import { headersForUrl, type NormalizedOrigin } from "../origin.ts";
import { RemoteSkillsError } from "./errors.ts";
import { parseImfFixdate } from "./http-date.ts";
import {
  hasRawUrlUserinfo,
  isCanonicalRawUrlReference,
  type ResolveHost,
  resolveNetworkTarget,
} from "./network-policy.ts";
import {
  type HttpTransport,
  RequestTimedOut,
  ResponseLimitExceeded,
  type TransportResponse,
} from "./transport.ts";

export interface RequestRuntime {
  now: () => number;
  random: () => number;
  sleep: (milliseconds: number) => Promise<void>;
  resolve: ResolveHost;
  transport: HttpTransport;
}

export interface RequestOptions {
  origin: NormalizedOrigin;
  url: URL;
  purpose: "artifact" | "catalog";
  accept: string;
  headers?: Readonly<Record<string, string>>;
  maxBytes: number;
}

export interface PolicyResponse extends TransportResponse {
  url: string;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const RETRY_STATUSES = new Set([408, 429]);
const RETRY_AFTER_CAP_MS = 5_000;

function normalizeResponseHeaders(
  headers: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const normalized: Record<string, string> = {};
  for (const [rawName, value] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    normalized[name] = normalized[name] === undefined ? value : `${normalized[name]}, ${value}`;
  }
  return normalized;
}

function retryAfterMilliseconds(value: string | undefined, now: number): number | undefined {
  if (value === undefined) return undefined;
  const fieldValue = value.trim();
  if (/^[0-9]+$/.test(fieldValue)) {
    const milliseconds = BigInt(fieldValue) * 1_000n;
    return milliseconds >= BigInt(RETRY_AFTER_CAP_MS) ? RETRY_AFTER_CAP_MS : Number(milliseconds);
  }
  const date = parseImfFixdate(fieldValue);
  if (date === undefined) return undefined;
  return Math.min(Math.max(0, date - now), RETRY_AFTER_CAP_MS);
}

function jitterDelay(attempt: number, random: number): number {
  const window = Math.min(250 * 2 ** attempt, RETRY_AFTER_CAP_MS);
  return Math.floor(Math.max(0, Math.min(random, 0.999_999)) * window);
}

function isTimeout(error: unknown): boolean {
  return (
    error instanceof RequestTimedOut || (error instanceof Error && error.name === "AbortError")
  );
}

type TerminalFailure =
  | { kind: "network" }
  | { kind: "status"; status: number }
  | { kind: "timeout" };

function terminalError(options: RequestOptions, failure: TerminalFailure): RemoteSkillsError {
  if (failure.kind === "timeout") {
    return new RemoteSkillsError("request_timeout", { origin_alias: options.origin.alias });
  }
  if (failure.kind === "status" && (failure.status === 401 || failure.status === 403)) {
    return new RemoteSkillsError(
      failure.status === 401 ? "authentication_failed" : "authorization_denied",
      {
        origin_alias: options.origin.alias,
        ...(options.origin.scope === undefined ? {} : { scope: options.origin.scope }),
        status: failure.status,
      },
    );
  }
  return new RemoteSkillsError("origin_unavailable", {
    origin_alias: options.origin.alias,
    ...(failure.kind === "status" ? { status: failure.status } : {}),
  });
}

async function executeOnce(
  options: RequestOptions,
  runtime: RequestRuntime,
  signal: AbortSignal,
): Promise<PolicyResponse> {
  let url = new URL(options.url.href);
  for (let redirects = 0; ; redirects += 1) {
    const address = await resolveNetworkTarget(options.origin, url, runtime.resolve, signal);
    const scopedHeaders = headersForUrl(options.origin, url, options.purpose);
    const response = await runtime.transport({
      url: url.href,
      headers: {
        accept: options.accept,
        ...scopedHeaders,
        ...options.headers,
      },
      address,
      signal,
      maxBytes: options.maxBytes,
    });
    if (!(response.body instanceof Uint8Array) || response.body.byteLength > options.maxBytes) {
      throw new ResponseLimitExceeded();
    }
    const normalized = { ...response, headers: normalizeResponseHeaders(response.headers) };
    if (!REDIRECT_STATUSES.has(response.status)) return { ...normalized, url: url.href };
    const location = normalized.headers.location;
    if (!location || redirects >= options.origin.maxRedirects) {
      throw new RemoteSkillsError("policy_denied", { origin_alias: options.origin.alias });
    }
    if (!isCanonicalRawUrlReference(location) || hasRawUrlUserinfo(location)) {
      throw new RemoteSkillsError("policy_denied", { origin_alias: options.origin.alias });
    }
    try {
      url = new URL(location, url);
    } catch {
      throw new RemoteSkillsError("policy_denied", { origin_alias: options.origin.alias });
    }
  }
}

async function withinDeadline<T>(
  milliseconds: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new RequestTimedOut()), milliseconds);
  const aborted = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener("abort", () => reject(controller.signal.reason), {
      once: true,
    });
  });
  try {
    return await Promise.race([operation(controller.signal), aborted]);
  } finally {
    clearTimeout(timeout);
  }
}

export async function requestWithPolicy(
  options: RequestOptions,
  runtime: RequestRuntime,
): Promise<PolicyResponse> {
  for (let attempt = 0; attempt <= options.origin.retries; attempt += 1) {
    try {
      const response = await withinDeadline(options.origin.timeoutMs, (signal) =>
        executeOnce(options, runtime, signal),
      );
      if (response.status === 200 || response.status === 304) return response;
      const retryableStatus = RETRY_STATUSES.has(response.status) || response.status >= 500;
      if (!retryableStatus || attempt === options.origin.retries) {
        throw terminalError(options, { kind: "status", status: response.status });
      }
      const delay =
        retryAfterMilliseconds(response.headers["retry-after"], runtime.now()) ??
        jitterDelay(attempt, runtime.random());
      await runtime.sleep(delay);
    } catch (error) {
      if (error instanceof RemoteSkillsError) throw error;
      if (error instanceof ResponseLimitExceeded) {
        throw new RemoteSkillsError("limit_exceeded", {
          ...(options.purpose === "catalog" ? { origin_alias: options.origin.alias } : {}),
          limit: options.purpose === "catalog" ? "catalog_bytes" : "archive_bytes",
        });
      }
      const failure: TerminalFailure = isTimeout(error) ? { kind: "timeout" } : { kind: "network" };
      if (attempt === options.origin.retries) throw terminalError(options, failure);
      await runtime.sleep(jitterDelay(attempt, runtime.random()));
    }
  }
  throw new Error("unreachable retry loop");
}

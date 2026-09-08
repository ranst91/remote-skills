import { Resolver } from "node:dns/promises";
import type { IncomingMessage } from "node:http";
import { request as requestHttp, validateHeaderName, validateHeaderValue } from "node:http";
import { request as requestHttps } from "node:https";
import { isIP } from "node:net";

import { invalidConfiguration, PublisherVerifyError } from "./verify-errors.ts";

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const RETRYABLE_STATUSES = new Set([408, 429]);
const FORBIDDEN_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "transfer-encoding",
  "remote-skills-scope",
]);
const RETRY_AFTER_CAP_MS = 5_000;
const IMF_FIXDATE =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), ([0-9]{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ([0-9]{4}) ([0-9]{2}):([0-9]{2}):([0-9]{2}) GMT$/u;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

class RequestTimedOut extends Error {}
class ResponseLimitExceeded extends Error {}

export type ResolvedAddress = { address: string; family: 4 | 6 };
type ResponseHeaders = Record<string, string | string[]>;
type TransportResponse = { status: number; headers: ResponseHeaders; body: Uint8Array };
type Resolve = (hostname: string, signal: AbortSignal) => Promise<readonly ResolvedAddress[]>;
export type TransportRequest = {
  url: string;
  headers: Record<string, string>;
  address: ResolvedAddress;
  signal: AbortSignal;
  maxBytes: number;
};
type Transport = (input: TransportRequest) => Promise<TransportResponse>;

/** @param {string} address */
function ipv4Value(address: string): number | undefined {
  if (isIP(address) !== 4) return undefined;
  const octets = address.split(".").map(Number);
  if (octets.length !== 4) return undefined;
  return octets.reduce((value, octet) => (value * 256 + octet) >>> 0, 0);
}

/** @param {number} value @param {number} base @param {number} prefix */
function inIpv4Range(value: number, base: number, prefix: number): boolean {
  const mask = prefix === 0 ? 0 : (0xffff_ffff << (32 - prefix)) >>> 0;
  return (value & mask) >>> 0 === (base & mask) >>> 0;
}

/** @param {string} address */
function isPublicIpv4(address: string): boolean {
  const value = ipv4Value(address);
  if (value === undefined) return false;
  const denied: ReadonlyArray<readonly [number, number]> = [
    [0x0000_0000, 8],
    [0x0a00_0000, 8],
    [0x6440_0000, 10],
    [0x7f00_0000, 8],
    [0xa9fe_0000, 16],
    [0xac10_0000, 12],
    [0xc000_0000, 24],
    [0xc000_0200, 24],
    [0xc058_6300, 24],
    [0xc0a8_0000, 16],
    [0xc612_0000, 15],
    [0xc633_6400, 24],
    [0xcb00_7100, 24],
    [0xe000_0000, 4],
    [0xf000_0000, 4],
  ];
  return !denied.some(([base, prefix]) => inIpv4Range(value, base ?? 0, prefix ?? 0));
}

/** @param {string} address */
function ipv6Value(address: string): bigint | undefined {
  if (address.includes("%")) return undefined;
  let normalized = address.toLowerCase();
  if (normalized.includes(".")) {
    const separator = normalized.lastIndexOf(":");
    const embedded = ipv4Value(normalized.slice(separator + 1));
    if (separator === -1 || embedded === undefined) return undefined;
    normalized = `${normalized.slice(0, separator)}:${(embedded >>> 16).toString(16)}:${(embedded & 0xffff).toString(16)}`;
  }
  if (isIP(normalized) !== 6) return undefined;
  const pieces = normalized.split("::");
  if (pieces.length > 2) return undefined;
  const parse = (side = ""): number[] =>
    side === "" ? [] : side.split(":").map((part) => Number.parseInt(part, 16));
  const left = parse(pieces[0] ?? "");
  const right = parse(pieces[1] ?? "");
  const missing = 8 - left.length - right.length;
  if ((pieces.length === 1 && missing !== 0) || (pieces.length === 2 && missing < 1))
    return undefined;
  const groups = [...left, ...Array.from({ length: missing }, () => 0), ...right];
  if (
    groups.length !== 8 ||
    groups.some((group) => !Number.isInteger(group) || group < 0 || group > 0xffff)
  )
    return undefined;
  return groups.reduce((value, group) => (value << 16n) | BigInt(group), 0n);
}

/** @param {bigint} value @param {bigint} base @param {number} prefix */
function inIpv6Range(value: bigint, base: bigint, prefix: number): boolean {
  const shift = 128n - BigInt(prefix);
  return value >> shift === base >> shift;
}

/** IANA special-purpose ranges whose Globally Reachable value is true. @type {readonly [bigint, number][]} */
const GLOBALLY_REACHABLE_IPV6_SPECIAL_PURPOSE: ReadonlyArray<readonly [bigint, number]> = [
  [0x0064_ff9b_0000_0000_0000_0000_0000_0000n, 96],
  [0x2001_0001_0000_0000_0000_0000_0000_0001n, 128],
  [0x2001_0001_0000_0000_0000_0000_0000_0002n, 128],
  [0x2001_0001_0000_0000_0000_0000_0000_0003n, 128],
  [0x2001_0003_0000_0000_0000_0000_0000_0000n, 32],
  [0x2001_0004_0112_0000_0000_0000_0000_0000n, 48],
  [0x2001_0020_0000_0000_0000_0000_0000_0000n, 28],
  [0x2001_0030_0000_0000_0000_0000_0000_0000n, 28],
];

/** IANA allocated global-unicast ranges; unknown space stays denied. @type {readonly [bigint, number][]} */
const ALLOCATED_GLOBAL_UNICAST_IPV6: ReadonlyArray<readonly [bigint, number]> = [
  [0x2001_0200_0000_0000_0000_0000_0000_0000n, 23],
  [0x2001_0400_0000_0000_0000_0000_0000_0000n, 23],
  [0x2001_0600_0000_0000_0000_0000_0000_0000n, 23],
  [0x2001_0800_0000_0000_0000_0000_0000_0000n, 22],
  [0x2001_0c00_0000_0000_0000_0000_0000_0000n, 23],
  [0x2001_0e00_0000_0000_0000_0000_0000_0000n, 23],
  [0x2001_1200_0000_0000_0000_0000_0000_0000n, 23],
  [0x2001_1400_0000_0000_0000_0000_0000_0000n, 22],
  [0x2001_1800_0000_0000_0000_0000_0000_0000n, 23],
  [0x2001_1a00_0000_0000_0000_0000_0000_0000n, 23],
  [0x2001_1c00_0000_0000_0000_0000_0000_0000n, 22],
  [0x2001_2000_0000_0000_0000_0000_0000_0000n, 19],
  [0x2001_4000_0000_0000_0000_0000_0000_0000n, 23],
  [0x2001_4200_0000_0000_0000_0000_0000_0000n, 23],
  [0x2001_4400_0000_0000_0000_0000_0000_0000n, 23],
  [0x2001_4600_0000_0000_0000_0000_0000_0000n, 23],
  [0x2001_4800_0000_0000_0000_0000_0000_0000n, 23],
  [0x2001_4a00_0000_0000_0000_0000_0000_0000n, 23],
  [0x2001_4c00_0000_0000_0000_0000_0000_0000n, 23],
  [0x2001_5000_0000_0000_0000_0000_0000_0000n, 20],
  [0x2001_8000_0000_0000_0000_0000_0000_0000n, 19],
  [0x2001_a000_0000_0000_0000_0000_0000_0000n, 20],
  [0x2001_b000_0000_0000_0000_0000_0000_0000n, 20],
  [0x2003_0000_0000_0000_0000_0000_0000_0000n, 18],
  [0x2400_0000_0000_0000_0000_0000_0000_0000n, 11],
  [0x2600_0000_0000_0000_0000_0000_0000_0000n, 12],
  [0x2610_0000_0000_0000_0000_0000_0000_0000n, 23],
  [0x2620_0000_0000_0000_0000_0000_0000_0000n, 23],
  [0x2630_0000_0000_0000_0000_0000_0000_0000n, 12],
  [0x2800_0000_0000_0000_0000_0000_0000_0000n, 12],
  [0x2a00_0000_0000_0000_0000_0000_0000_0000n, 11],
  [0x2c00_0000_0000_0000_0000_0000_0000_0000n, 12],
];

/** @param {string} address */
export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) return isPublicIpv4(address);
  const value = ipv6Value(address);
  if (value === undefined) return false;
  if (value >> 32n === 0xffffn) {
    const embedded = Number(value & 0xffff_ffffn);
    return isPublicIpv4([24, 16, 8, 0].map((shift) => (embedded >>> shift) & 0xff).join("."));
  }
  if (
    GLOBALLY_REACHABLE_IPV6_SPECIAL_PURPOSE.some(([base, prefix]) =>
      inIpv6Range(value, base, prefix),
    )
  )
    return true;
  if (inIpv6Range(value, 0x2001_0db8_0000_0000_0000_0000_0000_0000n, 32)) return false;
  return ALLOCATED_GLOBAL_UNICAST_IPV6.some(([base, prefix]) => inIpv6Range(value, base, prefix));
}

/** @param {string} address */
export function isLoopbackAddress(address: string): boolean {
  const ipv4 = ipv4Value(address);
  if (ipv4 !== undefined) return inIpv4Range(ipv4, 0x7f00_0000, 8);
  const ipv6 = ipv6Value(address);
  if (ipv6 === 1n) return true;
  return (
    ipv6 !== undefined &&
    ipv6 >> 32n === 0xffffn &&
    inIpv4Range(Number(ipv6 & 0xffff_ffffn), 0x7f00_0000, 8)
  );
}

/** @param {string} value */
function hasRawUrlUserinfo(value: string): boolean {
  const schemeAuthority = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.exec(value);
  const authorityStart = value.startsWith("//") ? 2 : schemeAuthority?.[0].length;
  if (authorityStart === undefined) return false;
  const remainder = value.slice(authorityStart);
  const delimiter = remainder.search(/[/?#]/u);
  return (delimiter === -1 ? remainder : remainder.slice(0, delimiter)).includes("@");
}

/** @param {string} value */
function rawUrlIsSafe(value: string): boolean {
  return (
    value.length > 0 &&
    value === value.trim() &&
    !/[\\\t\r\n]/u.test(value) &&
    !hasRawUrlUserinfo(value) &&
    !value.includes("?") &&
    !value.includes("#")
  );
}

/** @param {unknown} headers */
export function normalizeVerifyHeaders(headers: unknown): Readonly<Record<string, string>> {
  if (headers === undefined) return Object.freeze({});
  if (headers === null || typeof headers !== "object" || Array.isArray(headers))
    throw invalidConfiguration("headers");
  const normalized: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    try {
      validateHeaderName(rawName);
      if (typeof rawValue !== "string") throw new TypeError();
      validateHeaderValue(rawName, rawValue);
    } catch {
      throw invalidConfiguration(`headers.${rawName}`);
    }
    if (FORBIDDEN_HEADERS.has(name) || Object.hasOwn(normalized, name))
      throw invalidConfiguration(`headers.${rawName}`);
    normalized[name] = rawValue;
  }
  return Object.freeze(normalized);
}

/** @param {string} value */
function loopbackHostname(value: string): boolean {
  const hostname = value.replace(/^\[|\]$/gu, "").toLowerCase();
  return hostname === "localhost" || isLoopbackAddress(hostname);
}

/**
 * @param {string} value
 * @param {{headers?: Record<string, string>, scope?: string | undefined, timeoutMs?: number, retries?: number}} [options]
 */
export function normalizeVerifyOrigin(
  value: string,
  options: {
    headers?: Record<string, string>;
    scope?: string | undefined;
    timeoutMs?: number;
    retries?: number;
  } = {},
) {
  let originUrl: URL;
  try {
    if (typeof value !== "string" || !rawUrlIsSafe(value)) throw new TypeError();
    originUrl = new URL(value);
  } catch {
    throw invalidConfiguration("origin");
  }
  if (originUrl.username || originUrl.password || originUrl.search || originUrl.hash)
    throw invalidConfiguration("origin");
  const allowLoopbackHttp = originUrl.protocol === "http:" && loopbackHostname(originUrl.hostname);
  if (originUrl.protocol !== "https:" && !allowLoopbackHttp) throw invalidConfiguration("origin");
  return Object.freeze({
    originUrl,
    catalogUrl: new URL("/.well-known/agent-skills/index.json", originUrl),
    headers: normalizeVerifyHeaders(options.headers),
    scope: options.scope,
    timeoutMs: options.timeoutMs ?? 30_000,
    retries: options.retries ?? 2,
    maxRedirects: 5,
    allowLoopbackHttp,
  });
}

/** @param {string} hostname @param {AbortSignal} signal @returns {Promise<readonly {address: string, family: 4 | 6}[]>} */
async function defaultResolve(
  hostname: string,
  signal: AbortSignal,
): Promise<readonly ResolvedAddress[]> {
  if (signal.aborted) throw signal.reason;
  if (hostname.toLowerCase() === "localhost")
    return [
      { address: "127.0.0.1", family: 4 },
      { address: "::1", family: 6 },
    ];
  const resolver = new Resolver();
  const cancel = () => resolver.cancel();
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const [v4, v6] = await Promise.allSettled([
      resolver.resolve4(hostname),
      resolver.resolve6(hostname),
    ]);
    if (signal.aborted) throw signal.reason;
    const addresses: ResolvedAddress[] = [];
    if (v4.status === "fulfilled")
      addresses.push(...v4.value.map((address) => ({ address, family: 4 as const })));
    if (v6.status === "fulfilled")
      addresses.push(...v6.value.map((address) => ({ address, family: 6 as const })));
    if (addresses.length === 0)
      throw v4.status === "rejected"
        ? v4.reason
        : v6.status === "rejected"
          ? v6.reason
          : new Error("DNS returned no addresses");
    return addresses;
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

/** @param {URL} url @param {{allowLoopbackHttp: boolean, originUrl: URL}} origin @param {(hostname: string, signal: AbortSignal) => Promise<readonly {address: string, family: 4 | 6}[]>} resolve @param {AbortSignal} signal */
async function resolveTarget(
  url: URL,
  origin: { allowLoopbackHttp: boolean; originUrl: URL },
  resolve: Resolve,
  signal: AbortSignal,
): Promise<ResolvedAddress> {
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["http:", "https:"].includes(url.protocol)
  )
    throw new PublisherVerifyError("policy_denied");
  const literal = url.hostname.replace(/^\[|\]$/gu, "");
  const family = isIP(literal);
  let answers: readonly ResolvedAddress[];
  if (family === 4) answers = [{ address: literal, family: 4 }];
  else if (family === 6) answers = [{ address: literal, family: 6 }];
  else answers = await resolve(url.hostname, signal);
  if (answers.length === 0) throw new PublisherVerifyError("policy_denied");
  const isExplicitLoopback =
    origin.allowLoopbackHttp &&
    url.protocol === "http:" &&
    url.host.toLowerCase() === origin.originUrl.host.toLowerCase();
  if (isExplicitLoopback) {
    if (!answers.every(({ address }) => isLoopbackAddress(address)))
      throw new PublisherVerifyError("policy_denied");
  } else if (
    url.protocol !== "https:" ||
    !answers.every(({ address }) => isPublicAddress(address))
  ) {
    throw new PublisherVerifyError("policy_denied");
  }
  const selected = answers[0];
  if (!selected) throw new PublisherVerifyError("policy_denied");
  return selected;
}

/** @param {import("node:http").IncomingMessage} response */
function responseHeaders(response: IncomingMessage): ResponseHeaders {
  const headers: ResponseHeaders = {};
  for (let index = 0; index < response.rawHeaders.length; index += 2) {
    const name = (response.rawHeaders[index] ?? "").toLowerCase();
    const value = response.rawHeaders[index + 1] ?? "";
    const previous = headers[name];
    headers[name] =
      previous === undefined
        ? value
        : Array.isArray(previous)
          ? [...previous, value]
          : [previous, value];
  }
  return headers;
}

/** @param {import("node:http").IncomingMessage} response @param {number} maxBytes */
function consumeResponse(response: IncomingMessage, maxBytes: number): Promise<TransportResponse> {
  return new Promise<TransportResponse>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    response.on("error", reject);
    response.on("data", (chunk: Buffer) => {
      length += chunk.byteLength;
      if (length > maxBytes) response.destroy(new ResponseLimitExceeded());
      else chunks.push(chunk);
    });
    response.on("end", () => {
      resolve({
        status: response.statusCode ?? 0,
        headers: responseHeaders(response),
        body: Buffer.concat(chunks, length),
      });
    });
    const declared = Number(response.headers["content-length"]);
    if (Number.isFinite(declared) && declared > maxBytes)
      response.destroy(new ResponseLimitExceeded());
  });
}

/** @param {{url: string, headers: Record<string, string>, address: {address: string, family: 4 | 6}, signal: AbortSignal, maxBytes: number}} input */
async function defaultTransport(input: Parameters<Transport>[0]): Promise<TransportResponse> {
  return new Promise<TransportResponse>((resolve, reject) => {
    const url = new URL(input.url);
    const request = (url.protocol === "https:" ? requestHttps : requestHttp)(
      url,
      {
        method: "GET",
        headers: input.headers,
        signal: input.signal,
        lookup: (_hostname, options, callback) =>
          options.all
            ? callback(null, [input.address])
            : callback(null, input.address.address, input.address.family),
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if (status === 401 || status === 403) {
          resolve({ status, headers: responseHeaders(response), body: new Uint8Array() });
          response.destroy();
          return;
        }
        void consumeResponse(response, input.maxBytes).then(resolve, reject);
      },
    );
    request.on("error", reject);
    request.end();
  });
}

/** @param {Record<string, string | string[]>} headers */
function normalizedResponseHeaders(headers: ResponseHeaders): ResponseHeaders {
  const normalized: ResponseHeaders = {};
  for (const [rawName, value] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    const previous = normalized[name];
    if (previous === undefined) normalized[name] = value;
    else
      normalized[name] = [
        ...(Array.isArray(previous) ? previous : [previous]),
        ...(Array.isArray(value) ? value : [value]),
      ];
  }
  return normalized;
}

/** @param {string | string[] | undefined} value */
function singleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** @param {number} attempt @param {number} random */
function jitter(attempt: number, random: number): number {
  return Math.floor(
    Math.max(0, Math.min(random, 0.999_999)) * Math.min(250 * 2 ** attempt, RETRY_AFTER_CAP_MS),
  );
}

/** @param {string | undefined} value */
function parseImfFixdate(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const match = IMF_FIXDATE.exec(value.trim());
  if (!match) return undefined;
  const weekday = match[1];
  const day = Number(match[2]);
  const month = MONTHS.indexOf(match[3] ?? "");
  const year = Number(match[4]);
  const hour = Number(match[5]);
  const minute = Number(match[6]);
  const second = Number(match[7]);
  if (month < 0 || hour > 23 || minute > 59 || second > 60) return undefined;
  const date = new Date(0);
  date.setUTCHours(hour, minute, Math.min(second, 59), 0);
  date.setUTCFullYear(year, month, day);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month ||
    date.getUTCDate() !== day ||
    WEEKDAYS[date.getUTCDay()] !== weekday
  )
    return undefined;
  return date.getTime() + (second === 60 ? 1_000 : 0);
}

/** @param {string | undefined} value @param {number} now */
function retryAfter(value: string | undefined, now: number): number | undefined {
  if (value === undefined) return undefined;
  if (/^\s*[0-9]+\s*$/u.test(value))
    return Math.min(Number.parseInt(value, 10) * 1_000, RETRY_AFTER_CAP_MS);
  const date = parseImfFixdate(value);
  return date === undefined ? undefined : Math.min(Math.max(0, date - now), RETRY_AFTER_CAP_MS);
}

/** @param {number} milliseconds @param {(signal: AbortSignal) => Promise<unknown>} operation */
async function deadline<T>(
  milliseconds: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new RequestTimedOut()), milliseconds);
  const aborted = new Promise<never>((_resolve, reject) =>
    controller.signal.addEventListener("abort", () => reject(controller.signal.reason), {
      once: true,
    }),
  );
  try {
    return await Promise.race([operation(controller.signal), aborted]);
  } finally {
    clearTimeout(timer);
  }
}

/** @param {{originUrl: URL, headers: Readonly<Record<string, string>>, scope: string | undefined}} origin @param {URL} url @param {"catalog" | "artifact"} purpose */
function headersFor(
  origin: {
    originUrl: URL;
    headers: Readonly<Record<string, string>>;
    scope: string | undefined;
  },
  url: URL,
  purpose: "catalog" | "artifact",
): Record<string, string> {
  if (url.host.toLowerCase() !== origin.originUrl.host.toLowerCase()) return {};
  return {
    ...origin.headers,
    ...(purpose === "catalog" && origin.scope !== undefined
      ? { "remote-skills-scope": origin.scope }
      : {}),
  };
}

/**
 * @param {{url: URL, origin: ReturnType<typeof normalizeVerifyOrigin>, purpose: "catalog" | "artifact", accept: string, headers?: Readonly<Record<string, string>>, limit?: "fileBytes" | "archiveBytes", maxBytes: number}} options
 * @param {{resolve?: typeof defaultResolve, transport?: typeof defaultTransport, sleep?: (milliseconds: number) => Promise<void>, random?: () => number, now?: () => number}} [dependencies]
 */
export async function requestWithPolicy(
  options: {
    url: URL;
    origin: ReturnType<typeof normalizeVerifyOrigin>;
    purpose: "catalog" | "artifact";
    accept: string;
    headers?: Readonly<Record<string, string>>;
    limit?: "fileBytes" | "archiveBytes";
    maxBytes: number;
  },
  dependencies: {
    resolve?: Resolve;
    transport?: Transport;
    sleep?: (milliseconds: number) => Promise<void>;
    random?: () => number;
    now?: () => number;
  } = {},
) {
  const runtime = {
    resolve: dependencies.resolve ?? defaultResolve,
    transport: dependencies.transport ?? defaultTransport,
    sleep:
      dependencies.sleep ??
      ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds))),
    random: dependencies.random ?? Math.random,
    now: dependencies.now ?? Date.now,
  };
  for (let attempt = 0; attempt <= options.origin.retries; attempt += 1) {
    try {
      const response = await deadline(options.origin.timeoutMs, async (signal) => {
        let url = new URL(options.url.href);
        for (let redirects = 0; ; redirects += 1) {
          const address = await resolveTarget(url, options.origin, runtime.resolve, signal);
          const raw = await runtime.transport({
            url: url.href,
            headers: {
              accept: options.accept,
              ...headersFor(options.origin, url, options.purpose),
              ...options.headers,
            },
            address,
            signal,
            maxBytes: options.maxBytes,
          });
          const headers = normalizedResponseHeaders(raw.headers);
          if (raw.status === 401 || raw.status === 403)
            return { status: raw.status, headers, body: new Uint8Array(), url: url.href };
          if (!(raw.body instanceof Uint8Array) || raw.body.byteLength > options.maxBytes)
            throw new ResponseLimitExceeded();
          if (!REDIRECTS.has(raw.status)) return { ...raw, headers, url: url.href };
          const location = singleHeader(headers.location);
          if (!location || redirects >= options.origin.maxRedirects || !rawUrlIsSafe(location))
            throw new PublisherVerifyError("policy_denied");
          try {
            url = new URL(location, url);
          } catch {
            throw new PublisherVerifyError("policy_denied");
          }
        }
      });
      if (response.status === 200 || (options.purpose === "catalog" && response.status === 304))
        return response;
      const retryable = RETRYABLE_STATUSES.has(response.status) || response.status >= 500;
      if (!retryable || attempt === options.origin.retries) {
        if (response.status === 401 || response.status === 403)
          throw new PublisherVerifyError(
            response.status === 401 ? "authentication_failed" : "authorization_denied",
            {
              ...(options.origin.scope === undefined ? {} : { scope: options.origin.scope }),
              status: response.status,
            },
          );
        throw new PublisherVerifyError("origin_unavailable", { status: response.status });
      }
      await runtime.sleep(
        retryAfter(singleHeader(response.headers["retry-after"]), runtime.now()) ??
          jitter(attempt, runtime.random()),
      );
    } catch (error) {
      if (error instanceof PublisherVerifyError) throw error;
      if (error instanceof ResponseLimitExceeded)
        throw new PublisherVerifyError("limit_exceeded", {
          limit: options.purpose === "catalog" ? "catalogBytes" : (options.limit ?? "archiveBytes"),
        });
      const timeout =
        error instanceof RequestTimedOut || (error instanceof Error && error.name === "AbortError");
      if (attempt === options.origin.retries)
        throw new PublisherVerifyError(timeout ? "request_timeout" : "origin_unavailable");
      await runtime.sleep(jitter(attempt, runtime.random()));
    }
  }
  throw new Error("unreachable retry loop");
}

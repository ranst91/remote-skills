import { createHash } from "node:crypto";

import { normalizeVerifyHeaders, normalizeVerifyOrigin, requestWithPolicy } from "./network.ts";
import { validateVerifiedArtifact } from "./verify-artifact.ts";
import { parseVerifyCatalog } from "./verify-catalog.ts";
import { diagnosticFrom, invalidConfiguration, PublisherVerifyError } from "./verify-errors.ts";

const LIMITS = Object.freeze({
  catalogBytes: 1_048_576,
  archiveBytes: 52_428_800,
  extractedBytes: 104_857_600,
  files: 1_000,
  fileBytes: 10_485_760,
});
const LIMIT_OPTIONS: ReadonlyMap<string, keyof typeof LIMITS> = new Map([
  ["--catalog-bytes", "catalogBytes"],
  ["--archive-bytes", "archiveBytes"],
  ["--extracted-bytes", "extractedBytes"],
  ["--files", "files"],
  ["--file-bytes", "fileBytes"],
]);

type ResponseHeaders = Record<string, string | string[]>;
export type CatalogCacheValue = {
  body: Uint8Array;
  url: string;
  etag?: string;
  lastModified?: string;
};
export type VerifyDependencies = NonNullable<Parameters<typeof requestWithPolicy>[1]> & {
  catalogCache?: {
    get: (key: string) => Promise<CatalogCacheValue | undefined>;
    set: (key: string, value: CatalogCacheValue) => Promise<void>;
    delete?: (key: string) => Promise<void>;
  };
};
type VerifyResult = {
  origin: string;
  verified: boolean;
  entries: Array<{ name: string; version?: string; digest: string }>;
  failures: ReturnType<typeof diagnosticFrom>[];
  exitCode: number;
};

/** @param {string} value @param {string} option @param {number} minimum @param {number} maximum */
function boundedInteger(value: string, option: string, minimum: number, maximum: number): number {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) throw invalidConfiguration(option);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum)
    throw invalidConfiguration(option);
  return parsed;
}

/** @param {string} value @param {string} option */
function headerAssignment(value: string, option: string): { name: string; value: string } {
  const separator = value.indexOf("=");
  if (separator < 1) throw invalidConfiguration(option);
  return { name: value.slice(0, separator), value: value.slice(separator + 1) };
}

/** @param {unknown} value */
function validateScope(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 128 ||
    !/^[\x21-\x7e]+$/u.test(value) ||
    value.includes(",")
  )
    throw invalidConfiguration("scope");
  return value;
}

/**
 * @param {string[]} args
 * @param {Readonly<Record<string, string | undefined>>} [env]
 */
export function parseVerifyArgs(
  args: string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
) {
  let origin: string | undefined;
  let scope: string | undefined;
  let timeoutMs = 30_000;
  let retries = 2;
  const limits: Record<keyof typeof LIMITS, number> = { ...LIMITS };
  const headers: Record<string, string> = {};
  const seenHeaders = new Set<string>();
  const seenOptions = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? "";
    if (!argument.startsWith("--")) {
      if (origin !== undefined)
        throw invalidConfiguration("origin", "Verify accepts exactly one origin");
      origin = argument;
      continue;
    }
    const equals = argument.indexOf("=");
    const option = equals < 0 ? argument : argument.slice(0, equals);
    const value = equals < 0 ? args[index + 1] : argument.slice(equals + 1);
    if (value === undefined || (equals < 0 && value.startsWith("--")))
      throw invalidConfiguration(option, `${option} requires a value`);
    if (equals < 0) index += 1;
    if (option === "--header" || option === "--header-env") {
      const assignment = headerAssignment(value, option);
      const name = assignment.name.toLowerCase();
      if (seenHeaders.has(name))
        throw invalidConfiguration(
          `headers.${assignment.name}`,
          `Duplicate verify header: ${assignment.name}`,
        );
      seenHeaders.add(name);
      if (option === "--header-env") {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(assignment.value)) throw invalidConfiguration(option);
        const environmentValue = env[assignment.value];
        if (environmentValue === undefined)
          throw invalidConfiguration(
            option,
            `Environment variable is not set: ${assignment.value}`,
          );
        headers[assignment.name] = environmentValue;
      } else headers[assignment.name] = assignment.value;
      continue;
    }
    const limit = LIMIT_OPTIONS.get(option);
    if (limit === undefined && !["--scope", "--timeout-ms", "--retries"].includes(option))
      throw invalidConfiguration(option, `Unknown verify option: ${option}`);
    if (seenOptions.has(option))
      throw invalidConfiguration(option, `Duplicate verify option: ${option}`);
    seenOptions.add(option);
    if (limit !== undefined)
      limits[limit] = boundedInteger(value, option, 1, Number.MAX_SAFE_INTEGER);
    else if (option === "--scope") scope = validateScope(value);
    else if (option === "--timeout-ms") timeoutMs = boundedInteger(value, option, 1, 300_000);
    else retries = boundedInteger(value, option, 0, 10);
  }
  if (!origin) throw invalidConfiguration("origin", "Verify requires an origin");
  const normalizedHeaders = normalizeVerifyHeaders(headers);
  return { origin, headers: normalizedHeaders, scope, timeoutMs, retries, limits };
}

/** @param {Record<string, string | string[]>} headers @param {string} name */
function singleResponseHeader(headers: ResponseHeaders, name: string): string | undefined {
  const value = headers[name];
  return typeof value === "string" ? value : undefined;
}

/** @param {string | undefined} requested @param {Record<string, string | string[]>} headers */
function confirmScope(requested: string | undefined, headers: ResponseHeaders): void {
  if (requested === undefined) return;
  const value = headers["remote-skills-scope"];
  if (typeof value !== "string" || value !== requested)
    throw new PublisherVerifyError("catalog_invalid", {
      field: "remote-skills-scope",
      scope: requested,
    });
}

/** @param {Uint8Array} bytes */
function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** @param {ReturnType<typeof parseVerifyCatalog>[number]} entry */
function verificationTargets(entry: ReturnType<typeof parseVerifyCatalog>[number]) {
  if (!entry.extension) return [{ ...entry, version: undefined, current: true }];
  return entry.extension.releases.map((release) => ({
    ...release,
    name: entry.name,
    description: entry.description,
    current: release.version === entry.extension?.version,
  }));
}

/**
 * @param {{args: string[], env?: Readonly<Record<string, string | undefined>>}} options
 * @param {Parameters<typeof requestWithPolicy>[1] & {catalogCache?: {get: (key: string) => Promise<{body: Uint8Array, url: string, etag?: string, lastModified?: string} | undefined>, set: (key: string, value: {body: Uint8Array, url: string, etag?: string, lastModified?: string}) => Promise<void>, delete?: (key: string) => Promise<void>}}} [dependencies]
 */
export async function runVerifyCommand(
  options: { args: string[]; env?: Readonly<Record<string, string | undefined>> },
  dependencies: VerifyDependencies = {},
): Promise<VerifyResult> {
  const parsed = parseVerifyArgs(options.args, options.env ?? process.env);
  const origin = normalizeVerifyOrigin(parsed.origin, {
    headers: parsed.headers,
    ...(parsed.scope === undefined ? {} : { scope: parsed.scope }),
    timeoutMs: parsed.timeoutMs,
    retries: parsed.retries,
  });
  let entries: ReturnType<typeof parseVerifyCatalog>;
  try {
    const cacheKey = `${origin.catalogUrl.href}\n${origin.scope ?? ""}`;
    const cached = await dependencies.catalogCache?.get(cacheKey);
    const conditionalHeaders = {
      ...(cached?.etag === undefined ? {} : { "if-none-match": cached.etag }),
      ...(cached?.lastModified === undefined ? {} : { "if-modified-since": cached.lastModified }),
    };
    const response = await requestWithPolicy(
      {
        url: origin.catalogUrl,
        origin,
        purpose: "catalog",
        accept: "application/json",
        headers: conditionalHeaders,
        maxBytes: parsed.limits.catalogBytes,
      },
      dependencies,
    );
    confirmScope(origin.scope, response.headers);
    let catalogBody = response.body;
    let catalogUrl = response.url;
    if (response.status === 304) {
      if (!(cached?.body instanceof Uint8Array) || typeof cached.url !== "string")
        throw new PublisherVerifyError("catalog_invalid", { field: "catalog.cache" });
      catalogBody = cached.body;
      catalogUrl = cached.url;
    }
    entries = parseVerifyCatalog(catalogBody, new URL(catalogUrl), parsed.limits.catalogBytes);
    if (origin.scope !== undefined && dependencies.catalogCache) {
      const cacheControlValues = response.headers["cache-control"];
      const cacheControl = Array.isArray(cacheControlValues)
        ? cacheControlValues.join(",")
        : cacheControlValues;
      if (
        cacheControl?.split(",").some((directive) => directive.trim().toLowerCase() === "no-store")
      )
        await dependencies.catalogCache.delete?.(cacheKey);
      else {
        const etag =
          singleResponseHeader(response.headers, "etag") ??
          (response.status === 304 ? cached?.etag : undefined);
        const lastModified =
          singleResponseHeader(response.headers, "last-modified") ??
          (response.status === 304 ? cached?.lastModified : undefined);
        await dependencies.catalogCache.set(cacheKey, {
          body: catalogBody,
          url: catalogUrl,
          ...(etag === undefined ? {} : { etag }),
          ...(lastModified === undefined ? {} : { lastModified }),
        });
      }
    }
  } catch (error) {
    return {
      origin: origin.originUrl.origin,
      verified: false,
      entries: [],
      failures: [diagnosticFrom(error)],
      exitCode: 1,
    };
  }

  const verifiedEntries: VerifyResult["entries"] = [];
  const failures: VerifyResult["failures"] = [];
  for (const entry of entries) {
    for (const target of verificationTargets(entry)) {
      const targetContext = {
        skill_name: target.name,
        ...(target.version === undefined ? {} : { version: target.version }),
      };
      try {
        const response = await requestWithPolicy(
          {
            url: target.url,
            origin,
            purpose: "artifact",
            accept:
              target.type === "skill-md" ? "text/markdown" : "application/gzip, application/zip",
            limit: target.type === "skill-md" ? "fileBytes" : "archiveBytes",
            maxBytes:
              target.type === "skill-md" ? parsed.limits.fileBytes : parsed.limits.archiveBytes,
          },
          dependencies,
        );
        const actualDigest = sha256(response.body);
        if (actualDigest !== target.digest)
          throw new PublisherVerifyError("digest_mismatch", { expected_digest: target.digest });
        const contentType = singleResponseHeader(response.headers, "content-type");
        await validateVerifiedArtifact(response.body, {
          type: target.type,
          url: new URL(response.url),
          ...(contentType === undefined ? {} : { contentType }),
          skillName: target.name,
          ...(target.current ? { expectedDescription: target.description } : {}),
          limits: parsed.limits,
        });
        verifiedEntries.push({
          name: target.name,
          ...(target.version === undefined ? {} : { version: target.version }),
          digest: target.digest,
        });
      } catch (error) {
        failures.push(diagnosticFrom(error, targetContext));
      }
    }
  }
  return {
    origin: origin.originUrl.origin,
    verified: failures.length === 0,
    entries: verifiedEntries,
    failures,
    exitCode: failures.length === 0 ? 0 : 1,
  };
}

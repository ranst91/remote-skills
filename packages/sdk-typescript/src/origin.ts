import { validateHeaderValue } from "node:http";

import { RemoteSkillsError } from "./catalog/errors.ts";
import {
  canonicalIpAddress,
  hasRawUrlUserinfo,
  hasUrlQueryOrFragment,
  isCanonicalRawUrlReference,
  isLoopbackAddress,
} from "./catalog/network-policy.ts";

export interface NetworkPolicyConfig {
  allowedAddresses?: readonly string[];
  maxRedirects?: number;
}

export interface StaleCatalogConfig {
  maxAgeMs: number;
}

export interface OriginConfig {
  url: string | URL;
  headers?: Readonly<Record<string, string>>;
  artifactHeaders?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  scope?: string;
  timeoutMs?: number;
  retries?: number;
  catalogBytes?: number;
  stale?: StaleCatalogConfig;
  allowLoopbackHttp?: boolean;
  networkPolicy?: NetworkPolicyConfig;
}

export interface CatalogDefaults {
  timeoutMs?: number;
  retries?: number;
  catalogBytes?: number;
}

export interface NormalizedOrigin {
  alias: string;
  originUrl: URL;
  catalogUrl: URL;
  headers: Readonly<Record<string, string>>;
  artifactHeaders: ReadonlyMap<string, Readonly<Record<string, string>>>;
  scope: string | undefined;
  timeoutMs: number;
  retries: number;
  catalogBytes: number;
  maxStaleAgeMs: number | undefined;
  allowLoopbackHttp: boolean;
  allowedAddresses: ReadonlySet<string>;
  maxRedirects: number;
}

export type OriginMap = Readonly<Record<string, OriginConfig>>;

const ALIAS_PATTERN = /^[a-z][a-z0-9._-]{0,62}$/;
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const FORBIDDEN_HEADERS = new Set(["connection", "content-length", "host", "transfer-encoding"]);
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 300_000;
const DEFAULT_RETRIES = 2;
const MAX_RETRIES = 10;
const DEFAULT_CATALOG_BYTES = 1_048_576;
const MAX_CATALOG_BYTES = 52_428_800;
const MAX_REDIRECTS = 5;

function invalid(field: string): never {
  throw new RemoteSkillsError("configuration_invalid", { field });
}

function boundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
  field: string,
): number {
  const selected = value ?? fallback;
  if (
    typeof selected !== "number" ||
    !Number.isSafeInteger(selected) ||
    selected < minimum ||
    selected > maximum
  ) {
    invalid(field);
  }
  return selected;
}

interface UnknownProperties {
  readonly [key: string]: unknown;
}

function isPlainObject(value: unknown): value is UnknownProperties {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isWireSafeHeaderValue(name: string, value: string): boolean {
  try {
    validateHeaderValue(name, value);
    return true;
  } catch {
    return false;
  }
}

function normalizeHeaders(headers: unknown, field: string): Readonly<Record<string, string>> {
  if (headers === undefined) return Object.freeze({});
  if (!isPlainObject(headers)) invalid(field);
  const normalized: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (
      !HEADER_NAME_PATTERN.test(rawName) ||
      FORBIDDEN_HEADERS.has(name) ||
      name === "remote-skills-scope" ||
      typeof rawValue !== "string" ||
      !isWireSafeHeaderValue(rawName, rawValue)
    ) {
      invalid(name === "remote-skills-scope" ? name : `${field}.${rawName}`);
    }
    if (Object.hasOwn(normalized, name)) invalid(`${field}.${rawName}`);
    normalized[name] = rawValue;
  }
  return Object.freeze(normalized);
}

export function validateScope(value: unknown, field = "scope"): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 128 ||
    value.includes(",") ||
    !/^[\x21-\x7e]+$/u.test(value)
  ) {
    invalid(field);
  }
  return value;
}

function isLoopbackHostname(hostname: string): boolean {
  const plain = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return plain === "localhost" || isLoopbackAddress(plain);
}

function normalizeOriginUrl(config: OriginConfig, field: string): URL {
  let url: URL;
  try {
    const rawUrl = config.url instanceof URL ? config.url.href : config.url;
    if (
      typeof rawUrl !== "string" ||
      rawUrl.includes("?") ||
      rawUrl.includes("#") ||
      !isCanonicalRawUrlReference(rawUrl) ||
      hasRawUrlUserinfo(rawUrl)
    ) {
      throw new TypeError("invalid origin URL");
    }
    url = new URL(rawUrl);
  } catch {
    invalid(field);
  }
  if (url.username || url.password || hasUrlQueryOrFragment(url)) invalid(field);
  if (config.allowLoopbackHttp && (url.protocol !== "http:" || !isLoopbackHostname(url.hostname))) {
    invalid(field);
  }
  if (url.protocol === "http:") {
    if (!config.allowLoopbackHttp || !isLoopbackHostname(url.hostname)) invalid(field);
  } else if (url.protocol !== "https:") {
    invalid(field);
  }
  return url;
}

function normalizeArtifactHeaders(
  scopes: unknown,
  field: string,
): ReadonlyMap<string, Readonly<Record<string, string>>> {
  const normalized = new Map<string, Readonly<Record<string, string>>>();
  if (scopes === undefined) return normalized;
  if (!isPlainObject(scopes)) invalid(field);
  for (const [scope, headers] of Object.entries(scopes)) {
    let parsed: URL;
    try {
      parsed = new URL(`https://${scope}/`);
    } catch {
      invalid(`${field}.${scope}`);
    }
    if (parsed.host.toLowerCase() !== scope.toLowerCase() || parsed.pathname !== "/") {
      invalid(`${field}.${scope}`);
    }
    normalized.set(parsed.host.toLowerCase(), normalizeHeaders(headers, `${field}.${scope}`));
  }
  return normalized;
}

function normalizeAllowedAddresses(addresses: unknown, field: string) {
  const normalized = new Set<string>();
  if (addresses === undefined) return normalized;
  if (!Array.isArray(addresses)) invalid(field);
  for (const address of addresses) {
    if (typeof address !== "string") invalid(field);
    const canonical = canonicalIpAddress(address);
    if (canonical === undefined) invalid(field);
    normalized.add(canonical);
  }
  return normalized;
}

function normalizeStalePolicy(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (
    !isPlainObject(value) ||
    Object.keys(value).some((key) => key !== "maxAgeMs") ||
    typeof value.maxAgeMs !== "number" ||
    !Number.isSafeInteger(value.maxAgeMs) ||
    value.maxAgeMs < 0
  ) {
    invalid(field);
  }
  return value.maxAgeMs;
}

export function normalizeOrigins(
  origins: OriginMap,
  defaults: CatalogDefaults = {},
): ReadonlyMap<string, NormalizedOrigin> {
  if (typeof origins !== "object" || origins === null || Array.isArray(origins)) {
    invalid("origins");
  }
  const entries = Object.entries(origins);
  if (entries.length === 0) invalid("origins");
  if (!isPlainObject(defaults)) invalid("defaults");

  const defaultTimeout = boundedInteger(
    defaults.timeoutMs,
    DEFAULT_TIMEOUT_MS,
    1,
    MAX_TIMEOUT_MS,
    "defaults.timeoutMs",
  );
  const defaultRetries = boundedInteger(
    defaults.retries,
    DEFAULT_RETRIES,
    0,
    MAX_RETRIES,
    "defaults.retries",
  );
  const defaultCatalogBytes = boundedInteger(
    defaults.catalogBytes,
    DEFAULT_CATALOG_BYTES,
    1,
    MAX_CATALOG_BYTES,
    "defaults.catalogBytes",
  );

  const normalized = new Map<string, NormalizedOrigin>();
  for (const [alias, config] of entries) {
    if (!ALIAS_PATTERN.test(alias) || !isPlainObject(config)) {
      invalid(`origins.${alias}`);
    }
    const field = `origins.${alias}`;
    if (config.allowLoopbackHttp !== undefined && typeof config.allowLoopbackHttp !== "boolean") {
      invalid(`${field}.allowLoopbackHttp`);
    }
    if (config.networkPolicy !== undefined && !isPlainObject(config.networkPolicy)) {
      invalid(`${field}.networkPolicy`);
    }
    const originUrl = normalizeOriginUrl(config, `${field}.url`);
    const networkPolicy = config.networkPolicy ?? {};
    normalized.set(alias, {
      alias,
      originUrl,
      catalogUrl: new URL("/.well-known/agent-skills/index.json", originUrl),
      headers: normalizeHeaders(config.headers, `${field}.headers`),
      artifactHeaders: normalizeArtifactHeaders(config.artifactHeaders, `${field}.artifactHeaders`),
      scope: validateScope(config.scope),
      timeoutMs: boundedInteger(
        config.timeoutMs,
        defaultTimeout,
        1,
        MAX_TIMEOUT_MS,
        `${field}.timeoutMs`,
      ),
      retries: boundedInteger(config.retries, defaultRetries, 0, MAX_RETRIES, `${field}.retries`),
      catalogBytes: boundedInteger(
        config.catalogBytes,
        defaultCatalogBytes,
        1,
        MAX_CATALOG_BYTES,
        `${field}.catalogBytes`,
      ),
      maxStaleAgeMs: normalizeStalePolicy(config.stale, `${field}.stale`),
      allowLoopbackHttp: config.allowLoopbackHttp === true,
      allowedAddresses: normalizeAllowedAddresses(
        networkPolicy.allowedAddresses,
        `${field}.networkPolicy.allowedAddresses`,
      ),
      maxRedirects: boundedInteger(
        networkPolicy.maxRedirects,
        MAX_REDIRECTS,
        0,
        MAX_REDIRECTS,
        `${field}.networkPolicy.maxRedirects`,
      ),
    });
  }
  return normalized;
}

export function headersForUrl(
  origin: NormalizedOrigin,
  url: URL,
  purpose: "artifact" | "catalog",
): Readonly<Record<string, string>> {
  if (url.host.toLowerCase() === origin.originUrl.host.toLowerCase()) {
    if (purpose === "catalog" && origin.scope !== undefined) {
      return { ...origin.headers, "remote-skills-scope": origin.scope };
    }
    return origin.headers;
  }
  if (purpose === "artifact") return origin.artifactHeaders.get(url.host.toLowerCase()) ?? {};
  return {};
}

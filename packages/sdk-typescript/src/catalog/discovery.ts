import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";

import { CacheConfigurationError, CacheCorruptError } from "../cache/errors.ts";
import { canonicalOriginIdentifier } from "../cache/paths.ts";
import type {
  CacheBackend,
  CachedCatalog,
  CatalogMetadataInput,
  CatalogState,
} from "../cache/types.ts";
import { snapshotCatalogBody } from "../cache/validation.ts";
import {
  type CatalogDefaults,
  type NormalizedOrigin,
  normalizeOrigins,
  type OriginMap,
} from "../origin.ts";
import { RemoteSkillsError } from "./errors.ts";
import { type RequestRuntime, requestWithPolicy } from "./http.ts";
import { parseImfFixdate } from "./http-date.ts";
import { parseCatalog } from "./schema.ts";
import { defaultResolveHost, defaultTransport } from "./transport.ts";
import type { CatalogEntry, OriginCatalog } from "./types.ts";

interface CatalogCacheEntry {
  body: Uint8Array;
  catalog: OriginCatalog;
  responseHeaders: Readonly<Record<string, string>>;
  etag: string | undefined;
  lastModified: string | undefined;
  expiresAt: number;
  retrievedAt: number;
  storedAt: number;
}

export interface CatalogFailure {
  readonly originAlias: string;
  readonly error: RemoteSkillsError;
}

export interface AggregateCatalog {
  readonly entries: readonly CatalogEntry[];
  readonly failures: readonly CatalogFailure[];
}

export interface CatalogOptions {
  strict?: boolean;
}

export interface OriginCatalogOptions {
  forceRevalidate?: boolean;
}

export interface CatalogDiscoveryConfig {
  origins: OriginMap;
  defaults?: CatalogDefaults;
}

export type CatalogPersistence = Pick<
  CacheBackend,
  "deleteCatalog" | "getCatalogState" | "replaceCatalog" | "maxCatalogBytes"
>;

// Evidence is process-local and bound to one exact backend generation, never serialized.
interface AcceptedCatalog {
  readonly generation: string;
  readonly entry: CatalogCacheEntry;
}

const acceptedCatalogs = new WeakMap<CatalogPersistence, Map<string, AcceptedCatalog>>();

export function acceptedCatalogEntry(
  backend: CatalogPersistence | undefined,
  state: CatalogState | undefined,
  alias: string,
): CatalogCacheEntry | undefined {
  if (backend === undefined || state?.catalog == null) return undefined;
  const key = canonicalOriginIdentifier(
    state.catalog.metadata.canonicalUrl,
    state.catalog.metadata.confirmedScope,
  );
  const accepted = acceptedCatalogs.get(backend)?.get(key);
  if (accepted?.generation !== state.generation) return undefined;
  return {
    ...accepted.entry,
    catalog: Object.freeze({
      ...accepted.entry.catalog,
      originAlias: alias,
      entries: Object.freeze(
        accepted.entry.catalog.entries.map((entry) =>
          Object.freeze({ ...entry, originAlias: alias }),
        ),
      ),
    }),
  };
}

export type CatalogDiscoveryDependencies = Partial<RequestRuntime> & {
  persistentCache?: CatalogPersistence;
};

export interface CatalogDiscovery {
  catalog(options?: CatalogOptions): Promise<AggregateCatalog>;
  origin(alias: string, options?: OriginCatalogOptions): Promise<OriginCatalog>;
}

export class CatalogAggregateError extends Error {
  readonly failures: readonly CatalogFailure[];

  constructor(failures: readonly CatalogFailure[]) {
    super("Remote Skills aggregate catalog failed");
    this.name = "CatalogAggregateError";
    this.failures = failures;
  }
}

type OriginRequestStart =
  | { readonly kind: "fresh"; readonly catalog: OriginCatalog }
  | {
      readonly kind: "request";
      readonly cached: CatalogCacheEntry | undefined;
      readonly generation: number;
      readonly persistentExpected: CatalogState | undefined;
      readonly requestTime: number;
    };

interface CatalogMutationCoordinator {
  readonly generations: Map<string, number>;
  readonly tails: Map<string, Promise<void>>;
}

function createMutationCoordinator(): CatalogMutationCoordinator {
  return { generations: new Map(), tails: new Map() };
}

function createRuntime(dependencies: CatalogDiscoveryDependencies): RequestRuntime {
  return {
    now: dependencies.now ?? Date.now,
    random: dependencies.random ?? Math.random,
    sleep: dependencies.sleep ?? (async (milliseconds) => delay(milliseconds)),
    resolve: dependencies.resolve ?? defaultResolveHost,
    transport: dependencies.transport ?? defaultTransport,
  };
}

interface ParsedCacheControl {
  maxAgeMilliseconds: number | undefined;
  maxAgeInvalid: boolean;
  noCache: boolean;
  noStore: boolean;
}

const OVERFLOW_DELTA_SECONDS = 2_147_483_648n;
const HTTP_TOKEN_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function parseDeltaSeconds(value: string): number | undefined {
  const unquoted = /^"([0-9]+)"$/.exec(value)?.[1] ?? value;
  if (!/^[0-9]+$/.test(unquoted)) return undefined;
  const seconds = BigInt(unquoted);
  return Number(seconds > OVERFLOW_DELTA_SECONDS ? OVERFLOW_DELTA_SECONDS : seconds) * 1000;
}

function splitCacheControl(value: string): { malformed: boolean; members: readonly string[] } {
  const members: string[] = [];
  let memberStart = 0;
  let quoted = false;
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
    } else if (quoted && character === "\\") {
      escaped = true;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (!quoted && character === ",") {
      members.push(value.slice(memberStart, index));
      memberStart = index + 1;
    }
  }
  members.push(value.slice(memberStart));
  return {
    malformed: quoted || escaped || members.some((member) => member.trim() === ""),
    members,
  };
}

function isValidDirectiveArgument(value: string): boolean {
  if (HTTP_TOKEN_PATTERN.test(value)) return true;
  if (!value.startsWith('"') || !value.endsWith('"')) return false;
  let escaped = false;
  for (let index = 1; index < value.length - 1; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    const codePoint = character?.codePointAt(0);
    if (character === '"' || codePoint === undefined || codePoint === 0x7f || codePoint < 0x20) {
      return false;
    }
  }
  return !escaped;
}

function parseCacheControl(value: string | undefined): ParsedCacheControl {
  const fieldList = splitCacheControl(value ?? "");
  let maxAgeMilliseconds: number | undefined;
  let maxAgeCount = 0;
  let maxAgeInvalid = value !== undefined && fieldList.malformed;
  let noCache = false;
  let noStore = false;

  for (const rawDirective of fieldList.members) {
    const directive = rawDirective.trim();
    if (!directive) continue;
    const separator = directive.indexOf("=");
    const name = (separator === -1 ? directive : directive.slice(0, separator))
      .trim()
      .toLowerCase();
    const argument = separator === -1 ? undefined : directive.slice(separator + 1).trim();
    if (
      !HTTP_TOKEN_PATTERN.test(name) ||
      (argument !== undefined && !isValidDirectiveArgument(argument))
    ) {
      maxAgeInvalid = true;
      continue;
    }
    if (name === "no-cache") noCache = true;
    if (name === "no-store") noStore = true;
    if (name !== "max-age") continue;

    maxAgeCount += 1;
    const parsed = argument === undefined ? undefined : parseDeltaSeconds(argument);
    if (parsed === undefined) maxAgeInvalid = true;
    else maxAgeMilliseconds = parsed;
  }

  if (maxAgeCount > 1) maxAgeInvalid = true;
  return { maxAgeMilliseconds, maxAgeInvalid, noCache, noStore };
}

function parseAgeMilliseconds(value: string | undefined): number {
  const firstMember = value?.split(",", 1)[0]?.trim();
  if (firstMember === undefined) return 0;
  return parseDeltaSeconds(firstMember) ?? 0;
}

function remainingFreshness(
  headers: Readonly<Record<string, string>>,
  requestTime: number,
  responseTime: number,
): number {
  const directives = parseCacheControl(headers["cache-control"]);
  if (directives.noStore || directives.noCache) return 0;

  let freshnessLifetime = 0;
  if (directives.maxAgeInvalid) {
    freshnessLifetime = 0;
  } else if (directives.maxAgeMilliseconds !== undefined) {
    freshnessLifetime = directives.maxAgeMilliseconds;
  } else {
    const expires = parseImfFixdate(headers.expires);
    if (expires !== undefined) {
      const date = parseImfFixdate(headers.date);
      freshnessLifetime = Math.max(0, expires - (date ?? responseTime));
    }
  }

  const date = parseImfFixdate(headers.date);
  const apparentAge = date === undefined ? 0 : Math.max(0, responseTime - date);
  const responseDelay = Math.max(0, responseTime - requestTime);
  const ageValue = parseAgeMilliseconds(headers.age);
  const correctedInitialAge = Math.max(apparentAge, ageValue + responseDelay);
  return Math.max(0, freshnessLifetime - correctedInitialAge);
}

function shouldStore(headers: Readonly<Record<string, string>>): boolean {
  return !parseCacheControl(headers["cache-control"]).noStore;
}

function scopeConfirmation(
  originAlias: string,
  requestedScope: string | undefined,
  headers: Readonly<Record<string, string>>,
): string | undefined {
  if (requestedScope === undefined) return undefined;
  const confirmed = headers["remote-skills-scope"];
  if (
    confirmed !== requestedScope ||
    confirmed.includes(",") ||
    !/^[\x21-\x7e]{1,128}$/u.test(confirmed)
  ) {
    throw new RemoteSkillsError("catalog_invalid", {
      origin_alias: originAlias,
      field: "remote-skills-scope",
    });
  }
  return confirmed;
}

function catalogWithPersistence(
  catalog: OriginCatalog,
  canonicalUrl: string,
  requestedScope: string | undefined,
  confirmedScope: string | undefined,
  persistent: boolean,
): OriginCatalog {
  const {
    requestedScope: _requestedScope,
    confirmedScope: _confirmedScope,
    catalogIdentifier: _catalogIdentifier,
    persistent: _persistent,
    ...catalogSnapshot
  } = catalog;
  return Object.freeze({
    ...catalogSnapshot,
    ...(requestedScope === undefined ? {} : { requestedScope }),
    ...(confirmedScope === undefined ? {} : { confirmedScope }),
    ...(persistent
      ? { catalogIdentifier: canonicalOriginIdentifier(canonicalUrl, confirmedScope) }
      : {}),
    persistent,
  });
}

function persistentCacheEntry(
  originAlias: string,
  origin: NormalizedOrigin,
  state: CatalogState | undefined,
  backend: CatalogPersistence | undefined,
): CatalogCacheEntry | undefined {
  const cached = state?.catalog;
  if (
    cached === null ||
    cached === undefined ||
    (origin.scope === undefined && Object.keys(origin.headers).length > 0)
  ) {
    return undefined;
  }
  if (
    cached.metadata.canonicalUrl !== origin.catalogUrl.href ||
    cached.metadata.confirmedScope !== origin.scope
  ) {
    throw new RemoteSkillsError("catalog_invalid", {
      origin_alias: originAlias,
      field: "persistent_catalog",
    });
  }
  if (cached.body.byteLength > origin.catalogBytes) {
    throw new RemoteSkillsError("limit_exceeded", {
      origin_alias: originAlias,
      limit: "catalog_bytes",
    });
  }
  const accepted = acceptedCatalogEntry(backend, state, originAlias);
  if (accepted !== undefined) return accepted;
  const retrievedAt = Date.parse(cached.metadata.retrievedAt);
  const validatedAt = Date.parse(cached.metadata.validatedAt);
  if (!Number.isFinite(retrievedAt) || !Number.isFinite(validatedAt)) {
    throw new RemoteSkillsError("catalog_invalid", {
      origin_alias: originAlias,
      field: "persistent_catalog",
    });
  }
  const body = cached.body.slice();
  const parsed = parsePersistedCatalog(body, originAlias, origin.catalogUrl, origin.catalogBytes);
  if (parsed === undefined) return undefined;
  // Cache-v1 omits Date, Age, Expires and request delay. Require new freshness evidence.
  const responseHeaders: Record<string, string> = { "cache-control": "no-cache" };
  if (cached.metadata.etag !== undefined) responseHeaders.etag = cached.metadata.etag;
  if (cached.metadata.lastModified !== undefined) {
    responseHeaders["last-modified"] = cached.metadata.lastModified;
  }
  return {
    body,
    catalog: catalogWithPersistence(
      parsed,
      origin.catalogUrl.href,
      origin.scope,
      cached.metadata.confirmedScope,
      true,
    ),
    responseHeaders,
    etag: cached.metadata.etag,
    lastModified: cached.metadata.lastModified,
    expiresAt: Number.NEGATIVE_INFINITY,
    retrievedAt,
    storedAt: validatedAt,
  };
}

/** Cache-v1 has no final response URL: only base-independent bodies can be hydrated. */
export function parsePersistedCatalog(
  body: Uint8Array,
  originAlias: string,
  canonicalUrl: URL,
  catalogBytes: number,
): OriginCatalog | undefined {
  const parsed = parseCatalog(body, originAlias, canonicalUrl, catalogBytes);
  const alternate = new URL(
    `${canonicalUrl.protocol === "https:" ? "http:" : "https:"}//catalog-cache-base.invalid/other/index.json`,
  );
  const alternateParsed = parseCatalog(body, originAlias, alternate, catalogBytes);
  return isDeepStrictEqual(parsed.entries, alternateParsed.entries) ? parsed : undefined;
}

function preservesResolution(
  body: Uint8Array,
  catalog: OriginCatalog,
  origin: NormalizedOrigin,
): boolean {
  const parsed = parseCatalog(body, catalog.originAlias, origin.catalogUrl, origin.catalogBytes);
  return isDeepStrictEqual(parsed.entries, catalog.entries);
}

function sensitiveHeaderFragments(headers: Readonly<Record<string, string>>): readonly string[] {
  const fragments = new Set<string>();
  for (const value of Object.values(headers)) {
    const trimmed = value.trim();
    if (trimmed.length > 0) fragments.add(trimmed.toLowerCase());
    for (const token of trimmed.split(/[\s,;=]+/u)) {
      const unquoted = token.replace(/^["']+|["']+$/gu, "");
      if (unquoted.length > 0) fragments.add(unquoted.toLowerCase());
    }
  }
  return [...fragments];
}

function persistentCatalogSnapshot(
  canonicalUrl: string,
  body: Uint8Array,
  headers: Readonly<Record<string, string>>,
  configuredHeaders: Readonly<Record<string, string>>,
  confirmedScope: string | undefined,
  retrievedAt: number,
  validatedAt: number,
): CachedCatalog {
  const sensitiveFragments = sensitiveHeaderFragments(configuredHeaders);
  const safeMetadataValue = (value: string | undefined): string | undefined =>
    value !== undefined &&
    !sensitiveFragments.some((fragment) => value.toLowerCase().includes(fragment))
      ? value
      : undefined;
  const etag = safeMetadataValue(headers.etag);
  const lastModified = safeMetadataValue(headers["last-modified"]);
  const cacheControl = safeMetadataValue(headers["cache-control"]);
  const metadata: CatalogMetadataInput = {
    ...(confirmedScope === undefined ? {} : { confirmedScope }),
    ...(etag === undefined ? {} : { etag }),
    ...(lastModified === undefined ? {} : { lastModified }),
    ...(cacheControl === undefined ? {} : { cacheControl }),
    retrievedAt: new Date(retrievedAt).toISOString(),
    validatedAt: new Date(validatedAt).toISOString(),
  };
  return { body, metadata: { canonicalUrl, ...metadata } };
}

async function replacePersistentCatalog(
  cache: CatalogPersistence | undefined,
  candidate: CachedCatalog,
  expected: CatalogState | undefined,
  entry: CatalogCacheEntry,
): Promise<boolean> {
  if (cache === undefined) return true;
  try {
    // Storage examines raw ignored metadata too. Refusal here is admission policy,
    // whereas failures from backend operations below still describe cache state.
    snapshotCatalogBody(candidate.body);
  } catch (error) {
    if (!(error instanceof CacheCorruptError || error instanceof CacheConfigurationError)) {
      throw error;
    }
    entry.catalog = catalogWithPersistence(
      entry.catalog,
      candidate.metadata.canonicalUrl,
      entry.catalog.requestedScope,
      candidate.metadata.confirmedScope,
      false,
    );
    return deletePersistentCatalog(
      cache,
      candidate.metadata.canonicalUrl,
      candidate.metadata.confirmedScope,
      expected,
    );
  }
  const published = await cache.replaceCatalog(candidate, expected?.generation ?? "");
  if (!published) return false;
  const state = await cache.getCatalogState(
    candidate.metadata.canonicalUrl,
    candidate.metadata.confirmedScope,
  );
  if (
    state.catalog !== null &&
    isDeepStrictEqual(state.catalog.metadata, candidate.metadata) &&
    Buffer.from(state.catalog.body).equals(candidate.body)
  ) {
    const records: Map<string, AcceptedCatalog> = acceptedCatalogs.get(cache) ?? new Map();
    acceptedCatalogs.set(cache, records);
    const key = canonicalOriginIdentifier(
      candidate.metadata.canonicalUrl,
      candidate.metadata.confirmedScope,
    );
    // Bound supplemental evidence independently of backend capacity and eviction policy.
    if (records.size >= 128) {
      const oldest = records.keys().next().value;
      if (oldest !== undefined) records.delete(oldest);
    }
    records.set(key, { generation: state.generation, entry });
  }
  return true;
}

async function deletePersistentCatalog(
  cache: CatalogPersistence | undefined,
  canonicalUrl: string,
  confirmedScope: string | undefined,
  expected: CatalogState | undefined,
): Promise<boolean> {
  return (
    cache === undefined ||
    expected?.catalog === null ||
    expected === undefined ||
    cache.deleteCatalog(canonicalUrl, confirmedScope, expected.generation)
  );
}

function configurationError(field: string): RemoteSkillsError {
  return new RemoteSkillsError("configuration_invalid", { field });
}

export function createCatalogDiscovery(
  config: CatalogDiscoveryConfig,
  dependencies: CatalogDiscoveryDependencies = {},
): CatalogDiscovery {
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    throw configurationError("config");
  }
  const origins = normalizeOrigins(config.origins, config.defaults);
  const runtime = createRuntime(dependencies);
  const cache = new Map<string, CatalogCacheEntry>();
  const mutationCoordinator = createMutationCoordinator();
  const generations = mutationCoordinator.generations;
  const mutationTails = mutationCoordinator.tails;
  const mutationKeys = new Map(
    [...origins].map(([alias, origin]) => [
      alias,
      canonicalOriginIdentifier(origin.catalogUrl.href, origin.scope),
    ]),
  );

  async function withMutationLock<T>(key: string, action: () => T | Promise<T>): Promise<T> {
    const previous = mutationTails.get(key) ?? Promise.resolve();
    let release = () => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    mutationTails.set(key, tail);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (mutationTails.get(key) === tail) mutationTails.delete(key);
    }
  }

  function deleteMemoryEntries(key: string): void {
    for (const cachedAlias of cache.keys()) {
      if (mutationKeys.get(cachedAlias) === key) cache.delete(cachedAlias);
    }
  }

  async function commitCurrentGeneration(
    key: string,
    generation: number,
    mutatePersistence: () => Promise<boolean>,
    commitMemory: () => void = () => {},
  ): Promise<boolean> {
    return withMutationLock(key, async () => {
      if (generations.get(key) !== generation) return false;
      const won = await mutatePersistence();
      deleteMemoryEntries(key);
      if (won) commitMemory();
      return won;
    });
  }

  async function getOrigin(
    alias: string,
    options: OriginCatalogOptions = {},
  ): Promise<OriginCatalog> {
    try {
      return await discoverOrigin(alias, options);
    } catch (error) {
      if (error instanceof CacheCorruptError || error instanceof CacheConfigurationError) {
        // Backend messages, contexts and causes are not public diagnostic inputs.
        throw new RemoteSkillsError(error.code, { origin_alias: alias });
      }
      throw error;
    }
  }

  async function discoverOrigin(
    alias: string,
    options: OriginCatalogOptions,
  ): Promise<OriginCatalog> {
    const origin = origins.get(alias);
    if (!origin) throw configurationError(`origins.${alias}`);
    const mutationKey = mutationKeys.get(alias);
    if (mutationKey === undefined) throw configurationError(`origins.${alias}`);
    const start = await withMutationLock<OriginRequestStart>(mutationKey, async () => {
      let cached = cache.get(alias);
      const persistentExpected = await dependencies.persistentCache?.getCatalogState(
        origin.catalogUrl.href,
        origin.scope,
      );
      if (cached === undefined) {
        cached = persistentCacheEntry(
          alias,
          origin,
          persistentExpected,
          dependencies.persistentCache,
        );
        if (cached !== undefined) cache.set(alias, cached);
      }
      const requestTime = runtime.now();
      if (!options.forceRevalidate && cached && cached.expiresAt > requestTime) {
        return { kind: "fresh", catalog: cached.catalog };
      }
      const generation = (generations.get(mutationKey) ?? 0) + 1;
      generations.set(mutationKey, generation);
      return { kind: "request", cached, generation, persistentExpected, requestTime };
    });
    if (start.kind === "fresh") return start.catalog;
    const { cached, generation, persistentExpected, requestTime } = start;

    const validators: Record<string, string> = {};
    if (cached?.lastModified) validators["if-modified-since"] = cached.lastModified;
    if (cached?.etag) validators["if-none-match"] = cached.etag;
    const response = await requestWithPolicy(
      {
        origin,
        url: origin.catalogUrl,
        purpose: "catalog",
        accept: "application/json",
        headers: validators,
        maxBytes: origin.catalogBytes,
      },
      runtime,
    );
    const responseTime = runtime.now();
    let confirmedScope: string | undefined;
    try {
      confirmedScope = scopeConfirmation(alias, origin.scope, response.headers);
    } catch (error) {
      await commitCurrentGeneration(mutationKey, generation, () =>
        deletePersistentCatalog(
          dependencies.persistentCache,
          origin.catalogUrl.href,
          origin.scope,
          persistentExpected,
        ),
      );
      throw error;
    }

    if (response.status === 304) {
      if (!cached) {
        throw new RemoteSkillsError("origin_unavailable", {
          origin_alias: alias,
          status: 304,
        });
      }
      const responseHeaders = { ...cached.responseHeaders, ...response.headers };
      if (!shouldStore(responseHeaders)) {
        await commitCurrentGeneration(mutationKey, generation, () =>
          deletePersistentCatalog(
            dependencies.persistentCache,
            origin.catalogUrl.href,
            confirmedScope,
            persistentExpected,
          ),
        );
        return catalogWithPersistence(
          cached.catalog,
          origin.catalogUrl.href,
          origin.scope,
          confirmedScope,
          false,
        );
      }
      const persistent =
        preservesResolution(cached.body, cached.catalog, origin) &&
        cached.body.byteLength <= (dependencies.persistentCache?.maxCatalogBytes ?? Infinity) &&
        (confirmedScope !== undefined || Object.keys(origin.headers).length === 0);
      const catalog = catalogWithPersistence(
        cached.catalog,
        origin.catalogUrl.href,
        origin.scope,
        confirmedScope,
        persistent,
      );
      const updated: CatalogCacheEntry = {
        ...cached,
        catalog,
        responseHeaders,
        etag: responseHeaders.etag,
        lastModified: responseHeaders["last-modified"],
        expiresAt: responseTime + remainingFreshness(responseHeaders, requestTime, responseTime),
        storedAt: responseTime,
      };
      const committed = await commitCurrentGeneration(
        mutationKey,
        generation,
        () =>
          persistent
            ? replacePersistentCatalog(
                dependencies.persistentCache,
                persistentCatalogSnapshot(
                  origin.catalogUrl.href,
                  cached.body,
                  responseHeaders,
                  origin.headers,
                  confirmedScope,
                  cached.retrievedAt,
                  responseTime,
                ),
                persistentExpected,
                updated,
              )
            : deletePersistentCatalog(
                dependencies.persistentCache,
                origin.catalogUrl.href,
                confirmedScope,
                persistentExpected,
              ),
        () => cache.set(alias, updated),
      );
      return committed
        ? updated.catalog
        : catalogWithPersistence(
            catalog,
            origin.catalogUrl.href,
            origin.scope,
            confirmedScope,
            false,
          );
    }

    let parsed: OriginCatalog;
    try {
      parsed = parseCatalog(response.body, alias, new URL(response.url), origin.catalogBytes);
    } catch (error) {
      await commitCurrentGeneration(mutationKey, generation, () =>
        deletePersistentCatalog(
          dependencies.persistentCache,
          origin.catalogUrl.href,
          confirmedScope,
          persistentExpected,
        ),
      );
      throw error;
    }
    const persistentlyReusable =
      preservesResolution(response.body, parsed, origin) &&
      // Shared cache-v1 bodies have a fixed cap; larger accepted catalogs remain in memory.
      response.body.byteLength <= (dependencies.persistentCache?.maxCatalogBytes ?? Infinity) &&
      shouldStore(response.headers) &&
      (confirmedScope !== undefined || Object.keys(origin.headers).length === 0);
    const catalog = catalogWithPersistence(
      parsed,
      origin.catalogUrl.href,
      origin.scope,
      confirmedScope,
      persistentlyReusable,
    );
    const body = response.body.slice();
    const entry: CatalogCacheEntry = {
      body,
      catalog,
      responseHeaders: response.headers,
      etag: response.headers.etag,
      lastModified: response.headers["last-modified"],
      expiresAt: responseTime + remainingFreshness(response.headers, requestTime, responseTime),
      retrievedAt: responseTime,
      storedAt: responseTime,
    };
    const committed = await commitCurrentGeneration(
      mutationKey,
      generation,
      () =>
        persistentlyReusable
          ? replacePersistentCatalog(
              dependencies.persistentCache,
              persistentCatalogSnapshot(
                origin.catalogUrl.href,
                body,
                response.headers,
                origin.headers,
                confirmedScope,
                responseTime,
                responseTime,
              ),
              persistentExpected,
              entry,
            )
          : deletePersistentCatalog(
              dependencies.persistentCache,
              origin.catalogUrl.href,
              confirmedScope,
              persistentExpected,
            ),
      () => {
        if (!shouldStore(response.headers)) return;
        cache.set(alias, entry);
      },
    );
    return committed
      ? entry.catalog
      : catalogWithPersistence(
          catalog,
          origin.catalogUrl.href,
          origin.scope,
          confirmedScope,
          false,
        );
  }

  return {
    origin: getOrigin,
    async catalog(options = {}) {
      const aliases = [...origins.keys()];
      const settled = await Promise.all(
        aliases.map(async (alias) => {
          try {
            return { alias, catalog: await getOrigin(alias) };
          } catch (error) {
            if (error instanceof RemoteSkillsError) return { alias, error };
            throw error;
          }
        }),
      );
      const entries = settled.flatMap((result) => result.catalog?.entries ?? []);
      const failures = settled.flatMap((result) =>
        result.error ? [{ originAlias: result.alias, error: result.error }] : [],
      );
      if (options.strict && failures.length > 0) throw new CatalogAggregateError(failures);
      return Object.freeze({
        entries: Object.freeze(entries),
        failures: Object.freeze(failures.map((failure) => Object.freeze(failure))),
      });
    },
  };
}

import { randomUUID } from "node:crypto";

import {
  createActivationCoordinator,
  normalizeActivationLimits,
  verifyCachedExtraction,
} from "../activation/index.ts";
import type { ActivatedSkill, ActivationPin } from "../activation/types.ts";
import { canonicalOriginIdentifier, resolveCache } from "../cache/index.ts";
import type { CacheBackend, CachedCatalog } from "../cache/types.ts";
import { acceptedCatalogEntry, parsePersistedCatalog } from "../catalog/discovery.ts";
import { createCatalogDiscovery, RemoteSkillsError } from "../catalog/index.ts";
import type { OriginCatalog } from "../catalog/types.ts";
import { normalizeOrigins } from "../origin.ts";
import type {
  ActivatedSessionSkill,
  RemoteSkillsClient,
  RemoteSkillsConfig,
  RemoteSkillsDependencies,
  RemoteSkillsSession,
  SessionMetadata,
} from "./types.ts";

interface SessionSnapshot {
  readonly catalog: OriginCatalog;
  readonly staleAgeMs?: number;
}

function configuration(field: string): never {
  throw new RemoteSkillsError("configuration_invalid", { field });
}

function isUnavailable(error: unknown): error is RemoteSkillsError {
  return (
    error instanceof RemoteSkillsError &&
    (error.code === "origin_unavailable" || error.code === "request_timeout")
  );
}

function staleCatalog(
  cached: CachedCatalog,
  originAlias: string,
  requestedScope: string | undefined,
  catalogUrl: URL,
  catalogBytes: number,
  accepted: OriginCatalog | undefined,
): OriginCatalog | undefined {
  const parsed =
    accepted ?? parsePersistedCatalog(cached.body, originAlias, catalogUrl, catalogBytes);
  if (parsed === undefined) return undefined;
  const confirmedScope = cached.metadata.confirmedScope;
  return Object.freeze({
    ...parsed,
    ...(requestedScope === undefined ? {} : { requestedScope }),
    ...(confirmedScope === undefined ? {} : { confirmedScope }),
    catalogIdentifier: canonicalOriginIdentifier(catalogUrl.href, confirmedScope),
    persistent: true,
    stale: true,
  });
}

function sessionMetadata(snapshot: SessionSnapshot): SessionMetadata {
  const catalog = snapshot.catalog;
  return Object.freeze({
    originAlias: catalog.originAlias,
    ...(catalog.requestedScope === undefined ? {} : { requestedScope: catalog.requestedScope }),
    ...(catalog.confirmedScope === undefined ? {} : { confirmedScope: catalog.confirmedScope }),
    stale: catalog.stale,
    ...(snapshot.staleAgeMs === undefined ? {} : { staleAgeMs: snapshot.staleAgeMs }),
  });
}

function createSession(
  snapshot: SessionSnapshot,
  coordinator: ReturnType<typeof createActivationCoordinator>,
  maintainCache: (() => Promise<void>) | undefined,
): RemoteSkillsSession {
  const metadata = sessionMetadata(snapshot);
  const activated = new Map<string, Promise<ActivatedSessionSkill>>();
  let state: "closed" | "closing" | "open" = "open";
  let closing: Promise<void> | undefined;
  let needsCacheMaintenance = snapshot.catalog.persistent;

  function requireOpen(): void {
    if (state !== "open") {
      throw new RemoteSkillsError("session_closed", {
        origin_alias: snapshot.catalog.originAlias,
      });
    }
  }

  function bindSkill(skill: ActivatedSkill & ActivationPin): ActivatedSessionSkill {
    return Object.freeze({
      name: skill.name,
      description: skill.description,
      digest: skill.digest,
      ...(skill.version === undefined ? {} : { version: skill.version }),
      instructions: skill.instructions,
      frontmatter: skill.frontmatter,
      originAlias: skill.originAlias,
      ...(skill.confirmedScope === undefined ? {} : { confirmedScope: skill.confirmedScope }),
      descriptor: skill.descriptor,
      async list(prefix?: string) {
        requireOpen();
        return prefix === undefined ? skill.list() : skill.list(prefix);
      },
      async read(path: string) {
        requireOpen();
        return skill.read(path);
      },
      async readBytes(path: string) {
        requireOpen();
        return skill.readBytes(path);
      },
    });
  }

  const session: RemoteSkillsSession = {
    metadata,
    stale: metadata.stale,
    ...(metadata.staleAgeMs === undefined ? {} : { staleAgeMs: metadata.staleAgeMs }),
    async catalog() {
      requireOpen();
      return snapshot.catalog.entries;
    },
    async activate(name, requestedRange) {
      requireOpen();
      // Failed or in-flight activation may also leave cache coordination state to clean up.
      needsCacheMaintenance = true;
      const existing = activated.get(name);
      if (existing !== undefined) return existing;
      const pending = coordinator.activate(name, requestedRange).then((skill) => {
        requireOpen();
        return bindSkill(skill);
      });
      activated.set(name, pending);
      // The caller receives this same rejecting promise; this side handler only makes a retry possible.
      void pending.catch(() => {
        if (activated.get(name) === pending) activated.delete(name);
      });
      return pending;
    },
    close() {
      if (closing !== undefined) return closing;
      state = "closing";
      closing = coordinator
        .release()
        .then(() => (needsCacheMaintenance ? maintainCache?.() : undefined))
        .finally(() => {
          activated.clear();
          state = "closed";
        });
      return closing;
    },
    [Symbol.asyncDispose]() {
      return session.close();
    },
  };
  return Object.freeze(session);
}

async function staleSnapshot(
  cache: CacheBackend,
  originAlias: string,
  catalogUrl: URL,
  requestedScope: string | undefined,
  maximumAgeMs: number,
  now: number,
  unavailable: RemoteSkillsError,
  catalogBytes: number,
): Promise<SessionSnapshot> {
  const state = await cache.getCatalogState(catalogUrl.href, requestedScope);
  const cached = state.catalog;
  if (
    cached === null ||
    cached.metadata.canonicalUrl !== catalogUrl.href ||
    cached.metadata.confirmedScope !== requestedScope
  ) {
    throw unavailable;
  }
  const validatedAt = Date.parse(cached.metadata.validatedAt);
  const age = now - validatedAt;
  if (
    !Number.isFinite(validatedAt) ||
    !Number.isSafeInteger(age) ||
    age < 0 ||
    age > maximumAgeMs
  ) {
    throw unavailable;
  }
  const catalog = staleCatalog(
    cached,
    originAlias,
    requestedScope,
    catalogUrl,
    catalogBytes,
    acceptedCatalogEntry(cache, state, originAlias)?.catalog,
  );
  if (catalog === undefined) throw unavailable;
  return Object.freeze({
    catalog,
    staleAgeMs: age,
  });
}

export function createRemoteSkills(
  config: RemoteSkillsConfig,
  dependencies: RemoteSkillsDependencies = {},
): RemoteSkillsClient {
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    configuration("config");
  }
  const origins = normalizeOrigins(config.origins, config.defaults);
  const limits = normalizeActivationLimits(config.limits);
  const cache = resolveCache(
    config.cache,
    {
      ...config.cacheOptions,
      verifyExtractedContents: verifyCachedExtraction,
    },
    limits,
  );
  // Built-in eviction also runs bounded disk cleanup and preserves other sessions' leases.
  const maintainCache =
    config.cache === undefined || config.cache === "disk" || config.cache === "memory"
      ? async () => {
          await cache.evict();
        }
      : undefined;
  const { sessionNonce = randomUUID, ...requestDependencies } = dependencies;
  const discovery = createCatalogDiscovery(
    {
      origins: config.origins,
      ...(config.defaults === undefined ? {} : { defaults: config.defaults }),
    },
    { ...requestDependencies, persistentCache: cache },
  );

  async function snapshot(originAlias: string): Promise<SessionSnapshot> {
    const origin = origins.get(originAlias);
    if (origin === undefined) configuration(`origins.${originAlias}`);
    try {
      return Object.freeze({ catalog: await discovery.origin(originAlias) });
    } catch (error) {
      if (!isUnavailable(error) || origin.maxStaleAgeMs === undefined) throw error;
      return staleSnapshot(
        cache,
        originAlias,
        origin.catalogUrl,
        origin.scope,
        origin.maxStaleAgeMs,
        requestDependencies.now?.() ?? Date.now(),
        error,
        origin.catalogBytes,
      );
    }
  }

  return Object.freeze({
    catalog: discovery.catalog,
    async session(originAlias: string) {
      const origin = origins.get(originAlias);
      if (origin === undefined) configuration(`origins.${originAlias}`);
      const selected = await snapshot(originAlias);
      return createSession(
        selected,
        createActivationCoordinator(
          {
            origin,
            catalog: selected.catalog,
            cache,
            sessionNonce: sessionNonce(),
            limits,
          },
          requestDependencies,
        ),
        maintainCache,
      );
    },
    async refresh(originAlias?: string) {
      if (originAlias !== undefined) {
        await discovery.origin(originAlias, { forceRevalidate: true });
        return;
      }
      await Promise.all(
        [...origins.keys()].map((alias) =>
          discovery.origin(alias, { forceRevalidate: true }).then(() => undefined),
        ),
      );
    },
  });
}

import assert from "node:assert/strict";
import { createSocket } from "node:dgram";
import { Resolver } from "node:dns/promises";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  type CacheBackend,
  CacheConfigurationError,
  CacheCorruptError,
  DiskCache,
  MemoryCache,
} from "../src/cache/index.ts";
import type {
  CatalogDefaults,
  CatalogDiscovery,
  CatalogDiscoveryDependencies,
  CatalogPersistence,
  OriginMap,
  TransportRequest,
  TransportResponse,
} from "../src/catalog/index.ts";
import * as catalog from "../src/catalog/index.ts";
import * as transport from "../src/catalog/transport.ts";
import { createRemoteSkills } from "../src/index.ts";
import { runProtocolCase } from "../src/protocol-adapter.ts";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const validCatalog = await readFile(
  resolve(repositoryRoot, "tests/protocol/fixtures/catalog/valid-v0.2.json"),
);
const schemaUrl = "https://schemas.agentskills.io/discovery/0.2.0/schema.json";

interface CatalogEntryInput {
  description: string;
  digest: string;
  name: string;
  type: string;
  url: string;
  [extension: `x-${string}`]: unknown;
}

interface HarnessOptions {
  now?: number;
  random?: () => number;
  resolve?: CatalogDiscoveryDependencies["resolve"];
  responseDelayMs?: number;
}

interface DiscoveryHarness {
  advance(milliseconds: number): void;
  delays: number[];
  dependencies: CatalogDiscoveryDependencies;
  requests: TransportRequest[];
  requestStarted: EventEmitter;
}

type Respond = (
  request: TransportRequest,
  count: number,
) => TransportResponse | Promise<TransportResponse>;

function errorCode(value: unknown): unknown {
  return typeof value === "object" && value !== null && "code" in value ? value.code : undefined;
}

function errorContext(value: unknown): Readonly<Record<string, unknown>> {
  assert.ok(typeof value === "object" && value !== null && "context" in value);
  const context = value.context;
  assert.ok(isRecord(context));
  return context;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function storedCatalogSkillName(bytes: Uint8Array): string {
  const parsed: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
  assert.ok(isRecord(parsed));
  assert.ok(Array.isArray(parsed.skills));
  const first = parsed.skills[0];
  assert.ok(isRecord(first));
  if (typeof first.name !== "string") throw new TypeError("stored catalog skill name is invalid");
  return first.name;
}

function protocolFixtureCases(text: string): Record<string, unknown>[] {
  const parsed: unknown = JSON.parse(text);
  assert.ok(isRecord(parsed));
  assert.ok(Array.isArray(parsed.cases));
  return parsed.cases.map((fixture) => {
    assert.ok(isRecord(fixture));
    return fixture;
  });
}

function addressPolicyFixtures(
  text: string,
): Record<string, { address: string; decision: "allow" | "deny" }> {
  const parsed: unknown = JSON.parse(text);
  assert.ok(isRecord(parsed));
  const fixtures: Record<string, { address: string; decision: "allow" | "deny" }> = {};
  for (const [id, value] of Object.entries(parsed)) {
    assert.ok(isRecord(value));
    if (id === "rebinding") {
      assert.ok(Array.isArray(value.answers));
      assert.ok(value.answers.every((address) => typeof address === "string"));
      continue;
    }
    if (typeof value.address !== "string") throw new TypeError(`${id}.address must be a string`);
    if (value.decision !== "allow" && value.decision !== "deny") {
      throw new TypeError(`${id}.decision must be allow or deny`);
    }
    fixtures[id] = { address: value.address, decision: value.decision };
  }
  return fixtures;
}

function errorMessage(value: unknown): string {
  assert.ok(value instanceof Error);
  return value.message;
}

function errorDiagnostic(value: unknown): unknown {
  assert.ok(value instanceof catalog.RemoteSkillsError);
  return value.toDiagnostic();
}

function normalizeOriginsFromUnknown(origins: unknown, defaults?: unknown): unknown {
  return Reflect.apply(catalog.normalizeOrigins, catalog, [origins, defaults]);
}

function createDiscoveryFromUnknown(config: unknown): unknown {
  return Reflect.apply(catalog.createCatalogDiscovery, catalog, [config]);
}

function consumeResponseFromUnknown(
  response: unknown,
  maxBytes: number,
): Promise<TransportResponse> {
  return Reflect.apply(transport.consumeResponse, transport, [response, maxBytes]);
}

function catalogBytes(skills: readonly object[]): Buffer {
  return Buffer.from(`${JSON.stringify({ $schema: schemaUrl, skills })}\n`);
}

function validEntry(overrides: Partial<CatalogEntryInput> = {}): CatalogEntryInput {
  return {
    name: "code-review",
    description: "Review code.",
    type: "skill-md",
    url: "artifacts/code-review.md",
    digest: `sha256:${"a".repeat(64)}`,
    ...overrides,
  };
}

function makeResponse(
  status: number,
  options: { body?: Uint8Array; headers?: Readonly<{ [name: string]: string }> } = {},
): TransportResponse {
  return {
    status,
    headers: options.headers ?? {},
    body: options.body ?? new Uint8Array(),
  };
}

function deferred<T>() {
  let resolvePromise: (value: T) => void = () => {};
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

async function waitForRequestCount(
  harness: DiscoveryHarness,
  count: number,
  discoveryRequest: Promise<unknown>,
): Promise<void> {
  // Persistent reads can take arbitrarily long before transport starts. Coordinate on
  // arrival, while propagating a discovery failure instead of leaving a pending waiter.
  const arrived = deferred<void>();
  const checkCount = () => {
    if (harness.requests.length >= count) arrived.resolve(undefined);
  };
  harness.requestStarted.on("request", checkCount);
  try {
    checkCount();
    await Promise.race([arrived.promise, discoveryRequest]);
    assert.equal(harness.requests.length, count);
  } finally {
    harness.requestStarted.off("request", checkCount);
  }
}

async function forEachPersistentCache(
  run: (kind: "disk" | "memory", cache: CacheBackend) => Promise<void>,
): Promise<void> {
  await run("memory", new MemoryCache());
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-discovery-race-"));
  try {
    await run("disk", new DiskCache({ directory }));
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

const canonicalCatalogUrl = "https://skills.example.test/.well-known/agent-skills/index.json";

async function assertCatalogWinner(
  discovery: CatalogDiscovery,
  persistentCache: CacheBackend,
  expectedName: string,
  context: string,
  confirmedScope: string | undefined = undefined,
): Promise<void> {
  const inMemory = await discovery.origin("acme");
  const stored = await persistentCache.getCatalog(canonicalCatalogUrl, confirmedScope);
  const inMemoryWinner = inMemory.entries[0];
  assert.ok(inMemoryWinner);
  assert.equal(inMemoryWinner.name, expectedName, `${context}: in-memory winner`);
  assert.ok(stored, `${context}: persistent winner is present`);
  assert.equal(storedCatalogSkillName(stored.body), expectedName, `${context}: persistent winner`);
}

function createHarness(respond: Respond, options: HarnessOptions = {}): DiscoveryHarness {
  const requests: TransportRequest[] = [];
  const requestStarted = new EventEmitter();
  const delays: number[] = [];
  let now = options.now ?? Date.parse("2026-08-25T10:00:00.000Z");
  return {
    requests,
    requestStarted,
    delays,
    dependencies: {
      now: () => now,
      random: options.random ?? (() => 0),
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
      },
      resolve: options.resolve ?? (async () => [{ address: "93.184.216.34", family: 4 as const }]),
      transport: async (request) => {
        requests.push(request);
        requestStarted.emit("request");
        const response = await respond(request, requests.length);
        now += options.responseDelayMs ?? 0;
        return response;
      },
    },
    advance(milliseconds) {
      now += milliseconds;
    },
  };
}

function createDiscovery(
  origins: OriginMap,
  harness: DiscoveryHarness,
  defaults?: CatalogDefaults,
): CatalogDiscovery {
  return catalog.createCatalogDiscovery(
    defaults === undefined ? { origins } : { origins, defaults },
    harness.dependencies,
  );
}

test("redirected catalog descriptors survive memory and 304 reuse and revalidate after restart", async () => {
  await forEachPersistentCache(async (_kind, persistentCache) => {
    const redirected = "https://skills.example.test/releases/index.json";
    const harness = createHarness((request) => {
      if (request.url === canonicalCatalogUrl) {
        return makeResponse(302, { headers: { location: redirected } });
      }
      return request.headers["if-none-match"]
        ? makeResponse(304, { headers: { "cache-control": "max-age=60" } })
        : makeResponse(200, {
            body: catalogBytes([validEntry()]),
            headers: { etag: '"redirected"', "cache-control": "max-age=60" },
          });
    });
    harness.dependencies.persistentCache = persistentCache;
    const origins = { acme: { url: "https://skills.example.test" } };
    const discovery = createDiscovery(origins, harness);
    const first = await discovery.origin("acme");
    assert.equal(
      first.entries[0]?.url,
      "https://skills.example.test/releases/artifacts/code-review.md",
    );
    assert.deepEqual((await discovery.origin("acme")).entries, first.entries);
    assert.equal(harness.requests.length, 2);
    assert.deepEqual(
      (await discovery.origin("acme", { forceRevalidate: true })).entries,
      first.entries,
    );
    assert.deepEqual(
      (await createDiscovery(origins, harness).origin("acme")).entries,
      first.entries,
    );
    assert.equal(harness.requests.length, 6);
    assert.equal(harness.requests[4]?.headers["if-none-match"], undefined);
  });
});

test("persisted catalogs cannot restart corrected freshness or reuse an unknown relative base", async () => {
  for (const url of [
    "artifacts/code-review.md",
    "https://skills.example.test/artifacts/code-review.md",
  ]) {
    await forEachPersistentCache(async (_kind, persistentCache) => {
      const harness = createHarness(() =>
        makeResponse(200, {
          body: catalogBytes([validEntry({ url })]),
          headers: { "cache-control": "max-age=60", age: "50", etag: '"aged"' },
        }),
      );
      harness.dependencies.persistentCache = persistentCache;
      const origins = { acme: { url: "https://skills.example.test" } };
      await createDiscovery(origins, harness).origin("acme");
      harness.advance(11_000);
      const stored = await persistentCache.getCatalog(canonicalCatalogUrl);
      assert.ok(stored);
      const restartedCache =
        persistentCache instanceof DiskCache
          ? new DiskCache({ directory: persistentCache.directory })
          : new MemoryCache();
      if (restartedCache instanceof MemoryCache) {
        await restartedCache.putCatalog(canonicalCatalogUrl, stored.body, stored.metadata);
      }
      harness.dependencies.persistentCache = restartedCache;
      await createDiscovery(origins, harness).origin("acme");
      assert.equal(harness.requests.length, 2);
      assert.equal(
        harness.requests[1]?.headers["if-none-match"],
        url.startsWith("https:") ? '"aged"' : undefined,
      );
    });
  }
});

test("shared accepted catalog evidence keeps corrected freshness and rejects changed generations", async () => {
  for (const headers of [
    { "cache-control": "max-age=60", age: "50" },
    { date: "Tue, 25 Aug 2026 10:00:00 GMT", expires: "Tue, 25 Aug 2026 10:01:00 GMT", age: "50" },
  ]) {
    await forEachPersistentCache(async (_kind, persistentCache) => {
      const body = catalogBytes([
        validEntry({ url: "https://skills.example.test/artifacts/review.md" }),
      ]);
      const harness = createHarness(() => makeResponse(200, { body, headers }), {
        now: Date.parse("2026-08-25T10:00:00.000Z"),
      });
      harness.dependencies.persistentCache = persistentCache;
      const origins = { acme: { url: "https://skills.example.test" } };
      await createDiscovery(origins, harness).origin("acme");
      harness.advance(5_000);
      await createDiscovery(origins, harness).origin("acme");
      assert.equal(harness.requests.length, 1);
      harness.advance(6_000);
      await createDiscovery(origins, harness).origin("acme");
      assert.equal(harness.requests.length, 2);
      const stored = await persistentCache.getCatalog(canonicalCatalogUrl);
      assert.ok(stored);
      await persistentCache.putCatalog(canonicalCatalogUrl, body, {
        ...stored.metadata,
        etag: '"replacement"',
      });
      await createDiscovery(origins, harness).origin("acme");
      assert.equal(harness.requests.length, 3);
      assert.equal(harness.requests[2]?.headers["if-none-match"], '"replacement"');
    });
  }
});

async function listenLoopback(server: Server): Promise<number> {
  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (error: Error) => rejectListen(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolveListen();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("loopback server has no TCP port");
  return address.port;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()));
  });
}

test("aggregate discovery preserves origin-qualified collisions without precedence", async () => {
  const harness = createHarness(() => makeResponse(200, { body: validCatalog }));
  const discovery = createDiscovery(
    {
      acme: { url: "https://skills.example.test" },
      beta: { url: "https://other.example.test" },
    },
    harness,
  );

  const result = await discovery.catalog();

  assert.deepEqual(
    result.entries
      .filter(({ name }) => name === "code-review")
      .map(({ originAlias }) => originAlias),
    ["acme", "beta"],
  );
  assert.deepEqual(result.failures, []);
  assert.equal(
    harness.requests.every(({ url }) => url.endsWith("/.well-known/agent-skills/index.json")),
    true,
  );
});

test("non-strict aggregation returns healthy entries and typed per-origin failures", async () => {
  const harness = createHarness((request) => {
    if (request.url.startsWith("https://broken.example.test"))
      throw new Error("secret outage body");
    return makeResponse(200, { body: validCatalog });
  });
  const discovery = createDiscovery(
    {
      acme: { url: "https://skills.example.test" },
      broken: { url: "https://broken.example.test", retries: 0 },
    },
    harness,
  );

  const result = await discovery.catalog();

  assert.equal(result.entries.length, 2);
  assert.deepEqual(
    result.failures.map(({ originAlias, error }) => ({
      originAlias,
      diagnostic: errorDiagnostic(error),
    })),
    [
      {
        originAlias: "broken",
        diagnostic: {
          code: "origin_unavailable",
          retryable: true,
          context: { origin_alias: "broken" },
        },
      },
    ],
  );
});

test("strict aggregation throws while retaining every per-origin failure", async () => {
  const harness = createHarness(() => {
    throw new Error("unavailable");
  });
  const discovery = createDiscovery(
    {
      acme: { url: "https://skills.example.test", retries: 0 },
      beta: { url: "https://other.example.test", retries: 0 },
    },
    harness,
  );

  await assert.rejects(
    discovery.catalog({ strict: true }),
    (error) =>
      error instanceof catalog.CatalogAggregateError &&
      error.failures.map(({ originAlias }) => originAlias).join(",") === "acme,beta",
  );
});

for (const cacheFailure of [
  new CacheCorruptError(
    "injected cache failure detail",
    { layout_version: "backend detail" },
    {
      cause: new Error("injected cache cause"),
    },
  ),
  new CacheConfigurationError("injected backend field"),
]) {
  for (const operation of ["getCatalogState", "replaceCatalog", "deleteCatalog"] as const) {
    test(`known origin cache failure ${cacheFailure.code} during ${operation} stays typed and isolated`, async () => {
      const backend = new MemoryCache();
      let fail = false;
      const brokenUrl = "https://broken.example.test/.well-known/agent-skills/index.json";
      const injectFailure = (method: typeof operation, url: string) => {
        if (fail && method === operation && url === brokenUrl) throw cacheFailure;
      };
      const persistentCache: CatalogPersistence = {
        getCatalogState: async (url, scope) => {
          injectFailure("getCatalogState", url);
          return backend.getCatalogState(url, scope);
        },
        replaceCatalog: async (candidate, generation) => {
          injectFailure("replaceCatalog", candidate.metadata.canonicalUrl);
          return backend.replaceCatalog(candidate, generation);
        },
        deleteCatalog: async (url, scope, generation) => {
          injectFailure("deleteCatalog", url);
          return backend.deleteCatalog(url, scope, generation);
        },
      };
      const harness = createHarness((request) =>
        makeResponse(200, {
          body: validCatalog,
          headers: {
            "cache-control":
              fail && operation === "deleteCatalog" && request.url === brokenUrl
                ? "no-store"
                : "max-age=0",
          },
        }),
      );
      harness.dependencies.persistentCache = persistentCache;
      const discovery = createDiscovery(
        {
          acme: { url: "https://skills.example.test" },
          broken: { url: "https://broken.example.test" },
        },
        harness,
      );
      await discovery.origin("acme");
      await discovery.origin("broken");
      assert.ok(await backend.getCatalog(brokenUrl), "successful discovery seeds persistent state");
      fail = true;
      const expectedDiagnostic = {
        code: cacheFailure.code,
        retryable: false,
        context: { origin_alias: "broken" },
      };
      const assertFailure = (error: unknown): true => {
        assert.ok(error instanceof catalog.RemoteSkillsError);
        assert.deepEqual(error.toDiagnostic(), expectedDiagnostic);
        assert.equal(error.message, `Remote Skills request failed: ${cacheFailure.code}`);
        assert.equal(error.cause, undefined);
        return true;
      };

      const aggregate = await discovery.catalog();
      assert.equal(aggregate.entries.length, 2);
      assert.ok(aggregate.entries.every((entry) => entry.originAlias === "acme"));
      assert.equal(aggregate.failures.length, 1);
      assert.equal(aggregate.failures[0]?.originAlias, "broken");
      assertFailure(aggregate.failures[0]?.error);
      await assert.rejects(discovery.catalog({ strict: true }), (error) => {
        assert.ok(error instanceof catalog.CatalogAggregateError);
        assert.equal(error.failures.length, 1);
        assert.equal(error.failures[0]?.originAlias, "broken");
        return assertFailure(error.failures[0]?.error);
      });
      await assert.rejects(discovery.origin("broken"), assertFailure);
    });
  }
}

test("unexpected origin cache failures retain their identity in every discovery mode", async () => {
  const failure = new TypeError("injected programming error");
  const harness = createHarness(() => makeResponse(200, { body: validCatalog }));
  const backend = new MemoryCache();
  harness.dependencies.persistentCache = {
    getCatalogState: async () => {
      throw failure;
    },
    replaceCatalog: backend.replaceCatalog.bind(backend),
    deleteCatalog: backend.deleteCatalog.bind(backend),
  };
  const discovery = createDiscovery({ acme: { url: "https://skills.example.test" } }, harness);
  for (const result of [
    () => discovery.catalog(),
    () => discovery.catalog({ strict: true }),
    () => discovery.origin("acme"),
  ]) {
    await assert.rejects(result(), (error) => error === failure);
  }
});

test("fresh catalog reuse avoids transfer and stale reuse sends both validators", async () => {
  const harness = createHarness((_request, count) =>
    count === 1
      ? makeResponse(200, {
          body: validCatalog,
          headers: {
            "cache-control": "max-age=300",
            etag: '"catalog-v1"',
            "last-modified": "Tue, 25 Aug 2026 10:00:00 GMT",
          },
        })
      : makeResponse(304),
  );
  const discovery = createDiscovery({ acme: { url: "https://skills.example.test" } }, harness);

  await discovery.origin("acme");
  harness.advance(299_999);
  await discovery.origin("acme");
  harness.advance(2);
  const revalidated = await discovery.origin("acme");
  await discovery.origin("acme");

  assert.equal(revalidated.entries.length, 2);
  assert.equal(harness.requests.length, 2);
  assert.deepEqual(harness.requests.at(1)?.headers, {
    accept: "application/json",
    "if-modified-since": "Tue, 25 Aug 2026 10:00:00 GMT",
    "if-none-match": '"catalog-v1"',
  });
});

test("a 304 no-store response evicts the cached representation and its validators", async () => {
  const harness = createHarness((_request, count) => {
    if (count === 1) {
      return makeResponse(200, {
        body: validCatalog,
        headers: { "cache-control": "max-age=0", etag: '"catalog-v1"' },
      });
    }
    if (count === 2) return makeResponse(304, { headers: { "cache-control": "no-store" } });
    return makeResponse(200, { body: validCatalog });
  });
  const discovery = createDiscovery({ acme: { url: "https://skills.example.test" } }, harness);

  await discovery.origin("acme");
  await discovery.origin("acme");
  await discovery.origin("acme");

  assert.equal(harness.requests.length, 3);
  assert.deepEqual(harness.requests.at(2)?.headers, { accept: "application/json" });
});

test("a replacement 200 no-store response also evicts old validators", async () => {
  const harness = createHarness((_request, count) => {
    if (count === 1) {
      return makeResponse(200, {
        body: validCatalog,
        headers: { "cache-control": "max-age=0", etag: '"catalog-v1"' },
      });
    }
    if (count === 2) {
      return makeResponse(200, {
        body: validCatalog,
        headers: { "cache-control": "no-store" },
      });
    }
    return makeResponse(200, { body: validCatalog });
  });
  const discovery = createDiscovery({ acme: { url: "https://skills.example.test" } }, harness);

  await discovery.origin("acme");
  await discovery.origin("acme");
  await discovery.origin("acme");

  assert.equal(harness.requests.length, 3);
  assert.deepEqual(harness.requests.at(2)?.headers, { accept: "application/json" });
});

test("a final invalid 200 invalidates the previously cached representation before parsing", async () => {
  const invalidCatalog = catalogBytes([
    validEntry({ url: "https://cdn.example.test/skill.md?credential=secret" }),
  ]);
  const harness = createHarness((_request, count) => {
    if (count === 1) {
      return makeResponse(200, {
        body: validCatalog,
        headers: { "cache-control": "max-age=300", etag: '"catalog-v1"' },
      });
    }
    if (count === 2) {
      return makeResponse(200, {
        body: invalidCatalog,
        headers: { "cache-control": "no-store" },
      });
    }
    return makeResponse(200, { body: validCatalog });
  });
  const discovery = createDiscovery({ acme: { url: "https://skills.example.test" } }, harness);

  await discovery.origin("acme");
  await assert.rejects(
    discovery.origin("acme", { forceRevalidate: true }),
    (error) => errorCode(error) === "catalog_invalid",
  );
  await discovery.origin("acme");

  assert.equal(harness.requests.length, 3);
  assert.deepEqual(harness.requests.at(2)?.headers, { accept: "application/json" });
});

test("a slower catalog response cannot overwrite a newer same-origin generation", async () => {
  const older = deferred<TransportResponse>();
  const newer = deferred<TransportResponse>();
  const harness = createHarness((_request, count) => (count === 1 ? older.promise : newer.promise));
  const discovery = createDiscovery({ acme: { url: "https://skills.example.test" } }, harness);

  const first = discovery.origin("acme");
  const second = discovery.origin("acme");
  await waitForRequestCount(harness, 2, second);
  newer.resolve(
    makeResponse(200, {
      body: catalogBytes([validEntry({ name: "newer" })]),
      headers: { "cache-control": "max-age=300" },
    }),
  );
  assert.equal((await second).entries.at(0)?.name, "newer");
  older.resolve(
    makeResponse(200, {
      body: catalogBytes([validEntry({ name: "older" })]),
      headers: { "cache-control": "max-age=300" },
    }),
  );
  assert.equal((await first).entries.at(0)?.name, "older");

  assert.equal((await discovery.origin("acme")).entries.at(0)?.name, "newer");
  assert.equal(harness.requests.length, 2);
});

test("catalog generation ordering keeps memory and persistent caches on the same 200 winner", async () => {
  for (const completionOrder of ["newer-first", "older-first"]) {
    await forEachPersistentCache(async (cacheKind, persistentCache) => {
      const older = deferred<TransportResponse>();
      const newer = deferred<TransportResponse>();
      const harness = createHarness((_request, count) =>
        count === 1 ? older.promise : newer.promise,
      );
      harness.dependencies.persistentCache = persistentCache;
      const discovery = createDiscovery({ acme: { url: "https://skills.example.test" } }, harness);

      const first = discovery.origin("acme");
      await waitForRequestCount(harness, 1, first);
      const second = discovery.origin("acme");
      await waitForRequestCount(harness, 2, second);
      const olderResponse = makeResponse(200, {
        body: catalogBytes([validEntry({ name: "older" })]),
        headers: { "cache-control": "max-age=300" },
      });
      const newerResponse = makeResponse(200, {
        body: catalogBytes([validEntry({ name: "newer" })]),
        headers: { "cache-control": "max-age=300" },
      });

      if (completionOrder === "newer-first") {
        newer.resolve(newerResponse);
        await second;
        older.resolve(olderResponse);
        await first;
      } else {
        older.resolve(olderResponse);
        await first;
        newer.resolve(newerResponse);
        await second;
      }

      await assertCatalogWinner(
        discovery,
        persistentCache,
        "newer",
        `${cacheKind}/${completionOrder}`,
      );
      assert.equal(harness.requests.length, 2);
    });
  }
});

test("aliases sharing one canonical catalog identity cannot commit older persistent state last", async () => {
  await forEachPersistentCache(async (cacheKind, persistentCache) => {
    const older = deferred<TransportResponse>();
    const newer = deferred<TransportResponse>();
    const harness = createHarness((_request, count) =>
      count === 1 ? older.promise : newer.promise,
    );
    harness.dependencies.persistentCache = persistentCache;
    const discovery = createDiscovery(
      {
        "older-alias": { url: "https://skills.example.test", scope: "engineering" },
        "newer-alias": { url: "https://skills.example.test", scope: "engineering" },
      },
      harness,
    );

    const olderRequest = discovery.origin("older-alias");
    await waitForRequestCount(harness, 1, olderRequest);
    const newerRequest = discovery.origin("newer-alias");
    await waitForRequestCount(harness, 2, newerRequest);
    newer.resolve(
      makeResponse(200, {
        body: catalogBytes([validEntry({ name: "newer" })]),
        headers: {
          "cache-control": "max-age=300",
          "remote-skills-scope": "engineering",
        },
      }),
    );
    await newerRequest;
    older.resolve(
      makeResponse(200, {
        body: catalogBytes([validEntry({ name: "older" })]),
        headers: {
          "cache-control": "max-age=300",
          "remote-skills-scope": "engineering",
        },
      }),
    );
    await olderRequest;

    assert.equal((await discovery.origin("newer-alias")).entries.at(0)?.name, "newer", cacheKind);
    const stored = await persistentCache.getCatalog(canonicalCatalogUrl, "engineering");
    assert.ok(stored, cacheKind);
    assert.equal(storedCatalogSkillName(stored.body), "newer");
  });
});

test("same-identity aliases reapply their own catalog byte limit before memory or persistence reuse", async () => {
  await forEachPersistentCache(async (cacheKind, persistentCache) => {
    const harness = createHarness((_request, count) =>
      makeResponse(200, {
        body: catalogBytes([validEntry({ name: count === 1 ? "accepted" : "rejected" })]),
        headers: {
          "cache-control": "max-age=300",
          "remote-skills-scope": "engineering",
        },
      }),
    );
    harness.dependencies.persistentCache = persistentCache;
    const discovery = createDiscovery(
      {
        "high-limit": {
          url: "https://skills.example.test",
          scope: "engineering",
          catalogBytes: 1_048_576,
        },
        "low-limit": {
          url: "https://skills.example.test",
          scope: "engineering",
          catalogBytes: 1,
        },
      },
      harness,
    );

    assert.equal((await discovery.origin("high-limit")).entries.at(0)?.name, "accepted");
    await assert.rejects(
      discovery.origin("low-limit"),
      (error) => errorCode(error) === "limit_exceeded",
      cacheKind,
    );
    assert.equal(harness.requests.length, 1, cacheKind);
    assert.equal((await discovery.origin("high-limit")).entries.at(0)?.name, "accepted", cacheKind);
    const stored = await persistentCache.getCatalog(canonicalCatalogUrl, "engineering");
    assert.ok(stored, cacheKind);
    assert.equal(storedCatalogSkillName(stored.body), "accepted");
  });
});

test("a fresh discovery hydrates persistent validators before accepting a 304", async () => {
  await forEachPersistentCache(async (cacheKind, persistentCache) => {
    const independentBody = catalogBytes([
      validEntry({ url: "https://skills.example.test/artifacts/review.md" }),
    ]);
    await persistentCache.putCatalog(canonicalCatalogUrl, independentBody, {
      confirmedScope: "engineering",
      etag: '"persisted"',
      lastModified: "Tue, 25 Aug 2026 09:59:00 GMT",
      cacheControl: "max-age=0",
      retrievedAt: "2026-08-25T09:59:00.000Z",
      validatedAt: "2026-08-25T10:00:00.000Z",
    });
    const harness = createHarness(() =>
      makeResponse(304, {
        headers: {
          "cache-control": "max-age=60",
          etag: '"refreshed"',
          "remote-skills-scope": "engineering",
        },
      }),
    );
    harness.dependencies.persistentCache = persistentCache;

    const result = await createDiscovery(
      { acme: { url: "https://skills.example.test", scope: "engineering" } },
      harness,
    ).origin("acme");

    assert.equal(result.entries.at(0)?.name, "code-review", cacheKind);
    assert.equal(harness.requests.length, 1, cacheKind);
    assert.equal(harness.requests.at(0)?.headers["if-none-match"], '"persisted"', cacheKind);
    assert.equal(
      harness.requests.at(0)?.headers["if-modified-since"],
      "Tue, 25 Aug 2026 09:59:00 GMT",
      cacheKind,
    );
    const stored = await persistentCache.getCatalog(canonicalCatalogUrl, "engineering");
    assert.ok(stored, cacheKind);
    assert.equal(stored.metadata.etag, '"refreshed"', cacheKind);
    assert.ok(Buffer.from(stored.body).equals(independentBody), cacheKind);
  });
});

test("discoveries sharing a persistence backend coordinate the same catalog identity", async () => {
  for (const completionOrder of ["newer-first", "older-first"]) {
    await forEachPersistentCache(async (cacheKind, persistentCache) => {
      const older = deferred<TransportResponse>();
      const newer = deferred<TransportResponse>();
      const olderHarness = createHarness((_request, count) => {
        if (count === 1) return older.promise;
        throw new Error("losing discovery must perform a new request");
      });
      const newerHarness = createHarness((_request, count) => {
        if (count === 1) return newer.promise;
        throw new Error("losing discovery must perform a new request");
      });
      olderHarness.dependencies.persistentCache = persistentCache;
      newerHarness.dependencies.persistentCache = persistentCache;
      const olderDiscovery = createDiscovery(
        {
          acme: {
            url: "https://skills.example.test",
            scope: "engineering",
            retries: 0,
          },
        },
        olderHarness,
      );
      const newerDiscovery = createDiscovery(
        {
          acme: {
            url: "https://skills.example.test",
            scope: "engineering",
            retries: 0,
          },
        },
        newerHarness,
      );

      const olderRequest = olderDiscovery.origin("acme");
      await waitForRequestCount(olderHarness, 1, olderRequest);
      const newerRequest = newerDiscovery.origin("acme");
      await waitForRequestCount(newerHarness, 1, newerRequest);
      const olderResponse = makeResponse(200, {
        body: catalogBytes([validEntry({ name: "older" })]),
        headers: {
          "cache-control": "max-age=300",
          "remote-skills-scope": "engineering",
        },
      });
      const newerResponse = makeResponse(200, {
        body: catalogBytes([validEntry({ name: "newer" })]),
        headers: {
          "cache-control": "max-age=300",
          "remote-skills-scope": "engineering",
        },
      });
      let olderResult: Awaited<typeof olderRequest>;
      let newerResult: Awaited<typeof newerRequest>;
      if (completionOrder === "newer-first") {
        newer.resolve(newerResponse);
        newerResult = await newerRequest;
        assert.equal(newerResult.entries.at(0)?.name, "newer");
        older.resolve(olderResponse);
        olderResult = await olderRequest;
        assert.equal(olderResult.entries.at(0)?.name, "older");
      } else {
        older.resolve(olderResponse);
        olderResult = await olderRequest;
        assert.equal(olderResult.entries.at(0)?.name, "older");
        newer.resolve(newerResponse);
        newerResult = await newerRequest;
        assert.equal(newerResult.entries.at(0)?.name, "newer");
      }

      const expectedWinner = completionOrder === "newer-first" ? "newer" : "older";
      const winningResult = completionOrder === "newer-first" ? newerResult : olderResult;
      const losingResult = completionOrder === "newer-first" ? olderResult : newerResult;
      assert.equal(winningResult.persistent, true, `${cacheKind}/${completionOrder}: winner`);
      assert.ok(
        Object.hasOwn(winningResult, "catalogIdentifier"),
        `${cacheKind}/${completionOrder}: winner identity`,
      );
      assert.equal(losingResult.persistent, false, `${cacheKind}/${completionOrder}: loser`);
      assert.equal(
        Object.hasOwn(losingResult, "catalogIdentifier"),
        false,
        `${cacheKind}/${completionOrder}: loser identity`,
      );
      const stored = await persistentCache.getCatalog(canonicalCatalogUrl, "engineering");
      assert.ok(stored, `${cacheKind}/${completionOrder}`);
      assert.equal(
        storedCatalogSkillName(stored.body),
        expectedWinner,
        `${cacheKind}/${completionOrder}: first CAS commit wins`,
      );
      const winningDiscovery = completionOrder === "newer-first" ? newerDiscovery : olderDiscovery;
      assert.equal((await winningDiscovery.origin("acme")).entries.at(0)?.name, expectedWinner);
      const losingDiscovery = completionOrder === "newer-first" ? olderDiscovery : newerDiscovery;
      assert.equal(
        (await losingDiscovery.origin("acme")).entries.at(0)?.name,
        expectedWinner,
        `${cacheKind}/${completionOrder}: loser hydrates authoritative winner`,
      );
      const winningHarness = completionOrder === "newer-first" ? newerHarness : olderHarness;
      const losingHarness = completionOrder === "newer-first" ? olderHarness : newerHarness;
      assert.equal(winningHarness.requests.length, 1);
      assert.equal(losingHarness.requests.length, 1);
      const stillStored = await persistentCache.getCatalog(canonicalCatalogUrl, "engineering");
      assert.ok(stillStored);
      assert.equal(storedCatalogSkillName(stillStored.body), expectedWinner);
    });
  }
});

test("a persistent commit cannot be crossed by a later scoped request generation", async () => {
  await forEachPersistentCache(async (cacheKind, persistentCache) => {
    const firstPutStarted = deferred<void>();
    const releaseFirstPut = deferred<void>();
    let puts = 0;
    const serializedPersistence: CatalogPersistence = {
      deleteCatalog: (...arguments_) => persistentCache.deleteCatalog(...arguments_),
      getCatalogState: (...arguments_) => persistentCache.getCatalogState(...arguments_),
      async replaceCatalog(...arguments_) {
        puts += 1;
        if (puts === 1) {
          firstPutStarted.resolve(undefined);
          await releaseFirstPut.promise;
        }
        return persistentCache.replaceCatalog(...arguments_);
      },
    };
    const harness = createHarness((_request, count) =>
      makeResponse(200, {
        body: catalogBytes([validEntry({ name: count === 1 ? "older" : "newer" })]),
        headers: {
          "cache-control": "max-age=300",
          "remote-skills-scope": "engineering",
        },
      }),
    );
    harness.dependencies.persistentCache = serializedPersistence;
    const discovery = createDiscovery(
      {
        acme: {
          url: "https://skills.example.test",
          scope: "engineering",
        },
      },
      harness,
    );

    const first = discovery.origin("acme");
    await firstPutStarted.promise;
    const second = discovery.origin("acme", { forceRevalidate: true });
    await delay(0);
    assert.equal(harness.requests.length, 1, `${cacheKind}: commit boundary`);
    releaseFirstPut.resolve(undefined);
    await first;
    await waitForRequestCount(harness, 2, second);
    await second;

    await assertCatalogWinner(
      discovery,
      persistentCache,
      "newer",
      `${cacheKind}/deferred-persistence`,
      "engineering",
    );
  });
});

test("stale no-store and 304 completions cannot erase or overwrite the persistent winner", async () => {
  for (const staleResponseKind of ["200-no-store", "304-store", "304-no-store"]) {
    await forEachPersistentCache(async (cacheKind, persistentCache) => {
      const stale = deferred<TransportResponse>();
      const winner = deferred<TransportResponse>();
      const uses304 = staleResponseKind.startsWith("304");
      const harness = createHarness((_request, count) => {
        if (uses304 && count === 1) {
          return makeResponse(200, {
            body: catalogBytes([validEntry({ name: "seed" })]),
            headers: { "cache-control": "max-age=0", etag: '"seed"' },
          });
        }
        return count === (uses304 ? 2 : 1) ? stale.promise : winner.promise;
      });
      harness.dependencies.persistentCache = persistentCache;
      const discovery = createDiscovery({ acme: { url: "https://skills.example.test" } }, harness);
      if (uses304) await discovery.origin("acme");

      const staleRequest = discovery.origin("acme", { forceRevalidate: true });
      await waitForRequestCount(harness, uses304 ? 2 : 1, staleRequest);
      const winningRequest = discovery.origin("acme", { forceRevalidate: true });
      await waitForRequestCount(harness, uses304 ? 3 : 2, winningRequest);
      winner.resolve(
        makeResponse(200, {
          body: catalogBytes([validEntry({ name: "newer" })]),
          headers: { "cache-control": "max-age=300", etag: '"newer"' },
        }),
      );
      await winningRequest;
      stale.resolve(
        staleResponseKind === "200-no-store"
          ? makeResponse(200, {
              body: catalogBytes([validEntry({ name: "stale" })]),
              headers: { "cache-control": "no-store" },
            })
          : makeResponse(304, {
              headers: {
                "cache-control": staleResponseKind === "304-store" ? "max-age=300" : "no-store",
              },
            }),
      );
      await staleRequest;

      await assertCatalogWinner(
        discovery,
        persistentCache,
        "newer",
        `${cacheKind}/${staleResponseKind}`,
      );
      assert.equal(harness.requests.length, uses304 ? 3 : 2);
    });
  }
});

test("current 200 and 304 no-store responses delete seeded persistent state", async () => {
  for (const responseStatus of [200, 304]) {
    await forEachPersistentCache(async (cacheKind, persistentCache) => {
      const harness = createHarness((_request, count) => {
        if (count === 1) {
          return makeResponse(200, {
            body: catalogBytes([validEntry({ name: "seed" })]),
            headers: { "cache-control": "max-age=0", etag: '"seed"' },
          });
        }
        if (count === 2) {
          return makeResponse(responseStatus, {
            ...(responseStatus === 200
              ? { body: catalogBytes([validEntry({ name: "discarded" })]) }
              : {}),
            headers: { "cache-control": "no-store" },
          });
        }
        return makeResponse(200, {
          body: catalogBytes([validEntry({ name: "recovered" })]),
          headers: { "cache-control": "max-age=300" },
        });
      });
      harness.dependencies.persistentCache = persistentCache;
      const discovery = createDiscovery({ acme: { url: "https://skills.example.test" } }, harness);

      await discovery.origin("acme");
      assert.ok(await persistentCache.getCatalog(canonicalCatalogUrl), cacheKind);
      await discovery.origin("acme", { forceRevalidate: true });
      assert.equal(
        await persistentCache.getCatalog(canonicalCatalogUrl),
        null,
        `${cacheKind}/${responseStatus}`,
      );
      assert.equal((await discovery.origin("acme")).entries.at(0)?.name, "recovered");
      assert.deepEqual(harness.requests.at(2)?.headers, { accept: "application/json" });
    });
  }
});

test("invalid catalog replacement deletion is generation-ordered in memory and persistence", async () => {
  const invalidCatalog = catalogBytes([
    validEntry({ url: "https://cdn.example.test/skill.md?credential=secret" }),
  ]);
  await forEachPersistentCache(async (cacheKind, persistentCache) => {
    const harness = createHarness((_request, count) =>
      count === 1
        ? makeResponse(200, {
            body: catalogBytes([validEntry({ name: "seed" })]),
            headers: { "cache-control": "max-age=300", etag: '"seed"' },
          })
        : count === 2
          ? makeResponse(200, { body: invalidCatalog })
          : makeResponse(200, {
              body: catalogBytes([validEntry({ name: "recovered" })]),
              headers: { "cache-control": "max-age=300" },
            }),
    );
    harness.dependencies.persistentCache = persistentCache;
    const discovery = createDiscovery({ acme: { url: "https://skills.example.test" } }, harness);

    await discovery.origin("acme");
    await assert.rejects(
      discovery.origin("acme", { forceRevalidate: true }),
      (error) => errorCode(error) === "catalog_invalid",
    );
    assert.equal(await persistentCache.getCatalog(canonicalCatalogUrl), null, cacheKind);
    assert.equal((await discovery.origin("acme")).entries.at(0)?.name, "recovered", cacheKind);
    assert.deepEqual(harness.requests.at(2)?.headers, { accept: "application/json" }, cacheKind);
  });

  await forEachPersistentCache(async (cacheKind, persistentCache) => {
    const staleInvalid = deferred<TransportResponse>();
    const winner = deferred<TransportResponse>();
    const harness = createHarness((_request, count) => {
      if (count === 1) {
        return makeResponse(200, {
          body: catalogBytes([validEntry({ name: "seed" })]),
          headers: { "cache-control": "max-age=0", etag: '"seed"' },
        });
      }
      return count === 2 ? staleInvalid.promise : winner.promise;
    });
    harness.dependencies.persistentCache = persistentCache;
    const discovery = createDiscovery({ acme: { url: "https://skills.example.test" } }, harness);
    await discovery.origin("acme");

    const staleRequest = discovery.origin("acme", { forceRevalidate: true });
    await waitForRequestCount(harness, 2, staleRequest);
    const winningRequest = discovery.origin("acme", { forceRevalidate: true });
    await waitForRequestCount(harness, 3, winningRequest);
    winner.resolve(
      makeResponse(200, {
        body: catalogBytes([validEntry({ name: "newer" })]),
        headers: { "cache-control": "max-age=300" },
      }),
    );
    await winningRequest;
    staleInvalid.resolve(makeResponse(200, { body: invalidCatalog }));
    await assert.rejects(staleRequest, (error) => errorCode(error) === "catalog_invalid");

    await assertCatalogWinner(discovery, persistentCache, "newer", `${cacheKind}/invalid`);
  });
});

test("cache freshness uses RFC current age from Date, Age, and response delay", async () => {
  const harness = createHarness(
    (_request, count) =>
      count === 1
        ? makeResponse(200, {
            body: validCatalog,
            headers: {
              age: "8",
              "cache-control": "max-age=20",
              date: "Tue, 25 Aug 2026 09:59:50 GMT",
              etag: '"catalog-v1"',
            },
          })
        : makeResponse(304),
    { responseDelayMs: 5_000 },
  );
  const discovery = createDiscovery({ acme: { url: "https://skills.example.test" } }, harness);

  await discovery.origin("acme");
  harness.advance(4_999);
  await discovery.origin("acme");
  harness.advance(2);
  await discovery.origin("acme");

  assert.equal(harness.requests.length, 2);
});

test("cache dates accept only valid IMF-fixdate values", async () => {
  const invalidExpiresHarness = createHarness(() =>
    makeResponse(200, {
      body: validCatalog,
      headers: { expires: "9999" },
    }),
  );
  const invalidExpiresDiscovery = createDiscovery(
    { acme: { url: "https://skills.example.test" } },
    invalidExpiresHarness,
  );

  await invalidExpiresDiscovery.origin("acme");
  await invalidExpiresDiscovery.origin("acme");
  assert.equal(invalidExpiresHarness.requests.length, 2);

  const invalidDateHarness = createHarness(() =>
    makeResponse(200, {
      body: validCatalog,
      headers: {
        date: "1970-01-01T00:00:00Z",
        expires: "Tue, 25 Aug 2026 10:05:00 GMT",
      },
    }),
  );
  const invalidDateDiscovery = createDiscovery(
    { acme: { url: "https://skills.example.test" } },
    invalidDateHarness,
  );

  await invalidDateDiscovery.origin("acme");
  await invalidDateDiscovery.origin("acme");
  assert.equal(invalidDateHarness.requests.length, 1);
});

test("invalid or duplicate max-age directives make a response immediately stale", async () => {
  const cases = [
    { cacheControl: "max-age=0, max-age=300" },
    { cacheControl: "max-age=1e3" },
    { cacheControl: "max-age=1.5" },
    { cacheControl: "max-age=+10" },
    { cacheControl: 'foo="x,max-age=300,y"' },
    { cacheControl: 'foo="x\\",max-age=300,y"' },
    { cacheControl: 'max-age=300, foo="unterminated' },
    { cacheControl: "max-age=300," },
    { cacheControl: ",max-age=300" },
    { cacheControl: "max-age=300,,foo=bar" },
    {
      cacheControl: "max-age=invalid",
      expires: "Tue, 25 Aug 2027 10:00:00 GMT",
    },
  ];

  for (const { cacheControl, expires } of cases) {
    const harness = createHarness(() =>
      makeResponse(200, {
        body: validCatalog,
        headers: {
          "cache-control": cacheControl,
          ...(expires ? { expires } : {}),
        },
      }),
    );
    const discovery = createDiscovery({ acme: { url: "https://skills.example.test" } }, harness);

    await discovery.origin("acme");
    await discovery.origin("acme");

    assert.equal(harness.requests.length, 2, cacheControl);
  }
});

test("Age uses its first list member and rejects non-delta-seconds syntax", async () => {
  const listedAgeHarness = createHarness(() =>
    makeResponse(200, {
      body: validCatalog,
      headers: { age: "5, 999", "cache-control": "max-age=10" },
    }),
  );
  const listedAgeDiscovery = createDiscovery(
    { acme: { url: "https://skills.example.test" } },
    listedAgeHarness,
  );
  await listedAgeDiscovery.origin("acme");
  listedAgeHarness.advance(5_001);
  await listedAgeDiscovery.origin("acme");
  assert.equal(listedAgeHarness.requests.length, 2);

  const invalidAgeHarness = createHarness(() =>
    makeResponse(200, {
      body: validCatalog,
      headers: { age: "1e1", "cache-control": "max-age=10" },
    }),
  );
  const invalidAgeDiscovery = createDiscovery(
    { acme: { url: "https://skills.example.test" } },
    invalidAgeHarness,
  );
  await invalidAgeDiscovery.origin("acme");
  await invalidAgeDiscovery.origin("acme");
  assert.equal(invalidAgeHarness.requests.length, 1);
});

test("catalog requests send exact scoped headers and never fetch artifacts", async () => {
  const harness = createHarness(() => makeResponse(200, { body: validCatalog }));
  const discovery = createDiscovery(
    {
      acme: {
        url: "https://skills.example.test",
        headers: { Authorization: "runtime-secret", "X-Tenant": "fixture-tenant" },
      },
    },
    harness,
  );

  const result = await discovery.origin("acme");

  assert.equal(
    result.entries.every((entry) => Object.keys(entry).length === 6),
    true,
  );
  assert.deepEqual(
    harness.requests.map(({ url }) => url),
    ["https://skills.example.test/.well-known/agent-skills/index.json"],
  );
  assert.deepEqual(harness.requests.at(0)?.headers, {
    accept: "application/json",
    authorization: "runtime-secret",
    "x-tenant": "fixture-tenant",
  });
});

test("retryable statuses use bounded attempts and Retry-After", async () => {
  const harness = createHarness((_request, count) =>
    count === 1
      ? makeResponse(429, { headers: { "retry-after": "2" } })
      : makeResponse(200, { body: validCatalog }),
  );
  const discovery = createDiscovery(
    { acme: { url: "https://skills.example.test", retries: 2 } },
    harness,
  );

  await discovery.origin("acme");

  assert.equal(harness.requests.length, 2);
  assert.deepEqual(harness.delays, [2000]);
});

test("Retry-After delay-seconds use strict decimal syntax before HTTP-date fallback", async () => {
  for (const retryAfter of ["1e1", "0x10", "1.5", "+10", "-1", ""]) {
    const harness = createHarness(
      (_request, count) =>
        count === 1
          ? makeResponse(429, { headers: { "retry-after": retryAfter } })
          : makeResponse(200, { body: validCatalog }),
      { random: () => 0.5 },
    );
    const discovery = createDiscovery(
      { acme: { url: "https://skills.example.test", retries: 1 } },
      harness,
    );

    await discovery.origin("acme");
    assert.deepEqual(harness.delays, [125], retryAfter);
  }

  const dateHarness = createHarness((_request, count) =>
    count === 1
      ? makeResponse(429, {
          headers: { "retry-after": "Tue, 25 Aug 2026 10:00:02 GMT" },
        })
      : makeResponse(200, { body: validCatalog }),
  );
  const dateDiscovery = createDiscovery(
    { acme: { url: "https://skills.example.test", retries: 1 } },
    dateHarness,
  );

  await dateDiscovery.origin("acme");
  assert.deepEqual(dateHarness.delays, [2000]);
});

test("disabled retries return the first typed network failure without leaking its message", async () => {
  const secret = "RUNTIME_SECRET_CANARY";
  const harness = createHarness(() => {
    throw new Error(secret);
  });
  const discovery = createDiscovery(
    {
      acme: {
        url: "https://skills.example.test",
        headers: { authorization: secret },
        retries: 0,
      },
    },
    harness,
  );

  await assert.rejects(discovery.origin("acme"), (error) => {
    assert.deepEqual(errorDiagnostic(error), {
      code: "origin_unavailable",
      retryable: true,
      context: { origin_alias: "acme" },
    });
    assert.equal(JSON.stringify(error).includes(secret), false);
    assert.equal(errorMessage(error).includes(secret), false);
    return true;
  });
  assert.equal(harness.requests.length, 1);
});

test("request timeouts retain the stable timeout code after bounded retries", async () => {
  const harness = createHarness(() => {
    const error = new Error("timed out with secret");
    error.name = "AbortError";
    throw error;
  });
  const discovery = createDiscovery(
    { acme: { url: "https://skills.example.test", retries: 1, timeoutMs: 1 } },
    harness,
  );

  await assert.rejects(
    discovery.origin("acme"),
    (error) =>
      errorCode(error) === "request_timeout" && errorContext(error).origin_alias === "acme",
  );
  assert.equal(harness.requests.length, 2);
});

test("the request deadline includes an abort-aware delayed resolver", async () => {
  const harness = createHarness(() => makeResponse(200, { body: validCatalog }), {
    resolve: async (_hostname, signal) => {
      await delay(150, undefined, { signal });
      return [{ address: "93.184.216.34", family: 4 as const }];
    },
  });
  const discovery = createDiscovery(
    { acme: { url: "https://skills.example.test", retries: 0, timeoutMs: 25 } },
    harness,
  );

  await assert.rejects(discovery.origin("acme"), (error) => errorCode(error) === "request_timeout");
  assert.equal(harness.requests.length, 0);
});

test("the request deadline bounds a real trickling response body", async (t) => {
  const server = createServer((_request, response) => {
    let offset = 0;
    const chunkSize = Math.ceil(validCatalog.byteLength / 8);
    const interval = setInterval(() => {
      const nextOffset = Math.min(validCatalog.byteLength, offset + chunkSize);
      response.write(validCatalog.subarray(offset, nextOffset));
      offset = nextOffset;
      if (offset === validCatalog.byteLength) {
        clearInterval(interval);
        response.end();
      }
    }, 20);
    response.on("close", () => clearInterval(interval));
  });
  const port = await listenLoopback(server);
  t.after(() => closeServer(server));
  const discovery = catalog.createCatalogDiscovery({
    origins: {
      local: {
        url: `http://127.0.0.1:${port}`,
        allowLoopbackHttp: true,
        retries: 0,
        timeoutMs: 100,
      },
    },
  });

  await assert.rejects(
    discovery.origin("local"),
    (error) => errorCode(error) === "request_timeout",
  );
});

test("an oversized declared Content-Length returns the stable limit error", async (t) => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-length": "4096" });
    response.end();
  });
  const port = await listenLoopback(server);
  t.after(() => closeServer(server));
  const discovery = catalog.createCatalogDiscovery({
    origins: {
      local: {
        url: `http://127.0.0.1:${port}`,
        allowLoopbackHttp: true,
        catalogBytes: 128,
        retries: 0,
      },
    },
  });

  await assert.rejects(discovery.origin("local"), (error) => errorCode(error) === "limit_exceeded");
});

test("the pinned Node 24 transport satisfies lookup requests for all addresses", async (t) => {
  const server = createServer((_request, response) => response.end(validCatalog));
  const port = await listenLoopback(server);
  t.after(() => closeServer(server));

  const response = await transport.defaultTransport({
    url: `http://pinned.example.test:${port}/catalog`,
    headers: { accept: "application/json" },
    address: { address: "127.0.0.1", family: 4 as const },
    signal: new AbortController().signal,
    maxBytes: validCatalog.byteLength + 1,
  });

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, validCatalog);
});

test("the response body consumer registers errors before rejecting an oversized declaration", async () => {
  assert.equal(typeof transport.consumeResponse, "function");

  class SynchronousDestroyResponse extends EventEmitter {
    headers = { "content-length": "4096" };
    statusCode = 200;

    destroy(error: Error): this {
      this.emit("error", error);
      return this;
    }
  }

  await assert.rejects(
    consumeResponseFromUnknown(new SynchronousDestroyResponse(), 128),
    (error) => error instanceof transport.ResponseLimitExceeded,
  );
});

test("the default resolver cancels real outstanding DNS work when its caller aborts", async (t) => {
  assert.equal(typeof transport.createDefaultResolveHost, "function");
  const dnsServer = createSocket("udp4");
  await new Promise<void>((resolveListen, rejectListen) => {
    dnsServer.once("error", rejectListen);
    dnsServer.bind(0, "127.0.0.1", () => {
      dnsServer.off("error", rejectListen);
      resolveListen();
    });
  });
  t.after(
    () =>
      new Promise<void>((resolveClose) => {
        dnsServer.close(resolveClose);
      }),
  );
  const address = dnsServer.address();
  if (typeof address === "string") throw new Error("local DNS server has no UDP port");
  const resolver = new Resolver();
  resolver.setServers([`127.0.0.1:${address.port}`]);
  const resolveHost = transport.createDefaultResolveHost(() => resolver);
  const controller = new AbortController();
  const timeout = new transport.RequestTimedOut();

  const query = deferred<void>();
  const onQuery = () => query.resolve();
  dnsServer.once("message", onQuery);
  const lookup = resolveHost("skills.example.test", controller.signal);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("DNS cancellation handshake timed out")), 2_000);
  });
  try {
    await Promise.race([
      query.promise,
      lookup.then(() => {
        throw new Error("DNS lookup completed before query observation");
      }),
      deadline,
    ]);
    controller.abort(timeout);
    await Promise.race([assert.rejects(lookup, (error) => error === timeout), deadline]);
  } finally {
    clearTimeout(timer);
    dnsServer.off("message", onQuery);
    controller.abort(timeout);
    resolver.cancel();
    await lookup.catch(() => undefined);
  }
});

test("one request deadline spans a real redirect chain", async (t) => {
  const server = createServer(async (request, response) => {
    await delay(40);
    if (request.url?.endsWith("index.json")) {
      response.writeHead(302, { location: "/redirected" });
      response.end();
      return;
    }
    if (request.url === "/redirected") {
      response.writeHead(302, { location: "/final" });
      response.end();
      return;
    }
    response.end(validCatalog);
  });
  const port = await listenLoopback(server);
  t.after(() => closeServer(server));
  const discovery = catalog.createCatalogDiscovery({
    origins: {
      local: {
        url: `http://127.0.0.1:${port}`,
        allowLoopbackHttp: true,
        retries: 0,
        timeoutMs: 90,
      },
    },
  });

  await assert.rejects(
    discovery.origin("local"),
    (error) => errorCode(error) === "request_timeout",
  );
});

test("a terminal status replaces a timeout from an earlier retry attempt", async () => {
  const harness = createHarness((_request, count) => {
    if (count === 1) {
      const error = new Error("timed out");
      error.name = "AbortError";
      throw error;
    }
    return makeResponse(404);
  });
  const discovery = createDiscovery(
    { acme: { url: "https://skills.example.test", retries: 1 } },
    harness,
  );

  await assert.rejects(discovery.origin("acme"), (error) => {
    assert.deepEqual(errorDiagnostic(error), {
      code: "origin_unavailable",
      retryable: true,
      context: { origin_alias: "acme", status: 404 },
    });
    return true;
  });
});

test("a terminal network failure does not retain a status from an earlier attempt", async () => {
  const harness = createHarness((_request, count) => {
    if (count === 1) return makeResponse(500);
    throw new Error("network unavailable");
  });
  const discovery = createDiscovery(
    { acme: { url: "https://skills.example.test", retries: 1 } },
    harness,
  );

  await assert.rejects(discovery.origin("acme"), (error) => {
    assert.deepEqual(errorDiagnostic(error), {
      code: "origin_unavailable",
      retryable: true,
      context: { origin_alias: "acme" },
    });
    return true;
  });
});

test("redirects retain origin headers only on the exact configured host", async () => {
  const harness = createHarness((_request, count) =>
    count === 1
      ? makeResponse(302, { headers: { location: "https://cdn.example.test/catalog.json" } })
      : makeResponse(200, { body: validCatalog }),
  );
  const discovery = createDiscovery(
    {
      acme: {
        url: "https://skills.example.test",
        headers: { authorization: "origin-secret" },
        artifactHeaders: { "cdn.example.test": { "x-cdn-token": "cdn-secret" } },
      },
    },
    harness,
  );

  await discovery.origin("acme");

  assert.equal(harness.requests.at(0)?.headers.authorization, "origin-secret");
  const redirectedHeaders = harness.requests.at(1)?.headers;
  assert.ok(redirectedHeaders);
  assert.equal(Object.hasOwn(redirectedHeaders, "authorization"), false);
  assert.equal(Object.hasOwn(redirectedHeaders, "x-cdn-token"), false);

  const origin = catalog
    .normalizeOrigins({
      acme: {
        url: "https://skills.example.test",
        headers: { authorization: "origin-secret" },
        artifactHeaders: { "cdn.example.test": { "x-cdn-token": "cdn-secret" } },
      },
    })
    .get("acme");
  assert.ok(origin);
  assert.deepEqual(
    catalog.headersForUrl(origin, new URL("https://cdn.example.test/artifact.md"), "artifact"),
    { "x-cdn-token": "cdn-secret" },
  );
});

test("a redirect to a denied address fails before a second request", async () => {
  const harness = createHarness(() =>
    makeResponse(302, { headers: { location: "http://127.0.0.1/private" } }),
  );
  const discovery = createDiscovery({ acme: { url: "https://skills.example.test" } }, harness);

  await assert.rejects(discovery.origin("acme"), (error) => errorCode(error) === "policy_denied");
  assert.equal(harness.requests.length, 1);
});

test("a redirect with a bare query delimiter fails before a second request", async () => {
  const harness = createHarness(() => makeResponse(302, { headers: { location: "/catalog?" } }));
  const discovery = createDiscovery({ acme: { url: "https://skills.example.test" } }, harness);

  await assert.rejects(discovery.origin("acme"), (error) => errorCode(error) === "policy_denied");
  assert.equal(harness.requests.length, 1);
});

const noncanonicalRedirectLocations = [
  ["empty userinfo", "https://@cdn.example.test/catalog.json"],
  ["leading space", " https://cdn.example.test/catalog.json"],
  ["trailing ASCII control", "https://cdn.example.test/catalog.json\t"],
  ["backslash separators", String.raw`https:\\@cdn.example.test/catalog.json`],
  ["mixed separators", String.raw`https:/\@cdn.example.test/catalog.json`],
  ["extra special-scheme slashes", "https:////@cdn.example.test/catalog.json"],
  ["extra network-path slash", "///@cdn.example.test/catalog.json"],
] as const;

for (const [label, location] of noncanonicalRedirectLocations) {
  test(`redirect rejects ${label} raw Location before a second request`, async () => {
    const harness = createHarness(() => makeResponse(302, { headers: { location } }));
    const discovery = createDiscovery({ acme: { url: "https://skills.example.test" } }, harness);

    await assert.rejects(discovery.origin("acme"), (error) => errorCode(error) === "policy_denied");
    assert.equal(harness.requests.length, 1);
  });
}

test("a canonical network-path redirect makes exactly one follow-up request", async () => {
  const harness = createHarness((_request, count) =>
    count === 1
      ? makeResponse(302, { headers: { location: "//cdn.example.test/catalog.json" } })
      : makeResponse(200, { body: validCatalog }),
  );
  const discovery = createDiscovery({ acme: { url: "https://skills.example.test" } }, harness);

  await discovery.origin("acme");

  assert.equal(harness.requests.length, 2);
  assert.equal(harness.requests.at(1)?.url, "https://cdn.example.test/catalog.json");
});

test("loopback HTTP opt-in cannot be enabled for a production origin", () => {
  assert.throws(
    () =>
      catalog.normalizeOrigins({
        acme: { url: "https://skills.example.test", allowLoopbackHttp: true },
      }),
    (error) => errorCode(error) === "configuration_invalid",
  );
});

test("loopback HTTP opt-in cannot be enabled for an HTTPS loopback origin", () => {
  assert.throws(
    () =>
      catalog.normalizeOrigins({
        local: { url: "https://localhost:8787", allowLoopbackHttp: true },
      }),
    (error) => errorCode(error) === "configuration_invalid",
  );
});

test("loopback HTTP origins reject redirects whose DNS answers are not exclusively loopback", async () => {
  const harness = createHarness(
    () => makeResponse(302, { headers: { location: "http://public.example.test/catalog.json" } }),
    {
      resolve: async (hostname) =>
        hostname === "127.0.0.1"
          ? [{ address: "127.0.0.1", family: 4 as const }]
          : [
              { address: "127.0.0.1", family: 4 as const },
              { address: "93.184.216.34", family: 4 as const },
            ],
    },
  );
  const discovery = createDiscovery(
    {
      local: {
        url: "http://127.0.0.1:8787",
        allowLoopbackHttp: true,
        retries: 0,
      },
    },
    harness,
  );

  await assert.rejects(discovery.origin("local"), (error) => errorCode(error) === "policy_denied");
  assert.equal(harness.requests.length, 1);
});

test("loopback HTTP accepts normalized IPv6 and IPv4-mapped loopback answers", async () => {
  const origin = catalog
    .normalizeOrigins({
      local: { url: "http://localhost:8787", allowLoopbackHttp: true },
    })
    .get("local");
  assert.ok(origin);
  const cases = ["0:0:0:0:0:0:0:1", "::ffff:127.0.0.1", "::ffff:7f00:1"];

  for (const address of cases) {
    const selected = await catalog.resolveNetworkTarget(origin, origin.catalogUrl, async () => [
      { address, family: 6 },
    ]);
    assert.equal(selected.address, address);
  }
});

test("relative artifact URLs resolve against the final redirected index URL", async () => {
  const redirectedCatalog = catalogBytes([validEntry({ url: "artifact.md" })]);
  const harness = createHarness((_request, count) =>
    count === 1
      ? makeResponse(302, { headers: { location: "https://cdn.example.test/v2/index.json" } })
      : makeResponse(200, { body: redirectedCatalog }),
  );
  const discovery = createDiscovery({ acme: { url: "https://skills.example.test" } }, harness);

  const result = await discovery.origin("acme");

  assert.equal(result.entries.at(0)?.url, "https://cdn.example.test/v2/artifact.md");
});

test("catalog validation rejects unsafe artifact URLs", () => {
  const unsafeUrls = [
    "file:///tmp/skill.md",
    "artifact.md?",
    "https://user:password@cdn.example.test/skill.md",
    "https://cdn.example.test/skill.md?token=secret",
    "https://cdn.example.test/skill.md#instructions",
  ];

  for (const url of unsafeUrls) {
    assert.throws(
      () =>
        catalog.parseCatalog(
          catalogBytes([validEntry({ url })]),
          "acme",
          new URL("https://skills.example.test/.well-known/agent-skills/index.json"),
        ),
      (error) =>
        errorCode(error) === "catalog_invalid" && errorContext(error).field === "skills[0].url",
      url,
    );
  }
});

test("discovery does not cache a catalog containing an unsafe artifact URL", async () => {
  const unsafeCatalog = catalogBytes([
    validEntry({ url: "https://cdn.example.test/skill.md?token=secret" }),
  ]);
  const harness = createHarness((_request, count) =>
    count === 1
      ? makeResponse(200, {
          body: unsafeCatalog,
          headers: { "cache-control": "max-age=300", etag: '"unsafe"' },
        })
      : makeResponse(200, { body: validCatalog }),
  );
  const discovery = createDiscovery({ acme: { url: "https://skills.example.test" } }, harness);

  await assert.rejects(discovery.origin("acme"), (error) => errorCode(error) === "catalog_invalid");
  const recovered = await discovery.origin("acme");

  assert.equal(recovered.entries.length, 2);
  assert.equal(harness.requests.length, 2);
  assert.deepEqual(harness.requests.at(1)?.headers, { accept: "application/json" });
});

test("address policy matches every checked-in public and denied IP fixture", async () => {
  const policy = addressPolicyFixtures(
    await readFile(
      resolve(repositoryRoot, "tests/protocol/fixtures/network/dns-ip-policy.json"),
      "utf8",
    ),
  );

  for (const [id, fixture] of Object.entries(policy)) {
    if (id === "rebinding") continue;
    assert.equal(
      catalog.isPublicAddress(fixture.address),
      fixture.decision === "allow",
      `${id}:${fixture.address}`,
    );
  }
});

test("IPv6 policy default-denies non-global and IANA special-purpose destinations", () => {
  const cases = {
    "fec0::1": false,
    "64:ff9b:1::1": false,
    "100::1": false,
    "2002::1": false,
    "2200::1": false,
    "3000::1": false,
    "3fff::1": false,
    "4000::1": false,
    "5f00::1": false,
    "64:ff9b::c000:201": true,
    "2001:3::1": true,
    "2606:4700:4700::1111": true,
  };

  for (const [address, expected] of Object.entries(cases)) {
    assert.equal(catalog.isPublicAddress(address), expected, address);
  }
});

test("explicit IPv6 allowlists compare canonical address identity", async () => {
  const origin = catalog
    .normalizeOrigins({
      acme: {
        url: "https://skills.example.test",
        networkPolicy: { allowedAddresses: ["2001:0DB8:0:0:0:0:0:1"] },
      },
    })
    .get("acme");
  assert.ok(origin);

  const selected = await catalog.resolveNetworkTarget(origin, origin.catalogUrl, async () => [
    { address: "2001:db8::1", family: 6 },
  ]);

  assert.deepEqual(selected, { address: "2001:db8::1", family: 6 });
});

test("origin configuration requires explicit safe aliases and loopback HTTP opt-in", () => {
  assert.throws(
    () => catalog.normalizeOrigins({ inferred: { url: "http://example.com" } }),
    (error) => errorCode(error) === "configuration_invalid",
  );
  assert.throws(
    () => catalog.normalizeOrigins({ "bad alias": { url: "https://skills.example.test" } }),
    (error) => errorCode(error) === "configuration_invalid",
  );
  assert.throws(
    () => catalog.normalizeOrigins({ acme: { url: "https://skills.example.test?#" } }),
    (error) => errorCode(error) === "configuration_invalid",
  );
  const local = catalog
    .normalizeOrigins({
      local: { url: "http://127.0.0.1:8787", allowLoopbackHttp: true },
    })
    .get("local");
  assert.ok(local);
  assert.equal(local.catalogUrl.href, "http://127.0.0.1:8787/.well-known/agent-skills/index.json");
});

test("malformed origin URL types return the stable configuration error", () => {
  for (const url of [undefined, null, 42, {}, []]) {
    assert.throws(
      () => normalizeOriginsFromUnknown({ acme: { url } }),
      (error) =>
        error instanceof catalog.RemoteSkillsError &&
        errorCode(error) === "configuration_invalid" &&
        errorContext(error).field === "origins.acme.url",
    );
  }
});

const noncanonicalOriginUrls = [
  ["empty userinfo", "https://@skills.example.test"],
  ["leading space", " https://@skills.example.test"],
  ["trailing ASCII control", "https://skills.example.test\t"],
  ["backslash separators", String.raw`https:\\@skills.example.test`],
  ["mixed separators", String.raw`https:/\@skills.example.test`],
  ["four authority slashes", "https:////@skills.example.test"],
  ["five authority slashes", "https://///@skills.example.test"],
] as const;

for (const [label, url] of noncanonicalOriginUrls) {
  test(`origin configuration rejects ${label} before URL canonicalization`, () => {
    assert.throws(
      () => catalog.normalizeOrigins({ acme: { url } }),
      (error) =>
        error instanceof catalog.RemoteSkillsError &&
        errorCode(error) === "configuration_invalid" &&
        errorContext(error).field === "origins.acme.url",
    );
  });
}

test("malformed configuration shapes always return stable configuration errors", () => {
  const validOrigins = { acme: { url: "https://skills.example.test" } };
  const cases: ReadonlyArray<readonly [string, () => unknown, string]> = [
    ["defaults", () => normalizeOriginsFromUnknown(validOrigins, null), "defaults"],
    ["defaults array", () => normalizeOriginsFromUnknown(validOrigins, []), "defaults"],
    ["origin array", () => normalizeOriginsFromUnknown({ acme: [] }), "origins.acme"],
    [
      "headers string",
      () => normalizeOriginsFromUnknown({ acme: { ...validOrigins.acme, headers: "secret" } }),
      "origins.acme.headers",
    ],
    [
      "headers null",
      () => normalizeOriginsFromUnknown({ acme: { ...validOrigins.acme, headers: null } }),
      "origins.acme.headers",
    ],
    [
      "artifact headers array",
      () => normalizeOriginsFromUnknown({ acme: { ...validOrigins.acme, artifactHeaders: [] } }),
      "origins.acme.artifactHeaders",
    ],
    [
      "network policy null",
      () => normalizeOriginsFromUnknown({ acme: { ...validOrigins.acme, networkPolicy: null } }),
      "origins.acme.networkPolicy",
    ],
    [
      "network policy array",
      () => normalizeOriginsFromUnknown({ acme: { ...validOrigins.acme, networkPolicy: [] } }),
      "origins.acme.networkPolicy",
    ],
    [
      "allowed addresses object",
      () =>
        normalizeOriginsFromUnknown({
          acme: {
            ...validOrigins.acme,
            networkPolicy: { allowedAddresses: {} },
          },
        }),
      "origins.acme.networkPolicy.allowedAddresses",
    ],
    [
      "allowed address non-string",
      () =>
        normalizeOriginsFromUnknown({
          acme: {
            ...validOrigins.acme,
            networkPolicy: { allowedAddresses: [null] },
          },
        }),
      "origins.acme.networkPolicy.allowedAddresses",
    ],
    [
      "loopback opt-in string",
      () =>
        normalizeOriginsFromUnknown({
          acme: { ...validOrigins.acme, allowLoopbackHttp: "true" },
        }),
      "origins.acme.allowLoopbackHttp",
    ],
  ];

  for (const [label, operation, field] of cases) {
    assert.throws(
      operation,
      (error) =>
        error instanceof catalog.RemoteSkillsError &&
        errorCode(error) === "configuration_invalid" &&
        errorContext(error).field === field,
      label,
    );
  }
});

const invalidHeaderValues = [
  ["NUL", "value\u0000secret"],
  ["C0", "value\u0001secret"],
  ["DEL", "value\u007fsecret"],
  ["non-Latin-1", "value\u0100secret"],
] as const;

for (const [label, value] of invalidHeaderValues) {
  test(`origin normalization rejects ${label} request header values`, () => {
    assert.throws(
      () =>
        catalog.normalizeOrigins({
          acme: {
            url: "https://skills.example.test",
            headers: { "x-test": value },
          },
        }),
      (error) =>
        error instanceof catalog.RemoteSkillsError &&
        errorCode(error) === "configuration_invalid" &&
        errorContext(error).field === "origins.acme.headers.x-test",
    );
  });
}

for (const config of [null, undefined]) {
  test(`public discovery rejects ${String(config)} root config with stable diagnostics`, () => {
    assert.throws(
      () => createDiscoveryFromUnknown(config),
      (error) => {
        assert.equal(errorMessage(error), "Remote Skills request failed: configuration_invalid");
        assert.deepEqual(errorDiagnostic(error), {
          code: "configuration_invalid",
          retryable: false,
          context: { field: "config" },
        });
        return true;
      },
      String(config),
    );
  });
}

const schemaContextCanary = "SCHEMA_CONTEXT_SECRET_CANARY";
const untrustedSchemaValues = [
  ["userinfo", `https://user:${schemaContextCanary}@schemas.peer.example/discovery/schema.json`],
  ["query", `https://schemas.peer.example/discovery/schema.json?token=${schemaContextCanary}`],
  ["fragment", `https://schemas.peer.example/discovery/schema.json#${schemaContextCanary}`],
  ["arbitrary peer", "https://schemas.peer.example/discovery/0.3/schema.json"],
  ["oversized", `https://schemas.peer.example/${"x".repeat(4096)}${schemaContextCanary}`],
];

for (const [label, unsupportedSchema] of untrustedSchemaValues) {
  test(`unsupported schema diagnostics omit ${label} input`, () => {
    const bytes = Buffer.from(JSON.stringify({ $schema: unsupportedSchema, skills: [] }), "utf8");

    assert.throws(
      () =>
        catalog.parseCatalog(
          bytes,
          "acme",
          new URL("https://skills.example.test/.well-known/agent-skills/index.json"),
        ),
      (error) => {
        assert.equal(errorMessage(error), "Remote Skills request failed: unsupported_schema");
        assert.deepEqual(errorDiagnostic(error), {
          code: "unsupported_schema",
          retryable: false,
          context: { origin_alias: "acme" },
        });
        assert.equal(JSON.stringify(error).includes(schemaContextCanary), false);
        return true;
      },
    );
  });
}

const noncanonicalArtifactUrls = [
  ["absolute empty userinfo", "https://@cdn.example.test/SKILL.md"],
  ["network-path empty userinfo", "//@cdn.example.test/SKILL.md"],
  ["leading-space absolute", " https://@cdn.example.test/SKILL.md"],
  ["trailing ASCII control", "https://cdn.example.test/SKILL.md\r"],
  ["absolute backslash separators", String.raw`https:\\@cdn.example.test/SKILL.md`],
  ["absolute mixed separators", String.raw`https:/\@cdn.example.test/SKILL.md`],
  ["network-path backslash before userinfo", String.raw`//cdn.example.test\@evil.example/SKILL.md`],
  ["relative backslash before userinfo", String.raw`/\@cdn.example.test/SKILL.md`],
  ["extra network-path slash", "///@cdn.example.test/SKILL.md"],
  ["extra special-scheme slashes", "https:////@cdn.example.test/SKILL.md"],
] as const;

for (const [label, url] of noncanonicalArtifactUrls) {
  test(`catalog validation rejects ${label} before URL canonicalization`, () => {
    assert.throws(
      () =>
        catalog.parseCatalog(
          catalogBytes([validEntry({ url })]),
          "acme",
          new URL("https://skills.example.test/.well-known/agent-skills/index.json"),
        ),
      (error) =>
        error instanceof catalog.RemoteSkillsError &&
        errorCode(error) === "catalog_invalid" &&
        errorContext(error).field === "skills[0].url",
    );
  });
}

test("catalog validation preserves canonical absolute and relative artifact URL controls", () => {
  const indexUrl = new URL("https://skills.example.test/.well-known/agent-skills/index.json");
  const cases = [
    ["https://cdn.example.test/SKILL.md", "https://cdn.example.test/SKILL.md"],
    ["//cdn.example.test/SKILL.md", "https://cdn.example.test/SKILL.md"],
    [
      "artifacts/@scope/SKILL.md",
      "https://skills.example.test/.well-known/agent-skills/artifacts/@scope/SKILL.md",
    ],
  ] as const;

  for (const [reference, expected] of cases) {
    const parsed = catalog.parseCatalog(
      catalogBytes([validEntry({ url: reference })]),
      "acme",
      indexUrl,
    );
    assert.equal(parsed.entries.at(0)?.url, expected);
  }
});

test("v0.2 validation enforces the canonical Agent Skills name grammar", () => {
  assert.throws(
    () =>
      catalog.parseCatalog(
        catalogBytes([validEntry({ name: "bad--name" })]),
        "acme",
        new URL("https://skills.example.test/.well-known/agent-skills/index.json"),
      ),
    (error) =>
      errorCode(error) === "catalog_invalid" && errorContext(error).field === "skills[0].name",
  );
});

test("v0.2 validation enforces the 1024-character description limit", () => {
  assert.throws(
    () =>
      catalog.parseCatalog(
        catalogBytes([validEntry({ description: "x".repeat(1025) })]),
        "acme",
        new URL("https://skills.example.test/.well-known/agent-skills/index.json"),
      ),
    (error) =>
      errorCode(error) === "catalog_invalid" &&
      errorContext(error).field === "skills[0].description",
  );
});

test("v0.2 description length counts Unicode code points", () => {
  const parsed = catalog.parseCatalog(
    catalogBytes([validEntry({ description: "😀".repeat(1024) })]),
    "acme",
    new URL("https://skills.example.test/.well-known/agent-skills/index.json"),
  );

  assert.equal(parsed.entries.at(0)?.description, "😀".repeat(1024));
});

test("v0.2 discovery skips an unrecognized artifact type", () => {
  const parsed = catalog.parseCatalog(
    catalogBytes([validEntry({ type: "future-type" }), validEntry({ name: "known" })]),
    "acme",
    new URL("https://skills.example.test/.well-known/agent-skills/index.json"),
  );

  assert.deepEqual(
    parsed.entries.map(({ name }) => name),
    ["known"],
  );
});

test("v0.2 validation rejects duplicate recognized catalog members", () => {
  const entry = validEntry();
  const release = { version: "1.0.0", type: entry.type, url: entry.url, digest: entry.digest };
  const extension = { version: "1.0.0", releases: [release] };
  const versionedEntry = { ...entry, "x-remote-skills": extension };
  const document = { $schema: schemaUrl, skills: [versionedEntry] };
  const indexUrl = new URL("https://skills.example.test/.well-known/agent-skills/index.json");
  const parse = (text: string) => catalog.parseCatalog(Buffer.from(text), "acme", indexUrl);
  const duplicateMember = (value: object, key: string): string => {
    const members = Object.entries(value).flatMap(([name, member]) => {
      const text = `${JSON.stringify(name)}:${JSON.stringify(member)}`;
      return name === key ? [text, text] : [text];
    });
    return `{${members.join(",")}}`;
  };
  const wrapEntry = (text: string) => `{"$schema":${JSON.stringify(schemaUrl)},"skills":[${text}]}`;
  const wrapExtension = (text: string) =>
    wrapEntry(`${JSON.stringify(entry).slice(0, -1)},"x-remote-skills":${text}}`);

  assert.equal(parse(JSON.stringify(document)).entries.at(0)?.version, "1.0.0");
  const cases: Array<readonly [string, string]> = [
    ...Object.keys(document).map((key) => [key, duplicateMember(document, key)] as const),
    ...Object.keys(versionedEntry).map(
      (key) => [`entry.${key}`, wrapEntry(duplicateMember(versionedEntry, key))] as const,
    ),
    ...Object.keys(extension).map(
      (key) => [`extension.${key}`, wrapExtension(duplicateMember(extension, key))] as const,
    ),
    ...Object.keys(release).map(
      (key) =>
        [
          `release.${key}`,
          wrapExtension(`{"version":"1.0.0","releases":[${duplicateMember(release, key)}]}`),
        ] as const,
    ),
  ];
  for (const [label, text] of cases) {
    assert.throws(
      () => parse(text),
      (error) => error instanceof catalog.RemoteSkillsError && error.code === "catalog_invalid",
      label,
    );
  }
});

test("v0.2 validation still ignores duplicate unknown extension members", () => {
  const entry = JSON.stringify(validEntry());
  const ignored = '"x-note":{"name":"first","name":"second","skills":[{"version":1,"version":2}]}';
  const extendedEntry = `${entry.slice(0, -1)},${ignored},${ignored}}`;
  const bytes = Buffer.from(
    `{"$schema":${JSON.stringify(schemaUrl)},${ignored},${ignored},"skills":[${extendedEntry}]}`,
  );
  const indexUrl = new URL("https://skills.example.test/.well-known/agent-skills/index.json");
  assert.deepEqual(
    catalog.parseCatalog(bytes, "acme", indexUrl),
    catalog.parseCatalog(catalogBytes([validEntry()]), "acme", indexUrl),
  );
});

test("ignored catalog metadata stays invisible through the public facade and no-store", async () => {
  let note: unknown = "optional display metadata";
  for (let depth = 0; depth < 80; depth += 1) note = { next: note };
  const body = Buffer.from(
    JSON.stringify({
      $schema: schemaUrl,
      skills: [validEntry({ "x-note": note })],
      "x-note": note,
    }),
  );
  const expected = catalog.parseCatalog(
    catalogBytes([validEntry()]),
    "acme",
    new URL(canonicalCatalogUrl),
  ).entries;
  for (const cacheControl of ["max-age=60", "no-store"]) {
    const backend = new MemoryCache();
    const harness = createHarness(() =>
      makeResponse(200, { body, headers: { "cache-control": cacheControl } }),
    );
    const client = createRemoteSkills(
      { origins: { acme: { url: "https://skills.example.test" } }, cache: backend },
      harness.dependencies,
    );
    for (let request = 0; request < 2; request += 1) {
      const result = await client.catalog();
      assert.deepEqual(result.entries, expected);
      assert.deepEqual(result.failures, []);
    }
    assert.equal(harness.requests.length, cacheControl === "no-store" ? 2 : 1);
    assert.equal(
      (await backend.getCatalog(canonicalCatalogUrl)) === null,
      cacheControl === "no-store",
    );
  }
});

test("optional catalog storage refusal retains accepted metadata and freshness through 304", async (t) => {
  const backend = new MemoryCache();
  const body = Buffer.from(
    JSON.stringify({ $schema: schemaUrl, skills: [validEntry()], "x-storage-note": "optional" }),
  );
  const harness = createHarness((_request, count) =>
    count === 1
      ? makeResponse(200, {
          body: catalogBytes([validEntry({ name: "older" })]),
          headers: { "cache-control": "max-age=0" },
        })
      : count === 2
        ? makeResponse(200, {
            body,
            headers: { "cache-control": "max-age=60", age: "50", etag: '"accepted"' },
          })
        : makeResponse(304, { headers: { "cache-control": "max-age=60", age: "0" } }),
  );
  harness.dependencies.persistentCache = backend;
  const discovery = createDiscovery({ acme: { url: "https://skills.example.test" } }, harness);
  await discovery.origin("acme");
  assert.ok(await backend.getCatalog(canonicalCatalogUrl));

  const entries: (value: object) => [string, unknown][] = Object.entries;
  let refused = 0;
  // Inject refusal at the raw storage traversal, after ordinary wire parsing succeeds.
  t.mock.method(Object, "entries", (value: object) => {
    if (Object.hasOwn(value, "x-storage-note")) {
      refused += 1;
      throw new CacheCorruptError("injected optional storage admission refusal");
    }
    return entries(value);
  });
  const accepted = await discovery.origin("acme");
  assert.equal(accepted.entries[0]?.name, "code-review");
  assert.equal(accepted.persistent, false);
  assert.equal(accepted.catalogIdentifier, undefined);
  assert.equal(await backend.getCatalog(canonicalCatalogUrl), null);
  harness.advance(5_000);
  assert.deepEqual(await discovery.origin("acme"), accepted);
  assert.equal(harness.requests.length, 2);
  harness.advance(6_000);
  const revalidated = await discovery.origin("acme");
  assert.deepEqual(revalidated, accepted);
  assert.equal(harness.requests[2]?.headers["if-none-match"], '"accepted"');
  assert.equal(refused, 2);
  assert.deepEqual(await discovery.origin("acme"), accepted);
  assert.equal(harness.requests.length, 3);
  assert.equal(await backend.getCatalog(canonicalCatalogUrl), null);

  const facadeHarness = createHarness(() =>
    makeResponse(200, { body, headers: { "cache-control": "max-age=60" } }),
  );
  const client = createRemoteSkills(
    { origins: { acme: { url: "https://skills.example.test" } }, cache: backend },
    facadeHarness.dependencies,
  );
  for (let request = 0; request < 2; request += 1) {
    const result = await client.catalog();
    assert.deepEqual(result.entries, accepted.entries);
    assert.deepEqual(result.failures, []);
  }
  assert.equal(facadeHarness.requests.length, 1);
  assert.equal(refused, 3);
  assert.equal(await backend.getCatalog(canonicalCatalogUrl), null);
});

test("parsed and cached catalog snapshots resist runtime mutation", async () => {
  const parsed = catalog.parseCatalog(
    catalogBytes([validEntry()]),
    "acme",
    new URL("https://skills.example.test/.well-known/agent-skills/index.json"),
  );

  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(Object.isFrozen(parsed.entries), true);
  const parsedEntry = parsed.entries.at(0);
  assert.ok(parsedEntry);
  assert.equal(Object.isFrozen(parsedEntry), true);
  assert.throws(
    () => Reflect.apply(Array.prototype.push, parsed.entries, [validEntry()]),
    TypeError,
  );
  assert.equal(Reflect.set(parsedEntry, "name", "mutated"), false);

  const harness = createHarness(() =>
    makeResponse(200, {
      body: catalogBytes([validEntry()]),
      headers: { "cache-control": "max-age=300" },
    }),
  );
  const discovery = createDiscovery({ acme: { url: "https://skills.example.test" } }, harness);
  const first = await discovery.origin("acme");
  assert.equal(Reflect.set(first, "stale", true), false);
  assert.equal((await discovery.origin("acme")).stale, false);
  assert.equal(harness.requests.length, 1);
});

test("v0.2 validation rejects duplicate short names within one origin", () => {
  assert.throws(
    () =>
      catalog.parseCatalog(
        catalogBytes([validEntry(), validEntry()]),
        "acme",
        new URL("https://skills.example.test/.well-known/agent-skills/index.json"),
      ),
    (error) =>
      errorCode(error) === "catalog_invalid" && errorContext(error).field === "skills[1].name",
  );
});

test("scope is validated and sent only on catalog requests", () => {
  const origin = catalog
    .normalizeOrigins({
      acme: {
        url: "https://skills.example.test",
        scope: "engineering",
        headers: { authorization: "runtime secret" },
      },
    })
    .get("acme");
  assert.ok(origin);
  assert.deepEqual(catalog.headersForUrl(origin, origin.catalogUrl, "catalog"), {
    authorization: "runtime secret",
    "remote-skills-scope": "engineering",
  });
  assert.deepEqual(
    catalog.headersForUrl(
      origin,
      new URL("https://skills.example.test/.well-known/agent-skills/artifacts/a.md"),
      "artifact",
    ),
    { authorization: "runtime secret" },
  );
  for (const scope of [
    "",
    " engineering",
    "engineering ",
    "engineering,sales",
    "x\u007f",
    "a".repeat(129),
  ]) {
    assert.throws(
      () => catalog.normalizeOrigins({ acme: { url: "https://skills.example.test", scope } }),
      (error) => errorCode(error) === "configuration_invalid",
    );
  }
});

test("scoped catalog responses require confirmation and expose persistent identity", async () => {
  const confirmedHarness = createHarness(() =>
    makeResponse(200, {
      body: validCatalog,
      headers: { "remote-skills-scope": "engineering" },
    }),
  );
  const confirmed = await createDiscovery(
    { acme: { url: "https://skills.example.test", scope: "engineering" } },
    confirmedHarness,
  ).origin("acme");
  assert.equal(confirmed.confirmedScope, "engineering");
  assert.equal(confirmed.persistent, true);
  assert.equal(
    confirmed.catalogIdentifier,
    "9dc5c74ba396dc5b65ff423600466f65b6d0a1bfca3eb6866345481f98de17a9",
  );

  const missingHarness = createHarness(() => makeResponse(200, { body: validCatalog }));
  await assert.rejects(
    createDiscovery(
      { acme: { url: "https://skills.example.test", scope: "engineering" } },
      missingHarness,
    ).origin("acme"),
    (error) =>
      errorCode(error) === "catalog_invalid" && errorContext(error).field === "remote-skills-scope",
  );
});

test("confirmed discovery writes scoped catalog bytes and sanitized metadata to its cache seam", async () => {
  const cache = new MemoryCache();
  const harness = createHarness(() =>
    makeResponse(200, {
      body: validCatalog,
      headers: {
        "cache-control": "max-age=60",
        etag: '"scoped"',
        "remote-skills-scope": "engineering",
      },
    }),
  );
  harness.dependencies.persistentCache = cache;

  await createDiscovery(
    {
      acme: {
        url: "https://skills.example.test",
        scope: "engineering",
        headers: { authorization: "runtime secret" },
      },
    },
    harness,
  ).origin("acme");

  const stored = await cache.getCatalog(
    "https://skills.example.test/.well-known/agent-skills/index.json",
    "engineering",
  );
  assert.ok(stored);
  assert.ok(Buffer.from(stored.body).equals(validCatalog));
  assert.deepEqual(stored.metadata, {
    canonicalUrl: "https://skills.example.test/.well-known/agent-skills/index.json",
    confirmedScope: "engineering",
    etag: '"scoped"',
    cacheControl: "max-age=60",
    retrievedAt: "2026-08-25T10:00:00.000Z",
    validatedAt: "2026-08-25T10:00:00.000Z",
  });
  assert.equal(await cache.getCatalog(stored.metadata.canonicalUrl, "sales"), null);
});

test("reflected configured credentials never enter persistent catalog validators", async () => {
  const secret = "reflected-token";
  const reflected = "ReFlEcTeD-ToKeN";
  const authorization = `Bearer ${secret}`;
  await forEachPersistentCache(async (cacheKind, cache) => {
    const harness = createHarness((_request, count) =>
      count === 1
        ? makeResponse(200, {
            body: validCatalog,
            headers: {
              "cache-control": `max-age=0, private="${reflected}"`,
              etag: `"${reflected}"`,
              "last-modified": `Tue, 25 Aug 2026 10:00:00 GMT ${reflected}`,
              "remote-skills-scope": "engineering",
            },
          })
        : makeResponse(304, {
            headers: {
              "cache-control": `max-age=60, private="${reflected}"`,
              etag: `W/"${reflected}"`,
              "last-modified": `Tue, 25 Aug 2026 10:01:00 GMT ${reflected}`,
              "remote-skills-scope": "engineering",
            },
          }),
    );
    harness.dependencies.persistentCache = cache;
    const discovery = createDiscovery(
      {
        acme: {
          url: "https://skills.example.test",
          scope: "engineering",
          headers: { authorization },
        },
      },
      harness,
    );

    await discovery.origin("acme");
    await discovery.origin("acme", { forceRevalidate: true });

    const stored = await cache.getCatalog(canonicalCatalogUrl, "engineering");
    assert.ok(stored, cacheKind);
    assert.equal(JSON.stringify(stored.metadata).includes(secret), false, cacheKind);
    assert.equal(stored.metadata.etag, undefined, cacheKind);
    assert.equal(stored.metadata.lastModified, undefined, cacheKind);
    assert.equal(stored.metadata.cacheControl, undefined, cacheKind);
  });
});

test("a confirmed 304 persists refreshed validators without replacing scoped catalog bytes", async () => {
  const cache = new MemoryCache();
  const harness = createHarness((_request, count) =>
    count === 1
      ? makeResponse(200, {
          body: validCatalog,
          headers: {
            "cache-control": "max-age=0",
            etag: '"initial"',
            "remote-skills-scope": "engineering",
          },
        })
      : makeResponse(304, {
          headers: {
            "cache-control": "max-age=60",
            etag: '"refreshed"',
            "remote-skills-scope": "engineering",
          },
        }),
  );
  harness.dependencies.persistentCache = cache;
  const discovery = createDiscovery(
    { acme: { url: "https://skills.example.test", scope: "engineering" } },
    harness,
  );

  await discovery.origin("acme");
  harness.advance(60_000);
  await discovery.origin("acme", { forceRevalidate: true });

  const stored = await cache.getCatalog(
    "https://skills.example.test/.well-known/agent-skills/index.json",
    "engineering",
  );
  assert.ok(stored);
  assert.ok(Buffer.from(stored.body).equals(validCatalog));
  assert.equal(stored.metadata.etag, '"refreshed"');
  assert.equal(stored.metadata.cacheControl, "max-age=60");
  assert.equal(stored.metadata.retrievedAt, "2026-08-25T10:00:00.000Z");
  assert.equal(stored.metadata.validatedAt, "2026-08-25T10:01:00.000Z");
});

test("no-store and authenticated unscoped discovery never reach persistent catalog storage", async () => {
  for (const testCase of [
    {
      origin: { url: "https://skills.example.test", scope: "engineering" },
      headers: { "cache-control": "no-store", "remote-skills-scope": "engineering" },
    },
    {
      origin: {
        url: "https://skills.example.test",
        headers: { authorization: "runtime secret" },
      },
      headers: { "cache-control": "max-age=60" },
    },
  ]) {
    const cache = new MemoryCache();
    const canonicalUrl = "https://skills.example.test/.well-known/agent-skills/index.json";
    const confirmedScope = testCase.origin.scope;
    await cache.putCatalog(canonicalUrl, validCatalog, {
      ...(confirmedScope === undefined ? {} : { confirmedScope }),
      retrievedAt: "2026-08-25T09:00:00.000Z",
      validatedAt: "2026-08-25T09:00:00.000Z",
    });
    const harness = createHarness(() =>
      makeResponse(200, { body: validCatalog, headers: testCase.headers }),
    );
    harness.dependencies.persistentCache = cache;

    await createDiscovery({ acme: testCase.origin }, harness).origin("acme");
    assert.equal(await cache.getCatalog(canonicalUrl, confirmedScope), null);
  }
});

test("scope artifact adapter diagnostics are derived from the observed production request", async () => {
  const protocolRoot = await mkdtemp(join(tmpdir(), "remote-skills-adapter-scope-"));
  try {
    const fixtureDirectory = join(protocolRoot, "fixtures/network");
    await mkdir(fixtureDirectory, { recursive: true });
    await writeFile(
      join(fixtureDirectory, "scope-authorization.json"),
      JSON.stringify({
        boundary: {
          configuration: {
            origin_alias: "acme",
            origin: "https://skills.example.test",
            scope: "engineering",
            headers: { authorization: "$RUNTIME_SECRET_CANARY" },
            artifact_url: "https://skills.example.test/.well-known/agent-skills/artifacts/a.md",
          },
          artifact_request: {
            headers: { accept: "text/markdown" },
            forbidden_header_names: ["fixture-value-must-not-be-copied"],
          },
          response: { status: 403, headers: {} },
        },
      }),
    );
    const result = await runProtocolCase({
      suite: "network",
      fixture: {
        id: "scope-artifact-denied",
        category: "scope_authorization",
        scenario: "scope-authorization.json#boundary",
      },
      protocolRoot,
    });

    assert.ok(isRecord(result));
    assert.deepEqual(result.forbidden_header_names, ["remote-skills-scope"]);
    assert.deepEqual(result.sensitive_header_names, ["authorization"]);
    assert.ok(isRecord(result.error));
    assert.equal(result.error.code, "authorization_denied");
  } finally {
    await rm(protocolRoot, { recursive: true, force: true });
  }
});

test("invalid scope configuration terminates before a network response is required", async () => {
  const protocolRoot = await mkdtemp(join(tmpdir(), "remote-skills-adapter-config-invalid-"));
  try {
    const fixtureDirectory = join(protocolRoot, "fixtures/network");
    await mkdir(fixtureDirectory, { recursive: true });
    await writeFile(
      join(fixtureDirectory, "scope-authorization.json"),
      JSON.stringify({
        invalid: {
          configuration: {
            origin: "https://skills.example.test",
            scope: "engineering",
          },
          request: {
            headers: [
              { name: "remote-skills-scope", value: "engineering" },
              { name: "Remote-Skills-Scope", value: "security" },
            ],
          },
        },
      }),
    );

    const result = await runProtocolCase({
      suite: "network",
      fixture: {
        id: "scope-invalid-multiple-request-headers",
        category: "scope_authorization",
        scenario: "scope-authorization.json#invalid",
      },
      protocolRoot,
    });
    assert.ok(isRecord(result));
    assert.equal(result.outcome, "request_error");
    assert.equal(result.requests, 0);
    assert.ok(isRecord(result.error));
    assert.equal(result.error.code, "configuration_invalid");
  } finally {
    await rm(protocolRoot, { recursive: true, force: true });
  }
});

test("supplemental adapter surfaces the task-5.4 bounded stale-session result", async () => {
  const sharedProtocolRoot = resolve(repositoryRoot, "tests/protocol");
  const fixtures = protocolFixtureCases(
    await readFile(
      resolve(sharedProtocolRoot, "fixtures/network/scope-version-network-cases.json"),
      "utf8",
    ),
  );
  const id = "version-removal-explicit-stale";
  const fixture = fixtures.find((candidate) => candidate.id === id);
  assert.ok(fixture);
  const result = await runProtocolCase({
    suite: "network",
    fixture,
    protocolRoot: sharedProtocolRoot,
  });
  assert.ok(isRecord(result));
  assert.equal(result.selected_version, "1.4.7");
  assert.equal(result.stale, true);
  assert.equal(result.requests, 0);
});

test("supplemental adapter selects from the supplied range instead of fixture expectations", async () => {
  const result = await runProtocolCase({
    suite: "catalog",
    fixture: {
      id: "version-select-mutated-range",
      input: "valid-versioned-history.json",
      requested_range: "~1.4.2",
      skill_name: "code-review",
    },
    protocolRoot: resolve(repositoryRoot, "tests/protocol"),
  });
  assert.ok(isRecord(result));
  assert.equal(result.selected_version, "1.4.7");
  assert.notEqual(result.selected_version, "1.5.1");
});

test("future-online adapter replaces cached history through production discovery", async () => {
  const sharedProtocolRoot = resolve(repositoryRoot, "tests/protocol");
  const fixtures = protocolFixtureCases(
    await readFile(
      resolve(sharedProtocolRoot, "fixtures/network/scope-version-network-cases.json"),
      "utf8",
    ),
  );
  const fixture = fixtures.find((candidate) => candidate.id === "version-removal-future-online");
  assert.ok(fixture);
  const result = await runProtocolCase({
    suite: "network",
    fixture,
    protocolRoot: sharedProtocolRoot,
  });
  assert.ok(isRecord(result));
  assert.ok(isRecord(result.error));
  assert.equal(result.error.code, "version_unavailable");
  assert.equal(result.requests, 1);

  const protocolRoot = await mkdtemp(join(tmpdir(), "remote-skills-removal-adapter-"));
  try {
    await mkdir(join(protocolRoot, "fixtures/network"), { recursive: true });
    await mkdir(join(protocolRoot, "fixtures/catalog"), { recursive: true });
    await writeFile(
      join(protocolRoot, "fixtures/network/offline-removal.json"),
      JSON.stringify({
        mutated: {
          requested_range: "1.4.x",
          cached_versions: ["1.4.7"],
          advertised_versions: ["2.0.0", "1.5.1", "1.4.7"],
        },
      }),
    );
    await writeFile(
      join(protocolRoot, "fixtures/catalog/valid-versioned-history.json"),
      await readFile(resolve(sharedProtocolRoot, "fixtures/catalog/valid-versioned-history.json")),
    );
    await assert.rejects(
      runProtocolCase({
        suite: "network",
        fixture: {
          id: "version-removal-future-online",
          category: "removal",
          scenario: "offline-removal.json#mutated",
        },
        protocolRoot,
      }),
      /removed version unexpectedly selected/u,
    );
  } finally {
    await rm(protocolRoot, { recursive: true, force: true });
  }
});

test("version histories select the deterministic highest compatible release", async () => {
  const versioned = catalog
    .parseCatalog(
      await readFile(
        resolve(repositoryRoot, "tests/protocol/fixtures/catalog/valid-versioned-history.json"),
      ),
      "acme",
      new URL("https://skills.example.test/.well-known/agent-skills/index.json"),
    )
    .entries.at(0);
  assert.ok(versioned);
  assert.equal(versioned.version, "2.0.0");
  assert.equal(catalog.selectCatalogRelease(versioned, "1.4.x").version, "1.4.7");
  assert.equal(catalog.selectCatalogRelease(versioned, "^1.4.2").version, "1.5.1");
});

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, cp, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { verifyCachedExtraction } from "../../src/activation/index.ts";
import { canonicalOriginIdentifier, DiskCache, MemoryCache } from "../../src/cache/index.ts";
import type { EvictionResult } from "../../src/cache/types.ts";
import { RemoteSkillsError, type TransportRequest } from "../../src/catalog/index.ts";
import { createRemoteSkills } from "../../src/index.ts";
import type { OriginConfig } from "../../src/origin.ts";
import type { RemoteSkillsSession } from "../../src/session/types.ts";

const SCHEMA = "https://schemas.agentskills.io/discovery/0.2.0/schema.json";
const PUBLIC_ANSWER = [{ address: "93.184.216.34", family: 4 as const }];
const CATALOG_URL = "https://skills.example.test/.well-known/agent-skills/index.json";
const SKILL_V1 = Buffer.from(`---
name: code-review
description: Review version one.
---
Version one instructions.
`);
const SKILL_V2 = Buffer.from(`---
name: code-review
description: Review version two.
---
Version two instructions.
`);

for (const cacheMode of ["disk", "memory"] as const) {
  test(`${cacheMode} facade propagates public admission limits before activation`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "remote-skills-public-limits-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const prototype = cacheMode === "disk" ? DiskCache.prototype : MemoryCache.prototype;
    const publish = prototype.publishObject;
    let admitted = false;
    t.mock.method(
      prototype,
      "publishObject",
      async function (this: DiskCache | MemoryCache, input: Parameters<typeof publish>[0]) {
        assert.equal(this.maxArtifactBytes, 256);
        assert.equal(this.maxExtractedBytes, 256);
        assert.equal(this.maxExtractedFileBytes, 128);
        assert.equal(this.maxFilesPerObject, 1_001);
        admitted = true;
        return publish.call(this, input);
      },
    );
    const harness = createLifecycleHarness();
    const client = createRemoteSkills(
      {
        origins: { acme: { url: "https://skills.example.test" } },
        cache: cacheMode,
        cacheOptions: { directory, maxBytes: 1_000_000 },
        limits: { archiveBytes: 256, extractedBytes: 256, fileBytes: 128, files: 1_001 },
      },
      harness.dependencies,
    );
    const session = await client.session("acme");
    try {
      assert.equal(
        (await session.activate("code-review")).instructions,
        "Version one instructions.\n",
      );
      assert.equal(admitted, true);
    } finally {
      await session.close();
    }
  });

  test(`${cacheMode} facade retains above-v1 catalogs in memory without persistence`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "remote-skills-catalog-limits-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const body = Buffer.concat([
      catalogBytes([versionedEntry([descriptor("1.4.7", SKILL_V1)], "Review version one.")]),
      Buffer.from(" ".repeat(1_048_576)),
    ]);
    let requests = 0;
    const client = createRemoteSkills(
      {
        origins: {
          acme: { url: "https://skills.example.test", catalogBytes: body.length },
          small: { url: "https://small.example.test", catalogBytes: 512 },
        },
        cache: cacheMode,
        cacheOptions: { directory },
      },
      {
        resolve: async () => PUBLIC_ANSWER,
        transport: async () => {
          requests += 1;
          return requests === 2
            ? { status: 304, headers: { "cache-control": "max-age=60" }, body: new Uint8Array() }
            : { status: 200, headers: { "cache-control": "max-age=60", etag: '"catalog"' }, body };
        },
      },
    );
    for (let count = 0; count < 2; count += 1) {
      const session = await client.session("acme");
      assert.deepEqual(
        (await session.catalog()).map((entry) => entry.name),
        ["code-review"],
      );
      await session.close();
    }
    assert.equal(requests, 1);
    await client.refresh("acme");
    const refreshed = await client.session("acme");
    assert.equal((await refreshed.catalog())[0]?.name, "code-review");
    await refreshed.close();
    assert.equal(requests, 2);
    await assert.rejects(client.session("small"), { code: "limit_exceeded" });
    const disk = new DiskCache({ directory });
    assert.equal(await disk.getCatalog(CATALOG_URL), null);
  });
}

test("facade rejects conflicting built-in admission options and validates limits eagerly", () => {
  const origins = { acme: { url: "https://skills.example.test" } };
  assert.throws(() => createRemoteSkills({ origins, limits: { files: 0 } }), {
    code: "configuration_invalid",
  });
  for (const cache of ["disk", "memory"] as const) {
    assert.throws(
      () =>
        createRemoteSkills({
          origins,
          cache,
          limits: { files: 2 },
          cacheOptions: { maxFilesPerObject: 1 },
        }),
      { code: "configuration_invalid" },
    );
    assert.doesNotThrow(() =>
      createRemoteSkills({
        origins,
        cache,
        limits: { files: 2 },
        cacheOptions: { maxFilesPerObject: 3, maxBytes: 0 },
      }),
    );
  }
  assert.doesNotThrow(() =>
    createRemoteSkills({
      origins,
      cache: new MemoryCache({ maxFilesPerObject: 1 }),
      limits: { files: 2 },
    }),
  );
});

interface WireRelease {
  digest: string;
  type: "skill-md";
  url: string;
  version: string;
}

interface WireEntry {
  description: string;
  digest: string;
  name: string;
  type: "skill-md";
  url: string;
  "x-remote-skills": { releases: readonly WireRelease[]; version: string };
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function descriptor(version: string, bytes: Uint8Array): WireRelease {
  return {
    version,
    type: "skill-md",
    url: `artifacts/${version}.md`,
    digest: sha256(bytes),
  };
}

function versionedEntry(
  releases: readonly [WireRelease, ...WireRelease[]],
  description: string,
): WireEntry {
  const current = releases[0];
  return {
    name: "code-review",
    description,
    type: current.type,
    url: current.url,
    digest: current.digest,
    "x-remote-skills": { version: current.version, releases },
  };
}

function catalogBytes(entries: readonly WireEntry[]): Buffer {
  return Buffer.from(`${JSON.stringify({ $schema: SCHEMA, skills: entries })}\n`);
}

function deferred<T = void>() {
  let resolvePromise: (value: T) => void = () => {};
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

function createLifecycleHarness(
  options: {
    artifactGate?: ReturnType<typeof deferred<void>>;
    cache?: MemoryCache;
    entries?: readonly WireEntry[];
  } = {},
) {
  let now = Date.parse("2026-08-28T12:00:00.000Z");
  let online = true;
  let entries = options.entries ?? [
    versionedEntry([descriptor("1.4.7", SKILL_V1)], "Review version one."),
  ];
  const requests: TransportRequest[] = [];
  const artifacts = new Map([
    ["/.well-known/agent-skills/artifacts/1.4.7.md", SKILL_V1],
    ["/.well-known/agent-skills/artifacts/1.4.8.md", SKILL_V2],
    ["/.well-known/agent-skills/artifacts/1.5.1.md", SKILL_V2],
    ["/.well-known/agent-skills/artifacts/2.0.0.md", SKILL_V2],
  ]);
  const cache =
    options.cache ??
    new MemoryCache({
      now: () => new Date(now),
      verifyExtractedContents: verifyCachedExtraction,
    });
  const dependencies = {
    now: () => now,
    random: () => 0,
    sleep: async () => {},
    resolve: async () => PUBLIC_ANSWER,
    transport: async (request: TransportRequest) => {
      requests.push(request);
      if (!online) throw new Error("fixture origin is offline");
      const url = new URL(request.url);
      if (url.href === CATALOG_URL) {
        return {
          status: 200,
          headers: {
            "cache-control": "max-age=0",
            ...(request.headers["remote-skills-scope"] === undefined
              ? {}
              : { "remote-skills-scope": request.headers["remote-skills-scope"] }),
          },
          body: catalogBytes(entries),
        };
      }
      const bytes = artifacts.get(url.pathname);
      if (bytes === undefined) return { status: 404, headers: {}, body: new Uint8Array() };
      if (options.artifactGate !== undefined) await options.artifactGate.promise;
      return {
        status: 200,
        headers: { "content-type": "text/markdown; charset=utf-8" },
        body: bytes,
      };
    },
  };
  return {
    cache,
    dependencies,
    requests,
    advance(milliseconds: number) {
      now += milliseconds;
    },
    setEntries(next: readonly WireEntry[]) {
      entries = next;
    },
    setOnline(next: boolean) {
      online = next;
    },
  };
}

function createClient(
  harness: ReturnType<typeof createLifecycleHarness>,
  originOverrides: Partial<OriginConfig> = {},
) {
  return createRemoteSkills(
    {
      origins: {
        acme: {
          url: "https://skills.example.test",
          retries: 0,
          ...originOverrides,
        },
      },
      cache: harness.cache,
    },
    harness.dependencies,
  );
}

async function assertSessionClosed(action: () => Promise<unknown>): Promise<void> {
  await assert.rejects(action, (error) => {
    assert.ok(error instanceof RemoteSkillsError);
    assert.equal(error.code, "session_closed");
    assert.deepEqual(error.context, { origin_alias: "acme" });
    return true;
  });
}

test("future sessions observe compatible updates and removals while the existing scope/version/digest stays pinned", async () => {
  const harness = createLifecycleHarness();
  const client = createClient(harness, { scope: "engineering" });
  const firstSession = await client.session("acme");
  const first = await firstSession.activate("code-review", "1.4.x");
  assert.equal(first.version, "1.4.7");
  assert.equal(first.confirmedScope, "engineering");
  assert.equal(await first.read("SKILL.md"), SKILL_V1.toString());

  harness.setEntries([versionedEntry([descriptor("1.4.8", SKILL_V2)], "Review version two.")]);
  await client.refresh("acme");
  const repeated = await firstSession.activate("code-review", "*");
  assert.equal(repeated, first);
  assert.equal(repeated.version, "1.4.7");
  assert.equal(await repeated.read("SKILL.md"), SKILL_V1.toString());

  const secondSession = await client.session("acme");
  const second = await secondSession.activate("code-review", "1.4.x");
  assert.equal(second.version, "1.4.8");
  assert.equal(second.digest, sha256(SKILL_V2));

  harness.setEntries([]);
  await client.refresh("acme");
  const thirdSession = await client.session("acme");
  assert.deepEqual(await thirdSession.catalog(), []);
  await assert.rejects(thirdSession.activate("code-review"), { code: "skill_not_found" });
  assert.equal(await first.read("SKILL.md"), SKILL_V1.toString());

  await Promise.all([firstSession.close(), secondSession.close(), thirdSession.close()]);
});

test("a newly validated catalog cannot resurrect a removed compatible release from object cache", async () => {
  const harness = createLifecycleHarness();
  const client = createClient(harness);
  const firstSession = await client.session("acme");
  await firstSession.activate("code-review", "1.4.x");

  harness.setEntries([
    versionedEntry(
      [descriptor("2.0.0", SKILL_V2), descriptor("1.5.1", SKILL_V2)],
      "Review version two.",
    ),
  ]);
  await client.refresh("acme");
  const futureSession = await client.session("acme");
  const artifactRequestsBefore = harness.requests.filter(
    ({ url }) => new URL(url).pathname !== "/.well-known/agent-skills/index.json",
  ).length;
  await assert.rejects(futureSession.activate("code-review", "1.4.x"), {
    code: "version_unavailable",
  });
  const artifactRequestsAfter = harness.requests.filter(
    ({ url }) => new URL(url).pathname !== "/.well-known/agent-skills/index.json",
  ).length;
  assert.equal(artifactRequestsAfter, artifactRequestsBefore);

  await Promise.all([firstSession.close(), futureSession.close()]);
});

test("offline sessions fail closed by default and explicitly bounded stale sessions expose their age", async () => {
  const harness = createLifecycleHarness();
  const seedingClient = createClient(harness);
  const online = await seedingClient.session("acme");
  await online.activate("code-review", "1.4.x");
  await online.close();
  harness.advance(60_000);
  harness.setOnline(false);

  await assert.rejects(createClient(harness).session("acme"), { code: "origin_unavailable" });

  const stale = await createClient(harness, {
    stale: { maxAgeMs: 300_000 },
  }).session("acme");
  assert.deepEqual(stale.metadata, {
    originAlias: "acme",
    stale: true,
    staleAgeMs: 60_000,
  });
  assert.equal(stale.stale, true);
  assert.equal(stale.staleAgeMs, 60_000);
  assert.equal((await stale.activate("code-review", "1.4.x")).version, "1.4.7");
  await stale.close();

  harness.advance(241_000);
  await assert.rejects(createClient(harness, { stale: { maxAgeMs: 300_000 } }).session("acme"), {
    code: "origin_unavailable",
  });
});

test("offline restart requires base-independent catalog evidence for stale reuse", async () => {
  for (const absolute of [false, true]) {
    const release = descriptor("1.4.7", SKILL_V1);
    if (absolute) release.url = new URL(release.url, CATALOG_URL).href;
    const harness = createLifecycleHarness({
      entries: [versionedEntry([release], "Review version one.")],
    });
    const online = await createClient(harness).session("acme");
    await online.close();
    const stored = await harness.cache.getCatalog(CATALOG_URL);
    assert.ok(stored);
    // A new backend contains the serialized record, without the accepting client's evidence.
    const restartedCache = new MemoryCache();
    await restartedCache.putCatalog(CATALOG_URL, stored.body, stored.metadata);
    harness.setOnline(false);
    const restarted = createRemoteSkills(
      {
        origins: {
          acme: { url: "https://skills.example.test", retries: 0, stale: { maxAgeMs: 300_000 } },
        },
        cache: restartedCache,
      },
      harness.dependencies,
    );
    if (absolute) {
      const stale = await restarted.session("acme");
      assert.equal((await stale.catalog())[0]?.url, release.url);
      assert.equal(stale.stale, true);
      await stale.close();
    } else {
      await assert.rejects(restarted.session("acme"), { code: "origin_unavailable" });
    }
  }
});

test("aggregate catalog preserves partial failures and strict behavior through the facade", async () => {
  const harness = createLifecycleHarness();
  const client = createRemoteSkills(
    {
      origins: {
        acme: { url: "https://skills.example.test", retries: 0 },
        broken: { url: "https://broken.example.test", retries: 0 },
      },
      cache: harness.cache,
    },
    {
      ...harness.dependencies,
      transport: async (request) => {
        if (new URL(request.url).host === "broken.example.test") throw new Error("offline");
        return harness.dependencies.transport(request);
      },
    },
  );
  const aggregate = await client.catalog();
  assert.equal(aggregate.entries.length, 1);
  assert.deepEqual(
    aggregate.failures.map(({ originAlias }) => originAlias),
    ["broken"],
  );
  await assert.rejects(client.catalog({ strict: true }), { name: "CatalogAggregateError" });
});

test("same-named skills stay origin-qualified and sessions activate only their origin's artifact", async () => {
  const acmeSkill = Buffer.from(`---
name: code-review
description: Review with Acme policy.
---
Follow Acme's review policy.
`);
  const partnerSkill = Buffer.from(`---
name: code-review
description: Review with partner policy.
---
Follow the partner's review policy.
`);
  const origins = new Map([
    [
      "skills.example.test",
      {
        catalog: catalogBytes([
          versionedEntry([descriptor("1.0.0", acmeSkill)], "Review with Acme policy."),
        ]),
        artifact: acmeSkill,
      },
    ],
    [
      "partner.example.test",
      {
        catalog: catalogBytes([
          versionedEntry([descriptor("1.0.0", partnerSkill)], "Review with partner policy."),
        ]),
        artifact: partnerSkill,
      },
    ],
  ]);
  const client = createRemoteSkills(
    {
      origins: {
        acme: { url: "https://skills.example.test", retries: 0 },
        partner: { url: "https://partner.example.test", retries: 0 },
      },
      cache: new MemoryCache({ verifyExtractedContents: verifyCachedExtraction }),
    },
    {
      resolve: async () => PUBLIC_ANSWER,
      transport: async (request) => {
        const url = new URL(request.url);
        const fixture = origins.get(url.host);
        assert.ok(fixture, `unexpected origin ${url.host}`);
        return url.pathname.endsWith("/index.json")
          ? { status: 200, headers: { "cache-control": "max-age=0" }, body: fixture.catalog }
          : {
              status: 200,
              headers: { "content-type": "text/markdown; charset=utf-8" },
              body: fixture.artifact,
            };
      },
    },
  );

  const aggregate = await client.catalog();
  assert.deepEqual(
    aggregate.entries.map(({ originAlias, name }) => ({ originAlias, name })),
    [
      { originAlias: "acme", name: "code-review" },
      { originAlias: "partner", name: "code-review" },
    ],
  );

  const [acmeSession, partnerSession] = await Promise.all([
    client.session("acme"),
    client.session("partner"),
  ]);
  try {
    const [acme, partner] = await Promise.all([
      acmeSession.activate("code-review"),
      partnerSession.activate("code-review"),
    ]);
    assert.deepEqual(
      [acme, partner].map(({ originAlias, instructions }) => ({ originAlias, instructions })),
      [
        { originAlias: "acme", instructions: "Follow Acme's review policy.\n" },
        { originAlias: "partner", instructions: "Follow the partner's review policy.\n" },
      ],
    );
  } finally {
    await Promise.all([acmeSession.close(), partnerSession.close()]);
  }
});

test("refresh without an alias revalidates every origin for future sessions", async () => {
  const harness = createLifecycleHarness();
  const client = createRemoteSkills(
    {
      origins: {
        acme: { url: "https://skills.example.test", retries: 0 },
        beta: { url: "https://beta.example.test", retries: 0 },
      },
      cache: harness.cache,
    },
    {
      ...harness.dependencies,
      transport: async (request) => {
        if (new URL(request.url).host === "beta.example.test") {
          harness.requests.push(request);
          return {
            status: 200,
            headers: { "cache-control": "max-age=0" },
            body: catalogBytes([]),
          };
        }
        return harness.dependencies.transport(request);
      },
    },
  );
  await client.refresh();
  assert.deepEqual(harness.requests.map(({ url }) => new URL(url).host).sort(), [
    "beta.example.test",
    "skills.example.test",
  ]);
});

test("concurrent repeated activation returns one identity and performs one artifact request", async () => {
  const harness = createLifecycleHarness();
  const session = await createClient(harness).session("acme");
  const [first, second, third] = await Promise.all([
    session.activate("code-review", "1.4.x"),
    session.activate("code-review", "1.4.x"),
    session.activate("code-review", "*"),
  ]);
  assert.equal(first, second);
  assert.equal(second, third);
  assert.equal(
    harness.requests.filter(
      ({ url }) => new URL(url).pathname === "/.well-known/agent-skills/artifacts/1.4.7.md",
    ).length,
    1,
  );
  await session.close();
});

test("close is idempotent, releases leases, invalidates activated views, and supports async disposal", async () => {
  const cache = new MemoryCache({
    maxBytes: 0,
    verifyExtractedContents: verifyCachedExtraction,
  });
  const harness = createLifecycleHarness({ cache });
  const session = await createClient(harness).session("acme");
  const activated = await session.activate("code-review", "1.4.x");
  const beforeClose = await cache.evict();
  assert.deepEqual(beforeClose.retainedPinned, [activated.digest]);

  await Promise.all([session.close(), session.close(), session[Symbol.asyncDispose]()]);
  await assertSessionClosed(() => session.catalog());
  await assertSessionClosed(() => session.activate("code-review"));
  await assertSessionClosed(() => activated.list());
  await assertSessionClosed(() => activated.read("SKILL.md"));
  await assertSessionClosed(() => activated.readBytes("SKILL.md"));

  const afterClose = await cache.evict();
  assert.deepEqual(afterClose.retainedPinned, []);
  assert.deepEqual(afterClose.evicted, [activated.digest]);
});

for (const policy of ["no-store", "unconfirmed"] as const) {
  for (const activation of ["none", "successful", "failed", "in-flight"] as const) {
    test(`${policy} disk session with ${activation} activation preserves its persistence lifecycle`, async (t) => {
      const directory = await mkdtemp(join(tmpdir(), "remote-skills-session-nonpersistent-"));
      const artifactGate = deferred();
      const artifactStarted = deferred();
      const harness = createLifecycleHarness(activation === "in-flight" ? { artifactGate } : {});
      const client = createRemoteSkills(
        {
          origins: {
            acme: {
              url: "https://skills.example.test",
              retries: 0,
              ...(policy === "unconfirmed" ? { headers: { authorization: "fixture-token" } } : {}),
            },
          },
          cache: "disk",
          cacheOptions: {
            directory,
            maxBytes: 0,
            now: () => new Date(harness.dependencies.now()),
          },
        },
        {
          ...harness.dependencies,
          transport: async (request) => {
            if (request.url !== CATALOG_URL) artifactStarted.resolve();
            const response = await harness.dependencies.transport(request);
            return request.url === CATALOG_URL && policy === "no-store"
              ? { ...response, headers: { ...response.headers, "cache-control": "no-store" } }
              : response;
          },
        },
      );
      const session = await client.session("acme");
      t.after(async () => {
        artifactGate.resolve();
        try {
          await session.close();
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      });
      assert.deepEqual(
        (await session.catalog()).map(({ name }) => name),
        ["code-review"],
      );
      if (activation === "successful") {
        assert.equal((await session.activate("code-review")).digest, sha256(SKILL_V1));
      } else if (activation === "failed") {
        harness.setOnline(false);
        await assert.rejects(session.activate("code-review"), { code: "origin_unavailable" });
      } else if (activation === "in-flight") {
        const pending = session.activate("code-review");
        await artifactStarted.promise;
        const closing = session.close();
        artifactGate.resolve();
        await assertSessionClosed(() => pending);
        await closing;
      }
      await Promise.all([session.close(), session[Symbol.asyncDispose]()]);
      const files = (await readdir(directory, { recursive: true, withFileTypes: true })).filter(
        (entry) => entry.isFile(),
      );
      if (activation === "none") {
        assert.equal(files.length, 0);
      } else {
        await access(join(directory, "cache-v1", "eviction.json"));
        const cache = new DiskCache({ directory });
        assert.equal(await cache.getObject(sha256(SKILL_V1)), null);
      }
    });
  }
}

for (const cacheMode of ["default-disk", "memory"] as const) {
  for (const bound of ["capacity", "age"] as const) {
    test(`${cacheMode} lifecycle maintenance enforces ${bound} bounds while preserving active pins`, async (t) => {
      const directory = await mkdtemp(join(tmpdir(), "remote-skills-session-maintenance-"));
      const sessions: RemoteSkillsSession[] = [];
      t.after(async () => {
        const closed = await Promise.allSettled(sessions.map((session) => session.close()));
        await rm(directory, { recursive: true, force: true });
        assert.deepEqual(
          closed.filter((result) => result.status === "rejected"),
          [],
        );
      });
      const harness = createLifecycleHarness();
      const prototype = cacheMode === "memory" ? MemoryCache.prototype : DiskCache.prototype;
      const evict = prototype.evict;
      const maintenance: EvictionResult[] = [];
      t.mock.method(prototype, "evict", async function (this: MemoryCache | DiskCache) {
        const result = await evict.call(this);
        maintenance.push(result);
        return result;
      });
      const client = createRemoteSkills(
        {
          origins: { acme: { url: "https://skills.example.test", retries: 0 } },
          ...(cacheMode === "memory" ? { cache: "memory" as const } : {}),
          cacheOptions: {
            directory,
            now: () => new Date(harness.dependencies.now()),
            maxBytes: bound === "capacity" ? 0 : 1_000_000,
            maxAgeSeconds: bound === "age" ? 1 : 1_000_000,
          },
        },
        harness.dependencies,
      );
      const activeSession = await client.session("acme");
      sessions.push(activeSession);
      const active = await activeSession.activate("code-review");
      harness.setEntries([versionedEntry([descriptor("1.4.8", SKILL_V2)], "Review version two.")]);

      for (let cycle = 0; cycle < 2; cycle += 1) {
        const session = await client.session("acme");
        sessions.push(session);
        const skill = await session.activate("code-review");
        assert.equal(maintenance.length, cycle);
        harness.advance(2_000);
        await Promise.all([session.close(), session.close(), session[Symbol.asyncDispose]()]);
        assert.equal(maintenance.length, cycle + 1);
        assert.ok(maintenance[cycle]?.evicted.includes(skill.digest));
        assert.deepEqual(maintenance[cycle]?.retainedPinned, [active.digest]);
        assert.equal(await active.read("SKILL.md"), SKILL_V1.toString());
      }

      assert.equal(
        harness.requests.filter(
          ({ url }) => new URL(url).pathname === "/.well-known/agent-skills/artifacts/1.4.8.md",
        ).length,
        2,
      );
      harness.advance(2_000);
      await activeSession.close();
      assert.equal(maintenance.length, 3);
      assert.ok(maintenance[2]?.evicted.includes(active.digest));
      assert.deepEqual(maintenance[2]?.retainedPinned, []);
      assert.equal(maintenance[2]?.totalBytes, 0);
    });
  }
}

test("separate clients sharing disk cache close together and can activate again", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-shared-session-close-"));
  const sessions: RemoteSkillsSession[] = [];
  t.after(async () => {
    const closed = await Promise.allSettled(sessions.map((session) => session.close()));
    await rm(directory, { recursive: true, force: true });
    assert.deepEqual(
      closed.filter((result) => result.status === "rejected"),
      [],
    );
  });
  const harness = createLifecycleHarness();
  const clients = ["engineering", "sales"].map((scope) =>
    createRemoteSkills(
      {
        origins: { acme: { url: "https://skills.example.test", scope, retries: 0 } },
        cache: "disk",
        cacheOptions: { directory, now: () => new Date(harness.dependencies.now()) },
      },
      harness.dependencies,
    ),
  );
  for (const [index, client] of clients.entries()) {
    const session = await client.session("acme");
    sessions.push(session);
    assert.equal(
      (await session.activate("code-review")).instructions,
      index === 0 ? "Version one instructions.\n" : "Version two instructions.\n",
    );
    harness.setEntries([versionedEntry([descriptor("1.4.8", SKILL_V2)], "Review version two.")]);
  }
  await Promise.all(sessions.map((session) => session.close()));
  for (const client of clients) {
    const session = await client.session("acme");
    sessions.push(session);
    assert.equal(
      (await session.activate("code-review")).instructions,
      "Version two instructions.\n",
    );
    await session.close();
  }
});

test("default disk lifecycle maintenance cleans obsolete catalog generations within its scan budget", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-session-cleanup-"));
  let session: RemoteSkillsSession | undefined;
  try {
    const harness = createLifecycleHarness();
    const client = createRemoteSkills(
      {
        origins: { acme: { url: "https://skills.example.test", retries: 0 } },
        cacheOptions: {
          directory,
          now: () => new Date(harness.dependencies.now()),
          maxScanEntries: 1_000,
        },
      },
      harness.dependencies,
    );
    session = await client.session("acme");
    const originId = canonicalOriginIdentifier(CATALOG_URL);
    const current = join(directory, "cache-v1", "catalogs", originId);
    const previous = join(
      directory,
      "cache-v1",
      "tmp",
      "catalog-generations-v1",
      originId,
      "previous",
    );
    await mkdir(dirname(previous), { recursive: true });
    await cp(current, previous, { recursive: true });
    await access(previous);
    await session.close();
    await assert.rejects(access(previous), { code: "ENOENT" });
    await access(current);
  } finally {
    try {
      await session?.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("closing during activation waits for cleanup and never hands out a post-close view", async () => {
  const artifactGate = deferred();
  const harness = createLifecycleHarness({ artifactGate });
  const session = await createClient(harness).session("acme");
  const activation = session.activate("code-review", "1.4.x");
  while (
    !harness.requests.some(
      ({ url }) => new URL(url).pathname === "/.well-known/agent-skills/artifacts/1.4.7.md",
    )
  ) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const closing = session.close();
  artifactGate.resolve();
  await assertSessionClosed(() => activation);
  await closing;
  const eviction = await harness.cache.evict();
  assert.deepEqual(eviction.retainedPinned, []);
});

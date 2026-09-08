import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { crc32, gzipSync } from "node:zlib";
import { validateSkillMarkdown } from "../../../core/src/authoring/frontmatter.ts";
import { classifyZipEntryKind } from "../../src/activation/archive-entry-kind.ts";
import {
  type ActivateSkillInput,
  type ActivationDependencies,
  activateSkill,
  createActivationCoordinator,
  verifyCachedExtraction,
} from "../../src/activation/index.ts";
import { type CacheBackend, DiskCache, MemoryCache } from "../../src/cache/index.ts";
import { RemoteSkillsError, type TransportRequest } from "../../src/catalog/index.ts";
import { normalizeOrigins } from "../../src/origin.ts";

const repositoryRoot = resolve(import.meta.dirname, "../../../..");
const protocolRoot = resolve(repositoryRoot, "tests/protocol");
const archiveRoot = resolve(protocolRoot, "fixtures/archive");
const PUBLIC_ANSWER = [{ address: "93.184.216.34", family: 4 as const }] as const;

test("ZIP entry kind preserves unspecified modes and declared ordinary representations", () => {
  assert.equal(classifyZipEntryKind(0, false), "regular");
  assert.equal(classifyZipEntryKind(0, true), "directory");
  assert.equal(classifyZipEntryKind(0x8000, false), "regular");
  assert.equal(classifyZipEntryKind(0x4000, false), "directory");
  assert.equal(classifyZipEntryKind(0x4000, true), "directory");
});

test("ZIP entry kind rejects a declared regular file with a directory suffix", () => {
  assert.equal(classifyZipEntryKind(0x8000, true), undefined);
});

for (let unixType = 0; unixType <= 0xf000; unixType += 0x1000) {
  if (unixType === 0 || unixType === 0x4000 || unixType === 0x8000) continue;
  for (const hasDirectorySuffix of [false, true]) {
    test(`ZIP entry kind rejects disallowed scalar ${unixType.toString(16)} with directory suffix ${hasDirectorySuffix}`, () => {
      assert.equal(classifyZipEntryKind(unixType, hasDirectorySuffix), undefined);
    });
  }
}

interface ArchiveFixture {
  artifact_type: "archive" | "skill-md";
  format?: "tar.gz" | "zip";
  id?: string;
  limits?: {
    archive_bytes?: number;
    extracted_bytes?: number;
    file_bytes?: number;
    files?: number;
  };
  path?: string;
}

interface ActivationCall {
  input: ActivateSkillInput;
  dependencies: ActivationDependencies;
}

function record(value: unknown, label: string): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), label);
  return Object.fromEntries(Object.entries(value));
}

function records(value: unknown, label: string): Record<string, unknown>[] {
  assert.ok(Array.isArray(value), label);
  return value.map((entry, index) => record(entry, `${label}[${index}]`));
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  return value;
}

function numberValue(value: unknown, label: string): number {
  if (typeof value !== "number") throw new TypeError(`${label} must be a number`);
  return value;
}

function archiveFixture(value: unknown): ArchiveFixture {
  const raw = record(value, "archive fixture");
  const artifactType = stringValue(raw.artifact_type, "archive fixture artifact type");
  if (artifactType !== "archive" && artifactType !== "skill-md") {
    throw new TypeError("archive fixture artifact type is unsupported");
  }
  const format = raw.format === undefined ? undefined : stringValue(raw.format, "archive format");
  if (format !== undefined && format !== "tar.gz" && format !== "zip") {
    throw new TypeError("archive fixture format is unsupported");
  }
  const rawLimits = raw.limits === undefined ? undefined : record(raw.limits, "archive limits");
  return {
    artifact_type: artifactType,
    ...(format === undefined ? {} : { format }),
    ...(raw.id === undefined ? {} : { id: stringValue(raw.id, "archive fixture id") }),
    ...(raw.path === undefined ? {} : { path: stringValue(raw.path, "archive fixture path") }),
    ...(rawLimits === undefined
      ? {}
      : {
          limits: {
            ...(rawLimits.archive_bytes === undefined
              ? {}
              : { archive_bytes: numberValue(rawLimits.archive_bytes, "archive byte limit") }),
            ...(rawLimits.extracted_bytes === undefined
              ? {}
              : {
                  extracted_bytes: numberValue(rawLimits.extracted_bytes, "extracted byte limit"),
                }),
            ...(rawLimits.file_bytes === undefined
              ? {}
              : { file_bytes: numberValue(rawLimits.file_bytes, "file byte limit") }),
            ...(rawLimits.files === undefined
              ? {}
              : { files: numberValue(rawLimits.files, "file limit") }),
          },
        }),
  };
}

async function json(path: string): Promise<unknown> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  return parsed;
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function activationCache() {
  return new MemoryCache({ verifyExtractedContents: verifyCachedExtraction });
}

function tarHeader(path: string, size = 0, type = "0", mode = 0o644): Buffer {
  const header = Buffer.alloc(512);
  header.write(path, 0, 100, "utf8");
  header.write(`${mode.toString(8).padStart(7, "0")}\0`, 100, 8, "ascii");
  header.write("0000000\0", 108, 8, "ascii");
  header.write("0000000\0", 116, 8, "ascii");
  header.write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
  header.write("00000000000\0", 136, 12, "ascii");
  header.write(type, 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  header.fill(0x20, 148, 156);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return header;
}

function tarGzip(
  entries: readonly { contents: Uint8Array; mode?: number; path: string }[],
): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const contents = Buffer.from(entry.contents);
    blocks.push(tarHeader(entry.path, contents.length, "0", entry.mode));
    blocks.push(contents);
    blocks.push(Buffer.alloc((512 - (contents.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

function storedZip(entries: readonly { path: string; bytes: Uint8Array }[]): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.path);
    const checksum = crc32(entry.bytes);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x0403_4b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x21, 12);
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(entry.bytes.length, 18);
    header.writeUInt32LE(entry.bytes.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, Buffer.from(entry.bytes));
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x0201_4b50);
    record.writeUInt16LE(0x0314, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x21, 14);
    record.writeUInt32LE(checksum, 16);
    record.writeUInt32LE(entry.bytes.length, 20);
    record.writeUInt32LE(entry.bytes.length, 24);
    record.writeUInt16LE(name.length, 28);
    const mode = entry.path.endsWith("/") ? 0o40755 : 0o100644;
    record.writeUInt32LE((mode << 16) >>> 0, 38);
    record.writeUInt32LE(offset, 42);
    central.push(record, name);
    offset += header.length + name.length + entry.bytes.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x0605_4b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

function fixtureUrl(fixture: ArchiveFixture): string {
  if (fixture.artifact_type === "skill-md") return "https://skills.example.test/artifact.md";
  return `https://skills.example.test/artifact.${fixture.format}`;
}

function contentType(fixture: ArchiveFixture): string {
  if (fixture.artifact_type === "skill-md") return "text/markdown; charset=utf-8";
  return fixture.format === "zip" ? "application/zip" : "application/gzip";
}

function fixturePath(fixture: ArchiveFixture): string {
  if (fixture.path === undefined) throw new TypeError("archive fixture path is required");
  return fixture.path;
}

function limits(fixture: ArchiveFixture) {
  const selected = fixture.limits ?? {};
  return {
    ...(selected.archive_bytes === undefined ? {} : { archiveBytes: selected.archive_bytes }),
    ...(selected.extracted_bytes === undefined ? {} : { extractedBytes: selected.extracted_bytes }),
    ...(selected.files === undefined ? {} : { files: selected.files }),
    ...(selected.file_bytes === undefined ? {} : { fileBytes: selected.file_bytes }),
  };
}

function activationInput(
  fixture: ArchiveFixture,
  bytes: Uint8Array,
  cache: CacheBackend,
  requests: TransportRequest[],
): ActivationCall {
  const origin = normalizeOrigins({
    fixture: { url: "https://skills.example.test", retries: 0 },
  }).get("fixture");
  assert.ok(origin);
  return {
    input: {
      origin,
      originAlias: "fixture",
      confirmedScope: "engineering",
      entry: {
        originAlias: "fixture",
        name: "fixture-skill",
        description: "Exercise archive safety.",
        artifactType: fixture.artifact_type,
        url: fixtureUrl(fixture),
        digest: sha256(bytes),
      },
      cache,
      sessionNonce: "activation-fixture-session",
      limits: limits(fixture),
    },
    dependencies: {
      now: () => 1_787_888_000_000,
      random: () => 0,
      sleep: async () => {},
      resolve: async () => PUBLIC_ANSWER,
      transport: async (request) => {
        requests.push(request);
        return { status: 200, headers: { "content-type": contentType(fixture) }, body: bytes };
      },
    },
  };
}

const registry = records(
  record(await json(resolve(archiveRoot, "archive-cases.json")), "archive registry").cases,
  "archive cases",
).map(archiveFixture);
const expected = records(
  record(
    await json(resolve(protocolRoot, "expected-results/archive-results.json")),
    "archive expectations",
  ).cases,
  "archive expected cases",
).map((entry) => record(entry.result, "archive expected result"));

for (let index = 0; index < registry.length; index += 1) {
  const fixture = registry[index];
  const expectation = expected[index];
  assert.ok(fixture);
  assert.ok(expectation);
  test(`shared activation fixture: ${fixture.id}`, async () => {
    const bytes = await readFile(resolve(archiveRoot, fixturePath(fixture)));
    const cache = activationCache();
    const requests: TransportRequest[] = [];
    const call = activationInput(fixture, bytes, cache, requests);

    if (expectation.outcome === "activation_error") {
      await assert.rejects(activateSkill(call.input, call.dependencies), (error) => {
        assert.ok(error instanceof RemoteSkillsError);
        assert.deepEqual(error.toDiagnostic(), expectation.error);
        return true;
      });
      assert.equal(await cache.getObject(sha256(bytes)), null);
      assert.equal(requests.length, expectation.requests);
      return;
    }

    const activated = await activateSkill(call.input, call.dependencies);
    try {
      assert.equal(activated.skill.name, expectation.name);
      assert.equal(activated.skill.description, "Exercise archive safety.");
      assert.equal(activated.skill.digest, expectation.digest);
      assert.equal(activated.skill.instructions, expectation.instructions);
      assert.deepEqual(activated.skill.frontmatter, expectation.frontmatter);
      assert.deepEqual(await activated.skill.list(), expectation.files);
      assert.equal(requests.length, expectation.requests);
      assert.equal(activated.pin.confirmedScope, "engineering");
      assert.equal(activated.pin.digest, expectation.digest);
      assert.equal(Object.isFrozen(activated.pin), true);
    } finally {
      await activated.lease.release();
    }
  });
}

for (const backend of ["memory", "disk"] as const) {
  test(`ZIP directories preserve the regular-file allowance through ${backend} cache reuse`, async () => {
    const skill = Buffer.from(
      "---\nname: fixture-skill\ndescription: Exercise archive safety.\n---\nDirectory example.\n",
    );
    const resource = Buffer.from("Ordinary resource.\n");
    const bytes = storedZip([
      { path: "SKILL.md", bytes: skill },
      { path: "empty/", bytes: Buffer.alloc(0) },
      { path: "reference.txt", bytes: resource },
    ]);
    const directory = await mkdtemp(resolve(tmpdir(), "remote-skills-zip-directories-"));
    const verifier = { verifyExtractedContents: verifyCachedExtraction };
    const cache =
      backend === "memory" ? new MemoryCache(verifier) : new DiskCache({ directory, ...verifier });
    const fixture: ArchiveFixture = {
      artifact_type: "archive",
      format: "zip",
      limits: { files: 2 },
    };
    const requests: TransportRequest[] = [];
    try {
      const call = activationInput(fixture, bytes, cache, requests);
      await assert.rejects(
        activateSkill({ ...call.input, limits: { files: 1 } }, call.dependencies),
        {
          code: "limit_exceeded",
          context: { limit: "files" },
        },
      );
      requests.length = 0;
      for (const pass of ["cold", "warm"] as const) {
        const selectedCache =
          backend === "disk" && pass === "warm" ? new DiskCache({ directory, ...verifier }) : cache;
        const selected = activationInput(fixture, bytes, selectedCache, requests);
        const activated = await activateSkill(selected.input, selected.dependencies);
        try {
          assert.equal(await activated.skill.read("reference.txt"), resource.toString());
          assert.deepEqual(
            (await activated.skill.list()).map(({ path }) => path),
            ["SKILL.md", "reference.txt"],
          );
          const object = await selectedCache.getObject(sha256(bytes));
          assert.ok(object);
          assert.equal(object.metadata.files.length, 2);
          assert.equal(await verifyCachedExtraction(object), true);
        } finally {
          await activated.lease.release();
        }
      }
      await assert.rejects(
        activateSkill({ ...call.input, limits: { files: 1 } }, call.dependencies),
        {
          code: "limit_exceeded",
          context: { limit: "files" },
        },
      );
      assert.equal(requests.length, 1, "warm activation must reuse the verified ZIP");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("resource listing matches exact files and directory boundaries and rejects missing prefixes", async (t) => {
  const paths = [
    "SKILL.md",
    "references-extra/guide.md",
    "references.txt",
    "references/guide.md",
    "references/guide.md.backup",
    "references/nested/note.txt",
  ];
  const bytes = tarGzip(
    paths.map((path) => ({
      path,
      contents: Buffer.from(
        path === "SKILL.md"
          ? "---\nname: fixture-skill\ndescription: Exercise archive safety.\n---\nListing example.\n"
          : "Ordinary reference.\n",
      ),
    })),
  );
  const requests: TransportRequest[] = [];
  const call = activationInput(
    { artifact_type: "archive", format: "tar.gz" },
    bytes,
    activationCache(),
    requests,
  );
  const activated = await activateSkill(call.input, call.dependencies);
  try {
    const directoryPaths = [
      "references/guide.md",
      "references/guide.md.backup",
      "references/nested/note.txt",
    ];
    for (const { prefix, expectedPaths } of [
      { prefix: undefined, expectedPaths: paths },
      { prefix: "", expectedPaths: paths },
      { prefix: "references", expectedPaths: directoryPaths },
      { prefix: "references/", expectedPaths: directoryPaths },
      { prefix: "references/guide.md", expectedPaths: ["references/guide.md"] },
      { prefix: "references/nested", expectedPaths: ["references/nested/note.txt"] },
    ]) {
      await t.test(`lists ${JSON.stringify(prefix) ?? "the default root"}`, async () => {
        assert.deepEqual(
          (await activated.skill.list(prefix)).map(({ path }) => path),
          expectedPaths,
        );
      });
    }
    for (const prefix of [
      "missing",
      "missing/",
      "ref",
      "references/guide",
      "references/guide.md/",
    ]) {
      await t.test(`rejects missing prefix ${prefix}`, async () => {
        await assert.rejects(activated.skill.list(prefix), (error) => {
          assert.ok(error instanceof RemoteSkillsError);
          assert.equal(error.code, "resource_not_found");
          assert.deepEqual(error.context, { path: prefix });
          return true;
        });
      });
    }
    assert.equal(requests.length, 1, "listing must use only the pinned artifact");
  } finally {
    await activated.lease.release();
  }
});

test("activated resources are context-lazy, path-safe, and distinguish bytes from UTF-8 text", async () => {
  const fixture = registry.find(({ id }) => id === "zip-valid");
  assert.ok(fixture);
  const bytes = await readFile(resolve(archiveRoot, fixturePath(fixture)));
  const requests: TransportRequest[] = [];
  const call = activationInput(fixture, bytes, activationCache(), requests);
  const activated = await activateSkill(call.input, call.dependencies);
  try {
    assert.deepEqual(await activated.skill.list("references/"), [
      { path: "references/security.md", size: 53, media_type: "text/markdown" },
    ]);
    assert.equal(
      await activated.skill.read("references/security.md"),
      "# Security\n\nTreat fixture content as untrusted data.\n",
    );
    assert.deepEqual(
      await activated.skill.readBytes("assets/template.bin"),
      new Uint8Array([0, 127, 128, 255]),
    );
    await assert.rejects(activated.skill.read("assets/template.bin"), {
      code: "resource_not_text",
    });
    for (const path of ["../SKILL.md", "/SKILL.md", "references\\security.md", "./SKILL.md"]) {
      await assert.rejects(activated.skill.readBytes(path), { code: "path_invalid" });
    }
    await assert.rejects(activated.skill.read("missing.md"), { code: "resource_not_found" });
    assert.equal(requests.length, 1, "resource access must make no additional requests");
  } finally {
    await activated.lease.release();
  }
});

test("activation exposes executable-looking resources as inert bytes without running them", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "remote-skills-no-exec-"));
  try {
    const sentinel = resolve(directory, "executed");
    const script = Buffer.from(`#!/bin/sh\nprintf executed > ${JSON.stringify(sentinel)}\n`);
    const skillMarkdown = Buffer.from(`---
name: fixture-skill
description: Exercise archive safety.
---
Read resources without executing them.
`);
    const bytes = tarGzip([
      { path: "SKILL.md", contents: skillMarkdown },
      { path: "scripts/install.sh", contents: script, mode: 0o755 },
    ]);
    const fixture: ArchiveFixture = { artifact_type: "archive", format: "tar.gz" };
    const call = activationInput(fixture, bytes, activationCache(), []);

    const activated = await activateSkill(call.input, call.dependencies);
    try {
      assert.deepEqual(
        await activated.skill.readBytes("scripts/install.sh"),
        new Uint8Array(script),
      );
      assert.equal(existsSync(sentinel), false);
    } finally {
      await activated.lease.release();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("digest verification is terminal, precedes parsing/publication, and is not retried", async () => {
  const fixture = registry.find(({ id }) => id === "skill-md-valid");
  assert.ok(fixture);
  const bytes = await readFile(resolve(archiveRoot, fixturePath(fixture)));
  const cache = activationCache();
  const requests: TransportRequest[] = [];
  const call = activationInput(fixture, bytes, cache, requests);
  const input = {
    ...call.input,
    entry: { ...call.input.entry, digest: `sha256:${"0".repeat(64)}` },
    origin: { ...call.input.origin, retries: 2 },
  };
  await assert.rejects(activateSkill(input, call.dependencies), (error) => {
    assert.ok(error instanceof RemoteSkillsError);
    assert.equal(error.code, "digest_mismatch");
    assert.deepEqual(error.context, {
      origin_alias: "fixture",
      skill_name: "fixture-skill",
      expected_digest: `sha256:${"0".repeat(64)}`,
    });
    return true;
  });
  assert.equal(requests.length, 1);
  assert.equal(await cache.getObject(input.entry.digest), null);
});

test("an activation coordinator immutably pins authorized scope, release descriptor, and digest", async () => {
  const fixture = registry.find(({ id }) => id === "tar-valid");
  assert.ok(fixture);
  const bytes = await readFile(resolve(archiveRoot, fixturePath(fixture)));
  const requests: TransportRequest[] = [];
  const call = activationInput(fixture, bytes, activationCache(), requests);
  const current = { ...call.input.entry, version: "1.5.0" };
  const selected = { ...call.input.entry, version: "1.4.7" };
  const entry = Object.freeze({
    ...current,
    releases: Object.freeze([Object.freeze(current), Object.freeze(selected)]),
  });
  const coordinator = createActivationCoordinator(
    {
      origin: call.input.origin,
      catalog: Object.freeze({
        originAlias: "fixture",
        requestedScope: "engineering",
        confirmedScope: "engineering",
        stale: false,
        entries: Object.freeze([entry]),
      }),
      cache: call.input.cache,
      sessionNonce: call.input.sessionNonce,
    },
    call.dependencies,
  );
  try {
    const first = await coordinator.activate("fixture-skill", "1.4.x");
    const second = await coordinator.activate("fixture-skill", "*");
    assert.equal(first, second);
    assert.equal(first.version, "1.4.7");
    assert.equal(first.digest, selected.digest);
    assert.deepEqual(first.descriptor, {
      version: "1.4.7",
      artifactType: selected.artifactType,
      url: selected.url,
      digest: selected.digest,
    });
    assert.equal(first.confirmedScope, "engineering");
    assert.equal(Object.isFrozen(first.descriptor), true);
    assert.equal(requests.length, 1);
  } finally {
    await coordinator.release();
  }
});

test("cache reuse still enforces the current activation limits without another request", async () => {
  const fixture = registry.find(({ id }) => id === "zip-valid");
  assert.ok(fixture);
  const bytes = await readFile(resolve(archiveRoot, fixturePath(fixture)));
  const cache = activationCache();
  const requests: TransportRequest[] = [];
  const firstCall = activationInput(fixture, bytes, cache, requests);
  const first = await activateSkill(firstCall.input, firstCall.dependencies);
  await first.lease.release();

  const secondCall = activationInput(fixture, bytes, cache, requests);
  const secondInput = { ...secondCall.input, limits: { archiveBytes: 1 } };
  const secondDependencies = {
    ...secondCall.dependencies,
    transport: async () => {
      throw new Error("verified object reuse made an artifact request");
    },
  };
  await assert.rejects(activateSkill(secondInput, secondDependencies), {
    code: "limit_exceeded",
    context: { limit: "archive_bytes" },
  });
  assert.equal(requests.length, 1);
});

for (const selection of ["direct", "selected-unversioned", "selected-versioned"] as const) {
  for (const warm of [false, true]) {
    test(`${selection} current description mismatch rejects ${warm ? "warm" : "cold"} activation and releases its lease`, async (t) => {
      const bytes = Buffer.from(
        "---\nname: fixture-skill\ndescription: Exercise archive safety.\n---\nOrdinary instructions.\n",
      );
      const cache = new MemoryCache({
        maxBytes: 0,
        verifyExtractedContents: verifyCachedExtraction,
      });
      const requests: TransportRequest[] = [];
      const call = activationInput({ artifact_type: "skill-md" }, bytes, cache, requests);
      if (warm) {
        const seeded = await activateSkill(call.input, call.dependencies);
        await seeded.lease.release();
      }
      const publish = t.mock.method(cache, "publishObject");
      const acquireLease = cache.acquireLease.bind(cache);
      let released = 0;
      t.mock.method(cache, "acquireLease", async (digest: string, nonce: string) => {
        const lease = await acquireLease(digest, nonce);
        return {
          ...lease,
          async release() {
            released += 1;
            await lease.release();
          },
        };
      });
      const current = {
        ...call.input.entry,
        ...(selection === "selected-versioned" ? { version: "2.0.0" } : {}),
        description: "The catalog has an updated description.",
      };
      const entry = {
        ...current,
        ...(selection === "selected-versioned" ? { releases: [{ ...current }] } : {}),
      };
      if (entry.releases !== undefined) assert.notEqual(entry.releases[0], entry);
      const coordinator = createActivationCoordinator(
        {
          origin: call.input.origin,
          catalog: { originAlias: "fixture", stale: false, entries: [entry] },
          cache,
          sessionNonce: call.input.sessionNonce,
        },
        call.dependencies,
      );
      try {
        await assert.rejects(
          selection === "direct"
            ? activateSkill({ ...call.input, entry }, call.dependencies)
            : coordinator.activate(entry.name),
          { code: "catalog_invalid", context: { field: "description" } },
        );
        assert.equal(publish.mock.callCount(), 0);
        assert.equal(released, 1);
        assert.equal(requests.length, 1);
        assert.equal((await cache.getObject(entry.digest)) !== null, warm);
        const eviction = await cache.evict();
        assert.deepEqual(eviction.retainedPinned, []);
        assert.deepEqual(eviction.evicted, warm ? [entry.digest] : []);
      } finally {
        await coordinator.release();
      }
    });
  }
}

test("a historical descriptor uses its own parsed frontmatter description", async () => {
  const fixture = registry.find(({ id }) => id === "skill-md-valid");
  assert.ok(fixture);
  const bytes = await readFile(resolve(archiveRoot, fixturePath(fixture)));
  const requests: TransportRequest[] = [];
  const call = activationInput(fixture, bytes, activationCache(), requests);
  const input: ActivateSkillInput = {
    ...call.input,
    entry: {
      ...call.input.entry,
      description: "The current release has a newer description.",
    },
    release: {
      version: "1.0.0",
      artifactType: call.input.entry.artifactType,
      url: call.input.entry.url,
      digest: call.input.entry.digest,
    },
  };
  for (const _warm of [false, true]) {
    const result = await activateSkill(input, call.dependencies);
    try {
      assert.equal(result.skill.description, "Exercise archive safety.");
      assert.equal(result.skill.version, "1.0.0");
      assert.equal(requests.length, 1);
    } finally {
      await result.lease.release();
    }
  }
});

test("tar metadata rejects an unsafe first header before inflating its oversized payload tail", async () => {
  const expanded = Buffer.concat([tarHeader("../escape.txt"), Buffer.alloc(30_000)]);
  const bytes = gzipSync(expanded);
  const fixture: ArchiveFixture = {
    artifact_type: "archive",
    format: "tar.gz",
    limits: { extracted_bytes: 1, files: 1, file_bytes: 1 },
  };
  const call = activationInput(fixture, bytes, activationCache(), []);

  await assert.rejects(activateSkill(call.input, call.dependencies), {
    code: "archive_unsafe",
    context: { path: "../escape.txt" },
  });
});

test("activation sanitizes unknown frontmatter field diagnostics", async () => {
  const label = "unfamiliar-label";
  const bytes = Buffer.from(`---
name: fixture-skill
description: Exercise archive safety.
${label}: ordinary value
---
# Body
`);
  const call = activationInput({ artifact_type: "skill-md" }, bytes, activationCache(), []);

  await assert.rejects(activateSkill(call.input, call.dependencies), (error: unknown) => {
    assert.ok(error instanceof RemoteSkillsError);
    assert.deepEqual(error.toDiagnostic(), {
      code: "catalog_invalid",
      retryable: false,
      context: { field: "[unknown-field]" },
    });
    assert.equal(JSON.stringify(error.toDiagnostic()).includes(label), false);
    assert.equal(String(error).includes(label), false);
    return true;
  });
});

test("activation keeps recognized frontmatter field diagnostics specific", async () => {
  const fields = ["name", "description", "license", "compatibility", "metadata", "allowed-tools"];
  for (const field of fields) {
    const frontmatter = {
      name: "fixture-skill",
      description: "Exercise archive safety.",
      [field]: 42,
    };
    const bytes = Buffer.from(`---\n${JSON.stringify(frontmatter)}\n---\n# Body\n`);
    const call = activationInput({ artifact_type: "skill-md" }, bytes, activationCache(), []);

    await assert.rejects(activateSkill(call.input, call.dependencies), {
      code: "catalog_invalid",
      context: { field },
    });
  }
});

test("activation matches the canonical 100,000-node frontmatter limit", async () => {
  const sequence = Array.from({ length: 150_000 }, () => "  - value").join("\n");
  const source = `---
name: fixture-skill
description: Exercise archive safety.
allowed-tools:
${sequence}
---
# Body
`;
  const publisher = validateSkillMarkdown(source, {
    directoryName: "fixture-skill",
    sourcePath: "skills/fixture-skill/SKILL.md",
  });
  assert.deepEqual(
    publisher.diagnostics.map(({ code, context }) => ({ code, limit: context.limit })),
    [{ code: "limit_exceeded", limit: "frontmatterNodes" }],
  );

  const bytes = new TextEncoder().encode(source);
  const fixture: ArchiveFixture = { artifact_type: "skill-md" };
  const call = activationInput(fixture, bytes, activationCache(), []);
  await assert.rejects(activateSkill(call.input, call.dependencies), {
    code: "limit_exceeded",
    context: { limit: "frontmatterNodes" },
  });
});

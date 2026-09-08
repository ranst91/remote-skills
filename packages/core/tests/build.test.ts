import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs, {
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync, type ZlibOptions } from "node:zlib";

import { validateAuthoringProject } from "../src/authoring/index.ts";
import { encodeTarGzip, encodeZip } from "../src/build/archive.ts";
import { validatePublishedArtifact } from "../src/build/archive-validation.ts";
import { DISCOVERY_SCHEMA, encodeCatalogBounded } from "../src/build/catalog-json.ts";
import { buildPublisherOutput, PublisherBuildError } from "../src/build/index.ts";
import { verifyPriorOutput } from "../src/build/prior-output.ts";
import { prepareStableOutput, releaseStableOutput } from "../src/build/publication.ts";
import { type PublisherConfig, validateConfig } from "../src/config-schema.ts";
import { posixMutationProbe } from "./platform.ts";

const protocolPublisher = fileURLToPath(
  new URL("../../../tests/protocol/fixtures/publisher/", import.meta.url),
);
const protocolExpected = fileURLToPath(
  new URL("../../../tests/protocol/expected-results/", import.meta.url),
);
const temporaryProjects: string[] = [];

afterEach(() => {
  for (const projectDir of temporaryProjects.splice(0)) {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

function createProject(files: Readonly<Record<string, string | Uint8Array>> = {}) {
  const projectDir = realpathSync.native(mkdtempSync(path.join(tmpdir(), "remote-skills-build-")));
  temporaryProjects.push(projectDir);
  for (const [relativePath, contents] of Object.entries(files)) {
    const absolutePath = path.join(projectDir, relativePath);
    mkdirSync(path.dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, contents);
  }
  return projectDir;
}

test("temporary project paths use the production canonical spelling", async () => {
  const projectDir = createProject();

  assert.equal(projectDir, await fs.promises.realpath(projectDir));
});

function canonicalProject() {
  const projectDir = createProject();
  cpSync(path.join(protocolPublisher, "source", "skills"), path.join(projectDir, "skills"), {
    recursive: true,
  });
  return projectDir;
}

interface SkillMarkdownOptions {
  body?: string;
  version?: string;
}

function skillMarkdown(
  name: string,
  { version, body = "# Instructions\n" }: SkillMarkdownOptions = {},
) {
  return `---
name: ${name}
description: Deterministically build ${name}.
${version === undefined ? "" : `metadata:\n  version: ${version}\n`}---
${body}`;
}

type ConfigOverrides = Partial<Omit<PublisherConfig, "dev" | "limits">> & {
  dev?: Partial<PublisherConfig["dev"]>;
  limits?: Partial<PublisherConfig["limits"]>;
};

function config(overrides: ConfigOverrides = {}) {
  return validateConfig({
    ...overrides,
    ...(overrides.limits === undefined ? {} : { limits: overrides.limits }),
    ...(overrides.dev === undefined ? {} : { dev: overrides.dev }),
  });
}

async function validated(projectDir: string, publisherConfig: PublisherConfig) {
  const result = await validateAuthoringProject({ projectDir, config: publisherConfig });
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  return result;
}

function walkBytes(root: string, relative = ""): Array<readonly [string, Buffer]> {
  const entries: Array<readonly [string, Buffer]> = [];
  for (const name of readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const child = path.posix.join(relative, name.name);
    if (name.isDirectory()) entries.push(...walkBytes(root, child));
    else {
      const entry: readonly [string, Buffer] = [child, readFileSync(path.join(root, child))];
      entries.push(entry);
    }
  }
  return entries;
}

interface CatalogRelease {
  digest: string;
  type: string;
  url: string;
  version: string;
}

interface CatalogExtension {
  releases: CatalogRelease[];
  version: string;
}

interface CatalogEntry {
  digest: string;
  name: string;
  type: string;
  url: string;
  "x-remote-skills"?: CatalogExtension;
}

interface CatalogIndex {
  $schema: string;
  skills: [CatalogEntry, ...CatalogEntry[]];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isCatalogEntry(value: unknown): value is CatalogEntry {
  if (!isRecord(value)) return false;
  if (
    typeof value.name !== "string" ||
    typeof value.type !== "string" ||
    typeof value.url !== "string" ||
    typeof value.digest !== "string"
  )
    return false;
  const extension = value["x-remote-skills"];
  if (extension === undefined) return true;
  return (
    isRecord(extension) &&
    typeof extension.version === "string" &&
    Array.isArray(extension.releases) &&
    extension.releases.every(
      (release) =>
        isRecord(release) &&
        typeof release.version === "string" &&
        typeof release.type === "string" &&
        typeof release.url === "string" &&
        typeof release.digest === "string",
    )
  );
}

function parseCatalogIndex(text: string): CatalogIndex {
  const parsed: unknown = JSON.parse(text);
  assert.ok(isRecord(parsed));
  assert.ok(typeof parsed.$schema === "string");
  assert.ok(Array.isArray(parsed.skills));
  assert.ok(parsed.skills.length > 0);
  assert.ok(parsed.skills.every(isCatalogEntry));
  const first = parsed.skills[0];
  assert.ok(first);
  return { $schema: parsed.$schema, skills: [first, ...parsed.skills.slice(1)] };
}

function readIndex(outputDir: string): CatalogIndex {
  return parseCatalogIndex(
    readFileSync(path.join(outputDir, ".well-known", "agent-skills", "index.json"), "utf8"),
  );
}

function versionHistory(entry: CatalogEntry): CatalogExtension {
  const extension = entry["x-remote-skills"];
  assert.ok(extension, `expected ${entry.name} to have version history`);
  return extension;
}

function findEntry(index: CatalogIndex, name: string): CatalogEntry {
  const entry = index.skills.find((candidate) => candidate.name === name);
  assert.ok(entry, `expected catalog entry ${name}`);
  return entry;
}

function firstRelease(entry: CatalogEntry): CatalogRelease {
  const release = versionHistory(entry).releases[0];
  assert.ok(release, `expected ${entry.name} to have a release`);
  return release;
}

function findRelease(entry: CatalogEntry, version: string): CatalogRelease {
  const release = versionHistory(entry).releases.find((candidate) => candidate.version === version);
  assert.ok(release, `expected ${entry.name} release ${version}`);
  return release;
}

const isArchiveUnsafe = (error: { code: string }) =>
  error instanceof PublisherBuildError && error.code === "archive_unsafe";

function artifactPath(outputDir: string, entry: { url: string }) {
  return path.join(outputDir, ".well-known", "agent-skills", ...entry.url.split("/"));
}

function writerStateDir(outputDir: string) {
  return path.join(
    tmpdir(),
    "remote-skills-publisher-v1",
    createHash("sha256").update(path.resolve(outputDir), "utf8").digest("hex"),
  );
}

function writeWriterFixture(
  coordination: string,
  nonce: string,
  ticket: number,
  pid: number,
  createdAtMs: number,
) {
  writeFileSync(
    path.join(coordination, `${nonce}.intent`),
    `${JSON.stringify({
      schema: "remote-skills-publisher-writer-intent-v1",
      pid,
      nonce,
      created_at_ms: createdAtMs,
    })}\n`,
  );
  writeFileSync(
    path.join(coordination, `${String(ticket).padStart(16, "0")}-${nonce}.ticket`),
    `${JSON.stringify({
      schema: "remote-skills-publisher-writer-ticket-v1",
      pid,
      nonce,
      ticket,
      created_at_ms: createdAtMs,
    })}\n`,
  );
}

function removeWriterFixture(coordination: string, nonce: string, ticket: number) {
  rmSync(path.join(coordination, `${nonce}.intent`));
  rmSync(path.join(coordination, `${String(ticket).padStart(16, "0")}-${nonce}.ticket`));
}

async function waitForWriterRecords(
  coordination: fs.PathLike,
  expected: number,
  signal?: AbortSignal,
) {
  const started = Date.now();
  while (true) {
    const records = existsSync(coordination)
      ? readdirSync(coordination).filter((name) => /\.(?:intent|ticket)$/u.test(name))
      : [];
    if (records.length >= expected) return records;
    if (Date.now() - started > 5_000) {
      assert.fail(`timed out waiting for ${expected} writer records; saw ${records.join(", ")}`);
    }
    await delay(5, undefined, { signal });
  }
}

async function boundedWorkerWait<T>(
  operation: Promise<T>,
  timeoutMilliseconds = 10_000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("publisher worker wait timed out")),
          timeoutMilliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitForWorkerReady(
  ready: string,
  completion: Promise<unknown>,
  timeoutMilliseconds = 10_000,
): Promise<void> {
  const controller = new AbortController();
  const readiness = (async () => {
    while (!existsSync(ready)) await delay(2, undefined, { signal: controller.signal });
  })();
  try {
    await boundedWorkerWait(
      Promise.race([
        readiness,
        completion.then(() => {
          throw new Error("publisher worker exited before readiness");
        }),
      ]),
      timeoutMilliseconds,
    );
  } finally {
    controller.abort();
    await readiness.catch(() => undefined);
  }
}

function launchPublisherWorker(
  projectDir: string,
  name: string,
  ready: string,
  barrier: string,
  schedule?: "pause-writer-staging",
) {
  const worker = fileURLToPath(new URL("build-process-worker.ts", import.meta.url));
  const child = spawn(
    process.execPath,
    [worker, projectDir, name, ready, barrier, ...(schedule ? [schedule] : [])],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const completion = new Promise<void>((resolve, reject) => {
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`worker ${name}: ${stderr}`)),
    );
  });
  void completion.catch(() => undefined);
  return { child, ready, completion };
}

test("publisher worker waits reject early completion and unavailable readiness", async () => {
  const ready = path.join(createProject(), "unavailable.ready");
  await assert.rejects(waitForWorkerReady(ready, Promise.resolve()), /exited before readiness/);
  await assert.rejects(waitForWorkerReady(ready, new Promise<void>(() => {}), 5), /wait timed out/);
});

function rewriteArtifactDescriptor(outputDir: string, index: CatalogIndex, bytes: Uint8Array) {
  const entry = index.skills[0];
  const extension = entry.url.slice(entry.url.indexOf(".", "artifacts/sha256-".length));
  const digest = createHash("sha256").update(bytes).digest("hex");
  const descriptor = {
    type: entry.type,
    url: `artifacts/sha256-${digest}${extension}`,
    digest: `sha256:${digest}`,
  };
  rmSync(artifactPath(outputDir, entry));
  writeFileSync(path.join(outputDir, ".well-known", "agent-skills", descriptor.url), bytes);
  Object.assign(entry, descriptor);
  const release = versionHistory(entry).releases[0];
  assert.ok(release);
  Object.assign(release, descriptor);
  writeFileSync(
    path.join(outputDir, ".well-known", "agent-skills", "index.json"),
    `${JSON.stringify(index, null, 2)}\n`,
  );
}

const goldenFormats: ReadonlyArray<readonly [PublisherConfig["format"], string]> = [
  ["tar.gz", "tar-gzip"],
  ["zip", "zip"],
];

for (const [format, goldenDirectory] of goldenFormats) {
  test(`builds ${format} publisher goldens byte-for-byte twice`, async () => {
    const projectDir = canonicalProject();
    const publisherConfig = config({ format });
    const firstValidation = await validated(projectDir, publisherConfig);

    await buildPublisherOutput({
      projectDir,
      config: publisherConfig,
      validation: firstValidation,
    });

    const outputDir = path.join(projectDir, "dist");
    const expectedDir = path.join(protocolPublisher, "goldens", goldenDirectory);
    assert.deepEqual(walkBytes(outputDir), walkBytes(expectedDir));
    const first = walkBytes(outputDir);

    const secondValidation = await validated(projectDir, publisherConfig);
    await buildPublisherOutput({
      projectDir,
      config: publisherConfig,
      validation: secondValidation,
    });

    assert.deepEqual(walkBytes(outputDir), first);
    assert.deepEqual(walkBytes(outputDir), walkBytes(expectedDir));
  });
}

test("catalog byte preflight rejects before reading or copying current artifact bytes", async () => {
  const projectDir = createProject();
  const publisherConfig = config({ limits: { catalogBytes: 1 } });
  const rootBytes = Buffer.from(skillMarkdown("allocation-order"));
  const originalFrom = Buffer.from;
  let artifactTouched = false;
  Reflect.set(Buffer, "from", (...arguments_: unknown[]) => {
    if (arguments_[0] === rootBytes) artifactTouched = true;
    return Reflect.apply(originalFrom, Buffer, arguments_);
  });
  try {
    await assert.rejects(
      buildPublisherOutput({
        projectDir,
        config: publisherConfig,
        validation: {
          valid: true,
          skills: [
            {
              name: "allocation-order",
              description: "Reject the catalog before artifact allocation.",
              frontmatter: {},
              files: [{ path: "SKILL.md", bytes: rootBytes, size: rootBytes.byteLength }],
            },
          ],
        },
      }),
      (error) => error instanceof PublisherBuildError && error.code === "limit_exceeded",
    );
  } finally {
    Reflect.set(Buffer, "from", originalFrom);
  }
  assert.equal(artifactTouched, false);
});

test("catalog byte preflight stops visiting a wide catalog at the first over-bound entry", async () => {
  const projectDir = createProject();
  const publisherConfig = config({ limits: { catalogBytes: 256 } });
  let plansVisited = 0;
  const skills = Array.from({ length: 1_000 }, (_, index) => {
    const suffix = String(index).padStart(4, "0");
    const frontmatter = {};
    Object.defineProperty(frontmatter, "metadata", {
      enumerable: true,
      get() {
        plansVisited += 1;
        return undefined;
      },
    });
    const bytes = new Uint8Array([index % 256]);
    return {
      name: `wide-${suffix}`,
      description: `Wide catalog entry ${suffix}.`,
      frontmatter,
      files: [{ path: "SKILL.md", bytes, size: bytes.byteLength }],
    };
  });

  await assert.rejects(
    buildPublisherOutput({
      projectDir,
      config: publisherConfig,
      validation: { valid: true, skills },
    }),
    (error) => error instanceof PublisherBuildError && error.code === "limit_exceeded",
  );
  assert.equal(plansVisited, 1);
});

test("bounded catalog JSON preserves canonical bytes and enforces the exact UTF-8 limit", async () => {
  const entry = {
    name: "café",
    description: "Crème ☕",
    type: "skill-md",
    url: "artifacts/example.md",
    digest: "sha256:example",
  };
  const expected = Buffer.from(
    `{
  "$schema": ${JSON.stringify(DISCOVERY_SCHEMA)},
  "skills": [
    {
      "name": "café",
      "description": "Crème ☕",
      "type": "skill-md",
      "url": "artifacts/example.md",
      "digest": "sha256:example"
    }
  ]
}
`,
    "utf8",
  );

  assert.deepEqual(encodeCatalogBounded([entry], expected.byteLength), expected);
  assert.equal(
    encodeCatalogBounded([entry], expected.byteLength, { collect: false }),
    expected.byteLength,
  );
  assert.equal(expected.at(-1), 0x0a);
  await assert.rejects(
    async () => encodeCatalogBounded([entry], expected.byteLength - 1),
    (error) => error instanceof PublisherBuildError && error.code === "limit_exceeded",
  );
});

test("selects raw skill-md automatically and supports a forced root archive", async () => {
  const projectDir = createProject({
    "skills/one-file/SKILL.md": skillMarkdown("one-file"),
  });
  const directConfig = config();
  await buildPublisherOutput({
    projectDir,
    config: directConfig,
    validation: await validated(projectDir, directConfig),
  });
  const directOutput = path.join(projectDir, "dist");
  const directEntry = readIndex(directOutput).skills[0];
  assert.equal(directEntry.type, "skill-md");
  assert.equal(
    readFileSync(artifactPath(directOutput, directEntry), "utf8"),
    skillMarkdown("one-file"),
  );

  const archiveConfig = config({ outDir: "forced", format: "zip" });
  await buildPublisherOutput({
    projectDir,
    config: archiveConfig,
    validation: await validated(projectDir, archiveConfig),
    forceArchive: true,
  });
  const archiveEntry = readIndex(path.join(projectDir, "forced")).skills[0];
  assert.equal(archiveEntry.type, "archive");
  assert.match(archiveEntry.url, /^artifacts\/sha256-[0-9a-f]{64}\.zip$/u);
});

test("emits ordinary unversioned entries and strict, deterministically sorted version history", async () => {
  const projectDir = createProject({
    "skills/versioned/SKILL.md": skillMarkdown("versioned", {
      version: "1.4.7+build.2",
    }),
    "skills/unversioned/SKILL.md": skillMarkdown("unversioned"),
  });
  const firstConfig = config({ outDir: "first" });
  await buildPublisherOutput({
    projectDir,
    config: firstConfig,
    validation: await validated(projectDir, firstConfig),
  });
  const firstIndex = readIndex(path.join(projectDir, "first"));
  assert.equal(Object.hasOwn(firstIndex.skills[0], "x-remote-skills"), false);
  const firstVersioned = findEntry(firstIndex, "versioned");
  assert.deepEqual(
    versionHistory(firstVersioned).releases.map(({ version }) => version),
    ["1.4.7+build.2"],
  );

  writeFileSync(
    path.join(projectDir, "skills/versioned/SKILL.md"),
    skillMarkdown("versioned", { version: "1.4.7+build.10", body: "# Updated\n" }),
  );
  const secondConfig = config({ outDir: "second" });
  await buildPublisherOutput({
    projectDir,
    config: secondConfig,
    validation: await validated(projectDir, secondConfig),
    priorOutputDir: path.join(projectDir, "first"),
  });
  const secondVersioned = findEntry(readIndex(path.join(projectDir, "second")), "versioned");
  assert.deepEqual(
    versionHistory(secondVersioned).releases.map(({ version }) => version),
    ["1.4.7+build.10", "1.4.7+build.2"],
  );
  assert.deepEqual(firstRelease(secondVersioned), {
    version: "1.4.7+build.10",
    type: secondVersioned.type,
    url: secondVersioned.url,
    digest: secondVersioned.digest,
  });
});

test("executes the shared publisher version-history fixture and expected results directly", async () => {
  const fixtures: unknown = JSON.parse(
    readFileSync(path.join(protocolPublisher, "version-history-cases.json"), "utf8"),
  );
  const expected: unknown = JSON.parse(
    readFileSync(path.join(protocolExpected, "publisher-version-history-results.json"), "utf8"),
  );
  assert.ok(isRecord(fixtures) && Array.isArray(fixtures.cases));
  assert.ok(isRecord(expected) && Array.isArray(expected.cases));
  const expectedById = new Map<string, Record<string, unknown>>();
  for (const expectedCase of expected.cases) {
    assert.ok(isRecord(expectedCase));
    assert.ok(typeof expectedCase.id === "string");
    assert.ok(isRecord(expectedCase.result));
    expectedById.set(expectedCase.id, expectedCase.result);
  }

  for (const fixture of fixtures.cases) {
    assert.ok(isRecord(fixture));
    assert.ok(typeof fixture.id === "string");
    assert.ok(typeof fixture.skill_name === "string");
    assert.ok(isRecord(fixture.current));
    assert.ok(typeof fixture.current.version === "string");
    assert.ok(isStringArray(fixture.prune));
    assert.ok(
      fixture.prior_release_count === undefined || typeof fixture.prior_release_count === "number",
    );
    assert.ok(fixture.prior_releases === undefined || Array.isArray(fixture.prior_releases));
    const priorReleases = fixture.prior_releases ?? [];
    for (const release of priorReleases) {
      assert.ok(isRecord(release));
      assert.equal(typeof release.version, "string");
    }
    const firstPriorRelease = priorReleases[0];
    const priorVersion = isRecord(firstPriorRelease) ? firstPriorRelease.version : undefined;
    assert.ok(priorVersion === undefined || typeof priorVersion === "string");
    const fixtureId = fixture.id;
    const skillName = fixture.skill_name;
    const currentVersion = fixture.current.version;
    const prune = fixture.prune;
    const priorReleaseCount = fixture.prior_release_count;
    const wanted = expectedById.get(fixtureId);
    assert.ok(wanted, fixtureId);
    const projectFiles: Record<string, string> = {
      [`skills/${skillName}/SKILL.md`]: skillMarkdown(skillName, {
        version: priorVersion ?? currentVersion,
      }),
    };
    if (wanted.outcome === "publisher_history_error") {
      projectFiles["candidate/sentinel.txt"] = "previous generation\n";
    }
    const projectDir = createProject(projectFiles);
    let priorOutputDir: string | undefined;
    if (priorReleases.length > 0 || priorReleaseCount) {
      const priorConfig = config({ outDir: "prior" });
      await buildPublisherOutput({
        projectDir,
        config: priorConfig,
        validation: await validated(projectDir, priorConfig),
        forceArchive: true,
      });
      priorOutputDir = path.join(projectDir, "prior");
      if (priorReleaseCount) {
        const priorIndex = readIndex(priorOutputDir);
        const extension = versionHistory(priorIndex.skills[0]);
        const release = firstRelease(priorIndex.skills[0]);
        extension.version = "1.0.99";
        extension.releases = Array.from({ length: priorReleaseCount }, (_, index) => ({
          ...release,
          version: `1.0.${99 - index}`,
        }));
        writeFileSync(
          path.join(priorOutputDir, ".well-known", "agent-skills", "index.json"),
          `${JSON.stringify(priorIndex, null, 2)}\n`,
        );
      }
    }
    writeFileSync(
      path.join(projectDir, "skills", skillName, "SKILL.md"),
      skillMarkdown(skillName, {
        version: currentVersion,
        body: fixtureId === "history-version-remapped" ? "# Remapped\n" : "# Current\n",
      }),
    );
    const candidateConfig = config({ outDir: "candidate" });
    try {
      await buildPublisherOutput({
        projectDir,
        config: candidateConfig,
        validation: await validated(projectDir, candidateConfig),
        forceArchive: true,
        ...(priorOutputDir === undefined ? {} : { priorOutputDir }),
        ...(prune.length > 0 ? { prune: { [skillName]: prune } } : {}),
      });
      const entry = readIndex(path.join(projectDir, "candidate")).skills[0];
      const result = {
        outcome: "publisher_history_success",
        skill_name: entry.name,
        releases: versionHistory(entry).releases.map(({ version }) => version),
        artifacts_retained: versionHistory(entry).releases.length - 1,
      };
      assert.deepEqual(result, wanted, fixtureId);
    } catch (error) {
      assert.ok(error instanceof PublisherBuildError, fixtureId);
      const result = {
        outcome: "publisher_history_error",
        error: { code: error.code, retryable: error.retryable, context: error.context },
        output_replaced:
          readFileSync(path.join(projectDir, "candidate", "sentinel.txt"), "utf8") !==
          "previous generation\n",
      };
      assert.deepEqual(result, wanted, fixtureId);
    }
  }
});

test("carries prior content-addressed bytes unchanged and prunes only explicit releases", async () => {
  const projectDir = createProject({
    "skills/history/SKILL.md": skillMarkdown("history", { version: "1.4.7" }),
    "skills/history/reference.md": "prior bytes\n",
  });
  const firstConfig = config({ outDir: "first" });
  await buildPublisherOutput({
    projectDir,
    config: firstConfig,
    validation: await validated(projectDir, firstConfig),
  });
  const priorEntry = readIndex(path.join(projectDir, "first")).skills[0];
  const priorBytes = readFileSync(artifactPath(path.join(projectDir, "first"), priorEntry));

  writeFileSync(
    path.join(projectDir, "skills/history/SKILL.md"),
    skillMarkdown("history", { version: "2.0.0", body: "# Current\n" }),
  );
  const secondConfig = config({ outDir: "second" });
  await buildPublisherOutput({
    projectDir,
    config: secondConfig,
    validation: await validated(projectDir, secondConfig),
    priorOutputDir: path.join(projectDir, "first"),
  });
  const secondOutput = path.join(projectDir, "second");
  const secondEntry = readIndex(secondOutput).skills[0];
  const priorRelease = findRelease(secondEntry, "1.4.7");
  assert.deepEqual(readFileSync(artifactPath(secondOutput, priorRelease)), priorBytes);

  const thirdConfig = config({ outDir: "third" });
  await buildPublisherOutput({
    projectDir,
    config: thirdConfig,
    validation: await validated(projectDir, thirdConfig),
    priorOutputDir: secondOutput,
    prune: { history: ["1.4.7"] },
  });
  const thirdOutput = path.join(projectDir, "third");
  const thirdEntry = readIndex(thirdOutput).skills[0];
  assert.deepEqual(
    versionHistory(thirdEntry).releases.map(({ version }) => version),
    ["2.0.0"],
  );
  assert.equal(existsSync(artifactPath(thirdOutput, priorRelease)), false);
});

test("validates each prior descriptor before deduplicating retained sources", async () => {
  const projectDir = createProject({
    "skills/alpha/SKILL.md": skillMarkdown("alpha", { version: "1.0.0" }),
    "skills/bravo/SKILL.md": skillMarkdown("bravo", { version: "1.0.0" }),
  });
  const priorConfig = config({ outDir: "prior" });
  await buildPublisherOutput({
    projectDir,
    config: priorConfig,
    validation: await validated(projectDir, priorConfig),
  });
  const priorOutput = path.join(projectDir, "prior");
  const entries = readIndex(priorOutput).skills;
  const artifactOpens = new Map(entries.map((entry) => [artifactPath(priorOutput, entry), 0]));
  const originalOpen = fs.promises.open;
  fs.promises.open = async (target, ...arguments_) => {
    const source = String(target);
    const count = artifactOpens.get(source);
    if (count !== undefined) artifactOpens.set(source, count + 1);
    return originalOpen(target, ...arguments_);
  };
  syncBuiltinESMExports();
  try {
    const prior = await verifyPriorOutput({
      projectDir,
      priorOutputDir: priorOutput,
      ...priorConfig.limits,
    });
    try {
      assert.equal(prior.artifactSources.size, 2);
      // Each ordinary Markdown artifact has one inventory digest read, then a
      // validated read for both its current and identical history descriptors.
      assert.deepEqual([...artifactOpens.values()], [3, 3]);
    } finally {
      await prior.close();
    }
  } finally {
    fs.promises.open = originalOpen;
    syncBuiltinESMExports();
  }
});

test("rejects an inconsistent prior skill association before publication", async () => {
  const projectDir = createProject({
    "skills/alpha/SKILL.md": skillMarkdown("alpha", { version: "1.0.0" }),
    "skills/bravo/SKILL.md": skillMarkdown("bravo", { version: "1.0.0" }),
    "next/sentinel.txt": "previous generation\n",
  });
  const priorConfig = config({ outDir: "prior" });
  await buildPublisherOutput({
    projectDir,
    config: priorConfig,
    validation: await validated(projectDir, priorConfig),
  });
  const priorOutput = path.join(projectDir, "prior");
  const index = readIndex(priorOutput);
  const secondEntry = index.skills[1];
  assert.ok(secondEntry);
  secondEntry.name = "charlie";
  writeFileSync(
    path.join(priorOutput, ".well-known", "agent-skills", "index.json"),
    `${JSON.stringify(index, null, 2)}\n`,
  );
  const nextConfig = config({ outDir: "next" });
  const before = walkBytes(path.join(projectDir, "next"));
  await assert.rejects(
    buildPublisherOutput({
      projectDir,
      config: nextConfig,
      validation: await validated(projectDir, nextConfig),
      priorOutputDir: priorOutput,
    }),
    (error) => {
      assert.ok(error instanceof PublisherBuildError);
      assert.equal(error.code, "configuration_invalid");
      assert.equal(error.message, "prior skill-md artifact is invalid");
      assert.deepEqual(error.context, { field: "priorOutput" });
      return true;
    },
  );
  assert.deepEqual(walkBytes(path.join(projectDir, "next")), before);
});

test("retains exact historical bytes on the first in-place version update", async () => {
  const projectDir = createProject({
    "skills/history/SKILL.md": skillMarkdown("history", { version: "1.0.0" }),
    "skills/history/reference.md": "original reference bytes\n",
  });
  const publisherConfig = config({ outDir: "dist" });
  const outputDir = path.join(projectDir, "dist");
  await buildPublisherOutput({
    projectDir,
    config: publisherConfig,
    validation: await validated(projectDir, publisherConfig),
  });
  const oldEntry = readIndex(outputDir).skills[0];
  const oldBytes = readFileSync(artifactPath(outputDir, oldEntry));

  writeFileSync(
    path.join(projectDir, "skills/history/SKILL.md"),
    skillMarkdown("history", { version: "2.0.0", body: "# Updated instructions\n" }),
  );
  await buildPublisherOutput({
    projectDir,
    config: publisherConfig,
    validation: await validated(projectDir, publisherConfig),
    priorOutputDir: outputDir,
  });

  const currentEntry = readIndex(outputDir).skills[0];
  assert.deepEqual(
    versionHistory(currentEntry).releases.map(({ version }) => version),
    ["2.0.0", "1.0.0"],
  );
  assert.notEqual(currentEntry.digest, oldEntry.digest);
  assert.deepEqual(
    readFileSync(artifactPath(outputDir, findRelease(currentEntry, "1.0.0"))),
    oldBytes,
  );
});

test("rejects strict-SemVer failures and immutable version remaps without replacing output", async () => {
  const invalidProject = createProject({
    "skills/invalid/SKILL.md": skillMarkdown("invalid", { version: "01.0.0" }),
    "dist/sentinel.txt": "previous generation\n",
  });
  const invalidConfig = config();
  await assert.rejects(
    buildPublisherOutput({
      projectDir: invalidProject,
      config: invalidConfig,
      validation: await validated(invalidProject, invalidConfig),
    }),
    (error) => {
      assert.ok(error instanceof PublisherBuildError);
      assert.equal(error.code, "configuration_invalid");
      assert.deepEqual(error.context, { field: "skills[invalid].metadata.version" });
      return true;
    },
  );
  assert.deepEqual(walkBytes(path.join(invalidProject, "dist")), [
    ["sentinel.txt", Buffer.from("previous generation\n")],
  ]);

  const projectDir = createProject({
    "skills/history/SKILL.md": skillMarkdown("history", { version: "1.4.7" }),
  });
  const firstConfig = config({ outDir: "first" });
  await buildPublisherOutput({
    projectDir,
    config: firstConfig,
    validation: await validated(projectDir, firstConfig),
  });
  writeFileSync(
    path.join(projectDir, "skills/history/SKILL.md"),
    skillMarkdown("history", { version: "1.4.7", body: "# Remapped\n" }),
  );
  const candidateConfig = config({ outDir: "candidate" });
  mkdirSync(path.join(projectDir, "candidate"));
  writeFileSync(path.join(projectDir, "candidate", "sentinel.txt"), "previous generation\n");
  await assert.rejects(
    buildPublisherOutput({
      projectDir,
      config: candidateConfig,
      validation: await validated(projectDir, candidateConfig),
      priorOutputDir: path.join(projectDir, "first"),
    }),
    (error) => {
      assert.ok(error instanceof PublisherBuildError);
      assert.equal(error.code, "configuration_invalid");
      assert.deepEqual(error.context, { field: "skills[history].metadata.version" });
      return true;
    },
  );
  assert.deepEqual(walkBytes(path.join(projectDir, "candidate")), [
    ["sentinel.txt", Buffer.from("previous generation\n")],
  ]);
});

test("rejects a tampered prior artifact and history beyond 100 instead of truncating", async () => {
  const projectDir = createProject({
    "skills/history/SKILL.md": skillMarkdown("history", { version: "1.0.0" }),
  });
  const priorConfig = config({ outDir: "prior" });
  await buildPublisherOutput({
    projectDir,
    config: priorConfig,
    validation: await validated(projectDir, priorConfig),
  });
  const priorOutput = path.join(projectDir, "prior");
  const priorEntry = readIndex(priorOutput).skills[0];
  writeFileSync(artifactPath(priorOutput, priorEntry), "tampered\n");
  writeFileSync(
    path.join(projectDir, "skills/history/SKILL.md"),
    skillMarkdown("history", { version: "2.0.0" }),
  );
  const nextConfig = config({ outDir: "next" });
  await assert.rejects(
    buildPublisherOutput({
      projectDir,
      config: nextConfig,
      validation: await validated(projectDir, nextConfig),
      priorOutputDir: priorOutput,
    }),
    (error) => error instanceof PublisherBuildError && error.code === "configuration_invalid",
  );

  const freshConfig = config({ outDir: "fresh" });
  await buildPublisherOutput({
    projectDir,
    config: freshConfig,
    validation: await validated(projectDir, freshConfig),
  });
  const freshOutput = path.join(projectDir, "fresh");
  const freshIndex = readIndex(freshOutput);
  const freshExtension = versionHistory(freshIndex.skills[0]);
  const release = firstRelease(freshIndex.skills[0]);
  freshExtension.version = "1.0.0+build.0";
  freshExtension.releases = Array.from({ length: 100 }, (_, index) => ({
    version: `1.0.0+build.${index}`,
    type: release.type,
    url: release.url,
    digest: release.digest,
  })).sort((left, right) => (left.version < right.version ? -1 : 1));
  writeFileSync(
    path.join(freshOutput, ".well-known", "agent-skills", "index.json"),
    `${JSON.stringify(freshIndex, null, 2)}\n`,
  );
  await assert.rejects(
    buildPublisherOutput({
      projectDir,
      config: nextConfig,
      validation: await validated(projectDir, nextConfig),
      priorOutputDir: freshOutput,
    }),
    (error) => {
      assert.ok(error instanceof PublisherBuildError);
      assert.equal(error.code, "limit_exceeded");
      assert.deepEqual(error.context, { skill_name: "history", limit: 100 });
      return true;
    },
  );
});

test("prior output must remain beneath the canonical project without symlink ancestors", async (context) => {
  if (process.platform === "win32") context.skip("symlink setup requires Windows privileges");
  const projectDir = createProject({
    "skills/current/SKILL.md": skillMarkdown("current", { version: "2.0.0" }),
  });
  const outside = createProject({
    "skills/current/SKILL.md": skillMarkdown("current", { version: "1.0.0" }),
  });
  const priorConfig = config({ outDir: "prior" });
  await buildPublisherOutput({
    projectDir: outside,
    config: priorConfig,
    validation: await validated(outside, priorConfig),
  });
  const targetBefore = walkBytes(path.join(outside, "prior"));
  symlinkSync(outside, path.join(projectDir, "prior-link"), "dir");
  const nextConfig = config({ outDir: "next" });

  await assert.rejects(
    buildPublisherOutput({
      projectDir,
      config: nextConfig,
      validation: await validated(projectDir, nextConfig),
      priorOutputDir: path.join(projectDir, "prior-link", "prior"),
    }),
    (error) => error instanceof PublisherBuildError && error.code === "configuration_invalid",
  );
  assert.deepEqual(walkBytes(path.join(outside, "prior")), targetBefore);
});

test("prior output outside the canonical project is rejected with a sanitized error", async () => {
  const projectDir = createProject({
    "skills/current/SKILL.md": skillMarkdown("current", { version: "2.0.0" }),
  });
  const canary = "outside-prior-credential-canary";
  const outside = createProject({
    "skills/current/SKILL.md": skillMarkdown("current", { version: "1.0.0" }),
  });
  const priorConfig = config({ outDir: canary });
  await buildPublisherOutput({
    projectDir: outside,
    config: priorConfig,
    validation: await validated(outside, priorConfig),
  });
  const outsidePrior = path.join(outside, canary);
  const nextConfig = config({ outDir: "next" });

  await assert.rejects(
    buildPublisherOutput({
      projectDir,
      config: nextConfig,
      validation: await validated(projectDir, nextConfig),
      priorOutputDir: outsidePrior,
    }),
    (error) => {
      assert.ok(error instanceof PublisherBuildError);
      assert.equal(error.code, "configuration_invalid");
      const rendered = JSON.stringify([error.message, error]);
      assert.equal(rendered.includes(outsidePrior), false);
      assert.equal(rendered.includes(canary), false);
      return true;
    },
  );
});

test("prior output parent ABA during initial artifact verification fails closed", async (context) => {
  if (
    posixMutationProbe(
      context,
      "requires POSIX ancestor ABA error classification during initial artifact verification",
    )
  )
    return;
  const projectDir = createProject({
    "skills/prior-aba/SKILL.md": skillMarkdown("prior-aba", { version: "1.0.0" }),
  });
  const priorConfig = config({ outDir: "history/prior" });
  await buildPublisherOutput({
    projectDir,
    config: priorConfig,
    validation: await validated(projectDir, priorConfig),
  });
  writeFileSync(
    path.join(projectDir, "skills/prior-aba/SKILL.md"),
    skillMarkdown("prior-aba", { version: "2.0.0" }),
  );
  const history = path.join(projectDir, "history");
  const held = path.join(projectDir, "history-held");
  const successor = path.join(projectDir, "history-successor");
  cpSync(history, successor, { recursive: true });
  const priorArtifacts = path.join(
    realpathSync(history),
    "prior",
    ".well-known",
    "agent-skills",
    "artifacts",
  );
  const originalOpen = fs.promises.open;
  let artifactOpens = 0;
  let injected = false;
  fs.promises.open = async (target, ...arguments_) => {
    if (String(target).startsWith(`${priorArtifacts}${path.sep}`)) {
      artifactOpens += 1;
      if (!injected && artifactOpens === 3) {
        injected = true;
        fs.renameSync(history, held);
        fs.renameSync(successor, history);
        try {
          return await originalOpen(target, ...arguments_);
        } finally {
          fs.renameSync(history, successor);
          fs.renameSync(held, history);
        }
      }
    }
    return originalOpen(target, ...arguments_);
  };
  syncBuiltinESMExports();
  const nextConfig = config({ outDir: "next" });
  try {
    await assert.rejects(
      buildPublisherOutput({
        projectDir,
        config: nextConfig,
        validation: await validated(projectDir, nextConfig),
        priorOutputDir: path.join(projectDir, "history", "prior"),
      }),
      (error) => error instanceof PublisherBuildError && error.code === "configuration_invalid",
    );
  } finally {
    fs.promises.open = originalOpen;
    syncBuiltinESMExports();
  }
  assert.equal(injected, true);
});

test("deferred prior artifact I/O failure after current publication prevents index commit", async () => {
  const projectDir = createProject({
    "skills/history/SKILL.md": skillMarkdown("history", { version: "1.0.0" }),
  });
  const priorConfig = config({ outDir: "prior" });
  await buildPublisherOutput({
    projectDir,
    config: priorConfig,
    validation: await validated(projectDir, priorConfig),
  });
  const priorOutput = path.join(projectDir, "prior");
  const priorEntry = readIndex(priorOutput).skills[0];
  const priorArtifact = artifactPath(priorOutput, priorEntry);
  const priorBefore = walkBytes(priorOutput);
  const successor = Buffer.from(skillMarkdown("history", { version: "2.0.0" }));
  writeFileSync(path.join(projectDir, "skills/history/SKILL.md"), successor);
  const nextConfig = config({ outDir: "next" });
  const nextOutput = path.join(projectDir, "next");
  const successorFilename = `sha256-${createHash("sha256").update(successor).digest("hex")}.md`;
  const successorArtifact = artifactPath(nextOutput, { url: `artifacts/${successorFilename}` });
  const build = async () =>
    buildPublisherOutput({
      projectDir,
      config: nextConfig,
      validation: await validated(projectDir, nextConfig),
      priorOutputDir: priorOutput,
    });
  const originalLink = fs.promises.link;
  const originalOpen = fs.promises.open;
  let currentArtifactPublished = false;
  let deferredReadReached = false;
  fs.promises.link = async (source, destination) => {
    await originalLink(source, destination);
    // This destination is published only after initial prior-output verification
    // and output preparation; preliminary artifact-open counts cannot arm the failure.
    if (String(destination) === successorArtifact) currentArtifactPublished = true;
  };
  fs.promises.open = async (target, ...arguments_) => {
    if (currentArtifactPublished && String(target) === priorArtifact) {
      deferredReadReached = true;
      throw Object.assign(new Error("injected deferred artifact I/O failure"), { code: "EIO" });
    }
    return originalOpen(target, ...arguments_);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(build(), isArchiveUnsafe);
  } finally {
    fs.promises.link = originalLink;
    fs.promises.open = originalOpen;
    syncBuiltinESMExports();
  }
  assert.equal(currentArtifactPublished, true);
  assert.equal(deferredReadReached, true);
  assert.deepEqual(readFileSync(successorArtifact), successor);
  assert.equal(
    existsSync(path.join(nextOutput, ".well-known", "agent-skills", "index.json")),
    false,
  );
  assert.deepEqual(walkBytes(priorOutput), priorBefore);

  await build();
  const retained = findRelease(readIndex(nextOutput).skills[0], "1.0.0");
  assert.deepEqual(readFileSync(artifactPath(nextOutput, retained)), readFileSync(priorArtifact));
});

test("rejects duplicate prior history and hard-linked prior artifacts", async () => {
  const duplicateProject = createProject({
    "skills/history/SKILL.md": skillMarkdown("history", { version: "1.0.0" }),
  });
  const priorConfig = config({ outDir: "prior" });
  await buildPublisherOutput({
    projectDir: duplicateProject,
    config: priorConfig,
    validation: await validated(duplicateProject, priorConfig),
  });
  const priorOutput = path.join(duplicateProject, "prior");
  const duplicateIndex = readIndex(priorOutput);
  const duplicateRelease = firstRelease(duplicateIndex.skills[0]);
  versionHistory(duplicateIndex.skills[0]).releases.push({ ...duplicateRelease });
  writeFileSync(
    path.join(priorOutput, ".well-known", "agent-skills", "index.json"),
    `${JSON.stringify(duplicateIndex, null, 2)}\n`,
  );
  writeFileSync(
    path.join(duplicateProject, "skills/history/SKILL.md"),
    skillMarkdown("history", { version: "2.0.0" }),
  );
  const nextConfig = config({ outDir: "next" });
  await assert.rejects(
    buildPublisherOutput({
      projectDir: duplicateProject,
      config: nextConfig,
      validation: await validated(duplicateProject, nextConfig),
      priorOutputDir: priorOutput,
    }),
    (error) => error instanceof PublisherBuildError && error.code === "configuration_invalid",
  );

  const linkedProject = createProject({
    "skills/history/SKILL.md": skillMarkdown("history", { version: "1.0.0" }),
  });
  await buildPublisherOutput({
    projectDir: linkedProject,
    config: priorConfig,
    validation: await validated(linkedProject, priorConfig),
  });
  const linkedPrior = path.join(linkedProject, "prior");
  const linkedEntry = readIndex(linkedPrior).skills[0];
  linkSync(artifactPath(linkedPrior, linkedEntry), path.join(linkedProject, "outside-hardlink"));
  writeFileSync(
    path.join(linkedProject, "skills/history/SKILL.md"),
    skillMarkdown("history", { version: "2.0.0" }),
  );
  await assert.rejects(
    buildPublisherOutput({
      projectDir: linkedProject,
      config: nextConfig,
      validation: await validated(linkedProject, nextConfig),
      priorOutputDir: linkedPrior,
    }),
    (error) => error instanceof PublisherBuildError && error.code === "configuration_invalid",
  );
});

test("rejects prior publisher JSON with noncanonical key ordering", async () => {
  const projectDir = createProject({
    "skills/history/SKILL.md": skillMarkdown("history", { version: "1.0.0" }),
  });
  const priorConfig = config({ outDir: "prior" });
  await buildPublisherOutput({
    projectDir,
    config: priorConfig,
    validation: await validated(projectDir, priorConfig),
  });
  const priorOutput = path.join(projectDir, "prior");
  const priorIndex = readIndex(priorOutput);
  const reordered = { skills: priorIndex.skills, $schema: priorIndex.$schema };
  writeFileSync(
    path.join(priorOutput, ".well-known", "agent-skills", "index.json"),
    `${JSON.stringify(reordered, null, 2)}\n`,
  );
  writeFileSync(
    path.join(projectDir, "skills/history/SKILL.md"),
    skillMarkdown("history", { version: "2.0.0" }),
  );
  const nextConfig = config({ outDir: "next" });
  await assert.rejects(
    buildPublisherOutput({
      projectDir,
      config: nextConfig,
      validation: await validated(projectDir, nextConfig),
      priorOutputDir: priorOutput,
    }),
    (error) => error instanceof PublisherBuildError && error.code === "configuration_invalid",
  );
});

test("rejects a digest-correct prior archive whose media structure is invalid", async () => {
  const projectDir = createProject({
    "skills/history/SKILL.md": skillMarkdown("history", { version: "1.0.0" }),
    "skills/history/resource.txt": "archive me\n",
  });
  const priorConfig = config({ outDir: "prior" });
  await buildPublisherOutput({
    projectDir,
    config: priorConfig,
    validation: await validated(projectDir, priorConfig),
  });
  const priorOutput = path.join(projectDir, "prior");
  const priorIndex = readIndex(priorOutput);
  const malformed = Buffer.from("not a tar-gzip archive\n");
  const digest = createHash("sha256").update(malformed).digest("hex");
  const descriptor = {
    type: "archive",
    url: `artifacts/sha256-${digest}.tar.gz`,
    digest: `sha256:${digest}`,
  };
  const oldArtifact = artifactPath(priorOutput, priorIndex.skills[0]);
  rmSync(oldArtifact);
  writeFileSync(path.join(path.dirname(oldArtifact), path.basename(descriptor.url)), malformed);
  Object.assign(priorIndex.skills[0], descriptor);
  Object.assign(firstRelease(priorIndex.skills[0]), descriptor);
  writeFileSync(
    path.join(priorOutput, ".well-known", "agent-skills", "index.json"),
    `${JSON.stringify(priorIndex, null, 2)}\n`,
  );
  writeFileSync(
    path.join(projectDir, "skills/history/SKILL.md"),
    skillMarkdown("history", { version: "2.0.0" }),
  );
  const nextConfig = config({ outDir: "next" });

  await assert.rejects(
    buildPublisherOutput({
      projectDir,
      config: nextConfig,
      validation: await validated(projectDir, nextConfig),
      priorOutputDir: priorOutput,
    }),
    (error) => error instanceof PublisherBuildError && error.code === "configuration_invalid",
  );
});

test("rejects a digest-correct prior ZIP whose central directory is invalid", async () => {
  const projectDir = createProject({
    "skills/history/SKILL.md": skillMarkdown("history", { version: "1.0.0" }),
    "skills/history/resource.txt": "archive me\n",
  });
  const priorConfig = config({ outDir: "prior", format: "zip" });
  await buildPublisherOutput({
    projectDir,
    config: priorConfig,
    validation: await validated(projectDir, priorConfig),
  });
  const priorOutput = path.join(projectDir, "prior");
  const priorIndex = readIndex(priorOutput);
  const malformed = Buffer.from("not a ZIP archive\n");
  const digest = createHash("sha256").update(malformed).digest("hex");
  const descriptor = {
    type: "archive",
    url: `artifacts/sha256-${digest}.zip`,
    digest: `sha256:${digest}`,
  };
  const oldArtifact = artifactPath(priorOutput, priorIndex.skills[0]);
  rmSync(oldArtifact);
  writeFileSync(path.join(path.dirname(oldArtifact), path.basename(descriptor.url)), malformed);
  Object.assign(priorIndex.skills[0], descriptor);
  Object.assign(firstRelease(priorIndex.skills[0]), descriptor);
  writeFileSync(
    path.join(priorOutput, ".well-known", "agent-skills", "index.json"),
    `${JSON.stringify(priorIndex, null, 2)}\n`,
  );
  writeFileSync(
    path.join(projectDir, "skills/history/SKILL.md"),
    skillMarkdown("history", { version: "2.0.0" }),
  );
  const nextConfig = config({ outDir: "next", format: "zip" });

  await assert.rejects(
    buildPublisherOutput({
      projectDir,
      config: nextConfig,
      validation: await validated(projectDir, nextConfig),
      priorOutputDir: priorOutput,
    }),
    (error) => error instanceof PublisherBuildError && error.code === "configuration_invalid",
  );
});

test("enforces archive and catalog limits before replacing an existing generation", async () => {
  const projectDir = createProject({
    "skills/limited/SKILL.md": skillMarkdown("limited"),
    "skills/limited/resource.txt": "compress me but remain above a tiny archive limit\n",
    "dist/sentinel.txt": "previous generation\n",
  });
  const archiveLimited = config({ limits: { archiveBytes: 1 } });
  await assert.rejects(
    buildPublisherOutput({
      projectDir,
      config: archiveLimited,
      validation: await validated(projectDir, archiveLimited),
    }),
    (error) => error instanceof PublisherBuildError && error.code === "limit_exceeded",
  );
  assert.deepEqual(walkBytes(path.join(projectDir, "dist")), [
    ["sentinel.txt", Buffer.from("previous generation\n")],
  ]);

  const catalogLimited = config({ limits: { catalogBytes: 1 } });
  await assert.rejects(
    buildPublisherOutput({
      projectDir,
      config: catalogLimited,
      validation: await validated(projectDir, catalogLimited),
    }),
    (error) => error instanceof PublisherBuildError && error.code === "limit_exceeded",
  );
  assert.deepEqual(walkBytes(path.join(projectDir, "dist")), [
    ["sentinel.txt", Buffer.from("previous generation\n")],
  ]);
});

test("rejects unsafe integer build limits before archive allocation", async () => {
  const projectDir = createProject({
    "skills/integers/SKILL.md": skillMarkdown("integers"),
  });
  const unsafeConfig = config({ limits: { archiveBytes: Number.MAX_SAFE_INTEGER + 1 } });

  await assert.rejects(
    buildPublisherOutput({
      projectDir,
      config: unsafeConfig,
      validation: await validated(projectDir, unsafeConfig),
    }),
    (error) => error instanceof PublisherBuildError && error.code === "configuration_invalid",
  );
  assert.equal(existsSync(path.join(projectDir, "dist")), false);
});

test("repeated replacement leaves no previous-generation or transaction siblings", async () => {
  const projectDir = createProject({
    "skills/repeated/SKILL.md": skillMarkdown("repeated"),
  });
  const publisherConfig = config();
  for (let generation = 0; generation < 3; generation += 1) {
    writeFileSync(
      path.join(projectDir, "skills/repeated/SKILL.md"),
      skillMarkdown("repeated", { body: `# Generation ${generation}\n` }),
    );
    await buildPublisherOutput({
      projectDir,
      config: publisherConfig,
      validation: await validated(projectDir, publisherConfig),
    });
  }

  assert.deepEqual(readdirSync(projectDir).sort(), ["dist", "skills"]);
});

test("rejects a symlink in the project-relative output ancestor chain", async (context) => {
  if (process.platform === "win32") context.skip("symlink setup requires Windows privileges");
  const projectDir = createProject({
    "skills/anchored/SKILL.md": skillMarkdown("anchored"),
  });
  const outside = createProject();
  symlinkSync(outside, path.join(projectDir, "redirect"), "dir");
  const publisherConfig = config({ outDir: "redirect/dist" });

  await assert.rejects(
    buildPublisherOutput({
      projectDir,
      config: publisherConfig,
      validation: await validated(projectDir, publisherConfig),
    }),
    (error) => error instanceof PublisherBuildError && error.code === "archive_unsafe",
  );
  assert.deepEqual(readdirSync(outside), []);
});

test("keeps the committed index continuously readable while publishing a successor", async () => {
  const projectDir = createProject({
    "skills/continuous/SKILL.md": skillMarkdown("continuous"),
  });
  const publisherConfig = config();
  await buildPublisherOutput({
    projectDir,
    config: publisherConfig,
    validation: await validated(projectDir, publisherConfig),
  });
  writeFileSync(
    path.join(projectDir, "skills/continuous/SKILL.md"),
    skillMarkdown("continuous", { body: "# Successor\n" }),
  );

  const outputDir = path.join(realpathSync(projectDir), "dist");
  const indexPath = path.join(outputDir, ".well-known", "agent-skills", "index.json");
  const originalRename = fs.promises.rename;
  let observedMissingIndex = false;
  let completeReaderSamples = 0;
  const sampleReader = () => {
    try {
      const catalog = parseCatalogIndex(readFileSync(indexPath, "utf8"));
      readFileSync(artifactPath(outputDir, catalog.skills[0]));
      completeReaderSamples += 1;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        observedMissingIndex = true;
      } else {
        throw error;
      }
    }
  };
  fs.promises.rename = async (source, destination) => {
    if (String(destination) === indexPath) sampleReader();
    const result = await originalRename(source, destination);
    if (String(destination) === indexPath) sampleReader();
    return result;
  };
  syncBuiltinESMExports();
  try {
    await buildPublisherOutput({
      projectDir,
      config: publisherConfig,
      validation: await validated(projectDir, publisherConfig),
    });
  } finally {
    fs.promises.rename = originalRename;
    syncBuiltinESMExports();
  }

  assert.equal(observedMissingIndex, false);
  assert.ok(completeReaderSamples >= 2);
  assert.equal(readIndex(outputDir).skills[0].name, "continuous");
});

test("empty legacy private transaction names do not wedge or authorize deletion", async () => {
  const projectDir = createProject({
    "skills/recovery/SKILL.md": skillMarkdown("recovery"),
  });
  const transaction = path.join(projectDir, ".dist.remote-skills-transaction-v1");
  const deletion = path.join(projectDir, ".dist.remote-skills-delete-v1");
  mkdirSync(transaction);
  mkdirSync(deletion);
  const publisherConfig = config();

  await buildPublisherOutput({
    projectDir,
    config: publisherConfig,
    validation: await validated(projectDir, publisherConfig),
  });

  assert.deepEqual(readdirSync(transaction), []);
  assert.deepEqual(readdirSync(deletion), []);
  assert.equal(readIndex(path.join(projectDir, "dist")).skills[0].name, "recovery");
});

test("failed index commit preserves the exact previous catalog and the next build recovers", async () => {
  const projectDir = createProject({
    "skills/rollback/SKILL.md": skillMarkdown("rollback"),
  });
  const publisherConfig = config();
  await buildPublisherOutput({
    projectDir,
    config: publisherConfig,
    validation: await validated(projectDir, publisherConfig),
  });
  const outputDir = path.join(projectDir, "dist");
  const indexPath = path.join(outputDir, ".well-known", "agent-skills", "index.json");
  const agentSkills = path.join(outputDir, ".well-known", "agent-skills");
  const previous = readFileSync(indexPath);
  writeFileSync(
    path.join(projectDir, "skills/rollback/SKILL.md"),
    skillMarkdown("rollback", { body: "# Next generation\n" }),
  );

  const originalRename = fs.promises.rename;
  let injected = false;
  fs.promises.rename = async (source, destination) => {
    if (
      !injected &&
      path.basename(String(destination)) === "index.json" &&
      source !== destination
    ) {
      injected = true;
      throw Object.assign(new Error("injected commit interruption"), { code: "EIO" });
    }
    return originalRename(source, destination);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      buildPublisherOutput({
        projectDir,
        config: publisherConfig,
        validation: await validated(projectDir, publisherConfig),
      }),
      (error) => error instanceof PublisherBuildError && error.code === "archive_unsafe",
    );
  } finally {
    fs.promises.rename = originalRename;
    syncBuiltinESMExports();
  }

  assert.equal(injected, true);
  assert.deepEqual(readFileSync(indexPath), previous);
  assert.equal(
    readdirSync(agentSkills).some((name) =>
      /^\.remote-skills-index-[0-9a-f-]{36}\.pending$/u.test(name),
    ),
    true,
  );
  await buildPublisherOutput({
    projectDir,
    config: publisherConfig,
    validation: await validated(projectDir, publisherConfig),
  });
  assert.equal(
    readdirSync(agentSkills).some((name) =>
      /^\.remote-skills-index-[0-9a-f-]{36}\.pending$/u.test(name),
    ),
    false,
  );
  assert.deepEqual(readdirSync(projectDir).sort(), ["dist", "skills"]);
});

for (const failure of ["write", "sync"] as const) {
  test(`artifact ${failure} interruption preserves the catalog and permits an exact retry`, async () => {
    const projectDir = createProject({
      "skills/retry/SKILL.md": skillMarkdown("retry"),
    });
    const publisherConfig = config();
    const build = async () =>
      buildPublisherOutput({
        projectDir,
        config: publisherConfig,
        validation: await validated(projectDir, publisherConfig),
      });
    await build();
    const outputDir = path.join(projectDir, "dist");
    const agentSkills = path.join(outputDir, ".well-known", "agent-skills");
    const indexPath = path.join(agentSkills, "index.json");
    const previous = readFileSync(indexPath);
    const oldArtifact = artifactPath(outputDir, readIndex(outputDir).skills[0]);
    const oldBytes = readFileSync(oldArtifact);
    const successor = Buffer.from(skillMarkdown("retry", { body: "# Complete successor\n" }));
    writeFileSync(path.join(projectDir, "skills/retry/SKILL.md"), successor);
    const originalOpen = fs.promises.open;
    let injected = false;
    fs.promises.open = async (target, flags, ...arguments_) => {
      const handle = await originalOpen(target, flags, ...arguments_);
      if (
        !injected &&
        String(target).startsWith(`${agentSkills}${path.sep}`) &&
        typeof flags === "number" &&
        (flags & fs.constants.O_CREAT) !== 0
      ) {
        injected = true;
        if (failure === "write") {
          await handle.write(successor.subarray(0, 8));
          handle.write = async () => {
            throw Object.assign(new Error("injected artifact write failure"), { code: "EIO" });
          };
        } else {
          handle.sync = async () => {
            throw Object.assign(new Error("injected artifact sync failure"), { code: "EIO" });
          };
        }
      }
      return handle;
    };
    syncBuiltinESMExports();
    try {
      await assert.rejects(build(), isArchiveUnsafe);
    } finally {
      fs.promises.open = originalOpen;
      syncBuiltinESMExports();
    }
    assert.equal(injected, true);
    assert.deepEqual(readFileSync(indexPath), previous);
    assert.deepEqual(readFileSync(oldArtifact), oldBytes);
    assert.deepEqual(readdirSync(path.join(agentSkills, "artifacts")), [
      path.basename(oldArtifact),
    ]);

    await build();
    const current = readIndex(outputDir).skills[0];
    assert.deepEqual(readFileSync(artifactPath(outputDir, current)), successor);
    assert.equal(current.digest, `sha256:${createHash("sha256").update(successor).digest("hex")}`);
    assert.deepEqual(readdirSync(agentSkills).sort(), ["artifacts", "index.json"]);
  });
}

test("recovers a validated crash-stranded index-<uuid> pending leaf", async () => {
  const projectDir = createProject({
    "skills/pending/SKILL.md": skillMarkdown("pending"),
  });
  const publisherConfig = config();
  await buildPublisherOutput({
    projectDir,
    config: publisherConfig,
    validation: await validated(projectDir, publisherConfig),
  });
  const agentSkills = path.join(realpathSync(projectDir), "dist", ".well-known", "agent-skills");
  const indexPending = path.join(
    agentSkills,
    ".remote-skills-index-00000000-0000-4000-8000-000000000001.pending",
  );
  writeFileSync(indexPending, "");
  writeFileSync(
    path.join(projectDir, "skills/pending/SKILL.md"),
    skillMarkdown("pending", { body: "# Recovered\n" }),
  );

  await buildPublisherOutput({
    projectDir,
    config: publisherConfig,
    validation: await validated(projectDir, publisherConfig),
  });

  assert.equal(existsSync(indexPending), false);
  assert.equal(readIndex(path.join(projectDir, "dist")).skills[0].name, "pending");
});

test("rejects a symlinked index-<uuid> pending leaf without touching its target", async (context) => {
  if (process.platform === "win32") context.skip("symlink setup requires Windows privileges");
  const projectDir = createProject({
    "skills/pending-link/SKILL.md": skillMarkdown("pending-link"),
  });
  const publisherConfig = config();
  await buildPublisherOutput({
    projectDir,
    config: publisherConfig,
    validation: await validated(projectDir, publisherConfig),
  });
  const target = path.join(projectDir, "do-not-touch.txt");
  writeFileSync(target, "preserve me\n");
  const pending = path.join(
    projectDir,
    "dist",
    ".well-known",
    "agent-skills",
    ".remote-skills-index-00000000-0000-4000-8000-000000000002.pending",
  );
  symlinkSync(target, pending);

  await assert.rejects(
    buildPublisherOutput({
      projectDir,
      config: publisherConfig,
      validation: await validated(projectDir, publisherConfig),
    }),
    (error) => error instanceof PublisherBuildError,
  );
  assert.equal(readFileSync(target, "utf8"), "preserve me\n");
  assert.equal(existsSync(pending), true);
});

test("rejects a hard-linked index-<uuid> pending leaf without touching its target", async () => {
  const projectDir = createProject({
    "skills/pending-hardlink/SKILL.md": skillMarkdown("pending-hardlink"),
  });
  const publisherConfig = config();
  await buildPublisherOutput({
    projectDir,
    config: publisherConfig,
    validation: await validated(projectDir, publisherConfig),
  });
  const target = path.join(projectDir, "do-not-touch.txt");
  writeFileSync(target, "preserve me\n");
  const pending = path.join(
    projectDir,
    "dist",
    ".well-known",
    "agent-skills",
    ".remote-skills-index-00000000-0000-4000-8000-000000000003.pending",
  );
  linkSync(target, pending);

  await assert.rejects(
    buildPublisherOutput({
      projectDir,
      config: publisherConfig,
      validation: await validated(projectDir, publisherConfig),
    }),
    isArchiveUnsafe,
  );
  assert.equal(readFileSync(target, "utf8"), "preserve me\n");
  assert.equal(existsSync(pending), true);
});

test("reuses an exact existing content-addressed artifact without overwrite", async () => {
  const projectDir = createProject({
    "skills/reuse/SKILL.md": skillMarkdown("reuse"),
  });
  const publisherConfig = config();
  await buildPublisherOutput({
    projectDir,
    config: publisherConfig,
    validation: await validated(projectDir, publisherConfig),
  });
  const outputDir = path.join(projectDir, "dist");
  const entry = readIndex(outputDir).skills[0];
  const artifact = artifactPath(outputDir, entry);
  const before = fs.lstatSync(artifact, { bigint: true });
  const originalRename = fs.promises.rename;
  let artifactOverwrite = false;
  fs.promises.rename = async (source, destination) => {
    if (path.basename(String(destination)) === path.basename(artifact)) artifactOverwrite = true;
    return originalRename(source, destination);
  };
  syncBuiltinESMExports();
  try {
    await buildPublisherOutput({
      projectDir,
      config: publisherConfig,
      validation: await validated(projectDir, publisherConfig),
    });
  } finally {
    fs.promises.rename = originalRename;
    syncBuiltinESMExports();
  }
  const after = fs.lstatSync(artifact, { bigint: true });
  assert.equal(artifactOverwrite, false);
  assert.equal(after.dev, before.dev);
  assert.equal(after.ino, before.ino);
});

test("rejects a wrong existing content-addressed artifact without changing its bytes", async () => {
  const projectDir = createProject({
    "skills/wrong-existing/SKILL.md": skillMarkdown("wrong-existing"),
  });
  const publisherConfig = config();
  await buildPublisherOutput({
    projectDir,
    config: publisherConfig,
    validation: await validated(projectDir, publisherConfig),
  });
  const outputDir = path.join(projectDir, "dist");
  const artifact = artifactPath(outputDir, readIndex(outputDir).skills[0]);
  const wrong = Buffer.from(readFileSync(artifact));
  wrong[0] = (wrong[0] ?? 0) ^ 1;
  writeFileSync(artifact, wrong);

  await assert.rejects(
    buildPublisherOutput({
      projectDir,
      config: publisherConfig,
      validation: await validated(projectDir, publisherConfig),
    }),
    isArchiveUnsafe,
  );
  assert.deepEqual(readFileSync(artifact), wrong);
});

test("final verification rejects an output ancestor ABA restored after redirected index commit", async () => {
  const projectDir = createProject({
    "skills/example-skill/SKILL.md": skillMarkdown("example-skill"),
  });
  const publisherConfig = config();
  await buildPublisherOutput({
    projectDir,
    config: publisherConfig,
    validation: await validated(projectDir, publisherConfig),
  });
  const agentSkills = path.join(realpathSync(projectDir), "dist", ".well-known", "agent-skills");
  const originalIndex = path.join(agentSkills, "index.json");
  const generationOneIndex = readFileSync(originalIndex);
  const held = path.join(projectDir, "held-agent-skills");
  const redirected = path.join(projectDir, "redirected-agent-skills");
  mkdirSync(redirected);
  writeFileSync(
    path.join(projectDir, "skills", "example-skill", "SKILL.md"),
    skillMarkdown("example-skill", { body: "# Successor\n" }),
  );
  const originalRename = fs.promises.rename;
  fs.promises.rename = async (source, destination) => {
    if (path.basename(String(destination)) === "index.json") {
      fs.renameSync(agentSkills, held);
      fs.renameSync(redirected, agentSkills);
      fs.renameSync(
        path.join(held, path.basename(String(source))),
        path.join(agentSkills, path.basename(String(source))),
      );
      try {
        await originalRename(source, destination);
      } finally {
        fs.renameSync(agentSkills, redirected);
        fs.renameSync(held, agentSkills);
      }
      return;
    }
    return originalRename(source, destination);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      buildPublisherOutput({
        projectDir,
        config: publisherConfig,
        validation: await validated(projectDir, publisherConfig),
      }),
      isArchiveUnsafe,
    );
  } finally {
    fs.promises.rename = originalRename;
    syncBuiltinESMExports();
  }
  assert.deepEqual(readFileSync(originalIndex), generationOneIndex);
});

test("final verification rejects same-length committed index tampering", async () => {
  const projectDir = createProject({
    "skills/index-tamper/SKILL.md": skillMarkdown("index-tamper"),
  });
  const publisherConfig = config();
  const agentSkills = path.join(realpathSync(projectDir), "dist", ".well-known", "agent-skills");
  const indexPath = path.join(agentSkills, "index.json");
  const originalRename = fs.promises.rename;
  const originalOpendir = fs.promises.opendir;
  let committed = false;
  let tampered = false;
  fs.promises.rename = async (source, destination) => {
    const result = await originalRename(source, destination);
    if (String(destination) === indexPath) committed = true;
    return result;
  };
  fs.promises.opendir = async (target, ...arguments_) => {
    if (!tampered && committed && String(target) === path.join(agentSkills, "artifacts")) {
      tampered = true;
      const bytes = readFileSync(indexPath);
      const offset = bytes.indexOf(Buffer.from("index-tamper", "utf8"));
      assert.ok(offset >= 0);
      bytes[offset] = (bytes[offset] ?? 0) ^ 1;
      writeFileSync(indexPath, bytes);
    }
    return originalOpendir(target, ...arguments_);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      buildPublisherOutput({
        projectDir,
        config: publisherConfig,
        validation: await validated(projectDir, publisherConfig),
      }),
      isArchiveUnsafe,
    );
  } finally {
    fs.promises.rename = originalRename;
    fs.promises.opendir = originalOpendir;
    syncBuiltinESMExports();
  }
  assert.equal(tampered, true);
});

test("final verification rejects same-length referenced artifact tampering", async () => {
  const projectDir = createProject({
    "skills/artifact-tamper/SKILL.md": skillMarkdown("artifact-tamper"),
  });
  const publisherConfig = config();
  const agentSkills = path.join(realpathSync(projectDir), "dist", ".well-known", "agent-skills");
  const indexPath = path.join(agentSkills, "index.json");
  const originalRename = fs.promises.rename;
  const originalOpendir = fs.promises.opendir;
  let committed = false;
  let tampered = false;
  fs.promises.rename = async (source, destination) => {
    const result = await originalRename(source, destination);
    if (String(destination) === indexPath) committed = true;
    return result;
  };
  fs.promises.opendir = async (target, ...arguments_) => {
    if (!tampered && committed && String(target) === path.join(agentSkills, "artifacts")) {
      tampered = true;
      const entry = parseCatalogIndex(readFileSync(indexPath, "utf8")).skills[0];
      const artifact = path.join(agentSkills, ...entry.url.split("/"));
      const bytes = readFileSync(artifact);
      bytes[0] = (bytes[0] ?? 0) ^ 1;
      writeFileSync(artifact, bytes);
    }
    return originalOpendir(target, ...arguments_);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      buildPublisherOutput({
        projectDir,
        config: publisherConfig,
        validation: await validated(projectDir, publisherConfig),
      }),
      isArchiveUnsafe,
    );
  } finally {
    fs.promises.rename = originalRename;
    fs.promises.opendir = originalOpendir;
    syncBuiltinESMExports();
  }
  assert.equal(tampered, true);
});

test("never removes an unrelated generation substituted after cleanup verification", async () => {
  const projectDir = createProject({
    "skills/substitution/SKILL.md": skillMarkdown("substitution"),
    "unrelated/do-not-touch.txt": "preserve me\n",
  });
  const publisherConfig = config();
  await buildPublisherOutput({
    projectDir,
    config: publisherConfig,
    validation: await validated(projectDir, publisherConfig),
  });
  writeFileSync(
    path.join(projectDir, "skills/substitution/SKILL.md"),
    skillMarkdown("substitution", { body: "# Successor\n" }),
  );

  const deletionPrevious = path.join(projectDir, ".dist.remote-skills-delete-v1", "previous");
  const stolen = path.join(projectDir, ".stolen-previous-generation");
  const unrelated = path.join(projectDir, "unrelated");
  const originalRm = fs.promises.rm;
  const originalRename = fs.promises.rename;
  let injected = false;
  fs.promises.rm = async (target, options) => {
    if (!injected && target === deletionPrevious) {
      injected = true;
      await originalRename(target, stolen);
      await originalRename(unrelated, target);
    }
    return originalRm(target, options);
  };
  syncBuiltinESMExports();
  try {
    await buildPublisherOutput({
      projectDir,
      config: publisherConfig,
      validation: await validated(projectDir, publisherConfig),
    });
  } finally {
    fs.promises.rm = originalRm;
    syncBuiltinESMExports();
  }

  assert.equal(readFileSync(path.join(unrelated, "do-not-touch.txt"), "utf8"), "preserve me\n");
});

test("publisher coordination waits while another process writes its pending record", async () => {
  const projectDir = createProject({
    "skills/parent/SKILL.md": skillMarkdown("parent"),
  });
  const ready = path.join(projectDir, "child.ready");
  const barrier = path.join(projectDir, "child.start");
  const { child, completion } = launchPublisherWorker(
    projectDir,
    "child",
    ready,
    barrier,
    "pause-writer-staging",
  );
  const originalOpen = fs.promises.open;
  let scheduledWrite = false;
  try {
    await waitForWorkerReady(ready, completion);
    writeFileSync(barrier, "go\n");
    await waitForWorkerReady(`${ready}.pending-created`, completion);
    assert.equal(existsSync(`${ready}.pending`), false, "readiness must hide incomplete payloads");
    writeFileSync(`${barrier}.signal`, "signal\n");
    await waitForWorkerReady(`${ready}.pending`, completion);
    const pending = readFileSync(`${ready}.pending`, "utf8");
    fs.promises.open = async (target, flags, ...arguments_) => {
      const handle = await originalOpen(target, flags, ...arguments_);
      if (String(target) !== pending) return handle;
      return new Proxy(handle, {
        get(selectedHandle, property) {
          if (property === "stat") {
            return async (options: { bigint: true }) => {
              const before = await selectedHandle.stat(options);
              assert.equal(before.size, 0n);
              writeFileSync(`${barrier}.write`, "write\n");
              await waitForWorkerReady(`${ready}.written`, completion);
              scheduledWrite = true;
              return before;
            };
          }
          if (property === "close") {
            return async () => {
              writeFileSync(`${barrier}.publish`, "publish\n");
              await selectedHandle.close();
            };
          }
          const value = Reflect.get(selectedHandle, property, selectedHandle);
          return typeof value === "function" ? value.bind(selectedHandle) : value;
        },
      });
    };
    syncBuiltinESMExports();
    const publisherConfig = config();
    await buildPublisherOutput({
      projectDir,
      config: publisherConfig,
      validation: await validated(projectDir, publisherConfig),
    });
    await boundedWorkerWait(completion);
    assert.equal(scheduledWrite, true);
    const outputDir = path.join(projectDir, "dist");
    const entry = readIndex(outputDir).skills[0];
    const bytes = readFileSync(artifactPath(outputDir, entry));
    assert.equal(`sha256:${createHash("sha256").update(bytes).digest("hex")}`, entry.digest);
    assert.ok(["parent", "child"].includes(entry.name));
  } finally {
    fs.promises.open = originalOpen;
    syncBuiltinESMExports();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await Promise.allSettled([completion]);
  }
});

test("two publisher processes serialize complete content-addressed publication", async () => {
  const projectDir = createProject();
  const barrier = path.join(projectDir, "start");
  const launches = ["parallel-one", "parallel-two"].map((name) => {
    const ready = path.join(projectDir, `${name}.ready`);
    return launchPublisherWorker(projectDir, name, ready, barrier);
  });
  const readiness = launches.map(({ ready, completion }) => waitForWorkerReady(ready, completion));
  try {
    await Promise.all(readiness);
    writeFileSync(barrier, "go\n");
    await boundedWorkerWait(Promise.all(launches.map(({ completion }) => completion)));
  } finally {
    for (const { child } of launches) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    await Promise.allSettled(launches.map(({ completion }) => completion));
    await Promise.allSettled(readiness);
  }

  const outputDir = path.join(projectDir, "dist");
  const entry = readIndex(outputDir).skills[0];
  const bytes = readFileSync(artifactPath(outputDir, entry));
  assert.equal(`sha256:${createHash("sha256").update(bytes).digest("hex")}`, entry.digest);
  assert.ok(["parallel-one", "parallel-two"].includes(entry.name));
});

test("publisher processes serialize behind a retained publication state", async () => {
  const projectDir = createProject();
  const outputDir = path.join(realpathSync(projectDir), "dist");
  const publisherConfig = config();
  const held = await prepareStableOutput(projectDir, publisherConfig.outDir, {
    catalogBytes: publisherConfig.limits.catalogBytes,
    archiveBytes: publisherConfig.limits.archiveBytes,
  });
  const ready = path.join(projectDir, "serialized.ready");
  const barrier = path.join(projectDir, "serialized.start");
  const { child, completion } = launchPublisherWorker(projectDir, "serialized", ready, barrier);
  let released = false;
  try {
    await waitForWorkerReady(ready, completion);
    writeFileSync(barrier, "go\n");
    const recordsController = new AbortController();
    const records = waitForWriterRecords(writerStateDir(outputDir), 4, recordsController.signal);
    try {
      await Promise.race([
        records,
        completion.then(() => {
          throw new Error("publisher worker exited before writer records");
        }),
      ]);
    } finally {
      recordsController.abort();
      await records.catch(() => undefined);
    }
    const pendingController = new AbortController();
    const pending = delay(50, "pending", { signal: pendingController.signal });
    try {
      assert.equal(await Promise.race([completion.then(() => "completed"), pending]), "pending");
    } finally {
      pendingController.abort();
      await pending.catch(() => undefined);
    }
    await releaseStableOutput(held);
    released = true;
    await boundedWorkerWait(completion);
  } finally {
    if (!released) await releaseStableOutput(held).catch(() => undefined);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await completion.catch(() => undefined);
  }

  const entry = readIndex(outputDir).skills[0];
  const bytes = readFileSync(artifactPath(outputDir, entry));
  assert.equal(entry.name, "serialized");
  assert.equal(`sha256:${createHash("sha256").update(bytes).digest("hex")}`, entry.digest);
});

test("bounds and reclaims immutable artifacts while retaining the prior index generation", async () => {
  const projectDir = createProject({
    "skills/bounded/SKILL.md": skillMarkdown("bounded", { body: "# Generation 0\n" }),
  });
  const publisherConfig = config();
  const artifactNames = [];
  for (let generation = 0; generation < 105; generation += 1) {
    writeFileSync(
      path.join(projectDir, "skills/bounded/SKILL.md"),
      skillMarkdown("bounded", { body: `# Generation ${generation}\n` }),
    );
    const before = existsSync(path.join(projectDir, "dist"))
      ? readIndex(path.join(projectDir, "dist")).skills[0]
      : undefined;
    await buildPublisherOutput({
      projectDir,
      config: publisherConfig,
      validation: await validated(projectDir, publisherConfig),
    });
    const outputDir = path.join(projectDir, "dist");
    const current = readIndex(outputDir).skills[0];
    artifactNames.push(path.basename(current.url));
    assert.equal(existsSync(artifactPath(outputDir, current)), true);
    if (before) assert.equal(existsSync(artifactPath(outputDir, before)), true);
    assert.ok(
      readdirSync(path.join(outputDir, ".well-known", "agent-skills", "artifacts")).length <= 2,
    );
  }
  assert.equal(new Set(artifactNames).size, 105);
});

test("rejects prior skill-md artifacts that exceed file or extracted byte bounds", async () => {
  const projectDir = createProject({
    "skills/direct/SKILL.md": skillMarkdown("direct", {
      version: "1.0.0",
      body: `# Large\n${"x".repeat(512)}\n`,
    }),
  });
  const priorConfig = config({ outDir: "prior" });
  await buildPublisherOutput({
    projectDir,
    config: priorConfig,
    validation: await validated(projectDir, priorConfig),
  });
  writeFileSync(
    path.join(projectDir, "skills/direct/SKILL.md"),
    skillMarkdown("direct", { version: "2.0.0" }),
  );
  for (const limit of ["fileBytes", "extractedBytes"]) {
    const nextConfig = config({ outDir: `next-${limit}`, limits: { [limit]: 256 } });
    await assert.rejects(
      buildPublisherOutput({
        projectDir,
        config: nextConfig,
        validation: await validated(projectDir, nextConfig),
        priorOutputDir: path.join(projectDir, "prior"),
      }),
      (error) => error instanceof PublisherBuildError && error.code === "limit_exceeded",
    );
  }
});

test("accepts a bounded previous catalog generation with more than 100 artifacts as prior", async () => {
  const names = Array.from({ length: 101 }, (_, index) => `generation-${index}`);
  const projectDir = createProject(
    Object.fromEntries(names.map((name) => [`skills/${name}/SKILL.md`, skillMarkdown(name)])),
  );
  const publisherConfig = config();
  const outputDir = path.join(projectDir, "dist");
  await buildPublisherOutput({
    projectDir,
    config: publisherConfig,
    validation: await validated(projectDir, publisherConfig),
  });
  const previous = readIndex(outputDir);
  for (const name of names.slice(1)) {
    rmSync(path.join(projectDir, "skills", name), { recursive: true });
  }
  writeFileSync(
    path.join(projectDir, "skills/generation-0/SKILL.md"),
    skillMarkdown("generation-0", { body: "# Next generation\n" }),
  );
  await buildPublisherOutput({
    projectDir,
    config: publisherConfig,
    validation: await validated(projectDir, publisherConfig),
  });
  const current = readIndex(outputDir);
  assert.equal(current.skills.length, 1);
  assert.equal(
    readdirSync(path.join(outputDir, ".well-known", "agent-skills", "artifacts")).length,
    102,
  );
  for (const entry of previous.skills) {
    assert.deepEqual(
      readFileSync(artifactPath(outputDir, entry)),
      Buffer.from(skillMarkdown(entry.name)),
    );
  }

  const indexBytes = readFileSync(
    path.join(outputDir, ".well-known", "agent-skills", "index.json"),
  );
  const smallerConfig = config({ outDir: "smaller", limits: { catalogBytes: indexBytes.length } });
  await assert.rejects(
    buildPublisherOutput({
      projectDir,
      config: smallerConfig,
      validation: await validated(projectDir, smallerConfig),
      priorOutputDir: outputDir,
    }),
    (error) =>
      error instanceof PublisherBuildError &&
      error.code === "configuration_invalid" &&
      error.message === "prior output contains unexpected filesystem entries",
  );
  assert.equal(existsSync(path.join(projectDir, "smaller")), false);

  const nextConfig = config({ outDir: "next" });
  await buildPublisherOutput({
    projectDir,
    config: nextConfig,
    validation: await validated(projectDir, nextConfig),
    priorOutputDir: outputDir,
  });
  const nextOutput = path.join(projectDir, "next");
  assert.deepEqual(readIndex(nextOutput), current);
  assert.deepEqual(
    readFileSync(artifactPath(nextOutput, current.skills[0])),
    readFileSync(artifactPath(outputDir, current.skills[0])),
  );
});

test("orphan cleanup rejects symlink and hard-link candidates without touching targets", async (context) => {
  if (process.platform === "win32") context.skip("symlink setup requires Windows privileges");
  for (const kind of ["symlink", "hard-link"]) {
    const projectDir = createProject({
      "skills/orphan-links/SKILL.md": skillMarkdown("orphan-links"),
    });
    const publisherConfig = config();
    await buildPublisherOutput({
      projectDir,
      config: publisherConfig,
      validation: await validated(projectDir, publisherConfig),
    });
    const targetBytes = Buffer.from(`preserve ${kind}\n`);
    const target = path.join(projectDir, "do-not-touch.txt");
    writeFileSync(target, targetBytes);
    const filename = `sha256-${createHash("sha256").update(targetBytes).digest("hex")}.md`;
    const candidate = path.join(
      projectDir,
      "dist",
      ".well-known",
      "agent-skills",
      "artifacts",
      filename,
    );
    if (kind === "symlink") symlinkSync(target, candidate);
    else fs.linkSync(target, candidate);
    writeFileSync(
      path.join(projectDir, "skills/orphan-links/SKILL.md"),
      skillMarkdown("orphan-links", { body: "# Successor\n" }),
    );
    await assert.rejects(
      buildPublisherOutput({
        projectDir,
        config: publisherConfig,
        validation: await validated(projectDir, publisherConfig),
      }),
      (error) => error instanceof PublisherBuildError,
    );
    assert.deepEqual(readFileSync(target), targetBytes);
    assert.equal(existsSync(candidate), true);
  }
});

test("orphan cleanup never unlinks a replacement moved into its unique quarantine", async () => {
  const projectDir = createProject({
    "skills/orphan-race/SKILL.md": skillMarkdown("orphan-race"),
  });
  const publisherConfig = config();
  await buildPublisherOutput({
    projectDir,
    config: publisherConfig,
    validation: await validated(projectDir, publisherConfig),
  });
  const outputDir = path.join(projectDir, "dist");
  const firstName = path.basename(readIndex(outputDir).skills[0].url);
  for (const body of ["# Second\n", "# Third\n"]) {
    writeFileSync(
      path.join(projectDir, "skills/orphan-race/SKILL.md"),
      skillMarkdown("orphan-race", { body }),
    );
    if (body === "# Second\n") {
      await buildPublisherOutput({
        projectDir,
        config: publisherConfig,
        validation: await validated(projectDir, publisherConfig),
      });
    }
  }

  const artifacts = path.join(outputDir, ".well-known", "agent-skills", "artifacts");
  const firstBytes = readFileSync(path.join(artifacts, firstName));
  const stolen = path.join(projectDir, "verified-orphan-preserved.md");
  const replacement = Buffer.from("unrelated replacement\n");
  const originalRename = fs.promises.rename;
  let injected = false;
  fs.promises.rename = async (source, destination) => {
    if (
      !injected &&
      path.basename(String(source)) === firstName &&
      path.basename(String(destination)).startsWith(".remote-skills-orphan-")
    ) {
      injected = true;
      await originalRename(source, stolen);
      writeFileSync(source, replacement);
    }
    return originalRename(source, destination);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      buildPublisherOutput({
        projectDir,
        config: publisherConfig,
        validation: await validated(projectDir, publisherConfig),
      }),
      (error) => error instanceof PublisherBuildError,
    );
  } finally {
    fs.promises.rename = originalRename;
    syncBuiltinESMExports();
  }
  assert.equal(injected, true);
  assert.deepEqual(readFileSync(stolen), firstBytes);
  const quarantine = readdirSync(artifacts).find((name) =>
    name.startsWith(`.remote-skills-orphan-${firstName}-`),
  );
  assert.ok(quarantine);
  assert.deepEqual(readFileSync(path.join(artifacts, quarantine)), replacement);
});

test("validates deterministic tar count, metadata, and padding independently", async () => {
  const projectDir = createProject({
    "skills/tar-check/SKILL.md": skillMarkdown("tar-check", { version: "1.0.0" }),
    "skills/tar-check/resource.txt": "resource\n",
  });
  const priorConfig = config({ outDir: "prior" });
  await buildPublisherOutput({
    projectDir,
    config: priorConfig,
    validation: await validated(projectDir, priorConfig),
  });
  writeFileSync(
    path.join(projectDir, "skills/tar-check/SKILL.md"),
    skillMarkdown("tar-check", { version: "2.0.0" }),
  );
  const exactConfig = config({ outDir: "exact", limits: { files: 2 } });
  await buildPublisherOutput({
    projectDir,
    config: exactConfig,
    validation: await validated(projectDir, exactConfig),
    priorOutputDir: path.join(projectDir, "prior"),
  });

  const priorOutput = path.join(projectDir, "prior");
  const index = readIndex(priorOutput);
  const raw = gunzipSync(readFileSync(artifactPath(priorOutput, index.skills[0])));
  const size = Number.parseInt(raw.subarray(124, 136).toString("ascii"), 8);
  const padding = 512 + size;
  assert.ok(padding < Math.ceil(padding / 512) * 512);
  raw[padding] = 1;
  const gzipOptions: ZlibOptions & { mtime: number } = { mtime: 0 };
  rewriteArtifactDescriptor(priorOutput, index, gzipSync(raw, gzipOptions));
  await assert.rejects(
    buildPublisherOutput({
      projectDir,
      config: config({ outDir: "tampered" }),
      validation: await validated(projectDir, config({ outDir: "tampered" })),
      priorOutputDir: priorOutput,
    }),
    (error) => error instanceof PublisherBuildError && error.code === "configuration_invalid",
  );
});

test("validates a normalized tar at the exact many-file expansion bounds", () => {
  const files = [
    { path: "SKILL.md", bytes: Buffer.from(skillMarkdown("many-files")) },
    ...Array.from({ length: 63 }, (_, index) => ({
      path: `resources/${String(index).padStart(2, "0")}.txt`,
      bytes: Buffer.from("x"),
    })),
  ];
  const bytes = encodeTarGzip(files);
  const firstFile = files[0];
  assert.ok(firstFile);
  const extractedBytes = files.reduce((total, file) => total + file.bytes.length, 0);
  assert.doesNotThrow(() =>
    validatePublishedArtifact(bytes, {
      type: "archive",
      url: `artifacts/sha256-${"a".repeat(64)}.tar.gz`,
      skillName: "many-files",
      limits: { files: files.length, fileBytes: firstFile.bytes.length, extractedBytes },
    }),
  );
});

test("rejects digest-correct ZIP local headers that disagree with central metadata", async () => {
  const projectDir = createProject({
    "skills/zip-check/SKILL.md": skillMarkdown("zip-check", { version: "1.0.0" }),
    "skills/zip-check/resource.txt": "resource\n",
  });
  const priorConfig = config({ outDir: "prior", format: "zip" });
  await buildPublisherOutput({
    projectDir,
    config: priorConfig,
    validation: await validated(projectDir, priorConfig),
  });
  const priorOutput = path.join(projectDir, "prior");
  const index = readIndex(priorOutput);
  const bytes = readFileSync(artifactPath(priorOutput, index.skills[0]));
  bytes.writeUInt32LE((bytes.readUInt32LE(14) ^ 1) >>> 0, 14);
  rewriteArtifactDescriptor(priorOutput, index, bytes);
  writeFileSync(
    path.join(projectDir, "skills/zip-check/SKILL.md"),
    skillMarkdown("zip-check", { version: "2.0.0" }),
  );
  const nextConfig = config({ outDir: "next", format: "zip" });
  await assert.rejects(
    buildPublisherOutput({
      projectDir,
      config: nextConfig,
      validation: await validated(projectDir, nextConfig),
      priorOutputDir: priorOutput,
    }),
    (error) => error instanceof PublisherBuildError && error.code === "configuration_invalid",
  );
});

test("rejects digest-correct ZIP central records with non-normalized metadata", async () => {
  const projectDir = createProject({
    "skills/zip-normalized/SKILL.md": skillMarkdown("zip-normalized", { version: "1.0.0" }),
    "skills/zip-normalized/resource.txt": "resource\n",
  });
  const priorConfig = config({ outDir: "prior", format: "zip" });
  await buildPublisherOutput({
    projectDir,
    config: priorConfig,
    validation: await validated(projectDir, priorConfig),
  });
  const priorOutput = path.join(projectDir, "prior");
  const index = readIndex(priorOutput);
  const bytes = readFileSync(artifactPath(priorOutput, index.skills[0]));
  const central = bytes.readUInt32LE(bytes.length - 22 + 16);
  bytes.writeUInt16LE(0, central + 4);
  rewriteArtifactDescriptor(priorOutput, index, bytes);
  writeFileSync(
    path.join(projectDir, "skills/zip-normalized/SKILL.md"),
    skillMarkdown("zip-normalized", { version: "2.0.0" }),
  );
  const nextConfig = config({ outDir: "next", format: "zip" });
  await assert.rejects(
    buildPublisherOutput({
      projectDir,
      config: nextConfig,
      validation: await validated(projectDir, nextConfig),
      priorOutputDir: priorOutput,
    }),
    (error) => error instanceof PublisherBuildError && error.code === "configuration_invalid",
  );
});

test("archive encoders enforce the output byte bound before final allocation", () => {
  const files = [{ path: "SKILL.md", bytes: Buffer.from("x".repeat(4096)) }];
  for (const encode of [encodeTarGzip, encodeZip]) {
    assert.throws(
      () => encode(files, 1),
      (error) => error instanceof PublisherBuildError && error.code === "limit_exceeded",
    );
  }
});

test("tar-gzip streams compressible input without allocating the full expanded archive", () => {
  const files = [{ path: "SKILL.md", bytes: Buffer.alloc(1024 * 1024, 0x61) }];
  const originalAlloc = Buffer.alloc;
  Buffer.alloc = (size, ...arguments_) => {
    if (size > 64 * 1024) throw new Error("expanded tar allocation");
    return originalAlloc(size, ...arguments_);
  };
  try {
    assert.throws(
      () => encodeTarGzip(files, 32),
      (error) => error instanceof PublisherBuildError && error.code === "limit_exceeded",
    );
  } finally {
    Buffer.alloc = originalAlloc;
  }
});

test("publishes complete artifact bytes without overwriting an existing immutable leaf", async () => {
  const projectDir = createProject({
    "skills/publication/SKILL.md": skillMarkdown("publication"),
  });
  const publisherConfig = config();
  const bytes = Buffer.from(skillMarkdown("publication"));
  const originalLink = fs.promises.link;
  let injected = false;
  fs.promises.link = async (source, destination) => {
    if (!injected && String(source).includes(".remote-skills-artifact-")) {
      injected = true;
      assert.deepEqual(readFileSync(source), bytes);
      assert.equal(existsSync(destination), false);
      // A completed same-content publication makes the second link return EEXIST.
      await originalLink(source, destination);
    }
    return originalLink(source, destination);
  };
  syncBuiltinESMExports();
  try {
    await buildPublisherOutput({
      projectDir,
      config: publisherConfig,
      validation: await validated(projectDir, publisherConfig),
    });
  } finally {
    fs.promises.link = originalLink;
    syncBuiltinESMExports();
  }
  assert.equal(injected, true);
  const outputDir = path.join(projectDir, "dist");
  const artifact = artifactPath(outputDir, readIndex(outputDir).skills[0]);
  assert.deepEqual(readFileSync(artifact), bytes);
  assert.equal(fs.lstatSync(artifact).nlink, 1);
});

test("recovers artifact staging after publication succeeds but staging removal fails", async () => {
  const projectDir = createProject({
    "skills/recover-link/SKILL.md": skillMarkdown("recover-link"),
  });
  const publisherConfig = config();
  const build = async () =>
    buildPublisherOutput({
      projectDir,
      config: publisherConfig,
      validation: await validated(projectDir, publisherConfig),
    });
  const originalUnlink = fs.promises.unlink;
  let pendingPath: string | undefined;
  fs.promises.unlink = async (target) => {
    if (String(target).includes(".remote-skills-artifact-") && !pendingPath) {
      pendingPath = String(target);
      throw Object.assign(new Error("injected staging removal failure"), { code: "EIO" });
    }
    return originalUnlink(target);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(build(), isArchiveUnsafe);
  } finally {
    fs.promises.unlink = originalUnlink;
    syncBuiltinESMExports();
  }
  assert.ok(pendingPath);
  assert.equal(fs.lstatSync(pendingPath).nlink, 2);
  const outputDir = path.join(projectDir, "dist");
  const agentSkills = path.join(outputDir, ".well-known", "agent-skills");
  assert.equal(existsSync(path.join(agentSkills, "index.json")), false);
  await build();
  assert.deepEqual(readdirSync(agentSkills).sort(), ["artifacts", "index.json"]);
  const artifact = artifactPath(outputDir, readIndex(outputDir).skills[0]);
  assert.deepEqual(readFileSync(artifact), Buffer.from(skillMarkdown("recover-link")));
  assert.equal(fs.lstatSync(artifact).nlink, 1);
});

test("an orphan quarantine pivot and ABA restoration fails closed", async () => {
  const projectDir = createProject({
    "skills/orphan-pivot/SKILL.md": skillMarkdown("orphan-pivot", {
      body: "# Generation 0\n",
    }),
  });
  const publisherConfig = config();
  await buildPublisherOutput({
    projectDir,
    config: publisherConfig,
    validation: await validated(projectDir, publisherConfig),
  });
  writeFileSync(
    path.join(projectDir, "skills/orphan-pivot/SKILL.md"),
    skillMarkdown("orphan-pivot", { body: "# Generation 1\n" }),
  );
  await buildPublisherOutput({
    projectDir,
    config: publisherConfig,
    validation: await validated(projectDir, publisherConfig),
  });
  writeFileSync(
    path.join(projectDir, "skills/orphan-pivot/SKILL.md"),
    skillMarkdown("orphan-pivot", { body: "# Generation 2\n" }),
  );

  const artifacts = path.join(
    realpathSync(projectDir),
    "dist",
    ".well-known",
    "agent-skills",
    "artifacts",
  );
  const held = path.join(projectDir, "held-orphan-artifacts");
  const redirected = path.join(projectDir, "redirected-orphan-artifacts");
  mkdirSync(redirected);
  const originalRename = fs.promises.rename;
  let injected = false;
  fs.promises.rename = async (source, destination) => {
    if (
      !injected &&
      /^sha256-[0-9a-f]{64}\.(?:md|tar\.gz|zip)$/u.test(path.basename(String(source))) &&
      path.basename(String(destination)).startsWith(".remote-skills-orphan-")
    ) {
      injected = true;
      fs.renameSync(artifacts, held);
      fs.renameSync(redirected, artifacts);
      fs.renameSync(
        path.join(held, path.basename(String(source))),
        path.join(artifacts, path.basename(String(source))),
      );
      try {
        await originalRename(source, destination);
      } finally {
        fs.renameSync(artifacts, redirected);
        fs.renameSync(held, artifacts);
      }
      return;
    }
    return originalRename(source, destination);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      buildPublisherOutput({
        projectDir,
        config: publisherConfig,
        validation: await validated(projectDir, publisherConfig),
      }),
      isArchiveUnsafe,
    );
  } finally {
    fs.promises.rename = originalRename;
    syncBuiltinESMExports();
  }
  assert.equal(injected, true);
});

test("writer recovery never renames or removes a replaceable fixed lock pathname", async () => {
  const projectDir = createProject({
    "skills/lock-recovery/SKILL.md": skillMarkdown("lock-recovery"),
  });
  const outputDir = path.join(projectDir, "dist");
  mkdirSync(outputDir);
  const legacy = path.join(outputDir, ".remote-skills-writer.lock");
  writeFileSync(legacy, "legacy fixed state\n");
  utimesSync(legacy, 0, 0);
  const publisherConfig = config();
  await assert.rejects(
    buildPublisherOutput({
      projectDir,
      config: publisherConfig,
      validation: await validated(projectDir, publisherConfig),
    }),
    (error) => error instanceof PublisherBuildError && error.code === "archive_unsafe",
  );
  assert.equal(readFileSync(legacy, "utf8"), "legacy fixed state\n");
});

test("writer records become visible only after their complete bytes are durable", async () => {
  const projectDir = createProject();
  const outputDir = path.join(realpathSync(projectDir), "dist");
  const coordination = writerStateDir(outputDir);
  const publisherConfig = config();
  const originalOpen = fs.promises.open;
  const visibleDuringWrite: boolean[] = [];

  fs.promises.open = async (target, flags, ...arguments_) => {
    const handle = await originalOpen(target, flags, ...arguments_);
    if (typeof flags !== "number" || (flags & fs.constants.O_CREAT) === 0) return handle;
    return new Proxy(handle, {
      get(selectedHandle, property) {
        if (property === "writeFile") {
          return async (
            bytes:
              | string
              | NodeJS.ArrayBufferView<ArrayBufferLike>
              | Iterable<string | NodeJS.ArrayBufferView<ArrayBufferLike>>
              | AsyncIterable<string | NodeJS.ArrayBufferView<ArrayBufferLike>>,
          ) => {
            const record: unknown = JSON.parse(String(bytes));
            assert.ok(isRecord(record));
            assert.equal(typeof record.schema, "string");
            assert.equal(typeof record.nonce, "string");
            assert.ok(record.ticket === undefined || typeof record.ticket === "number");
            const name =
              record.schema === "remote-skills-publisher-writer-intent-v1"
                ? `${record.nonce}.intent`
                : `${String(record.ticket).padStart(16, "0")}-${record.nonce}.ticket`;
            visibleDuringWrite.push(existsSync(path.join(coordination, name)));
            return selectedHandle.writeFile(bytes);
          };
        }
        const value = Reflect.get(selectedHandle, property, selectedHandle);
        return typeof value === "function" ? value.bind(selectedHandle) : value;
      },
    });
  };
  syncBuiltinESMExports();
  let held: Awaited<ReturnType<typeof prepareStableOutput>> | undefined;
  try {
    held = await prepareStableOutput(projectDir, publisherConfig.outDir, {
      catalogBytes: publisherConfig.limits.catalogBytes,
      archiveBytes: publisherConfig.limits.archiveBytes,
    });
  } finally {
    fs.promises.open = originalOpen;
    syncBuiltinESMExports();
    if (held) await releaseStableOutput(held);
  }

  assert.deepEqual(visibleDuringWrite, [false, false]);
});

test("writer record publication syncs its destination directory before returning", async () => {
  const projectDir = createProject();
  const outputDir = path.join(realpathSync(projectDir), "dist");
  const coordination = writerStateDir(outputDir);
  const publisherConfig = config();
  const originalOpen = fs.promises.open;
  const originalRename = fs.promises.rename;
  const events: string[] = [];
  let awaitingDirectorySync = false;

  fs.promises.rename = async (source, destination) => {
    const result = await originalRename(source, destination);
    if (
      path.dirname(String(destination)) === coordination &&
      /\.(?:intent|ticket)$/u.test(path.basename(String(destination)))
    ) {
      events.push(`rename:${path.extname(String(destination)).slice(1)}`);
      awaitingDirectorySync = true;
    }
    return result;
  };
  fs.promises.open = async (target, flags, ...arguments_) => {
    const handle = await originalOpen(target, flags, ...arguments_);
    if (String(target) !== coordination || flags !== "r") return handle;
    return new Proxy(handle, {
      get(selectedHandle, property) {
        if (property === "sync") {
          return async () => {
            if (awaitingDirectorySync) {
              events.push("sync:coordination");
              awaitingDirectorySync = false;
            }
            return selectedHandle.sync();
          };
        }
        const value = Reflect.get(selectedHandle, property, selectedHandle);
        return typeof value === "function" ? value.bind(selectedHandle) : value;
      },
    });
  };
  syncBuiltinESMExports();
  let held: Awaited<ReturnType<typeof prepareStableOutput>> | undefined;
  try {
    held = await prepareStableOutput(projectDir, publisherConfig.outDir, {
      catalogBytes: publisherConfig.limits.catalogBytes,
      archiveBytes: publisherConfig.limits.archiveBytes,
    });
  } finally {
    fs.promises.open = originalOpen;
    fs.promises.rename = originalRename;
    syncBuiltinESMExports();
    if (held) await releaseStableOutput(held);
  }

  assert.deepEqual(events, [
    "rename:intent",
    "sync:coordination",
    "rename:ticket",
    "sync:coordination",
  ]);
});

test("reclaims only a bounded stale writer staging generation", async () => {
  const projectDir = createProject({
    "skills/stale-stage/SKILL.md": skillMarkdown("stale-stage"),
  });
  const outputDir = path.join(realpathSync(projectDir), "dist");
  const staging = path.join(writerStateDir(outputDir), ".staging");
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  const pending = path.join(
    staging,
    ".record-99999999-00000000-0000-4000-8000-000000000005.pending",
  );
  writeFileSync(pending, "partially-written");
  utimesSync(pending, 0, 0);
  const publisherConfig = config();

  await buildPublisherOutput({
    projectDir,
    config: publisherConfig,
    validation: await validated(projectDir, publisherConfig),
  });

  assert.equal(existsSync(pending), false);
  assert.deepEqual(readdirSync(staging), []);
});

for (const fallback of [false, true]) {
  test(`closes initial ancestry ${fallback ? "fallback directory" : "file"} handles after an I/O failure`, async () => {
    const projectDir = createProject();
    const publisherConfig = config();
    const originalOpen = fs.promises.open;
    const originalOpendir = fs.promises.opendir;
    const acquired: Array<{ handle: { close(): Promise<void> }; closes: number }> = [];
    let injected = false;

    function track<Handle extends { close(): Promise<void> }>(handle: Handle): Handle {
      const entry = { handle, closes: 0 };
      acquired.push(entry);
      return new Proxy(handle, {
        get(selectedHandle, property) {
          if (property === "close") {
            return async () => {
              entry.closes += 1;
              return selectedHandle.close();
            };
          }
          const value = Reflect.get(selectedHandle, property, selectedHandle);
          return typeof value === "function" ? value.bind(selectedHandle) : value;
        },
      });
    }

    fs.promises.open = async (target, ...arguments_) => {
      if (String(target) === projectDir) {
        injected = true;
        throw Object.assign(new Error("injected ordinary I/O failure"), { code: "EIO" });
      }
      if (fallback) {
        throw Object.assign(new Error("directory requires opendir"), { code: "EISDIR" });
      }
      return track(await originalOpen(target, ...arguments_));
    };
    fs.promises.opendir = async (target, ...arguments_) =>
      track(await originalOpendir(target, ...arguments_));
    syncBuiltinESMExports();
    try {
      await assert.rejects(
        prepareStableOutput(projectDir, publisherConfig.outDir, publisherConfig.limits),
        isArchiveUnsafe,
      );
      assert.equal(injected, true);
      assert.ok(acquired.length > 0);
      assert.ok(acquired.every((entry) => entry.closes === 1));
    } finally {
      fs.promises.open = originalOpen;
      fs.promises.opendir = originalOpendir;
      syncBuiltinESMExports();
      for (const entry of acquired) {
        if (entry.closes === 0) await entry.handle.close();
      }
    }

    const output = await prepareStableOutput(
      projectDir,
      publisherConfig.outDir,
      publisherConfig.limits,
    );
    await releaseStableOutput(output);
  });
}

test("closes the writer coordination handle when staging cannot be bound", async () => {
  const projectDir = createProject();
  const outputDir = path.join(realpathSync(projectDir), "dist");
  const coordination = writerStateDir(outputDir);
  mkdirSync(coordination, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(coordination, ".staging"), "not a directory");
  const originalOpen = fs.promises.open;
  let coordinationClosed = false;

  fs.promises.open = async (target, ...arguments_) => {
    const handle = await originalOpen(target, ...arguments_);
    if (String(target) !== coordination) return handle;
    return new Proxy(handle, {
      get(selectedHandle, property) {
        if (property === "close") {
          return async () => {
            coordinationClosed = true;
            return selectedHandle.close();
          };
        }
        const value = Reflect.get(selectedHandle, property, selectedHandle);
        return typeof value === "function" ? value.bind(selectedHandle) : value;
      },
    });
  };
  syncBuiltinESMExports();
  try {
    const publisherConfig = config();
    await assert.rejects(
      prepareStableOutput(projectDir, publisherConfig.outDir, {
        catalogBytes: publisherConfig.limits.catalogBytes,
        archiveBytes: publisherConfig.limits.archiveBytes,
      }),
      isArchiveUnsafe,
    );
  } finally {
    fs.promises.open = originalOpen;
    syncBuiltinESMExports();
  }

  assert.equal(coordinationClosed, true);
});

test("writer scans tolerate a record released after it is opened", async () => {
  const projectDir = createProject({
    "skills/released-writer/SKILL.md": skillMarkdown("released-writer"),
  });
  const outputDir = path.join(realpathSync(projectDir), "dist");
  const coordination = writerStateDir(outputDir);
  mkdirSync(coordination, { recursive: true, mode: 0o700 });
  const nonce = "00000000-0000-4000-8000-000000000004";
  writeWriterFixture(coordination, nonce, 1, 99_999_999, 0);
  const released = path.join(coordination, `${nonce}.intent`);
  const originalOpen = fs.promises.open;
  let injected = false;

  fs.promises.open = async (target, ...arguments_) => {
    const handle = await originalOpen(target, ...arguments_);
    if (!injected && String(target) === released) {
      injected = true;
      fs.unlinkSync(released);
    }
    return handle;
  };
  syncBuiltinESMExports();
  try {
    const publisherConfig = config();
    await buildPublisherOutput({
      projectDir,
      config: publisherConfig,
      validation: await validated(projectDir, publisherConfig),
    });
  } finally {
    fs.promises.open = originalOpen;
    syncBuiltinESMExports();
  }

  assert.equal(injected, true);
});

test("writer scans reject a replacement installed after opening an old record", async () => {
  const projectDir = createProject({
    "skills/replaced-writer/SKILL.md": skillMarkdown("replaced-writer"),
  });
  const outputDir = path.join(realpathSync(projectDir), "dist");
  const coordination = writerStateDir(outputDir);
  mkdirSync(coordination, { recursive: true, mode: 0o700 });
  const nonce = "00000000-0000-4000-8000-000000000006";
  const ticket = path.join(coordination, `${String(1).padStart(16, "0")}-${nonce}.ticket`);
  const bytes = `${JSON.stringify({
    schema: "remote-skills-publisher-writer-ticket-v1",
    pid: process.pid,
    nonce,
    ticket: 1,
    created_at_ms: Date.now(),
  })}\n`;
  writeFileSync(ticket, bytes);
  const originalOpen = fs.promises.open;
  let opens = 0;
  let replaced = false;

  fs.promises.open = async (target, ...arguments_) => {
    const handle = await originalOpen(target, ...arguments_);
    if (String(target) === ticket && ++opens === 2) {
      fs.unlinkSync(ticket);
      writeFileSync(ticket, bytes);
      replaced = true;
    }
    return handle;
  };
  syncBuiltinESMExports();
  try {
    const publisherConfig = config();
    await assert.rejects(
      buildPublisherOutput({
        projectDir,
        config: publisherConfig,
        validation: await validated(projectDir, publisherConfig),
      }),
      isArchiveUnsafe,
    );
  } finally {
    fs.promises.open = originalOpen;
    syncBuiltinESMExports();
    rmSync(ticket, { force: true });
  }

  assert.equal(replaced, true);
});

test("dead unique writer records are reclaimed without touching a live successor record", async () => {
  const projectDir = createProject({
    "skills/record-recovery/SKILL.md": skillMarkdown("record-recovery"),
  });
  const outputDir = path.join(realpathSync(projectDir), "dist");
  const coordination = writerStateDir(outputDir);
  mkdirSync(coordination, { recursive: true, mode: 0o700 });
  const deadNonce = "00000000-0000-4000-8000-000000000001";
  const liveNonce = "00000000-0000-4000-8000-000000000002";
  const malformedNonce = "00000000-0000-4000-8000-000000000003";
  writeWriterFixture(coordination, deadNonce, 1, 99_999_999, 0);
  writeWriterFixture(coordination, liveNonce, 2, process.pid, Date.now());
  const malformedIntent = path.join(coordination, `${malformedNonce}.intent`);
  writeFileSync(malformedIntent, "");
  utimesSync(malformedIntent, 0, 0);
  const liveTicket = path.join(coordination, `${String(2).padStart(16, "0")}-${liveNonce}.ticket`);
  const publisherConfig = config();

  const build = buildPublisherOutput({
    projectDir,
    config: publisherConfig,
    validation: await validated(projectDir, publisherConfig),
  });
  const deadIntent = path.join(coordination, `${deadNonce}.intent`);
  const deadTicket = path.join(coordination, `${String(1).padStart(16, "0")}-${deadNonce}.ticket`);
  assert.equal(
    await Promise.race([
      build.then(() => "completed"),
      (async () => {
        const started = Date.now();
        while (existsSync(deadIntent) || existsSync(deadTicket) || existsSync(malformedIntent)) {
          if (Date.now() - started > 5_000) {
            assert.fail("timed out waiting for dead writer records to be reclaimed");
          }
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        return "reclaimed";
      })(),
    ]),
    "reclaimed",
  );
  assert.equal(existsSync(liveTicket), true);
  assert.equal(existsSync(deadIntent), false);
  assert.equal(existsSync(deadTicket), false);
  assert.equal(existsSync(malformedIntent), false);
  removeWriterFixture(coordination, liveNonce, 2);
  await build;
});

test("rejects a symlinked writer gate without reading or changing its target", async (context) => {
  if (process.platform === "win32") context.skip("symlink setup requires Windows privileges");
  const projectDir = createProject({
    "skills/lock-link/SKILL.md": skillMarkdown("lock-link"),
  });
  const outputDir = path.join(projectDir, "dist");
  mkdirSync(outputDir);
  const target = path.join(projectDir, "do-not-read-or-touch.txt");
  writeFileSync(target, "preserve me\n");
  symlinkSync(target, path.join(outputDir, ".remote-skills-writer.lock"));
  const publisherConfig = config();
  await assert.rejects(
    buildPublisherOutput({
      projectDir,
      config: publisherConfig,
      validation: await validated(projectDir, publisherConfig),
    }),
    (error) => error instanceof PublisherBuildError && error.code === "archive_unsafe",
  );
  assert.equal(readFileSync(target, "utf8"), "preserve me\n");
});

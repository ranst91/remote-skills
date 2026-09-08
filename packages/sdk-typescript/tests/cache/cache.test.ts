import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, type Stats } from "node:fs";
import {
  access,
  cp,
  type FileHandle,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { runCommand } from "../../../../tests/helpers/run-command.ts";
import { extractZip, verifyCachedExtraction } from "../../src/activation/archive.ts";
import { mediaTypeForPath } from "../../src/activation/media-types.ts";
import { normalizedArchivePath } from "../../src/activation/paths.ts";
import {
  CacheConfigurationError,
  CacheCorruptError,
  canonicalOriginIdentifier,
  DiskCache,
  type DiskCacheOptions,
  defaultCacheDirectory,
  type ExtractedContentsVerifier,
  MemoryCache,
  DiskCache as ReviewDiskCache,
  MemoryCache as ReviewMemoryCache,
  resolveCache,
  catalogAbsenceGeneration as reviewCatalogAbsenceGeneration,
  catalogMutationDigest as reviewCatalogMutationDigest,
  defaultCacheDirectory as reviewDefaultCacheDirectory,
  canonicalOriginIdentifier as reviewOriginId,
} from "../../src/cache/index.ts";
import type { CacheBackend, CachedObject, PublishObjectInput } from "../../src/cache/types.ts";
import { pinnedUnicodeCaseFold } from "../../src/cache/unicode-casefold.ts";
import {
  snapshotPublishObjectInput,
  validatePortablePaths,
  validatePortablePaths as validateReviewPaths,
} from "../../src/cache/validation.ts";

const cacheModulePath = fileURLToPath(new URL("../../src/cache/index.ts", import.meta.url));
const packageRoot = new URL("../../", import.meta.url);
const protocolRoot = new URL("../../../../tests/protocol/", import.meta.url);

interface CacheObjectGenerationGuard {
  digest: string;
  directories: readonly object[];
}

type TestObjectInput = Omit<
  PublishObjectInput,
  "accessedAt" | "files" | "mediaTypes" | "verifiedAt"
> & {
  accessedAt: string;
  files: Map<string, Uint8Array>;
  mediaTypes: Map<string, string>;
  verifiedAt: string;
};

interface CacheProtocolFixture {
  cases?: Array<{
    id: string;
    result: { digest?: string; object_retained?: boolean };
  }>;
  lease_expiry_seconds?: number;
  now?: string;
  origin_identifier?: { example_identifier: string; example_url: string };
  process_liveness?: Record<string, boolean>;
}

interface WriterMessage {
  digest?: string;
  leasePath?: string;
  nodeTimeOrigin?: number;
  processNonce?: string;
  type?: string;
}

function isWriterMessage(value: unknown): value is WriterMessage {
  if (typeof value !== "object" || value === null) return false;
  if ("type" in value && value.type !== undefined && typeof value.type !== "string") return false;
  if ("digest" in value && value.digest !== undefined && typeof value.digest !== "string")
    return false;
  if ("leasePath" in value && value.leasePath !== undefined && typeof value.leasePath !== "string")
    return false;
  if (
    "processNonce" in value &&
    value.processNonce !== undefined &&
    typeof value.processNonce !== "string"
  )
    return false;
  return !(
    "nodeTimeOrigin" in value &&
    value.nodeTimeOrigin !== undefined &&
    typeof value.nodeTimeOrigin !== "number"
  );
}

function isTimeOriginMessage(value: unknown): value is { timeOrigin: number } {
  return (
    typeof value === "object" &&
    value !== null &&
    "timeOrigin" in value &&
    typeof value.timeOrigin === "number"
  );
}

interface RaceWriter {
  child: ChildProcess;
  completion: Promise<void>;
  messages: WriterMessage[];
}

interface MultiprocessObservationEvidence {
  releasedAcknowledgements: number;
  criticalSectionAcknowledgements: number;
  publishedAcknowledgements: number;
  partialObservations: number;
  inFlightCompleteObservations: number;
  overlappingReadBlocked: boolean;
}

type VoidDeferred = { promise: Promise<void>; resolve(): void };
type CacheCleanup = ReturnType<DiskCache["cleanup"]>;
type CacheEviction = ReturnType<DiskCache["evict"]>;
type CacheLease = Awaited<ReturnType<DiskCache["acquireLease"]>>;
type CacheLeaseAcquisition = ReturnType<DiskCache["acquireLease"]>;
type CacheObjectRead = ReturnType<DiskCache["getObject"]>;
type CachePublication = ReturnType<DiskCache["publishObject"]>;

interface CacheInternals {
  ensureSafeDirectory(target: string): Promise<void>;
  isRegisteredProcessAlive(pid: number, processNonce: string, digest: string): Promise<boolean>;
  listObjectRows(scanBudget: object): Promise<unknown[]>;
  mutationTurnState(
    directory: string,
    own: object,
    ownPath: string,
  ): Promise<{ ready: boolean; contendedWithEviction: boolean }>;
  openObjectGenerationGuard(digest: string): Promise<CacheObjectGenerationGuard | undefined>;
  readObject(digest: string, touch: boolean): Promise<CachedObject | null>;
  readObjectUnlocked(
    digest: string,
    touch: boolean,
    scanBudget: object,
  ): Promise<CachedObject | null>;
  reclaimStaleMutationLock(path: string): Promise<void>;
  removeObject(digest: string, scanBudget: object): Promise<"missing" | "pinned" | "removed">;
  removeOwnRegistrationIfUnleased(
    digest: string,
    identity?: Stats,
    scanBudget?: object,
  ): Promise<void>;
  renameFile(source: string, destination: string): Promise<void>;
  renameReplacingFile(source: string, destination: string): Promise<void>;
  startProcessRegistrationHeartbeat(digest: string): Promise<unknown>;
  validateObjectGenerationGuard(guard: CacheObjectGenerationGuard): Promise<void>;
  withDigestLock<T>(
    digest: string,
    action: () => Promise<T>,
    scanBudget?: object,
    operation?: "acquire" | "evict" | "mutation",
    rejectMissingObjectAfterEvictionContention?: boolean,
    observedObjectGeneration?: CacheObjectGenerationGuard,
  ): Promise<T>;
  writeObjectMetadata(
    directory: string,
    metadata: { accessed_at?: string; [key: string]: unknown },
  ): Promise<void>;
  writeProcessRegistration(digest: string): Promise<Stats>;
}

function hasCacheInternals(value: object): value is CacheInternals {
  return (
    "withDigestLock" in value &&
    "readObject" in value &&
    "renameFile" in value &&
    "writeProcessRegistration" in value
  );
}

function cacheInternals(cache: ReviewDiskCache): CacheInternals {
  assert.ok(hasCacheInternals(cache));
  return cache;
}

async function readProtocolJson(path: string): Promise<CacheProtocolFixture> {
  const raw = parseJsonRecord(await readFile(new URL(path, protocolRoot), "utf8"));
  const rawCases = raw.cases;
  const originIdentifier = raw.origin_identifier;
  const processLiveness = raw.process_liveness;
  return {
    ...(rawCases === undefined
      ? {}
      : {
          cases: requiredRecords(rawCases, "cache protocol cases").map((entry, index) => {
            const result = requiredRecord(entry.result, `cache protocol cases[${index}].result`);
            return {
              id: requiredString(entry, "id"),
              result: {
                ...(result.digest === undefined
                  ? {}
                  : { digest: requiredString(result, "digest") }),
                ...(result.object_retained === undefined
                  ? {}
                  : { object_retained: requiredBoolean(result, "object_retained") }),
              },
            };
          }),
        }),
    ...(raw.lease_expiry_seconds === undefined
      ? {}
      : { lease_expiry_seconds: requiredNumber(raw, "lease_expiry_seconds") }),
    ...(raw.now === undefined ? {} : { now: requiredString(raw, "now") }),
    ...(originIdentifier === undefined
      ? {}
      : {
          origin_identifier: {
            example_identifier: requiredString(
              requiredRecord(originIdentifier, "origin identifier"),
              "example_identifier",
            ),
            example_url: requiredString(
              requiredRecord(originIdentifier, "origin identifier"),
              "example_url",
            ),
          },
        }),
    ...(processLiveness === undefined
      ? {}
      : {
          process_liveness: Object.fromEntries(
            Object.entries(requiredRecord(processLiveness, "process liveness")).map(
              ([pid, value]) => {
                if (typeof value !== "boolean") {
                  throw new TypeError(`process liveness ${pid} must be a boolean`);
                }
                return [pid, value];
              },
            ),
          ),
        }),
  };
}

function hasErrnoCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && errorCode(error) === code;
}

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

function parseJsonRecord(text: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text);
  return requiredRecord(parsed, "JSON document");
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value) || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return Object.fromEntries(Object.entries(value));
}

function requiredRecords(value: unknown, label: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return value.map((entry, index) => requiredRecord(entry, `${label}[${index}]`));
}

function requiredNumber(record: Readonly<Record<string, unknown>>, field: string): number {
  const value = record[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${field} must be a finite number`);
  }
  return value;
}

function requiredBoolean(record: Readonly<Record<string, unknown>>, field: string): boolean {
  const value = record[field];
  if (typeof value !== "boolean") throw new TypeError(`${field} must be a boolean`);
  return value;
}

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new TypeError(`${label} is required`);
  return value;
}

function errorWithCode(message: string, code: string): Error {
  const error = new Error(message);
  Object.defineProperty(error, "code", { configurable: true, value: code });
  return error;
}

function errorMessage(value: unknown): string {
  assert.ok(value instanceof Error);
  return value.message;
}

function requiredString(record: Readonly<Record<string, unknown>>, field: string): string {
  const value = record[field];
  assert.equal(typeof value, "string");
  return typeof value === "string" ? value : "";
}

async function validFixtureObjectInput(): Promise<TestObjectInput> {
  const stateRoot = new URL("fixtures/cache/states/valid/cache-v1/", protocolRoot);
  const digest = "e4bb9c0cb022778c3e22703220eb387a5405b2025dad77b870291fc692c4e21d";
  const objectRoot = new URL(`objects/sha256/${digest.slice(0, 2)}/${digest.slice(2)}/`, stateRoot);
  const metadata = parseJsonRecord(await readFile(new URL("object.json", objectRoot), "utf8"));
  return {
    digest: requiredString(metadata, "digest"),
    artifactType: requiredString(metadata, "artifact_type"),
    archiveFormat:
      metadata.archive_format === null ? null : requiredString(metadata, "archive_format"),
    artifact: new Uint8Array(await readFile(new URL("artifact", objectRoot))),
    files: new Map([
      ["SKILL.md", new Uint8Array(await readFile(new URL("root/SKILL.md", objectRoot)))],
    ]),
    mediaTypes: new Map([["SKILL.md", "text/markdown"]]),
    verifiedAt: requiredString(metadata, "verified_at"),
    accessedAt: requiredString(metadata, "accessed_at"),
  };
}

function requiredSkillBytes(input: PublishObjectInput): Uint8Array {
  const bytes = input.files.get("SKILL.md");
  assert.ok(bytes);
  return bytes;
}

function deferred(): { promise: Promise<void>; resolve(): void };
function deferred<T>(): { promise: Promise<T>; resolve(value: T): void };
function deferred<T = void>() {
  let resolvePromise: (value: T) => void = () => {};
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value: T) {
      resolvePromise(value);
    },
  };
}

async function waitForSignal(
  signal: Promise<void>,
  label: string,
  timeoutMilliseconds = 1_000,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const received = await Promise.race([
      signal.then(() => true),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMilliseconds);
      }),
    ]);
    assert.equal(received, true, `timed out waiting for ${label}`);
  } finally {
    clearTimeout(timer);
  }
}

function observeChildCompletion(child: ChildProcess): Promise<number | null> {
  const completion = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  void completion.catch(() => undefined);
  return completion;
}

function mutationLockRecord({
  pid = 999_999,
  processNonce,
  ownerNonce,
  ticket = 1,
  createdAt = "2020-01-01T00:00:00.000Z",
  contendedWithEviction = false,
}: {
  pid?: number;
  processNonce: string;
  ownerNonce: string;
  ticket?: number;
  createdAt?: string;
  contendedWithEviction?: boolean;
}): string {
  return `${JSON.stringify(
    {
      schema: "remote-skills-cache-mutation-lock-v1",
      pid,
      process_nonce: processNonce,
      owner_nonce: ownerNonce,
      ticket,
      created_at: createdAt,
      operation: "mutation",
      ...(contendedWithEviction ? { contended_with_eviction: true } : {}),
    },
    null,
    2,
  )}\n`;
}

async function rewriteFileInPlace(path: string, contents: string | Uint8Array): Promise<void> {
  const original = await lstat(path);
  const handle = await open(path, "r+");
  try {
    await handle.truncate(0);
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
  const rewritten = await lstat(path);
  assert.equal(rewritten.dev, original.dev);
  assert.equal(rewritten.ino, original.ino);
}

async function startPausedStaleMutationLockCleanup(directoryPrefix: string, nonceSuffix: string) {
  const directory = await mkdtemp(join(tmpdir(), directoryPrefix));
  const input = await validFixtureObjectInput();
  const hex = input.digest.replace("sha256:", "");
  const lockDirectory = join(directory, "cache-v1", "tmp", "coordination-v1", "locks", hex);
  const lockPath = join(lockDirectory, `0000000000000001-stale-owner-${nonceSuffix}.lock`);
  const livenessEntered = deferred();
  const resumeLiveness = deferred();
  await mkdir(lockDirectory, { recursive: true });
  await writeFile(
    lockPath,
    mutationLockRecord({
      processNonce: `stale-process-${nonceSuffix}`,
      ownerNonce: `stale-owner-${nonceSuffix}`,
      contendedWithEviction: true,
    }),
  );
  const cache = new ReviewDiskCache({
    directory,
    now: () => new Date("2040-01-01T00:00:00.000Z"),
    leaseExpirySeconds: 1,
    isProcessAlive: async () => {
      livenessEntered.resolve();
      await resumeLiveness.promise;
      return false;
    },
    renewIntervalSeconds: 0,
  });
  const cleanup = cacheInternals(cache).reclaimStaleMutationLock(lockPath);
  await waitForSignal(livenessEntered.promise, `stale mutation-lock ${nonceSuffix} liveness`);
  return { cleanup, directory, lockDirectory, lockPath, resumeLiveness };
}

async function currentMutationLockPath(directory: string, digest: string): Promise<string> {
  const hex = digest.replace("sha256:", "");
  const lockDirectory = join(directory, "cache-v1", "tmp", "coordination-v1", "locks", hex);
  const name = (await readdir(lockDirectory)).find((entry) => entry.endsWith(".lock"));
  assert.ok(name, `expected a live mutation gate for ${digest}`);
  return join(lockDirectory, name);
}

async function linuxProcessStartIdentity(pid: number): Promise<string> {
  const value = await readFile(`/proc/${pid}/stat`, "utf8");
  const closingParenthesis = value.lastIndexOf(")");
  assert.ok(closingParenthesis >= 0);
  const fields = value
    .slice(closingParenthesis + 1)
    .trim()
    .split(/\s+/u);
  const startIdentity = fields[19];
  assert.ok(startIdentity);
  assert.match(startIdentity, /^\d+$/u);
  return `linux:${startIdentity}`;
}

function archiveInput(): TestObjectInput {
  const artifact = new TextEncoder().encode("verified archive bytes");
  return {
    digest: `sha256:${createHash("sha256").update(artifact).digest("hex")}`,
    artifactType: "archive",
    archiveFormat: "zip",
    artifact,
    files: new Map([
      ["SKILL.md", new TextEncoder().encode("# archived skill\n")],
      ["references/ä.txt", new TextEncoder().encode("reference\n")],
      ["references/z.txt", new TextEncoder().encode("zeta\n")],
    ]),
    mediaTypes: new Map([
      ["SKILL.md", "text/markdown"],
      ["references/ä.txt", "text/plain"],
      ["references/z.txt", "text/plain"],
    ]),
    verifiedAt: "2026-08-25T10:00:00.000Z",
    accessedAt: "2026-08-25T10:00:00.000Z",
  };
}

function skillInput(contents: string, timestamp = "2026-08-25T10:00:00.000Z"): TestObjectInput {
  const artifact = new TextEncoder().encode(contents);
  return {
    digest: `sha256:${createHash("sha256").update(artifact).digest("hex")}`,
    artifactType: "skill-md",
    archiveFormat: null,
    artifact,
    files: new Map([["SKILL.md", artifact]]),
    mediaTypes: new Map([["SKILL.md", "text/markdown"]]),
    verifiedAt: timestamp,
    accessedAt: timestamp,
  };
}

function immutableMap<Key, Value>(entries: ReadonlyMap<Key, Value>): ReadonlyMap<Key, Value> {
  const contents = new Map(entries);
  const view: ReadonlyMap<Key, Value> = {
    size: contents.size,
    get: (key) => contents.get(key),
    has: (key) => contents.has(key),
    entries: () => contents.entries(),
    keys: () => contents.keys(),
    values: () => contents.values(),
    [Symbol.iterator]: () => contents[Symbol.iterator](),
    forEach(callback, thisArg?: unknown) {
      contents.forEach((value, key) => {
        callback.call(thisArg, value, key, view);
      });
    },
  };
  return Object.freeze(view);
}

function startRaceWriter(args: readonly string[]): RaceWriter {
  const worker = fileURLToPath(new URL("helpers/race-writer.ts", import.meta.url));
  const child = spawn(process.execPath, [worker, ...args], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const messages: WriterMessage[] = [];
  child.on("message", (message) => {
    if (isWriterMessage(message)) messages.push(message);
  });
  const completion = new Promise<void>((resolve, reject) => {
    let stderr = "";
    assert.ok(child.stderr);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`race writer exited ${code}: ${stderr}`));
    });
  });
  return { child, completion, messages };
}

async function waitForWriterMessages(
  writer: Pick<RaceWriter, "messages">,
  type: string,
  count: number | undefined,
  timeoutMilliseconds = 5_000,
): Promise<void> {
  if (count === undefined || !Number.isSafeInteger(count) || count < 1) {
    throw new TypeError("writer message wait requires a positive message count");
  }
  const deadline = Date.now() + timeoutMilliseconds;
  while (writer.messages.filter((message) => message?.type === type).length < count) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for writer ${type} message`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("writer-message waits reject an omitted count instead of succeeding immediately", async () => {
  await assert.rejects(
    waitForWriterMessages({ messages: [] }, "released", undefined, 10),
    /positive message count/,
  );
});

function assertMultiprocessObservationEvidence({
  releasedAcknowledgements,
  criticalSectionAcknowledgements,
  publishedAcknowledgements,
  partialObservations,
  inFlightCompleteObservations,
  overlappingReadBlocked,
}: MultiprocessObservationEvidence): void {
  assert.equal(releasedAcknowledgements, 2, "released acknowledgment count");
  assert.ok(criticalSectionAcknowledgements > 0, "critical-section acknowledgment required");
  assert.equal(publishedAcknowledgements, 2, "published acknowledgment count");
  assert.equal(partialObservations, 0, "partial observation count");
  assert.ok(inFlightCompleteObservations > 0, "in-flight complete observation required");
  assert.equal(overlappingReadBlocked, true, "critical-section read must block");
}

test("multiprocess evidence controls reject missing release and in-flight observations", () => {
  const completeEvidence = {
    releasedAcknowledgements: 2,
    criticalSectionAcknowledgements: 1,
    publishedAcknowledgements: 2,
    partialObservations: 0,
    inFlightCompleteObservations: 1,
    overlappingReadBlocked: true,
  };
  assert.throws(
    () =>
      assertMultiprocessObservationEvidence({
        ...completeEvidence,
        releasedAcknowledgements: 0,
      }),
    /released acknowledgment count/,
  );
  assert.throws(
    () =>
      assertMultiprocessObservationEvidence({
        ...completeEvidence,
        inFlightCompleteObservations: 0,
      }),
    /in-flight complete observation required/,
  );
  assert.throws(
    () =>
      assertMultiprocessObservationEvidence({
        ...completeEvidence,
        overlappingReadBlocked: false,
      }),
    /critical-section read must block/,
  );
});

async function stopRaceWriters(
  writers: readonly { child: ChildProcess; completion: Promise<unknown> }[],
): Promise<void> {
  const completions = Promise.allSettled(writers.map(({ completion }) => completion));
  for (const { child } of writers) {
    if (child.exitCode === null) child.kill();
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped: boolean;
  try {
    stopped = await Promise.race([
      completions.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), 250);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  if (!stopped) {
    for (const { child } of writers) {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  }
  await completions;
}

async function waitForPath(
  path: string,
  timeoutMilliseconds = 1_000,
  completion?: Promise<unknown>,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  let completed = false;
  let completionError: unknown;
  void completion?.then(
    () => {
      completed = true;
    },
    (error: unknown) => {
      completed = true;
      completionError = error;
    },
  );
  for (;;) {
    if (completed) throw completionError ?? new Error("child exited before path readiness");
    try {
      await access(path);
      return;
    } catch (error) {
      if (!hasErrnoCode(error, "ENOENT")) throw error;
      if (Date.now() >= deadline)
        throw new Error(`timed out waiting for ${path.split(/[\\/]/u).at(-1)}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}

test("path readiness waits reject child completion and missing signals", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-readiness-"));
  try {
    const ready = join(directory, "absent");
    await assert.rejects(
      waitForPath(ready, 1_000, Promise.resolve(0)),
      /exited before path readiness/,
    );
    await assert.rejects(waitForPath(ready, 5), /timed out waiting/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function waitForJson(
  path: string,
  predicate: (value: Readonly<Record<string, unknown>>) => boolean,
  timeoutMilliseconds = 3_000,
): Promise<Readonly<Record<string, unknown>>> {
  const deadline = Date.now() + timeoutMilliseconds;
  let lastValue: Readonly<Record<string, unknown>> | undefined;
  for (;;) {
    try {
      const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
      if (!isRecord(parsed)) throw new TypeError("persisted JSON state must be an object");
      lastValue = parsed;
      if (predicate(lastValue)) return lastValue;
    } catch (error) {
      if (!hasErrnoCode(error, "ENOENT") && !(error instanceof SyntaxError)) throw error;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `timed out waiting for persisted JSON state at ${path}: ${JSON.stringify(lastValue)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function plantLeafAfterSafeDirectory(
  cache: ReviewDiskCache,
  matches: (target: string) => boolean,
  directoryForLeaf: (target: string) => string,
  leafName: string,
  sentinel: string,
): () => boolean {
  const ensureSafeDirectory = cacheInternals(cache).ensureSafeDirectory.bind(cache);
  let planted = false;
  cacheInternals(cache).ensureSafeDirectory = async (target) => {
    await ensureSafeDirectory(target);
    if (planted || !matches(target)) return;
    planted = true;
    await symlink(sentinel, join(directoryForLeaf(target), leafName));
  };
  return () => planted;
}

function reviewCacheBackends(
  directory: string,
  options: ConstructorParameters<typeof ReviewMemoryCache>[0] = {},
) {
  return [new ReviewMemoryCache(options), new ReviewDiskCache({ directory, ...options })];
}

function validCatalogMetadata() {
  return {
    retrievedAt: "2026-08-25T10:00:00.000Z",
    validatedAt: "2026-08-25T10:00:00.000Z",
  };
}

async function replaceStagedCatalogBody(directory: string, body: Uint8Array): Promise<void> {
  const temporaryRoot = join(directory, "cache-v1", "tmp");
  for (const entry of await readdir(temporaryRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("catalog-")) continue;
    const stagingDirectory = join(temporaryRoot, entry.name);
    const replacement = join(stagingDirectory, "body.replacement");
    await writeFile(replacement, body);
    await rename(replacement, join(stagingDirectory, "body.json"));
    return;
  }
  throw new Error("catalog staging directory was not found");
}

async function putCatalogWithUnknownMetadata(
  cache: Pick<CacheBackend, "putCatalog">,
  canonicalUrl: string,
  body: Uint8Array,
  metadata: unknown,
): Promise<void> {
  await Reflect.apply(cache.putCatalog, cache, [canonicalUrl, body, metadata]);
}

function resolveCacheFromUnknown(selection: unknown): unknown {
  return Reflect.apply(resolveCache, undefined, [selection]);
}

function publishObjectFromUnknown(
  cache: Pick<CacheBackend, "publishObject">,
  input: unknown,
): Promise<unknown> {
  return Reflect.apply(cache.publishObject, cache, [input]);
}

test("the TypeScript SDK exposes its cache implementation from the owned cache boundary", () => {
  assert.equal(existsSync(cacheModulePath), true);
});

test("common asset media types survive TypeScript and Python shared cache reuse in both directions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-media-types-"));
  const python = process.env.REMOTE_SKILLS_PYTHON ?? "python3";
  const pythonScript = `
import base64
import json
import sys
from datetime import datetime, timezone
from remote_skills.archive import extract_archive, verify_cached_archive
from remote_skills.cache import CachedObject, DiskCache
from test_activation import archive_with_files

mode, directory, digest, encoded = sys.argv[1:]
if mode == "archive":
    entries = [
        ("SKILL.md", b"---\\nname: asset-example\\ndescription: Shared assets.\\n---\\n"),
        ("assets/pixel.PNG", base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aG1kAAAAASUVORK5CYII=")),
        ("assets/guide.pdf", b"%PDF-1.4\\n1 0 obj <</Type /Catalog>> endobj\\n%%EOF\\n"),
        ("assets/index.html", b"<!doctype html><title>Example</title>"),
        ("assets/style.css", b"body { color: black; }"),
        ("assets/main.mjs", b"export const title = 'Example';"),
        ("assets/icon.svg", b'<svg xmlns="http://www.w3.org/2000/svg"/>'),
    ]
    print(json.dumps({"artifact": base64.b64encode(archive_with_files("zip", entries)).decode()}))
else:
    cache = DiskCache(directory, touch_on_read=False, archive_verifier=verify_cached_archive)
    if mode == "publish":
        artifact = base64.b64decode(encoded)
        files, media_types = extract_archive(artifact, "zip", extracted_bytes=4096, files=16, file_bytes=4096)
        now = datetime.now(timezone.utc)
        cache.publish_object(CachedObject(
            digest=digest, artifact_type="archive", archive_format="zip",
            artifact=artifact, files=files, media_types=media_types,
            verified_at=now, accessed_at=now,
        ))
    cached = cache.get_object(digest)
    assert cached is not None
    assert verify_cached_archive(cached)
    print(json.dumps({"mediaTypes": dict(cached.media_types), "artifact": base64.b64encode(cached.artifact).decode()}))
`;
  const invokePython = (mode: string, root: string, digest = "", artifact = "") => {
    const result = runCommand(python, ["-c", pythonScript, mode, root, digest, artifact], {
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        PYTHONPATH: fileURLToPath(new URL("../../../sdk-python/tests/", import.meta.url)),
      },
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    return parseJsonRecord(result.stdout);
  };
  try {
    const encoded = requiredString(invokePython("archive", directory), "artifact");
    const artifact = new Uint8Array(Buffer.from(encoded, "base64"));
    const digest = `sha256:${createHash("sha256").update(artifact).digest("hex")}`;
    const files = extractZip(artifact, {
      archiveBytes: artifact.length,
      extractedBytes: 4096,
      files: 16,
      fileBytes: 4096,
    });
    const expectedMediaTypes = {
      "SKILL.md": "text/markdown",
      "assets/pixel.PNG": "image/png",
      "assets/guide.pdf": "application/pdf",
      "assets/index.html": "text/html",
      "assets/style.css": "text/css",
      "assets/main.mjs": "text/javascript",
      "assets/icon.svg": "image/svg+xml",
    };
    const timestamp = new Date().toISOString();
    const typescriptRoot = join(directory, "typescript-writer");
    await new DiskCache({
      directory: typescriptRoot,
      verifyExtractedContents: verifyCachedExtraction,
    }).publishObject({
      digest,
      artifactType: "archive",
      archiveFormat: "zip",
      artifact,
      files,
      mediaTypes: new Map([...files.keys()].map((path) => [path, mediaTypeForPath(path)])),
      verifiedAt: timestamp,
      accessedAt: timestamp,
    });
    const pythonRead = invokePython("read", typescriptRoot, digest);
    assert.deepEqual(pythonRead.mediaTypes, expectedMediaTypes);
    assert.equal(pythonRead.artifact, encoded);

    const pythonRoot = join(directory, "python-writer");
    const pythonPublished = invokePython("publish", pythonRoot, digest, encoded);
    assert.deepEqual(pythonPublished.mediaTypes, expectedMediaTypes);
    const typescriptRead = await new DiskCache({
      directory: pythonRoot,
      verifyExtractedContents: verifyCachedExtraction,
    }).getObject(digest);
    assert.ok(typescriptRead);
    assert.equal(await verifyCachedExtraction(typescriptRead), true);
    assert.deepEqual(typescriptRead.artifact, artifact);
    assert.deepEqual(
      Object.fromEntries(typescriptRead.metadata.files.map((file) => [file.path, file.mediaType])),
      expectedMediaTypes,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the TypeScript package gate runs real typechecking and all package-local tests", async () => {
  const manifest = parseJsonRecord(await readFile(new URL("package.json", packageRoot), "utf8"));
  const scripts = requiredRecord(manifest.scripts, "package scripts");

  assert.match(requiredString(scripts, "typecheck"), /\btsc\b/u);
  const testScript = requiredString(scripts, "test");
  const runnerMatch = /(?:^|\s)(scripts\/[^\s"']+\.ts)(?:\s|$)/u.exec(testScript);
  const discoverySource =
    runnerMatch === null
      ? testScript
      : await readFile(new URL(runnerMatch[1] ?? "", packageRoot), "utf8");
  assert.match(discoverySource, /\.test\.ts/u);
  assert.match(discoverySource, /\*\*|recursive|readdir|opendir/u);
  assert.match(requiredString(scripts, "check"), /typecheck/u);
  assert.match(requiredString(scripts, "check"), /test/u);
  assert.doesNotMatch(JSON.stringify(scripts), /run-package-gate/u);
  await access(new URL("tsconfig.json", packageRoot));
});

test("origin identifiers consume the checked-in canonical URL contract", async () => {
  const layout = await readProtocolJson("contracts/v0/cache-layout.json");
  assert.ok(layout.origin_identifier);

  assert.equal(
    canonicalOriginIdentifier(layout.origin_identifier.example_url),
    layout.origin_identifier.example_identifier,
  );
});

test("verified objects publish once at the shared fixture path and remain immutable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-test-"));
  const input = await validFixtureObjectInput();
  const hex = input.digest.replace("sha256:", "");
  const expected = required(
    (await readProtocolJson("expected-results/cache-results.json")).cases,
    "cache expected cases",
  ).find(({ id }) => id === "cache-v1-valid");
  assert.ok(expected);

  try {
    const cache = new DiskCache({ directory });
    const published = await cache.publishObject(input);
    assert.equal(published.metadata.digest, required(expected.result.digest, "expected digest"));
    assert.deepEqual(published.artifact, input.artifact);
    assert.deepEqual(published.root.get("SKILL.md"), input.files.get("SKILL.md"));

    const objectDirectory = join(
      directory,
      "cache-v1",
      "objects",
      "sha256",
      hex.slice(0, 2),
      hex.slice(2),
    );
    const firstMetadata = await readFile(join(objectDirectory, "object.json"), "utf8");
    const losingWriter = await cache.publishObject({
      ...input,
      verifiedAt: "2026-08-25T11:00:00.000Z",
      accessedAt: "2026-08-25T11:00:00.000Z",
    });
    assert.equal(await readFile(join(objectDirectory, "object.json"), "utf8"), firstMetadata);
    assert.equal(losingWriter.metadata.verifiedAt, input.verifiedAt);
    assert.deepEqual(await readdir(join(directory, "cache-v1", "tmp")), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("digest mismatch and published corruption fail closed with cache_corrupt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-test-"));
  const input = await validFixtureObjectInput();
  const hex = input.digest.replace("sha256:", "");

  try {
    const cache = new DiskCache({ directory });
    await assert.rejects(
      cache.publishObject({ ...input, artifact: new TextEncoder().encode("tampered") }),
      (error) =>
        error instanceof CacheCorruptError &&
        errorCode(error) === "cache_corrupt" &&
        errorContext(error).expected_digest === input.digest,
    );
    assert.equal(await cache.getObject(input.digest), null);

    await cache.publishObject(input);
    const artifactPath = join(
      directory,
      "cache-v1",
      "objects",
      "sha256",
      hex.slice(0, 2),
      hex.slice(2),
      "artifact",
    );
    await writeFile(artifactPath, "tampered");
    await assert.rejects(
      cache.getObject(input.digest),
      (error) => error instanceof CacheCorruptError && errorCode(error) === "cache_corrupt",
    );

    await assert.rejects(
      cache.publishObject(input),
      (error) => errorCode(error) === "cache_corrupt",
    );
    await rename(artifactPath, `${artifactPath}.missing`);
    await assert.rejects(
      cache.getObject(input.digest),
      (error) => error instanceof CacheCorruptError && errorCode(error) === "cache_corrupt",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("same-length extracted-file tampering is detected against the verified skill-md artifact", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-test-"));
  const input = await validFixtureObjectInput();
  const hex = input.digest.replace("sha256:", "");

  try {
    const cache = new DiskCache({ directory });
    await cache.publishObject(input);
    const skillPath = join(
      directory,
      "cache-v1",
      "objects",
      "sha256",
      hex.slice(0, 2),
      hex.slice(2),
      "root",
      "SKILL.md",
    );
    const original = await readFile(skillPath);
    const tampered = new Uint8Array(original);
    const firstByte = tampered.at(0);
    assert.ok(firstByte !== undefined);
    tampered[0] = firstByte ^ 1;
    await writeFile(skillPath, tampered);

    await assert.rejects(
      cache.getObject(input.digest),
      (error) => error instanceof CacheCorruptError && errorCode(error) === "cache_corrupt",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("disk reuse advances accessed_at through the injected clock for LRU ordering", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-test-"));
  const input = await validFixtureObjectInput();
  let now = new Date("2026-08-25T10:01:00.000Z");

  try {
    const cache = new DiskCache({ directory, now: () => now });
    await cache.publishObject(input);
    now = new Date("2026-08-25T10:05:00.000Z");
    const reused = await cache.getObject(input.digest);
    assert.equal(reused?.metadata.accessedAt, now.toISOString());
    const hex = input.digest.replace("sha256:", "");
    const metadata = parseJsonRecord(
      await readFile(
        join(
          directory,
          "cache-v1",
          "objects",
          "sha256",
          hex.slice(0, 2),
          hex.slice(2),
          "object.json",
        ),
        "utf8",
      ),
    );
    assert.equal(metadata.accessed_at, now.toISOString());
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("concurrent access-time writers preserve the newest metadata update", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-test-"));
  const input = await validFixtureObjectInput();
  let now = new Date("2026-08-25T10:05:00.000Z");

  try {
    const cache = new DiskCache({ directory, now: () => now });
    await cache.publishObject(input);
    const writeMetadata = cacheInternals(cache).writeObjectMetadata.bind(cache);
    const newerMayWrite = deferred();
    const newerReady = deferred();
    cacheInternals(cache).writeObjectMetadata = async (objectDirectory, metadata) => {
      if (metadata.accessed_at === "2026-08-25T10:05:00.000Z") {
        newerReady.resolve();
        await newerMayWrite.promise;
        await writeMetadata(objectDirectory, metadata);
        return;
      }
      await writeMetadata(objectDirectory, metadata);
    };

    const newerRead = cache.getObject(input.digest);
    await newerReady.promise;
    now = new Date("2026-08-25T10:04:00.000Z");
    let olderSettled = false;
    const olderRead = cache.getObject(input.digest).finally(() => {
      olderSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(olderSettled, false, "the digest lock must serialize access-time updates");
    newerMayWrite.resolve();
    await Promise.all([newerRead, olderRead]);
    const hex = input.digest.replace("sha256:", "");
    const metadata = parseJsonRecord(
      await readFile(
        join(
          directory,
          "cache-v1",
          "objects",
          "sha256",
          hex.slice(0, 2),
          hex.slice(2),
          "object.json",
        ),
        "utf8",
      ),
    );
    assert.equal(metadata.accessed_at, "2026-08-25T10:05:00.000Z");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("access-time replacement retries Windows destination conflicts instead of dropping updates", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-test-"));
  const input = await validFixtureObjectInput();
  const cache = new DiskCache({
    directory,
    now: () => new Date("2026-08-25T10:05:00.000Z"),
  });

  try {
    await cache.publishObject(input);
    const renameFile = cacheInternals(cache).renameFile.bind(cache);
    let conflicts = 2;
    cacheInternals(cache).renameFile = async (source, destination) => {
      if (destination.endsWith("object.json") && conflicts > 0) {
        conflicts -= 1;
        throw errorWithCode("simulated Windows sharing violation", "EPERM");
      }
      await renameFile(source, destination);
    };

    await cache.getObject(input.digest);
    assert.equal(conflicts, 0);
    assert.equal(
      (await cache.getObject(input.digest))?.metadata.accessedAt,
      "2026-08-25T10:05:00.000Z",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("cache limits reject non-finite or negative configuration", async () => {
  for (const construct of [
    () => new DiskCache({ maxBytes: Number.POSITIVE_INFINITY }),
    () => new DiskCache({ leaseExpirySeconds: -1 }),
    () => new DiskCache({ pid: -1 }),
    () => new DiskCache({ processNonce: "../escape" }),
    () => new DiskCache({ maxArtifactBytes: Number.POSITIVE_INFINITY }),
    () => new MemoryCache({ maxExtractedBytes: -1 }),
    () => new MemoryCache({ maxExtractedFileBytes: Number.NaN }),
    () => new MemoryCache({ maxAgeSeconds: Number.NaN }),
  ]) {
    assert.throws(
      construct,
      (error) =>
        error instanceof CacheConfigurationError && errorCode(error) === "configuration_invalid",
    );
  }
});

test("cache timestamps require finite canonical UTC round trips", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-test-"));
  const input = await validFixtureObjectInput();

  try {
    const cache = new DiskCache({ directory });
    for (const invalidTimestamp of ["2026-02-30T10:00:00.000Z", "9999-99-99T99:99:99.999Z"]) {
      await assert.rejects(
        cache.publishObject({ ...input, verifiedAt: invalidTimestamp }),
        (error) => error instanceof CacheCorruptError && errorCode(error) === "cache_corrupt",
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("portable cache paths reject Windows drive prefixes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-test-"));
  const input = await validFixtureObjectInput();
  input.files = new Map([["C:/SKILL.md", requiredSkillBytes(input)]]);
  input.mediaTypes = new Map([["C:/SKILL.md", "text/markdown"]]);

  try {
    await assert.rejects(
      new DiskCache({ directory }).publishObject(input),
      (error) => error instanceof CacheCorruptError && errorCode(error) === "cache_corrupt",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("portable cache paths reject drive-relative, ADS, and device colon forms", async () => {
  const input = await validFixtureObjectInput();

  for (const path of ["C:SKILL.md", "references/file.txt:stream", "CON:device"]) {
    const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-test-"));
    try {
      await assert.rejects(
        new DiskCache({ directory, verifyExtractedContents: () => true }).publishObject({
          ...input,
          artifactType: "archive",
          archiveFormat: "tar.gz",
          files: new Map([[path, requiredSkillBytes(input)]]),
          mediaTypes: new Map([[path, "text/markdown"]]),
        }),
        (error) => error instanceof CacheCorruptError && errorCode(error) === "cache_corrupt",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("portable cache paths reject Windows device names and forbidden aliases consistently", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-windows-paths-"));
  const invalidPaths = [
    "CON",
    "references/name.",
    "references/file ",
    "references/AUX.txt",
    "references/COM1.skill",
    "references/COM¹.txt",
    "references/bad?.txt",
    "references/bad|name.txt",
  ];
  const validPaths = [
    "CONSOLE.md",
    "references/name.ok",
    "references/file-space.txt",
    "references/COM10.txt",
  ];
  const bytes = new TextEncoder().encode("portable content\n");
  try {
    for (const path of invalidPaths) {
      assert.throws(
        () => validateReviewPaths([path]),
        (error) => errorCode(error) === "cache_corrupt",
      );
      const input = archiveInput();
      input.files = new Map([[path, bytes]]);
      input.mediaTypes = new Map([[path, "text/plain"]]);
      for (const cache of reviewCacheBackends(directory, {
        verifyExtractedContents: () => true,
      })) {
        await assert.rejects(
          cache.publishObject(input),
          (error) => errorCode(error) === "cache_corrupt",
        );
      }
    }

    assert.deepEqual(
      validateReviewPaths(validPaths),
      validPaths.toSorted((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right))),
    );
    const valid = archiveInput();
    valid.files = new Map(validPaths.map((path) => [path, bytes]));
    valid.mediaTypes = new Map(validPaths.map((path) => [path, "text/plain"]));
    for (const cache of reviewCacheBackends(directory, {
      verifyExtractedContents: () => true,
    })) {
      assert.equal((await cache.publishObject(valid)).metadata.digest, valid.digest);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("OS defaults isolate cache-v1 beneath the standard per-user cache directory", async () => {
  assert.equal(
    defaultCacheDirectory({ platform: "darwin", home: "/Users/alice", env: {} }),
    "/Users/alice/Library/Caches/remote-skills",
  );
  assert.equal(
    defaultCacheDirectory({
      platform: "win32",
      home: "C:\\Users\\alice",
      env: { LOCALAPPDATA: "C:\\Users\\alice\\AppData\\Local" },
    }),
    "C:\\Users\\alice\\AppData\\Local\\remote-skills",
  );
  assert.equal(
    defaultCacheDirectory({
      platform: "linux",
      home: "/home/alice",
      env: { XDG_CACHE_HOME: "/cache/alice" },
    }),
    "/cache/alice/remote-skills",
  );
});

test("disk catalogs use cache-v1 metadata and exclude credentials and URL secrets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-test-"));
  const secret = "RMS_SYNTHETIC_SECRET_CANARY_8F0D2A7C";
  const canonicalUrl =
    "https://user:password@skills.example.test/.well-known/agent-skills/index.json?token=secret#fragment";
  const sanitizedUrl = "https://skills.example.test/.well-known/agent-skills/index.json";
  const body = new TextEncoder().encode('{"skills":[]}\n');

  try {
    const cache = new DiskCache({ directory });
    await putCatalogWithUnknownMetadata(cache, canonicalUrl, body, {
      etag: '"catalog-v1"',
      retrievedAt: "2026-08-25T10:00:00.000Z",
      validatedAt: "2026-08-25T10:00:00.000Z",
      headers: { Authorization: secret },
    });

    const originId = canonicalOriginIdentifier(sanitizedUrl);
    const metadataPath = join(directory, "cache-v1", "catalogs", originId, "metadata.json");
    const stored = await readFile(metadataPath, "utf8");
    assert.equal(stored.includes(secret), false);
    assert.deepEqual(parseJsonRecord(stored), {
      schema: "remote-skills-catalog-metadata-v1",
      canonical_url: sanitizedUrl,
      etag: '"catalog-v1"',
      retrieved_at: "2026-08-25T10:00:00.000Z",
      validated_at: "2026-08-25T10:00:00.000Z",
    });

    const cached = await cache.getCatalog(canonicalUrl);
    assert.deepEqual(cached?.body, body);
    assert.equal(cached?.metadata.canonicalUrl, sanitizedUrl);

    const forbiddenMetadata = parseJsonRecord(stored);
    forbiddenMetadata.authorization = secret;
    await writeFile(metadataPath, `${JSON.stringify(forbiddenMetadata, null, 2)}\n`);
    await assert.rejects(
      cache.getCatalog(canonicalUrl),
      (error) =>
        errorCode(error) === "cache_corrupt" && errorMessage(error).includes(secret) === false,
    );
    await writeFile(metadataPath, stored);
    await rename(metadataPath, `${metadataPath}.missing`);
    await assert.rejects(
      cache.getCatalog(canonicalUrl),
      (error) => errorCode(error) === "cache_corrupt" && stored.includes(secret) === false,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("disk and memory catalogs reject credential-bearing body URLs without retaining secrets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-body-credentials-"));
  const canonicalUrl = "https://skills.example.test/.well-known/agent-skills/index.json";
  const canary = "RMS_CATALOG_BODY_SECRET_CANARY_31D849E7";
  const credentialBearingBodies = [
    `https://user:${canary}@cdn.example/x?access_token=${canary}`,
    `https://cdn.example/x?client_secret=${canary}`,
    `https://cdn.example/x#access_token=${canary}`,
    `https://cdn.example/x#/route?access_token=${canary}?next=1`,
  ].map((url) =>
    new TextEncoder().encode(
      `${JSON.stringify({
        $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
        skills: [
          {
            name: "credential-test",
            description: "A credential exclusion regression.",
            type: "skill-md",
            url,
            digest: `sha256:${"a".repeat(64)}`,
          },
        ],
      })}\n`,
    ),
  );
  const safeLookalikeBody = new TextEncoder().encode(
    `${JSON.stringify({
      $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
      skills: [
        {
          name: "safe-lookalikes",
          description: "Documents access_token and user:secret@host examples as plain text.",
          type: "skill-md",
          url: "https://cdn.example/x?access_token_hint=public&tokenizer=v1#client_secret_hint=public",
          digest: `sha256:${"b".repeat(64)}`,
        },
      ],
    })}\n`,
  );

  try {
    for (const cache of reviewCacheBackends(directory)) {
      for (const credentialBearingBody of credentialBearingBodies) {
        await assert.rejects(
          cache.putCatalog(canonicalUrl, credentialBearingBody, validCatalogMetadata()),
          (error) => {
            assert.equal(errorCode(error), "cache_corrupt");
            assert.equal(errorMessage(error).includes(canary), false);
            assert.equal(JSON.stringify(errorContext(error)).includes(canary), false);
            return true;
          },
        );
      }
      assert.equal(await cache.getCatalog(canonicalUrl), null);
      await cache.putCatalog(canonicalUrl, safeLookalikeBody, validCatalogMetadata());
      assert.deepEqual((await cache.getCatalog(canonicalUrl))?.body, safeLookalikeBody);
    }
    const storedPaths = await readdir(directory, { recursive: true, encoding: "utf8" });
    for (const path of storedPaths) {
      assert.equal(path.includes(canary), false);
      const absolute = join(directory, path);
      const state = await lstat(absolute);
      if (state.isFile()) assert.equal((await readFile(absolute, "utf8")).includes(canary), false);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("catalog timestamps are validated before disk or memory cache mutation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-test-"));
  const canonicalUrl = "https://skills.example.test/.well-known/agent-skills/index.json";
  const body = new TextEncoder().encode('{"skills":[]}\n');
  const invalid = {
    retrievedAt: "2026-02-30T10:00:00.000Z",
    validatedAt: "2026-08-25T10:00:00.000Z",
  };

  try {
    const disk = new DiskCache({ directory });
    const memory = new MemoryCache();
    for (const cache of [disk, memory]) {
      await assert.rejects(
        cache.putCatalog(canonicalUrl, body, invalid),
        (error) => error instanceof CacheCorruptError && errorCode(error) === "cache_corrupt",
      );
      assert.equal(await cache.getCatalog(canonicalUrl), null);
    }
    await assert.rejects(
      access(join(directory, "cache-v1", "catalogs", canonicalOriginIdentifier(canonicalUrl))),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("disk catalog reads reject symlinked files without following them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-test-"));
  const canonicalUrl = "https://skills.example.test/.well-known/agent-skills/index.json";
  const body = new TextEncoder().encode('{"skills":[]}\n');

  try {
    const cache = new DiskCache({ directory });
    await cache.putCatalog(canonicalUrl, body, {
      retrievedAt: "2026-08-25T10:00:00.000Z",
      validatedAt: "2026-08-25T10:00:00.000Z",
    });
    const catalogDirectory = join(
      directory,
      "cache-v1",
      "catalogs",
      canonicalOriginIdentifier(canonicalUrl),
    );
    await rename(join(catalogDirectory, "body.json"), join(catalogDirectory, "outside.json"));
    await symlink("outside.json", join(catalogDirectory, "body.json"));

    await assert.rejects(
      cache.getCatalog(canonicalUrl),
      (error) => errorCode(error) === "cache_corrupt",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("disk object reads reject a symlinked root directory without following it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-test-"));
  const input = await validFixtureObjectInput();
  const hex = input.digest.replace("sha256:", "");

  try {
    const cache = new DiskCache({ directory });
    await cache.publishObject(input);
    const objectDirectory = join(
      directory,
      "cache-v1",
      "objects",
      "sha256",
      hex.slice(0, 2),
      hex.slice(2),
    );
    await rename(join(objectDirectory, "root"), join(objectDirectory, "outside-root"));
    await symlink("outside-root", join(objectDirectory, "root"));

    await assert.rejects(
      cache.getObject(input.digest),
      (error) => errorCode(error) === "cache_corrupt",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("object and catalog reads reject symlinked cache ancestors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-test-"));
  const outside = await mkdtemp(join(tmpdir(), "remote-skills-cache-outside-"));
  const input = await validFixtureObjectInput();
  const canonicalUrl = "https://skills.example.test/.well-known/agent-skills/index.json";

  try {
    const cache = new DiskCache({ directory });
    await cache.publishObject(input);
    await cache.putCatalog(canonicalUrl, new TextEncoder().encode('{"skills":[]}\n'), {
      retrievedAt: "2026-08-25T10:00:00.000Z",
      validatedAt: "2026-08-25T10:00:00.000Z",
    });
    const layout = join(directory, "cache-v1");
    await rename(join(layout, "objects"), join(outside, "objects"));
    await symlink(
      join(outside, "objects"),
      join(layout, "objects"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await rename(join(layout, "catalogs"), join(outside, "catalogs"));
    await symlink(
      join(outside, "catalogs"),
      join(layout, "catalogs"),
      process.platform === "win32" ? "junction" : "dir",
    );

    await assert.rejects(
      cache.getObject(input.digest),
      (error) => errorCode(error) === "cache_corrupt",
    );
    await assert.rejects(
      cache.getCatalog(canonicalUrl),
      (error) => errorCode(error) === "cache_corrupt",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("publication and lease acquisition reject symlinked cache ancestors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-test-"));
  const outside = await mkdtemp(join(tmpdir(), "remote-skills-cache-outside-"));
  const input = await validFixtureObjectInput();

  try {
    const layout = join(directory, "cache-v1");
    await mkdir(layout, { recursive: true });
    for (const name of ["objects", "tmp", "leases"]) {
      await mkdir(join(outside, name));
      await symlink(
        join(outside, name),
        join(layout, name),
        process.platform === "win32" ? "junction" : "dir",
      );
    }
    const cache = new DiskCache({ directory, renewIntervalSeconds: 0 });

    await assert.rejects(
      cache.publishObject(input),
      (error) => errorCode(error) === "cache_corrupt",
    );
    await assert.rejects(
      cache.acquireLease(input.digest, "session-ancestor-symlink"),
      (error) => errorCode(error) === "cache_corrupt",
    );
    assert.deepEqual(await readdir(join(outside, "objects")), []);
    assert.deepEqual(await readdir(join(outside, "leases")), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("cleanup rejects a symlinked temporary root without deleting external state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-test-"));
  const outside = await mkdtemp(join(tmpdir(), "remote-skills-cache-outside-"));
  const sentinel = join(outside, "stale-writer");

  try {
    await mkdir(join(directory, "cache-v1"), { recursive: true });
    await mkdir(sentinel);
    await writeFile(join(sentinel, "writer.json"), "{}\n");
    await utimes(
      sentinel,
      new Date("2026-08-20T10:00:00.000Z"),
      new Date("2026-08-20T10:00:00.000Z"),
    );
    await symlink(
      outside,
      join(directory, "cache-v1", "tmp"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const cache = new DiskCache({
      directory,
      now: () => new Date("2026-08-25T10:00:00.000Z"),
      temporaryExpirySeconds: 120,
    });

    await assert.rejects(cache.cleanup(), (error) => errorCode(error) === "cache_corrupt");
    await access(sentinel);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("memory cache preserves disk semantics without filesystem state", async () => {
  const input = await validFixtureObjectInput();
  const cache = new MemoryCache({
    maxBytes: input.artifact.byteLength + requiredSkillBytes(input).byteLength,
    now: () => new Date("2026-08-25T10:00:30.000Z"),
  });

  await putCatalogWithUnknownMetadata(
    cache,
    "https://skills.example.test/.well-known/agent-skills/index.json",
    new TextEncoder().encode('{"skills":[]}\n'),
    {
      retrievedAt: "2026-08-25T10:00:00.000Z",
      validatedAt: "2026-08-25T10:00:00.000Z",
      headers: { Authorization: "RMS_SYNTHETIC_SECRET_CANARY_8F0D2A7C" },
    },
  );
  assert.equal(
    JSON.stringify(
      await cache.getCatalog("https://skills.example.test/.well-known/agent-skills/index.json"),
    ).includes("RMS_SYNTHETIC_SECRET_CANARY_8F0D2A7C"),
    false,
  );
  const first = await cache.publishObject(input);
  input.artifact[0] = 0;
  assert.notEqual(first.artifact[0], 0, "memory publication must clone caller-owned bytes");

  const lease = await cache.acquireLease(first.metadata.digest, "session-a");
  const pinned = await cache.evict();
  assert.deepEqual(pinned.retainedPinned, [first.metadata.digest]);
  assert.ok(await cache.getObject(first.metadata.digest));

  await lease.release();
  const secondInput = await validFixtureObjectInput();
  const otherBytes = new TextEncoder().encode("another verified object");
  const otherDigest = `sha256:${createHash("sha256").update(otherBytes).digest("hex")}`;
  await cache.publishObject({
    ...secondInput,
    digest: otherDigest,
    artifact: otherBytes,
    files: new Map([["SKILL.md", otherBytes]]),
    verifiedAt: "2026-08-25T10:01:00.000Z",
    accessedAt: "2026-08-25T10:01:00.000Z",
  });
  const evicted = await cache.evict();
  assert.ok(evicted.evicted.includes(first.metadata.digest));

  const unsafe = await validFixtureObjectInput();
  unsafe.files = new Map([["../SKILL.md", requiredSkillBytes(unsafe)]]);
  unsafe.mediaTypes = new Map([["../SKILL.md", "text/markdown"]]);
  await assert.rejects(
    cache.publishObject(unsafe),
    (error) => errorCode(error) === "cache_corrupt",
  );
  await assert.rejects(
    cache.acquireLease(first.metadata.digest, "../escape"),
    (error) => errorCode(error) === "configuration_invalid",
  );
});

test("catalog generations participate in memory and disk size and age eviction", async () => {
  const canonicalUrl = "https://skills.example.test/.well-known/agent-skills/index.json";
  const body = new TextEncoder().encode('{"skills":[]}\n');
  const metadata = {
    retrievedAt: "2026-08-25T10:00:00.000Z",
    validatedAt: "2026-08-25T10:00:00.000Z",
  };
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-catalog-bounds-"));
  try {
    for (const cache of [
      new ReviewMemoryCache({
        maxBytes: 0,
        maxAgeSeconds: 1_000_000,
        now: () => new Date("2026-08-25T10:00:02.000Z"),
      }),
      new ReviewDiskCache({
        directory,
        maxBytes: 0,
        maxAgeSeconds: 1_000_000,
        now: () => new Date("2026-08-25T10:00:02.000Z"),
        processNonce: "catalog-bounds-disk",
      }),
    ]) {
      await cache.putCatalog(canonicalUrl, body, metadata);
      assert.ok(await cache.getCatalog(canonicalUrl));
      const result = await cache.evict();
      assert.equal(result.totalBytes, 0);
      assert.equal(await cache.getCatalog(canonicalUrl), null);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("disk eviction counts and removes a crash-stranded previous catalog generation", async () => {
  const canonicalUrl = "https://skills.example.test/.well-known/agent-skills/index.json";
  const originId = reviewOriginId(canonicalUrl);
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-catalog-previous-bound-"));
  const current = join(directory, "cache-v1", "catalogs", originId);
  const previous = join(
    directory,
    "cache-v1",
    "tmp",
    "catalog-generations-v1",
    originId,
    "previous",
  );
  try {
    const cache = new ReviewDiskCache({
      directory,
      maxBytes: 512 * 1024 * 1024,
      maxAgeSeconds: 1,
      now: () => new Date("2026-08-25T10:00:02.000Z"),
      processNonce: "catalog-previous-bound",
    });
    await cache.putCatalog(canonicalUrl, new TextEncoder().encode('{"generation":"stranded"}\n'), {
      retrievedAt: "2026-08-25T10:00:00.000Z",
      validatedAt: "2026-08-25T10:00:00.000Z",
    });
    await mkdir(dirname(previous), { recursive: true });
    await rename(current, previous);

    const lockedDigests: string[] = [];
    const withDigestLock = cacheInternals(cache).withDigestLock.bind(cache);
    cacheInternals(cache).withDigestLock = async (digest, ...args) => {
      lockedDigests.push(digest);
      return withDigestLock(digest, ...args);
    };
    assert.ok(await cache.getCatalog(canonicalUrl));
    const result = await cache.evict();
    assert.ok(lockedDigests.includes(reviewCatalogMutationDigest(originId)));
    assert.ok(!lockedDigests.includes(`sha256:${originId}`));
    assert.equal(result.totalBytes, 0);
    assert.equal(await cache.getCatalog(canonicalUrl), null);
    await assert.rejects(access(previous));
    await assert.rejects(access(dirname(previous)));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("catalog cleanup removes obsolete previous state under its lock but preserves the sole generation", async () => {
  const canonicalUrl = "https://skills.example.test/.well-known/agent-skills/index.json";
  const originId = reviewOriginId(canonicalUrl);
  const mutationDigest = reviewCatalogMutationDigest(originId);
  assert.equal(
    mutationDigest,
    "sha256:3865824a8b232ea6d5c94441f74a5bd5e18af3a790d003dfd0f40ca1e1293d8d",
  );
  const body = new TextEncoder().encode('{"generation":"catalog-cleanup"}\n');
  const metadata = validCatalogMetadata();
  for (const mode of ["current-and-previous", "previous-only"]) {
    const directory = await mkdtemp(join(tmpdir(), `remote-skills-cache-${mode}-`));
    const current = join(directory, "cache-v1", "catalogs", originId);
    const previous = join(
      directory,
      "cache-v1",
      "tmp",
      "catalog-generations-v1",
      originId,
      "previous",
    );
    try {
      const cache = new ReviewDiskCache({ directory, processNonce: `catalog-cleanup-${mode}` });
      await cache.putCatalog(canonicalUrl, body, metadata);
      await mkdir(dirname(previous), { recursive: true });
      if (mode === "current-and-previous") await cp(current, previous, { recursive: true });
      else await rename(current, previous);

      const lockedDigests: string[] = [];
      const lockedPaths: string[] = [];
      const withDigestLock = cacheInternals(cache).withDigestLock.bind(cache);
      cacheInternals(cache).withDigestLock = async (digest, ...args) => {
        lockedDigests.push(digest);
        lockedPaths.push(
          join(
            directory,
            "cache-v1",
            "tmp",
            "coordination-v1",
            "locks",
            digest.replace("sha256:", ""),
          ),
        );
        return withDigestLock(digest, ...args);
      };
      await cache.cleanup();

      const mutationLockPath = join(
        directory,
        "cache-v1",
        "tmp",
        "coordination-v1",
        "locks",
        mutationDigest.replace("sha256:", ""),
      );
      assert.ok(lockedDigests.includes(mutationDigest));
      assert.ok(
        lockedDigests.includes(
          "sha256:52f171c6c5d96edd9ec677a3dbb30b1b5aa0ac1fc93e9007b33f6afd4a3c9f59",
        ),
      );
      assert.ok(!lockedDigests.includes(`sha256:${originId}`));
      assert.ok(lockedPaths.includes(mutationLockPath));
      assert.deepEqual((await cache.getCatalog(canonicalUrl))?.body, body);
      await access(current);
      await assert.rejects(access(previous));
      await assert.rejects(access(dirname(previous)));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("catalog publication and multi-origin eviction do not leak empty generation parents", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-catalog-parent-cleanup-"));
  const urls = [
    "https://one.example.test/.well-known/agent-skills/index.json",
    "https://two.example.test/.well-known/agent-skills/index.json",
    "https://three.example.test/.well-known/agent-skills/index.json",
  ];
  const generationParents = urls.map((url) =>
    join(directory, "cache-v1", "tmp", "catalog-generations-v1", reviewOriginId(url)),
  );
  const managedGenerationEntries = 2 * urls.length;
  // state.json is fixed O(1) state; each catalog's generation.json is charged on scan and removal.
  assert.equal(managedGenerationEntries, 6);
  try {
    const cache = new ReviewDiskCache({
      directory,
      maxBytes: 0,
      maxScanEntries: 100 + managedGenerationEntries,
      processNonce: "catalog-parent-cleanup",
    });
    for (const [index, url] of urls.entries()) {
      const generationParent = generationParents[index];
      assert.ok(generationParent);
      await cache.putCatalog(url, new TextEncoder().encode(`{"generation":${index}}\n`), {
        retrievedAt: "2026-08-25T10:00:00.000Z",
        validatedAt: "2026-08-25T10:00:00.000Z",
      });
      await access(join(directory, "cache-v1", "catalogs", reviewOriginId(url), "generation.json"));
      await assert.rejects(access(generationParent));
      await mkdir(generationParent, { recursive: true });
    }
    await access(join(directory, "cache-v1", "tmp", "catalog-generations-v1", "state.json"));

    assert.equal((await cache.evict()).totalBytes, 0);
    for (const parent of generationParents) await assert.rejects(access(parent));

    const boundedCleaner = new ReviewDiskCache({
      directory,
      maxScanEntries: 1,
      processNonce: "catalog-parent-bounded-cleanup",
    });
    assert.deepEqual(await boundedCleaner.cleanup(), {
      removedTemporaryPaths: 0,
      reclaimedLeases: 0,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("memory skill-md publication byte-binds SKILL.md to the verified artifact", async () => {
  const input = await validFixtureObjectInput();
  const tampered = new Uint8Array(requiredSkillBytes(input));
  const firstByte = tampered.at(0);
  assert.ok(firstByte !== undefined);
  tampered[0] = firstByte ^ 1;

  await assert.rejects(
    new MemoryCache().publishObject({ ...input, files: new Map([["SKILL.md", tampered]]) }),
    (error) => error instanceof CacheCorruptError && errorCode(error) === "cache_corrupt",
  );
});

test("memory archive reuse fails closed without an artifact-root verifier", async () => {
  const input = await validFixtureObjectInput();
  const archive = {
    ...input,
    artifactType: "archive",
    archiveFormat: "tar.gz",
  };

  await assert.rejects(
    new MemoryCache().publishObject(archive),
    (error) => error instanceof CacheCorruptError && errorCode(error) === "cache_corrupt",
  );
  assert.equal(
    (await new MemoryCache({ verifyExtractedContents: () => true }).publishObject(archive)).metadata
      .digest,
    input.digest,
  );
});

test("duplicate memory lease handles keep independent pins until both release", async () => {
  const input = await validFixtureObjectInput();
  const cache = new MemoryCache({ maxBytes: 0 });
  await cache.publishObject(input);
  const first = await cache.acquireLease(input.digest, "session-duplicate");
  const second = await cache.acquireLease(input.digest, "session-duplicate");

  await first.release();
  assert.deepEqual((await cache.evict()).retainedPinned, [input.digest]);
  assert.ok(await cache.getObject(input.digest));
  await second.release();
  assert.deepEqual((await cache.evict()).evicted, [input.digest]);
});

test("cache selection accepts memory, disk, and a caller-supplied custom backend", async () => {
  const custom = {
    getCatalog: async () => null,
    getCatalogState: async () => ({
      catalog: null,
      generation: `sha256:${"0".repeat(64)}`,
    }),
    putCatalog: async () => {},
    replaceCatalog: async () => true,
    deleteCatalog: async () => true,
    getObject: async () => null,
    publishObject: async () => {
      throw new Error("not used");
    },
    acquireLease: async () => {
      throw new Error("not used");
    },
    evict: async () => ({ evicted: [], retainedPinned: [], totalBytes: 0 }),
    cleanup: async () => ({ removedTemporaryPaths: 0, reclaimedLeases: 0 }),
  };

  assert.ok(resolveCache("memory") instanceof MemoryCache);
  assert.ok(resolveCache("disk") instanceof DiskCache);
  assert.equal(resolveCache(custom), custom);
  assert.throws(
    () => resolveCacheFromUnknown({ getCatalog: async () => null }),
    (error) => errorCode(error) === "configuration_invalid",
  );
});

test("invalid canonical URLs fail with a sanitized stable configuration error", async () => {
  const secret = "RMS_SYNTHETIC_SECRET_CANARY_8F0D2A7C";

  assert.throws(
    () => canonicalOriginIdentifier(`not a URL ${secret}`),
    (error) =>
      error instanceof CacheConfigurationError &&
      errorCode(error) === "configuration_invalid" &&
      errorMessage(error).includes(secret) === false,
  );
});

test("disk leases atomically acquire, renew with an injected clock, and release", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-test-"));
  const input = await validFixtureObjectInput();
  let now = new Date("2026-08-25T10:00:00.000Z");

  try {
    const cache = new DiskCache({
      directory,
      now: () => now,
      pid: 4242,
      processNonce: "process-test",
      renewIntervalSeconds: 0,
    });
    const lease = await cache.acquireLease(input.digest, "session-test");
    assert.ok(lease.path);
    const created = parseJsonRecord(await readFile(lease.path, "utf8"));
    assert.match(requiredString(created, "lease_nonce"), /^[A-Za-z0-9._-]+$/u);
    assert.deepEqual(created, {
      schema: "remote-skills-cache-lease-v1",
      digest: input.digest,
      pid: 4242,
      process_nonce: "process-test",
      session_nonce: "session-test",
      lease_nonce: requiredString(created, "lease_nonce"),
      created_at: "2026-08-25T10:00:00.000Z",
      renewed_at: "2026-08-25T10:00:00.000Z",
    });

    now = new Date("2026-08-25T10:00:30.000Z");
    await lease.renew();
    assert.equal(parseJsonRecord(await readFile(lease.path, "utf8")).renewed_at, now.toISOString());
    await lease.release();
    await assert.rejects(access(lease.path));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("disk auxiliary coordination state stays outside the shared lease-only directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-test-"));
  const input = await validFixtureObjectInput();
  const hex = input.digest.replace("sha256:", "");

  try {
    const cache = new DiskCache({
      directory,
      processNonce: "process-layout-test",
      renewIntervalSeconds: 0,
    });
    const lease = await cache.acquireLease(input.digest, "session-layout-test");
    assert.ok(lease.path);
    assert.deepEqual(await readdir(join(directory, "cache-v1", "leases", hex)), [
      lease.path.split(/[\\/]/u).at(-1),
    ]);
    await access(
      join(
        directory,
        "cache-v1",
        "tmp",
        "coordination-v1",
        "processes",
        hex,
        "process-layout-test.json",
      ),
    );
    await lease.release();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("crash cleanup reclaims stale lease coordination without polluting the shared lease layout", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-test-"));
  const input = await validFixtureObjectInput();
  const hex = input.digest.replace("sha256:", "");
  let now = new Date("2026-08-25T10:00:00.000Z");
  const registration = join(
    directory,
    "cache-v1",
    "tmp",
    "coordination-v1",
    "processes",
    hex,
    "process-crashed-writer.json",
  );

  try {
    const crashed = new DiskCache({
      directory,
      now: () => now,
      pid: 999_999,
      processNonce: "process-crashed-writer",
      leaseExpirySeconds: 10,
      renewIntervalSeconds: 0,
    });
    await crashed.acquireLease(input.digest, "session-crashed-writer");
    assert.equal((await readdir(join(directory, "cache-v1", "leases", hex))).length, 1);
    await access(registration);

    now = new Date("2026-08-25T10:00:20.000Z");
    const cleaner = new DiskCache({
      directory,
      now: () => now,
      leaseExpirySeconds: 10,
      isProcessAlive: () => false,
      renewIntervalSeconds: 0,
    });
    assert.equal((await cleaner.cleanup()).reclaimedLeases, 1);
    await assert.rejects(access(registration));
    await assert.rejects(access(join(directory, "cache-v1", "leases", hex)));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("TypeScript cleanup reclaims Python orphan registration and generation without an object", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-test-"));
  const input = await validFixtureObjectInput();
  const hex = input.digest.replace("sha256:", "");
  const helper = fileURLToPath(new URL("helpers/python-orphan-registration.py", import.meta.url));
  const registration = join(
    directory,
    "cache-v1",
    "tmp",
    "coordination-v1",
    "processes",
    hex,
    "python-orphan-before-publication.json",
  );
  const generation = join(directory, "cache-v1", "leases", hex, ".lease-generation.json");
  try {
    const child = spawn(
      process.env.REMOTE_SKILLS_PYTHON ?? "python3",
      [helper, directory, input.digest],
      {
        env: {
          ...process.env,
          PYTHONPATH: fileURLToPath(new URL("../../../sdk-python/src/", import.meta.url)),
        },
      },
    );
    const code = await new Promise<number | null>((resolve) =>
      child.once("exit", (exitCode) => resolve(exitCode)),
    );
    assert.equal(code, 0);
    await access(registration);
    await access(generation);

    await new DiskCache({
      directory,
      now: () => new Date("2040-01-01T00:00:00.000Z"),
      leaseExpirySeconds: 1,
      temporaryExpirySeconds: 1,
      isProcessAlive: () => false,
      renewIntervalSeconds: 0,
    }).cleanup();

    await assert.rejects(access(registration));
    await assert.rejects(access(generation));
    await assert.rejects(access(join(directory, "cache-v1", "tmp", "coordination-v1")));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("generation cleanup preserves active state and stale handles cannot release successors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-test-"));
  const input = await validFixtureObjectInput();
  const hex = input.digest.replace("sha256:", "");
  const generation = join(directory, "cache-v1", "leases", hex, ".lease-generation.json");
  let now = new Date("2026-08-26T00:00:00.000Z");
  try {
    const owner = new DiskCache({
      directory,
      now: () => now,
      pid: 999_999,
      processNonce: "typescript-stale-handle",
      isProcessAlive: () => false,
      leaseExpirySeconds: 1,
      renewIntervalSeconds: 0,
    });
    const original = await owner.acquireLease(input.digest, "same-session");
    await writeFile(
      generation,
      `${JSON.stringify({
        schema: "remote-skills-cache-lease-generation-v1",
        coordination_version: "remote-skills-cache-coordination-v1",
        generation: now.toISOString(),
      })}\n`,
    );
    const activeCleaner = new DiskCache({
      directory,
      now: () => now,
      leaseExpirySeconds: 1,
      renewIntervalSeconds: 0,
    });
    await activeCleaner.cleanup();
    await access(generation);

    now = new Date("2040-01-01T00:00:00.000Z");
    await activeCleaner.cleanup();
    await assert.rejects(access(generation));
    const successor = await new DiskCache({
      directory,
      now: () => new Date("2026-08-26T00:00:00.000Z"),
      processNonce: "typescript-stale-handle",
      renewIntervalSeconds: 0,
    }).acquireLease(input.digest, "same-session");
    assert.ok(successor.path);
    await original.release();
    await access(successor.path);
    await successor.release();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("coordination cleanup fails closed at the shared scan budget", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-test-"));
  const processes = join(directory, "cache-v1", "tmp", "coordination-v1", "processes");
  try {
    for (let index = 0; index < 4; index += 1) {
      const hex = createHash("sha256").update(`bounded-${index}`).digest("hex");
      const registrationDirectory = join(processes, hex);
      await mkdir(registrationDirectory, { recursive: true });
      await writeFile(
        join(registrationDirectory, `orphan-${index}.json`),
        `${JSON.stringify({
          schema: "remote-skills-cache-process-registration-v1",
          pid: 999_999,
          process_nonce: `orphan-${index}`,
          renewed_at: "2020-01-01T00:00:00.000Z",
        })}\n`,
      );
    }
    await assert.rejects(
      new DiskCache({
        directory,
        now: () => new Date("2040-01-01T00:00:00.000Z"),
        maxScanEntries: 2,
        isProcessAlive: () => false,
        renewIntervalSeconds: 0,
      }).cleanup(),
      (error) => error instanceof CacheCorruptError && errorCode(error) === "cache_corrupt",
    );
    assert.ok((await readdir(processes)).length >= 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("stale process-registration cleanup preserves a same-inode successor", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-registration-rewrite-"));
  const hex = createHash("sha256").update("registration-rewrite").digest("hex");
  const processNonce = "registration-rewrite-process";
  const registrationDirectory = join(
    directory,
    "cache-v1",
    "tmp",
    "coordination-v1",
    "processes",
    hex,
  );
  const registrationPath = join(registrationDirectory, `${processNonce}.json`);
  const livenessEntered = deferred();
  const resumeLiveness = deferred();
  let cleanup: CacheCleanup | undefined;
  const successor = `${JSON.stringify({
    schema: "remote-skills-cache-process-registration-v1",
    pid: 999_999,
    process_nonce: processNonce,
    renewed_at: "2040-01-01T00:00:00.000Z",
  })}\n`;

  try {
    await mkdir(registrationDirectory, { recursive: true });
    await writeFile(
      registrationPath,
      `${JSON.stringify({
        schema: "remote-skills-cache-process-registration-v1",
        pid: 999_999,
        process_nonce: processNonce,
        renewed_at: "2020-01-01T00:00:00.000Z",
      })}\n`,
    );
    const cache = new ReviewDiskCache({
      directory,
      now: () => new Date("2040-01-01T00:00:00.000Z"),
      leaseExpirySeconds: 1,
      isProcessAlive: async () => {
        livenessEntered.resolve();
        await resumeLiveness.promise;
        return false;
      },
      renewIntervalSeconds: 0,
    });

    cleanup = cache.cleanup();
    await waitForSignal(livenessEntered.promise, "stale process-registration liveness check");
    await rewriteFileInPlace(registrationPath, successor);
    resumeLiveness.resolve();
    await cleanup;

    assert.equal(await readFile(registrationPath, "utf8"), successor);
  } finally {
    resumeLiveness.resolve();
    await Promise.allSettled([cleanup].filter(Boolean));
    await rm(directory, { recursive: true, force: true });
  }
});

test("coordination cleanup preserves unknown versioned peer state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-test-"));
  const input = await validFixtureObjectInput();
  const hex = input.digest.replace("sha256:", "");
  const peerLock = join(
    directory,
    "cache-v1",
    "tmp",
    "coordination-v1",
    "locks",
    hex,
    "0000000000000001-peer-owner.lock",
  );
  const peerProcess = join(
    directory,
    "cache-v1",
    "tmp",
    "coordination-v1",
    "processes",
    "python-peer-v1",
    "state.json",
  );
  try {
    await mkdir(join(peerLock, ".."), { recursive: true });
    await mkdir(join(peerProcess, ".."), { recursive: true });
    await writeFile(peerLock, '{"schema":"python-peer-lock-v1"}\n');
    await writeFile(peerProcess, '{"schema":"python-peer-process-v1"}\n');
    const cache = new DiskCache({
      directory,
      now: () => new Date("2030-08-25T10:00:00.000Z"),
    });

    await cache.cleanup();
    assert.equal(await readFile(peerLock, "utf8"), '{"schema":"python-peer-lock-v1"}\n');
    assert.equal(await readFile(peerProcess, "utf8"), '{"schema":"python-peer-process-v1"}\n');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("same-process DiskCache instances honor a registered nonce instead of reclaiming by PID", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-test-"));
  const input = await validFixtureObjectInput();
  let now = new Date("2026-08-25T10:00:00.000Z");

  try {
    const owner = new DiskCache({
      directory,
      now: () => now,
      leaseExpirySeconds: 10,
      processNonce: "process-owner-instance",
      renewIntervalSeconds: 0,
    });
    const first = await owner.acquireLease(input.digest, "session-old-but-live");
    now = new Date("2026-08-25T10:00:20.000Z");
    const second = await owner.acquireLease(input.digest, "session-registration-heartbeat");
    const cleaner = new DiskCache({
      directory,
      now: () => now,
      leaseExpirySeconds: 10,
      processNonce: "process-cleaner-instance",
      renewIntervalSeconds: 0,
    });

    assert.equal((await cleaner.cleanup()).reclaimedLeases, 0);
    await first.release();
    await second.release();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a demonstrably live lease owner survives a frozen registration timestamp", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-live-frozen-lease-"));
  const input = skillInput("# frozen live lease\n");
  const ownerNow = new Date("2026-08-25T10:00:00.000Z");
  const cleanerNow = new Date("2026-08-25T10:00:02.000Z");
  let lease: CacheLease | undefined;
  try {
    const owner = new ReviewDiskCache({
      directory,
      now: () => ownerNow,
      leaseExpirySeconds: 1,
      renewIntervalSeconds: 0,
      processNonce: "frozen-live-lease-owner",
      maxBytes: 0,
    });
    await owner.publishObject(input);
    lease = await owner.acquireLease(input.digest, "frozen-live-lease-session");
    const cleaner = new ReviewDiskCache({
      directory,
      now: () => cleanerNow,
      leaseExpirySeconds: 1,
      renewIntervalSeconds: 0,
      processNonce: "frozen-live-lease-cleaner",
      maxBytes: 0,
    });

    assert.equal((await cleaner.cleanup()).reclaimedLeases, 0);
    const protectedResult = await cleaner.evict();
    assert.deepEqual(protectedResult.evicted, []);
    assert.deepEqual(protectedResult.retainedPinned, [input.digest]);
    assert.ok(await cleaner.getObject(input.digest));

    await lease.release();
    lease = undefined;
    assert.deepEqual((await cleaner.evict()).evicted, [input.digest]);
  } finally {
    await lease?.release();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a demonstrably live mutation-lock owner survives a frozen registration timestamp", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-live-frozen-lock-"));
  const input = skillInput("# frozen live mutation lock\n");
  const ownerNow = new Date("2026-08-25T10:00:00.000Z");
  const cleanerNow = new Date("2026-08-25T10:00:02.000Z");
  const ownerEntered = deferred();
  const releaseOwner = deferred();
  const contenderEntered = deferred();
  let held: Promise<void> | undefined;
  let contender: Promise<void> | undefined;
  try {
    const owner = new ReviewDiskCache({
      directory,
      now: () => ownerNow,
      leaseExpirySeconds: 1,
      processNonce: "frozen-live-lock-owner",
    });
    held = cacheInternals(owner).withDigestLock(input.digest, async () => {
      ownerEntered.resolve();
      await releaseOwner.promise;
    });
    await ownerEntered.promise;

    const cleaner = new ReviewDiskCache({
      directory,
      now: () => cleanerNow,
      leaseExpirySeconds: 1,
      processNonce: "frozen-live-lock-cleaner",
    });
    const lockPath = await currentMutationLockPath(directory, input.digest);
    await cacheInternals(cleaner).reclaimStaleMutationLock(lockPath);
    await access(lockPath);

    contender = cacheInternals(cleaner).withDigestLock(input.digest, async () =>
      contenderEntered.resolve(),
    );
    assert.equal(
      await Promise.race([
        contenderEntered.promise.then(() => true),
        new Promise((resolve) => setTimeout(() => resolve(false), 100)),
      ]),
      false,
    );
    releaseOwner.resolve();
    await Promise.all([held, contender]);
  } finally {
    releaseOwner.resolve();
    await Promise.allSettled([held, contender].filter(Boolean));
    await rm(directory, { recursive: true, force: true });
  }
});

test("mutation-gate publication never exposes an unregistered owner or overlapping action", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-gate-publication-"));
  const input = skillInput("# atomic gate publication\n");
  const registrationMayStart = deferred();
  const releaseRegistration = deferred();
  const ownerEntered = deferred();
  const releaseOwner = deferred();
  const contenderEntered = deferred();
  let held: Promise<void> | undefined;
  let cleanup: Promise<void> | undefined;
  let contender: Promise<void> | undefined;
  try {
    const owner = new ReviewDiskCache({
      directory,
      now: () => new Date("2026-08-25T10:00:00.000Z"),
      leaseExpirySeconds: 1,
      processNonce: "gate-publication-owner",
    });
    const startHeartbeat = cacheInternals(owner).startProcessRegistrationHeartbeat.bind(owner);
    cacheInternals(owner).startProcessRegistrationHeartbeat = async (...args) => {
      registrationMayStart.resolve();
      await releaseRegistration.promise;
      return startHeartbeat(...args);
    };
    held = cacheInternals(owner).withDigestLock(input.digest, async () => {
      ownerEntered.resolve();
      await releaseOwner.promise;
    });
    await waitForSignal(registrationMayStart.promise, "gate publication before registration");

    const lockRoot = join(directory, "cache-v1", "tmp", "coordination-v1", "locks");
    const preRegistrationRecords = await readdir(lockRoot, { recursive: true }).catch((error) => {
      if (errorCode(error) === "ENOENT") return [];
      throw error;
    });
    assert.deepEqual(
      preRegistrationRecords,
      [],
      "no gate record may be visible before its owner registration is live",
    );
    releaseRegistration.resolve();
    await waitForSignal(ownerEntered.promise, "registered owner action");

    const cleaner = new ReviewDiskCache({
      directory,
      now: () => new Date("2026-08-25T10:00:02.000Z"),
      leaseExpirySeconds: 1,
      processNonce: "gate-publication-cleaner",
    });
    const published = (await readdir(lockRoot, { recursive: true, withFileTypes: true })).find(
      (entry) => entry.isFile() && entry.name.endsWith(".lock"),
    );
    assert.ok(published, "the registered owner must publish a gate record");
    cleanup = cacheInternals(cleaner).reclaimStaleMutationLock(
      join(published.parentPath, published.name),
    );
    await cleanup;

    contender = cacheInternals(cleaner).withDigestLock(input.digest, async () => {
      contenderEntered.resolve();
    });
    assert.equal(
      await Promise.race([
        contenderEntered.promise.then(() => true),
        new Promise((resolve) => setTimeout(() => resolve(false), 100)),
      ]),
      false,
      "a contender must not overlap the registered owner action",
    );
    releaseOwner.resolve();
    await Promise.all([held, contender]);
  } finally {
    releaseRegistration.resolve();
    releaseOwner.resolve();
    await Promise.allSettled([held, cleanup, contender].filter(Boolean));
    await rm(directory, { recursive: true, force: true });
  }
});

test("a live peer identity uses its active registration generation when logical time is frozen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-live-peer-identity-"));
  const input = skillInput("# live peer identity\n");
  const hex = input.digest.replace("sha256:", "");
  const processNonce = "live-peer-process";
  const child = spawn(
    process.execPath,
    [
      "-e",
      "process.send?.({ timeOrigin: Math.floor(performance.timeOrigin) }); setInterval(() => {}, 1_000)",
    ],
    {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    },
  );
  const childPid = child.pid;
  assert.ok(childPid);
  const childIdentity = new Promise<string>((resolve, reject) => {
    child.once("message", async (message) => {
      if (!isTimeOriginMessage(message)) {
        reject(new Error("child returned an invalid time origin"));
        return;
      }
      resolve(
        process.platform === "linux"
          ? await linuxProcessStartIdentity(childPid)
          : `node:${childPid}:${message.timeOrigin}`,
      );
    });
  });
  const childExit = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  try {
    const registrationDirectory = join(
      directory,
      "cache-v1",
      "tmp",
      "coordination-v1",
      "processes",
      hex,
    );
    const registrationPath = join(registrationDirectory, `${processNonce}.json`);
    await mkdir(registrationDirectory, { recursive: true });
    await writeFile(
      registrationPath,
      `${JSON.stringify({
        schema: "remote-skills-cache-process-registration-v1",
        pid: childPid,
        process_nonce: processNonce,
        process_identity: await childIdentity,
        renewed_at: "2026-08-25T10:00:00.000Z",
      })}\n`,
    );
    const cleaner = new ReviewDiskCache({
      directory,
      now: () => new Date("2026-08-25T10:00:20.000Z"),
      leaseExpirySeconds: 10,
    });

    await utimes(registrationPath, new Date(Date.now() + 250), new Date(Date.now() + 250));
    assert.equal(
      await cacheInternals(cleaner).isRegisteredProcessAlive(childPid, processNonce, hex),
      true,
    );
    await utimes(registrationPath, new Date(0), new Date(0));
    assert.equal(
      await cacheInternals(cleaner).isRegisteredProcessAlive(childPid, processNonce, hex),
      process.platform === "linux",
    );
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await childExit;
    await rm(directory, { recursive: true, force: true });
  }
});

test("legacy Linux registrations use stable process-generation evidence across wall-clock steps", {
  skip: process.platform !== "linux",
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-linux-legacy-clock-"));
  const input = skillInput("# legacy Linux wall clock\n");
  const hex = input.digest.replace("sha256:", "");
  const processNonce = "legacy-wall-clock-owner";
  const child = spawn(
    process.execPath,
    ["-e", "process.send?.(Math.floor(performance.timeOrigin)); setInterval(() => {}, 1_000)"],
    { stdio: ["ignore", "ignore", "ignore", "ipc"] },
  );
  const childPid = child.pid;
  assert.ok(childPid);
  const childExit = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const timeOrigin = await new Promise<number>((resolve, reject) => {
    child.once("message", (message) => {
      if (typeof message === "number") resolve(message);
      else reject(new Error("child returned an invalid time origin"));
    });
    child.once("error", reject);
  });
  const registrationDirectory = join(
    directory,
    "cache-v1",
    "tmp",
    "coordination-v1",
    "processes",
    hex,
  );
  const registrationPath = join(registrationDirectory, `${processNonce}.json`);
  const registration = {
    schema: "remote-skills-cache-process-registration-v1",
    pid: childPid,
    process_nonce: processNonce,
    process_identity: `node:${childPid}:${timeOrigin}`,
    renewed_at: "2026-08-25T10:00:00.000Z",
  };
  const realDateNow = Date.now;
  try {
    await mkdir(registrationDirectory, { recursive: true });
    await writeFile(registrationPath, `${JSON.stringify(registration)}\n`);
    const cleaner = new ReviewDiskCache({
      directory,
      now: () => new Date("2026-08-25T10:00:20.000Z"),
      leaseExpirySeconds: 1,
    });

    Date.now = () => 0;
    assert.equal(
      await cacheInternals(cleaner).isRegisteredProcessAlive(childPid, processNonce, hex),
      true,
    );
    Date.now = () => 8_000_000_000_000;
    assert.equal(
      await cacheInternals(cleaner).isRegisteredProcessAlive(childPid, processNonce, hex),
      true,
    );

    const processState = await lstat(`/proc/${childPid}`);
    await new Promise((resolve) => setTimeout(resolve, 1_300));
    await writeFile(
      registrationPath,
      `${JSON.stringify({
        ...registration,
        process_identity: `node:${childPid}:${Math.floor(processState.ctimeMs + 1_100)}`,
      })}\n`,
    );
    assert.equal(
      await cacheInternals(cleaner).isRegisteredProcessAlive(child.pid, processNonce, hex),
      false,
    );

    await writeFile(
      registrationPath,
      `${JSON.stringify({ ...registration, process_identity: `node:${child.pid}:1` })}\n`,
    );
    assert.equal(
      await cacheInternals(cleaner).isRegisteredProcessAlive(child.pid, processNonce, hex),
      false,
    );
    await writeFile(
      registrationPath,
      `${JSON.stringify({
        ...registration,
        process_identity: `node:${child.pid + 1}:${timeOrigin}`,
      })}\n`,
    );
    assert.equal(
      await cacheInternals(cleaner).isRegisteredProcessAlive(child.pid, processNonce, hex),
      false,
    );
  } finally {
    Date.now = realDateNow;
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await childExit;
    await rm(directory, { recursive: true, force: true });
  }
});

test("a Linux child registration uses its peer-verifiable start identity for aged live leases", {
  skip: process.platform !== "linux",
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-linux-child-live-"));
  const helper = fileURLToPath(new URL("helpers/live-lease-holder.ts", import.meta.url));
  const child = spawn(process.execPath, [helper, directory], {
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  const messages: WriterMessage[] = [];
  child.on("message", (message) => {
    if (isWriterMessage(message)) messages.push(message);
  });
  const childExit = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  let stderr = "";
  assert.ok(child.stderr);
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  try {
    await waitForWriterMessages({ messages }, "ready", 1);
    const ready = messages.find((message) => message?.type === "ready");
    assert.ok(
      ready?.digest && ready.processNonce && ready.leasePath && ready.nodeTimeOrigin !== undefined,
    );
    assert.ok(child.pid);
    const hex = ready.digest.replace("sha256:", "");
    const registrationPath = join(
      directory,
      "cache-v1",
      "tmp",
      "coordination-v1",
      "processes",
      hex,
      `${ready.processNonce}.json`,
    );
    const registration = parseJsonRecord(await readFile(registrationPath, "utf8"));
    const leaseRecord = await readFile(ready.leasePath, "utf8");
    assert.match(requiredString(registration, "process_identity"), /^linux:\d+$/u);

    await Promise.all([
      utimes(registrationPath, new Date(0), new Date(0)),
      utimes(ready.leasePath, new Date(0), new Date(0)),
    ]);
    const cleaner = new ReviewDiskCache({
      directory,
      now: () => new Date("2026-08-25T10:00:20.000Z"),
      leaseExpirySeconds: 10,
      renewIntervalSeconds: 0,
      maxBytes: 0,
      processNonce: "linux-live-cleaner",
    });
    assert.equal((await cleaner.cleanup()).reclaimedLeases, 0);
    assert.deepEqual((await cleaner.evict()).retainedPinned, [ready.digest]);

    child.send("stop-heartbeat");
    await waitForWriterMessages({ messages }, "heartbeat-stopped", 1);
    await mkdir(dirname(registrationPath), { recursive: true });
    await mkdir(dirname(ready.leasePath), { recursive: true });
    const legacyRegistration = {
      ...registration,
      process_identity: `node:${child.pid}:${ready.nodeTimeOrigin}`,
    };
    await writeFile(registrationPath, `${JSON.stringify(legacyRegistration)}\n`);
    await writeFile(ready.leasePath, leaseRecord);
    await Promise.all([
      utimes(registrationPath, new Date(0), new Date(0)),
      utimes(ready.leasePath, new Date(0), new Date(0)),
    ]);
    assert.equal((await cleaner.cleanup()).reclaimedLeases, 0);
    assert.deepEqual((await cleaner.evict()).retainedPinned, [ready.digest]);

    await writeFile(
      registrationPath,
      `${JSON.stringify({
        ...legacyRegistration,
        process_identity: `node:${child.pid + 1}:${ready.nodeTimeOrigin}`,
      })}\n`,
    );
    assert.equal(
      await cacheInternals(cleaner).isRegisteredProcessAlive(child.pid, ready.processNonce, hex),
      false,
    );
    await writeFile(
      registrationPath,
      `${JSON.stringify({
        ...legacyRegistration,
        process_identity: `node:${child.pid}:0`,
      })}\n`,
    );
    assert.equal(
      await cacheInternals(cleaner).isRegisteredProcessAlive(child.pid, ready.processNonce, hex),
      false,
    );
    await writeFile(
      registrationPath,
      `${JSON.stringify({ ...registration, process_identity: "linux:0" })}\n`,
    );
    const mismatched = parseJsonRecord(await readFile(registrationPath, "utf8"));
    assert.equal(mismatched.process_identity, "linux:0");
    assert.equal((await cleaner.cleanup()).reclaimedLeases, 1);
    assert.deepEqual((await cleaner.evict()).evicted, [ready.digest]);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await childExit;
    await rm(directory, { recursive: true, force: true });
  }
  assert.equal(stderr, "");
});

test("lease renewal scheduling is derived safely below expiry and uses the injected clock", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-test-"));
  const input = await validFixtureObjectInput();
  let now = new Date("2026-08-25T10:00:00.000Z");
  let leaseWrites = 0;

  try {
    const cache = new DiskCache({
      directory,
      now: () => now,
      leaseExpirySeconds: 1,
      renewIntervalSeconds: 10,
      processNonce: "process-safe-renewal",
      coordinationHooks: {
        beforeLeaseWrite: async () => {
          leaseWrites += 1;
          if (leaseWrites === 2) {
            await new Promise((resolve) => setTimeout(resolve, 850));
          }
        },
      },
    });
    assert.ok(cache.renewIntervalSeconds <= cache.leaseExpirySeconds / 2);
    const lease = await cache.acquireLease(input.digest, "session-safe-renewal");
    assert.ok(lease.path);
    now = new Date("2026-08-25T10:00:00.750Z");
    const renewed = await waitForJson(
      lease.path,
      (value) => value.renewed_at === now.toISOString(),
    );
    assert.equal(renewed.renewed_at, now.toISOString());
    await lease.release();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("TypeScript eviction preserves an expired Python lease while its real process is live", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-python-live-"));
  const ready = join(directory, "python-ready");
  const release = join(directory, "python-release");
  const input = await validFixtureObjectInput();
  const helper = fileURLToPath(new URL("helpers/python-lease-holder.py", import.meta.url));
  let child: ChildProcess | undefined;
  let completion: Promise<number | null> | undefined;
  let stderr = "";

  try {
    await new DiskCache({ directory }).publishObject(input);
    const runningChild = spawn(
      process.env.REMOTE_SKILLS_PYTHON ?? "python3",
      [helper, directory, input.digest, ready, release],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    completion = observeChildCompletion(runningChild);
    child = runningChild;
    assert.ok(runningChild.stderr);
    runningChild.stderr.setEncoding("utf8");
    runningChild.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    await waitForPath(ready, 10_000, completion);

    const cleaner = new DiskCache({
      directory,
      maxBytes: 0,
      maxAgeSeconds: 0,
      leaseExpirySeconds: 1,
      renewIntervalSeconds: 0,
      now: () => new Date("2040-01-01T00:00:00.000Z"),
    });
    const result = await cleaner.evict();
    assert.deepEqual(result.retainedPinned, [input.digest]);
    assert.notEqual(await cleaner.getObject(input.digest), null);

    await writeFile(release, "release", "utf8");
    await waitForSignal(
      completion.then(() => undefined),
      "Python lease holder completion",
      10_000,
    );
    const code = await completion;
    assert.equal(code, 0, stderr);
  } finally {
    if (child && completion) await stopRaceWriters([{ child, completion }]);
    await rm(directory, { recursive: true, force: true });
  }
  assert.equal(stderr, "");
});

test("TypeScript cleanup preserves a live Python writer and reclaims it after a crash", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-python-writer-"));
  const ready = join(directory, "python-writer-ready");
  const release = join(directory, "python-writer-release");
  const input = await validFixtureObjectInput();
  const helper = fileURLToPath(new URL("helpers/python-writer-holder.py", import.meta.url));
  const fixtureRoot = fileURLToPath(new URL("fixtures/cache/states/valid/", protocolRoot));
  let child: ChildProcess | undefined;
  let completion: Promise<number | null> | undefined;
  let stderr = "";

  try {
    const runningChild = spawn(
      process.env.REMOTE_SKILLS_PYTHON ?? "python3",
      [helper, fixtureRoot, directory, input.digest, ready, release],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    completion = observeChildCompletion(runningChild);
    child = runningChild;
    assert.ok(runningChild.stderr);
    runningChild.stderr.setEncoding("utf8");
    runningChild.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    await waitForPath(ready, 10_000, completion);
    const temporaryRoot = join(directory, "cache-v1", "tmp");
    const stageName = (await readdir(temporaryRoot)).find((name) =>
      name.startsWith("writer-python-"),
    );
    assert.ok(stageName);
    const stage = join(temporaryRoot, stageName);
    await utimes(stage, new Date(0), new Date(0));
    const cleaner = new DiskCache({
      directory,
      now: () => new Date("2040-01-01T00:00:00.000Z"),
      temporaryExpirySeconds: 1,
      leaseExpirySeconds: 1,
      renewIntervalSeconds: 0,
    });
    const writer = parseJsonRecord(await readFile(join(stage, "writer.json"), "utf8"));
    const registrationPath = join(
      temporaryRoot,
      "coordination-v1",
      "processes",
      input.digest.replace("sha256:", ""),
      `${requiredString(writer, "process_nonce")}.json`,
    );
    const firstRegistration = parseJsonRecord(await readFile(registrationPath, "utf8"));
    await waitForJson(
      registrationPath,
      (value) => value.renewed_at !== firstRegistration.renewed_at,
    );
    assert.equal(
      await cacheInternals(cleaner).isRegisteredProcessAlive(
        requiredNumber(writer, "pid"),
        requiredString(writer, "process_nonce"),
        input.digest.replace("sha256:", ""),
      ),
      true,
      JSON.stringify(writer),
    );
    assert.equal((await cleaner.cleanup()).removedTemporaryPaths, 0);
    await access(stage);

    process.kill(requiredNumber(writer, "pid"), "SIGKILL");
    await waitForSignal(
      completion.then(() => undefined),
      "Python writer completion",
      10_000,
    );
    assert.equal((await cleaner.cleanup()).removedTemporaryPaths, 1);
    await assert.rejects(access(stage));
  } finally {
    if (child && completion) await stopRaceWriters([{ child, completion }]);
    await rm(directory, { recursive: true, force: true });
  }
  assert.equal(stderr, "");
});

test("lease renewal conflict fallback publishes a successor before removing the live lease", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-test-"));
  const input = await validFixtureObjectInput();
  let now = new Date("2026-08-25T10:00:00.000Z");

  try {
    const cache = new DiskCache({
      directory,
      now: () => now,
      processNonce: "process-windows-renewal",
      renewIntervalSeconds: 0,
    });
    const lease = await cache.acquireLease(input.digest, "session-windows-renewal");
    const firstPath = lease.path;
    assert.ok(firstPath);
    const renameFile = cacheInternals(cache).renameFile.bind(cache);
    let simulatedConflict = true;
    const successorPrefix = firstPath.replace(/\.json$/u, ".renew-");
    let observedSuccessorPath: string | undefined;
    cacheInternals(cache).renameFile = async (source, destination) => {
      if (destination === firstPath && simulatedConflict) {
        simulatedConflict = false;
        throw errorWithCode("simulated Windows sharing violation", "EPERM");
      }
      await renameFile(source, destination);
      if (
        !simulatedConflict &&
        destination.startsWith(successorPrefix) &&
        destination.endsWith(".json")
      ) {
        assert.equal(observedSuccessorPath, undefined);
        await access(firstPath);
        observedSuccessorPath = destination;
      }
    };

    now = new Date("2026-08-25T10:00:30.000Z");
    await lease.renew();
    assert.equal(simulatedConflict, false);
    assert.ok(observedSuccessorPath);
    assert.equal(observedSuccessorPath, lease.path);
    assert.notEqual(lease.path, firstPath);
    assert.ok(lease.path);
    assert.equal(parseJsonRecord(await readFile(lease.path, "utf8")).renewed_at, now.toISOString());
    await assert.rejects(access(firstPath));
    await lease.release();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("duplicate disk lease handles keep independent pins until both release", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-test-"));
  const input = await validFixtureObjectInput();

  try {
    const cache = new DiskCache({
      directory,
      maxBytes: 0,
      processNonce: "process-duplicate-handles",
      renewIntervalSeconds: 0,
    });
    await cache.publishObject(input);
    const first = await cache.acquireLease(input.digest, "session-duplicate");
    const second = await cache.acquireLease(input.digest, "session-duplicate");
    assert.notEqual(first.path, second.path);
    await first.release();
    assert.deepEqual((await cache.evict()).retainedPinned, [input.digest]);
    assert.ok(await cache.getObject(input.digest));
    await second.release();
    assert.deepEqual((await cache.evict()).evicted, [input.digest]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("stale malformed mutation locks are reclaimed instead of blocking forever", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-test-"));
  const input = await validFixtureObjectInput();
  const hex = input.digest.replace("sha256:", "");
  const lockDirectory = join(directory, "cache-v1", "tmp", "coordination-v1", "locks", hex);
  const lockPath = join(lockDirectory, "malformed-owner.lock");

  try {
    await mkdir(lockDirectory, { recursive: true });
    await writeFile(lockPath, "{\n");
    await utimes(
      lockPath,
      new Date("2026-08-20T10:00:00.000Z"),
      new Date("2026-08-20T10:00:00.000Z"),
    );
    const cache = new DiskCache({
      directory,
      now: () => new Date("2026-08-25T10:00:00.000Z"),
      leaseExpirySeconds: 120,
    });

    await cacheInternals(cache).reclaimStaleMutationLock(lockPath);
    await assert.rejects(access(lockPath));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("stale mutation-lock cleanup preserves a final-window unique successor", async () => {
  const race = await startPausedStaleMutationLockCleanup(
    "remote-skills-cache-gate-rewrite-",
    "same-inode",
  );
  const successorPath = join(
    race.lockDirectory,
    "0000000000000001-successor-owner-same-ticket.lock",
  );
  const successor = mutationLockRecord({
    processNonce: "successor-process-same-inode",
    ownerNonce: "successor-owner-same-inode",
    createdAt: "2040-01-01T00:00:00.000Z",
  });

  try {
    await writeFile(successorPath, successor);
    race.resumeLiveness.resolve();
    await race.cleanup;

    await assert.rejects(access(race.lockPath));
    assert.equal(await readFile(successorPath, "utf8"), successor);
  } finally {
    race.resumeLiveness.resolve();
    await Promise.allSettled([race.cleanup]);
    await rm(race.directory, { recursive: true, force: true });
  }
});

test("stale malformed known-schema mutation intents are reclaimed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-gate-malformed-intent-"));
  const input = await validFixtureObjectInput();
  const hex = input.digest.replace("sha256:", "");
  const lockDirectory = join(directory, "cache-v1", "tmp", "coordination-v1", "locks", hex);
  const path = join(lockDirectory, "malformed-owner.intent");
  try {
    await mkdir(lockDirectory, { recursive: true });
    await writeFile(path, '{"schema":"remote-skills-cache-mutation-intent-v1"}\n');
    await utimes(path, new Date("2026-08-20T10:00:00.000Z"), new Date("2026-08-20T10:00:00.000Z"));
    const cache = new ReviewDiskCache({
      directory,
      now: () => new Date("2026-08-25T10:00:00.000Z"),
      leaseExpirySeconds: 120,
    });
    await cacheInternals(cache).reclaimStaleMutationLock(path);
    await assert.rejects(access(path));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("stale mutation locks are reclaimed when a live PID has no matching registration nonce", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-test-"));
  const input = await validFixtureObjectInput();
  const hex = input.digest.replace("sha256:", "");
  const lockDirectory = join(directory, "cache-v1", "tmp", "coordination-v1", "locks", hex);
  const lockPath = join(lockDirectory, "0000000000000001-owner-stale-before-pid-reuse.lock");
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], {
    stdio: "ignore",
  });
  const completion = observeChildCompletion(child);

  try {
    assert.ok(child.pid);
    await mkdir(lockDirectory, { recursive: true });
    await writeFile(
      lockPath,
      `${JSON.stringify(
        {
          schema: "remote-skills-cache-mutation-lock-v1",
          pid: child.pid,
          process_nonce: "process-stale-before-pid-reuse",
          owner_nonce: "owner-stale-before-pid-reuse",
          ticket: 1,
          created_at: "2026-08-20T10:00:00.000Z",
        },
        null,
        2,
      )}\n`,
    );
    const cache = new DiskCache({
      directory,
      now: () => new Date("2026-08-25T10:00:00.000Z"),
      leaseExpirySeconds: 120,
      processNonce: "process-current-cleaner",
    });

    await cacheInternals(cache).reclaimStaleMutationLock(lockPath);
    await assert.rejects(access(lockPath));
  } finally {
    await stopRaceWriters([{ child, completion }]);
    await rm(directory, { recursive: true, force: true });
  }
});

test("cleanup consumes crashed-lease inputs, retains the object, and isolates unknown layouts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-test-"));
  const crashedRoot = new URL("fixtures/cache/states/crashed-lease/", protocolRoot);
  const unknownRoot = new URL("fixtures/cache/states/unknown-layout/", protocolRoot);
  const inputs = await readProtocolJson(
    "fixtures/cache/states/crashed-lease/evaluation-inputs.json",
  );
  const expected = required(
    (await readProtocolJson("expected-results/cache-results.json")).cases,
    "cache expected cases",
  ).find(({ id }) => id === "cache-v1-crashed-lease");
  assert.ok(expected);
  const fixtureNow = required(inputs.now, "cache fixture time");
  const leaseExpirySeconds = required(inputs.lease_expiry_seconds, "lease expiry seconds");
  const processLiveness = required(inputs.process_liveness, "process liveness");

  try {
    await cp(new URL("cache-v1", crashedRoot), join(directory, "cache-v1"), { recursive: true });
    await cp(new URL("cache-v2", unknownRoot), join(directory, "cache-v2"), { recursive: true });
    const cache = new DiskCache({
      directory,
      now: () => new Date(fixtureNow),
      leaseExpirySeconds,
      isProcessAlive: (pid) => processLiveness[String(pid)] ?? true,
    });

    const result = await cache.cleanup();
    assert.equal(result.reclaimedLeases, 1);
    assert.equal(required(expected.result.object_retained, "expected object retention"), true);
    assert.ok(await cache.getObject((await validFixtureObjectInput()).digest));
    assert.equal(
      await readFile(join(directory, "cache-v2", "DO-NOT-TOUCH.txt"), "utf8"),
      await readFile(new URL("cache-v2/DO-NOT-TOUCH.txt", unknownRoot), "utf8"),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("expired lease cleanup passes process_nonce to liveness checks to detect PID reuse", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-test-"));
  const crashedRoot = new URL("fixtures/cache/states/crashed-lease/", protocolRoot);

  try {
    await cp(new URL("cache-v1", crashedRoot), join(directory, "cache-v1"), { recursive: true });
    const seenIdentities: Array<[number, string | undefined]> = [];
    const cache = new DiskCache({
      directory,
      now: () => new Date("2026-08-25T10:00:45.000Z"),
      leaseExpirySeconds: 120,
      isProcessAlive: (pid, processNonce) => {
        seenIdentities.push([pid, processNonce]);
        return processNonce === undefined;
      },
    });

    assert.equal((await cache.cleanup()).reclaimedLeases, 1);
    assert.deepEqual(seenIdentities, [[999999, "process-fixture-dead"]]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("cleanup ignores readers' temporary state then removes only stale private writers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-test-"));
  const partialRoot = new URL("fixtures/cache/states/partial-writer/cache-v1", protocolRoot);
  const writerPath = join(directory, "cache-v1", "tmp", "writer-typescript-0001");

  try {
    await cp(partialRoot, join(directory, "cache-v1"), { recursive: true });
    await utimes(
      writerPath,
      new Date("2026-08-20T10:00:00.000Z"),
      new Date("2026-08-20T10:00:00.000Z"),
    );
    const before = new DiskCache({
      directory,
      now: () => new Date("2026-08-20T10:00:30.000Z"),
      temporaryExpirySeconds: 120,
    });
    assert.equal((await before.cleanup()).removedTemporaryPaths, 0);
    await access(writerPath);

    const after = new DiskCache({
      directory,
      now: () => new Date("2026-08-25T10:00:00.000Z"),
      temporaryExpirySeconds: 120,
    });
    assert.equal((await after.cleanup()).removedTemporaryPaths, 1);
    await assert.rejects(access(writerPath));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("bounded disk LRU evicts eligible objects but never an active pin", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-test-"));
  const first = await validFixtureObjectInput();
  const objectBytes = first.artifact.byteLength + requiredSkillBytes(first).byteLength;
  const otherBytes = new TextEncoder().encode("another verified object");
  const otherDigest = `sha256:${createHash("sha256").update(otherBytes).digest("hex")}`;

  try {
    const cache = new DiskCache({
      directory,
      maxBytes: objectBytes,
      maxAgeSeconds: 30 * 24 * 60 * 60,
      now: () => new Date("2026-08-25T10:02:00.000Z"),
      processNonce: "process-test",
      renewIntervalSeconds: 0,
    });
    await cache.publishObject(first);
    const lease = await cache.acquireLease(first.digest, "session-test");
    await cache.publishObject({
      ...first,
      digest: otherDigest,
      artifact: otherBytes,
      files: new Map([["SKILL.md", otherBytes]]),
      verifiedAt: "2026-08-25T10:01:00.000Z",
      accessedAt: "2026-08-25T10:01:00.000Z",
    });

    const result = await cache.evict();
    assert.deepEqual(result.retainedPinned, [first.digest]);
    assert.deepEqual(result.evicted, [otherDigest]);
    assert.ok(await cache.getObject(first.digest));
    assert.equal(await cache.getObject(otherDigest), null);

    const eviction = parseJsonRecord(
      await readFile(join(directory, "cache-v1", "eviction.json"), "utf8"),
    );
    assert.deepEqual(eviction, {
      schema: "remote-skills-eviction-metadata-v1",
      last_run_at: "2026-08-25T10:02:00.000Z",
      max_bytes: objectBytes,
      max_age_seconds: 30 * 24 * 60 * 60,
      candidate_order: ["accessed_at", "digest"],
    });
    await lease.release();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a lease acquired after eviction's snapshot prevents the object removal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-test-"));
  const input = await validFixtureObjectInput();

  try {
    const cache = new DiskCache({
      directory,
      maxBytes: 0,
      now: () => new Date("2026-08-25T10:02:00.000Z"),
      processNonce: "process-racing-pin",
      renewIntervalSeconds: 0,
    });
    await cache.publishObject(input);
    const removeObject = cacheInternals(cache).removeObject.bind(cache);
    let lease: Awaited<ReturnType<DiskCache["acquireLease"]>> | undefined;
    cacheInternals(cache).removeObject = async (digest, scanBudget) => {
      lease = await cache.acquireLease(digest, "session-racing-pin");
      return removeObject(digest, scanBudget);
    };

    const result = await cache.evict();
    assert.deepEqual(result.evicted, []);
    assert.ok(await cache.getObject(input.digest));
    assert.ok(lease);
    await lease.release();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("lease acquisition fails when a winning eviction disappears before its first turn scan", {
  timeout: 10_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-eviction-handoff-"));
  const input = await validFixtureObjectInput();
  const evictionPaused = deferred();
  const releaseEviction = deferred();
  const acquisitionPaused = deferred();
  const releaseAcquisition = deferred();
  let eviction: CacheEviction | undefined;
  let acquisition: CacheLeaseAcquisition | undefined;
  try {
    const publisher = new ReviewDiskCache({ directory, renewIntervalSeconds: 0 });
    await publisher.publishObject(input);
    const evictor = new ReviewDiskCache({
      directory,
      maxBytes: 0,
      maxAgeSeconds: 0,
      renewIntervalSeconds: 0,
      coordinationHooks: {
        beforeObjectEvictionCommit: async () => {
          evictionPaused.resolve();
          await releaseEviction.promise;
        },
      },
    });
    const acquirer = new ReviewDiskCache({ directory, renewIntervalSeconds: 0 });
    const mutationTurnState = cacheInternals(acquirer).mutationTurnState.bind(acquirer);
    let firstTurn = true;
    cacheInternals(acquirer).mutationTurnState = async (...args) => {
      if (firstTurn) {
        firstTurn = false;
        acquisitionPaused.resolve();
        await releaseAcquisition.promise;
      }
      return mutationTurnState(...args);
    };

    eviction = evictor.evict();
    await waitForSignal(evictionPaused.promise, "eviction removal pause");
    acquisition = acquirer.acquireLease(input.digest, "session-disappearing-eviction");
    await waitForSignal(acquisitionPaused.promise, "acquisition first-turn pause");
    const gateDirectory = join(
      directory,
      "cache-v1",
      "tmp",
      "coordination-v1",
      "locks",
      input.digest.replace("sha256:", ""),
    );
    const handoffRecords = [];
    for (const name of await readdir(gateDirectory)) {
      if (!name.endsWith(".intent") && !name.endsWith(".lock")) continue;
      const value = parseJsonRecord(await readFile(join(gateDirectory, name), "utf8"));
      if (value.contended_with_eviction === true) handoffRecords.push(value.schema);
    }
    assert.deepEqual(handoffRecords, ["remote-skills-cache-mutation-lock-v1"]);

    releaseEviction.resolve();
    assert.deepEqual((await eviction).evicted, [input.digest]);
    const hex = input.digest.replace("sha256:", "");
    await assert.rejects(
      access(join(directory, "cache-v1", "objects", "sha256", hex.slice(0, 2), hex.slice(2))),
      (error) => errorCode(error) === "ENOENT",
    );
    releaseAcquisition.resolve();

    await assert.rejects(acquisition, (error) => errorCode(error) === "cache_corrupt");
    const leaseDirectory = join(
      directory,
      "cache-v1",
      "leases",
      input.digest.replace("sha256:", ""),
    );
    const leaseEntries = await readdir(leaseDirectory).catch((error) => {
      if (errorCode(error) === "ENOENT") return [];
      throw error;
    });
    assert.equal(
      leaseEntries.some((name) => name.endsWith(".json") && !name.startsWith(".")),
      false,
    );
  } finally {
    releaseEviction.resolve();
    releaseAcquisition.resolve();
    await Promise.allSettled([eviction, acquisition].filter(Boolean));
    await rm(directory, { recursive: true, force: true });
  }
});

test("lease acquisition fails when eviction starts after its prepublication scan", {
  timeout: 10_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-eviction-scan-gap-"));
  const input = await validFixtureObjectInput();
  const scanCompleted = deferred();
  const releaseAcquisition = deferred();
  let acquisition: CacheLeaseAcquisition | undefined;
  try {
    const publisher = new ReviewDiskCache({ directory, renewIntervalSeconds: 0 });
    await publisher.publishObject(input);
    const acquirer = new ReviewDiskCache({ directory, renewIntervalSeconds: 0 });
    const openObjectGenerationGuard =
      cacheInternals(acquirer).openObjectGenerationGuard.bind(acquirer);
    let firstScan = true;
    cacheInternals(acquirer).openObjectGenerationGuard = async (...args) => {
      const result = await openObjectGenerationGuard(...args);
      if (firstScan) {
        firstScan = false;
        scanCompleted.resolve();
        await releaseAcquisition.promise;
      }
      return result;
    };

    acquisition = acquirer.acquireLease(input.digest, "session-eviction-scan-gap");
    await waitForSignal(scanCompleted.promise, "acquisition prepublication scan");
    const evictor = new ReviewDiskCache({
      directory,
      maxBytes: 0,
      maxAgeSeconds: 0,
      renewIntervalSeconds: 0,
    });
    assert.deepEqual((await evictor.evict()).evicted, [input.digest]);
    releaseAcquisition.resolve();

    await assert.rejects(acquisition, (error) => errorCode(error) === "cache_corrupt");
    const leaseDirectory = join(
      directory,
      "cache-v1",
      "leases",
      input.digest.replace("sha256:", ""),
    );
    const leaseEntries = await readdir(leaseDirectory).catch((error) => {
      if (errorCode(error) === "ENOENT") return [];
      throw error;
    });
    assert.equal(
      leaseEntries.some((name) => name.endsWith(".json") && !name.startsWith(".")),
      false,
    );
  } finally {
    releaseAcquisition.resolve();
    await Promise.allSettled([acquisition].filter(Boolean));
    await rm(directory, { recursive: true, force: true });
  }
});

test("lease generation recheck rejects an object ancestor pivot preserving leaf identity", {
  timeout: 10_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-object-anchor-swap-"));
  const input = await validFixtureObjectInput();
  try {
    const publisher = new ReviewDiskCache({ directory, renewIntervalSeconds: 0 });
    await publisher.publishObject(input);
    const acquirer = new ReviewDiskCache({ directory, renewIntervalSeconds: 0 });
    const hex = input.digest.replace("sha256:", "");
    const objectDirectory = join(
      directory,
      "cache-v1",
      "objects",
      "sha256",
      hex.slice(0, 2),
      hex.slice(2),
    );
    const objectsDirectory = join(directory, "cache-v1", "objects");
    const parkedObjects = join(directory, "parked-objects");
    const artifactBefore = await readFile(join(objectDirectory, "artifact"));
    const validateObjectGenerationGuard =
      cacheInternals(acquirer).validateObjectGenerationGuard.bind(acquirer);
    let pivoted = false;
    cacheInternals(acquirer).validateObjectGenerationGuard = async (guard) => {
      if (!pivoted) {
        pivoted = true;
        await rename(objectsDirectory, parkedObjects);
        await symlink(
          parkedObjects,
          objectsDirectory,
          process.platform === "win32" ? "junction" : "dir",
        );
      }
      return validateObjectGenerationGuard(guard);
    };

    await assert.rejects(
      acquirer.acquireLease(input.digest, "session-object-anchor-swap"),
      (error) => errorCode(error) === "cache_corrupt",
    );
    assert.deepEqual(
      await readFile(join(parkedObjects, "sha256", hex.slice(0, 2), hex.slice(2), "artifact")),
      artifactBefore,
    );
    const leaseDirectory = join(directory, "cache-v1", "leases", hex);
    const leaseEntries = await readdir(leaseDirectory).catch((error) => {
      if (errorCode(error) === "ENOENT") return [];
      throw error;
    });
    assert.equal(
      leaseEntries.some((name) => name.endsWith(".json")),
      false,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("lease generation guard rejects a 64-bit identity collision after deletion and republish", async () => {
  const helper = fileURLToPath(new URL("helpers/bigint-directory-identity.ts", import.meta.url));
  const child = spawn(process.execPath, ["--experimental-test-module-mocks", helper], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const code = await new Promise<number | null>((resolve) =>
    child.once("exit", (exitCode) => resolve(exitCode)),
  );
  assert.equal(code, 0, stderr);
});

test("lease generation guard permits legitimate and initially absent object paths", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-object-anchor-normal-"));
  const input = await validFixtureObjectInput();
  try {
    const cache = new ReviewDiskCache({ directory, renewIntervalSeconds: 0 });
    await cache.publishObject(input);
    const existingLease = await cache.acquireLease(input.digest, "session-object-anchor-existing");
    await existingLease.release();

    const absentDigest = `sha256:${createHash("sha256").update("absent-object-anchor").digest("hex")}`;
    const absentLease = await cache.acquireLease(absentDigest, "session-object-anchor-absent");
    await absentLease.release();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("disk eviction orders unpinned objects by persisted access time without touching candidates", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-test-"));
  const first = await validFixtureObjectInput();
  const objectBytes = first.artifact.byteLength + requiredSkillBytes(first).byteLength;
  const otherBytes = new TextEncoder().encode("another verified object");
  const otherDigest = `sha256:${createHash("sha256").update(otherBytes).digest("hex")}`;

  try {
    const cache = new DiskCache({
      directory,
      maxBytes: objectBytes,
      now: () => new Date("2026-08-25T10:02:00.000Z"),
    });
    const { verifiedAt: _verifiedAt, accessedAt: _accessedAt, ...withoutTimes } = first;
    const firstPublished = await cache.publishObject(withoutTimes);
    assert.equal(firstPublished.metadata.verifiedAt, "2026-08-25T10:02:00.000Z");
    firstPublished.metadata.accessedAt = "2026-08-25T10:00:00.000Z";
    const hex = first.digest.replace("sha256:", "");
    const metadataPath = join(
      directory,
      "cache-v1",
      "objects",
      "sha256",
      hex.slice(0, 2),
      hex.slice(2),
      "object.json",
    );
    const firstMetadata = parseJsonRecord(await readFile(metadataPath, "utf8"));
    firstMetadata.accessed_at = "2026-08-25T10:00:00.000Z";
    await writeFile(metadataPath, `${JSON.stringify(firstMetadata, null, 2)}\n`);
    await cache.publishObject({
      ...first,
      digest: otherDigest,
      artifact: otherBytes,
      files: new Map([["SKILL.md", otherBytes]]),
      verifiedAt: "2026-08-25T10:01:00.000Z",
      accessedAt: "2026-08-25T10:01:00.000Z",
    });

    const result = await cache.evict();
    assert.deepEqual(result.evicted, [first.digest]);
    assert.equal(await cache.getObject(first.digest), null);
    assert.ok(await cache.getObject(otherDigest));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("lease cleanup rechecks a peer renewal before owner-safe unlink", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-test-"));
  const input = await validFixtureObjectInput();
  let now = new Date("2026-08-25T10:00:00.000Z");
  let hookCalled = false;

  try {
    const owner = new DiskCache({
      directory,
      now: () => now,
      pid: 919_191,
      processNonce: "process-cleanup-race-owner",
      leaseExpirySeconds: 10,
      renewIntervalSeconds: 0,
    });
    const lease = await owner.acquireLease(input.digest, "session-cleanup-race");
    assert.ok(lease.path);
    now = new Date("2026-08-25T10:00:20.000Z");
    const cleaner = new DiskCache({
      directory,
      now: () => now,
      leaseExpirySeconds: 10,
      renewIntervalSeconds: 0,
      isProcessAlive: () => false,
      coordinationHooks: {
        beforeLeaseCleanupUnlink: async (path) => {
          hookCalled = true;
          const renewed = parseJsonRecord(await readFile(path, "utf8"));
          renewed.renewed_at = now.toISOString();
          const successor = `${path}.peer-renewal`;
          await writeFile(successor, `${JSON.stringify(renewed, null, 2)}\n`);
          await rename(successor, path);
        },
      },
    });

    assert.equal((await cleaner.cleanup()).reclaimedLeases, 0);
    assert.equal(hookCalled, true);
    assert.equal(parseJsonRecord(await readFile(lease.path, "utf8")).renewed_at, now.toISOString());
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("publication waits for digest eviction coordination and republishes after removal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-test-"));
  const input = await validFixtureObjectInput();
  const evictionEntered = deferred();
  const releaseEviction = deferred();

  try {
    const cache = new DiskCache({
      directory,
      maxBytes: 0,
      renewIntervalSeconds: 0,
      coordinationHooks: {
        beforeObjectEvictionCommit: async () => {
          evictionEntered.resolve();
          await releaseEviction.promise;
        },
      },
    });
    await cache.publishObject(input);
    const eviction = cache.evict();
    const first = await Promise.race([
      evictionEntered.promise.then(() => "entered"),
      eviction.then(() => "finished"),
    ]);
    assert.equal(first, "entered");

    let publicationSettled = false;
    const publication = cache.publishObject(input).finally(() => {
      publicationSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(publicationSettled, false);
    releaseEviction.resolve();

    assert.deepEqual((await eviction).evicted, [input.digest]);
    assert.equal((await publication).metadata.digest, input.digest);
    assert.ok(await cache.getObject(input.digest));
  } finally {
    releaseEviction.resolve();
    await rm(directory, { recursive: true, force: true });
  }
});

test("disk and memory publish detached structural ReadonlyMap and native Map inputs", async (t) => {
  for (const backend of ["disk", "memory"]) {
    for (const structural of [true, false]) {
      await t.test(
        `${backend} with ${structural ? "ReadonlyMap wrapper" : "native Map"}`,
        async () => {
          const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-test-"));
          try {
            const source = skillInput("# ordinary map publication\n");
            const original = new Uint8Array(source.artifact);
            const input: PublishObjectInput = {
              ...source,
              files: structural ? immutableMap(source.files) : source.files,
              mediaTypes: structural ? immutableMap(source.mediaTypes) : source.mediaTypes,
            };
            const snapshot = snapshotPublishObjectInput(input);
            assert.notEqual(snapshot.files, input.files);
            assert.notEqual(snapshot.mediaTypes, input.mediaTypes);
            assert.notEqual(snapshot.files.get("SKILL.md"), input.files.get("SKILL.md"));
            const cache = backend === "disk" ? new DiskCache({ directory }) : new MemoryCache();
            const published = await cache.publishObject(input);
            source.artifact.fill(0);
            source.files.clear();
            source.mediaTypes.clear();
            assert.deepEqual(snapshot.artifact, original);
            assert.deepEqual(snapshot.files.get("SKILL.md"), original);
            assert.equal(snapshot.mediaTypes.get("SKILL.md"), "text/markdown");
            assert.deepEqual(published.artifact, original);
            assert.deepEqual(published.root.get("SKILL.md"), original);
            assert.equal(published.metadata.files.at(0)?.mediaType, "text/markdown");
            published.artifact.fill(0);
            published.root.get("SKILL.md")?.fill(0);
            const cached = await cache.getObject(input.digest);
            assert.deepEqual(cached?.artifact, original);
            assert.deepEqual(cached?.root.get("SKILL.md"), original);
          } finally {
            await rm(directory, { recursive: true, force: true });
          }
        },
      );
    }
  }
});

test("publication snapshots sanitize ordinary ReadonlyMap iterator exceptions", () => {
  const source = skillInput("# ordinary iterator failure\n");
  let iteratorCalls = 0;
  const failingFiles: ReadonlyMap<string, Uint8Array> = {
    ...immutableMap(source.files),
    [Symbol.iterator]() {
      iteratorCalls += 1;
      throw new Error("iterator unavailable");
    },
  };
  const failingMediaTypes: ReadonlyMap<string, string> = {
    ...immutableMap(source.mediaTypes),
    [Symbol.iterator]() {
      iteratorCalls += 1;
      throw new Error("iterator unavailable");
    },
  };
  for (const input of [
    { ...source, files: failingFiles },
    { ...source, mediaTypes: failingMediaTypes },
  ]) {
    assert.throws(() => snapshotPublishObjectInput(input), {
      name: "CacheCorruptError",
      code: "cache_corrupt",
      message: "cache object publication input is corrupt",
    });
  }
  assert.equal(iteratorCalls, 2);
});

test("disk and memory publication snapshot caller state and isolate custom verifier mutation", async () => {
  for (const backend of ["disk", "memory"]) {
    const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-test-"));
    const input = archiveInput();
    const originalArtifact = new Uint8Array(input.artifact);
    const originalSkill = new Uint8Array(requiredSkillBytes(input));
    const verifierEntered = deferred();
    const releaseVerifier = deferred();
    let verifierCalls = 0;
    const verifyExtractedContents: ExtractedContentsVerifier = async (candidate) => {
      verifierCalls += 1;
      if (verifierCalls === 1) {
        const artifactByte = candidate.artifact.at(0);
        const candidateSkill = candidate.root.get("SKILL.md");
        const candidateSkillByte = candidateSkill?.at(0);
        const metadataFile = candidate.metadata.files.at(0);
        assert.ok(
          artifactByte !== undefined &&
            candidateSkill !== undefined &&
            candidateSkillByte !== undefined &&
            metadataFile !== undefined,
        );
        candidate.artifact[0] = artifactByte ^ 1;
        candidateSkill[0] = candidateSkillByte ^ 1;
        metadataFile.mediaType = "application/mutated";
        verifierEntered.resolve();
        await releaseVerifier.promise;
      }
      return true;
    };
    const cache =
      backend === "disk"
        ? new DiskCache({ directory, verifyExtractedContents })
        : new MemoryCache({ verifyExtractedContents });

    try {
      const publication = cache.publishObject(input);
      await verifierEntered.promise;
      const inputArtifactByte = input.artifact.at(0);
      const inputSkill = requiredSkillBytes(input);
      const inputSkillByte = inputSkill.at(0);
      assert.ok(inputArtifactByte !== undefined && inputSkillByte !== undefined);
      input.artifact[0] = inputArtifactByte ^ 1;
      inputSkill[0] = inputSkillByte ^ 1;
      input.mediaTypes.set("SKILL.md", "application/caller-mutated");
      input.artifactType = "caller-mutated";
      input.verifiedAt = "caller-mutated";
      releaseVerifier.resolve();

      const published = await publication;
      assert.deepEqual(published.artifact, originalArtifact, backend);
      assert.deepEqual(published.root.get("SKILL.md"), originalSkill, backend);
      assert.equal(published.metadata.artifactType, "archive", backend);
      assert.equal(published.metadata.files.at(0)?.mediaType, "text/markdown", backend);
      assert.equal(published.metadata.verifiedAt, "2026-08-25T10:00:00.000Z", backend);
    } finally {
      releaseVerifier.resolve();
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("catalog and lease mutation guards reject deterministic ancestor swaps", async () => {
  const input = await validFixtureObjectInput();
  for (const operation of ["catalog", "lease"]) {
    const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-test-"));
    const outside = await mkdtemp(join(tmpdir(), "remote-skills-cache-outside-"));
    let swapped = false;
    const swap = async (name: string): Promise<void> => {
      if (swapped) return;
      swapped = true;
      const path = join(directory, "cache-v1", name);
      await rename(path, `${path}.owned`);
      await symlink(outside, path, process.platform === "win32" ? "junction" : "dir");
    };
    const cache = new DiskCache({
      directory,
      renewIntervalSeconds: 0,
      coordinationHooks: {
        beforeCatalogCommit: () => swap("catalogs"),
        beforeLeaseWrite: () => swap("leases"),
      },
    });

    try {
      const action =
        operation === "catalog"
          ? cache.putCatalog(
              "https://skills.example.test/.well-known/agent-skills/index.json",
              new TextEncoder().encode('{"skills":[]}\n'),
              {
                retrievedAt: "2026-08-25T10:00:00.000Z",
                validatedAt: "2026-08-25T10:00:00.000Z",
              },
            )
          : cache.acquireLease(input.digest, "session-ancestor-swap");
      await assert.rejects(action, (error) => errorCode(error) === "cache_corrupt");
      assert.equal(swapped, true);
      assert.deepEqual(await readdir(outside), []);
    } finally {
      await rm(directory, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  }
});

test("temporary cleanup and object deletion reject deterministic ancestor swaps", async () => {
  for (const operation of ["temporary", "object"]) {
    const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-test-"));
    const outside = await mkdtemp(join(tmpdir(), "remote-skills-cache-outside-"));
    const input = await validFixtureObjectInput();
    let swapped = false;
    const cache = new DiskCache({
      directory,
      maxBytes: 0,
      now: () => new Date("2026-08-25T10:00:00.000Z"),
      coordinationHooks: {
        beforeTemporaryCleanup: async () => {
          if (operation !== "temporary" || swapped) return;
          swapped = true;
          const path = join(directory, "cache-v1", "tmp");
          await rename(path, `${path}.owned`);
          await symlink(outside, path, process.platform === "win32" ? "junction" : "dir");
        },
        beforeObjectEvictionCommit: async () => {
          if (operation !== "object" || swapped) return;
          swapped = true;
          const path = join(directory, "cache-v1", "objects");
          await rename(path, `${path}.owned`);
          await symlink(outside, path, process.platform === "win32" ? "junction" : "dir");
        },
      },
    });

    try {
      if (operation === "temporary") {
        const writer = join(directory, "cache-v1", "tmp", "writer-stale");
        await mkdir(writer, { recursive: true });
        await writeFile(join(writer, "writer.json"), "{}\n");
        await utimes(
          writer,
          new Date("2026-08-20T10:00:00.000Z"),
          new Date("2026-08-20T10:00:00.000Z"),
        );
        await assert.rejects(cache.cleanup(), (error) => errorCode(error) === "cache_corrupt");
      } else {
        await cache.publishObject(input);
        await assert.rejects(cache.evict(), (error) => errorCode(error) === "cache_corrupt");
      }
      assert.equal(swapped, true);
      assert.deepEqual(await readdir(outside), []);
    } finally {
      await rm(directory, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  }
});

test("persisted lease and mutation-lock identities reject unsafe nonces and non-positive PIDs", async () => {
  const input = await validFixtureObjectInput();
  for (const invalid of [
    { field: "process_nonce", value: "../escape" },
    { field: "session_nonce", value: "../escape" },
    { field: "pid", value: 0 },
  ]) {
    const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-test-"));
    try {
      const owner = new DiskCache({
        directory,
        processNonce: "process-persisted-validation",
        renewIntervalSeconds: 0,
      });
      const lease = await owner.acquireLease(input.digest, "session-persisted-validation");
      assert.ok(lease.path);
      const persisted = parseJsonRecord(await readFile(lease.path, "utf8"));
      persisted[invalid.field] = invalid.value;
      await writeFile(lease.path, `${JSON.stringify(persisted, null, 2)}\n`);
      const cleaner = new DiskCache({
        directory,
        now: () => new Date("2030-08-25T10:00:00.000Z"),
        isProcessAlive: () => false,
      });
      await assert.rejects(cleaner.cleanup(), (error) => errorCode(error) === "cache_corrupt");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-test-"));
  const hex = input.digest.replace("sha256:", "");
  const lockDirectory = join(directory, "cache-v1", "tmp", "coordination-v1", "locks", hex);
  const lockPath = join(lockDirectory, "0000000000000001-owner-valid.lock");
  try {
    await mkdir(lockDirectory, { recursive: true });
    await writeFile(
      lockPath,
      `${JSON.stringify({
        schema: "remote-skills-cache-mutation-lock-v1",
        pid: 1,
        process_nonce: "../escape",
        owner_nonce: "owner-valid",
        ticket: 1,
        created_at: "2040-08-20T10:00:00.000Z",
      })}\n`,
    );
    await utimes(
      lockPath,
      new Date("2020-01-01T00:00:00.000Z"),
      new Date("2020-01-01T00:00:00.000Z"),
    );
    const cache = new DiskCache({
      directory,
      now: () => new Date("2026-08-25T10:00:00.000Z"),
    });
    await cacheInternals(cache).reclaimStaleMutationLock(lockPath);
    await assert.rejects(access(lockPath));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("long-held digest locks heartbeat their registered owner and are not stolen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-test-"));
  const input = await validFixtureObjectInput();
  const entered = deferred();
  const release = deferred();
  let now = new Date("2026-08-25T10:00:00.000Z");

  try {
    const owner = new DiskCache({
      directory,
      now: () => now,
      leaseExpirySeconds: 1,
      renewIntervalSeconds: 10,
      processNonce: "process-long-lock-owner",
    });
    const held = cacheInternals(owner).withDigestLock(input.digest, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    now = new Date("2026-08-25T10:00:02.000Z");
    await new Promise((resolve) => setTimeout(resolve, 750));
    const lockPath = await currentMutationLockPath(directory, input.digest);
    const lock = parseJsonRecord(await readFile(lockPath, "utf8"));
    assert.match(requiredString(lock, "owner_nonce"), /^[A-Za-z0-9._-]{1,128}$/u);

    const cleaner = new DiskCache({
      directory,
      now: () => now,
      leaseExpirySeconds: 1,
      processNonce: "process-long-lock-cleaner",
    });
    await cacheInternals(cleaner).reclaimStaleMutationLock(lockPath);
    await access(lockPath);
    release.resolve();
    await held;
  } finally {
    release.resolve();
    await rm(directory, { recursive: true, force: true });
  }
});

test("registration cleanup cannot unlink a newer same-process owner heartbeat", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-test-"));
  const input = await validFixtureObjectInput();
  const hex = input.digest.replace("sha256:", "");
  const registrationPath = join(
    directory,
    "cache-v1",
    "tmp",
    "coordination-v1",
    "processes",
    hex,
    "process-shared-instance.json",
  );

  try {
    const first = new DiskCache({
      directory,
      processNonce: "process-shared-instance",
      renewIntervalSeconds: 0,
    });
    const second = new DiskCache({
      directory,
      processNonce: "process-shared-instance",
      renewIntervalSeconds: 0,
    });
    await cacheInternals(first).writeProcessRegistration(hex);
    const firstIdentity = await lstat(registrationPath);
    await cacheInternals(second).writeProcessRegistration(hex);
    const secondIdentity = await lstat(registrationPath);
    assert.notEqual(firstIdentity.ino, secondIdentity.ino);

    await cacheInternals(first).removeOwnRegistrationIfUnleased(hex, firstIdentity);
    assert.equal((await lstat(registrationPath)).ino, secondIdentity.ino);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("portable path policy rejects C0 and DEL code points consistently with activation", () => {
  for (const point of [...Array.from({ length: 0x20 }, (_, index) => index), 0x7f]) {
    const candidate = `references/guide${String.fromCodePoint(point)}.md`;
    assert.throws(() => validatePortablePaths([candidate]), CacheCorruptError);
    assert.equal(normalizedArchivePath(candidate), null);
  }
  for (const candidate of ["SKILL.md", "references/guide ~.md", "references/café.md"]) {
    assert.deepEqual(validatePortablePaths([candidate]), [candidate]);
    assert.equal(normalizedArchivePath(candidate)?.path, candidate);
  }
});

test("portable collisions use pinned Unicode casefold semantics", async () => {
  for (const paths of [
    ["Straße.txt", "STRASSE.txt"],
    ["Σ.txt", "ς.txt"],
  ]) {
    assert.throws(
      () => validatePortablePaths(paths),
      (error) => errorCode(error) === "cache_corrupt",
    );
  }
  assert.equal(pinnedUnicodeCaseFold("\u1c89"), "\u1c89");
  assert.throws(
    () => validatePortablePaths(["references/e\u0301.txt"]),
    (error) => errorCode(error) === "cache_corrupt",
  );

  const digest = createHash("sha256");
  for (let codePoint = 0; codePoint <= 0x10ffff; codePoint += 1) {
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) continue;
    digest.update(
      `${codePoint.toString(16)};${pinnedUnicodeCaseFold(String.fromCodePoint(codePoint))}\n`,
    );
  }
  assert.equal(
    digest.digest("hex"),
    "30cd34c5c42b505aaa96c4694785ad1fd6dbcd026243f34f1d71ee1f3ac80007",
  );
});

test("multi-file metadata uses canonical UTF-8 byte order in memory and on disk", async () => {
  const input = archiveInput();
  const expected = [...input.files.keys()].sort((left, right) =>
    Buffer.compare(Buffer.from(left), Buffer.from(right)),
  );
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-test-"));
  try {
    const disk = new DiskCache({ directory, verifyExtractedContents: () => true });
    const memory = new MemoryCache({ verifyExtractedContents: () => true });
    assert.deepEqual(
      (await disk.publishObject(input)).metadata.files.map(({ path }) => path),
      expected,
    );
    assert.deepEqual(
      (await memory.publishObject(input)).metadata.files.map(({ path }) => path),
      expected,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("automatic renewal intervals never exceed the Node timer delay limit", async () => {
  const cache = new DiskCache({
    leaseExpirySeconds: Number.MAX_SAFE_INTEGER,
    renewIntervalSeconds: Number.MAX_SAFE_INTEGER,
  });
  assert.ok(cache.renewIntervalSeconds * 1_000 <= 2_147_483_647);
});

test("object eviction detects an immediate ancestor ABA and restores its quarantine", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-test-"));
  const input = await validFixtureObjectInput();
  let swapped = false;
  try {
    const cache = new DiskCache({
      directory,
      maxBytes: 0,
      coordinationHooks: {
        afterObjectEvictionQuarantine: async () => {
          swapped = true;
          const objects = join(directory, "cache-v1", "objects");
          const parked = `${objects}.aba`;
          await rename(objects, parked);
          await rename(parked, objects);
        },
      },
    });
    await cache.publishObject(input);

    await assert.rejects(cache.evict(), (error) => errorCode(error) === "cache_corrupt");
    assert.equal(swapped, true);
    assert.ok(await cache.getObject(input.digest));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("object eviction never restores a partially deleted quarantine to the public cache", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-object-quarantine-"));
  const input = await validFixtureObjectInput();
  let enlarged = false;
  try {
    await new ReviewDiskCache({ directory }).publishObject(input);
    const cache = new ReviewDiskCache({
      directory,
      maxBytes: 0,
      maxScanEntries: 80,
      coordinationHooks: {
        afterObjectEvictionQuarantine: async () => {
          const temporaryRoot = join(directory, "cache-v1", "tmp");
          const quarantine = (await readdir(temporaryRoot, { withFileTypes: true })).find(
            (entry) => entry.isDirectory() && entry.name.startsWith("evict-"),
          );
          assert.ok(quarantine);
          await Promise.all(
            Array.from({ length: 100 }, (_, index) =>
              writeFile(join(temporaryRoot, quarantine.name, `unexpected-${index}`), "x"),
            ),
          );
          enlarged = true;
        },
      },
    });

    await assert.rejects(cache.evict(), (error) => errorCode(error) === "cache_corrupt");
    assert.equal(enlarged, true);
    assert.equal(await new ReviewDiskCache({ directory }).getObject(input.digest), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("catalog eviction never restores a partially deleted quarantine to the public cache", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-catalog-quarantine-"));
  const canonicalUrl = "https://skills.example.test/.well-known/agent-skills/index.json";
  let enlarged = false;
  try {
    await new ReviewDiskCache({ directory }).putCatalog(
      canonicalUrl,
      new TextEncoder().encode('{"skills":[]}\n'),
      validCatalogMetadata(),
    );
    const cache = new ReviewDiskCache({
      directory,
      maxBytes: 0,
      maxScanEntries: 80,
      coordinationHooks: {
        afterCatalogEvictionQuarantine: async () => {
          const temporaryRoot = join(directory, "cache-v1", "tmp");
          const quarantine = (await readdir(temporaryRoot, { withFileTypes: true })).find(
            (entry) => entry.isDirectory() && entry.name.startsWith("evict-catalog-"),
          );
          assert.ok(quarantine);
          await Promise.all(
            Array.from({ length: 100 }, (_, index) =>
              writeFile(join(temporaryRoot, quarantine.name, `unexpected-${index}`), "x"),
            ),
          );
          enlarged = true;
        },
      },
    });

    await assert.rejects(cache.evict(), (error) => errorCode(error) === "cache_corrupt");
    assert.equal(enlarged, true);
    assert.equal(await new ReviewDiskCache({ directory }).getCatalog(canonicalUrl), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("disk LRU scans compact bounded metadata without loading retained object bytes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-test-"));
  const input = await validFixtureObjectInput();
  try {
    const cache = new DiskCache({
      directory,
      maxBytes: Number.MAX_SAFE_INTEGER,
      now: () => new Date("2026-08-25T10:00:02.000Z"),
    });
    await cache.publishObject(input);
    let objectReads = 0;
    const readObject = cacheInternals(cache).readObject.bind(cache);
    cacheInternals(cache).readObject = async (...args) => {
      objectReads += 1;
      return readObject(...args);
    };

    assert.deepEqual((await cache.evict()).evicted, []);
    assert.equal(objectReads, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("disk metadata scans enforce entry, metadata-byte, and file-table ceilings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-test-"));
  const first = skillInput("# first\n");
  const second = skillInput("# second\n", "2026-08-25T10:00:01.000Z");
  try {
    const writer = new DiskCache({ directory });
    await writer.publishObject(first);
    await writer.publishObject(second);

    await assert.rejects(
      new DiskCache({ directory, maxScanEntries: 1 }).evict(),
      (error) => errorCode(error) === "cache_corrupt",
    );
    await assert.rejects(
      new DiskCache({ directory, maxObjectMetadataBytes: 32 }).getObject(first.digest),
      (error) => errorCode(error) === "cache_corrupt",
    );
    await assert.rejects(
      new DiskCache({ directory, maxFilesPerObject: 0 }).getObject(first.digest),
      (error) => errorCode(error) === "cache_corrupt",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("catalog updates expose the old generation until the new generation commits", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-test-"));
  const canonicalUrl = "https://skills.example.test/.well-known/agent-skills/index.json";
  const oldBody = new TextEncoder().encode('{"generation":"old"}\n');
  const newBody = new TextEncoder().encode('{"generation":"new"}\n');
  const entered = deferred();
  const release = deferred();
  try {
    await new DiskCache({ directory }).putCatalog(canonicalUrl, oldBody, {
      retrievedAt: "2026-08-25T10:00:00.000Z",
      validatedAt: "2026-08-25T10:00:00.000Z",
    });
    const cache = new DiskCache({
      directory,
      coordinationHooks: {
        afterCatalogPreviousPublished: async () => {
          entered.resolve();
          await release.promise;
        },
      },
    });
    const publication = cache.putCatalog(canonicalUrl, newBody, {
      retrievedAt: "2026-08-25T10:00:01.000Z",
      validatedAt: "2026-08-25T10:00:01.000Z",
    });
    assert.equal(
      await Promise.race([
        entered.promise.then(() => "entered"),
        publication.then(() => "finished"),
      ]),
      "entered",
    );
    assert.deepEqual((await cache.getCatalog(canonicalUrl))?.body, oldBody);
    release.resolve();
    await publication;
    assert.deepEqual((await cache.getCatalog(canonicalUrl))?.body, newBody);
  } finally {
    release.resolve();
    await rm(directory, { recursive: true, force: true });
  }
});

test("memory winners validate candidate contents and timestamps before reuse", async () => {
  const input = await validFixtureObjectInput();
  const cache = new MemoryCache();
  await cache.publishObject(input);

  await assert.rejects(
    cache.publishObject({ ...input, verifiedAt: "invalid" }),
    (error) => errorCode(error) === "cache_corrupt",
  );
  await assert.rejects(
    cache.publishObject({
      ...input,
      files: new Map([["SKILL.md", new TextEncoder().encode("same digest, wrong root")]]),
    }),
    (error) => errorCode(error) === "cache_corrupt",
  );

  const invalidClock = new MemoryCache({ now: () => new Date(Number.NaN) });
  await invalidClock.publishObject(input);
  await assert.rejects(
    invalidClock.getObject(input.digest),
    (error) => errorCode(error) === "cache_corrupt",
  );
});

test("stale private writers require matching nonce registration, not a live PID alone", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-test-"));
  const input = await validFixtureObjectInput();
  const writer = join(directory, "cache-v1", "tmp", "writer-stale-live-pid");
  try {
    await mkdir(writer, { recursive: true });
    await writeFile(
      join(writer, "writer.json"),
      `${JSON.stringify({
        schema: "remote-skills-cache-writer-v1",
        writer: "typescript",
        pid: process.pid,
        process_nonce: "process-from-another-start",
        expected_digest: input.digest,
        bytes_received: 1,
        complete: false,
      })}\n`,
    );
    await utimes(
      writer,
      new Date("2026-08-20T10:00:00.000Z"),
      new Date("2026-08-20T10:00:00.000Z"),
    );
    const cache = new DiskCache({
      directory,
      now: () => new Date("2026-08-25T10:00:00.000Z"),
      temporaryExpirySeconds: 1,
    });

    assert.equal((await cache.cleanup()).removedTemporaryPaths, 1);
    await assert.rejects(access(writer));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("write-side filesystem failures use stable redacted cache errors", async () => {
  const parent = await mkdtemp(join(tmpdir(), "remote-skills-cache-test-"));
  const directory = join(parent, "occupied");
  const input = await validFixtureObjectInput();
  await writeFile(directory, "not a directory");
  try {
    const cache = new DiskCache({ directory });
    for (const operation of [
      () =>
        cache.putCatalog(
          "https://skills.example.test/.well-known/agent-skills/index.json",
          new TextEncoder().encode('{"skills":[]}\n'),
          {
            retrievedAt: "2026-08-25T10:00:00.000Z",
            validatedAt: "2026-08-25T10:00:00.000Z",
          },
        ),
      () => cache.publishObject(input),
    ]) {
      await assert.rejects(operation(), (error) => {
        assert.ok(error instanceof Error);
        assert.equal(errorCode(error), "cache_corrupt");
        assert.equal(error.cause, undefined);
        assert.doesNotMatch(
          String(error),
          new RegExp(parent.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"),
        );
        return true;
      });
    }
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

async function assertEvictionInventoryWaitsForObjectRead(separateCache: boolean) {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-test-"));
  const input = archiveInput();
  const entered = deferred();
  const release = deferred();
  const inventoryOutcome = deferred<"waiting-for-reader" | "completed-before-reader">();
  const accessedAt = "2026-08-25T11:00:00.000Z";
  let pauseRead = false;
  let reader: CacheObjectRead | undefined;
  let eviction: CacheEviction | undefined;
  try {
    const options = {
      directory,
      maxBytes: 0,
      now: () => new Date(accessedAt),
      verifyExtractedContents: async () => {
        if (pauseRead) {
          entered.resolve();
          await release.promise;
        }
        return true;
      },
    };
    const cache = new DiskCache(options);
    await cache.publishObject(input);
    const evictor = separateCache ? new DiskCache(options) : cache;
    const internals = cacheInternals(evictor);
    const listObjectRows = internals.listObjectRows.bind(evictor);
    const mutationTurnState = internals.mutationTurnState.bind(evictor);
    let inventoryRunning = false;
    internals.listObjectRows = async (...args) => {
      inventoryRunning = true;
      try {
        const rows = await listObjectRows(...args);
        inventoryOutcome.resolve("completed-before-reader");
        return rows;
      } finally {
        inventoryRunning = false;
      }
    };
    internals.mutationTurnState = async (...args) => {
      const turn = await mutationTurnState(...args);
      if (
        inventoryRunning &&
        args[0].endsWith(join("locks", input.digest.replace("sha256:", ""))) &&
        !turn.ready
      ) {
        inventoryOutcome.resolve("waiting-for-reader");
      }
      return turn;
    };

    pauseRead = true;
    reader = cache.getObject(input.digest);
    await Promise.race([entered.promise, reader]);
    eviction = evictor.evict();
    assert.equal(
      await Promise.race([inventoryOutcome.promise, eviction]),
      "waiting-for-reader",
      "eviction must wait before reading metadata held by an active reader",
    );
    release.resolve();
    const object = await reader;
    assert.ok(object);
    assert.equal(object.metadata.accessedAt, accessedAt);
    assert.deepEqual((await eviction).evicted, [input.digest]);
    assert.equal(await cache.getObject(input.digest), null);
  } finally {
    release.resolve();
    await Promise.allSettled([reader, eviction].filter(Boolean));
    await rm(directory, { recursive: true, force: true });
  }
}

for (const separateCache of [false, true]) {
  test(`eviction inventory waits for object validation and access-time touch ${separateCache ? "across cache instances" : "within one cache"}`, () =>
    assertEvictionInventoryWaitsForObjectRead(separateCache));
}

test("temporary cleanup coordinates access-time metadata publication by digest", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-access-cleanup-"));
  const input = await validFixtureObjectInput();
  const staged = deferred<string>();
  const release = deferred();
  let reader: CacheObjectRead | undefined;
  let cleanup: CacheCleanup | undefined;
  try {
    await new ReviewDiskCache({ directory }).publishObject(input);
    const cache = new ReviewDiskCache({
      directory,
      now: () => new Date("2026-08-25T11:00:00.000Z"),
    });
    const renameReplacingFile = cacheInternals(cache).renameReplacingFile.bind(cache);
    cacheInternals(cache).renameReplacingFile = async (source, destination) => {
      if (source.includes("object-access-")) {
        staged.resolve(source);
        await release.promise;
      }
      return renameReplacingFile(source, destination);
    };

    reader = cache.getObject(input.digest);
    const temporary = await staged.promise;
    await utimes(temporary, new Date(0), new Date(0));
    let cleanupSettled = false;
    cleanup = new ReviewDiskCache({
      directory,
      now: () => new Date("2026-08-25T12:00:00.000Z"),
      temporaryExpirySeconds: 1,
    })
      .cleanup()
      .finally(() => {
        cleanupSettled = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(cleanupSettled, false);
    await access(temporary);
    release.resolve();
    assert.ok(await reader);
    assert.equal((await cleanup).removedTemporaryPaths, 0);
  } finally {
    release.resolve();
    await Promise.allSettled([reader, cleanup].filter(Boolean));
    await rm(directory, { recursive: true, force: true });
  }
});

test("lock contention uses an expiry-derived deadline instead of a fixed attempt ceiling", async () => {
  const source = await readFile(new URL("../../src/cache/disk-cache.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /attempt\s*<\s*2_500/u);
  assert.match(source, /mutationLockTimeoutSeconds/u);
});

test("lock acquisition recreates a concurrently removed empty coordination directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-test-"));
  const input = await validFixtureObjectInput();
  try {
    const cache = new DiskCache({ directory });
    const ensureSafeDirectory = cacheInternals(cache).ensureSafeDirectory.bind(cache);
    let lockDirectoryEnsures = 0;
    const hex = input.digest.replace("sha256:", "");
    cacheInternals(cache).ensureSafeDirectory = async (target) => {
      await ensureSafeDirectory(target);
      if (!target.endsWith(join("coordination-v1", "locks", hex))) return;
      lockDirectoryEnsures += 1;
      if (lockDirectoryEnsures === 1) {
        await rm(join(directory, "cache-v1", "tmp", "coordination-v1"), {
          recursive: true,
          force: true,
        });
      }
    };

    assert.ok(await cache.publishObject(input));
    assert.equal(lockDirectoryEnsures >= 2, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("persisted cache metadata uses fatal UTF-8 decoding", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-test-"));
  const input = await validFixtureObjectInput();
  const hex = input.digest.replace("sha256:", "");
  try {
    const cache = new DiskCache({ directory });
    await cache.publishObject(input);
    const metadataPath = join(
      directory,
      "cache-v1",
      "objects",
      "sha256",
      hex.slice(0, 2),
      hex.slice(2),
      "object.json",
    );
    const encoded = await readFile(metadataPath);
    const marker = encoded.indexOf(Buffer.from("text/markdown"));
    assert.ok(marker >= 0);
    encoded[marker] = 0xff;
    await writeFile(metadataPath, encoded);
    await assert.rejects(
      cache.getObject(input.digest),
      (error) => errorCode(error) === "cache_corrupt",
    );

    const source = await readFile(
      new URL("../../src/cache/disk-cache.ts", import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(source, /new TextDecoder\(\)/u);
    assert.match(source, /fatal:\s*true/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("catalog staging rejects planted body and metadata leaf symlinks", async () => {
  const canonicalUrl = "https://skills.example.test/.well-known/agent-skills/index.json";
  for (const leafName of ["body.json", "metadata.json"]) {
    const parent = await mkdtemp(join(tmpdir(), "remote-skills-cache-leaf-swap-"));
    const directory = join(parent, "cache");
    const sentinel = join(parent, `${leafName}.sentinel`);
    await writeFile(sentinel, "external sentinel\n");
    try {
      const cache = new ReviewDiskCache({ directory });
      const wasPlanted = plantLeafAfterSafeDirectory(
        cache,
        (target) => /[\\/]tmp[\\/]catalog-[0-9a-f]{64}-/u.test(target),
        (target) => target,
        leafName,
        sentinel,
      );

      await assert.rejects(
        cache.putCatalog(canonicalUrl, new TextEncoder().encode('{"skills":[]}\n'), {
          retrievedAt: "2026-08-25T10:00:00.000Z",
          validatedAt: "2026-08-25T10:00:00.000Z",
        }),
        (error) => errorCode(error) === "cache_corrupt",
      );
      assert.equal(wasPlanted(), true);
      assert.equal(await readFile(sentinel, "utf8"), "external sentinel\n");
      assert.equal(await cache.getCatalog(canonicalUrl), null);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  }
});

test("object staging rejects a planted writer metadata leaf symlink", async () => {
  const parent = await mkdtemp(join(tmpdir(), "remote-skills-cache-leaf-swap-"));
  const directory = join(parent, "cache");
  const sentinel = join(parent, "writer.sentinel");
  const input = await validFixtureObjectInput();
  await writeFile(sentinel, "external sentinel\n");
  try {
    const cache = new ReviewDiskCache({ directory });
    const wasPlanted = plantLeafAfterSafeDirectory(
      cache,
      (target) => /[\\/]writer-typescript-[^\\/]+[\\/]root$/u.test(target),
      (target) => dirname(target),
      "writer.json",
      sentinel,
    );

    await assert.rejects(
      cache.publishObject(input),
      (error) => errorCode(error) === "cache_corrupt",
    );
    assert.equal(wasPlanted(), true);
    assert.equal(await readFile(sentinel, "utf8"), "external sentinel\n");
    assert.equal(await cache.getObject(input.digest), null);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("bounded reads reject an extra metadata probe byte after the retained first read", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-read-growth-"));
  const input = await validFixtureObjectInput();
  const hex = input.digest.replace("sha256:", "");
  const metadataPath = join(
    directory,
    "cache-v1",
    "objects",
    "sha256",
    hex.slice(0, 2),
    hex.slice(2),
    "object.json",
  );
  const writer = new ReviewDiskCache({ directory });
  await writer.publishObject(input);
  const probe = await open(metadataPath, "r");
  const metadataIdentity = await probe.stat();
  const handlePrototype: object = Object.getPrototypeOf(probe);
  const originalRead: unknown = Reflect.get(handlePrototype, "read");
  const originalReadFile: unknown = Reflect.get(handlePrototype, "readFile");
  assert.ok(typeof originalRead === "function" && typeof originalReadFile === "function");
  await probe.close();
  const encodedMetadata = await readFile(metadataPath);
  assert.ok(encodedMetadata.byteLength < 64 * 1_024);
  let targetHandle: FileHandle | undefined;
  let targetReads = 0;
  let unrelatedReads = 0;
  let firstReadCompleted = false;
  let probeByteInjected = false;
  const isMetadataHandle = async (handle: FileHandle): Promise<boolean> => {
    const identity = await handle.stat();
    return identity.dev === metadataIdentity.dev && identity.ino === metadataIdentity.ino;
  };
  Reflect.set(handlePrototype, "read", async function (this: FileHandle, ...args: unknown[]) {
    if (!(await isMetadataHandle(this))) {
      unrelatedReads += 1;
      return Reflect.apply(originalRead, this, args);
    }
    targetReads += 1;
    const [buffer, offset, length, position] = args;
    assert.ok(Buffer.isBuffer(buffer));
    assert.equal(offset, 0);
    if (targetReads === 1) {
      targetHandle = this;
      assert.equal(length, encodedMetadata.byteLength);
      assert.equal(position, 0);
      const result: unknown = await Reflect.apply(originalRead, this, args);
      assert.ok(typeof result === "object" && result !== null && "bytesRead" in result);
      assert.equal(result.bytesRead, encodedMetadata.byteLength);
      assert.deepEqual(buffer, encodedMetadata);
      firstReadCompleted = true;
      return result;
    }
    assert.equal(this, targetHandle);
    assert.equal(targetReads, 2);
    assert.equal(firstReadCompleted, true);
    assert.equal(length, 1);
    assert.equal(position, encodedMetadata.byteLength);
    // Model one extra byte in memory; leave the metadata file and its identity unchanged.
    buffer[0] = 0x20;
    probeByteInjected = true;
    return { bytesRead: 1, buffer };
  });
  Reflect.set(handlePrototype, "readFile", async function (this: FileHandle, ...args: unknown[]) {
    assert.equal(await isMetadataHandle(this), false, "metadata must use bounded reads");
    return Reflect.apply(originalReadFile, this, args);
  });
  try {
    const cache = new ReviewDiskCache({
      directory,
      maxObjectMetadataBytes: encodedMetadata.byteLength,
      now: () => new Date(input.accessedAt),
    });
    await assert.rejects(
      cache.getObject(input.digest),
      (error) => errorCode(error) === "cache_corrupt",
    );
    assert.ok(unrelatedReads > 0);
    assert.equal(targetReads, 2);
    assert.equal(firstReadCompleted, true);
    assert.equal(probeByteInjected, true);
  } finally {
    Reflect.set(handlePrototype, "read", originalRead);
    Reflect.set(handlePrototype, "readFile", originalReadFile);
    await rm(directory, { recursive: true, force: true });
  }
});

test("catalog metadata input validation has disk and memory parity without mutation", async () => {
  const canonicalUrl = "https://skills.example.test/.well-known/agent-skills/index.json";
  const originalBody = new TextEncoder().encode('{"generation":"old"}\n');
  const replacementBody = new TextEncoder().encode('{"generation":"new"}\n');
  const validMetadata = {
    etag: '"old"',
    lastModified: "Mon, 25 Aug 2026 10:00:00 GMT",
    cacheControl: "max-age=60",
    retrievedAt: "2026-08-25T10:00:00.000Z",
    validatedAt: "2026-08-25T10:00:00.000Z",
  };
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-catalog-parity-"));
  try {
    for (const cache of [new ReviewMemoryCache(), new ReviewDiskCache({ directory })]) {
      await cache.putCatalog(canonicalUrl, originalBody, validMetadata);
      const invalidFields: Array<[string, unknown]> = [
        ["etag", 1],
        ["lastModified", false],
        ["cacheControl", {}],
      ];
      for (const [field, value] of invalidFields) {
        await assert.rejects(
          putCatalogWithUnknownMetadata(cache, canonicalUrl, replacementBody, {
            ...validMetadata,
            [field]: value,
          }),
          (error) => errorCode(error) === "cache_corrupt",
        );
        assert.deepEqual((await cache.getCatalog(canonicalUrl))?.body, originalBody);
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("portable paths reject unpaired UTF-16 surrogates consistently", async () => {
  const highPath = `references/high-\ud800.txt`;
  const lowPath = `references/high-\udc00.txt`;
  assert.deepEqual(Buffer.from(highPath), Buffer.from(lowPath));
  assert.throws(
    () => validateReviewPaths([highPath, lowPath]),
    (error) => errorCode(error) === "cache_corrupt",
  );

  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-surrogate-"));
  const input = archiveInput();
  const bytes = new TextEncoder().encode("replacement collision\n");
  input.files = new Map([...input.files, [highPath, bytes], [lowPath, bytes]]);
  input.mediaTypes = new Map([
    ...input.mediaTypes,
    [highPath, "text/plain"],
    [lowPath, "text/plain"],
  ]);
  try {
    for (const cache of [
      new ReviewMemoryCache({ verifyExtractedContents: () => true }),
      new ReviewDiskCache({ directory, verifyExtractedContents: () => true }),
    ]) {
      await assert.rejects(
        cache.publishObject(input),
        (error) => errorCode(error) === "cache_corrupt",
      );
      assert.equal(await cache.getObject(input.digest), null);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("object reads and eviction reject a large unexpected top-level sibling", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-inventory-"));
  const input = await validFixtureObjectInput();
  const hex = input.digest.replace("sha256:", "");
  const objectDirectory = join(
    directory,
    "cache-v1",
    "objects",
    "sha256",
    hex.slice(0, 2),
    hex.slice(2),
  );
  try {
    const cache = new ReviewDiskCache({ directory, maxBytes: Number.MAX_SAFE_INTEGER });
    await cache.publishObject(input);
    await writeFile(join(objectDirectory, "unexpected.bin"), Buffer.alloc(2 * 1_024 * 1_024));

    await assert.rejects(
      cache.getObject(input.digest),
      (error) => errorCode(error) === "cache_corrupt",
    );
    await assert.rejects(cache.evict(), (error) => errorCode(error) === "cache_corrupt");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("persisted record readers require explicit protocol ceilings", async () => {
  const source = (
    await Promise.all([
      readFile(new URL("../../src/cache/disk-cache.ts", import.meta.url), "utf8"),
      readFile(new URL("../../src/cache/validation.ts", import.meta.url), "utf8"),
    ])
  ).join("\n");
  assert.doesNotMatch(source, /maxBytes\s*=\s*Number\.MAX_SAFE_INTEGER/u);
  for (const ceiling of [
    "CACHE_MAX_CATALOG_BODY_BYTES",
    "CACHE_MAX_CATALOG_METADATA_BYTES",
    "MAX_COORDINATION_RECORD_BYTES",
    "CACHE_MAX_OBJECT_METADATA_BYTES",
    "CACHE_MAX_ARTIFACT_BYTES",
    "CACHE_MAX_EXTRACTED_FILE_BYTES",
  ]) {
    assert.match(source, new RegExp(`const ${ceiling}\\b`, "u"));
  }
});

test("catalog reads reject bodies and metadata beyond their protocol ceilings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-catalog-limit-"));
  const canonicalUrl = "https://skills.example.test/.well-known/agent-skills/index.json";
  const originId = reviewOriginId(canonicalUrl);
  const catalogDirectory = join(directory, "cache-v1", "catalogs", originId);
  const bodyPath = join(catalogDirectory, "body.json");
  const metadataPath = join(catalogDirectory, "metadata.json");
  try {
    const cache = new ReviewDiskCache({ directory });
    await cache.putCatalog(canonicalUrl, new TextEncoder().encode('{"skills":[]}\n'), {
      retrievedAt: "2026-08-25T10:00:00.000Z",
      validatedAt: "2026-08-25T10:00:00.000Z",
    });
    const body = await readFile(bodyPath);
    await writeFile(bodyPath, Buffer.concat([body, Buffer.alloc(1_048_576, 0x20)]));
    await assert.rejects(
      cache.getCatalog(canonicalUrl),
      (error) => errorCode(error) === "cache_corrupt",
    );

    await writeFile(bodyPath, body);
    const metadata = await readFile(metadataPath);
    await writeFile(metadataPath, Buffer.concat([metadata, Buffer.alloc(65_536, 0x20)]));
    await assert.rejects(
      cache.getCatalog(canonicalUrl),
      (error) => errorCode(error) === "cache_corrupt",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an invalid portable path cannot poison a digest before a valid publication", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-path-rollback-"));
  const valid = archiveInput();
  const invalid = archiveInput();
  const invalidPath = `references/invalid-\ud800.txt`;
  const invalidBytes = new TextEncoder().encode("invalid path\n");
  invalid.files = new Map([...invalid.files, [invalidPath, invalidBytes]]);
  invalid.mediaTypes = new Map([...invalid.mediaTypes, [invalidPath, "text/plain"]]);
  try {
    const cache = new ReviewDiskCache({
      directory,
      verifyExtractedContents: () => true,
    });
    await assert.rejects(
      cache.publishObject(invalid),
      (error) => errorCode(error) === "cache_corrupt",
    );
    assert.equal(await cache.getObject(valid.digest), null);
    assert.ok(await cache.publishObject(valid));
    assert.ok(await cache.getObject(valid.digest));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("publication bounds media types before cloning or iterating them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-media-type-bound-"));
  const input = skillInput("# bounded media types\n");
  let iterations = 0;
  class OversizedMediaTypes extends Map<string, string> {
    [Symbol.iterator](): MapIterator<[string, string]> {
      iterations += 1;
      throw new Error("media-type-iteration-canary");
    }
  }
  const mediaTypes = new OversizedMediaTypes([
    ["SKILL.md", "text/markdown"],
    ["unexpected.txt", "text/plain"],
  ]);
  try {
    for (const cache of [
      new ReviewMemoryCache({ maxFilesPerObject: 1 }),
      new ReviewDiskCache({ directory, maxFilesPerObject: 1 }),
    ]) {
      await assert.rejects(
        cache.publishObject({ ...input, mediaTypes }),
        (error) => errorCode(error) === "cache_corrupt",
      );
    }
    assert.equal(iterations, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("expired-temp cleanup cannot remove a live object stage paused before commit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-live-object-stage-"));
  const input = skillInput("# live object stage\n");
  const commitPaused = deferred();
  const releaseCommit = deferred();
  let publication: CachePublication | undefined;
  try {
    const publisher = new ReviewDiskCache({
      directory,
      now: () => new Date("2026-08-25T10:00:00.000Z"),
      leaseExpirySeconds: 1,
      temporaryExpirySeconds: 1,
      processNonce: "live-object-stage-owner",
      coordinationHooks: {
        beforeObjectPublicationCommit: async () => {
          commitPaused.resolve();
          await releaseCommit.promise;
        },
      },
    });
    publication = publisher.publishObject(input);
    await commitPaused.promise;
    const temporaryRoot = join(directory, "cache-v1", "tmp");
    const stageName = (await readdir(temporaryRoot)).find((name) =>
      name.startsWith("writer-typescript-"),
    );
    assert.ok(stageName);
    const stage = join(temporaryRoot, stageName);
    await utimes(stage, new Date("2026-08-25T10:00:00.000Z"), new Date("2026-08-25T10:00:00.000Z"));
    const cleaner = new ReviewDiskCache({
      directory,
      now: () => new Date("2026-08-25T10:00:02.000Z"),
      leaseExpirySeconds: 1,
      temporaryExpirySeconds: 1,
      processNonce: "live-object-stage-cleaner",
    });
    assert.equal((await cleaner.cleanup()).removedTemporaryPaths, 0);
    await access(stage);
    releaseCommit.resolve();
    await publication;
    assert.ok(await cleaner.getObject(input.digest));
  } finally {
    releaseCommit.resolve();
    await Promise.allSettled([publication].filter(Boolean));
    await rm(directory, { recursive: true, force: true });
  }
});

test("catalog reads recover when the probed generation moves before directory open", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-catalog-transition-"));
  const canonicalUrl = "https://skills.example.test/.well-known/agent-skills/index.json";
  const body = new TextEncoder().encode('{"generation":"old"}\n');
  const originId = reviewOriginId(canonicalUrl);
  const current = join(directory, "cache-v1", "catalogs", originId);
  const previous = join(
    directory,
    "cache-v1",
    "tmp",
    "catalog-generations-v1",
    originId,
    "previous",
  );
  let moved = false;
  const opened: string[] = [];
  try {
    const writer = new ReviewDiskCache({ directory });
    await writer.putCatalog(canonicalUrl, body, {
      retrievedAt: "2026-08-25T10:00:00.000Z",
      validatedAt: "2026-08-25T10:00:00.000Z",
    });
    const reader = new ReviewDiskCache({
      directory,
      coordinationHooks: {
        beforeCatalogGenerationOpen: async (path) => {
          opened.push(path);
          if (moved || path !== current) return;
          moved = true;
          await mkdir(dirname(previous), { recursive: true });
          await rename(current, previous);
        },
      },
    });

    assert.deepEqual((await reader.getCatalog(canonicalUrl))?.body, body);
    assert.equal(moved, true);
    assert.deepEqual(new Set(opened), new Set([current]));
    await access(join(current, "body.json"));
    await assert.rejects(access(previous));

    for (let generation = 0; generation < 12; generation += 1) {
      const next = new TextEncoder().encode(`{"generation":${generation}}\n`);
      const observations = await Promise.all([
        reader.getCatalog(canonicalUrl),
        writer.putCatalog(canonicalUrl, next, {
          retrievedAt: "2026-08-25T10:00:00.000Z",
          validatedAt: "2026-08-25T10:00:00.000Z",
        }),
        reader.getCatalog(canonicalUrl),
      ]);
      for (const observation of [observations.at(0), observations.at(2)]) {
        assert.ok(observation);
        assert.ok(observation.body.byteLength > 0);
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("corrupt staged objects are rejected before an independent reader can observe the digest", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-stage-visibility-"));
  const input = skillInput("# stage visibility\n");
  const hex = input.digest.replace("sha256:", "");
  const objectDirectory = join(
    directory,
    "cache-v1",
    "objects",
    "sha256",
    hex.slice(0, 2),
    hex.slice(2),
  );
  const publicReadEntered = deferred();
  const releasePublicRead = deferred();
  let tampered = false;
  let publication: CachePublication | undefined;
  try {
    const cache = new ReviewDiskCache({
      directory,
      coordinationHooks: {
        beforeObjectPublicationCommit: async () => {
          const temporaryRoot = join(directory, "cache-v1", "tmp");
          const stageName = (await readdir(temporaryRoot)).find((name) =>
            name.startsWith(`writer-typescript-${hex}-`),
          );
          assert.ok(stageName);
          const corrupt = new Uint8Array(input.artifact);
          const firstByte = corrupt.at(0);
          assert.ok(firstByte !== undefined);
          corrupt[0] = firstByte ^ 0xff;
          await writeFile(join(temporaryRoot, stageName, "artifact"), corrupt);
          tampered = true;
        },
      },
    });
    const readObjectUnlocked = cacheInternals(cache).readObjectUnlocked.bind(cache);
    cacheInternals(cache).readObjectUnlocked = async (...args) => {
      await access(join(objectDirectory, "artifact"));
      publicReadEntered.resolve();
      await releasePublicRead.promise;
      return readObjectUnlocked(...args);
    };

    publication = cache.publishObject(input);
    const outcome = await Promise.race([
      publication.then(
        () => "published",
        () => "rejected-before-publication",
      ),
      publicReadEntered.promise.then(() => "publicly-visible-before-verification"),
    ]);
    assert.equal(tampered, true);
    assert.equal(outcome, "rejected-before-publication");
    await assert.rejects(access(objectDirectory));
  } finally {
    releasePublicRead.resolve();
    await Promise.allSettled([publication].filter(Boolean));
    await rm(directory, { recursive: true, force: true });
  }
});

test("lease acquisition recreates its directory while holding digest coordination", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-lease-create-race-"));
  const input = await validFixtureObjectInput();
  const prepared = deferred();
  const releaseAcquire = deferred();
  const cleanupQueued = deferred();
  try {
    const acquirer = new ReviewDiskCache({
      directory,
      coordinationHooks: {
        afterLeaseDirectoryPrepared: async () => {
          prepared.resolve();
          await releaseAcquire.promise;
        },
      },
    });
    const cleaner = new ReviewDiskCache({ directory });
    const withDigestLock = cacheInternals(cleaner).withDigestLock.bind(cleaner);
    cacheInternals(cleaner).withDigestLock = async (...args) => {
      cleanupQueued.resolve();
      return withDigestLock(...args);
    };

    const acquisition = acquirer.acquireLease(input.digest, "session-create-race");
    await prepared.promise;
    const cleanup = cleaner.cleanup();
    await cleanupQueued.promise;
    releaseAcquire.resolve();

    const [lease, result] = await Promise.all([acquisition, cleanup]);
    assert.equal(result.reclaimedLeases, 0);
    assert.ok(lease.path);
    await access(lease.path);
    await lease.release();
  } finally {
    releaseAcquire.resolve();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a staged writer remains registered while contending for publication", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-writer-heartbeat-"));
  const input = await validFixtureObjectInput();
  const holderCommitted = deferred();
  const releaseHolder = deferred();
  const contenderStaged = deferred();
  let now = new Date();
  const common = {
    directory,
    now: () => new Date(now),
    leaseExpirySeconds: 1,
    temporaryExpirySeconds: 1,
    renewIntervalSeconds: 0,
  };
  const writerCommon = { ...common, isProcessAlive: () => true };
  const holder = new ReviewDiskCache({
    ...writerCommon,
    processNonce: "process-writer-holder",
    coordinationHooks: {
      beforeObjectPublicationCommit: async () => {
        holderCommitted.resolve();
        await releaseHolder.promise;
      },
    },
  });
  const contender = new ReviewDiskCache({
    ...writerCommon,
    processNonce: "process-writer-contender",
    coordinationHooks: {
      afterObjectStaging: () => contenderStaged.resolve(),
    },
  });
  const first = holder.publishObject(input);
  let second: ReturnType<ReviewDiskCache["publishObject"]> | undefined;
  try {
    await holderCommitted.promise;
    second = contender.publishObject(input);
    await contenderStaged.promise;
    const temporaryRoot = join(directory, "cache-v1", "tmp");
    let contenderDirectory: string | undefined;
    for (const entry of await readdir(temporaryRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith("writer-typescript-")) continue;
      const writer = await readFile(join(temporaryRoot, entry.name, "writer.json")).then(
        (bytes) => parseJsonRecord(bytes.toString("utf8")),
        (error) => {
          if (errorCode(error) === "ENOENT") return undefined;
          throw error;
        },
      );
      if (writer?.process_nonce === "process-writer-contender") {
        contenderDirectory = join(temporaryRoot, entry.name);
        await utimes(contenderDirectory, new Date(0), new Date(0));
      } else if (writer === undefined) {
        const holderDirectory = join(temporaryRoot, entry.name);
        const current = new Date(now.getTime() + 10_000);
        await utimes(holderDirectory, current, current);
      }
    }
    assert.ok(contenderDirectory);
    now = new Date(now.getTime() + 10_000);
    const registration = await waitForJson(
      join(
        temporaryRoot,
        "coordination-v1",
        "processes",
        input.digest.replace("sha256:", ""),
        "process-writer-contender.json",
      ),
      (value) => Date.parse(requiredString(value, "renewed_at")) === now.getTime(),
    );
    assert.equal(Date.parse(requiredString(registration, "renewed_at")), now.getTime());
    assert.ok(now.getTime() - (await lstat(contenderDirectory)).mtimeMs > 1_000);

    const result = await new ReviewDiskCache(common).cleanup();
    assert.equal(result.removedTemporaryPaths, 0);
    releaseHolder.resolve();
    assert.ok(second);
    const [firstWinner, secondWinner] = await Promise.all([first, second]);
    assert.equal(firstWinner.metadata.digest, input.digest);
    assert.equal(secondWinner.metadata.digest, input.digest);
  } finally {
    releaseHolder.resolve();
    await Promise.allSettled([first, second].filter(Boolean));
    await rm(directory, { recursive: true, force: true });
  }
});

test("a live catalog stage remains registered past temporary expiry and crashed stages recover", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-catalog-heartbeat-"));
  const canonicalUrl = "https://skills.example.test/.well-known/agent-skills/index.json";
  const originId = reviewOriginId(canonicalUrl);
  const mutationDigest = reviewCatalogMutationDigest(originId);
  const staged = deferred<string>();
  const release = deferred();
  let now = new Date("2026-08-25T10:00:00.000Z");
  const common = {
    directory,
    now: () => new Date(now),
    leaseExpirySeconds: 1,
    temporaryExpirySeconds: 1,
  };
  const writer = new ReviewDiskCache({
    ...common,
    processNonce: "catalog-live-writer",
    isProcessAlive: () => true,
  });
  const withDigestLock = cacheInternals(writer).withDigestLock.bind(writer);
  let paused = false;
  let catalogMutationLockCount = 0;
  cacheInternals(writer).withDigestLock = async (digest, ...args) => {
    const operation = args[2] ?? "mutation";
    if (digest === mutationDigest && operation === "mutation") {
      catalogMutationLockCount += 1;
    }
    if (!paused && catalogMutationLockCount === 2) {
      paused = true;
      const temporaryRoot = join(directory, "cache-v1", "tmp");
      const liveEntry = (await readdir(temporaryRoot, { withFileTypes: true })).find(
        (entry) => entry.isDirectory() && entry.name.startsWith(`catalog-${originId}-`),
      );
      assert.ok(liveEntry);
      const liveStage = join(temporaryRoot, liveEntry.name);
      const liveWriter = parseJsonRecord(await readFile(join(liveStage, "writer.json"), "utf8"));
      assert.equal(liveWriter.process_nonce, "catalog-live-writer");
      staged.resolve(liveStage);
      await release.promise;
    }
    return withDigestLock(digest, ...args);
  };
  const publication = writer.putCatalog(
    canonicalUrl,
    new TextEncoder().encode('{"generation":"live"}\n'),
    validCatalogMetadata(),
  );
  try {
    const liveStage = await staged.promise;
    assert.equal(catalogMutationLockCount, 2);
    const temporaryRoot = join(directory, "cache-v1", "tmp");
    const liveWriter = parseJsonRecord(await readFile(join(liveStage, "writer.json"), "utf8"));
    assert.equal(liveWriter.process_nonce, "catalog-live-writer");
    assert.equal(liveWriter.expected_digest, `sha256:${originId}`);
    await utimes(liveStage, new Date(0), new Date(0));
    now = new Date("2026-08-25T10:00:10.000Z");
    await new Promise((resolve) => setTimeout(resolve, 600));

    const liveCleanup = await new ReviewDiskCache(common).cleanup();
    assert.equal(liveCleanup.removedTemporaryPaths, 0);
    await access(liveStage);
    release.resolve();
    await publication;

    const crashedStage = join(
      temporaryRoot,
      `catalog-${originId}-123e4567-e89b-42d3-a456-426614174000`,
    );
    await mkdir(crashedStage, { recursive: true });
    await writeFile(
      join(crashedStage, "writer.json"),
      `${JSON.stringify({
        schema: "remote-skills-cache-writer-v1",
        writer: "typescript",
        pid: 999_999,
        process_nonce: "catalog-crashed-writer",
        expected_digest: `sha256:${originId}`,
        bytes_received: 0,
        complete: false,
      })}\n`,
    );
    await utimes(crashedStage, new Date(0), new Date(0));
    const crashedCleanup = await new ReviewDiskCache(common).cleanup();
    assert.equal(crashedCleanup.removedTemporaryPaths, 1);
    await assert.rejects(access(crashedStage));
  } finally {
    release.resolve();
    await Promise.allSettled([publication]);
    await rm(directory, { recursive: true, force: true });
  }
});

test("catalog stage cleanup waits for the global and exact identity mutation gates", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-catalog-stage-lock-"));
  const canonicalUrl = "https://skills.example.test/.well-known/agent-skills/index.json";
  const originId = reviewOriginId(canonicalUrl, "engineering");
  const globalDigest = "sha256:52f171c6c5d96edd9ec677a3dbb30b1b5aa0ac1fc93e9007b33f6afd4a3c9f59";
  const mutationDigest = reviewCatalogMutationDigest(originId);
  const temporaryRoot = join(directory, "cache-v1", "tmp");
  const staleStage = join(
    temporaryRoot,
    `catalog-${originId}-123e4567-e89b-42d3-a456-426614174000`,
  );
  const malformedStage = join(temporaryRoot, `catalog-${originId}-not-a-uuid`);
  const holderEntered = deferred();
  const cleanupEntered = deferred();
  const releaseHolder = deferred();
  let cleanup: ReturnType<ReviewDiskCache["cleanup"]> | undefined;
  const holder = new ReviewDiskCache({ directory, processNonce: "catalog-stage-holder" });
  const cleaner = new ReviewDiskCache({
    directory,
    processNonce: "catalog-stage-cleaner",
    now: () => new Date("2026-08-25T10:00:10.000Z"),
    temporaryExpirySeconds: 1,
    coordinationHooks: {
      beforeTemporaryCleanup: (path) => {
        if (path === staleStage) cleanupEntered.resolve();
      },
    },
  });
  const observed: string[] = [];
  const withDigestLock = cacheInternals(cleaner).withDigestLock.bind(cleaner);
  cacheInternals(cleaner).withDigestLock = async (digest, ...args) => {
    if (digest === globalDigest || digest === mutationDigest) observed.push(digest);
    return withDigestLock(digest, ...args);
  };
  try {
    await mkdir(staleStage, { recursive: true });
    await writeFile(join(staleStage, "partial"), "partial", "utf8");
    await utimes(staleStage, new Date(0), new Date(0));
    await mkdir(malformedStage, { recursive: true });
    await utimes(malformedStage, new Date(0), new Date(0));
    const holding = cacheInternals(holder).withDigestLock(globalDigest, () =>
      cacheInternals(holder).withDigestLock(mutationDigest, async () => {
        holderEntered.resolve();
        await releaseHolder.promise;
      }),
    );
    await holderEntered.promise;

    cleanup = cleaner.cleanup();
    const enteredWhileHeld = await Promise.race([
      cleanupEntered.promise.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 100)),
    ]);
    assert.equal(enteredWhileHeld, false);
    await access(staleStage);

    releaseHolder.resolve();
    await holding;
    assert.equal((await cleanup).removedTemporaryPaths, 1);
    assert.deepEqual(observed.slice(0, 2), [globalDigest, mutationDigest]);
    await assert.rejects(access(staleStage));
    await access(malformedStage);
  } finally {
    releaseHolder.resolve();
    await Promise.allSettled([cleanup].filter(Boolean));
    await rm(directory, { recursive: true, force: true });
  }
});

test("cleanup applies one cumulative scan budget across temporary and coordination state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-scan-budget-"));
  const temporaryRoot = join(directory, "cache-v1", "tmp");
  const locks = join(temporaryRoot, "coordination-v1", "locks");
  try {
    await mkdir(join(temporaryRoot, "stale-a"), { recursive: true });
    await mkdir(join(temporaryRoot, "stale-b"), { recursive: true });
    await mkdir(locks, { recursive: true });
    await writeFile(join(locks, "unknown-a"), "peer state\n");
    await writeFile(join(locks, "unknown-b"), "peer state\n");
    const cache = new ReviewDiskCache({
      directory,
      maxScanEntries: 3,
      now: () => new Date("2030-08-25T10:00:00.000Z"),
    });

    await assert.rejects(cache.cleanup(), (error) => errorCode(error) === "cache_corrupt");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("archive metadata input validation has disk and memory parity without mutation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-archive-parity-"));
  const baseline = archiveInput();
  try {
    for (const cache of [
      new ReviewMemoryCache({ verifyExtractedContents: () => true }),
      new ReviewDiskCache({ directory, verifyExtractedContents: () => true }),
    ]) {
      await cache.publishObject(baseline);
      const invalidMediaType = archiveInput();
      Reflect.apply(invalidMediaType.mediaTypes.set, invalidMediaType.mediaTypes, ["SKILL.md", 7]);
      for (const invalid of [{ ...archiveInput(), archiveFormat: 7 }, invalidMediaType]) {
        await assert.rejects(
          publishObjectFromUnknown(cache, invalid),
          (error) => errorCode(error) === "cache_corrupt",
        );
        const winner = await cache.getObject(baseline.digest);
        assert.ok(winner);
        assert.equal(winner.metadata.archiveFormat, "zip");
        assert.equal(winner.metadata.files.at(0)?.mediaType, "text/markdown");
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("catalog body publications enforce the protocol cap and allow a valid retry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-catalog-body-write-cap-"));
  const canonicalUrl = "https://skills.example.test/.well-known/agent-skills/index.json";
  const oversized = new Uint8Array(1_048_576 + 1);
  const valid = new TextEncoder().encode('{"skills":[]}\n');
  try {
    for (const cache of reviewCacheBackends(directory)) {
      await assert.rejects(
        cache.putCatalog(canonicalUrl, oversized, validCatalogMetadata()),
        (error) => errorCode(error) === "cache_corrupt",
      );
      assert.equal(await cache.getCatalog(canonicalUrl), null);
      await cache.putCatalog(canonicalUrl, valid, validCatalogMetadata());
      assert.deepEqual((await cache.getCatalog(canonicalUrl))?.body, valid);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("catalog metadata publications enforce their wire cap without replacing a valid generation", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "remote-skills-cache-catalog-metadata-write-cap-"),
  );
  const canonicalUrl = "https://skills.example.test/.well-known/agent-skills/index.json";
  const oldBody = new TextEncoder().encode('{"generation":"old"}\n');
  const newBody = new TextEncoder().encode('{"generation":"new"}\n');
  try {
    for (const cache of reviewCacheBackends(directory)) {
      await cache.putCatalog(canonicalUrl, oldBody, validCatalogMetadata());
      await assert.rejects(
        cache.putCatalog(canonicalUrl, newBody, {
          ...validCatalogMetadata(),
          etag: "x".repeat(65_536),
        }),
        (error) => errorCode(error) === "cache_corrupt",
      );
      assert.deepEqual((await cache.getCatalog(canonicalUrl))?.body, oldBody);
      await cache.putCatalog(canonicalUrl, newBody, validCatalogMetadata());
      assert.deepEqual((await cache.getCatalog(canonicalUrl))?.body, newBody);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a just-published invalid catalog generation restores the prior valid generation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-catalog-rollback-"));
  const canonicalUrl = "https://skills.example.test/.well-known/agent-skills/index.json";
  const oldBody = new TextEncoder().encode('{"generation":"old"}\n');
  const newBody = new TextEncoder().encode('{"generation":"new"}\n');
  let tampered = false;
  try {
    await new ReviewDiskCache({ directory }).putCatalog(
      canonicalUrl,
      oldBody,
      validCatalogMetadata(),
    );
    const failing = new ReviewDiskCache({
      directory,
      coordinationHooks: {
        beforeCatalogCommit: async () => {
          if (tampered) return;
          const temporaryRoot = join(directory, "cache-v1", "tmp");
          for (const entry of await readdir(temporaryRoot, { withFileTypes: true })) {
            if (!entry.isDirectory() || !entry.name.startsWith("catalog-")) continue;
            await writeFile(
              join(temporaryRoot, entry.name, "body.json"),
              new Uint8Array(1_048_576 + 1),
            );
            tampered = true;
          }
        },
      },
    });

    await assert.rejects(
      failing.putCatalog(canonicalUrl, newBody, validCatalogMetadata()),
      (error) => errorCode(error) === "cache_corrupt",
    );
    assert.equal(tampered, true);
    assert.deepEqual((await failing.getCatalog(canonicalUrl))?.body, oldBody);
    await new ReviewDiskCache({ directory }).putCatalog(
      canonicalUrl,
      newBody,
      validCatalogMetadata(),
    );
    assert.deepEqual(
      (await new ReviewDiskCache({ directory }).getCatalog(canonicalUrl))?.body,
      newBody,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("object metadata publications enforce their wire cap and cannot poison a valid retry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-object-write-cap-"));
  const valid = skillInput("# metadata cap\n");
  const oversized = skillInput("# metadata cap\n");
  oversized.mediaTypes.set("SKILL.md", `text/plain;${"x".repeat(1_048_576)}`);
  try {
    for (const cache of reviewCacheBackends(directory)) {
      await assert.rejects(
        cache.publishObject(oversized),
        (error) => errorCode(error) === "cache_corrupt",
      );
      assert.equal(await cache.getObject(valid.digest), null);
      const published = await cache.publishObject(valid);
      assert.equal(published.metadata.files.at(0)?.mediaType, "text/markdown");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a just-published invalid object generation is rolled back for a valid retry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-object-rollback-"));
  const input = skillInput("# publication rollback\n");
  let planted = false;
  try {
    const failing = new ReviewDiskCache({
      directory,
      coordinationHooks: {
        beforeObjectPublicationCommit: async () => {
          const temporaryRoot = join(directory, "cache-v1", "tmp");
          for (const entry of await readdir(temporaryRoot, { withFileTypes: true })) {
            if (!entry.isDirectory() || !entry.name.startsWith("writer-typescript-")) continue;
            await writeFile(join(temporaryRoot, entry.name, "unexpected"), "invalid generation");
            planted = true;
          }
        },
      },
    });
    await assert.rejects(
      failing.publishObject(input),
      (error) => errorCode(error) === "cache_corrupt",
    );
    assert.equal(planted, true);

    const retry = new ReviewDiskCache({ directory });
    assert.equal(await retry.getObject(input.digest), null);
    assert.equal((await retry.publishObject(input)).metadata.digest, input.digest);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("memory and disk caches enforce the normative one-thousand-file default", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-file-limit-"));
  const input = archiveInput();
  input.files = new Map(
    Array.from({ length: 1_001 }, (_, index): [string, Uint8Array] => [
      `files/${index}.txt`,
      new Uint8Array(),
    ]),
  );
  input.mediaTypes = new Map([...input.files.keys()].map((path) => [path, "text/plain"]));
  try {
    for (const cache of reviewCacheBackends(directory, { verifyExtractedContents: () => true })) {
      await assert.rejects(
        cache.publishObject(input),
        (error) => errorCode(error) === "cache_corrupt",
      );
      assert.equal(await cache.getObject(input.digest), null);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("memory and disk caches enforce the aggregate extracted-byte protocol limit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-aggregate-limit-"));
  const input = archiveInput();
  const tenMiB = new Uint8Array(10 * 1_024 * 1_024);
  input.files = new Map([
    ...Array.from({ length: 10 }, (_, index): [string, Uint8Array] => [
      `files/${index}.bin`,
      tenMiB,
    ]),
    ["files/overflow.bin", new Uint8Array([1])] satisfies [string, Uint8Array],
  ]);
  input.mediaTypes = new Map(
    [...input.files.keys()].map((path) => [path, "application/octet-stream"]),
  );
  try {
    for (const cache of reviewCacheBackends(directory, { verifyExtractedContents: () => true })) {
      await assert.rejects(
        cache.publishObject(input),
        (error) => errorCode(error) === "cache_corrupt",
      );
      assert.equal(await cache.getObject(input.digest), null);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("temporary cleanup charges recursive children to one cumulative scan budget", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-temp-tree-limit-"));
  const stale = join(directory, "cache-v1", "tmp", "writer-stale-tree");
  try {
    await mkdir(stale, { recursive: true });
    await writeFile(join(stale, "child-a"), "a");
    await writeFile(join(stale, "child-b"), "b");
    await utimes(stale, new Date(0), new Date(0));
    const cache = new ReviewDiskCache({
      directory,
      maxScanEntries: 1,
      temporaryExpirySeconds: 1,
      now: () => new Date("2030-08-25T10:00:00.000Z"),
    });

    await assert.rejects(cache.cleanup(), (error) => errorCode(error) === "cache_corrupt");
    await access(join(stale, "child-a"));
    await access(join(stale, "child-b"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("temporary cleanup bounds children planted immediately before destructive traversal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-temp-mutation-limit-"));
  const stale = join(directory, "cache-v1", "tmp", "writer-mutating-tree");
  let mutated = false;
  try {
    await mkdir(stale, { recursive: true });
    await writeFile(join(stale, "original"), "original");
    await utimes(stale, new Date(0), new Date(0));
    const cache = new ReviewDiskCache({
      directory,
      maxScanEntries: 2,
      temporaryExpirySeconds: 1,
      now: () => new Date("2030-08-25T10:00:00.000Z"),
      coordinationHooks: {
        afterTemporaryCleanupScan: async (path) => {
          if (path !== stale) return;
          await writeFile(join(stale, "late-a"), "a");
          await writeFile(join(stale, "late-b"), "b");
          mutated = true;
        },
      },
    });

    await assert.rejects(cache.cleanup(), (error) => errorCode(error) === "cache_corrupt");
    assert.equal(mutated, true);
    await access(stale);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("multi-object eviction retains one cumulative budget through object validation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-eviction-tree-limit-"));
  const first = skillInput("# cumulative first\n");
  const second = skillInput("# cumulative second\n", "2026-08-25T10:00:01.000Z");
  try {
    const writer = new ReviewDiskCache({ directory });
    await writer.publishObject(first);
    await writer.publishObject(second);
    const prefixes = new Set(
      [first.digest, second.digest].map((digest) =>
        digest.slice("sha256:".length, "sha256:".length + 2),
      ),
    );
    const indexAndInventoryEntries = prefixes.size + 2 + 3 * 2;
    const evictor = new ReviewDiskCache({
      directory,
      maxBytes: 0,
      maxScanEntries: indexAndInventoryEntries,
    });

    await assert.rejects(evictor.evict(), (error) => errorCode(error) === "cache_corrupt");
    assert.ok(await writer.getObject(first.digest));
    assert.ok(await writer.getObject(second.digest));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("eviction metadata publication rejects a replaced cache generation without external writes", async () => {
  const parent = await mkdtemp(join(tmpdir(), "remote-skills-cache-eviction-parent-swap-"));
  const directory = join(parent, "cache");
  const layoutDirectory = join(directory, "cache-v1");
  const parkedLayout = join(parent, "cache-v1.parked");
  const outside = join(parent, "outside");
  const outsideTemporary = join(outside, "tmp");
  const sentinel = join(outside, "sentinel.txt");
  let swapped = false;
  try {
    await mkdir(outsideTemporary, { recursive: true });
    await writeFile(sentinel, "external sentinel\n");
    const cache = new ReviewDiskCache({ directory });
    const ensureSafeDirectory = cacheInternals(cache).ensureSafeDirectory.bind(cache);
    cacheInternals(cache).ensureSafeDirectory = async (target) => {
      await ensureSafeDirectory(target);
      if (swapped || target !== join(layoutDirectory, "tmp")) return;
      await rename(layoutDirectory, parkedLayout);
      await symlink(outside, layoutDirectory, "dir");
      swapped = true;
    };

    await assert.rejects(cache.evict(), (error) => errorCode(error) === "cache_corrupt");
    assert.equal(swapped, true);
    assert.equal(await readFile(sentinel, "utf8"), "external sentinel\n");
    await assert.rejects(access(join(outside, "eviction.json")));
    assert.deepEqual(await readdir(outsideTemporary), []);
  } finally {
    if (swapped) {
      await rm(layoutDirectory, { force: true });
      await rename(parkedLayout, layoutDirectory);
    }
    await rm(parent, { recursive: true, force: true });
  }
});

test("repeated object publication tolerates concurrent eviction metadata generations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-publish-evict-"));
  let active: { digest: string; entered: VoidDeferred; release: VoidDeferred } | undefined;
  const operations: Array<CachePublication | CacheEviction> = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const cache = new ReviewDiskCache({
      directory,
      maxBytes: Number.MAX_SAFE_INTEGER,
      now: () => new Date("2026-08-25T10:00:02.000Z"),
      coordinationHooks: {
        beforeObjectPublicationCommit: async (digest) => {
          if (active?.digest !== digest) return;
          active.entered.resolve();
          await active.release.promise;
        },
      },
    });
    for (let index = 0; index < 5; index += 1) {
      const input = skillInput(`# publication versus eviction ${index}\n`);
      active = { digest: input.digest, entered: deferred(), release: deferred() };
      const publication = cache.publishObject(input);
      operations.push(publication);
      void publication.catch(() => undefined);
      await Promise.race([active.entered.promise, publication]);
      const eviction = cache.evict();
      operations.push(eviction);
      void eviction.catch(() => undefined);
      try {
        const evictionCompletedDuringPublication = await Promise.race([
          eviction.then(() => true),
          new Promise((resolve) => {
            timer = setTimeout(() => resolve(false), 50);
          }),
        ]);
        assert.equal(evictionCompletedDuringPublication, false);
      } finally {
        clearTimeout(timer);
        active.release.resolve();
      }
      assert.equal((await publication).metadata.digest, input.digest);
      await eviction;
      assert.ok(await cache.getObject(input.digest));
    }
  } finally {
    clearTimeout(timer);
    active?.release.resolve();
    await Promise.allSettled(operations);
    await rm(directory, { recursive: true, force: true });
  }
});

test("disk and memory object publication reject malformed runtime inputs with stable errors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-malformed-publish-"));
  const malformed = [null, undefined, 42, {}, { digest: "sha256:malformed" }];
  try {
    for (const cache of reviewCacheBackends(directory)) {
      for (const input of malformed) {
        await assert.rejects(
          publishObjectFromUnknown(cache, input),
          (error) => errorCode(error) === "cache_corrupt" && error instanceof TypeError === false,
        );
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("catalog commit rejects an oversized staged body and preserves the prior generation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-catalog-stage-cap-"));
  const canonicalUrl = "https://skills.example.test/.well-known/agent-skills/index.json";
  const oldBody = new TextEncoder().encode('{"generation":"old"}\n');
  const newBody = new TextEncoder().encode('{"generation":"new"}\n');
  try {
    await new ReviewDiskCache({ directory }).putCatalog(
      canonicalUrl,
      oldBody,
      validCatalogMetadata(),
    );
    const cache = new ReviewDiskCache({
      directory,
      coordinationHooks: {
        beforeCatalogCommit: () =>
          replaceStagedCatalogBody(directory, new Uint8Array(1_048_576 + 1)),
      },
    });

    await assert.rejects(
      cache.putCatalog(canonicalUrl, newBody, validCatalogMetadata()),
      (error) => errorCode(error) === "cache_corrupt",
    );
    assert.deepEqual((await cache.getCatalog(canonicalUrl))?.body, oldBody);
    await new ReviewDiskCache({ directory }).putCatalog(
      canonicalUrl,
      newBody,
      validCatalogMetadata(),
    );
    assert.deepEqual(
      (await new ReviewDiskCache({ directory }).getCatalog(canonicalUrl))?.body,
      newBody,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("catalog commit rejects a same-length staged body replacement after preserving the prior generation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-catalog-stage-identity-"));
  const canonicalUrl = "https://skills.example.test/.well-known/agent-skills/index.json";
  const oldBody = new TextEncoder().encode('{"generation":"old"}\n');
  const newBody = new TextEncoder().encode('{"generation":"new"}\n');
  const replacement = new Uint8Array(newBody.byteLength).fill("x".charCodeAt(0));
  try {
    await new ReviewDiskCache({ directory }).putCatalog(
      canonicalUrl,
      oldBody,
      validCatalogMetadata(),
    );
    const cache = new ReviewDiskCache({
      directory,
      coordinationHooks: {
        afterCatalogPreviousPublished: () => replaceStagedCatalogBody(directory, replacement),
      },
    });

    await assert.rejects(
      cache.putCatalog(canonicalUrl, newBody, validCatalogMetadata()),
      (error) => errorCode(error) === "cache_corrupt",
    );
    assert.deepEqual((await cache.getCatalog(canonicalUrl))?.body, oldBody);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("object reads share four scan entries with digest-lock registration teardown", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-operation-budget-"));
  const input = skillInput("# operation-wide budget\n");
  let lease: CacheLease | undefined;
  try {
    await new ReviewDiskCache({ directory }).publishObject(input);
    lease = await new ReviewDiskCache({
      directory,
      processNonce: "budget-peer",
      renewIntervalSeconds: 0,
    }).acquireLease(input.digest, "budget-session");
    const reader = new ReviewDiskCache({
      directory,
      maxScanEntries: 4,
      processNonce: "budget-reader",
      renewIntervalSeconds: 0,
    });

    await assert.rejects(
      reader.getObject(input.digest),
      (error) => errorCode(error) === "cache_corrupt",
    );
  } finally {
    await lease?.release();
    await rm(directory, { recursive: true, force: true });
  }
});

test("environment cache defaults require non-empty absolute platform paths", () => {
  const linuxFallback = "/home/alice/.cache/remote-skills";
  for (const value of ["", "relative/cache"]) {
    assert.equal(
      reviewDefaultCacheDirectory({
        platform: "linux",
        home: "/home/alice",
        env: { XDG_CACHE_HOME: value },
      }),
      linuxFallback,
    );
  }
  assert.equal(
    reviewDefaultCacheDirectory({
      platform: "linux",
      home: "/home/alice",
      env: { XDG_CACHE_HOME: "/var/cache/alice" },
    }),
    "/var/cache/alice/remote-skills",
  );

  const windowsFallback = "C:\\Users\\alice\\AppData\\Local\\remote-skills";
  for (const value of ["", "AppData\\Local", "C:relative-cache"]) {
    assert.equal(
      reviewDefaultCacheDirectory({
        platform: "win32",
        home: "C:\\Users\\alice",
        env: { LOCALAPPDATA: value },
      }),
      windowsFallback,
    );
  }
  assert.equal(
    reviewDefaultCacheDirectory({
      platform: "win32",
      home: "C:\\Users\\alice",
      env: { LOCALAPPDATA: "D:\\Cache" },
    }),
    "D:\\Cache\\remote-skills",
  );
});

test("environment cache defaults require an absolute fallback home on every platform", () => {
  for (const platform of ["linux", "darwin", "win32"] satisfies NodeJS.Platform[]) {
    for (const home of ["", "relative/home"]) {
      assert.throws(
        () => reviewDefaultCacheDirectory({ platform, home, env: {} }),
        (error) =>
          errorCode(error) === "configuration_invalid" && errorContext(error).field === "home",
      );
    }
  }

  assert.equal(
    reviewDefaultCacheDirectory({ platform: "linux", home: "/home/alice", env: {} }),
    "/home/alice/.cache/remote-skills",
  );
  assert.equal(
    reviewDefaultCacheDirectory({ platform: "darwin", home: "/Users/alice", env: {} }),
    "/Users/alice/Library/Caches/remote-skills",
  );
  assert.equal(
    reviewDefaultCacheDirectory({ platform: "win32", home: "C:\\Users\\alice", env: {} }),
    "C:\\Users\\alice\\AppData\\Local\\remote-skills",
  );
  assert.equal(
    reviewDefaultCacheDirectory({
      platform: "linux",
      home: "relative/home",
      env: { XDG_CACHE_HOME: "/var/cache/alice" },
    }),
    "/var/cache/alice/remote-skills",
  );
  assert.equal(
    reviewDefaultCacheDirectory({
      platform: "win32",
      home: "relative/home",
      env: { LOCALAPPDATA: "D:\\Cache" },
    }),
    "D:\\Cache\\remote-skills",
  );
});

test("confirmed scopes isolate catalog identity and store only sanitized scope metadata", async () => {
  const canonicalUrl = "https://skills.example.test/.well-known/agent-skills/index.json";
  const body = new TextEncoder().encode('{"skills":[]}\n');
  const timestamp = "2026-08-25T10:00:00.000Z";
  assert.equal(
    reviewOriginId(canonicalUrl, "engineering"),
    "9dc5c74ba396dc5b65ff423600466f65b6d0a1bfca3eb6866345481f98de17a9",
  );
  assert.equal(
    reviewCatalogMutationDigest(reviewOriginId(canonicalUrl, "engineering")),
    "sha256:7462c6cf357bb59bc58f0f8aa158cd5eadfa36c671dbcb6b2be4c4976f132514",
  );
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-scoped-catalog-"));
  try {
    for (const cache of [new ReviewMemoryCache(), new ReviewDiskCache({ directory })]) {
      await cache.putCatalog(canonicalUrl, body, {
        confirmedScope: "engineering",
        retrievedAt: timestamp,
        validatedAt: timestamp,
      });
      assert.equal(await cache.getCatalog(canonicalUrl, "sales"), null);
      assert.equal(
        (await cache.getCatalog(canonicalUrl, "engineering"))?.metadata.confirmedScope,
        "engineering",
      );
      const expected = await cache.getCatalogState(canonicalUrl, "engineering");
      assert.ok(expected.catalog);
      assert.equal(
        await cache.deleteCatalog(canonicalUrl, "engineering", expected.generation),
        true,
      );
      assert.equal(await cache.getCatalog(canonicalUrl, "engineering"), null);
    }
    await new ReviewDiskCache({ directory }).putCatalog(canonicalUrl, body, {
      confirmedScope: "engineering",
      retrievedAt: timestamp,
      validatedAt: timestamp,
    });
    const metadata = parseJsonRecord(
      await readFile(
        join(
          directory,
          "cache-v1",
          "catalogs",
          reviewOriginId(canonicalUrl, "engineering"),
          "metadata.json",
        ),
        "utf8",
      ),
    );
    assert.deepEqual(Object.keys(metadata).sort(), [
      "canonical_url",
      "confirmed_scope",
      "retrieved_at",
      "schema",
      "validated_at",
    ]);
    assert.equal(metadata.confirmed_scope, "engineering");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("catalog compare-and-swap uses opaque generations and rejects value ABA", async () => {
  const canonicalUrl = "https://skills.example.test/.well-known/agent-skills/index.json";
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-catalog-cas-"));
  const catalog = (generation: string, validatedAt: string) => ({
    body: new TextEncoder().encode(`${JSON.stringify({ generation })}\n`),
    metadata: {
      canonicalUrl,
      confirmedScope: "engineering",
      etag: `"${generation}"`,
      retrievedAt: validatedAt,
      validatedAt,
    },
  });
  try {
    const cacheCases: Array<[string, ReviewMemoryCache | ReviewDiskCache, ReviewDiskCache | null]> =
      [
        ["memory", new ReviewMemoryCache(), null],
        ["disk", new ReviewDiskCache({ directory }), new ReviewDiskCache({ directory })],
      ];
    for (const [cacheKind, first, second] of cacheCases) {
      const writer = second ?? first;
      const seed = catalog("seed", "2026-08-25T10:00:00.000Z");
      const winner = catalog("winner", "2026-08-25T10:00:01.000Z");
      const loser = catalog("loser", "2026-08-25T10:00:02.000Z");
      const absent = await first.getCatalogState(canonicalUrl, "engineering");
      const otherAbsent = await first.getCatalogState(canonicalUrl, "sales");
      assert.equal(absent.catalog, null);
      assert.equal(await first.replaceCatalog(seed, absent.generation), true, `${cacheKind}: seed`);
      assert.equal(
        await first.replaceCatalog(
          {
            ...loser,
            metadata: { ...loser.metadata, confirmedScope: "sales" },
          },
          otherAbsent.generation,
        ),
        false,
        `${cacheKind}: global absence epoch`,
      );
      const expected = await first.getCatalogState(canonicalUrl, "engineering");
      assert.ok(expected.catalog);
      assert.equal(
        await writer.replaceCatalog(winner, expected.generation),
        true,
        `${cacheKind}: replace`,
      );
      assert.equal(
        await first.replaceCatalog(loser, expected.generation),
        false,
        `${cacheKind}: stale replace`,
      );
      assert.equal(
        await first.deleteCatalog(canonicalUrl, "engineering", expected.generation),
        false,
        `${cacheKind}: stale delete`,
      );
      const winnerState = await first.getCatalogState(canonicalUrl, "engineering");
      assert.ok(winnerState.catalog);
      assert.equal(
        await writer.replaceCatalog(seed, winnerState.generation),
        true,
        `${cacheKind}: restore equal seed value`,
      );
      assert.equal(
        await first.replaceCatalog(loser, expected.generation),
        false,
        `${cacheKind}: ABA token`,
      );
      const current = await first.getCatalogState(canonicalUrl, "engineering");
      assert.ok(current.catalog);
      assert.equal(
        parseJsonRecord(new TextDecoder().decode(current.catalog.body)).generation,
        "seed",
      );
      assert.equal(
        await writer.deleteCatalog(canonicalUrl, "engineering", current.generation),
        true,
        `${cacheKind}: current delete`,
      );
      const deleted = await first.getCatalogState(canonicalUrl, "engineering");
      assert.equal(deleted.catalog, null);
      assert.notEqual(deleted.generation, absent.generation, `${cacheKind}: absence ABA`);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("disk catalog generation state is canonical, bounded, and fails closed", async () => {
  const canonicalUrl = "https://skills.example.test/.well-known/agent-skills/index.json";
  const scope = "engineering";
  const identifier = reviewOriginId(canonicalUrl, scope);
  const catalog = {
    body: new TextEncoder().encode('{"generation":"seed"}\n'),
    metadata: {
      canonicalUrl,
      confirmedScope: scope,
      retrievedAt: "2026-08-25T10:00:00.000Z",
      validatedAt: "2026-08-25T10:00:00.000Z",
    },
  };
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-catalog-generation-state-"));
  try {
    const cache = new ReviewDiskCache({ directory });
    const absent = await cache.getCatalogState(canonicalUrl, scope);
    assert.equal(absent.catalog, null);
    assert.equal(
      absent.generation,
      "sha256:7725e9fbcff20c13382b646153055b324c70b6cf41c5df734687fb685cff2c6a",
    );
    assert.equal(absent.generation, reviewCatalogAbsenceGeneration(identifier, 0));
    assert.equal(await cache.replaceCatalog(catalog, absent.generation), true);

    const root = join(directory, "cache-v1", "tmp", "catalog-generations-v1");
    assert.deepEqual(parseJsonRecord(await readFile(join(root, "state.json"), "utf8")), {
      schema: "remote-skills-catalog-generation-state-v1",
      generation: 1,
    });
    const generationPath = join(directory, "cache-v1", "catalogs", identifier, "generation.json");
    const storedGeneration = parseJsonRecord(await readFile(generationPath, "utf8"));
    assert.deepEqual(Object.keys(storedGeneration).sort(), [
      "catalog_identifier",
      "generation",
      "schema",
      "state",
    ]);
    assert.deepEqual(
      {
        schema: storedGeneration.schema,
        catalog_identifier: storedGeneration.catalog_identifier,
        state: storedGeneration.state,
      },
      {
        schema: "remote-skills-catalog-generation-v1",
        catalog_identifier: identifier,
        state: "present",
      },
    );
    assert.match(requiredString(storedGeneration, "generation"), /^sha256:[0-9a-f]{64}$/u);

    await rm(generationPath);
    await assert.rejects(
      cache.getCatalogState(canonicalUrl, scope),
      (error) => errorCode(error) === "cache_corrupt",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }

  for (const state of [undefined, { schema: "remote-skills-catalog-generation-state-v1" }]) {
    const corruptRoot = await mkdtemp(join(tmpdir(), "remote-skills-catalog-state-corrupt-"));
    try {
      const root = join(corruptRoot, "cache-v1", "tmp", "catalog-generations-v1");
      await mkdir(root, { recursive: true });
      if (state !== undefined) await writeFile(join(root, "state.json"), JSON.stringify(state));
      await assert.rejects(
        new ReviewDiskCache({ directory: corruptRoot }).getCatalogState(canonicalUrl, scope),
        (error) => errorCode(error) === "cache_corrupt",
      );
    } finally {
      await rm(corruptRoot, { recursive: true, force: true });
    }
  }

  const exhaustedRoot = await mkdtemp(join(tmpdir(), "remote-skills-catalog-state-exhausted-"));
  try {
    const root = join(exhaustedRoot, "cache-v1", "tmp", "catalog-generations-v1");
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, "state.json"),
      `${JSON.stringify({
        schema: "remote-skills-catalog-generation-state-v1",
        generation: Number.MAX_SAFE_INTEGER,
      })}\n`,
    );
    const cache = new ReviewDiskCache({ directory: exhaustedRoot });
    const exhausted = await cache.getCatalogState(canonicalUrl, scope);
    assert.equal(exhausted.catalog, null);
    await assert.rejects(
      cache.replaceCatalog(catalog, exhausted.generation),
      (error) => errorCode(error) === "cache_corrupt",
    );
    assert.equal((await cache.getCatalogState(canonicalUrl, scope)).catalog, null);
  } finally {
    await rm(exhaustedRoot, { recursive: true, force: true });
  }
});

test("TypeScript and Python reject actual-process older-last catalog mutations", async () => {
  const canonicalUrl = "https://skills.example.test/.well-known/agent-skills/index.json";
  const pythonSource =
    process.env.REMOTE_SKILLS_PYTHON_CAS_SOURCE ??
    fileURLToPath(new URL("../../../sdk-python/src/", import.meta.url));
  const pythonScript = `
import base64
import json
import sys
import time
from datetime import datetime
from pathlib import Path
from remote_skills.cache import CachedCatalog, CatalogMetadata, DiskCache

mode, root, canonical_url, scope, ready, start, result, body, timestamp = sys.argv[1:]
cache = DiskCache(root, touch_on_read=False)
expected_generation = cache.get_catalog_state(canonical_url, confirmed_scope=scope).generation
Path(ready).write_text("ready", encoding="utf-8")
while not Path(start).exists():
    time.sleep(0.002)
if mode == "delete":
    won = cache.delete_catalog(
        canonical_url,
        confirmed_scope=scope,
        expected_generation=expected_generation,
    )
else:
    instant = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
    candidate = CachedCatalog(
        body=base64.b64decode(body),
        metadata=CatalogMetadata(
            canonical_url=canonical_url,
            confirmed_scope=scope,
            etag='"python-stale"',
            retrieved_at=instant,
            validated_at=instant,
        ),
    )
    won = cache.replace_catalog(candidate, expected_generation=expected_generation)
Path(result).write_text(json.dumps({"won": won}), encoding="utf-8")
`;
  const timestamp = (second: number) => `2026-08-25T10:00:0${second}.000Z`;
  const catalog = (name: string, second: number, bodyName = name) => ({
    body: new TextEncoder().encode(`${JSON.stringify({ generation: bodyName })}\n`),
    metadata: {
      canonicalUrl,
      confirmedScope: "engineering",
      etag: `"${name}"`,
      retrievedAt: timestamp(second),
      validatedAt: timestamp(second),
    },
  });
  const root = await mkdtemp(join(tmpdir(), "remote-skills-cross-runtime-catalog-cas-"));
  try {
    for (const scenario of ["200", "304", "no-store", "invalid-delete", "missing"]) {
      const directory = join(root, scenario);
      const coordination = join(root, `${scenario}-coordination`);
      const ready = join(coordination, "ready");
      const start = join(coordination, "start");
      const result = join(coordination, "result.json");
      await mkdir(coordination, { recursive: true });
      const cache = new ReviewDiskCache({ directory });
      if (scenario !== "missing") {
        const absent = await cache.getCatalogState(canonicalUrl, "engineering");
        assert.equal(
          await cache.replaceCatalog(catalog("seed", 0), absent.generation),
          true,
          scenario,
        );
      }
      const expected = await cache.getCatalogState(canonicalUrl, "engineering");
      const staleBody =
        scenario === "304"
          ? catalog("python-stale", 2, "seed").body
          : catalog("python-stale", 2).body;
      const child = spawn(
        process.env.REMOTE_SKILLS_PYTHON ?? "python3",
        [
          "-c",
          pythonScript,
          scenario === "no-store" || scenario === "invalid-delete" ? "delete" : "replace",
          directory,
          canonicalUrl,
          "engineering",
          ready,
          start,
          result,
          Buffer.from(staleBody).toString("base64"),
          timestamp(2),
        ],
        {
          env: { ...process.env, PYTHONPATH: pythonSource },
          stdio: ["ignore", "ignore", "pipe"],
        },
      );
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      const completion = new Promise((resolve) => child.once("exit", resolve));
      try {
        await waitForPath(ready, 30_000);
        assert.equal(
          await cache.replaceCatalog(catalog("winner", 1), expected.generation),
          true,
          scenario,
        );
        await writeFile(start, "start", "utf8");
        assert.equal(await completion, 0, stderr);
        assert.deepEqual(parseJsonRecord(await readFile(result, "utf8")), { won: false }, scenario);
        const current = await cache.getCatalog(canonicalUrl, "engineering");
        assert.ok(current, scenario);
        assert.equal(parseJsonRecord(new TextDecoder().decode(current.body)).generation, "winner");
      } finally {
        await writeFile(start, "start", "utf8").catch(() => {});
        if (child.exitCode === null) child.kill("SIGKILL");
        await completion;
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("digest lock registration cannot overlap a contender after publication expiry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-lock-registration-race-"));
  const input = skillInput("# lock registration race\n");
  const registrationPaused = deferred();
  const releaseRegistration = deferred();
  const contenderEntered = deferred();
  const releaseContender = deferred();
  const ownerEntered = deferred();
  const releaseOwner = deferred();
  let activeCriticalSections = 0;
  let overlaps = 0;
  try {
    const owner = new ReviewDiskCache({
      directory,
      leaseExpirySeconds: 1,
      now: () => new Date("2026-08-25T10:00:00.000Z"),
      processNonce: "registration-owner",
    });
    const contender = new ReviewDiskCache({
      directory,
      leaseExpirySeconds: 1,
      now: () => new Date("2026-08-25T10:00:02.000Z"),
      processNonce: "registration-contender",
    });
    const writeRegistration = cacheInternals(owner).writeProcessRegistration.bind(owner);
    let paused = false;
    cacheInternals(owner).writeProcessRegistration = async (hex) => {
      if (!paused) {
        paused = true;
        registrationPaused.resolve();
        await releaseRegistration.promise;
      }
      return writeRegistration(hex);
    };
    const criticalSection = async (entered: VoidDeferred, release: VoidDeferred): Promise<void> => {
      activeCriticalSections += 1;
      if (activeCriticalSections > 1) overlaps += 1;
      entered.resolve();
      await release.promise;
      activeCriticalSections -= 1;
    };

    const ownerTask = cacheInternals(owner).withDigestLock(input.digest, () =>
      criticalSection(ownerEntered, releaseOwner),
    );
    await registrationPaused.promise;
    const contenderTask = cacheInternals(contender).withDigestLock(input.digest, () =>
      criticalSection(contenderEntered, releaseContender),
    );
    await contenderEntered.promise;
    releaseRegistration.resolve();

    const ownerEnteredWhileContenderHeld = await Promise.race([
      ownerEntered.promise.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 50)),
    ]);
    assert.equal(ownerEnteredWhileContenderHeld, false);
    assert.equal(overlaps, 0);

    releaseContender.resolve();
    await ownerEntered.promise;
    releaseOwner.resolve();
    await Promise.all([ownerTask, contenderTask]);
    assert.equal(overlaps, 0);
  } finally {
    releaseRegistration.resolve();
    releaseContender.resolve();
    releaseOwner.resolve();
    await rm(directory, { recursive: true, force: true });
  }
});

test("concurrent eviction decisions retain exactly one of two fitting objects", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-eviction-decision-race-"));
  const now = () => new Date("2026-08-25T10:00:02.000Z");
  const first = skillInput("a".repeat(64), "2026-08-25T10:00:00.000Z");
  const second = skillInput("b".repeat(64), "2026-08-25T10:00:01.000Z");
  const firstListed = deferred();
  const release = deferred();
  try {
    const writer = new ReviewDiskCache({ directory, now });
    await writer.publishObject(first);
    await writer.publishObject(second);
    const evictors = [
      new ReviewDiskCache({
        directory,
        maxBytes: 129,
        now,
        processNonce: "eviction-decision-one",
      }),
      new ReviewDiskCache({
        directory,
        maxBytes: 129,
        now,
        processNonce: "eviction-decision-two",
      }),
    ];
    const firstEvictor = evictors[0];
    const secondEvictor = evictors[1];
    assert.ok(firstEvictor && secondEvictor);
    const firstList = cacheInternals(firstEvictor).listObjectRows.bind(firstEvictor);
    cacheInternals(firstEvictor).listObjectRows = async (...args) => {
      const rows = await firstList(...args);
      firstListed.resolve();
      await release.promise;
      return rows;
    };
    const secondList = cacheInternals(secondEvictor).listObjectRows.bind(secondEvictor);
    cacheInternals(secondEvictor).listObjectRows = async (...args) => {
      const rows = await secondList(...args);
      release.resolve();
      return rows;
    };

    const firstDecision = firstEvictor.evict();
    await firstListed.promise;
    const fallback = setTimeout(() => release.resolve(), 50);
    const secondDecision = secondEvictor.evict();
    const results = await Promise.all([firstDecision, secondDecision]);
    clearTimeout(fallback);
    assert.deepEqual(
      results.map(({ totalBytes }) => totalBytes),
      [128, 128],
    );
    const survivors = await Promise.all([
      writer.getObject(first.digest),
      writer.getObject(second.digest),
    ]);
    assert.equal(survivors.filter((object) => object !== null).length, 1);
  } finally {
    release.resolve();
    await rm(directory, { recursive: true, force: true });
  }
});

test("object publication cannot enter after an eviction decision has scanned the namespace", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-evict-scan-publish-"));
  const now = () => new Date("2026-08-25T10:00:02.000Z");
  const baseline = skillInput("a".repeat(64));
  const concurrent = skillInput("b".repeat(64), "2026-08-25T10:00:01.000Z");
  const scanned = deferred();
  const releaseScan = deferred();
  const publicationEntered = deferred();
  const releasePublication = deferred();
  let eviction: CacheEviction | undefined;
  let publication: CachePublication | undefined;
  try {
    await new ReviewDiskCache({ directory, now }).publishObject(baseline);
    const evictor = new ReviewDiskCache({ directory, maxBytes: 1_000, now });
    const listObjectRows = cacheInternals(evictor).listObjectRows.bind(evictor);
    cacheInternals(evictor).listObjectRows = async (...args) => {
      const rows = await listObjectRows(...args);
      scanned.resolve();
      await releaseScan.promise;
      return rows;
    };
    const publisher = new ReviewDiskCache({
      directory,
      now,
      coordinationHooks: {
        beforeObjectPublicationCommit: async () => {
          publicationEntered.resolve();
          await releasePublication.promise;
        },
      },
    });

    eviction = evictor.evict();
    await scanned.promise;
    publication = publisher.publishObject(concurrent);
    const enteredDuringDecision = await Promise.race([
      publicationEntered.promise.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 50)),
    ]);
    assert.equal(enteredDuringDecision, false);
    releaseScan.resolve();
    const result = await eviction;
    await publicationEntered.promise;
    assert.equal(result.totalBytes, baseline.artifact.byteLength * 2);
    assert.ok(await new ReviewDiskCache({ directory, now }).getObject(baseline.digest));
    const concurrentHex = concurrent.digest.replace("sha256:", "");
    await assert.rejects(
      access(
        join(
          directory,
          "cache-v1",
          "objects",
          "sha256",
          concurrentHex.slice(0, 2),
          concurrentHex.slice(2),
        ),
      ),
    );
    releasePublication.resolve();
    await publication;
  } finally {
    releaseScan.resolve();
    releasePublication.resolve();
    await Promise.allSettled([eviction, publication].filter(Boolean));
    await rm(directory, { recursive: true, force: true });
  }
});

test("object publication cannot enter while eviction is removing another digest", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-evict-remove-publish-"));
  const removed = skillInput("c".repeat(64));
  const concurrent = skillInput("d".repeat(64), "2026-08-25T10:00:01.000Z");
  const removalEntered = deferred();
  const releaseRemoval = deferred();
  const publicationEntered = deferred();
  const releasePublication = deferred();
  let eviction: CacheEviction | undefined;
  let publication: CachePublication | undefined;
  try {
    await new ReviewDiskCache({ directory }).publishObject(removed);
    const evictor = new ReviewDiskCache({
      directory,
      maxBytes: 0,
      coordinationHooks: {
        beforeObjectEvictionCommit: async () => {
          removalEntered.resolve();
          await releaseRemoval.promise;
        },
      },
    });
    const publisher = new ReviewDiskCache({
      directory,
      coordinationHooks: {
        beforeObjectPublicationCommit: async () => {
          publicationEntered.resolve();
          await releasePublication.promise;
        },
      },
    });

    eviction = evictor.evict();
    await removalEntered.promise;
    publication = publisher.publishObject(concurrent);
    const enteredDuringRemoval = await Promise.race([
      publicationEntered.promise.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 50)),
    ]);
    assert.equal(enteredDuringRemoval, false);
    releaseRemoval.resolve();
    const result = await eviction;
    await publicationEntered.promise;
    assert.equal(result.totalBytes, 0);
    assert.equal(await new ReviewDiskCache({ directory }).getObject(removed.digest), null);
    const concurrentHex = concurrent.digest.replace("sha256:", "");
    await assert.rejects(
      access(
        join(
          directory,
          "cache-v1",
          "objects",
          "sha256",
          concurrentHex.slice(0, 2),
          concurrentHex.slice(2),
        ),
      ),
    );
    releasePublication.resolve();
    await publication;
  } finally {
    releaseRemoval.resolve();
    releasePublication.resolve();
    await Promise.allSettled([eviction, publication].filter(Boolean));
    await rm(directory, { recursive: true, force: true });
  }
});

test("catalog generations retain newer metadata and use last-committer-wins ties in memory and disk", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-catalog-order-"));
  const canonicalUrl = "https://skills.example.test/.well-known/agent-skills/index.json";
  const newerBody = new TextEncoder().encode('{"generation":"newer"}\n');
  const olderBody = new TextEncoder().encode('{"generation":"older"}\n');
  const tiedBody = new TextEncoder().encode('{"generation":"tie-winner"}\n');
  const newer = {
    retrievedAt: "2026-08-25T10:59:00.000Z",
    validatedAt: "2026-08-25T11:00:00.000Z",
  };
  const older = {
    retrievedAt: "2026-08-25T09:59:00.000Z",
    validatedAt: "2026-08-25T10:00:00.000Z",
  };
  try {
    for (const cache of reviewCacheBackends(directory)) {
      await cache.putCatalog(canonicalUrl, newerBody, newer);
      await cache.putCatalog(canonicalUrl, olderBody, older);
      assert.deepEqual((await cache.getCatalog(canonicalUrl))?.body, newerBody);
      await cache.putCatalog(canonicalUrl, tiedBody, newer);
      assert.deepEqual((await cache.getCatalog(canonicalUrl))?.body, tiedBody);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a staged older disk catalog cannot replace a concurrently committed newer generation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-catalog-delayed-order-"));
  const canonicalUrl = "https://skills.example.test/.well-known/agent-skills/index.json";
  const olderBody = new TextEncoder().encode('{"generation":"older"}\n');
  const newerBody = new TextEncoder().encode('{"generation":"newer"}\n');
  const staged = deferred();
  const release = deferred();
  try {
    const older = new ReviewDiskCache({ directory, processNonce: "catalog-delayed-older" });
    const withDigestLock = cacheInternals(older).withDigestLock.bind(older);
    let paused = false;
    cacheInternals(older).withDigestLock = async (...args) => {
      if (!paused) {
        paused = true;
        staged.resolve();
        await release.promise;
      }
      return withDigestLock(...args);
    };
    const olderPublication = older.putCatalog(canonicalUrl, olderBody, {
      retrievedAt: "2026-08-25T09:59:00.000Z",
      validatedAt: "2026-08-25T10:00:00.000Z",
    });
    await staged.promise;
    await new ReviewDiskCache({
      directory,
      processNonce: "catalog-immediate-newer",
    }).putCatalog(canonicalUrl, newerBody, {
      retrievedAt: "2026-08-25T10:59:00.000Z",
      validatedAt: "2026-08-25T11:00:00.000Z",
    });
    release.resolve();
    await olderPublication;

    const final = await new ReviewDiskCache({ directory }).getCatalog(canonicalUrl);
    assert.ok(final);
    assert.deepEqual(final.body, newerBody);
    assert.equal(final.metadata.validatedAt, "2026-08-25T11:00:00.000Z");
  } finally {
    release.resolve();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a previous-only newer catalog generation survives an older publication", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-catalog-previous-order-"));
  const canonicalUrl = "https://skills.example.test/.well-known/agent-skills/index.json";
  const originId = reviewOriginId(canonicalUrl);
  const current = join(directory, "cache-v1", "catalogs", originId);
  const previous = join(
    directory,
    "cache-v1",
    "tmp",
    "catalog-generations-v1",
    originId,
    "previous",
  );
  const newerBody = new TextEncoder().encode('{"generation":"newer-previous"}\n');
  const olderBody = new TextEncoder().encode('{"generation":"older-current"}\n');
  try {
    const cache = new ReviewDiskCache({ directory });
    await cache.putCatalog(canonicalUrl, newerBody, {
      retrievedAt: "2026-08-25T10:59:00.000Z",
      validatedAt: "2026-08-25T11:00:00.000Z",
    });
    await mkdir(dirname(previous), { recursive: true });
    await rename(current, previous);

    await cache.putCatalog(canonicalUrl, olderBody, {
      retrievedAt: "2026-08-25T09:59:00.000Z",
      validatedAt: "2026-08-25T10:00:00.000Z",
    });

    const final = await cache.getCatalog(canonicalUrl);
    assert.ok(final);
    assert.deepEqual(final.body, newerBody);
    assert.equal(final.metadata.validatedAt, "2026-08-25T11:00:00.000Z");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a delayed older eviction run cannot regress eviction metadata time", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-eviction-order-"));
  const entered = deferred();
  const release = deferred();
  try {
    const older = new ReviewDiskCache({
      directory,
      now: () => new Date("2026-08-25T10:00:00.000Z"),
    });
    const newer = new ReviewDiskCache({
      directory,
      now: () => new Date("2026-08-25T11:00:00.000Z"),
    });
    const ensureSafeDirectory = cacheInternals(older).ensureSafeDirectory.bind(older);
    let paused = false;
    cacheInternals(older).ensureSafeDirectory = async (target) => {
      await ensureSafeDirectory(target);
      if (paused || target !== join(directory, "cache-v1", "tmp")) return;
      paused = true;
      entered.resolve();
      await release.promise;
    };

    const delayed = older.evict();
    await entered.promise;
    await newer.evict();
    release.resolve();
    await delayed;

    const metadata = parseJsonRecord(
      await readFile(join(directory, "cache-v1", "eviction.json"), "utf8"),
    );
    assert.equal(metadata.last_run_at, "2026-08-25T11:00:00.000Z");
  } finally {
    release.resolve();
    await rm(directory, { recursive: true, force: true });
  }
});

test("twenty concurrent evictions preserve monotonic advisory metadata", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-eviction-stress-"));
  const backgroundErrors: unknown[] = [];
  const timestamps = Array.from(
    { length: 20 },
    (_, index) => `2026-08-25T10:${String(index).padStart(2, "0")}:00.000Z`,
  );
  try {
    for (let round = 0; round < 1; round += 1) {
      const caches = timestamps.map(
        (timestamp, index) =>
          new ReviewDiskCache({
            directory,
            now: () => new Date(timestamp),
            processNonce: `eviction-stress-${round}-${index}`,
            onBackgroundError: (error) => backgroundErrors.push(error),
          }),
      );
      const settled = await Promise.allSettled(caches.map((cache) => cache.evict()));
      const rejected = settled.flatMap((result) =>
        result.status === "rejected"
          ? [{ code: errorCode(result.reason), message: errorMessage(result.reason) }]
          : [],
      );
      assert.deepEqual(rejected, []);
      const results = settled.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : [],
      );
      assert.equal(results.length, 20);
      const metadata = parseJsonRecord(
        await readFile(join(directory, "cache-v1", "eviction.json"), "utf8"),
      );
      assert.equal(metadata.last_run_at, timestamps.at(-1));
    }
    assert.deepEqual(backgroundErrors, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("concurrent catalog writers guard private generations instead of shared tmp metadata", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-catalog-stress-"));
  const canonicalUrl = "https://skills.example.test/.well-known/agent-skills/index.json";
  try {
    for (let round = 0; round < 12; round += 1) {
      const bodies = [
        new TextEncoder().encode(`{"writer":"left","round":${round}}\n`),
        new TextEncoder().encode(`{"writer":"right","round":${round}}\n`),
      ];
      const writers = [
        new ReviewDiskCache({ directory, processNonce: `catalog-left-${round}` }),
        new ReviewDiskCache({ directory, processNonce: `catalog-right-${round}` }),
      ];
      await Promise.all(
        writers.map((writer, index) => {
          const body = bodies[index];
          assert.ok(body);
          return writer.putCatalog(canonicalUrl, body, validCatalogMetadata());
        }),
      );
      const final = await new ReviewDiskCache({ directory }).getCatalog(canonicalUrl);
      assert.ok(final);
      assert.ok(bodies.some((body) => Buffer.compare(body, final.body) === 0));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("object byte limits keep protocol defaults and allow explicit memory and disk overrides", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-cache-object-limits-"));
  const input = archiveInput();
  const artifactBytes = input.artifact.byteLength;
  const extractedBytes = [...input.files.values()].reduce(
    (sum, bytes) => sum + bytes.byteLength,
    0,
  );
  const largestFileBytes = Math.max(...[...input.files.values()].map((bytes) => bytes.byteLength));
  const common = { verifyExtractedContents: () => true };
  try {
    const defaultMemory = new ReviewMemoryCache();
    const defaultDisk = new ReviewDiskCache({ directory });
    for (const cache of [defaultMemory, defaultDisk]) {
      assert.equal(cache.maxArtifactBytes, 50 * 1_024 * 1_024);
      assert.equal(cache.maxExtractedBytes, 100 * 1_024 * 1_024);
      assert.equal(cache.maxExtractedFileBytes, 10 * 1_024 * 1_024);
    }

    const limitCases: Array<[string, DiskCacheOptions, DiskCacheOptions]> = [
      ["artifact", { maxArtifactBytes: artifactBytes - 1 }, { maxArtifactBytes: artifactBytes }],
      [
        "aggregate",
        { maxExtractedBytes: extractedBytes - 1 },
        { maxExtractedBytes: extractedBytes },
      ],
      [
        "file",
        { maxExtractedFileBytes: largestFileBytes - 1 },
        { maxExtractedFileBytes: largestFileBytes },
      ],
    ];
    for (const [name, rejectedOptions, acceptedOptions] of limitCases) {
      const limitDirectory = join(directory, name);
      for (const cache of reviewCacheBackends(limitDirectory, { ...common, ...rejectedOptions })) {
        await assert.rejects(
          cache.publishObject(input),
          (error) => errorCode(error) === "cache_corrupt",
        );
        assert.equal(await cache.getObject(input.digest), null);
      }
      const memory = new ReviewMemoryCache({ ...common, ...acceptedOptions });
      const disk = new ReviewDiskCache({
        directory: limitDirectory,
        ...common,
        ...acceptedOptions,
      });
      assert.equal((await memory.publishObject(input)).metadata.digest, input.digest);
      assert.equal((await disk.publishObject(input)).metadata.digest, input.digest);
      assert.equal((await memory.getObject(input.digest))?.metadata.digest, input.digest);
      assert.equal(
        (
          await new ReviewDiskCache({
            directory: limitDirectory,
            ...common,
            ...acceptedOptions,
          }).getObject(input.digest)
        )?.metadata.digest,
        input.digest,
      );
      await assert.rejects(
        new ReviewDiskCache({
          directory: limitDirectory,
          ...common,
          ...rejectedOptions,
        }).getObject(input.digest),
        (error) => errorCode(error) === "cache_corrupt",
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("memory cache normalizes invalid clocks and verifier failures without leaking causes", async () => {
  const invalidClockInput = skillInput("# invalid memory clock\n");
  const {
    verifiedAt: _verifiedAt,
    accessedAt: _accessedAt,
    ...invalidClockInputWithoutTimestamps
  } = invalidClockInput;
  const canary = "secret-verifier-canary";
  const cases: Array<[ReviewMemoryCache, PublishObjectInput]> = [
    [
      new ReviewMemoryCache({ now: () => new Date(Number.NaN) }),
      invalidClockInputWithoutTimestamps,
    ],
    [
      new ReviewMemoryCache({
        verifyExtractedContents: () => {
          throw new Error(canary);
        },
      }),
      archiveInput(),
    ],
  ];
  for (const [cache, input] of cases) {
    await assert.rejects(cache.publishObject(input), (error) => {
      assert.equal(errorCode(error), "cache_corrupt");
      assert.equal(String(error).includes(canary), false);
      assert.equal(JSON.stringify(errorContext(error)).includes(canary), false);
      return true;
    });
    assert.equal(await cache.getObject(input.digest), null);
  }
});

test("multiple processes publish the static race fixture without partial observations", async () => {
  const parent = await mkdtemp(join(tmpdir(), "remote-skills-cache-race-"));
  const directory = join(parent, "cache");
  const controlDirectory = join(parent, "control");
  await mkdir(controlDirectory);
  const releaseWriters = join(controlDirectory, "release-staged-writers");
  const firstReady = join(controlDirectory, "writer-one-staged");
  const secondReady = join(controlDirectory, "writer-two-staged");
  const publicationStart = join(controlDirectory, "start-publication");
  const observationComplete = join(controlDirectory, "observation-complete");
  const finishWriters = join(controlDirectory, "finish-writers");
  const stateRoot = fileURLToPath(new URL("fixtures/cache/states/cross-process/", protocolRoot));
  const artifactPath = join(
    stateRoot,
    "before",
    "cache-v1",
    "tmp",
    "writer-typescript-0001",
    "artifact",
  );
  const metadataPath = join(
    stateRoot,
    "after",
    "cache-v1",
    "objects",
    "sha256",
    "e4",
    "bb9c0cb022778c3e22703220eb387a5405b2025dad77b870291fc692c4e21d",
    "object.json",
  );
  const input = await validFixtureObjectInput();
  const first = startRaceWriter([
    directory,
    artifactPath,
    metadataPath,
    firstReady,
    releaseWriters,
    publicationStart,
    observationComplete,
    finishWriters,
  ]);
  const second = startRaceWriter([
    directory,
    artifactPath,
    metadataPath,
    secondReady,
    releaseWriters,
    publicationStart,
    observationComplete,
    finishWriters,
  ]);
  try {
    await Promise.all([waitForPath(firstReady, 10_000), waitForPath(secondReady, 10_000)]);
    const cache = new ReviewDiskCache({ directory });
    let preReleaseReadsWhileRunning = 0;
    let inFlightCompleteObservations = 0;
    let partialObservations = 0;
    assert.equal(await cache.getObject(input.digest), null);
    if (first.child.exitCode === null || second.child.exitCode === null) {
      preReleaseReadsWhileRunning += 1;
    }
    await writeFile(releaseWriters, "go");
    await Promise.all([
      waitForWriterMessages(first, "released", 1),
      waitForWriterMessages(second, "released", 1),
    ]);
    const releasedAcknowledgements = [...first.messages, ...second.messages].filter(
      (message) => message?.type === "released",
    ).length;
    const releasedObservation = await cache.getObject(input.digest);
    assert.equal(releasedObservation, null);
    await writeFile(publicationStart, "publish");
    await Promise.race([
      waitForWriterMessages(first, "critical-section", 1),
      waitForWriterMessages(second, "critical-section", 1),
    ]);
    const criticalSectionAcknowledgements = [...first.messages, ...second.messages].filter(
      (message) => message?.type === "critical-section",
    ).length;
    let overlappingReadSettled = false;
    const overlappingRead = cache.getObject(input.digest).then(
      (observation) => {
        overlappingReadSettled = true;
        return observation;
      },
      (error) => {
        overlappingReadSettled = true;
        throw error;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    const overlappingReadBlocked = !overlappingReadSettled;
    assert.equal(overlappingReadBlocked, true);
    await writeFile(observationComplete, "observed");
    try {
      const observation = await overlappingRead;
      if (observation === null) {
        partialObservations += 1;
      } else {
        assert.equal(observation.metadata.digest, input.digest);
        assert.deepEqual(observation.artifact, input.artifact);
        assert.deepEqual(observation.root.get("SKILL.md"), input.files.get("SKILL.md"));
        if (first.child.exitCode === null || second.child.exitCode === null) {
          inFlightCompleteObservations += 1;
        }
      }
    } catch {
      partialObservations += 1;
    }
    await Promise.all([
      waitForWriterMessages(first, "published", 1),
      waitForWriterMessages(second, "published", 1),
    ]);

    const publishedMessages = [...first.messages, ...second.messages].filter(
      (message) => message?.type === "published",
    );
    const publishedAcknowledgements = publishedMessages.length;
    await writeFile(finishWriters, "finish");

    const completed = Promise.all([first.completion, second.completion]);
    const deadline = Date.now() + 5_000;
    while (await Promise.race([completed.then(() => false), delayTick()])) {
      if (Date.now() >= deadline) throw new Error("race writers exceeded their deadline");
      await delayTick();
    }
    await completed;

    const object = await cache.getObject(input.digest);
    assert.ok(object);
    assert.deepEqual(
      new Set(publishedMessages.map(({ digest }) => digest)),
      new Set([input.digest]),
    );
    assertMultiprocessObservationEvidence({
      releasedAcknowledgements,
      criticalSectionAcknowledgements,
      publishedAcknowledgements,
      partialObservations,
      inFlightCompleteObservations,
      overlappingReadBlocked,
    });
    assert.ok(preReleaseReadsWhileRunning > 0);
    assert.deepEqual(await readdir(join(directory, "cache-v1", "tmp")), []);
    assert.equal(object.metadata.verifiedAt, "2026-08-25T10:00:01.000Z");
  } finally {
    await stopRaceWriters([first, second]);
    await rm(parent, { recursive: true, force: true });
  }
});

async function delayTick() {
  await new Promise((resolve) => setTimeout(resolve, 1));
  return true;
}

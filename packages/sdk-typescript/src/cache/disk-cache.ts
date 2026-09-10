import { randomBytes, randomUUID } from "node:crypto";
import { type BigIntStats, constants, type Dirent, type Stats } from "node:fs";
import { link, lstat, mkdir, open, opendir, rename, rm, rmdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

import {
  CacheConfigurationError,
  CacheCorruptError,
  isSafeNonce,
  requireFiniteLimit,
  requireSafeNonce,
} from "./errors.ts";
import {
  canonicalOriginIdentifier,
  catalogAbsenceGeneration,
  catalogMutationDigest,
  defaultCacheDirectory,
  sanitizeCanonicalUrl,
} from "./paths.ts";
import {
  CACHE_LAYOUT_NAMESPACE,
  type CacheBackend,
  type CacheClock,
  type CachedCatalog,
  type CachedObject,
  type CacheLease,
  type CatalogMetadataInput,
  type CatalogState,
  type CleanupResult,
  type EvictionResult,
  type ExtractedContentsVerifier,
  type ObjectMetadata,
  type ProcessLiveness,
  type PublishObjectInput,
} from "./types.ts";
import {
  CACHE_MAX_ARTIFACT_BYTES,
  CACHE_MAX_CATALOG_BODY_BYTES,
  CACHE_MAX_CATALOG_METADATA_BYTES,
  CACHE_MAX_EXTRACTED_BYTES,
  CACHE_MAX_EXTRACTED_FILE_BYTES,
  CACHE_MAX_FILES_PER_OBJECT,
  CACHE_MAX_OBJECT_METADATA_BYTES,
  compareCatalogMetadataFreshness,
  digestHex,
  isTimestamp,
  objectMetadataWireByteLength,
  sha256,
  snapshotCatalogBody,
  snapshotCatalogMetadataInput,
  snapshotPublishObjectInput,
  validateExtractedContentBinding,
  validatePortablePaths,
} from "./validation.ts";

export type DiskCacheOptions = {
  directory?: string;
  maxBytes?: number;
  maxAgeSeconds?: number;
  leaseExpirySeconds?: number;
  temporaryExpirySeconds?: number;
  renewIntervalSeconds?: number;
  maxScanEntries?: number;
  maxObjectMetadataBytes?: number;
  maxFilesPerObject?: number;
  maxArtifactBytes?: number;
  maxExtractedBytes?: number;
  maxExtractedFileBytes?: number;
  now?: CacheClock;
  isProcessAlive?: ProcessLiveness;
  pid?: number;
  processNonce?: string;
  verifyExtractedContents?: ExtractedContentsVerifier;
  onBackgroundError?: (error: unknown) => void;
  coordinationHooks?: DiskCacheCoordinationHooks;
};

export type DiskCacheCoordinationHooks = {
  beforeCatalogCommit?: () => void | Promise<void>;
  afterCatalogPreviousPublished?: () => void | Promise<void>;
  beforeCatalogGenerationOpen?: (path: string) => void | Promise<void>;
  afterLeaseDirectoryPrepared?: (path: string) => void | Promise<void>;
  beforeLeaseWrite?: (path: string) => void | Promise<void>;
  beforeLeaseCleanupUnlink?: (path: string) => void | Promise<void>;
  beforeObjectPublicationCommit?: (digest: string) => void | Promise<void>;
  afterObjectStaging?: (digest: string) => void | Promise<void>;
  beforeObjectEvictionCommit?: (digest: string) => void | Promise<void>;
  afterObjectEvictionQuarantine?: (digest: string) => void | Promise<void>;
  afterCatalogEvictionQuarantine?: (originId: string) => void | Promise<void>;
  beforeTemporaryCleanup?: (path: string) => void | Promise<void>;
  afterTemporaryCleanupScan?: (path: string) => void | Promise<void>;
  beforeMutationTurnState?: () => void | Promise<void>;
  afterObjectGenerationGuardOpen?: () => void | Promise<void>;
  beforeDirectoryRemoval?: (path: string) => void | Promise<void>;
};

const MAX_TIMER_DELAY_MILLISECONDS = 2_147_483_647;
const MAX_COORDINATION_RECORD_BYTES = 65_536;
const FILESYSTEM_TIMESTAMP_SKEW_MILLISECONDS = 1_000;
const DEFAULT_MAX_SCAN_ENTRIES = 100_000;
const FATAL_UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const EVICTION_METADATA_LOCK_DIGEST = `sha256:${sha256(
  new TextEncoder().encode("remote-skills-cache-eviction-metadata-v1"),
)}`;
const EVICTION_DECISION_LOCK_DIGEST = `sha256:${sha256(
  new TextEncoder().encode("remote-skills-cache-eviction-decision-v1"),
)}`;

type StoredCatalogMetadata = {
  schema: "remote-skills-catalog-metadata-v1";
  canonical_url: string;
  confirmed_scope?: string;
  etag?: string;
  last_modified?: string;
  cache_control?: string;
  retrieved_at: string;
  validated_at: string;
};

type StoredCatalogGeneration = {
  schema: "remote-skills-catalog-generation-v1";
  catalog_identifier: string;
  generation: string;
  state: "present";
};

type StoredCatalogGenerationState = {
  schema: "remote-skills-catalog-generation-state-v1";
  generation: number;
};

type StoredEvictionMetadata = {
  schema: "remote-skills-eviction-metadata-v1";
  last_run_at: string;
  max_bytes: number;
  max_age_seconds: number;
  candidate_order: ["accessed_at", "digest"];
};

type CatalogGenerationSnapshot = {
  directoryIdentity: Stats;
  body: RegularFileSnapshot;
  metadata: RegularFileSnapshot;
  generation: RegularFileSnapshot | undefined;
  generationToken: string | undefined;
  stored: StoredCatalogMetadata;
};

type StoredObjectMetadata = {
  schema: "remote-skills-object-metadata-v1";
  digest: string;
  artifact_type: string;
  archive_format: string | null;
  artifact_bytes: number;
  extracted_bytes: number;
  files: Array<{ path: string; size: number; media_type: string }>;
  verified_at: string;
  accessed_at: string;
};

type StoredLease = {
  schema: "remote-skills-cache-lease-v1";
  digest: string;
  pid: number;
  process_nonce: string;
  session_nonce: string;
  created_at: string;
  renewed_at: string;
  lease_nonce?: string;
};

type StoredWriter = {
  schema: "remote-skills-cache-writer-v1";
  writer: "typescript";
  pid: number;
  process_nonce: string;
  expected_digest: string;
  bytes_received: number;
  complete: boolean;
};

type ParsedWriter = {
  schema?: string;
  writer?: string;
  pid?: number;
  process_nonce?: string;
  expected_digest?: string;
  bytes_received?: number;
  complete?: boolean;
};

type StoredMutationLock = {
  schema: "remote-skills-cache-mutation-lock-v1";
  pid: number;
  process_nonce: string;
  owner_nonce: string;
  ticket: number;
  created_at: string;
  operation?: "acquire" | "evict" | "mutation";
  contended_with_eviction?: boolean;
};

type StoredMutationIntent = {
  schema: "remote-skills-cache-mutation-intent-v1";
  pid: number;
  process_nonce: string;
  owner_nonce: string;
  created_at: string;
  operation?: "acquire" | "evict" | "mutation";
  contended_with_eviction?: boolean;
};

type ParsedMutationRecord = {
  schema?: string;
  pid?: number;
  process_nonce?: string;
  owner_nonce?: string;
  ticket?: number;
  created_at?: string;
  operation?: string;
  contended_with_eviction?: boolean;
};

type StoredProcessRegistration = {
  schema: "remote-skills-cache-process-registration-v1";
  pid: number;
  process_nonce: string;
  process_identity?: string;
  renewed_at: string;
};

type OpenDirectoryGuard = {
  path: string;
  identity: BigIntStats;
  changeToken: string;
  handle: Awaited<ReturnType<typeof open>>;
};

type ObjectGenerationGuard = {
  digest: string;
  directories: OpenDirectoryGuard[];
};

type ObjectScanRow = {
  digest: string;
  artifactBytes: number;
  extractedBytes: number;
  accessedAt: string;
};

type CatalogScanRow = {
  originId: string;
  canonicalUrl: string;
  generation: "current" | "previous";
  directory: string;
  snapshot: CatalogGenerationSnapshot;
  bytes: number;
  accessedAt: string;
};

type ProcessRegistrationHeartbeat = {
  stop(): Promise<{ final: boolean; identity?: Stats }>;
};

function parsedObject(value: unknown, label: string): { [key: string]: unknown } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return Object.fromEntries(Object.entries(value));
}

function parsedString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  return value;
}

function parsedNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite number`);
  }
  return value;
}

function parsedBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${label} must be a boolean`);
  return value;
}

function parsedOptionalString(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : parsedString(value, label);
}

function requireParsedKeys(
  value: { [key: string]: unknown },
  expected: readonly string[],
  label: string,
): void {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    throw new TypeError(`${label} has unexpected fields`);
  }
}

function parseStoredObjectMetadata(value: unknown): StoredObjectMetadata {
  const raw = parsedObject(value, "object metadata");
  requireParsedKeys(
    raw,
    [
      "accessed_at",
      "archive_format",
      "artifact_bytes",
      "artifact_type",
      "digest",
      "extracted_bytes",
      "files",
      "schema",
      "verified_at",
    ],
    "object metadata",
  );
  if (raw.schema !== "remote-skills-object-metadata-v1") {
    throw new TypeError("object metadata has an unsupported schema");
  }
  if (!Array.isArray(raw.files)) throw new TypeError("object metadata files must be an array");
  const files = raw.files.map((value, index) => {
    const file = parsedObject(value, `object metadata files[${index}]`);
    requireParsedKeys(file, ["media_type", "path", "size"], `object metadata files[${index}]`);
    return {
      path: parsedString(file.path, `object metadata files[${index}].path`),
      size: parsedNumber(file.size, `object metadata files[${index}].size`),
      media_type: parsedString(file.media_type, `object metadata files[${index}].media_type`),
    };
  });
  const archiveFormat = raw.archive_format;
  if (archiveFormat !== null && typeof archiveFormat !== "string") {
    throw new TypeError("object metadata archive_format must be a string or null");
  }
  return {
    schema: "remote-skills-object-metadata-v1",
    digest: parsedString(raw.digest, "object metadata digest"),
    artifact_type: parsedString(raw.artifact_type, "object metadata artifact_type"),
    archive_format: archiveFormat,
    artifact_bytes: parsedNumber(raw.artifact_bytes, "object metadata artifact_bytes"),
    extracted_bytes: parsedNumber(raw.extracted_bytes, "object metadata extracted_bytes"),
    files,
    verified_at: parsedString(raw.verified_at, "object metadata verified_at"),
    accessed_at: parsedString(raw.accessed_at, "object metadata accessed_at"),
  };
}

function parseMutationRecord(value: unknown): ParsedMutationRecord {
  const raw = parsedObject(value, "mutation record");
  return {
    ...(raw.schema === undefined ? {} : { schema: parsedString(raw.schema, "mutation schema") }),
    ...(raw.pid === undefined ? {} : { pid: parsedNumber(raw.pid, "mutation pid") }),
    ...(raw.process_nonce === undefined
      ? {}
      : { process_nonce: parsedString(raw.process_nonce, "mutation process nonce") }),
    ...(raw.owner_nonce === undefined
      ? {}
      : { owner_nonce: parsedString(raw.owner_nonce, "mutation owner nonce") }),
    ...(raw.ticket === undefined ? {} : { ticket: parsedNumber(raw.ticket, "mutation ticket") }),
    ...(raw.created_at === undefined
      ? {}
      : { created_at: parsedString(raw.created_at, "mutation created_at") }),
    ...(raw.operation === undefined
      ? {}
      : { operation: parsedString(raw.operation, "mutation operation") }),
    ...(raw.contended_with_eviction === undefined
      ? {}
      : {
          contended_with_eviction: parsedBoolean(
            raw.contended_with_eviction,
            "mutation eviction contention",
          ),
        }),
  };
}

function parseStoredWriter(value: unknown): ParsedWriter {
  const raw = parsedObject(value, "writer metadata");
  const schema = parsedOptionalString(raw.schema, "writer schema");
  const writer = parsedOptionalString(raw.writer, "writer implementation");
  return {
    ...(schema === undefined ? {} : { schema }),
    ...(writer === undefined ? {} : { writer }),
    ...(raw.pid === undefined ? {} : { pid: parsedNumber(raw.pid, "writer pid") }),
    ...(raw.process_nonce === undefined
      ? {}
      : { process_nonce: parsedString(raw.process_nonce, "writer process nonce") }),
    ...(raw.expected_digest === undefined
      ? {}
      : { expected_digest: parsedString(raw.expected_digest, "writer expected digest") }),
    ...(raw.bytes_received === undefined
      ? {}
      : { bytes_received: parsedNumber(raw.bytes_received, "writer bytes received") }),
    ...(raw.complete === undefined
      ? {}
      : { complete: parsedBoolean(raw.complete, "writer completion") }),
  };
}

function parseStoredProcessRegistration(value: unknown): Partial<StoredProcessRegistration> {
  const raw = parsedObject(value, "process registration");
  const schema = parsedOptionalString(raw.schema, "process registration schema");
  if (schema !== undefined && schema !== "remote-skills-cache-process-registration-v1") {
    throw new TypeError("process registration has an unsupported schema");
  }
  return {
    ...(schema === undefined ? {} : { schema }),
    ...(raw.pid === undefined ? {} : { pid: parsedNumber(raw.pid, "process registration pid") }),
    ...(raw.process_nonce === undefined
      ? {}
      : { process_nonce: parsedString(raw.process_nonce, "process registration nonce") }),
    ...(raw.process_identity === undefined
      ? {}
      : {
          process_identity: parsedString(raw.process_identity, "process registration identity"),
        }),
    ...(raw.renewed_at === undefined
      ? {}
      : { renewed_at: parsedString(raw.renewed_at, "process registration renewed_at") }),
  };
}

function parseStoredLease(value: unknown): StoredLease {
  const raw = parsedObject(value, "cache lease");
  if (raw.schema !== "remote-skills-cache-lease-v1") {
    throw new TypeError("cache lease has an unsupported schema");
  }
  const leaseNonce = parsedOptionalString(raw.lease_nonce, "cache lease nonce");
  requireParsedKeys(
    raw,
    [
      "created_at",
      "digest",
      ...(leaseNonce === undefined ? [] : ["lease_nonce"]),
      "pid",
      "process_nonce",
      "renewed_at",
      "schema",
      "session_nonce",
    ],
    "cache lease",
  );
  return {
    schema: "remote-skills-cache-lease-v1",
    digest: parsedString(raw.digest, "cache lease digest"),
    pid: parsedNumber(raw.pid, "cache lease pid"),
    process_nonce: parsedString(raw.process_nonce, "cache lease process nonce"),
    session_nonce: parsedString(raw.session_nonce, "cache lease session nonce"),
    created_at: parsedString(raw.created_at, "cache lease created_at"),
    renewed_at: parsedString(raw.renewed_at, "cache lease renewed_at"),
    ...(leaseNonce === undefined ? {} : { lease_nonce: leaseNonce }),
  };
}

function isConfirmedScope(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 128 &&
    !value.includes(",") &&
    /^[\x21-\x7e]+$/u.test(value)
  );
}

type ProcessRegistrationState = {
  references: number;
  identity: Stats;
  queue: Promise<void>;
  interval: NodeJS.Timeout | undefined;
};

class CachePathChangedError extends CacheCorruptError {
  constructor() {
    super("cache path identity changed", { layout_version: CACHE_LAYOUT_NAMESPACE });
  }
}

class CacheScanBudget {
  private entries = 0;
  private readonly limit: number;

  constructor(limit: number) {
    this.limit = limit;
  }

  consume(): void {
    this.entries += 1;
    if (this.entries > this.limit) {
      throw new CacheCorruptError("cache scan entry limit exceeded", {
        layout_version: CACHE_LAYOUT_NAMESPACE,
      });
    }
  }
}

async function readDirectoryBounded(directory: string, budget: CacheScanBudget): Promise<Dirent[]> {
  const entries: Dirent[] = [];
  for await (const entry of await opendir(directory)) {
    budget.consume();
    entries.push(entry);
  }
  return entries;
}

function serializeJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function decodeUtf8(bytes: Uint8Array): string {
  return FATAL_UTF8_DECODER.decode(bytes);
}

function isStoredCatalogMetadata(
  value: unknown,
  canonicalUrl: string,
): value is StoredCatalogMetadata {
  if (value === null || typeof value !== "object") return false;
  const stored = value as Partial<StoredCatalogMetadata>;
  const required = ["schema", "canonical_url", "retrieved_at", "validated_at"];
  const allowed = new Set([
    ...required,
    "confirmed_scope",
    "etag",
    "last_modified",
    "cache_control",
  ]);
  const keys = Object.keys(stored);
  return (
    required.every((key) => Object.hasOwn(stored, key)) &&
    keys.every((key) => allowed.has(key)) &&
    stored.schema === "remote-skills-catalog-metadata-v1" &&
    stored.canonical_url === canonicalUrl &&
    (stored.confirmed_scope === undefined || isConfirmedScope(stored.confirmed_scope)) &&
    isTimestamp(stored.retrieved_at) &&
    isTimestamp(stored.validated_at) &&
    (stored.etag === undefined || typeof stored.etag === "string") &&
    (stored.last_modified === undefined || typeof stored.last_modified === "string") &&
    (stored.cache_control === undefined || typeof stored.cache_control === "string")
  );
}

function isCatalogGeneration(
  value: unknown,
  expectedIdentifier: string,
): value is StoredCatalogGeneration {
  if (value === null || typeof value !== "object") return false;
  const stored = value as Partial<StoredCatalogGeneration>;
  return (
    JSON.stringify(Object.keys(stored).sort()) ===
      JSON.stringify(["catalog_identifier", "generation", "schema", "state"]) &&
    stored.schema === "remote-skills-catalog-generation-v1" &&
    stored.catalog_identifier === expectedIdentifier &&
    typeof stored.generation === "string" &&
    /^sha256:[0-9a-f]{64}$/u.test(stored.generation) &&
    stored.state === "present"
  );
}

function isCatalogGenerationState(value: unknown): value is StoredCatalogGenerationState {
  if (value === null || typeof value !== "object") return false;
  const stored = value as Partial<StoredCatalogGenerationState>;
  return (
    JSON.stringify(Object.keys(stored).sort()) === JSON.stringify(["generation", "schema"]) &&
    stored.schema === "remote-skills-catalog-generation-state-v1" &&
    typeof stored.generation === "number" &&
    Number.isSafeInteger(stored.generation) &&
    stored.generation >= 1
  );
}

function isStoredEvictionMetadata(value: unknown): value is StoredEvictionMetadata {
  if (value === null || typeof value !== "object") return false;
  const stored = value as Partial<StoredEvictionMetadata>;
  return (
    JSON.stringify(Object.keys(stored).sort()) ===
      JSON.stringify([
        "candidate_order",
        "last_run_at",
        "max_age_seconds",
        "max_bytes",
        "schema",
      ]) &&
    stored.schema === "remote-skills-eviction-metadata-v1" &&
    isTimestamp(stored.last_run_at) &&
    typeof stored.max_bytes === "number" &&
    Number.isSafeInteger(stored.max_bytes) &&
    stored.max_bytes >= 0 &&
    typeof stored.max_age_seconds === "number" &&
    Number.isSafeInteger(stored.max_age_seconds) &&
    stored.max_age_seconds >= 0 &&
    JSON.stringify(stored.candidate_order) === JSON.stringify(["accessed_at", "digest"])
  );
}

async function writeSyncedFile(path: string, value: Uint8Array | string): Promise<void> {
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    await handle.writeFile(value);
    await handle.sync();
    const [opened, current] = await Promise.all([handle.stat(), lstat(path)]);
    const expectedSize = typeof value === "string" ? Buffer.byteLength(value) : value.byteLength;
    if (
      !opened.isFile() ||
      !current.isFile() ||
      current.isSymbolicLink() ||
      opened.nlink !== 1 ||
      current.nlink !== 1 ||
      opened.size !== expectedSize ||
      current.size !== expectedSize ||
      !isSameIdentity(opened, current)
    ) {
      throw new CachePathChangedError();
    }
  } finally {
    await handle.close();
  }
}

function isSameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}

function isSameExactIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}

function isSameRegularFileState(left: Stats, right: Stats): boolean {
  return (
    isSameIdentity(left, right) &&
    left.size === right.size &&
    left.nlink === right.nlink &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

async function directoryChangeToken(path: string): Promise<string> {
  const state = await lstat(path, { bigint: true });
  return `${state.dev}:${state.ino}:${state.ctimeNs}:${state.mtimeNs}:${state.nlink}`;
}

async function openDirectoryNoFollow(path: string): Promise<OpenDirectoryGuard> {
  const before = await lstat(path, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink()) throw new CachePathChangedError();
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isDirectory() || !isSameExactIdentity(before, opened)) {
      throw new CachePathChangedError();
    }
    const changeToken = await directoryChangeToken(path);
    return { path, identity: opened, changeToken, handle };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function verifyDirectoryGuard(
  guard: OpenDirectoryGuard,
  requireUnchangedMetadata = false,
): Promise<void> {
  const [opened, current] = await Promise.all([
    guard.handle.stat({ bigint: true }),
    lstat(guard.path, { bigint: true }),
  ]);
  if (
    !opened.isDirectory() ||
    !current.isDirectory() ||
    current.isSymbolicLink() ||
    !isSameExactIdentity(guard.identity, opened) ||
    !isSameExactIdentity(guard.identity, current)
  ) {
    throw new CachePathChangedError();
  }
  if (requireUnchangedMetadata && (await directoryChangeToken(guard.path)) !== guard.changeToken) {
    throw new CachePathChangedError();
  }
}

async function withDirectoryGuard<T>(path: string, action: () => Promise<T>): Promise<T> {
  const guard = await openDirectoryNoFollow(path);
  try {
    const value = await action();
    await verifyDirectoryGuard(guard);
    return value;
  } finally {
    await guard.handle.close();
  }
}

function cacheRelativeParts(root: string, target: string): string[] {
  const child = relative(root, target);
  if (child === "") return [];
  if (isAbsolute(child) || child === ".." || child.startsWith(`..${sep}`)) {
    throw new CachePathChangedError();
  }
  return child.split(sep);
}

async function openDirectoryChainNoFollow(
  root: string,
  target: string,
): Promise<OpenDirectoryGuard[]> {
  const guards: OpenDirectoryGuard[] = [];
  try {
    let current = root;
    guards.push(await openDirectoryNoFollow(current));
    for (const part of cacheRelativeParts(root, target)) {
      current = join(current, part);
      guards.push(await openDirectoryNoFollow(current));
    }
    return guards;
  } catch (error) {
    await Promise.all(guards.map(({ handle }) => handle.close()));
    throw error;
  }
}

async function withDirectoryChainGuard<T>(
  root: string,
  target: string,
  action: () => Promise<T>,
): Promise<T> {
  const guards = await openDirectoryChainNoFollow(root, target);
  try {
    const value = await action();
    for (const guard of guards) await verifyDirectoryGuard(guard);
    return value;
  } finally {
    await Promise.all(guards.map(({ handle }) => handle.close()));
  }
}

async function withDirectoryChainsMutationGuard<T>(
  root: string,
  targets: Iterable<string>,
  beforeMutation: () => void | Promise<void>,
  mutation: (verifyCommit: () => Promise<void>) => Promise<T>,
  detectAncestorAba = false,
): Promise<T> {
  const guards = new Map<string, OpenDirectoryGuard>();
  const targetSet = new Set(targets);
  try {
    for (const target of targetSet) {
      for (const guard of await openDirectoryChainNoFollow(root, target)) {
        const duplicate = guards.get(guard.path);
        if (duplicate === undefined) guards.set(guard.path, guard);
        else await guard.handle.close();
      }
    }
    const verifyCommit = async (): Promise<void> => {
      const sharedLayoutDirectory = join(root, CACHE_LAYOUT_NAMESPACE);
      const sharedTemporaryDirectory = join(sharedLayoutDirectory, "tmp");
      for (const guard of guards.values()) {
        await verifyDirectoryGuard(
          guard,
          detectAncestorAba &&
            !targetSet.has(guard.path) &&
            guard.path !== sharedLayoutDirectory &&
            guard.path !== sharedTemporaryDirectory,
        );
      }
    };
    await beforeMutation();
    await verifyCommit();
    const value = await mutation(verifyCommit);
    await verifyCommit();
    return value;
  } finally {
    await Promise.all([...guards.values()].map(({ handle }) => handle.close()));
  }
}

type RegularFileSnapshot = { bytes: Uint8Array; identity: Stats };

async function readRegularFileSnapshotNoFollow(
  path: string,
  maxBytes: number,
): Promise<RegularFileSnapshot> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maxBytes) {
    throw new CachePathChangedError();
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.size > maxBytes ||
      !isSameRegularFileState(before, opened)
    ) {
      throw new CachePathChangedError();
    }
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    while (totalBytes < maxBytes) {
      const capacity = Math.min(64 * 1_024, maxBytes - totalBytes);
      const chunk = Buffer.allocUnsafe(capacity);
      const { bytesRead } = await handle.read(chunk, 0, capacity, totalBytes);
      if (bytesRead === 0) break;
      chunks.push(new Uint8Array(chunk.buffer, chunk.byteOffset, bytesRead));
      totalBytes += bytesRead;
    }
    if (totalBytes === maxBytes) {
      const probe = Buffer.allocUnsafe(1);
      if ((await handle.read(probe, 0, 1, totalBytes)).bytesRead !== 0) {
        throw new CachePathChangedError();
      }
    }
    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const [afterOpened, afterPath] = await Promise.all([handle.stat(), lstat(path)]);
    if (
      !afterPath.isFile() ||
      afterPath.isSymbolicLink() ||
      afterOpened.nlink !== 1 ||
      afterPath.nlink !== 1 ||
      afterOpened.size !== totalBytes ||
      afterPath.size !== totalBytes ||
      !isSameRegularFileState(opened, afterOpened) ||
      !isSameRegularFileState(opened, afterPath)
    ) {
      throw new CachePathChangedError();
    }
    return { bytes, identity: afterOpened };
  } finally {
    await handle.close();
  }
}

async function readRegularFileNoFollow(path: string, maxBytes: number): Promise<Uint8Array> {
  return (await readRegularFileSnapshotNoFollow(path, maxBytes)).bytes;
}

async function unlinkIfSameIdentity(path: string, identity: Stats): Promise<void> {
  try {
    const current = await lstat(path);
    if (!current.isSymbolicLink() && current.isFile() && isSameIdentity(current, identity)) {
      await rm(path, { force: true });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function unlinkIfSameSnapshot(path: string, expected: RegularFileSnapshot): Promise<boolean> {
  try {
    const current = await readRegularFileSnapshotNoFollow(path, MAX_COORDINATION_RECORD_BYTES);
    if (
      !isSameRegularFileState(expected.identity, current.identity) ||
      Buffer.compare(Buffer.from(expected.bytes), Buffer.from(current.bytes)) !== 0
    ) {
      return false;
    }
    await rm(path, { force: true });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function validateCatalogDirectoryInventory(
  directory: string,
  scanBudget: CacheScanBudget,
): Promise<void> {
  const expected = new Set(["body.json", "metadata.json"]);
  let generationFound = false;
  await withDirectoryGuard(directory, async () => {
    for await (const entry of await opendir(directory)) {
      scanBudget.consume();
      if (entry.name === "generation.json") {
        if (generationFound) {
          throw new CacheCorruptError("catalog cache directory inventory is corrupt", {
            layout_version: CACHE_LAYOUT_NAMESPACE,
          });
        }
        generationFound = true;
      } else if (!expected.delete(entry.name)) {
        throw new CacheCorruptError("catalog cache directory inventory is corrupt", {
          layout_version: CACHE_LAYOUT_NAMESPACE,
        });
      }
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new CacheCorruptError("catalog cache directory inventory is corrupt", {
          layout_version: CACHE_LAYOUT_NAMESPACE,
        });
      }
      const state = await lstat(join(directory, entry.name));
      if (!state.isFile() || state.isSymbolicLink() || state.nlink !== 1) {
        throw new CacheCorruptError("catalog cache directory inventory is corrupt", {
          layout_version: CACHE_LAYOUT_NAMESPACE,
        });
      }
    }
  });
  if (expected.size !== 0) {
    throw new CacheCorruptError("catalog cache directory inventory is corrupt", {
      layout_version: CACHE_LAYOUT_NAMESPACE,
    });
  }
}

async function validateObjectDirectoryInventory(
  directory: string,
  budget: CacheScanBudget,
): Promise<void> {
  const expected = new Map<string, "file" | "directory">([
    ["artifact", "file"],
    ["object.json", "file"],
    ["root", "directory"],
  ]);
  await withDirectoryGuard(directory, async () => {
    for await (const entry of await opendir(directory)) {
      budget.consume();
      if (expected.size === 0) {
        throw new CacheCorruptError("cache object directory inventory is corrupt", {
          layout_version: CACHE_LAYOUT_NAMESPACE,
        });
      }
      const expectedType = expected.get(entry.name);
      if (expectedType === undefined || entry.isSymbolicLink()) {
        throw new CacheCorruptError("cache object directory inventory is corrupt", {
          layout_version: CACHE_LAYOUT_NAMESPACE,
        });
      }
      const state = await lstat(join(directory, entry.name));
      if (
        state.isSymbolicLink() ||
        (expectedType === "file" && (!entry.isFile() || !state.isFile())) ||
        (expectedType === "directory" && (!entry.isDirectory() || !state.isDirectory()))
      ) {
        throw new CacheCorruptError("cache object directory inventory is corrupt", {
          layout_version: CACHE_LAYOUT_NAMESPACE,
        });
      }
      expected.delete(entry.name);
    }
  });
  if (expected.size !== 0) {
    throw new CacheCorruptError("cache object directory inventory is corrupt", {
      layout_version: CACHE_LAYOUT_NAMESPACE,
    });
  }
}

async function validateStagedObjectDirectoryInventory(
  directory: string,
  budget: CacheScanBudget,
): Promise<void> {
  const expected = new Map<string, "file" | "directory">([
    ["artifact", "file"],
    ["object.json", "file"],
    ["root", "directory"],
    ["writer.json", "file"],
  ]);
  await withDirectoryGuard(directory, async () => {
    for await (const entry of await opendir(directory)) {
      budget.consume();
      const expectedType = expected.get(entry.name);
      if (expectedType === undefined || entry.isSymbolicLink()) {
        throw new CacheCorruptError("cache object staging inventory is corrupt", {
          layout_version: CACHE_LAYOUT_NAMESPACE,
        });
      }
      const state = await lstat(join(directory, entry.name));
      if (
        state.isSymbolicLink() ||
        (expectedType === "file" && (!entry.isFile() || !state.isFile())) ||
        (expectedType === "directory" && (!entry.isDirectory() || !state.isDirectory()))
      ) {
        throw new CacheCorruptError("cache object staging inventory is corrupt", {
          layout_version: CACHE_LAYOUT_NAMESPACE,
        });
      }
      expected.delete(entry.name);
    }
  });
  if (expected.size !== 0) {
    throw new CacheCorruptError("cache object staging inventory is corrupt", {
      layout_version: CACHE_LAYOUT_NAMESPACE,
    });
  }
}

async function walkRegularFiles(
  root: string,
  expectedSizes: ReadonlyMap<string, number>,
  budget: CacheScanBudget,
): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();
  const visit = async (directory: string): Promise<void> => {
    await withDirectoryGuard(directory, async () => {
      for await (const entry of await opendir(directory)) {
        budget.consume();
        const absolute = join(directory, entry.name);
        const state = await lstat(absolute);
        if (state.isSymbolicLink()) throw new CachePathChangedError();
        if (state.isDirectory()) await visit(absolute);
        else if (state.isFile()) {
          const cachePath = relative(root, absolute).split(sep).join("/");
          const expectedSize = expectedSizes.get(cachePath);
          if (expectedSize === undefined) {
            throw new CacheCorruptError("cache object file table is corrupt", {
              layout_version: CACHE_LAYOUT_NAMESPACE,
            });
          }
          files.set(cachePath, await readRegularFileNoFollow(absolute, expectedSize));
        } else {
          throw new CacheCorruptError("cache object contains a non-regular file", {
            layout_version: CACHE_LAYOUT_NAMESPACE,
          });
        }
      }
    });
  };
  await visit(root);
  return files;
}

async function defaultProcessLiveness(pid: number): Promise<boolean> {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function readLinuxProcessStartToken(pid: number): Promise<string | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(`/proc/${pid}/stat`, constants.O_RDONLY);
    const bytes = Buffer.alloc(4_097);
    const { bytesRead } = await handle.read(bytes, 0, bytes.byteLength, 0);
    if (bytesRead === bytes.byteLength) return undefined;
    const value = bytes.subarray(0, bytesRead).toString("utf8");
    const closingParenthesis = value.lastIndexOf(")");
    if (closingParenthesis < 0) return undefined;
    const fields = value
      .slice(closingParenthesis + 1)
      .trim()
      .split(/\s+/u);
    const startTicks = fields[19];
    return /^\d+$/u.test(startTicks ?? "") ? `linux:${startTicks}` : undefined;
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => {});
  }
}

const CURRENT_PROCESS_IDENTITY = `node:${process.pid}:${Math.floor(performance.timeOrigin)}`;

async function defaultProcessIdentity(pid: number): Promise<string | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  if (process.platform === "linux") return readLinuxProcessStartToken(pid);
  if (pid === process.pid) return CURRENT_PROCESS_IDENTITY;
  return undefined;
}

async function matchesLegacyNodeIdentityForLinuxProcess(
  identity: string,
  pid: number,
  registrationState: Stats,
  currentIdentity: string,
): Promise<boolean> {
  // The immediate predecessor wrote Node time origins on Linux. Its token cannot be
  // reproduced by a peer. Bind it to the current /proc directory generation and to
  // the registration generation's stored ctime instead of sampling the mutable wall
  // clock. A later wall-clock step cannot invalidate those two fixed observations,
  // while a registration left by an earlier occupant of a reused PID fails closed.
  if (process.platform !== "linux") return false;
  const match = /^node:(\d+):(\d+)$/u.exec(identity);
  const currentMatch = /^linux:(\d+)$/u.exec(currentIdentity);
  if (match === null || currentMatch === null || Number(match[1]) !== pid) return false;
  const timeOrigin = Number(match[2]);
  const startTicks = Number(currentMatch[1]);
  if (
    !Number.isSafeInteger(timeOrigin) ||
    timeOrigin <= 0 ||
    !Number.isSafeInteger(startTicks) ||
    startTicks < 0
  )
    return false;
  let before: Stats;
  let after: Stats;
  try {
    before = await lstat(`/proc/${pid}`);
    const confirmedIdentity = await readLinuxProcessStartToken(pid);
    after = await lstat(`/proc/${pid}`);
    if (
      confirmedIdentity !== currentIdentity ||
      !before.isDirectory() ||
      before.isSymbolicLink() ||
      !isSameIdentity(before, after)
    ) {
      return false;
    }
  } catch {
    return false;
  }
  const procTimestampResolutionMilliseconds = 1_000;
  return (
    timeOrigin >= before.ctimeMs - procTimestampResolutionMilliseconds &&
    timeOrigin <= before.ctimeMs + procTimestampResolutionMilliseconds &&
    registrationState.ctimeMs >= before.ctimeMs
  );
}

export class DiskCache implements CacheBackend {
  readonly maxCatalogBytes = CACHE_MAX_CATALOG_BODY_BYTES;
  readonly directory: string;
  readonly layoutDirectory: string;
  readonly maxBytes: number;
  readonly maxAgeSeconds: number;
  readonly leaseExpirySeconds: number;
  readonly temporaryExpirySeconds: number;
  readonly renewIntervalSeconds: number;
  readonly maxScanEntries: number;
  readonly maxObjectMetadataBytes: number;
  readonly maxFilesPerObject: number;
  readonly maxArtifactBytes: number;
  readonly maxExtractedBytes: number;
  readonly maxExtractedFileBytes: number;
  private readonly mutationLockTimeoutSeconds: number;
  private readonly now: CacheClock;
  private readonly isProcessAlive: ProcessLiveness;
  private readonly hasInjectedProcessLiveness: boolean;
  private readonly pid: number;
  private readonly processNonce: string;
  private readonly verifyExtractedContents: ExtractedContentsVerifier | undefined;
  private readonly onBackgroundError: (error: unknown) => void;
  private readonly coordinationHooks: DiskCacheCoordinationHooks;
  private readonly processRegistrationStates = new Map<string, Promise<ProcessRegistrationState>>();
  private renameFile = rename;

  constructor(options: DiskCacheOptions = {}) {
    this.directory = options.directory ?? defaultCacheDirectory();
    this.layoutDirectory = join(this.directory, CACHE_LAYOUT_NAMESPACE);
    this.maxBytes = requireFiniteLimit("maxBytes", options.maxBytes ?? 512 * 1024 * 1024, {
      allowZero: true,
    });
    this.maxAgeSeconds = requireFiniteLimit(
      "maxAgeSeconds",
      options.maxAgeSeconds ?? 30 * 24 * 60 * 60,
      { allowZero: true },
    );
    this.leaseExpirySeconds = requireFiniteLimit(
      "leaseExpirySeconds",
      options.leaseExpirySeconds ?? 120,
    );
    this.temporaryExpirySeconds = requireFiniteLimit(
      "temporaryExpirySeconds",
      options.temporaryExpirySeconds ?? 24 * 60 * 60,
    );
    const configuredRenewInterval = requireFiniteLimit(
      "renewIntervalSeconds",
      options.renewIntervalSeconds ?? 30,
      { allowZero: true },
    );
    this.renewIntervalSeconds =
      configuredRenewInterval === 0
        ? 0
        : Math.min(
            configuredRenewInterval,
            this.leaseExpirySeconds / 2,
            MAX_TIMER_DELAY_MILLISECONDS / 1_000,
          );
    this.maxScanEntries = requireFiniteLimit(
      "maxScanEntries",
      options.maxScanEntries ?? DEFAULT_MAX_SCAN_ENTRIES,
    );
    this.maxObjectMetadataBytes = Math.min(
      requireFiniteLimit(
        "maxObjectMetadataBytes",
        options.maxObjectMetadataBytes ?? CACHE_MAX_OBJECT_METADATA_BYTES,
      ),
      CACHE_MAX_OBJECT_METADATA_BYTES,
    );
    this.maxFilesPerObject = requireFiniteLimit(
      "maxFilesPerObject",
      options.maxFilesPerObject ?? CACHE_MAX_FILES_PER_OBJECT,
      { allowZero: true },
    );
    this.maxArtifactBytes = requireFiniteLimit(
      "maxArtifactBytes",
      options.maxArtifactBytes ?? CACHE_MAX_ARTIFACT_BYTES,
      { allowZero: true },
    );
    this.maxExtractedBytes = requireFiniteLimit(
      "maxExtractedBytes",
      options.maxExtractedBytes ?? CACHE_MAX_EXTRACTED_BYTES,
      { allowZero: true },
    );
    this.maxExtractedFileBytes = requireFiniteLimit(
      "maxExtractedFileBytes",
      options.maxExtractedFileBytes ?? CACHE_MAX_EXTRACTED_FILE_BYTES,
      { allowZero: true },
    );
    this.mutationLockTimeoutSeconds = Math.min(
      MAX_TIMER_DELAY_MILLISECONDS / 1_000,
      Math.max(30, this.leaseExpirySeconds * 2),
    );
    this.now = options.now ?? (() => new Date());
    this.pid = options.pid ?? process.pid;
    if (!Number.isSafeInteger(this.pid) || this.pid <= 0) throw new CacheConfigurationError("pid");
    this.processNonce = requireSafeNonce("processNonce", options.processNonce ?? randomUUID());
    this.hasInjectedProcessLiveness = options.isProcessAlive !== undefined;
    this.isProcessAlive = options.isProcessAlive ?? ((pid) => defaultProcessLiveness(pid));
    this.verifyExtractedContents = options.verifyExtractedContents;
    this.coordinationHooks = options.coordinationHooks ?? {};
    this.onBackgroundError =
      options.onBackgroundError ??
      ((error) => {
        queueMicrotask(() => {
          throw error;
        });
      });
  }

  private async normalizeWriteOperation<T>(action: () => Promise<T>, digest?: string): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (error instanceof CacheConfigurationError || error instanceof CacheCorruptError)
        throw error;
      throw new CacheCorruptError("cache operation failed", {
        ...(digest === undefined ? {} : { expected_digest: digest }),
        layout_version: CACHE_LAYOUT_NAMESPACE,
      });
    }
  }

  async putCatalog(
    canonicalUrl: string,
    body: Uint8Array,
    metadata: CatalogMetadataInput,
  ): Promise<void> {
    const bodySnapshot = snapshotCatalogBody(body);
    const metadataSnapshot = snapshotCatalogMetadataInput(metadata);
    const sanitizedUrl = sanitizeCanonicalUrl(canonicalUrl);
    const candidate: CachedCatalog = {
      body: bodySnapshot,
      metadata: { canonicalUrl: sanitizedUrl, ...metadataSnapshot },
    };
    for (;;) {
      const expected = await this.getCatalogState(sanitizedUrl, metadataSnapshot.confirmedScope);
      if (
        expected.catalog !== null &&
        compareCatalogMetadataFreshness(candidate.metadata, expected.catalog.metadata) < 0
      ) {
        return;
      }
      if (await this.replaceCatalog(candidate, expected.generation)) return;
    }
  }

  async replaceCatalog(catalog: CachedCatalog, expectedGeneration: string): Promise<boolean> {
    return this.normalizeWriteOperation(() =>
      this.replaceCatalogUnnormalized(catalog, expectedGeneration),
    );
  }

  private async replaceCatalogUnnormalized(
    catalog: CachedCatalog,
    expectedGeneration: string,
  ): Promise<boolean> {
    const scanBudget = new CacheScanBudget(this.maxScanEntries);
    const bodySnapshot = snapshotCatalogBody(catalog.body);
    const metadataSnapshot = snapshotCatalogMetadataInput(catalog.metadata);
    const sanitizedUrl = sanitizeCanonicalUrl(catalog.metadata.canonicalUrl);
    if (!/^sha256:[0-9a-f]{64}$/u.test(expectedGeneration)) {
      throw new CacheConfigurationError("catalogGeneration");
    }
    const originId = canonicalOriginIdentifier(sanitizedUrl, metadataSnapshot.confirmedScope);
    const mutationDigest = catalogMutationDigest(originId);
    const catalogDirectory = join(this.layoutDirectory, "catalogs", originId);
    const temporaryDirectory = join(
      this.layoutDirectory,
      "tmp",
      `catalog-${originId}-${randomUUID()}`,
    );
    const stored: StoredCatalogMetadata = {
      schema: "remote-skills-catalog-metadata-v1",
      canonical_url: sanitizedUrl,
      ...(metadataSnapshot.confirmedScope === undefined
        ? {}
        : { confirmed_scope: metadataSnapshot.confirmedScope }),
      ...(metadataSnapshot.etag === undefined ? {} : { etag: metadataSnapshot.etag }),
      ...(metadataSnapshot.lastModified === undefined
        ? {}
        : { last_modified: metadataSnapshot.lastModified }),
      ...(metadataSnapshot.cacheControl === undefined
        ? {}
        : { cache_control: metadataSnapshot.cacheControl }),
      retrieved_at: metadataSnapshot.retrievedAt,
      validated_at: metadataSnapshot.validatedAt,
    };
    const encodedMetadata = serializeJson(stored);
    const generationToken = `sha256:${randomBytes(32).toString("hex")}`;
    const encodedGeneration = serializeJson({
      schema: "remote-skills-catalog-generation-v1",
      catalog_identifier: originId,
      generation: generationToken,
      state: "present",
    });
    if (
      Buffer.byteLength(encodedMetadata) >
      Math.min(this.maxObjectMetadataBytes, CACHE_MAX_CATALOG_METADATA_BYTES)
    ) {
      throw new CacheCorruptError("catalog cache metadata exceeds its protocol limit", {
        layout_version: CACHE_LAYOUT_NAMESPACE,
      });
    }

    await this.ensureSafeDirectory(temporaryDirectory);
    await this.ensureSafeDirectory(join(this.layoutDirectory, "catalogs"));
    const catalogDigest = `sha256:${originId}`;
    const writerPath = join(temporaryDirectory, "writer.json");
    const writer: StoredWriter = {
      schema: "remote-skills-cache-writer-v1",
      writer: "typescript",
      pid: this.pid,
      process_nonce: this.processNonce,
      expected_digest: catalogDigest,
      bytes_received: 0,
      complete: false,
    };
    let writerHeartbeat: ProcessRegistrationHeartbeat | undefined;
    try {
      writerHeartbeat = await this.startProcessRegistrationHeartbeat(originId);
      await this.writeStagingFileExclusive(writerPath, serializeJson(writer));
      await withDirectoryChainsMutationGuard(
        this.directory,
        [temporaryDirectory],
        () => {},
        async () => {
          await Promise.all([
            writeSyncedFile(join(temporaryDirectory, "body.json"), bodySnapshot),
            writeSyncedFile(join(temporaryDirectory, "metadata.json"), encodedMetadata),
            writeSyncedFile(join(temporaryDirectory, "generation.json"), encodedGeneration),
          ]);
        },
        true,
      );
      writer.bytes_received =
        bodySnapshot.byteLength +
        Buffer.byteLength(encodedMetadata) +
        Buffer.byteLength(encodedGeneration);
      writer.complete = true;
      await this.replaceStagingFile(writerPath, serializeJson(writer));
      const replaced = await this.withDigestLock(
        EVICTION_DECISION_LOCK_DIGEST,
        () =>
          this.withDigestLock(
            mutationDigest,
            async () => {
              const current = await this.readCatalogStateUnlocked(
                sanitizedUrl,
                originId,
                metadataSnapshot.confirmedScope,
                scanBudget,
              );
              if (current.generation !== expectedGeneration) return false;
              await this.advanceCatalogGenerationEpoch();
              await rm(writerPath, { force: true });
              await this.commitCatalogGeneration(
                sanitizedUrl,
                originId,
                temporaryDirectory,
                catalogDirectory,
                scanBudget,
              );
              return true;
            },
            scanBudget,
          ),
        scanBudget,
      );
      return replaced;
    } finally {
      const registrationRelease = await writerHeartbeat?.stop();
      await withDirectoryChainsMutationGuard(
        this.directory,
        [dirname(temporaryDirectory)],
        () => {},
        () => this.removeDirectoryTreeBounded(temporaryDirectory, scanBudget),
        true,
      );
      if (registrationRelease?.final === true) {
        await this.removeOwnRegistrationIfUnleased(
          originId,
          registrationRelease.identity,
          scanBudget,
        );
      }
    }
  }

  async getCatalog(canonicalUrl: string, confirmedScope?: string): Promise<CachedCatalog | null> {
    const originId = canonicalOriginIdentifier(canonicalUrl, confirmedScope);
    const catalogDirectory = join(this.layoutDirectory, "catalogs", originId);
    const scanBudget = new CacheScanBudget(this.maxScanEntries);
    try {
      try {
        const generation = await this.readCatalogGeneration(
          canonicalUrl,
          catalogDirectory,
          scanBudget,
          confirmedScope,
        );
        if (generation !== null) return generation;
      } catch (error) {
        if (!(error instanceof CachePathChangedError)) throw error;
      }
      return await this.withDigestLock(
        EVICTION_DECISION_LOCK_DIGEST,
        () =>
          this.withDigestLock(
            catalogMutationDigest(originId),
            async () => {
              const current = await this.readCatalogGeneration(
                canonicalUrl,
                catalogDirectory,
                scanBudget,
                confirmedScope,
              );
              if (current !== null) return current;
              const previous = await lstat(this.catalogPreviousDirectory(originId)).catch(
                (error: NodeJS.ErrnoException) => {
                  if (error.code === "ENOENT") return undefined;
                  throw error;
                },
              );
              if (previous === undefined) return null;
              await this.advanceCatalogGenerationEpoch();
              const restored = await this.restoreCatalogPreviousGeneration(
                canonicalUrl,
                originId,
                scanBudget,
              );
              if (!restored) return null;
              return this.readCatalogGeneration(
                canonicalUrl,
                catalogDirectory,
                scanBudget,
                confirmedScope,
              );
            },
            scanBudget,
          ),
        scanBudget,
      );
    } catch (error) {
      if (error instanceof CacheCorruptError) throw error;
      throw new CacheCorruptError("catalog cache state is unreadable", {
        layout_version: CACHE_LAYOUT_NAMESPACE,
      });
    }
  }

  async getCatalogState(canonicalUrl: string, confirmedScope?: string): Promise<CatalogState> {
    const sanitizedUrl = sanitizeCanonicalUrl(canonicalUrl);
    const originId = canonicalOriginIdentifier(sanitizedUrl, confirmedScope);
    const scanBudget = new CacheScanBudget(this.maxScanEntries);
    return this.normalizeWriteOperation(() =>
      this.withDigestLock(
        EVICTION_DECISION_LOCK_DIGEST,
        () =>
          this.withDigestLock(
            catalogMutationDigest(originId),
            () => this.readCatalogStateUnlocked(sanitizedUrl, originId, confirmedScope, scanBudget),
            scanBudget,
          ),
        scanBudget,
      ),
    );
  }

  async deleteCatalog(
    canonicalUrl: string,
    confirmedScope: string | undefined,
    expectedGeneration: string,
  ): Promise<boolean> {
    return this.normalizeWriteOperation(async () => {
      const originId = canonicalOriginIdentifier(canonicalUrl, confirmedScope);
      if (!/^sha256:[0-9a-f]{64}$/u.test(expectedGeneration)) {
        throw new CacheConfigurationError("catalogGeneration");
      }
      const scanBudget = new CacheScanBudget(this.maxScanEntries);
      return this.withDigestLock(
        EVICTION_DECISION_LOCK_DIGEST,
        () =>
          this.withDigestLock(
            catalogMutationDigest(originId),
            async () => {
              const current = await this.readCatalogStateUnlocked(
                canonicalUrl,
                originId,
                confirmedScope,
                scanBudget,
              );
              if (current.catalog === null || current.generation !== expectedGeneration)
                return false;
              await this.advanceCatalogGenerationEpoch();
              const rows = (await this.listCatalogRows(scanBudget)).filter(
                (row) => row.originId === originId,
              );
              for (const row of rows) {
                await this.removeCatalogGenerationUnlocked(row, scanBudget);
              }
              return true;
            },
            scanBudget,
          ),
        scanBudget,
      );
    });
  }

  async getObject(digest: string): Promise<CachedObject | null> {
    return this.readObject(digest, true);
  }

  private async readObject(digest: string, touch: boolean): Promise<CachedObject | null> {
    const scanBudget = new CacheScanBudget(this.maxScanEntries);
    return this.withDigestLock(
      digest,
      () => this.readObjectUnlocked(digest, touch, scanBudget),
      scanBudget,
    );
  }

  private async readObjectUnlocked(
    digest: string,
    touch: boolean,
    scanBudget: CacheScanBudget,
  ): Promise<CachedObject | null> {
    const hex = digestHex(digest);
    const objectDirectory = this.objectDirectory(hex);
    try {
      await this.assertSafeAncestors(objectDirectory);
      const state = await lstat(objectDirectory);
      if (!state.isDirectory() || state.isSymbolicLink()) throw new CachePathChangedError();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw this.corruptObject(digest, error);
    }
    try {
      return await withDirectoryChainGuard(this.directory, objectDirectory, async () => {
        await validateObjectDirectoryInventory(objectDirectory, scanBudget);
        const encodedMetadata = await readRegularFileNoFollow(
          join(objectDirectory, "object.json"),
          this.maxObjectMetadataBytes,
        );
        const stored = parseStoredObjectMetadata(JSON.parse(decodeUtf8(encodedMetadata)));
        const paths = this.validateStoredObjectMetadata(stored, digest);
        const expectedSizes = new Map(stored.files.map((file) => [file.path, file.size]));
        const [artifact, root] = await Promise.all([
          readRegularFileNoFollow(join(objectDirectory, "artifact"), stored.artifact_bytes),
          walkRegularFiles(join(objectDirectory, "root"), expectedSizes, scanBudget),
        ]);
        if (root.size !== paths.length) throw this.corruptObject(digest);
        await this.validateStoredObject(stored, digest, artifact, root);
        if (touch) {
          const accessedAt = this.now().toISOString();
          if (!isTimestamp(accessedAt)) throw this.corruptObject(digest);
          if (Date.parse(accessedAt) > Date.parse(stored.accessed_at)) {
            stored.accessed_at = accessedAt;
            await this.writeObjectMetadata(objectDirectory, stored);
          }
        }
        return {
          artifact,
          root,
          metadata: this.fromStoredObject(stored),
        };
      });
    } catch (error) {
      if (error instanceof CacheCorruptError) throw error;
      throw this.corruptObject(digest, error);
    }
  }

  async publishObject(input: PublishObjectInput): Promise<CachedObject> {
    const digest =
      input !== null && typeof input === "object" && typeof input.digest === "string"
        ? input.digest
        : undefined;
    return this.normalizeWriteOperation(() => this.publishObjectUnnormalized(input), digest);
  }

  private async publishObjectUnnormalized(input: PublishObjectInput): Promise<CachedObject> {
    const scanBudget = new CacheScanBudget(this.maxScanEntries);
    const snapshot = snapshotPublishObjectInput(input, {
      maxArtifactBytes: this.maxArtifactBytes,
      maxExtractedBytes: this.maxExtractedBytes,
      maxExtractedFileBytes: this.maxExtractedFileBytes,
      maxFiles: this.maxFilesPerObject,
    });
    const hex = digestHex(snapshot.digest);
    if (sha256(snapshot.artifact) !== hex) throw this.corruptObject(snapshot.digest);
    const paths = validatePortablePaths(snapshot.files.keys());
    const fileRows = paths.map((path) => {
      const bytes = snapshot.files.get(path);
      const mediaType = snapshot.mediaTypes.get(path);
      if (bytes === undefined || mediaType === undefined) throw this.corruptObject(snapshot.digest);
      return { path, size: bytes.byteLength, media_type: mediaType };
    });
    if (snapshot.mediaTypes.size !== fileRows.length) throw this.corruptObject(snapshot.digest);
    const extractedBytes = fileRows.reduce((sum, file) => sum + file.size, 0);

    const verifiedAt = snapshot.verifiedAt ?? this.now().toISOString();
    const accessedAt = snapshot.accessedAt ?? verifiedAt;
    if (!isTimestamp(verifiedAt) || !isTimestamp(accessedAt))
      throw this.corruptObject(snapshot.digest);
    const metadata: StoredObjectMetadata = {
      schema: "remote-skills-object-metadata-v1",
      digest: snapshot.digest,
      artifact_type: snapshot.artifactType,
      archive_format: snapshot.archiveFormat,
      artifact_bytes: snapshot.artifact.byteLength,
      extracted_bytes: extractedBytes,
      files: fileRows,
      verified_at: verifiedAt,
      accessed_at: accessedAt,
    };
    if (
      objectMetadataWireByteLength(this.fromStoredObject(metadata)) > this.maxObjectMetadataBytes
    ) {
      throw this.corruptObject(snapshot.digest);
    }
    const root = new Map(paths.map((path) => [path, snapshot.files.get(path) as Uint8Array]));
    await this.validateStoredObject(metadata, snapshot.digest, snapshot.artifact, root);

    const temporaryDirectory = join(
      this.layoutDirectory,
      "tmp",
      `writer-typescript-${hex}-${randomUUID()}`,
    );
    const objectDirectory = this.objectDirectory(hex);
    await this.ensureSafeDirectory(join(temporaryDirectory, "root"));
    const writer: StoredWriter = {
      schema: "remote-skills-cache-writer-v1",
      writer: "typescript",
      pid: this.pid,
      process_nonce: this.processNonce,
      expected_digest: snapshot.digest,
      bytes_received: 0,
      complete: false,
    };
    const writerPath = join(temporaryDirectory, "writer.json");
    let writerHeartbeat: ProcessRegistrationHeartbeat | undefined;
    try {
      writerHeartbeat = await this.startProcessRegistrationHeartbeat(hex);
      await this.writeStagingFileExclusive(writerPath, serializeJson(writer));
      await writeSyncedFile(join(temporaryDirectory, "artifact"), snapshot.artifact);
      writer.bytes_received = snapshot.artifact.byteLength;
      for (const path of paths) {
        const destination = join(temporaryDirectory, "root", ...path.split("/"));
        await this.ensureSafeDirectory(dirname(destination));
        const bytes = snapshot.files.get(path);
        if (bytes === undefined) throw this.corruptObject(snapshot.digest);
        await writeSyncedFile(destination, bytes);
      }
      await writeSyncedFile(join(temporaryDirectory, "object.json"), serializeJson(metadata));
      writer.complete = true;
      await this.replaceStagingFile(writerPath, serializeJson(writer));
      await this.coordinationHooks.afterObjectStaging?.(snapshot.digest);

      return await this.withDigestLock(
        EVICTION_DECISION_LOCK_DIGEST,
        () =>
          this.withDigestLock(
            snapshot.digest,
            async () => {
              await this.ensureSafeDirectory(dirname(objectDirectory));
              return withDirectoryChainsMutationGuard(
                this.directory,
                [dirname(temporaryDirectory), dirname(objectDirectory)],
                () => this.coordinationHooks.beforeObjectPublicationCommit?.(snapshot.digest),
                async () => {
                  const stagedIdentity = await this.validateStagedObjectGeneration(
                    temporaryDirectory,
                    metadata,
                    writer,
                    snapshot.artifact,
                    root,
                    scanBudget,
                  );
                  const writerSnapshot = await readRegularFileSnapshotNoFollow(
                    writerPath,
                    MAX_COORDINATION_RECORD_BYTES,
                  );
                  await unlinkIfSameIdentity(writerPath, writerSnapshot.identity);
                  await validateObjectDirectoryInventory(temporaryDirectory, scanBudget);
                  const readyIdentity = await lstat(temporaryDirectory);
                  if (!isSameIdentity(stagedIdentity, readyIdentity)) {
                    throw new CachePathChangedError();
                  }
                  let installedIdentity: Stats | undefined;
                  try {
                    await rename(temporaryDirectory, objectDirectory);
                    installedIdentity = stagedIdentity;
                  } catch (error) {
                    if (
                      !["EEXIST", "ENOTEMPTY", "EPERM"].includes(
                        (error as NodeJS.ErrnoException).code ?? "",
                      )
                    ) {
                      throw error;
                    }
                  }

                  try {
                    if (installedIdentity !== undefined) {
                      const installed = await lstat(objectDirectory);
                      if (!isSameIdentity(installedIdentity, installed)) {
                        throw new CachePathChangedError();
                      }
                    }
                    const published = await this.readObjectUnlocked(
                      snapshot.digest,
                      false,
                      scanBudget,
                    );
                    if (published === null) throw this.corruptObject(snapshot.digest);
                    return published;
                  } catch (error) {
                    if (installedIdentity !== undefined) {
                      const current = await lstat(objectDirectory).catch(
                        (pathError: NodeJS.ErrnoException) => {
                          if (pathError.code === "ENOENT") return undefined;
                          throw pathError;
                        },
                      );
                      if (current !== undefined && isSameIdentity(installedIdentity, current)) {
                        const quarantine = join(
                          this.layoutDirectory,
                          "tmp",
                          `invalid-object-${randomUUID()}`,
                        );
                        await this.renameFile(objectDirectory, quarantine);
                        const quarantined = await lstat(quarantine);
                        if (!isSameIdentity(installedIdentity, quarantined)) {
                          throw new CachePathChangedError();
                        }
                        await this.removeDirectoryTreeBounded(quarantine, scanBudget);
                      }
                    }
                    throw error;
                  }
                },
                true,
              );
            },
            scanBudget,
          ),
        scanBudget,
      );
    } finally {
      const registrationRelease = await writerHeartbeat?.stop();
      await withDirectoryChainsMutationGuard(
        this.directory,
        [dirname(temporaryDirectory)],
        () => {},
        () => this.removeDirectoryTreeBounded(temporaryDirectory, scanBudget),
        true,
      );
      if (registrationRelease?.final === true) {
        await this.removeOwnRegistrationIfUnleased(hex, registrationRelease.identity, scanBudget);
      }
    }
  }

  async acquireLease(digest: string, sessionNonce: string): Promise<CacheLease> {
    return this.normalizeWriteOperation(
      () => this.acquireLeaseUnnormalized(digest, sessionNonce),
      digest,
    );
  }

  private async acquireLeaseUnnormalized(
    digest: string,
    sessionNonce: string,
  ): Promise<CacheLease> {
    const acquireScanBudget = new CacheScanBudget(this.maxScanEntries);
    const hex = digestHex(digest);
    requireSafeNonce("sessionNonce", sessionNonce);
    const objectGeneration = await this.openObjectGenerationGuard(digest);
    const directory = join(this.layoutDirectory, "leases", hex);
    const leaseNonce = randomUUID();
    let leasePath = join(directory, `${this.processNonce}-${sessionNonce}-${leaseNonce}.json`);
    const createdAt = this.now().toISOString();
    const lease: StoredLease = {
      schema: "remote-skills-cache-lease-v1",
      digest,
      pid: this.pid,
      process_nonce: this.processNonce,
      session_nonce: sessionNonce,
      created_at: createdAt,
      renewed_at: createdAt,
      lease_nonce: leaseNonce,
    };
    try {
      leasePath = await this.withDigestLock(
        digest,
        async () => {
          await this.ensureSafeDirectory(directory);
          await this.coordinationHooks.afterLeaseDirectoryPrepared?.(directory);
          return this.atomicCreateLease(leasePath, lease);
        },
        acquireScanBudget,
        "acquire",
        true,
        objectGeneration,
      );
    } finally {
      await this.closeObjectGenerationGuard(objectGeneration);
    }

    let released = false;
    let renewal: NodeJS.Timeout | undefined;
    let renewalQueue = Promise.resolve();
    const renewUnnormalized = async (): Promise<void> => {
      const pending = renewalQueue.then(async () => {
        if (released) return;
        const scanBudget = new CacheScanBudget(this.maxScanEntries);
        lease.renewed_at = this.now().toISOString();
        if (!isTimestamp(lease.renewed_at)) throw this.corruptObject(digest);
        leasePath = await this.withDigestLock(
          digest,
          async () => this.atomicReplaceLease(leasePath, lease),
          scanBudget,
        );
      });
      renewalQueue = pending.then(
        () => undefined,
        () => undefined,
      );
      return pending;
    };
    const renew = (): Promise<void> => this.normalizeWriteOperation(renewUnnormalized, digest);
    if (this.renewIntervalSeconds > 0) {
      renewal = setInterval(() => {
        void renew().catch(this.onBackgroundError);
      }, this.renewIntervalSeconds * 1_000);
      renewal.unref();
    }
    return {
      digest,
      get path() {
        return leasePath;
      },
      renew,
      release: () =>
        this.normalizeWriteOperation(async () => {
          const scanBudget = new CacheScanBudget(this.maxScanEntries);
          if (released) return;
          released = true;
          if (renewal !== undefined) clearInterval(renewal);
          await renewalQueue;
          await this.withDigestLock(
            digest,
            async () => {
              try {
                const snapshot = await readRegularFileSnapshotNoFollow(
                  leasePath,
                  MAX_COORDINATION_RECORD_BYTES,
                );
                await unlinkIfSameIdentity(leasePath, snapshot.identity);
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
              }
              const siblings = await readDirectoryBounded(directory, scanBudget).catch(
                (error: NodeJS.ErrnoException) => {
                  if (error.code === "ENOENT") return [];
                  throw error;
                },
              );
              if (siblings.some((entry) => entry.name.startsWith(`${this.processNonce}-`))) return;
            },
            scanBudget,
          );
        }, digest),
    };
  }

  async evict(): Promise<EvictionResult> {
    return this.normalizeWriteOperation(() => this.evictUnnormalized());
  }

  private async evictUnnormalized(): Promise<EvictionResult> {
    const scanBudget = new CacheScanBudget(this.maxScanEntries);
    await this.cleanupUnnormalized(scanBudget);
    const result = await this.withDigestLock(
      EVICTION_DECISION_LOCK_DIGEST,
      async () => {
        const objects = await this.listObjectRows(scanBudget);
        const catalogs = await this.listCatalogRows(scanBudget);
        const liveLeases = await this.liveLeaseDigests(scanBudget);
        const retainedPinned: string[] = [];
        const evicted: string[] = [];
        const candidates = [
          ...objects.map((object) => ({
            kind: "object" as const,
            key: object.digest,
            resultKey: object.digest,
            accessedAt: object.accessedAt,
            bytes: object.artifactBytes + object.extractedBytes,
            object,
          })),
          ...catalogs.map((catalog) => ({
            kind: "catalog" as const,
            key: `${catalog.originId}:${catalog.generation}`,
            resultKey: `catalog:${catalog.originId}:${catalog.generation}`,
            accessedAt: catalog.accessedAt,
            bytes: catalog.bytes,
            catalog,
          })),
        ].sort(
          (left, right) =>
            Date.parse(left.accessedAt) - Date.parse(right.accessedAt) ||
            (left.resultKey < right.resultKey ? -1 : left.resultKey > right.resultKey ? 1 : 0),
        );
        let totalBytes = candidates.reduce((sum, candidate) => sum + candidate.bytes, 0);
        const now = this.now().getTime();
        for (const candidate of candidates) {
          if (candidate.kind === "object" && liveLeases.has(candidate.key)) {
            retainedPinned.push(candidate.key);
            continue;
          }
          const expired = now - Date.parse(candidate.accessedAt) > this.maxAgeSeconds * 1_000;
          if (!expired && totalBytes <= this.maxBytes) continue;
          const outcome =
            candidate.kind === "object"
              ? await this.removeObject(candidate.key, scanBudget)
              : await this.removeCatalogGeneration(candidate.catalog, scanBudget);
          if (outcome === "removed") {
            totalBytes -= candidate.bytes;
            evicted.push(candidate.resultKey);
          } else if (outcome === "missing") {
            totalBytes -= candidate.bytes;
          } else if (outcome === "pinned" && !retainedPinned.includes(candidate.key)) {
            retainedPinned.push(candidate.key);
          }
        }
        return { evicted, retainedPinned, totalBytes };
      },
      scanBudget,
    );
    await this.writeEvictionMetadata(scanBudget);
    return result;
  }

  async cleanup(): Promise<CleanupResult> {
    return this.normalizeWriteOperation(() => this.cleanupUnnormalized());
  }

  private async cleanupUnnormalized(
    scanBudget = new CacheScanBudget(this.maxScanEntries),
  ): Promise<CleanupResult> {
    await this.cleanupCatalogPreviousGenerations(scanBudget);
    const removedTemporaryPaths = await this.cleanupTemporaryPaths(scanBudget);
    const reclaimedLeases = await this.cleanupLeases(scanBudget);
    await this.cleanupCoordinationState(scanBudget);
    return { removedTemporaryPaths, reclaimedLeases };
  }

  private async cleanupCatalogPreviousGenerations(scanBudget: CacheScanBudget): Promise<void> {
    const root = join(this.layoutDirectory, "tmp", "catalog-generations-v1");
    let entries: Dirent[];
    try {
      await this.assertSafeAncestors(root);
      entries = [];
      for await (const entry of await opendir(root)) {
        if (entry.name === "state.json") continue; // Fixed O(1) protocol state is not scan input.
        scanBudget.consume();
        entries.push(entry);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      if (!/^[0-9a-f]{64}$/u.test(entry.name)) continue;
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new CacheCorruptError("catalog cache directory inventory is corrupt", {
          layout_version: CACHE_LAYOUT_NAMESPACE,
        });
      }
      const originId = entry.name;
      await this.withDigestLock(
        EVICTION_DECISION_LOCK_DIGEST,
        () =>
          this.withDigestLock(
            catalogMutationDigest(originId),
            async () => {
              const previousDirectory = this.catalogPreviousDirectory(originId);
              const previousState = await lstat(previousDirectory).catch(
                (error: NodeJS.ErrnoException) => {
                  if (error.code === "ENOENT") return undefined;
                  throw error;
                },
              );
              if (previousState === undefined) {
                await this.removeEmptyCatalogGenerationParent(originId);
                return;
              }
              const previous = await this.readCatalogScanRow(
                originId,
                "previous",
                previousDirectory,
                scanBudget,
              );
              const currentDirectory = join(this.layoutDirectory, "catalogs", originId);
              const currentState = await lstat(currentDirectory).catch(
                (error: NodeJS.ErrnoException) => {
                  if (error.code === "ENOENT") return undefined;
                  throw error;
                },
              );
              if (currentState === undefined) {
                await this.advanceCatalogGenerationEpoch();
                await this.restoreCatalogPreviousGeneration(
                  previous.canonicalUrl,
                  originId,
                  scanBudget,
                );
                return;
              }
              const current = await this.readCatalogScanRow(
                originId,
                "current",
                currentDirectory,
                scanBudget,
              );
              if (
                compareCatalogMetadataFreshness(
                  {
                    retrievedAt: current.snapshot.stored.retrieved_at,
                    validatedAt: current.snapshot.stored.validated_at,
                  },
                  {
                    retrievedAt: previous.snapshot.stored.retrieved_at,
                    validatedAt: previous.snapshot.stored.validated_at,
                  },
                ) < 0
              ) {
                return;
              }
              await this.advanceCatalogGenerationEpoch();
              await this.removeCatalogGenerationUnlocked(previous, scanBudget);
            },
            scanBudget,
          ),
        scanBudget,
      );
    }
  }

  private async ensureSafeDirectory(target: string): Promise<void> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const guards: OpenDirectoryGuard[] = [];
      try {
        let current = this.directory;
        guards.push(await openDirectoryNoFollow(current));
        for (const part of cacheRelativeParts(this.directory, target)) {
          current = join(current, part);
          await mkdir(current, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "EEXIST") throw error;
          });
          guards.push(await openDirectoryNoFollow(current));
        }
        for (const guard of guards) await verifyDirectoryGuard(guard);
        return;
      } catch (error) {
        if (
          !["EINVAL", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "") ||
          attempt === 7
        )
          throw error;
      } finally {
        await Promise.all(guards.map(({ handle }) => handle.close()));
      }
    }
  }

  private async assertSafeAncestors(target: string): Promise<void> {
    let current = this.directory;
    for (const part of ["", ...cacheRelativeParts(this.directory, target)]) {
      if (part !== "") current = join(current, part);
      try {
        const guard = await openDirectoryNoFollow(current);
        await guard.handle.close();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
    }
  }

  private catalogPreviousDirectory(originId: string): string {
    return join(this.layoutDirectory, "tmp", "catalog-generations-v1", originId, "previous");
  }

  private catalogGenerationRoot(): string {
    return join(this.layoutDirectory, "tmp", "catalog-generations-v1");
  }

  private catalogGenerationStatePath(): string {
    return join(this.catalogGenerationRoot(), "state.json");
  }

  private async readCatalogGenerationEpoch(): Promise<number> {
    const root = this.catalogGenerationRoot();
    const rootState = await lstat(root).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (rootState === undefined) return 0;
    if (!rootState.isDirectory() || rootState.isSymbolicLink()) throw new CachePathChangedError();
    return withDirectoryChainGuard(this.directory, root, async () => {
      let state: RegularFileSnapshot;
      try {
        state = await readRegularFileSnapshotNoFollow(
          this.catalogGenerationStatePath(),
          MAX_COORDINATION_RECORD_BYTES,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new CacheCorruptError("catalog generation state is missing", {
            layout_version: CACHE_LAYOUT_NAMESPACE,
          });
        }
        throw error;
      }
      const parsed: unknown = JSON.parse(decodeUtf8(state.bytes));
      if (!isCatalogGenerationState(parsed)) {
        throw new CacheCorruptError("catalog generation state is corrupt", {
          layout_version: CACHE_LAYOUT_NAMESPACE,
        });
      }
      return parsed.generation;
    });
  }

  private async advanceCatalogGenerationEpoch(): Promise<number> {
    const current = await this.readCatalogGenerationEpoch();
    if (current === Number.MAX_SAFE_INTEGER) {
      throw new CacheCorruptError("catalog generation state is exhausted", {
        layout_version: CACHE_LAYOUT_NAMESPACE,
      });
    }
    const next = current + 1;
    const root = this.catalogGenerationRoot();
    await this.ensureSafeDirectory(root);
    const destination = this.catalogGenerationStatePath();
    const temporary = join(root, `state-${randomUUID()}.tmp`);
    await withDirectoryChainsMutationGuard(
      this.directory,
      [root],
      () => {},
      async (verifyCommit) => {
        if (current === 0) {
          const existing = await lstat(destination).catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return undefined;
            throw error;
          });
          if (existing !== undefined) throw new CachePathChangedError();
        } else if ((await this.readCatalogGenerationEpoch()) !== current) {
          throw new CachePathChangedError();
        }
        await writeSyncedFile(
          temporary,
          serializeJson({ schema: "remote-skills-catalog-generation-state-v1", generation: next }),
        );
        try {
          await verifyCommit();
          await this.renameReplacingFile(temporary, destination);
          await verifyCommit();
        } finally {
          await rm(temporary, { force: true });
        }
      },
      true,
    );
    return next;
  }

  private async restoreCatalogPreviousGeneration(
    canonicalUrl: string,
    originId: string,
    scanBudget: CacheScanBudget,
  ): Promise<boolean> {
    const previousDirectory = this.catalogPreviousDirectory(originId);
    const catalogDirectory = join(this.layoutDirectory, "catalogs", originId);
    const previousState = await lstat(previousDirectory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (previousState === undefined) return false;
    const previous = await this.readCatalogGenerationSnapshot(
      canonicalUrl,
      previousDirectory,
      scanBudget,
    );
    await this.ensureSafeDirectory(dirname(catalogDirectory));
    await withDirectoryChainsMutationGuard(
      this.directory,
      [dirname(previousDirectory), dirname(catalogDirectory)],
      () => {},
      async (verifyCommit) => {
        const currentState = await lstat(catalogDirectory).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        });
        if (currentState !== undefined) return;
        await this.readCatalogGenerationSnapshot(
          canonicalUrl,
          previousDirectory,
          scanBudget,
          previous,
        );
        await verifyCommit();
        await this.renameFile(previousDirectory, catalogDirectory);
        await verifyCommit();
        await this.readCatalogGenerationSnapshot(
          canonicalUrl,
          catalogDirectory,
          scanBudget,
          previous,
        );
      },
      true,
    );
    await this.removeEmptyCatalogGenerationParent(originId);
    return true;
  }

  private async removeEmptyCatalogGenerationParent(originId: string): Promise<void> {
    const root = join(this.layoutDirectory, "tmp", "catalog-generations-v1");
    const originDirectory = join(root, originId);
    try {
      await withDirectoryChainGuard(this.directory, root, async () => {
        const state = await lstat(originDirectory).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        });
        if (state === undefined) return;
        if (!state.isDirectory() || state.isSymbolicLink()) throw new CachePathChangedError();
        await rmdir(originDirectory).catch((error: NodeJS.ErrnoException) => {
          if (!["ENOENT", "ENOTEMPTY"].includes(error.code ?? "")) throw error;
        });
      });
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "ENOENT" &&
        !(error instanceof CachePathChangedError)
      )
        throw error;
    }
  }

  private async readCatalogGeneration(
    canonicalUrl: string,
    catalogDirectory: string,
    scanBudget: CacheScanBudget,
    confirmedScope?: string,
  ): Promise<CachedCatalog | null> {
    try {
      await this.assertSafeAncestors(catalogDirectory);
      const state = await lstat(catalogDirectory);
      if (!state.isDirectory() || state.isSymbolicLink()) throw new CachePathChangedError();
      await this.coordinationHooks.beforeCatalogGenerationOpen?.(catalogDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    try {
      const generation = await this.readCatalogGenerationSnapshot(
        canonicalUrl,
        catalogDirectory,
        scanBudget,
      );
      if (generation.stored.confirmed_scope !== confirmedScope) {
        throw new CacheCorruptError("catalog cache metadata is corrupt", {
          layout_version: CACHE_LAYOUT_NAMESPACE,
        });
      }
      return {
        body: generation.body.bytes,
        metadata: {
          canonicalUrl: generation.stored.canonical_url,
          ...(generation.stored.confirmed_scope === undefined
            ? {}
            : { confirmedScope: generation.stored.confirmed_scope }),
          ...(generation.stored.etag === undefined ? {} : { etag: generation.stored.etag }),
          ...(generation.stored.last_modified === undefined
            ? {}
            : { lastModified: generation.stored.last_modified }),
          ...(generation.stored.cache_control === undefined
            ? {}
            : { cacheControl: generation.stored.cache_control }),
          retrievedAt: generation.stored.retrieved_at,
          validatedAt: generation.stored.validated_at,
        },
      };
    } catch (error) {
      if (
        error instanceof CachePathChangedError ||
        ["ENOENT", "EINVAL"].includes((error as NodeJS.ErrnoException).code ?? "")
      ) {
        throw new CachePathChangedError();
      }
      throw error;
    }
  }

  private async readCatalogStateUnlocked(
    canonicalUrl: string,
    originId: string,
    confirmedScope: string | undefined,
    scanBudget: CacheScanBudget,
  ): Promise<CatalogState> {
    const catalogDirectory = join(this.layoutDirectory, "catalogs", originId);
    const epoch = await this.readCatalogGenerationEpoch();
    const currentState = await lstat(catalogDirectory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (currentState === undefined) {
      const previousState = await lstat(this.catalogPreviousDirectory(originId)).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        },
      );
      if (previousState !== undefined) {
        await this.advanceCatalogGenerationEpoch();
        if (await this.restoreCatalogPreviousGeneration(canonicalUrl, originId, scanBudget)) {
          return this.readCatalogStateUnlocked(canonicalUrl, originId, confirmedScope, scanBudget);
        }
      }
      return { catalog: null, generation: catalogAbsenceGeneration(originId, epoch) };
    }
    if (!currentState.isDirectory() || currentState.isSymbolicLink()) {
      throw new CachePathChangedError();
    }
    if (epoch === 0) {
      throw new CacheCorruptError("catalog generation state is missing", {
        layout_version: CACHE_LAYOUT_NAMESPACE,
      });
    }
    const snapshot = await this.readCatalogGenerationSnapshot(
      canonicalUrl,
      catalogDirectory,
      scanBudget,
      undefined,
      true,
    );
    if (
      snapshot.stored.confirmed_scope !== confirmedScope ||
      snapshot.generationToken === undefined
    ) {
      throw new CacheCorruptError("catalog cache metadata is corrupt", {
        layout_version: CACHE_LAYOUT_NAMESPACE,
      });
    }
    return {
      catalog: {
        body: snapshot.body.bytes,
        metadata: {
          canonicalUrl: snapshot.stored.canonical_url,
          ...(snapshot.stored.confirmed_scope === undefined
            ? {}
            : { confirmedScope: snapshot.stored.confirmed_scope }),
          ...(snapshot.stored.etag === undefined ? {} : { etag: snapshot.stored.etag }),
          ...(snapshot.stored.last_modified === undefined
            ? {}
            : { lastModified: snapshot.stored.last_modified }),
          ...(snapshot.stored.cache_control === undefined
            ? {}
            : { cacheControl: snapshot.stored.cache_control }),
          retrievedAt: snapshot.stored.retrieved_at,
          validatedAt: snapshot.stored.validated_at,
        },
      },
      generation: snapshot.generationToken,
    };
  }

  private async readCatalogGenerationSnapshot(
    canonicalUrl: string,
    catalogDirectory: string,
    scanBudget: CacheScanBudget,
    expected?: CatalogGenerationSnapshot,
    requireGeneration = false,
  ): Promise<CatalogGenerationSnapshot> {
    return withDirectoryChainGuard(this.directory, catalogDirectory, async () => {
      await validateCatalogDirectoryInventory(catalogDirectory, scanBudget);
      const directoryIdentity = await lstat(catalogDirectory);
      const [body, metadata, generation] = await Promise.all([
        readRegularFileSnapshotNoFollow(
          join(catalogDirectory, "body.json"),
          CACHE_MAX_CATALOG_BODY_BYTES,
        ),
        readRegularFileSnapshotNoFollow(
          join(catalogDirectory, "metadata.json"),
          Math.min(this.maxObjectMetadataBytes, CACHE_MAX_CATALOG_METADATA_BYTES),
        ),
        readRegularFileSnapshotNoFollow(
          join(catalogDirectory, "generation.json"),
          MAX_COORDINATION_RECORD_BYTES,
        ).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        }),
      ]);
      if (requireGeneration && generation === undefined) {
        throw new CacheCorruptError("catalog generation token is missing", {
          layout_version: CACHE_LAYOUT_NAMESPACE,
        });
      }
      snapshotCatalogBody(body.bytes);
      if (
        expected !== undefined &&
        (!isSameIdentity(expected.directoryIdentity, directoryIdentity) ||
          !isSameRegularFileState(expected.body.identity, body.identity) ||
          !isSameRegularFileState(expected.metadata.identity, metadata.identity) ||
          (expected.generation === undefined) !== (generation === undefined) ||
          (expected.generation !== undefined &&
            generation !== undefined &&
            (!isSameRegularFileState(expected.generation.identity, generation.identity) ||
              Buffer.compare(
                Buffer.from(expected.generation.bytes),
                Buffer.from(generation.bytes),
              ) !== 0)) ||
          Buffer.compare(Buffer.from(expected.body.bytes), Buffer.from(body.bytes)) !== 0 ||
          Buffer.compare(Buffer.from(expected.metadata.bytes), Buffer.from(metadata.bytes)) !== 0)
      ) {
        throw new CachePathChangedError();
      }
      const stored: unknown = JSON.parse(decodeUtf8(metadata.bytes));
      if (!isStoredCatalogMetadata(stored, sanitizeCanonicalUrl(canonicalUrl))) {
        throw new CacheCorruptError("catalog cache metadata is corrupt", {
          layout_version: CACHE_LAYOUT_NAMESPACE,
        });
      }
      let generationToken: string | undefined;
      if (generation !== undefined) {
        const parsedGeneration: unknown = JSON.parse(decodeUtf8(generation.bytes));
        if (
          !isCatalogGeneration(
            parsedGeneration,
            canonicalOriginIdentifier(stored.canonical_url, stored.confirmed_scope),
          )
        ) {
          throw new CacheCorruptError("catalog generation token is corrupt", {
            layout_version: CACHE_LAYOUT_NAMESPACE,
          });
        }
        generationToken = parsedGeneration.generation;
      }
      return { directoryIdentity, body, metadata, generation, generationToken, stored };
    });
  }

  private async commitCatalogGeneration(
    canonicalUrl: string,
    originId: string,
    temporaryDirectory: string,
    catalogDirectory: string,
    scanBudget: CacheScanBudget,
  ): Promise<void> {
    const previousDirectory = this.catalogPreviousDirectory(originId);
    await this.ensureSafeDirectory(dirname(previousDirectory));
    await withDirectoryChainsMutationGuard(
      this.directory,
      [dirname(temporaryDirectory), dirname(catalogDirectory), dirname(previousDirectory)],
      () => this.coordinationHooks.beforeCatalogCommit?.(),
      async (verifyCommit) => {
        const staged = await this.readCatalogGenerationSnapshot(
          canonicalUrl,
          temporaryDirectory,
          scanBudget,
          undefined,
          true,
        );
        const currentExists = await lstat(catalogDirectory).then(
          () => true,
          (error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return false;
            throw error;
          },
        );
        const previousExists = await lstat(previousDirectory).then(
          () => true,
          (error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return false;
            throw error;
          },
        );
        if (currentExists && previousExists) {
          await this.removeDirectoryTreeBounded(previousDirectory, scanBudget);
        }

        let movedCurrent = false;
        let installed = false;
        let quarantine: string | undefined;
        try {
          if (currentExists) {
            await this.coordinationHooks.afterCatalogPreviousPublished?.();
            await this.renameFile(catalogDirectory, previousDirectory);
            movedCurrent = true;
            await verifyCommit();
          }
          await this.readCatalogGenerationSnapshot(
            canonicalUrl,
            temporaryDirectory,
            scanBudget,
            staged,
          );
          await verifyCommit();
          await this.renameFile(temporaryDirectory, catalogDirectory);
          installed = true;
          await verifyCommit();
          await this.readCatalogGenerationSnapshot(
            canonicalUrl,
            catalogDirectory,
            scanBudget,
            staged,
          );
        } catch (error) {
          try {
            if (installed) {
              const current = await lstat(catalogDirectory);
              if (!isSameIdentity(staged.directoryIdentity, current)) {
                throw new CachePathChangedError();
              }
              quarantine = join(dirname(previousDirectory), `invalid-${randomUUID()}`);
              await this.renameFile(catalogDirectory, quarantine);
              const quarantined = await lstat(quarantine);
              if (!isSameIdentity(staged.directoryIdentity, quarantined)) {
                throw new CachePathChangedError();
              }
              installed = false;
            }
            if (movedCurrent) {
              await this.renameFile(previousDirectory, catalogDirectory);
              movedCurrent = false;
            }
            if (quarantine !== undefined) {
              await this.removeDirectoryTreeBounded(quarantine, scanBudget);
              quarantine = undefined;
            }
          } catch (recoveryError) {
            throw new AggregateError([error, recoveryError], "catalog generation recovery failed");
          }
          throw error;
        }
        await this.removeDirectoryTreeBounded(previousDirectory, scanBudget);
      },
      true,
    );
    await this.removeEmptyCatalogGenerationParent(originId);
  }

  private objectDirectory(hex: string): string {
    return join(this.layoutDirectory, "objects", "sha256", hex.slice(0, 2), hex.slice(2));
  }

  private corruptObject(digest: string, _cause?: unknown): CacheCorruptError {
    return new CacheCorruptError("verified cache object is corrupt", {
      expected_digest: digest,
      layout_version: CACHE_LAYOUT_NAMESPACE,
    });
  }

  private async validateStoredObject(
    stored: StoredObjectMetadata,
    digest: string,
    artifact: Uint8Array,
    root: ReadonlyMap<string, Uint8Array>,
  ): Promise<void> {
    this.validateStoredObjectMetadata(stored, digest);
    if (stored.artifact_bytes !== artifact.byteLength || sha256(artifact) !== digestHex(digest)) {
      throw this.corruptObject(digest);
    }
    for (const file of stored.files) {
      const bytes = root.get(file.path);
      if (bytes === undefined || bytes.byteLength !== file.size) throw this.corruptObject(digest);
    }
    if (root.size !== stored.files.length) throw this.corruptObject(digest);
    const object: CachedObject = {
      artifact: new Uint8Array(artifact),
      root,
      metadata: this.fromStoredObject(stored),
    };
    await validateExtractedContentBinding(object, this.verifyExtractedContents);
  }

  private async validateStagedObjectGeneration(
    directory: string,
    expected: StoredObjectMetadata,
    writer: StoredWriter,
    expectedArtifact: Uint8Array,
    expectedRoot: ReadonlyMap<string, Uint8Array>,
    scanBudget: CacheScanBudget,
  ): Promise<Stats> {
    return withDirectoryChainGuard(this.directory, directory, async () => {
      await validateStagedObjectDirectoryInventory(directory, scanBudget);
      const directoryIdentity = await lstat(directory);
      const writerSnapshot = await readRegularFileSnapshotNoFollow(
        join(directory, "writer.json"),
        MAX_COORDINATION_RECORD_BYTES,
      );
      const storedWriter: unknown = JSON.parse(decodeUtf8(writerSnapshot.bytes));
      if (
        storedWriter === null ||
        typeof storedWriter !== "object" ||
        JSON.stringify(storedWriter) !== JSON.stringify(writer)
      ) {
        throw this.corruptObject(expected.digest);
      }
      const encodedMetadata = await readRegularFileNoFollow(
        join(directory, "object.json"),
        this.maxObjectMetadataBytes,
      );
      const stored = parseStoredObjectMetadata(JSON.parse(decodeUtf8(encodedMetadata)));
      if (JSON.stringify(stored) !== JSON.stringify(expected)) {
        throw this.corruptObject(expected.digest);
      }
      const paths = this.validateStoredObjectMetadata(stored, expected.digest);
      const expectedSizes = new Map(stored.files.map((file) => [file.path, file.size]));
      const [artifact, root] = await Promise.all([
        readRegularFileNoFollow(join(directory, "artifact"), stored.artifact_bytes),
        walkRegularFiles(join(directory, "root"), expectedSizes, scanBudget),
      ]);
      if (root.size !== paths.length) throw this.corruptObject(expected.digest);
      if (Buffer.compare(Buffer.from(artifact), Buffer.from(expectedArtifact)) !== 0) {
        throw this.corruptObject(expected.digest);
      }
      for (const [path, expectedBytes] of expectedRoot) {
        const stagedBytes = root.get(path);
        if (
          stagedBytes === undefined ||
          Buffer.compare(Buffer.from(stagedBytes), Buffer.from(expectedBytes)) !== 0
        ) {
          throw this.corruptObject(expected.digest);
        }
      }
      const current = await lstat(directory);
      if (!isSameIdentity(directoryIdentity, current)) throw new CachePathChangedError();
      return directoryIdentity;
    });
  }

  private validateStoredObjectMetadata(stored: StoredObjectMetadata, digest: string): string[] {
    const expectedKeys = [
      "accessed_at",
      "archive_format",
      "artifact_bytes",
      "artifact_type",
      "digest",
      "extracted_bytes",
      "files",
      "schema",
      "verified_at",
    ];
    if (
      stored === null ||
      typeof stored !== "object" ||
      JSON.stringify(Object.keys(stored).sort()) !== JSON.stringify(expectedKeys) ||
      stored.schema !== "remote-skills-object-metadata-v1" ||
      stored.digest !== digest ||
      typeof stored.artifact_type !== "string" ||
      (stored.archive_format !== null && typeof stored.archive_format !== "string") ||
      !Number.isSafeInteger(stored.artifact_bytes) ||
      stored.artifact_bytes < 0 ||
      stored.artifact_bytes > this.maxArtifactBytes ||
      !Number.isSafeInteger(stored.extracted_bytes) ||
      stored.extracted_bytes < 0 ||
      stored.extracted_bytes > this.maxExtractedBytes ||
      !Array.isArray(stored.files) ||
      stored.files.length > this.maxFilesPerObject ||
      !isTimestamp(stored.verified_at) ||
      !isTimestamp(stored.accessed_at)
    ) {
      throw this.corruptObject(digest);
    }

    const paths = validatePortablePaths(stored.files.map((file) => file.path));
    if (JSON.stringify(paths) !== JSON.stringify(stored.files.map((file) => file.path))) {
      throw this.corruptObject(digest);
    }
    let extractedBytes = 0;
    for (const file of stored.files) {
      if (
        JSON.stringify(Object.keys(file).sort()) !==
          JSON.stringify(["media_type", "path", "size"]) ||
        !Number.isSafeInteger(file.size) ||
        file.size < 0 ||
        file.size > this.maxExtractedFileBytes ||
        typeof file.media_type !== "string"
      ) {
        throw this.corruptObject(digest);
      }
      extractedBytes += file.size;
      if (!Number.isSafeInteger(extractedBytes)) throw this.corruptObject(digest);
    }
    if (extractedBytes !== stored.extracted_bytes) {
      throw this.corruptObject(digest);
    }
    return paths;
  }

  private fromStoredObject(stored: StoredObjectMetadata): ObjectMetadata {
    return {
      digest: stored.digest,
      artifactType: stored.artifact_type,
      archiveFormat: stored.archive_format,
      artifactBytes: stored.artifact_bytes,
      extractedBytes: stored.extracted_bytes,
      files: stored.files.map((file) => ({
        path: file.path,
        size: file.size,
        mediaType: file.media_type,
      })),
      verifiedAt: stored.verified_at,
      accessedAt: stored.accessed_at,
    };
  }

  private async atomicCreateLease(path: string, lease: StoredLease): Promise<string> {
    return withDirectoryChainsMutationGuard(
      this.directory,
      [dirname(path)],
      () => this.coordinationHooks.beforeLeaseWrite?.(path),
      async () => {
        const temporary = `${path}.${randomUUID()}.tmp`;
        await writeSyncedFile(temporary, serializeJson(lease));
        try {
          await link(temporary, path);
          return path;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          return await this.atomicReplaceLease(path, lease, false);
        } finally {
          await rm(temporary, { force: true });
        }
      },
      true,
    );
  }

  private async atomicReplaceLease(
    path: string,
    lease: StoredLease,
    invokeHook = true,
  ): Promise<string> {
    return withDirectoryChainsMutationGuard(
      this.directory,
      [dirname(path)],
      () => (invokeHook ? this.coordinationHooks.beforeLeaseWrite?.(path) : undefined),
      async () => {
        const temporary = `${path}.${randomUUID()}.tmp`;
        await writeSyncedFile(temporary, serializeJson(lease));
        try {
          await this.renameFile(temporary, path);
          return path;
        } catch (error) {
          if (!["EEXIST", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? ""))
            throw error;
          const successor = path.replace(/\.json$/u, `.renew-${randomUUID()}.json`);
          await this.renameFile(temporary, successor);
          await rm(path, { force: true });
          return successor;
        } finally {
          await rm(temporary, { force: true });
        }
      },
      true,
    );
  }

  private async openObjectGenerationGuard(
    digest: string,
  ): Promise<ObjectGenerationGuard | undefined> {
    const directory = this.objectDirectory(digestHex(digest));
    try {
      const guard = {
        digest,
        directories: await openDirectoryChainNoFollow(this.directory, directory),
      };
      await this.coordinationHooks.afterObjectGenerationGuardOpen?.();
      return guard;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw this.corruptObject(digest, error);
    }
  }

  private async validateObjectGenerationGuard(guard: ObjectGenerationGuard): Promise<void> {
    try {
      for (const directory of guard.directories) await verifyDirectoryGuard(directory);
    } catch (error) {
      throw this.corruptObject(guard.digest, error);
    }
  }

  private async closeObjectGenerationGuard(
    guard: ObjectGenerationGuard | undefined,
  ): Promise<void> {
    if (guard === undefined) return;
    await Promise.all(guard.directories.map(({ handle }) => handle.close()));
  }

  private async withDigestLock<T>(
    digest: string,
    action: () => Promise<T>,
    scanBudget = new CacheScanBudget(this.maxScanEntries),
    operation: "acquire" | "evict" | "mutation" = "mutation",
    rejectMissingObjectAfterEvictionContention = false,
    observedObjectGeneration?: ObjectGenerationGuard,
  ): Promise<T> {
    const hex = digestHex(digest);
    const directory = this.mutationLockDigestDirectory(hex);
    const deadline = performance.now() + this.mutationLockTimeoutSeconds * 1_000;
    let contendedWithEviction = false;
    const ownerNonce = randomUUID();
    const createdAt = this.now().toISOString();
    if (!isTimestamp(createdAt)) throw this.corruptObject(digest);
    let heartbeat: ProcessRegistrationHeartbeat | undefined;
    let intentPath: string | undefined;
    let lockPath: string | undefined;
    try {
      // A contender may only publish coordination state after its liveness record exists.
      heartbeat = await this.startProcessRegistrationHeartbeat(hex);
      await this.ensureMutationLockDigestDirectory(hex);
      const intent: StoredMutationIntent = {
        schema: "remote-skills-cache-mutation-intent-v1",
        pid: this.pid,
        process_nonce: this.processNonce,
        owner_nonce: ownerNonce,
        created_at: createdAt,
        operation,
      };
      intentPath = join(directory, `${ownerNonce}.intent`);
      await this.publishMutationGateRecord(intentPath, intent);

      const selected = await this.nextMutationTicket(directory, digest);
      const ticket = selected.ticket;
      contendedWithEviction ||= selected.contendedWithEviction;
      const lock: StoredMutationLock = {
        schema: "remote-skills-cache-mutation-lock-v1",
        pid: this.pid,
        process_nonce: this.processNonce,
        owner_nonce: ownerNonce,
        ticket,
        created_at: createdAt,
        operation,
        ...(contendedWithEviction ? { contended_with_eviction: true } : {}),
      };
      lockPath = join(directory, `${String(ticket).padStart(16, "0")}-${ownerNonce}.lock`);
      await this.publishMutationGateRecord(lockPath, lock);

      for (;;) {
        const turn = await this.mutationTurnState(directory, lock, lockPath);
        contendedWithEviction ||= turn.contendedWithEviction;
        if (turn.ready) break;
        const remainingMilliseconds = deadline - performance.now();
        if (remainingMilliseconds <= 0) throw this.corruptObject(digest);
        await delay(Math.min(10, remainingMilliseconds));
      }
      if (observedObjectGeneration !== undefined) {
        await this.validateObjectGenerationGuard(observedObjectGeneration);
      } else if (
        rejectMissingObjectAfterEvictionContention &&
        contendedWithEviction &&
        (await this.readObjectUnlocked(digest, false, scanBudget)) === null
      ) {
        throw this.corruptObject(digest);
      }
      return await action();
    } finally {
      for (const path of [lockPath, intentPath]) {
        if (path === undefined) continue;
        try {
          await rm(path, { force: true });
        } catch (error) {
          this.onBackgroundError(error);
        }
      }
      const registrationRelease = await heartbeat?.stop();
      if (registrationRelease?.final === true) {
        await this.removeOwnRegistrationIfUnleased(hex, registrationRelease.identity, scanBudget);
      }
    }
  }

  private async publishMutationGateRecord(
    path: string,
    record: StoredMutationIntent | StoredMutationLock,
  ): Promise<void> {
    const directory = dirname(path);
    const digestHexValue = directory.slice(directory.lastIndexOf(sep) + 1);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const temporary = join(directory, `.${basename(path)}-${randomUUID()}.tmp`);
      try {
        await withDirectoryChainsMutationGuard(
          this.directory,
          [directory],
          () => {},
          async () => {
            await writeSyncedFile(temporary, serializeJson(record));
            try {
              await link(temporary, path);
            } finally {
              await rm(temporary, { force: true });
            }
          },
        );
        return;
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => {});
        if (
          (!(error instanceof CachePathChangedError) &&
            !["EINVAL", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")) ||
          attempt === 7
        ) {
          throw error;
        }
        await this.ensureMutationLockDigestDirectory(digestHexValue);
      }
    }
  }

  private async nextMutationTicket(
    directory: string,
    digest: string,
  ): Promise<{ ticket: number; contendedWithEviction: boolean }> {
    let maximum = 0;
    let contendedWithEviction = false;
    for (const entry of await readDirectoryBounded(
      directory,
      new CacheScanBudget(this.maxScanEntries),
    )) {
      if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".lock")) continue;
      const snapshot = await readRegularFileSnapshotNoFollow(
        join(directory, entry.name),
        MAX_COORDINATION_RECORD_BYTES,
      ).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT" || error instanceof CachePathChangedError) return undefined;
        throw error;
      });
      if (snapshot === undefined) continue;
      let value: ParsedMutationRecord;
      try {
        value = parseMutationRecord(JSON.parse(decodeUtf8(snapshot.bytes)));
      } catch {
        continue;
      }
      if (
        value.schema === "remote-skills-cache-mutation-lock-v1" &&
        Number.isSafeInteger(value.ticket) &&
        (value.ticket as number) > 0
      ) {
        maximum = Math.max(maximum, value.ticket as number);
        contendedWithEviction ||= value.operation === "evict";
      }
    }
    if (maximum >= Number.MAX_SAFE_INTEGER) throw this.corruptObject(digest);
    return { ticket: maximum + 1, contendedWithEviction };
  }

  private async mutationTurnState(
    directory: string,
    own: StoredMutationLock,
    ownPath: string,
  ): Promise<{ ready: boolean; contendedWithEviction: boolean }> {
    await this.coordinationHooks.beforeMutationTurnState?.();
    let blocked = false;
    let contendedWithEviction = false;
    const entries = await readDirectoryBounded(directory, new CacheScanBudget(this.maxScanEntries));
    const records: ParsedMutationRecord[] = [];
    for (const entry of entries) {
      if (entry.isSymbolicLink() || !entry.isFile()) {
        blocked = true;
        contendedWithEviction = true;
        continue;
      }
      const path = join(directory, entry.name);
      if (path === ownPath) continue;
      if (entry.name.endsWith(".tmp")) {
        await this.reclaimStaleMutationLock(path);
        continue;
      }
      if (!entry.name.endsWith(".intent") && !entry.name.endsWith(".lock")) {
        blocked = true;
        contendedWithEviction = true;
        continue;
      }
      await this.reclaimStaleMutationLock(path);
      const snapshot = await readRegularFileSnapshotNoFollow(
        path,
        MAX_COORDINATION_RECORD_BYTES,
      ).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT" || error instanceof CachePathChangedError) return undefined;
        throw error;
      });
      if (snapshot === undefined) continue;
      let value: ParsedMutationRecord;
      try {
        value = parseMutationRecord(JSON.parse(decodeUtf8(snapshot.bytes)));
      } catch {
        blocked = true;
        contendedWithEviction = true;
        continue;
      }
      if (
        value.schema !== "remote-skills-cache-mutation-intent-v1" &&
        value.schema !== "remote-skills-cache-mutation-lock-v1"
      ) {
        blocked = true;
        contendedWithEviction = true;
        continue;
      }
      if (
        !Number.isSafeInteger(value.pid) ||
        (value.pid as number) <= 0 ||
        !isSafeNonce(value.process_nonce) ||
        !isSafeNonce(value.owner_nonce) ||
        !isTimestamp(value.created_at) ||
        (value.operation !== undefined &&
          !["acquire", "evict", "mutation"].includes(value.operation)) ||
        (value.contended_with_eviction !== undefined &&
          typeof value.contended_with_eviction !== "boolean")
      ) {
        blocked = true;
        contendedWithEviction = true;
        continue;
      }
      contendedWithEviction ||= !["acquire", "mutation"].includes(value.operation ?? "");
      if (value.schema === "remote-skills-cache-mutation-intent-v1") {
        records.push(value);
        continue;
      }
      if (
        !Number.isSafeInteger(value.ticket) ||
        (value.ticket as number) <= 0 ||
        !isSafeNonce(value.owner_nonce)
      ) {
        blocked = true;
        continue;
      }
      if (
        (value.ticket as number) < own.ticket ||
        ((value.ticket as number) === own.ticket && (value.owner_nonce as string) < own.owner_nonce)
      ) {
        blocked = true;
      }
      records.push(value);
    }
    const finalizedOwners = new Set<string>([own.owner_nonce]);
    for (const record of records) {
      if (
        record.schema === "remote-skills-cache-mutation-lock-v1" &&
        isSafeNonce(record.owner_nonce)
      ) {
        finalizedOwners.add(record.owner_nonce);
      }
    }
    for (const record of records) {
      if (
        record.schema === "remote-skills-cache-mutation-intent-v1" &&
        (!isSafeNonce(record.owner_nonce) || !finalizedOwners.has(record.owner_nonce))
      ) {
        blocked = true;
      }
    }
    return { ready: !blocked, contendedWithEviction };
  }

  private async ensureMutationLockDirectory(): Promise<void> {
    const stableParent = join(this.layoutDirectory, "tmp");
    await this.ensureSafeDirectory(stableParent);
    await withDirectoryChainGuard(this.directory, stableParent, async () => {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        try {
          await this.ensureSafeDirectory(this.mutationLockDirectory());
          return;
        } catch (error) {
          if (
            (!(error instanceof CachePathChangedError) &&
              !["EINVAL", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")) ||
            attempt === 7
          ) {
            throw error;
          }
        }
      }
    });
  }

  private async ensureMutationLockDigestDirectory(digestHexValue: string): Promise<void> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        await this.ensureMutationLockDirectory();
        await withDirectoryChainGuard(this.directory, this.mutationLockDirectory(), () =>
          this.ensureSafeDirectory(this.mutationLockDigestDirectory(digestHexValue)),
        );
        return;
      } catch (error) {
        if (
          (!(error instanceof CachePathChangedError) &&
            !["EINVAL", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")) ||
          attempt === 7
        ) {
          throw error;
        }
      }
    }
  }

  private async reclaimStaleMutationLock(path: string): Promise<void> {
    try {
      await this.assertSafeAncestors(dirname(path));
      const snapshot = await readRegularFileSnapshotNoFollow(path, MAX_COORDINATION_RECORD_BYTES);
      let lock: ParsedMutationRecord | undefined;
      try {
        lock = parseMutationRecord(JSON.parse(decodeUtf8(snapshot.bytes)));
      } catch {
        lock = undefined;
      }
      if (
        lock !== undefined &&
        typeof lock.schema === "string" &&
        ![
          "remote-skills-cache-mutation-lock-v1",
          "remote-skills-cache-mutation-intent-v1",
        ].includes(lock.schema)
      ) {
        return;
      }
      const hex = dirname(path).slice(dirname(path).lastIndexOf(sep) + 1);
      const knownSchema =
        lock?.schema === "remote-skills-cache-mutation-lock-v1" ||
        lock?.schema === "remote-skills-cache-mutation-intent-v1";
      const valid =
        lock !== undefined &&
        knownSchema &&
        Number.isSafeInteger(lock.pid) &&
        (lock.pid as number) > 0 &&
        isSafeNonce(lock.process_nonce) &&
        isSafeNonce(lock.owner_nonce) &&
        isTimestamp(lock.created_at) &&
        (lock.operation === undefined ||
          ["acquire", "evict", "mutation"].includes(lock.operation)) &&
        (lock.contended_with_eviction === undefined ||
          typeof lock.contended_with_eviction === "boolean") &&
        (lock.schema === "remote-skills-cache-mutation-intent-v1" ||
          (Number.isSafeInteger(lock.ticket) && (lock.ticket as number) > 0)) &&
        /^[0-9a-f]{64}$/u.test(hex);
      const age =
        this.now().getTime() -
        (valid ? Date.parse(lock?.created_at as string) : snapshot.identity.mtimeMs);
      if (age <= this.leaseExpirySeconds * 1_000) {
        return;
      }
      const registeredAlive =
        valid && lock !== undefined
          ? await this.isRegisteredProcessAlive(
              lock.pid as number,
              lock.process_nonce as string,
              hex,
            )
          : false;
      if (!registeredAlive) {
        // Gate records are generation-unique and their paths are never reused. A later
        // legitimate owner therefore cannot occupy this pathname between the liveness
        // decision and removal.
        await rm(path, { force: true });
      }
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "ENOENT" &&
        !(error instanceof CachePathChangedError)
      )
        throw error;
    }
  }

  private async cleanupTemporaryPaths(scanBudget: CacheScanBudget): Promise<number> {
    const root = join(this.layoutDirectory, "tmp");
    let entries: Dirent[];
    try {
      await this.assertSafeAncestors(root);
      entries = await readDirectoryBounded(root, scanBudget);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw error;
    }
    let removed = 0;
    for (const entry of entries) {
      if (entry.name === "coordination-v1" || entry.name === "catalog-generations-v1") continue;
      const path = join(root, entry.name);
      const state = await lstat(path);
      const age = this.now().getTime() - state.mtimeMs;
      if (age <= this.temporaryExpirySeconds * 1_000) continue;
      const catalogMatch =
        /^catalog-([0-9a-f]{64})-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.exec(
          entry.name,
        );
      if (entry.name.startsWith("catalog-") && catalogMatch === null) continue;
      const objectMatch = /^writer-typescript-([0-9a-f]{64})-[A-Za-z0-9-]+$/u.exec(entry.name);
      const accessMatch = /^object-access-([0-9a-f]{64})-[A-Za-z0-9-]+\.tmp$/u.exec(entry.name);
      const catalogIdentifier = catalogMatch?.[1];
      let coordinationDigest: string | undefined;
      if (objectMatch !== null) coordinationDigest = `sha256:${objectMatch[1] as string}`;
      else if (accessMatch !== null) coordinationDigest = `sha256:${accessMatch[1] as string}`;
      if (entry.isDirectory() && !state.isSymbolicLink()) {
        try {
          const writer = await withDirectoryGuard(path, async () =>
            parseStoredWriter(
              JSON.parse(
                decodeUtf8(
                  await readRegularFileNoFollow(
                    join(path, "writer.json"),
                    MAX_COORDINATION_RECORD_BYTES,
                  ),
                ),
              ),
            ),
          );
          const writerDigest =
            typeof writer.expected_digest === "string" &&
            /^[0-9a-f]{64}$/u.test(digestHex(writer.expected_digest))
              ? writer.expected_digest
              : undefined;
          if (
            writer.schema === "remote-skills-cache-writer-v1" &&
            Number.isSafeInteger(writer.pid) &&
            (writer.pid as number) > 0 &&
            isSafeNonce(writer.process_nonce) &&
            writerDigest !== undefined &&
            (catalogIdentifier !== undefined
              ? writerDigest === `sha256:${catalogIdentifier}`
              : coordinationDigest === undefined || coordinationDigest === writerDigest) &&
            (await this.isRegisteredProcessAlive(
              writer.pid as number,
              writer.process_nonce,
              digestHex(writerDigest),
            ))
          ) {
            continue;
          }
          if (coordinationDigest === undefined) coordinationDigest = writerDigest;
        } catch (error) {
          if (error instanceof CachePathChangedError) continue;
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            // Unknown temporary metadata is never interpreted; conservative age still applies.
          }
        }
      }
      const deletePath = () =>
        withDirectoryChainsMutationGuard(
          this.directory,
          [root],
          () => this.coordinationHooks.beforeTemporaryCleanup?.(path),
          async () => {
            const current = await lstat(path).catch((error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return undefined;
              throw error;
            });
            if (current === undefined || !isSameIdentity(state, current)) return false;
            await this.coordinationHooks.afterTemporaryCleanupScan?.(path);
            await this.removeDirectoryTreeBounded(path, scanBudget, current);
            return true;
          },
          true,
        );
      const deleted =
        catalogIdentifier === undefined
          ? coordinationDigest === undefined
            ? await deletePath()
            : await this.withDigestLock(coordinationDigest, deletePath, scanBudget)
          : await this.withDigestLock(
              EVICTION_DECISION_LOCK_DIGEST,
              () =>
                this.withDigestLock(
                  catalogMutationDigest(catalogIdentifier),
                  deletePath,
                  scanBudget,
                ),
              scanBudget,
            );
      if (deleted) removed += 1;
    }
    return removed;
  }

  private async removeDirectoryTreeBounded(
    path: string,
    scanBudget: CacheScanBudget,
    expected?: Stats,
  ): Promise<void> {
    await this.coordinationHooks.beforeDirectoryRemoval?.(path);
    const state = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (state === undefined) return;
    if (expected !== undefined && !isSameIdentity(expected, state)) {
      throw new CachePathChangedError();
    }
    if (!state.isDirectory() || state.isSymbolicLink()) {
      const current = await lstat(path);
      if (!isSameIdentity(state, current) || current.isDirectory()) {
        throw new CachePathChangedError();
      }
      await rm(path, { force: true });
      return;
    }
    await withDirectoryChainGuard(this.directory, path, async () => {
      for await (const entry of await opendir(path)) {
        scanBudget.consume();
        const child = join(path, entry.name);
        const childState = await lstat(child);
        if (childState.isDirectory() && !childState.isSymbolicLink()) {
          await this.removeDirectoryTreeBounded(child, scanBudget, childState);
        } else {
          const current = await lstat(child);
          if (!isSameIdentity(childState, current) || current.isDirectory()) {
            throw new CachePathChangedError();
          }
          await rm(child, { force: true });
        }
      }
    });
    await rmdir(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }

  private async cleanupLeases(scanBudget: CacheScanBudget): Promise<number> {
    const root = join(this.layoutDirectory, "leases");
    let digestDirectories: Dirent[];
    try {
      await this.assertSafeAncestors(root);
      digestDirectories = await readDirectoryBounded(root, scanBudget);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw error;
    }
    let reclaimed = 0;
    for (const digestDirectory of digestDirectories) {
      if (!digestDirectory.isDirectory() || !/^[0-9a-f]{64}$/u.test(digestDirectory.name)) continue;
      const directory = join(root, digestDirectory.name);
      const digest = `sha256:${digestDirectory.name}`;
      reclaimed += await this.withDigestLock(
        digest,
        async () => {
          let digestReclaimed = 0;
          let entries: Dirent[];
          try {
            await this.assertSafeAncestors(directory);
            entries = await readDirectoryBounded(directory, scanBudget);
          } catch (error) {
            // Another cleanup may finish this directory before our digest lock is acquired.
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
            throw error;
          }
          for (const entry of entries) {
            if (!entry.isFile() || entry.name.startsWith(".")) continue;
            const path = join(directory, entry.name);
            const snapshot = await this.readLeaseSnapshot(path, digestDirectory.name);
            const age = this.now().getTime() - Date.parse(snapshot.lease.renewed_at);
            if (age <= this.leaseExpirySeconds * 1_000) continue;
            if (await this.isLeaseHolderAlive(snapshot.lease, digestDirectory.name)) continue;
            await this.coordinationHooks.beforeLeaseCleanupUnlink?.(path);
            if (await unlinkIfSameSnapshot(path, snapshot)) digestReclaimed += 1;
          }
          await this.cleanupPythonEvictionClaim(directory);
          await this.cleanupLeaseGeneration(directory, scanBudget);
          // Keep removal in the same turn as inspection so other cleanup and lease writers wait.
          if ((await readDirectoryBounded(directory, scanBudget)).length === 0) {
            await rmdir(directory).catch((error: NodeJS.ErrnoException) => {
              if (!["ENOENT", "ENOTEMPTY"].includes(error.code ?? "")) throw error;
            });
          }
          return digestReclaimed;
        },
        scanBudget,
      );
    }
    return reclaimed;
  }

  private async cleanupPythonEvictionClaim(directory: string): Promise<void> {
    const claimPath = join(directory, ".eviction-claim.json");
    let snapshot: RegularFileSnapshot;
    try {
      snapshot = await readRegularFileSnapshotNoFollow(claimPath, MAX_COORDINATION_RECORD_BYTES);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    let claim: unknown;
    try {
      claim = JSON.parse(decodeUtf8(snapshot.bytes));
    } catch {
      return;
    }
    if (
      claim === null ||
      typeof claim !== "object" ||
      JSON.stringify(Object.keys(claim).sort()) !==
        JSON.stringify([
          "coordination_version",
          "created_at",
          "pid",
          "process_identity",
          "process_nonce",
          "schema",
        ]) ||
      (claim as { schema?: unknown }).schema !== "remote-skills-cache-eviction-claim-v1" ||
      (claim as { coordination_version?: unknown }).coordination_version !==
        "remote-skills-cache-coordination-v1" ||
      !Number.isSafeInteger((claim as { pid?: unknown }).pid) ||
      ((claim as { pid: number }).pid as number) <= 0 ||
      !isSafeNonce((claim as { process_nonce?: unknown }).process_nonce) ||
      typeof (claim as { process_identity?: unknown }).process_identity !== "string" ||
      !isTimestamp((claim as { created_at?: unknown }).created_at)
    ) {
      return;
    }
    const stored = claim as {
      pid: number;
      process_nonce: string;
      created_at: string;
    };
    const age = this.now().getTime() - Date.parse(stored.created_at);
    if (
      age <= this.leaseExpirySeconds * 1_000 ||
      (await this.isProcessAlive(stored.pid, stored.process_nonce))
    ) {
      return;
    }
    await unlinkIfSameSnapshot(claimPath, snapshot);
  }

  private async cleanupLeaseGeneration(
    directory: string,
    scanBudget: CacheScanBudget,
  ): Promise<void> {
    const generationPath = join(directory, ".lease-generation.json");
    const entries = await readDirectoryBounded(directory, scanBudget);
    if (entries.some((entry) => entry.name !== ".lease-generation.json")) return;
    let snapshot: RegularFileSnapshot;
    try {
      snapshot = await readRegularFileSnapshotNoFollow(
        generationPath,
        MAX_COORDINATION_RECORD_BYTES,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    let generation: unknown;
    try {
      generation = JSON.parse(decodeUtf8(snapshot.bytes));
    } catch {
      return;
    }
    if (
      generation === null ||
      typeof generation !== "object" ||
      JSON.stringify(Object.keys(generation).sort()) !==
        JSON.stringify(["coordination_version", "generation", "schema"]) ||
      (generation as { schema?: unknown }).schema !== "remote-skills-cache-lease-generation-v1" ||
      (generation as { coordination_version?: unknown }).coordination_version !==
        "remote-skills-cache-coordination-v1" ||
      !isTimestamp((generation as { generation?: unknown }).generation)
    ) {
      return;
    }
    const currentEntries = await readDirectoryBounded(directory, scanBudget);
    if (currentEntries.some((entry) => entry.name !== ".lease-generation.json")) return;
    await unlinkIfSameSnapshot(generationPath, snapshot);
  }

  private async cleanupCoordinationState(scanBudget: CacheScanBudget): Promise<void> {
    const locks = this.mutationLockDirectory();
    let lockEntries: Dirent[] = [];
    try {
      await this.assertSafeAncestors(locks);
      lockEntries = await readDirectoryBounded(locks, scanBudget);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    for (const entry of lockEntries) {
      if (entry.isSymbolicLink() || !entry.isDirectory() || !/^[0-9a-f]{64}$/u.test(entry.name))
        continue;
      const digestDirectory = join(locks, entry.name);
      const records = await readDirectoryBounded(digestDirectory, scanBudget).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return [];
          throw error;
        },
      );
      for (const record of records) {
        if (
          record.isSymbolicLink() ||
          !record.isFile() ||
          !/^\.?[A-Za-z0-9._-]+\.(?:intent|lock)(?:-[A-Za-z0-9._-]+\.tmp)?$/u.test(record.name)
        )
          continue;
        await this.reclaimStaleMutationLock(join(digestDirectory, record.name));
      }
      await rmdir(digestDirectory).catch((error: NodeJS.ErrnoException) => {
        if (!["ENOENT", "ENOTEMPTY"].includes(error.code ?? "")) throw error;
      });
    }

    const processes = join(this.coordinationDirectory(), "processes");
    let digestDirectories: Dirent[] = [];
    try {
      await this.assertSafeAncestors(processes);
      digestDirectories = await readDirectoryBounded(processes, scanBudget);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    for (const digestEntry of digestDirectories) {
      if (
        digestEntry.isSymbolicLink() ||
        !digestEntry.isDirectory() ||
        !/^[0-9a-f]{64}$/u.test(digestEntry.name)
      )
        continue;
      const directory = join(processes, digestEntry.name);
      let registrationEntries: Dirent[];
      try {
        await this.assertSafeAncestors(directory);
        registrationEntries = await readDirectoryBounded(directory, scanBudget);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      for (const entry of registrationEntries) {
        if (
          entry.isSymbolicLink() ||
          !entry.isFile() ||
          !/^[A-Za-z0-9._-]+\.json$/u.test(entry.name)
        )
          continue;
        const path = join(directory, entry.name);
        let snapshot: RegularFileSnapshot;
        let registration: Partial<StoredProcessRegistration>;
        try {
          snapshot = await readRegularFileSnapshotNoFollow(path, MAX_COORDINATION_RECORD_BYTES);
          registration = parseStoredProcessRegistration(JSON.parse(decodeUtf8(snapshot.bytes)));
        } catch {
          continue;
        }
        if (registration.schema !== "remote-skills-cache-process-registration-v1") continue;
        if (
          !Number.isSafeInteger(registration.pid) ||
          (registration.pid as number) <= 0 ||
          !isSafeNonce(registration.process_nonce) ||
          entry.name !== `${registration.process_nonce}.json` ||
          !isTimestamp(registration.renewed_at)
        ) {
          throw this.corruptObject(`sha256:${digestEntry.name}`);
        }
        const age = this.now().getTime() - Date.parse(registration.renewed_at);
        if (
          age > this.leaseExpirySeconds * 1_000 &&
          !(await this.isRegisteredProcessAlive(
            registration.pid as number,
            registration.process_nonce as string,
            digestEntry.name,
          ))
        ) {
          await unlinkIfSameSnapshot(path, snapshot);
        }
      }
      await rmdir(directory).catch((error: NodeJS.ErrnoException) => {
        if (!["ENOENT", "ENOTEMPTY"].includes(error.code ?? "")) throw error;
      });
    }
    for (const directory of [processes, locks, this.coordinationDirectory()]) {
      await rmdir(directory).catch((error: NodeJS.ErrnoException) => {
        if (!["ENOENT", "ENOTEMPTY"].includes(error.code ?? "")) throw error;
      });
    }
  }

  private async readLeaseSnapshot(
    path: string,
    digestHexValue: string,
  ): Promise<RegularFileSnapshot & { lease: StoredLease }> {
    try {
      await this.assertSafeAncestors(dirname(path));
      const snapshot = await readRegularFileSnapshotNoFollow(path, MAX_COORDINATION_RECORD_BYTES);
      const lease = parseStoredLease(JSON.parse(decodeUtf8(snapshot.bytes)));
      const keys = [
        "created_at",
        "digest",
        ...(lease.lease_nonce === undefined ? [] : ["lease_nonce"]),
        "pid",
        "process_nonce",
        "renewed_at",
        "schema",
        "session_nonce",
      ];
      if (
        JSON.stringify(Object.keys(lease).sort()) !== JSON.stringify(keys) ||
        lease.schema !== "remote-skills-cache-lease-v1" ||
        digestHex(lease.digest) !== digestHexValue ||
        !Number.isSafeInteger(lease.pid) ||
        lease.pid <= 0 ||
        !isSafeNonce(lease.process_nonce) ||
        !isSafeNonce(lease.session_nonce) ||
        (lease.lease_nonce !== undefined && !isSafeNonce(lease.lease_nonce)) ||
        !isTimestamp(lease.created_at) ||
        !isTimestamp(lease.renewed_at)
      ) {
        throw this.corruptObject(`sha256:${digestHexValue}`);
      }
      return { ...snapshot, lease };
    } catch (error) {
      if (error instanceof CacheCorruptError) throw error;
      throw this.corruptObject(`sha256:${digestHexValue}`, error);
    }
  }

  private async readLease(path: string, digestHexValue: string): Promise<StoredLease> {
    return (await this.readLeaseSnapshot(path, digestHexValue)).lease;
  }

  private async liveLeaseDigests(scanBudget: CacheScanBudget): Promise<Set<string>> {
    const root = join(this.layoutDirectory, "leases");
    const live = new Set<string>();
    let digestDirectories: Dirent[];
    try {
      await this.assertSafeAncestors(root);
      digestDirectories = await readDirectoryBounded(root, scanBudget);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return live;
      throw error;
    }
    for (const digestDirectory of digestDirectories) {
      if (!digestDirectory.isDirectory() || !/^[0-9a-f]{64}$/u.test(digestDirectory.name)) continue;
      const directory = join(root, digestDirectory.name);
      await this.assertSafeAncestors(directory);
      for (const entry of await readDirectoryBounded(directory, scanBudget)) {
        if (!entry.isFile() || entry.name.startsWith(".")) continue;
        const lease = await this.readLease(join(directory, entry.name), digestDirectory.name);
        const age = this.now().getTime() - Date.parse(lease.renewed_at);
        if (
          age <= this.leaseExpirySeconds * 1_000 ||
          (await this.isLeaseHolderAlive(lease, digestDirectory.name))
        ) {
          live.add(lease.digest);
        }
      }
    }
    return live;
  }

  private async readCatalogScanRow(
    originId: string,
    generation: "current" | "previous",
    directory: string,
    scanBudget: CacheScanBudget,
  ): Promise<CatalogScanRow> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        decodeUtf8(
          await readRegularFileNoFollow(
            join(directory, "metadata.json"),
            Math.min(this.maxObjectMetadataBytes, CACHE_MAX_CATALOG_METADATA_BYTES),
          ),
        ),
      );
    } catch (error) {
      if (error instanceof CacheCorruptError) throw error;
      throw new CacheCorruptError("catalog cache metadata is corrupt", {
        layout_version: CACHE_LAYOUT_NAMESPACE,
      });
    }
    const candidateUrl =
      parsed !== null && typeof parsed === "object"
        ? (parsed as Partial<StoredCatalogMetadata>).canonical_url
        : undefined;
    if (typeof candidateUrl !== "string") {
      throw new CacheCorruptError("catalog cache metadata is corrupt", {
        layout_version: CACHE_LAYOUT_NAMESPACE,
      });
    }
    let canonicalUrl: string;
    try {
      canonicalUrl = sanitizeCanonicalUrl(candidateUrl);
    } catch {
      throw new CacheCorruptError("catalog cache metadata is corrupt", {
        layout_version: CACHE_LAYOUT_NAMESPACE,
      });
    }
    const candidateScope =
      parsed !== null && typeof parsed === "object"
        ? (parsed as Partial<StoredCatalogMetadata>).confirmed_scope
        : undefined;
    if (candidateScope !== undefined && !isConfirmedScope(candidateScope)) {
      throw new CacheCorruptError("catalog cache metadata is corrupt", {
        layout_version: CACHE_LAYOUT_NAMESPACE,
      });
    }
    if (canonicalOriginIdentifier(canonicalUrl, candidateScope) !== originId) {
      throw new CacheCorruptError("catalog cache metadata is corrupt", {
        layout_version: CACHE_LAYOUT_NAMESPACE,
      });
    }
    const snapshot = await this.readCatalogGenerationSnapshot(canonicalUrl, directory, scanBudget);
    return {
      originId,
      canonicalUrl,
      generation,
      directory,
      snapshot,
      bytes: snapshot.body.bytes.byteLength + snapshot.metadata.bytes.byteLength,
      accessedAt: snapshot.stored.validated_at,
    };
  }

  private async listCatalogRows(scanBudget: CacheScanBudget): Promise<CatalogScanRow[]> {
    const rows: CatalogScanRow[] = [];
    const scanRoot = async (root: string, generation: "current" | "previous"): Promise<void> => {
      let entries: Dirent[];
      try {
        await this.assertSafeAncestors(root);
        entries = [];
        for await (const entry of await opendir(root)) {
          if (generation === "previous" && entry.name === "state.json") continue;
          scanBudget.consume();
          entries.push(entry);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      for (const entry of entries) {
        if (!/^[0-9a-f]{64}$/u.test(entry.name)) continue;
        if (!entry.isDirectory() || entry.isSymbolicLink()) {
          throw new CacheCorruptError("catalog cache directory inventory is corrupt", {
            layout_version: CACHE_LAYOUT_NAMESPACE,
          });
        }
        const directory =
          generation === "current" ? join(root, entry.name) : join(root, entry.name, "previous");
        const state = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        });
        if (state === undefined) continue;
        if (!state.isDirectory() || state.isSymbolicLink()) {
          throw new CacheCorruptError("catalog cache directory inventory is corrupt", {
            layout_version: CACHE_LAYOUT_NAMESPACE,
          });
        }
        rows.push(await this.readCatalogScanRow(entry.name, generation, directory, scanBudget));
      }
    };
    await scanRoot(join(this.layoutDirectory, "catalogs"), "current");
    await scanRoot(join(this.layoutDirectory, "tmp", "catalog-generations-v1"), "previous");
    return rows;
  }

  private async removeCatalogGeneration(
    row: CatalogScanRow,
    scanBudget: CacheScanBudget,
  ): Promise<"missing" | "removed"> {
    return this.withDigestLock(
      catalogMutationDigest(row.originId),
      async () => {
        await this.advanceCatalogGenerationEpoch();
        return this.removeCatalogGenerationUnlocked(row, scanBudget);
      },
      scanBudget,
    );
  }

  private async removeCatalogGenerationUnlocked(
    row: CatalogScanRow,
    scanBudget: CacheScanBudget,
  ): Promise<"missing" | "removed"> {
    try {
      await this.readCatalogGenerationSnapshot(
        row.canonicalUrl,
        row.directory,
        scanBudget,
        row.snapshot,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        await this.removeEmptyCatalogGenerationParent(row.originId);
        return "missing";
      }
      throw error;
    }
    const quarantine = join(
      this.layoutDirectory,
      "tmp",
      `evict-catalog-${row.originId}-${randomUUID()}`,
    );
    await this.ensureSafeDirectory(dirname(quarantine));
    const outcome = await withDirectoryChainsMutationGuard(
      this.directory,
      [dirname(row.directory), dirname(quarantine)],
      () => {},
      async (verifyCommit) => {
        let deletionStarted = false;
        try {
          await this.renameFile(row.directory, quarantine);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
          throw error;
        }
        try {
          await this.coordinationHooks.afterCatalogEvictionQuarantine?.(row.originId);
          const quarantined = await lstat(quarantine);
          if (!isSameIdentity(row.snapshot.directoryIdentity, quarantined)) {
            throw new CachePathChangedError();
          }
          await verifyCommit();
          deletionStarted = true;
          await this.removeDirectoryTreeBounded(quarantine, scanBudget, quarantined);
          return "removed";
        } catch (error) {
          if (deletionStarted) throw error;
          try {
            await this.renameFile(quarantine, row.directory);
          } catch (recoveryError) {
            throw new AggregateError(
              [error, recoveryError],
              "catalog eviction quarantine recovery failed",
            );
          }
          throw error;
        }
      },
      true,
    );
    await this.removeEmptyCatalogGenerationParent(row.originId);
    return outcome;
  }

  private async listObjectRows(scanBudget: CacheScanBudget): Promise<ObjectScanRow[]> {
    const root = join(this.layoutDirectory, "objects", "sha256");
    const objects: ObjectScanRow[] = [];
    try {
      await this.assertSafeAncestors(root);
      const rootState = await lstat(root);
      if (!rootState.isDirectory() || rootState.isSymbolicLink()) throw new CachePathChangedError();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return objects;
      throw error;
    }
    for await (const prefix of await opendir(root)) {
      scanBudget.consume();
      if (!prefix.isDirectory() || !/^[0-9a-f]{2}$/u.test(prefix.name)) continue;
      const prefixPath = join(root, prefix.name);
      await this.assertSafeAncestors(prefixPath);
      for await (const suffix of await opendir(prefixPath)) {
        scanBudget.consume();
        if (!suffix.isDirectory() || !/^[0-9a-f]{62}$/u.test(suffix.name)) continue;
        const digest = `sha256:${prefix.name}${suffix.name}`;
        objects.push(
          await this.withDigestLock(
            digest,
            () => this.readObjectMetadataRow(digest, scanBudget),
            scanBudget,
          ),
        );
      }
    }
    return objects;
  }

  private async readObjectMetadataRow(
    digest: string,
    scanBudget: CacheScanBudget,
  ): Promise<ObjectScanRow> {
    const objectDirectory = this.objectDirectory(digestHex(digest));
    return withDirectoryChainGuard(this.directory, objectDirectory, async () => {
      await validateObjectDirectoryInventory(objectDirectory, scanBudget);
      const encoded = await readRegularFileNoFollow(
        join(objectDirectory, "object.json"),
        this.maxObjectMetadataBytes,
      );
      const stored = parseStoredObjectMetadata(JSON.parse(decodeUtf8(encoded)));
      this.validateStoredObjectMetadata(stored, digest);
      return {
        digest,
        artifactBytes: stored.artifact_bytes,
        extractedBytes: stored.extracted_bytes,
        accessedAt: stored.accessed_at,
      };
    });
  }

  private async removeObject(
    digest: string,
    scanBudget: CacheScanBudget,
  ): Promise<"missing" | "pinned" | "removed"> {
    return this.withDigestLock(
      digest,
      async () => {
        if (await this.hasLiveLease(digest, scanBudget)) return "pinned";
        if ((await this.readObjectUnlocked(digest, false, scanBudget)) === null) return "missing";
        const source = this.objectDirectory(digestHex(digest));
        const temporary = join(this.layoutDirectory, "tmp", `evict-${randomUUID()}`);
        await this.ensureSafeDirectory(dirname(temporary));
        return withDirectoryChainsMutationGuard(
          this.directory,
          [dirname(source), dirname(temporary)],
          () => this.coordinationHooks.beforeObjectEvictionCommit?.(digest),
          async (verifyCommit) => {
            let quarantined = false;
            let deletionStarted = false;
            try {
              await this.renameFile(source, temporary);
              quarantined = true;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
              throw error;
            }
            try {
              await this.coordinationHooks.afterObjectEvictionQuarantine?.(digest);
              await verifyCommit();
              if (await this.hasLiveLease(digest, scanBudget)) {
                await this.renameFile(temporary, source);
                quarantined = false;
                return "pinned";
              }
              deletionStarted = true;
              await this.removeDirectoryTreeBounded(temporary, scanBudget);
              quarantined = false;
              return "removed";
            } catch (error) {
              if (quarantined && !deletionStarted) {
                try {
                  await this.renameFile(temporary, source);
                } catch (recoveryError) {
                  throw new AggregateError(
                    [error, recoveryError],
                    "cache object quarantine recovery failed",
                  );
                }
              }
              throw error;
            }
          },
          true,
        );
      },
      scanBudget,
      "evict",
    );
  }

  private async hasLiveLease(digest: string, scanBudget: CacheScanBudget): Promise<boolean> {
    const directory = join(this.layoutDirectory, "leases", digestHex(digest));
    let entries: Dirent[];
    try {
      await this.assertSafeAncestors(directory);
      entries = await readDirectoryBounded(directory, scanBudget);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isFile() || entry.name.startsWith(".")) continue;
      const lease = await this.readLease(join(directory, entry.name), digestHex(digest));
      const age = this.now().getTime() - Date.parse(lease.renewed_at);
      if (
        age <= this.leaseExpirySeconds * 1_000 ||
        (await this.isLeaseHolderAlive(lease, digestHex(digest)))
      ) {
        return true;
      }
    }
    return false;
  }

  private coordinationDirectory(): string {
    return join(this.layoutDirectory, "tmp", "coordination-v1");
  }

  private mutationLockDirectory(): string {
    return join(this.coordinationDirectory(), "locks");
  }

  private mutationLockDigestDirectory(digestHexValue: string): string {
    return join(this.mutationLockDirectory(), digestHexValue);
  }

  private processRegistrationDirectory(digestHexValue: string): string {
    return join(this.coordinationDirectory(), "processes", digestHexValue);
  }

  private processRegistrationPath(digestHexValue: string, processNonce: string): string {
    return join(this.processRegistrationDirectory(digestHexValue), `${processNonce}.json`);
  }

  private async startProcessRegistrationHeartbeat(
    digestHexValue: string,
  ): Promise<ProcessRegistrationHeartbeat> {
    let statePromise = this.processRegistrationStates.get(digestHexValue);
    if (statePromise === undefined) {
      statePromise = (async () => {
        const state: ProcessRegistrationState = {
          references: 0,
          identity: await this.writeProcessRegistration(digestHexValue),
          queue: Promise.resolve(),
          interval: undefined,
        };
        this.scheduleProcessRegistrationHeartbeat(digestHexValue, state);
        return state;
      })();
      this.processRegistrationStates.set(digestHexValue, statePromise);
    }
    let state: ProcessRegistrationState;
    try {
      state = await statePromise;
    } catch (error) {
      if (this.processRegistrationStates.get(digestHexValue) === statePromise) {
        this.processRegistrationStates.delete(digestHexValue);
      }
      throw error;
    }
    state.references += 1;
    let stopped = false;
    let stopResult: { final: boolean; identity?: Stats } | undefined;
    return {
      stop: async () => {
        if (stopped) return stopResult ?? { final: false };
        stopped = true;
        state.references -= 1;
        if (state.references > 0) {
          stopResult = { final: false };
          return stopResult;
        }
        if (state.interval !== undefined) clearInterval(state.interval);
        state.interval = undefined;
        await state.queue;
        if (state.references > 0) {
          this.scheduleProcessRegistrationHeartbeat(digestHexValue, state);
          stopResult = { final: false };
          return stopResult;
        }
        if (this.processRegistrationStates.get(digestHexValue) === statePromise) {
          this.processRegistrationStates.delete(digestHexValue);
        }
        stopResult = { final: true, identity: state.identity };
        return stopResult;
      },
    };
  }

  private scheduleProcessRegistrationHeartbeat(
    digestHexValue: string,
    state: ProcessRegistrationState,
  ): void {
    if (state.interval !== undefined) return;
    const intervalSeconds = Math.min(
      this.leaseExpirySeconds / 2,
      MAX_TIMER_DELAY_MILLISECONDS / 1_000,
    );
    state.interval = setInterval(() => {
      const pending = state.queue.then(async () => {
        state.identity = await this.writeProcessRegistration(digestHexValue);
      });
      state.queue = pending.then(
        () => undefined,
        () => undefined,
      );
      void pending.catch(this.onBackgroundError);
    }, intervalSeconds * 1_000);
    state.interval.unref();
  }

  private async writeProcessRegistration(digestHexValue: string): Promise<Stats> {
    const directory = this.processRegistrationDirectory(digestHexValue);
    const processIdentity =
      process.platform === "linux" ? await defaultProcessIdentity(this.pid) : undefined;
    const registration: StoredProcessRegistration = {
      schema: "remote-skills-cache-process-registration-v1",
      pid: this.pid,
      process_nonce: this.processNonce,
      ...(processIdentity === undefined ? {} : { process_identity: processIdentity }),
      renewed_at: this.now().toISOString(),
    };
    if (!isTimestamp(registration.renewed_at)) {
      throw new CacheCorruptError("cache process registration timestamp is invalid", {
        layout_version: CACHE_LAYOUT_NAMESPACE,
      });
    }
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        await this.ensureSafeDirectory(directory);
        return await withDirectoryChainsMutationGuard(
          this.directory,
          [directory],
          () => {},
          async () => {
            const destination = this.processRegistrationPath(digestHexValue, this.processNonce);
            const temporary = `${destination}.${randomUUID()}.tmp`;
            await writeSyncedFile(temporary, serializeJson(registration));
            try {
              await this.renameReplacingFile(temporary, destination);
              return await lstat(destination);
            } finally {
              await rm(temporary, { force: true });
            }
          },
        );
      } catch (error) {
        if (
          !["EINVAL", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "") ||
          attempt === 7
        )
          throw error;
      }
    }
    throw new CacheCorruptError("cache process registration could not be written", {
      layout_version: CACHE_LAYOUT_NAMESPACE,
    });
  }

  private async removeOwnRegistrationIfUnleased(
    digestHexValue: string,
    registrationIdentity?: Stats,
    scanBudget = new CacheScanBudget(this.maxScanEntries),
  ): Promise<void> {
    const leaseDirectory = join(this.layoutDirectory, "leases", digestHexValue);
    await this.assertSafeAncestors(leaseDirectory);
    const siblings = await readDirectoryBounded(leaseDirectory, scanBudget).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      },
    );
    if (siblings.some((entry) => entry.name.startsWith(`${this.processNonce}-`))) return;
    const registrationPath = this.processRegistrationPath(digestHexValue, this.processNonce);
    try {
      await withDirectoryChainsMutationGuard(
        this.directory,
        [dirname(registrationPath)],
        () => {},
        async () => {
          const expected =
            registrationIdentity ??
            (await readRegularFileSnapshotNoFollow(registrationPath, MAX_COORDINATION_RECORD_BYTES))
              .identity;
          await unlinkIfSameIdentity(registrationPath, expected);
        },
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await rmdir(this.mutationLockDigestDirectory(digestHexValue)).catch(
      (error: NodeJS.ErrnoException) => {
        if (!["ENOENT", "ENOTEMPTY"].includes(error.code ?? "")) throw error;
      },
    );
    for (const directory of [
      this.processRegistrationDirectory(digestHexValue),
      join(this.coordinationDirectory(), "processes"),
      this.mutationLockDirectory(),
      this.coordinationDirectory(),
    ]) {
      await rmdir(directory).catch((error: NodeJS.ErrnoException) => {
        if (!["ENOENT", "ENOTEMPTY"].includes(error.code ?? "")) throw error;
      });
    }
  }

  private async isRegisteredProcessAlive(
    pid: number,
    processNonce: string,
    digestHexValue: string,
  ): Promise<boolean> {
    if (this.hasInjectedProcessLiveness) {
      return this.isProcessAlive(pid, processNonce);
    }
    if (!(await this.isProcessAlive(pid, processNonce))) return false;
    try {
      await this.assertSafeAncestors(this.processRegistrationDirectory(digestHexValue));
      const registrationSnapshot = await readRegularFileSnapshotNoFollow(
        this.processRegistrationPath(digestHexValue, processNonce),
        MAX_COORDINATION_RECORD_BYTES,
      );
      const registration = parseStoredProcessRegistration(
        JSON.parse(decodeUtf8(registrationSnapshot.bytes)),
      );
      const expectedKeys = [
        "pid",
        "process_nonce",
        ...(registration.process_identity === undefined ? [] : ["process_identity"]),
        "renewed_at",
        "schema",
      ].sort();
      if (
        JSON.stringify(Object.keys(registration).sort()) !== JSON.stringify(expectedKeys) ||
        registration.schema !== "remote-skills-cache-process-registration-v1" ||
        registration.pid !== pid ||
        registration.process_nonce !== processNonce ||
        registration.pid <= 0 ||
        !isSafeNonce(registration.process_nonce) ||
        (registration.process_identity !== undefined &&
          (typeof registration.process_identity !== "string" ||
            registration.process_identity.length === 0 ||
            registration.process_identity.length > 128)) ||
        !isTimestamp(registration.renewed_at)
      ) {
        return false;
      }
      if (registration.process_identity !== undefined) {
        const currentIdentity = await defaultProcessIdentity(pid);
        if (currentIdentity !== undefined) {
          return (
            currentIdentity === registration.process_identity ||
            (await matchesLegacyNodeIdentityForLinuxProcess(
              registration.process_identity,
              pid,
              registrationSnapshot.identity,
              currentIdentity,
            ))
          );
        }
        const filesystemHeartbeatAge = Date.now() - registrationSnapshot.identity.mtimeMs;
        return (
          filesystemHeartbeatAge >= -FILESYSTEM_TIMESTAMP_SKEW_MILLISECONDS &&
          filesystemHeartbeatAge <= this.leaseExpirySeconds * 1_000
        );
      }
      const filesystemHeartbeatAge = Date.now() - registrationSnapshot.identity.mtimeMs;
      return (
        filesystemHeartbeatAge >= -FILESYSTEM_TIMESTAMP_SKEW_MILLISECONDS &&
        filesystemHeartbeatAge <= this.leaseExpirySeconds * 1_000
      );
    } catch {
      return false;
    }
  }

  private async isLeaseHolderAlive(lease: StoredLease, digestHexValue: string): Promise<boolean> {
    return this.isRegisteredProcessAlive(lease.pid, lease.process_nonce, digestHexValue);
  }

  private async writeEvictionMetadata(scanBudget: CacheScanBudget): Promise<void> {
    const value: StoredEvictionMetadata = {
      schema: "remote-skills-eviction-metadata-v1",
      last_run_at: this.now().toISOString(),
      max_bytes: this.maxBytes,
      max_age_seconds: this.maxAgeSeconds,
      candidate_order: ["accessed_at", "digest"],
    };
    const temporary = join(this.layoutDirectory, "tmp", `eviction-${randomUUID()}.json`);
    const destination = join(this.layoutDirectory, "eviction.json");
    await this.ensureSafeDirectory(dirname(temporary));
    await this.withDigestLock(
      EVICTION_METADATA_LOCK_DIGEST,
      async () => {
        let existing: StoredEvictionMetadata | undefined;
        try {
          const bytes = await readRegularFileNoFollow(destination, MAX_COORDINATION_RECORD_BYTES);
          const parsed: unknown = JSON.parse(decodeUtf8(bytes));
          if (!isStoredEvictionMetadata(parsed)) throw new CachePathChangedError();
          existing = parsed;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        if (
          existing !== undefined &&
          Date.parse(existing.last_run_at) >= Date.parse(value.last_run_at)
        ) {
          return;
        }
        await withDirectoryChainsMutationGuard(
          this.directory,
          [this.layoutDirectory, dirname(temporary)],
          () => {},
          async (verifyCommit) => {
            let temporaryIdentity: Stats | undefined;
            try {
              await verifyCommit();
              await writeSyncedFile(temporary, serializeJson(value));
              temporaryIdentity = await lstat(temporary);
              if (
                !temporaryIdentity.isFile() ||
                temporaryIdentity.isSymbolicLink() ||
                temporaryIdentity.nlink !== 1
              ) {
                throw new CachePathChangedError();
              }
              await verifyCommit();
              await this.renameReplacingFile(temporary, destination);
              const installed = await lstat(destination);
              if (!isSameIdentity(temporaryIdentity, installed)) {
                throw new CachePathChangedError();
              }
              await verifyCommit();
            } finally {
              if (temporaryIdentity !== undefined) {
                await verifyCommit();
                await unlinkIfSameIdentity(temporary, temporaryIdentity);
              }
            }
          },
          true,
        );
      },
      scanBudget,
    );
  }

  private async writeStagingFileExclusive(path: string, value: Uint8Array | string): Promise<void> {
    await withDirectoryChainsMutationGuard(
      this.directory,
      [dirname(path)],
      () => {},
      async (verifyCommit) => {
        await verifyCommit();
        await writeSyncedFile(path, value);
        await verifyCommit();
      },
    );
  }

  private async replaceStagingFile(path: string, value: Uint8Array | string): Promise<void> {
    await withDirectoryChainsMutationGuard(
      this.directory,
      [dirname(path)],
      () => {},
      async (verifyCommit) => {
        const existing = await lstat(path);
        if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1) {
          throw new CachePathChangedError();
        }
        const temporary = `${path}.${randomUUID()}.tmp`;
        await writeSyncedFile(temporary, value);
        try {
          const [current, replacement] = await Promise.all([lstat(path), lstat(temporary)]);
          if (
            !current.isFile() ||
            current.isSymbolicLink() ||
            !isSameIdentity(existing, current) ||
            !replacement.isFile() ||
            replacement.isSymbolicLink() ||
            replacement.nlink !== 1
          ) {
            throw new CachePathChangedError();
          }
          await verifyCommit();
          await this.renameFile(temporary, path);
          const installed = await lstat(path);
          if (
            !installed.isFile() ||
            installed.isSymbolicLink() ||
            !isSameIdentity(replacement, installed)
          ) {
            throw new CachePathChangedError();
          }
          await verifyCommit();
        } finally {
          await rm(temporary, { force: true });
        }
      },
    );
  }

  private async writeObjectMetadata(
    objectDirectory: string,
    metadata: StoredObjectMetadata,
  ): Promise<void> {
    const temporaryRoot = join(this.layoutDirectory, "tmp");
    await this.ensureSafeDirectory(temporaryRoot);
    await withDirectoryChainsMutationGuard(
      this.directory,
      [objectDirectory, temporaryRoot],
      () => {},
      async (verifyCommit) => {
        const destination = join(objectDirectory, "object.json");
        const current = parsedObject(
          JSON.parse(
            decodeUtf8(await readRegularFileNoFollow(destination, this.maxObjectMetadataBytes)),
          ),
          "current object metadata",
        );
        if (
          current.schema !== "remote-skills-object-metadata-v1" ||
          current.digest !== metadata.digest ||
          !isTimestamp(current.accessed_at)
        ) {
          throw this.corruptObject(metadata.digest);
        }
        if (Date.parse(current.accessed_at) > Date.parse(metadata.accessed_at)) {
          metadata.accessed_at = current.accessed_at;
        }
        const temporary = join(
          temporaryRoot,
          `object-access-${digestHex(metadata.digest)}-${randomUUID()}.tmp`,
        );
        await writeSyncedFile(temporary, serializeJson(metadata));
        try {
          await verifyCommit();
          await this.renameReplacingFile(temporary, destination);
          await verifyCommit();
        } finally {
          await rm(temporary, { force: true });
        }
      },
      true,
    );
  }

  private async renameReplacingFile(source: string, destination: string): Promise<void> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        await this.renameFile(source, destination);
        return;
      } catch (error) {
        if (!["EEXIST", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        if (attempt === 7) throw error;
        await delay(2);
      }
    }
  }
}

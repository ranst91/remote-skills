// @ts-check

import { createHash, randomUUID } from "node:crypto";
import type { BigIntStats, Dir } from "node:fs";
import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { link, lstat, mkdir, open, opendir, realpath, rename, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { invalidBuild, PublisherBuildError } from "./errors.ts";
import { syncDirectory } from "./output.ts";

const activeOutputs = new Set<string>();
const INTENT_SCHEMA = "remote-skills-publisher-writer-intent-v1";
const TICKET_SCHEMA = "remote-skills-publisher-writer-ticket-v1";
const WRITER_ROOT = path.join(tmpdir(), "remote-skills-publisher-v1");
const INTENT_NAME =
  /^(?<nonce>[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.intent$/u;
const TICKET_NAME =
  /^(?<ticket>[0-9]{16})-(?<nonce>[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.ticket$/u;
const WRITER_STAGING_NAME =
  /^\.record-(?<pid>[1-9][0-9]*)-(?<nonce>[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.pending$/u;
const MAX_WRITER_RECORDS = 10_000;
const MALFORMED_RECORD_STALE_MS = 30_000;
const ARTIFACT_NAME = /^sha256-(?<digest>[0-9a-f]{64})\.(?:md|tar\.gz|zip)$/u;
const ARTIFACT_URL = /^artifacts\/(?<name>sha256-(?<digest>[0-9a-f]{64})\.(?:md|tar\.gz|zip))$/u;
const INDEX_PENDING =
  /^\.remote-skills-index-(?<nonce>[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.pending$/u;
const ARTIFACT_PENDING =
  /^\.remote-skills-artifact-(?<name>sha256-[0-9a-f]{64}\.(?:md|tar\.gz|zip))-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.pending$/u;
const ORPHAN_QUARANTINE =
  /^\.remote-skills-orphan-(?<name>sha256-(?<digest>[0-9a-f]{64})\.(?:md|tar\.gz|zip))-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MAX_ARTIFACT_ENTRIES = 100_000;
const MAX_PENDING_LEAVES = 100;

/** @param {string} message @param {Record<string, unknown>} [context] */
function unsafeOutput(message: string, context: Record<string, unknown> = {}) {
  return new PublisherBuildError("archive_unsafe", message, context);
}

type DirectoryAnchor = {
  path: string;
  stats: import("node:fs").BigIntStats;
  generation?: import("node:fs").BigIntStats;
  handle: import("node:fs/promises").FileHandle | undefined;
  directory: import("node:fs").Dir | undefined;
};
type WriterRecord = {
  kind: "intent" | "ticket";
  name: string;
  path: string;
  nonce: string;
  ticket: number | undefined;
  pid: number | undefined;
  createdAtMs: number | undefined;
  malformed: boolean;
  stats: import("node:fs").BigIntStats;
  handle: import("node:fs/promises").FileHandle;
};

interface StableOutputState {
  outputDir: string;
  agentSkillsDir: string;
  artifactsDir: string;
  anchors: DirectoryAnchor[];
  writerTurn: Awaited<ReturnType<typeof acquireWriterTurn>>;
  previousArtifacts: Set<string>;
  catalogBytes: number;
  archiveBytes: number;
  publishedArtifacts: Map<string, BigIntStats>;
  committedIndexStats: BigIntStats | undefined;
  committedIndexBytes: Buffer | undefined;
}

/** @param {import("node:fs").BigIntStats} left @param {import("node:fs").BigIntStats} right */
function sameFile(left: import("node:fs").BigIntStats, right: import("node:fs").BigIntStats) {
  return left.isFile() && right.isFile() && left.dev === right.dev && left.ino === right.ino;
}

/** @param {import("node:fs").BigIntStats} left @param {import("node:fs").BigIntStats} right */
function sameFileGeneration(
  left: import("node:fs").BigIntStats,
  right: import("node:fs").BigIntStats,
) {
  return (
    sameFile(left, right) &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

/** @param {import("node:fs").BigIntStats} left @param {import("node:fs").BigIntStats} right */
function sameDirectoryIdentity(
  left: import("node:fs").BigIntStats,
  right: import("node:fs").BigIntStats,
) {
  return (
    left.isDirectory() &&
    right.isDirectory() &&
    !left.isSymbolicLink() &&
    !right.isSymbolicLink() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid
  );
}

/** @param {import("node:fs").BigIntStats} left @param {import("node:fs").BigIntStats} right */
function sameDirectoryGeneration(
  left: import("node:fs").BigIntStats,
  right: import("node:fs").BigIntStats,
) {
  return (
    sameDirectoryIdentity(left, right) &&
    left.ctimeNs === right.ctimeNs &&
    left.mtimeNs === right.mtimeNs
  );
}

/** @param {import("node:fs").BigIntStats} stats */
function ownedByCurrentUser(stats: import("node:fs").BigIntStats) {
  return typeof process.getuid !== "function" || stats.uid === BigInt(process.getuid());
}

/** @param {string} parent @param {string} child */
function isWithin(parent: string, child: string) {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}

/** @param {string} target */
async function optionalStats(target: string) {
  try {
    return await lstat(target, { bigint: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * Bind the canonical filesystem chain. Canonicalization is done once, then every component is
 * rejected if it is a link or ceases to name the same directory before publication.
 * @param {string} canonicalPath
 */
async function bindExistingDirectoryChain(canonicalPath: string): Promise<DirectoryAnchor[]> {
  const root = path.parse(canonicalPath).root;
  const relative = path.relative(root, canonicalPath);
  const components = relative === "" ? [] : relative.split(path.sep);
  const anchors: DirectoryAnchor[] = [];
  let current = root;
  try {
    for (const component of ["", ...components]) {
      if (component !== "") current = path.join(current, component);
      const stats = await lstat(current, { bigint: true });
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw unsafeOutput("output directory ancestors must be stable real directories", {
          field: "outDir",
        });
      }
      let handle: FileHandle | undefined;
      let directory: Dir | undefined;
      try {
        handle = await open(current, "r");
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            "code" in error &&
            ["EISDIR", "EPERM"].includes(String(error.code))
          )
        ) {
          throw error;
        }
        directory = await opendir(current);
      }
      anchors.push({ path: current, stats, handle, directory });
    }
    return anchors;
  } catch (error) {
    await closeAnchors(anchors);
    throw error;
  }
}

/** @param {DirectoryAnchor[]} anchors */
async function verifyAnchors(anchors: DirectoryAnchor[]) {
  for (const anchor of anchors) {
    let opened: BigIntStats | undefined;
    if (anchor.handle) {
      opened = await anchor.handle.stat({ bigint: true });
      if (!sameDirectoryIdentity(anchor.stats, opened)) {
        throw unsafeOutput("output directory ancestry changed during publication", {
          field: "outDir",
        });
      }
    }
    const current = await lstat(anchor.path, { bigint: true });
    if (
      !sameDirectoryIdentity(anchor.stats, current) ||
      (opened && !sameDirectoryIdentity(opened, current)) ||
      (anchor.generation &&
        (!sameDirectoryGeneration(anchor.generation, current) ||
          (opened && !sameDirectoryGeneration(anchor.generation, opened))))
    ) {
      throw unsafeOutput("output directory ancestry changed during publication", {
        field: "outDir",
      });
    }
  }
}

/** @param {DirectoryAnchor[]} anchors @param {string} generationRoot */
async function armAnchorGenerations(anchors: DirectoryAnchor[], generationRoot: string) {
  for (const anchor of anchors) {
    const opened = anchor.handle
      ? await anchor.handle.stat({ bigint: true })
      : await lstat(anchor.path, { bigint: true });
    const current = await lstat(anchor.path, { bigint: true });
    const trackGeneration = isWithin(generationRoot, anchor.path);
    if (
      !sameDirectoryIdentity(anchor.stats, opened) ||
      !sameDirectoryIdentity(opened, current) ||
      (trackGeneration && !sameDirectoryGeneration(opened, current))
    ) {
      throw unsafeOutput("output directory ancestry changed during publication", {
        field: "outDir",
      });
    }
    if (trackGeneration) anchor.generation = opened;
  }
}

/**
 * Accept the expected generation change of exactly one directory after checking every retained
 * parent and sibling. A failed check is never refreshed into trusted state.
 * @param {DirectoryAnchor[]} anchors
 * @param {string} mutablePath
 */
async function refreshDirectoryGeneration(anchors: DirectoryAnchor[], mutablePath: string) {
  let mutable: DirectoryAnchor | undefined;
  let nextGeneration: BigIntStats | undefined;
  for (const anchor of anchors) {
    const opened = anchor.handle
      ? await anchor.handle.stat({ bigint: true })
      : await lstat(anchor.path, { bigint: true });
    const current = await lstat(anchor.path, { bigint: true });
    if (
      !sameDirectoryIdentity(anchor.stats, opened) ||
      !sameDirectoryIdentity(opened, current) ||
      (anchor.generation && !sameDirectoryGeneration(opened, current))
    ) {
      throw unsafeOutput("output directory ancestry changed during publication", {
        field: "outDir",
      });
    }
    if (anchor.path === mutablePath) {
      mutable = anchor;
      nextGeneration = opened;
    } else if (anchor.generation && !sameDirectoryGeneration(anchor.generation, opened)) {
      throw unsafeOutput("output directory ancestry changed during publication", {
        field: "outDir",
      });
    }
  }
  if (!mutable || !nextGeneration) {
    throw unsafeOutput("publisher mutation escaped the retained output chain", {
      field: "outDir",
    });
  }
  mutable.generation = nextGeneration;
}

/** @param {string} directory @param {number} maximum */
async function boundedNames(directory: string, maximum: number) {
  const handle = await opendir(directory);
  const names = [];
  try {
    while (true) {
      const entry = await handle.read();
      if (entry === null) break;
      names.push(entry.name);
      if (names.length > maximum) {
        throw unsafeOutput("publisher output inventory exceeds safe bounds", { field: "outDir" });
      }
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
  names.sort();
  return names;
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** @param {unknown} value */
function artifactReference(value: unknown): string {
  if (!isRecord(value) || typeof value.url !== "string" || typeof value.digest !== "string") {
    throw unsafeOutput("publisher index contains a malformed artifact reference", {
      field: "outDir",
    });
  }
  const match = ARTIFACT_URL.exec(value.url);
  if (
    !match?.groups?.name ||
    !match.groups.digest ||
    value.digest !== `sha256:${match.groups.digest}`
  ) {
    throw unsafeOutput("publisher index artifact reference is not content-addressed", {
      field: "outDir",
    });
  }
  return match.groups.name;
}

/** @param {Uint8Array} bytes */
function indexArtifactReferences(bytes: Uint8Array) {
  let catalog: unknown;
  try {
    catalog = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw unsafeOutput("publisher index is not valid UTF-8 JSON", { field: "outDir" });
  }
  if (!isRecord(catalog) || !Array.isArray(catalog.skills)) {
    throw unsafeOutput("publisher index has an invalid catalog shape", { field: "outDir" });
  }
  const references = new Set<string>();
  for (const entry of catalog.skills) {
    references.add(artifactReference(entry));
    if (isRecord(entry) && Object.hasOwn(entry, "x-remote-skills")) {
      const extension = entry["x-remote-skills"];
      if (
        !isRecord(extension) ||
        !Array.isArray(extension.releases) ||
        extension.releases.length > 100
      ) {
        throw unsafeOutput("publisher index has invalid release history", { field: "outDir" });
      }
      for (const release of extension.releases) references.add(artifactReference(release));
    }
  }
  return references;
}

/** @param {string} target @param {number} maximum */
async function readBoundedRegularFile(target: string, maximum: number) {
  const noFollow = constants.O_NOFOLLOW ?? 0;
  let handle: FileHandle | undefined;
  try {
    handle = await open(target, constants.O_RDONLY | noFollow);
    const before = await handle.stat({ bigint: true });
    const size = Number(before.size);
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      !ownedByCurrentUser(before) ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      size > maximum
    ) {
      throw unsafeOutput("publisher index is not trusted bounded state", { field: "outDir" });
    }
    const bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) {
        throw unsafeOutput("publisher index changed while reading", { field: "outDir" });
      }
      offset += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const current = await lstat(target, { bigint: true });
    if (!sameFileGeneration(before, after) || !sameFileGeneration(after, current)) {
      throw unsafeOutput("publisher index changed while reading", { field: "outDir" });
    }
    return bytes;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ELOOP") {
      throw unsafeOutput("publisher index must not be a symlink", { field: "outDir" });
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Open and hash one builder-format artifact without following links or allocating its full body.
 * The returned handle remains open so the caller can bind a quarantine rename to this inode.
 * @param {string} target
 * @param {string} expectedDigest
 * @param {number} maximum
 */
async function verifyArtifactCandidate(target: string, expectedDigest: string, maximum: number) {
  const noFollow = constants.O_NOFOLLOW ?? 0;
  let handle: FileHandle | undefined;
  try {
    handle = await open(target, constants.O_RDONLY | noFollow);
    const before = await handle.stat({ bigint: true });
    const size = Number(before.size);
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      !ownedByCurrentUser(before) ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      size > maximum
    ) {
      throw unsafeOutput("orphan artifact is not trusted bounded builder state", {
        field: "outDir",
      });
    }
    const hash = createHash("sha256");
    const chunk = Buffer.alloc(Math.min(64 * 1024, Math.max(1, size)));
    let offset = 0;
    while (offset < size) {
      const length = Math.min(chunk.length, size - offset);
      const { bytesRead } = await handle.read(chunk, 0, length, offset);
      if (bytesRead === 0) {
        throw unsafeOutput("orphan artifact changed while hashing", { field: "outDir" });
      }
      hash.update(chunk.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const current = await lstat(target, { bigint: true });
    if (
      !sameFileGeneration(before, after) ||
      !sameFileGeneration(after, current) ||
      hash.digest("hex") !== expectedDigest
    ) {
      throw unsafeOutput("orphan artifact does not match its content address", {
        field: "outDir",
      });
    }
    return { handle, stats: after };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (error instanceof Error && "code" in error && error.code === "ELOOP") {
      throw unsafeOutput("orphan artifact must not be a symlink", { field: "outDir" });
    }
    throw error;
  }
}

/**
 * Remove one verified public artifact through a generation-unique quarantine pathname. The
 * public pathname is never unlinked directly, and the opened inode remains held through unlink.
 * @param {Awaited<ReturnType<typeof prepareStableOutput>>} state
 * @param {string} name
 * @param {string} digest
 */
async function quarantineAndUnlinkArtifact(
  state: Awaited<ReturnType<typeof prepareStableOutput>>,
  name: string,
  digest: string,
) {
  const source = path.join(state.artifactsDir, name);
  const verified = await verifyArtifactCandidate(source, digest, state.archiveBytes);
  const quarantineName = `.remote-skills-orphan-${name}-${randomUUID()}`;
  const quarantine = path.join(state.artifactsDir, quarantineName);
  try {
    await verifyAnchors(state.anchors);
    // Portable Node has no descriptor-relative conditional rename. A same-UID pivot after this
    // check is outside prevention scope; the generation refresh and final verification fail closed.
    await rename(source, quarantine);
    await syncDirectory(state.artifactsDir);
    await refreshDirectoryGeneration(state.anchors, state.artifactsDir);
    const moved = await lstat(quarantine, { bigint: true });
    const opened = await verified.handle.stat({ bigint: true });
    if (!sameFile(verified.stats, moved) || !sameFile(verified.stats, opened)) {
      throw unsafeOutput("orphan artifact identity changed during quarantine", {
        field: "outDir",
      });
    }
    const checked = await verifyArtifactCandidate(quarantine, digest, state.archiveBytes);
    try {
      await verifyAnchors(state.anchors);
      const current = await lstat(quarantine, { bigint: true });
      const held = await checked.handle.stat({ bigint: true });
      if (!sameFile(checked.stats, current) || !sameFile(checked.stats, held)) {
        throw unsafeOutput("orphan quarantine identity changed before unlink", {
          field: "outDir",
        });
      }
      // See the pathname-race boundary above; do not attempt unsafe rollback after a redirect.
      await unlink(quarantine);
      await syncDirectory(state.artifactsDir);
      await refreshDirectoryGeneration(state.anchors, state.artifactsDir);
    } finally {
      await checked.handle.close().catch(() => undefined);
    }
  } finally {
    await verified.handle.close().catch(() => undefined);
  }
}

/**
 * Reclaim only verified, unreferenced builder artifacts after the new index is durable. Current
 * and immediately previous index references are retained for old/new concurrent readers.
 * @param {Awaited<ReturnType<typeof prepareStableOutput>>} state
 * @param {Set<string>} retained
 */
async function reclaimUnreferencedArtifacts(
  state: Awaited<ReturnType<typeof prepareStableOutput>>,
  retained: Set<string>,
) {
  const names = await boundedNames(state.artifactsDir, MAX_ARTIFACT_ENTRIES);
  for (const name of names) {
    const artifact = ARTIFACT_NAME.exec(name);
    if (artifact?.groups) {
      const digest = artifact.groups.digest;
      if (!digest) {
        throw unsafeOutput("artifact filename is missing its digest", { field: "outDir" });
      }
      if (!retained.has(name)) {
        await quarantineAndUnlinkArtifact(state, name, digest);
      }
      continue;
    }
    const stranded = ORPHAN_QUARANTINE.exec(name);
    if (stranded?.groups) {
      const digest = stranded.groups.digest;
      if (!digest) {
        throw unsafeOutput("orphan quarantine filename is missing its digest", {
          field: "outDir",
        });
      }
      const target = path.join(state.artifactsDir, name);
      await verifyAnchors(state.anchors);
      const verified = await verifyArtifactCandidate(target, digest, state.archiveBytes);
      try {
        await verifyAnchors(state.anchors);
        const current = await lstat(target, { bigint: true });
        const held = await verified.handle.stat({ bigint: true });
        if (!sameFile(verified.stats, current) || !sameFile(verified.stats, held)) {
          throw unsafeOutput("orphan quarantine identity changed before recovery unlink", {
            field: "outDir",
          });
        }
        // Portable Node cannot bind this unlink to the retained handle atomically.
        await unlink(target);
        await syncDirectory(state.artifactsDir);
        await refreshDirectoryGeneration(state.anchors, state.artifactsDir);
      } finally {
        await verified.handle.close().catch(() => undefined);
      }
      continue;
    }
    throw unsafeOutput("artifact directory contains unknown unmanaged state", {
      field: "outDir",
    });
  }
  await syncDirectory(state.artifactsDir);
  await verifyAnchors(state.anchors);
}

/**
 * @param {DirectoryAnchor[]} anchors
 * @param {string} target
 */
async function bindOrCreateDirectory(anchors: DirectoryAnchor[], target: string) {
  const existing = await optionalStats(target);
  if (!existing) {
    try {
      await mkdir(target, { mode: 0o755 });
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
  }
  const stats = await lstat(target, { bigint: true });
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw unsafeOutput("output directory ancestors must be stable real directories", {
      field: "outDir",
    });
  }
  let handle: FileHandle | undefined;
  let directory: Dir | undefined;
  try {
    handle = await open(target, "r");
  } catch (error) {
    if (
      !(
        error instanceof Error &&
        "code" in error &&
        ["EISDIR", "EPERM"].includes(String(error.code))
      )
    ) {
      throw error;
    }
    directory = await opendir(target);
  }
  anchors.push({ path: target, stats, handle, directory });
}

/** @param {Awaited<ReturnType<typeof bindExistingDirectoryChain>>} anchors */
async function closeAnchors(anchors: DirectoryAnchor[]) {
  for (const anchor of [...anchors].reverse()) {
    await anchor.handle?.close().catch(() => undefined);
    await anchor.directory?.close().catch(() => undefined);
  }
}

/** @param {number} pid */
function processIsAlive(pid: number) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

/** @param {import("node:fs").BigIntStats} stats */
function isPrivateWriterDirectory(stats: import("node:fs").BigIntStats) {
  return (
    stats.isDirectory() &&
    !stats.isSymbolicLink() &&
    ownedByCurrentUser(stats) &&
    (typeof process.getuid !== "function" || (stats.mode & 0o077n) === 0n)
  );
}

/** @param {string} target */
async function bindPrivateWriterDirectory(target: string) {
  try {
    await mkdir(target, { mode: 0o700 });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  }
  const stats = await lstat(target, { bigint: true });
  if (!isPrivateWriterDirectory(stats)) {
    throw unsafeOutput("publisher writer coordination is not trusted private state", {
      field: "outDir",
    });
  }
  let handle: FileHandle | undefined;
  let directory: Dir | undefined;
  try {
    handle = await open(
      target,
      constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
    );
  } catch (error) {
    if (
      !(
        error instanceof Error &&
        "code" in error &&
        ["EISDIR", "EPERM"].includes(String(error.code))
      )
    ) {
      throw error;
    }
    directory = await opendir(target);
  }
  const anchor: DirectoryAnchor = { path: target, stats, handle, directory };
  try {
    await verifyAnchors([anchor]);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await directory?.close().catch(() => undefined);
    throw error;
  }
  return anchor;
}

/** @param {string} outputDir */
async function bindWriterCoordination(outputDir: string) {
  const root = await bindPrivateWriterDirectory(WRITER_ROOT);
  let directory: DirectoryAnchor | undefined;
  let staging: DirectoryAnchor | undefined;
  try {
    await verifyAnchors([root]);
    const key = createHash("sha256").update(outputDir, "utf8").digest("hex");
    directory = await bindPrivateWriterDirectory(path.join(WRITER_ROOT, key));
    staging = await bindPrivateWriterDirectory(path.join(directory.path, ".staging"));
    const state = {
      path: directory.path,
      stagingPath: staging.path,
      anchors: [root, directory, staging],
    };
    await verifyAnchors(state.anchors);
    return state;
  } catch (error) {
    await closeAnchors([staging, directory, root].filter((anchor) => anchor !== undefined));
    throw error;
  }
}

/** @param {Awaited<ReturnType<typeof bindWriterCoordination>>} state */
async function closeWriterCoordination(state: Awaited<ReturnType<typeof bindWriterCoordination>>) {
  await closeAnchors(state.anchors);
}

/**
 * Create one generation-unique writer record and retain its handle for exact-name cleanup.
 * @param {Awaited<ReturnType<typeof bindWriterCoordination>>} state
 * @param {string} name
 * @param {string} bytes
 */
async function createImmutableRecord(
  state: Awaited<ReturnType<typeof bindWriterCoordination>>,
  name: string,
  bytes: string,
) {
  await verifyAnchors(state.anchors);
  const target = path.join(state.path, name);
  const temporary = path.join(state.stagingPath, `.record-${process.pid}-${randomUUID()}.pending`);
  let handle = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  let published = false;
  let publishedRecord:
    | { path: string; name: string; handle: FileHandle; stats: BigIntStats }
    | undefined;
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    const privateStats = await handle.stat({ bigint: true });
    if (!privateStats.isFile() || privateStats.nlink !== 1n || !ownedByCurrentUser(privateStats)) {
      throw unsafeOutput("publisher writer record is not trusted private state", {
        field: "outDir",
      });
    }
    await handle.close();
    await verifyAnchors(state.anchors);
    try {
      await lstat(target);
      throw unsafeOutput("publisher writer record already exists", { field: "outDir" });
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    await rename(temporary, target);
    published = true;
    handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stats = await handle.stat({ bigint: true });
    const current = await lstat(target, { bigint: true });
    if (
      !stats.isFile() ||
      stats.nlink !== 1n ||
      !ownedByCurrentUser(stats) ||
      !sameFileGeneration(stats, current)
    ) {
      throw unsafeOutput("publisher writer record is not trusted private state", {
        field: "outDir",
      });
    }
    publishedRecord = { path: target, name, handle, stats };
    await syncDirectory(state.stagingPath);
    await syncDirectory(state.path);
    await verifyAnchors(state.anchors);
    return publishedRecord;
  } catch (error) {
    if (publishedRecord) {
      await removeWriterRecord(state, publishedRecord, "owned").catch(() => undefined);
    }
    await handle?.close().catch(() => undefined);
    if (!published) {
      await unlink(temporary).catch(() => undefined);
      await syncDirectory(state.stagingPath).catch(() => undefined);
    }
    throw error;
  }
}

/** @param {unknown} value @returns {value is number} */
function isCanonicalWriterInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * @param {Awaited<ReturnType<typeof bindWriterCoordination>>} state
 * @param {string} name
 * @param {RegExpExecArray & {groups?: Record<string, string>}} match
 * @param {"intent" | "ticket"} kind
 * @returns {Promise<WriterRecord | undefined>}
 */
async function openWriterRecord(
  state: Awaited<ReturnType<typeof bindWriterCoordination>>,
  name: string,
  match: RegExpExecArray & { groups?: Record<string, string> },
  kind: "intent" | "ticket",
): Promise<WriterRecord | undefined> {
  const target = path.join(state.path, name);
  let handle: FileHandle | undefined;
  try {
    handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = await handle.stat({ bigint: true });
    if (before.nlink === 0n) {
      await handle.close();
      handle = undefined;
      try {
        await lstat(target);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
          return undefined;
        }
        throw error;
      }
      throw unsafeOutput("publisher writer record changed while reading", {
        field: "outDir",
      });
    }
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      !ownedByCurrentUser(before) ||
      before.size > 1024n
    ) {
      throw unsafeOutput("publisher writer record is not trusted bounded state", {
        field: "outDir",
      });
    }
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) {
        throw unsafeOutput("publisher writer record changed while reading", {
          field: "outDir",
        });
      }
      offset += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const current = await lstat(target, { bigint: true });
    if (!sameFileGeneration(before, after) || !sameFileGeneration(after, current)) {
      throw unsafeOutput("publisher writer record changed while reading", {
        field: "outDir",
      });
    }
    const nonce = match.groups?.nonce ?? "";
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {}
    let valid = false;
    let ticket: number | undefined;
    let pid: number | undefined;
    let createdAtMs: number | undefined;
    if (
      isRecord(parsed) &&
      isCanonicalWriterInteger(parsed.pid) &&
      parsed.pid > 0 &&
      parsed.nonce === nonce &&
      isCanonicalWriterInteger(parsed.created_at_ms)
    ) {
      pid = parsed.pid;
      createdAtMs = parsed.created_at_ms;
      if (kind === "intent" && parsed.schema === INTENT_SCHEMA) {
        const canonical = `${JSON.stringify({
          schema: INTENT_SCHEMA,
          pid,
          nonce,
          created_at_ms: createdAtMs,
        })}\n`;
        valid = bytes.equals(Buffer.from(canonical, "utf8"));
      } else if (kind === "ticket" && parsed.schema === TICKET_SCHEMA) {
        ticket = Number(match.groups?.ticket);
        const canonical = `${JSON.stringify({
          schema: TICKET_SCHEMA,
          pid,
          nonce,
          ticket: parsed.ticket,
          created_at_ms: createdAtMs,
        })}\n`;
        valid =
          Number.isSafeInteger(ticket) &&
          ticket > 0 &&
          parsed.ticket === ticket &&
          isCanonicalWriterInteger(parsed.ticket) &&
          bytes.equals(Buffer.from(canonical, "utf8"));
      }
    }
    return {
      kind,
      name,
      path: target,
      nonce,
      ticket: valid ? ticket : undefined,
      pid: valid ? pid : undefined,
      createdAtMs: valid ? createdAtMs : undefined,
      malformed: !valid,
      stats: after,
      handle,
    };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    if (error instanceof Error && "code" in error && error.code === "ELOOP") {
      throw unsafeOutput("publisher writer record must not be a symlink", { field: "outDir" });
    }
    throw error;
  }
}

/** @param {WriterRecord | {path: string, name: string, handle: import("node:fs/promises").FileHandle, stats: import("node:fs").BigIntStats}} record */
async function closeWriterRecord(
  record:
    | WriterRecord
    | {
        path: string;
        name: string;
        handle: import("node:fs/promises").FileHandle;
        stats: import("node:fs").BigIntStats;
      },
) {
  await record.handle.close().catch(() => undefined);
}

/**
 * Remove only this immutable generation-unique name after a final retained-handle check.
 * @param {Awaited<ReturnType<typeof bindWriterCoordination>>} state
 * @param {WriterRecord | {path: string, name: string, handle: import("node:fs/promises").FileHandle, stats: import("node:fs").BigIntStats}} record
 * @param {"dead" | "malformed" | "owned"} reason
 */
async function removeWriterRecord(
  state: Awaited<ReturnType<typeof bindWriterCoordination>>,
  record:
    | WriterRecord
    | {
        path: string;
        name: string;
        handle: import("node:fs/promises").FileHandle;
        stats: import("node:fs").BigIntStats;
      },
  reason: "dead" | "malformed" | "owned",
) {
  await verifyAnchors(state.anchors);
  const held = await record.handle.stat({ bigint: true });
  if (!sameFileGeneration(record.stats, held)) {
    throw unsafeOutput("publisher writer record identity changed before cleanup", {
      field: "outDir",
    });
  }
  let current: BigIntStats;
  try {
    current = await lstat(record.path, { bigint: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
  if (!sameFileGeneration(record.stats, current)) {
    throw unsafeOutput("publisher writer record identity changed before cleanup", {
      field: "outDir",
    });
  }
  if (
    reason === "dead" &&
    "pid" in record &&
    record.pid !== undefined &&
    processIsAlive(record.pid)
  ) {
    return false;
  }
  if (
    reason === "malformed" &&
    BigInt(Date.now()) * 1_000_000n - current.mtimeNs <=
      BigInt(MALFORMED_RECORD_STALE_MS) * 1_000_000n
  ) {
    return false;
  }
  await verifyAnchors(state.anchors);
  await unlink(record.path);
  const stillHeld = await record.handle.stat({ bigint: true });
  if (!sameFile(record.stats, stillHeld)) {
    throw unsafeOutput("publisher writer record identity changed during cleanup", {
      field: "outDir",
    });
  }
  await syncDirectory(state.path);
  await verifyAnchors(state.anchors);
  return true;
}

/** @param {WriterRecord[]} records */
async function closeWriterRecords(records: WriterRecord[]) {
  await Promise.all(records.map((record) => closeWriterRecord(record)));
}

/** @param {Awaited<ReturnType<typeof bindWriterCoordination>>} state */
async function scanWriterStaging(state: Awaited<ReturnType<typeof bindWriterCoordination>>) {
  const names = await boundedNames(state.stagingPath, MAX_WRITER_RECORDS);
  let blocked = false;
  for (const name of names) {
    const match = WRITER_STAGING_NAME.exec(name);
    if (!match?.groups) {
      throw unsafeOutput("publisher writer staging contains unknown state", {
        field: "outDir",
      });
    }
    const pid = Number(match.groups.pid);
    if (!Number.isSafeInteger(pid)) {
      throw unsafeOutput("publisher writer staging contains malformed state", {
        field: "outDir",
      });
    }
    const target = path.join(state.stagingPath, name);
    let handle: FileHandle | undefined;
    try {
      try {
        handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
        throw error;
      }
      const before = await handle.stat({ bigint: true });
      if (
        !before.isFile() ||
        before.nlink !== 1n ||
        !ownedByCurrentUser(before) ||
        before.size > 1024n
      ) {
        throw unsafeOutput("publisher writer staging is not trusted bounded state", {
          field: "outDir",
        });
      }
      let current: BigIntStats;
      try {
        current = await lstat(target, { bigint: true });
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
        throw error;
      }
      // Pending bytes are mutable until publication; their identity and bounds are not.
      if (
        !sameFile(before, current) ||
        before.mode !== current.mode ||
        before.uid !== current.uid ||
        before.gid !== current.gid ||
        before.nlink !== current.nlink ||
        current.size > 1024n
      ) {
        throw unsafeOutput("publisher writer staging changed while scanning", {
          field: "outDir",
        });
      }
      const stale =
        BigInt(Date.now()) * 1_000_000n - current.mtimeNs >
        BigInt(MALFORMED_RECORD_STALE_MS) * 1_000_000n;
      if (processIsAlive(pid) || !stale) {
        blocked = true;
        continue;
      }
      if (!sameFileGeneration(before, current)) {
        throw unsafeOutput("publisher writer staging changed before cleanup", {
          field: "outDir",
        });
      }
      await verifyAnchors(state.anchors);
      const held = await handle.stat({ bigint: true });
      const exact = await lstat(target, { bigint: true });
      if (!sameFileGeneration(before, held) || !sameFileGeneration(held, exact)) {
        throw unsafeOutput("publisher writer staging changed before cleanup", {
          field: "outDir",
        });
      }
      await unlink(target);
      const stillHeld = await handle.stat({ bigint: true });
      if (!sameFile(before, stillHeld)) {
        throw unsafeOutput("publisher writer staging changed during cleanup", {
          field: "outDir",
        });
      }
      await syncDirectory(state.stagingPath);
      await verifyAnchors(state.anchors);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ELOOP") {
        throw unsafeOutput("publisher writer staging must not be a symlink", {
          field: "outDir",
        });
      }
      throw error;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
  return blocked;
}

/** @param {Awaited<ReturnType<typeof bindWriterCoordination>>} state */
async function scanWriterRecords(state: Awaited<ReturnType<typeof bindWriterCoordination>>) {
  await verifyAnchors(state.anchors);
  const stagingBlocked = await scanWriterStaging(state);
  const names = await boundedNames(state.path, MAX_WRITER_RECORDS);
  /** @type {WriterRecord[]} */
  const opened: WriterRecord[] = [];
  /** @type {WriterRecord[]} */
  const intents: WriterRecord[] = [];
  /** @type {WriterRecord[]} */
  const tickets: WriterRecord[] = [];
  /** @type {WriterRecord[]} */
  const blockers: WriterRecord[] = [];
  try {
    for (const name of names) {
      if (name === ".staging") continue;
      const intent = INTENT_NAME.exec(name);
      const ticket = TICKET_NAME.exec(name);
      if (!intent && !ticket) {
        throw unsafeOutput("publisher writer coordination contains unknown state", {
          field: "outDir",
        });
      }
      const match = intent ?? ticket;
      if (!match) {
        throw unsafeOutput("publisher writer record name is invalid", { field: "outDir" });
      }
      const record = await openWriterRecord(state, name, match, intent ? "intent" : "ticket");
      if (!record) continue;
      opened.push(record);
      if (record.malformed) {
        const removed = await removeWriterRecord(state, record, "malformed");
        if (!removed) blockers.push(record);
      } else if (record.pid === undefined || !processIsAlive(record.pid)) {
        await removeWriterRecord(state, record, "dead");
      } else if (record.kind === "intent") {
        intents.push(record);
      } else {
        tickets.push(record);
      }
    }
    return { intents, tickets, blockers, stagingBlocked, opened };
  } catch (error) {
    await closeWriterRecords(opened);
    throw error;
  }
}

/** @param {Awaited<ReturnType<typeof scanWriterRecords>>} snapshot */
async function closeWriterSnapshot(snapshot: Awaited<ReturnType<typeof scanWriterRecords>>) {
  await closeWriterRecords(snapshot.opened);
}

/** @param {string} outputDir */
async function acquireWriterTurn(outputDir: string) {
  const state = await bindWriterCoordination(outputDir);
  const nonce = randomUUID();
  const createdAtMs = Date.now();
  const started = createdAtMs;
  let intent: { path: string; name: string; handle: FileHandle; stats: BigIntStats } | undefined;
  let ticketRecord:
    | { path: string; name: string; handle: FileHandle; stats: BigIntStats }
    | undefined;
  let acquired = false;
  try {
    const intentName = `${nonce}.intent`;
    intent = await createImmutableRecord(
      state,
      intentName,
      `${JSON.stringify({
        schema: INTENT_SCHEMA,
        pid: process.pid,
        nonce,
        created_at_ms: createdAtMs,
      })}\n`,
    );
    const initial = await scanWriterRecords(state);
    let ticket: number;
    try {
      ticket = Math.max(0, ...initial.tickets.map((record) => record.ticket ?? 0)) + 1;
    } finally {
      await closeWriterSnapshot(initial);
    }
    if (!Number.isSafeInteger(ticket)) {
      throw unsafeOutput("publisher writer ticket exceeds safe bounds", { field: "outDir" });
    }
    const ticketName = `${String(ticket).padStart(16, "0")}-${nonce}.ticket`;
    ticketRecord = await createImmutableRecord(
      state,
      ticketName,
      `${JSON.stringify({
        schema: TICKET_SCHEMA,
        pid: process.pid,
        nonce,
        ticket,
        created_at_ms: createdAtMs,
      })}\n`,
    );

    while (true) {
      const snapshot = await scanWriterRecords(state);
      let mayEnter: boolean;
      try {
        const ticketsByNonce = new Map(snapshot.tickets.map((record) => [record.nonce, record]));
        const unresolvedIntent = snapshot.intents.find(
          (candidate) => candidate.nonce !== nonce && !ticketsByNonce.has(candidate.nonce),
        );
        const predecessor = snapshot.tickets.find(
          (candidate) =>
            candidate.nonce !== nonce &&
            ((candidate.ticket ?? 0) < ticket ||
              (candidate.ticket === ticket && candidate.nonce < nonce)),
        );
        mayEnter =
          !unresolvedIntent &&
          !predecessor &&
          snapshot.blockers.length === 0 &&
          !snapshot.stagingBlocked;
      } finally {
        await closeWriterSnapshot(snapshot);
      }
      if (mayEnter) break;
      if (Date.now() - started > 10_000) {
        throw unsafeOutput("another publisher build is active for this output", {
          field: "outDir",
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    acquired = true;
    return { state, nonce, ticket, intent, ticketRecord };
  } finally {
    if (!acquired) {
      if (ticketRecord) {
        await removeWriterRecord(state, ticketRecord, "owned").catch(() => undefined);
        await closeWriterRecord(ticketRecord);
      }
      if (intent) {
        await removeWriterRecord(state, intent, "owned").catch(() => undefined);
        await closeWriterRecord(intent);
      }
      await closeWriterCoordination(state);
    }
  }
}

/** @param {Awaited<ReturnType<typeof acquireWriterTurn>>} turn */
async function releaseWriterTurn(turn: Awaited<ReturnType<typeof acquireWriterTurn>>) {
  try {
    await removeWriterRecord(turn.state, turn.ticketRecord, "owned");
    await removeWriterRecord(turn.state, turn.intent, "owned");
  } finally {
    await closeWriterRecord(turn.ticketRecord);
    await closeWriterRecord(turn.intent);
    await closeWriterCoordination(turn.state);
  }
}

/**
 * @param {string} projectDir
 * @param {string} relativeOutput
 * @param {{catalogBytes: number, archiveBytes: number}} limits
 */
export async function prepareStableOutput(
  projectDir: string,
  relativeOutput: string,
  limits: { catalogBytes: number; archiveBytes: number },
): Promise<StableOutputState> {
  try {
    const requested = path.resolve(projectDir);
    const requestedStats = await lstat(requested, { bigint: true });
    if (!requestedStats.isDirectory() || requestedStats.isSymbolicLink()) {
      throw unsafeOutput("project directory must be a stable real directory", {
        field: "projectDir",
      });
    }
    const canonicalProject = await realpath(requested);
    const outputDir = path.resolve(canonicalProject, relativeOutput);
    if (!isWithin(canonicalProject, outputDir) || outputDir === canonicalProject) {
      throw invalidBuild("output directory must remain below the project", { field: "outDir" });
    }
    if (activeOutputs.has(outputDir)) {
      throw invalidBuild("another publisher build is active for this output", { field: "outDir" });
    }
    activeOutputs.add(outputDir);
    /** @type {DirectoryAnchor[]} */
    let anchors: DirectoryAnchor[] = [];
    let writerTurn: Awaited<ReturnType<typeof acquireWriterTurn>> | undefined;
    try {
      anchors = await bindExistingDirectoryChain(canonicalProject);
      let current = canonicalProject;
      const outputRelative = path.relative(canonicalProject, outputDir);
      for (const component of outputRelative.split(path.sep)) {
        current = path.join(current, component);
        await bindOrCreateDirectory(anchors, current);
      }
      const existingOutputNames = await boundedNames(outputDir, 2);
      if (existingOutputNames.some((name) => name !== ".well-known")) {
        throw unsafeOutput("existing output is not a stable publisher generation", {
          field: "outDir",
        });
      }
      for (const component of [".well-known", "agent-skills", "artifacts"]) {
        current = path.join(current, component);
        await bindOrCreateDirectory(anchors, current);
      }
      await verifyAnchors(anchors);
      writerTurn = await acquireWriterTurn(outputDir);
      await armAnchorGenerations(anchors, canonicalProject);
      await verifyAnchors(anchors);
      const indexPath = path.join(path.dirname(current), "index.json");
      const previousArtifacts: Set<string> = (await optionalStats(indexPath))
        ? indexArtifactReferences(await readBoundedRegularFile(indexPath, limits.catalogBytes))
        : new Set<string>();
      await verifyAnchors(anchors);
      return {
        outputDir,
        agentSkillsDir: path.dirname(current),
        artifactsDir: current,
        anchors,
        writerTurn,
        previousArtifacts,
        catalogBytes: limits.catalogBytes,
        archiveBytes: limits.archiveBytes,
        publishedArtifacts: new Map<string, BigIntStats>(),
        committedIndexStats: undefined,
        committedIndexBytes: undefined,
      };
    } catch (error) {
      if (writerTurn) await releaseWriterTurn(writerTurn).catch(() => undefined);
      await closeAnchors(anchors);
      activeOutputs.delete(outputDir);
      throw error;
    }
  } catch (error) {
    if (error instanceof PublisherBuildError && error.code === "archive_unsafe") throw error;
    throw new PublisherBuildError(
      "archive_unsafe",
      "publisher output could not be anchored safely",
      { field: "outDir" },
    );
  }
}

/** @param {import("node:fs/promises").FileHandle} handle @param {Uint8Array} bytes */
async function writeAll(handle: import("node:fs/promises").FileHandle, bytes: Uint8Array) {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset, offset);
    if (bytesWritten === 0) {
      throw unsafeOutput("publisher file could not be written safely", { field: "outDir" });
    }
    offset += bytesWritten;
  }
}

/**
 * @param {Awaited<ReturnType<typeof prepareStableOutput>>} state
 * @param {string} filename
 * @param {string} digest
 */
async function acceptArtifact(
  state: Awaited<ReturnType<typeof prepareStableOutput>>,
  filename: string,
  digest: string,
) {
  await verifyAnchors(state.anchors);
  const verified = await verifyArtifactCandidate(
    path.join(state.artifactsDir, filename),
    digest,
    state.archiveBytes,
  );
  try {
    await verifyAnchors(state.anchors);
    state.publishedArtifacts.set(filename, verified.stats);
  } finally {
    await verified.handle.close().catch(() => undefined);
  }
}

/** @param {Awaited<ReturnType<typeof prepareStableOutput>>} state @param {string} filename @param {Uint8Array} bytes */
export async function publishArtifact(
  state: Awaited<ReturnType<typeof prepareStableOutput>>,
  filename: string,
  bytes: Uint8Array,
) {
  const match = ARTIFACT_NAME.exec(filename);
  const digest = match?.groups?.digest;
  if (!digest || bytes.byteLength > state.archiveBytes) {
    throw unsafeOutput("publisher artifact is not bounded content-addressed state", {
      field: "outDir",
    });
  }
  const actualDigest = createHash("sha256").update(bytes).digest("hex");
  if (actualDigest !== digest) {
    throw unsafeOutput("publisher artifact bytes do not match their content address", {
      field: "outDir",
    });
  }
  const destination = path.join(state.artifactsDir, filename);
  await recoverPendingLeaves(state);
  if (await optionalStats(destination)) {
    await acceptArtifact(state, filename, digest);
    return;
  }

  const pendingPath = path.join(
    state.agentSkillsDir,
    `.remote-skills-artifact-${filename}-${randomUUID()}.pending`,
  );
  let handle: FileHandle | undefined;
  try {
    await verifyAnchors(state.anchors);
    // The exclusive unique leaf owns incomplete bytes until the complete artifact is durable.
    handle = await open(
      pendingPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    await writeAll(handle, bytes);
    await handle.chmod(0o644);
    await handle.sync();
    const held = await handle.stat({ bigint: true });
    const current = await lstat(pendingPath, { bigint: true });
    if (
      !held.isFile() ||
      held.nlink !== 1n ||
      !ownedByCurrentUser(held) ||
      !sameFileGeneration(held, current)
    ) {
      throw unsafeOutput("publisher artifact identity changed while creating it", {
        field: "outDir",
      });
    }
    await syncDirectory(state.agentSkillsDir);
    await refreshDirectoryGeneration(state.anchors, state.agentSkillsDir);
    await verifyAnchors(state.anchors);
    // Same-filesystem link publication is atomic and fails if the immutable destination exists.
    // Portable Node still needs the post-checks to detect pathname ancestry changes.
    try {
      await link(pendingPath, destination);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
    await syncDirectory(state.artifactsDir);
    await refreshDirectoryGeneration(state.anchors, state.artifactsDir);
    await reclaimPendingLeaf(state, path.basename(pendingPath));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ELOOP") {
      throw unsafeOutput("publisher artifact must not be a symlink", { field: "outDir" });
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
  await acceptArtifact(state, filename, digest);
}

/**
 * @param {Awaited<ReturnType<typeof prepareStableOutput>>} state
 * @param {string} name
 */
async function reclaimPendingLeaf(
  state: Awaited<ReturnType<typeof prepareStableOutput>>,
  name: string,
) {
  const target = path.join(state.agentSkillsDir, name);
  const artifactName = ARTIFACT_PENDING.exec(name)?.groups?.name;
  const maximumBytes = artifactName ? state.archiveBytes : state.catalogBytes;
  let handle: FileHandle | undefined;
  try {
    handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      (before.nlink !== 1n && !(artifactName && before.nlink === 2n)) ||
      !ownedByCurrentUser(before) ||
      before.size > BigInt(maximumBytes)
    ) {
      throw unsafeOutput("publisher pending leaf is not trusted bounded state", {
        field: "outDir",
      });
    }
    const current = await lstat(target, { bigint: true });
    if (!sameFileGeneration(before, current)) {
      throw unsafeOutput("publisher pending leaf changed before recovery", {
        field: "outDir",
      });
    }
    await verifyAnchors(state.anchors);
    const held = await handle.stat({ bigint: true });
    const finalPath = await lstat(target, { bigint: true });
    if (!sameFileGeneration(before, held) || !sameFileGeneration(before, finalPath)) {
      throw unsafeOutput("publisher pending leaf changed before recovery", {
        field: "outDir",
      });
    }
    if (artifactName && before.nlink === 2n) {
      // A crash after publication can leave exactly the staging and final names linked.
      // Never reclaim a multiply-linked leaf unless its other publisher name is the same inode.
      const published = await lstat(path.join(state.artifactsDir, artifactName), { bigint: true });
      if (!sameFileGeneration(before, published)) {
        throw unsafeOutput("publisher artifact pending leaf has an unverified link", {
          field: "outDir",
        });
      }
    }
    // Exact unique name plus retained inode checks bound recovery; no conditional unlink exists.
    await unlink(target);
    const unlinked = await handle.stat({ bigint: true });
    if (!sameFile(before, unlinked)) {
      throw unsafeOutput("publisher pending leaf changed during recovery", {
        field: "outDir",
      });
    }
    await syncDirectory(state.agentSkillsDir);
    await refreshDirectoryGeneration(state.anchors, state.agentSkillsDir);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ELOOP") {
      throw unsafeOutput("publisher pending leaf must not be a symlink", {
        field: "outDir",
      });
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** @param {Awaited<ReturnType<typeof prepareStableOutput>>} state */
async function recoverPendingLeaves(state: Awaited<ReturnType<typeof prepareStableOutput>>) {
  const names = await boundedNames(state.agentSkillsDir, MAX_PENDING_LEAVES + 2);
  for (const name of names) {
    if (name === "artifacts" || name === "index.json") continue;
    if (!INDEX_PENDING.test(name) && !ARTIFACT_PENDING.test(name)) {
      throw unsafeOutput("publisher output contains unknown pending state", { field: "outDir" });
    }
    await reclaimPendingLeaf(state, name);
  }
}

/** @param {Awaited<ReturnType<typeof prepareStableOutput>>} state @param {Uint8Array} bytes */
async function publishIndex(
  state: Awaited<ReturnType<typeof prepareStableOutput>>,
  bytes: Uint8Array,
) {
  if (bytes.byteLength > state.catalogBytes) {
    throw unsafeOutput("publisher index exceeds its configured bound", { field: "outDir" });
  }
  await recoverPendingLeaves(state);
  const pendingPath = path.join(
    state.agentSkillsDir,
    `.remote-skills-index-${randomUUID()}.pending`,
  );
  const destination = path.join(state.agentSkillsDir, "index.json");
  let handle: FileHandle | undefined;
  try {
    await verifyAnchors(state.anchors);
    // The generation-unique exclusive leaf cannot overwrite another publisher's staging inode.
    handle = await open(
      pendingPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    await writeAll(handle, bytes);
    await handle.chmod(0o644);
    await handle.sync();
    const staged = await handle.stat({ bigint: true });
    const current = await lstat(pendingPath, { bigint: true });
    if (
      !staged.isFile() ||
      staged.nlink !== 1n ||
      !ownedByCurrentUser(staged) ||
      !sameFileGeneration(staged, current)
    ) {
      throw unsafeOutput("publisher index pending leaf changed while writing", {
        field: "outDir",
      });
    }
    await syncDirectory(state.agentSkillsDir);
    await refreshDirectoryGeneration(state.anchors, state.agentSkillsDir);
    if (await optionalStats(destination)) {
      await readBoundedRegularFile(destination, state.catalogBytes);
    }
    await verifyAnchors(state.anchors);
    // Atomic fixed-index visibility is pathname-based in portable Node. A same-UID redirect after
    // this check is detected by the refresh/final generation check and is not rolled back.
    await rename(pendingPath, destination);
    await syncDirectory(state.agentSkillsDir);
    await refreshDirectoryGeneration(state.anchors, state.agentSkillsDir);
    const committed = await lstat(destination, { bigint: true });
    const held = await handle.stat({ bigint: true });
    if (
      !sameFile(staged, committed) ||
      !sameFile(committed, held) ||
      committed.nlink !== 1n ||
      !ownedByCurrentUser(committed) ||
      committed.size !== BigInt(bytes.byteLength)
    ) {
      throw unsafeOutput("published index identity changed during commit", { field: "outDir" });
    }
    state.committedIndexStats = committed;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ELOOP") {
      throw unsafeOutput("publisher index pending leaf must not be a symlink", {
        field: "outDir",
      });
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * @param {Awaited<ReturnType<typeof prepareStableOutput>>} state
 * @param {Uint8Array} indexBytes
 */
async function verifyCommittedGeneration(
  state: Awaited<ReturnType<typeof prepareStableOutput>>,
  indexBytes: Uint8Array,
) {
  await verifyAnchors(state.anchors);
  const indexPath = path.join(state.agentSkillsDir, "index.json");
  const committed = await readBoundedRegularFile(indexPath, state.catalogBytes);
  const committedStats = await lstat(indexPath, { bigint: true });
  if (
    !committed.equals(indexBytes) ||
    !state.committedIndexStats ||
    !sameFileGeneration(state.committedIndexStats, committedStats)
  ) {
    throw unsafeOutput("published index does not match the built generation", {
      field: "outDir",
    });
  }
  for (const name of indexArtifactReferences(indexBytes)) {
    const match = ARTIFACT_NAME.exec(name);
    const digest = match?.groups?.digest;
    const expected = state.publishedArtifacts.get(name);
    if (!digest || !expected) {
      throw unsafeOutput("published artifact name is invalid", { field: "outDir" });
    }
    const verified = await verifyArtifactCandidate(
      path.join(state.artifactsDir, name),
      digest,
      state.archiveBytes,
    );
    try {
      if (!sameFileGeneration(expected, verified.stats)) {
        throw unsafeOutput("published artifact generation changed before verification", {
          field: "outDir",
        });
      }
    } finally {
      await verified.handle.close().catch(() => undefined);
    }
  }
  await verifyAnchors(state.anchors);
}

/** @param {Awaited<ReturnType<typeof prepareStableOutput>>} state @param {Uint8Array} bytes */
export async function commitIndex(
  state: Awaited<ReturnType<typeof prepareStableOutput>>,
  bytes: Uint8Array,
) {
  const wellKnown = path.dirname(state.agentSkillsDir);
  const outputDir = path.dirname(wellKnown);
  const outputNames = await boundedNames(outputDir, 2);
  const wellKnownNames = await boundedNames(wellKnown, 1);
  if (
    outputNames.some((name) => name !== ".well-known") ||
    JSON.stringify(wellKnownNames) !== JSON.stringify(["agent-skills"])
  ) {
    throw new PublisherBuildError(
      "archive_unsafe",
      "publisher output contains entries outside its stable publication layout",
      { field: "outDir" },
    );
  }
  await publishIndex(state, bytes);
  const retained = indexArtifactReferences(bytes);
  for (const name of state.previousArtifacts) retained.add(name);
  await reclaimUnreferencedArtifacts(state, retained);
  await verifyCommittedGeneration(state, bytes);
  state.committedIndexBytes = Buffer.from(bytes);
}

/** @param {Awaited<ReturnType<typeof prepareStableOutput>>} state */
export async function releaseStableOutput(state: Awaited<ReturnType<typeof prepareStableOutput>>) {
  try {
    if (state.committedIndexBytes) {
      await verifyCommittedGeneration(state, state.committedIndexBytes);
    }
  } finally {
    try {
      await releaseWriterTurn(state.writerTurn);
    } finally {
      await closeAnchors(state.anchors);
      activeOutputs.delete(state.outputDir);
    }
  }
}

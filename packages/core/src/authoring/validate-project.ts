// @ts-check

import type { BigIntStats, Dir } from "node:fs";
import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import path from "node:path";

import { fromMarkdown } from "mdast-util-from-markdown";

import { DEFAULT_CONFIG } from "../config-schema.ts";
import { authoringDiagnostic } from "./diagnostics.ts";
import { validateSkillMarkdown } from "./frontmatter.ts";
import { createSkillIgnorePolicy, ignoredByDefaults } from "./inclusion.ts";
import {
  INVALID_CONFIG_PATH,
  isProjectRelativePath,
  normalizePortableRelativePath,
} from "./paths.ts";

export { DEFAULT_EXCLUSIONS } from "./inclusion.ts";
const MIN_TRAVERSAL_ENTRIES = 1_024;
const MAX_TRAVERSAL_ENTRIES = 10_000;

export type AuthoringConfig = {
  sourceRoots?: string[];
  strict?: boolean;
  limits?: {
    files?: number;
    fileBytes?: number;
    extractedBytes?: number;
  };
};

type MarkdownNode = { type: string; url?: string; identifier?: string; children?: MarkdownNode[] };
type MarkdownTargetsResult =
  | { kind: "invalid" }
  | { kind: "limit" }
  | { kind: "targets"; targets: string[] };
type VerifiedFileResult =
  | { kind: "file"; bytes: Buffer; size: number; snapshot: RetainedFile }
  | { kind: "missing" }
  | { kind: "limit"; limit: string }
  | { kind: "hardlink" }
  | { kind: "special" }
  | { kind: "symlink" }
  | { kind: "unsafe" };
type DirectoryReadResult =
  | { kind: "entries"; entries: import("node:fs").Dirent[] }
  | { kind: "limit" }
  | { kind: "unsafe" };
type DirectoryIdentity = { stats: import("node:fs").BigIntStats; resolved: string };
type DirectorySnapshot = DirectoryIdentity & {
  absolutePath: string;
  realBoundary: string;
  diagnosticPath: string;
  skillName?: string;
  identityOnly?: boolean;
  handle: import("node:fs").Dir;
};
type RetainedFile = {
  absolutePath: string;
  stats: import("node:fs").BigIntStats;
  handle: import("node:fs/promises").FileHandle;
};
type FileSnapshot = RetainedFile & {
  diagnosticPath: string;
  skillName?: string;
};
type AuthoringProjectSnapshot = {
  requestedProjectDir: string;
  projectDir: string;
  projectPathSnapshots: DirectorySnapshot[];
  directoryHandles: import("node:fs").Dir[];
  fileHandles: import("node:fs/promises").FileHandle[];
  fileSnapshots: FileSnapshot[];
  missingFileSnapshots: string[];
  closed: boolean;
};

const INVALID_LOCAL_REFERENCE = "[invalid-local-reference]";
const MARKDOWN_NODE_LIMIT = 10_000;

function projectPathChangedDiagnostic() {
  return authoringDiagnostic(
    "error",
    "archive_unsafe",
    "project directory path changed during validation",
    { path: "." },
  );
}

/** @param {string} value */
function toPosix(value: string) {
  return value.split(path.sep).join("/");
}

/** @param {string} value */
function logicalLineCount(value: string) {
  if (value.length === 0) return 0;
  let count = 1;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "\r") {
      count += 1;
      if (value[index + 1] === "\n") index += 1;
    } else if (value[index] === "\n") {
      count += 1;
    }
  }
  return value.endsWith("\r") || value.endsWith("\n") ? count - 1 : count;
}

type FilesystemEntryKind = "directory" | "file" | "special" | "symlink" | "unknown" | "unsafe";

/** @param {import("node:fs").Dirent | import("node:fs").BigIntStats} entry */
function filesystemEntryKind(entry: import("node:fs").Dirent | import("node:fs").BigIntStats) {
  if (entry.isSymbolicLink()) return "symlink";
  if (entry.isDirectory()) return "directory";
  if (entry.isFile()) return "file";
  if (entry.isBlockDevice() || entry.isCharacterDevice() || entry.isFIFO() || entry.isSocket()) {
    return "special";
  }
  return "unknown";
}

/**
 * Recover a filesystem type only when readdir reports DT_UNKNOWN. Known entries keep the streamed
 * fast path; unknown entries are classified without opening or reading their content.
 * @param {import("node:fs").Dirent} entry
 * @param {string} absolutePath
 * @returns {Promise<FilesystemEntryKind>}
 */
async function classifyDirectoryEntry(
  entry: import("node:fs").Dirent,
  absolutePath: string,
): Promise<FilesystemEntryKind> {
  const streamedKind = filesystemEntryKind(entry);
  if (streamedKind !== "unknown") return streamedKind;
  try {
    const stats = await lstat(absolutePath, { bigint: true });
    const inspectedKind = filesystemEntryKind(stats);
    return inspectedKind === "unknown" ? "special" : inspectedKind;
  } catch {
    return "unsafe";
  }
}

/** @param {{name: string}} left @param {{name: string}} right */
function compareNames(left: { name: string }, right: { name: string }) {
  if (left.name === right.name) return 0;
  return left.name < right.name ? -1 : 1;
}

/** @param {number} fileLimit */
function traversalEntryCeiling(fileLimit: number) {
  return Math.min(
    MAX_TRAVERSAL_ENTRIES,
    Math.max(MIN_TRAVERSAL_ENTRIES, Math.min(fileLimit, MAX_TRAVERSAL_ENTRIES) * 4),
  );
}

/**
 * @param {DirectorySnapshot} snapshot
 * @param {{count: number, ceiling: number}} traversal
 * @returns {Promise<DirectoryReadResult>}
 */
async function readBoundedDirectory(
  snapshot: DirectorySnapshot,
  traversal: { count: number; ceiling: number },
): Promise<DirectoryReadResult> {
  const directory = snapshot.handle;
  /** @type {import("node:fs").Dirent[]} */
  const entries: import("node:fs").Dirent[] = [];
  /** @type {DirectoryReadResult} */
  let result: DirectoryReadResult = { kind: "entries", entries };
  try {
    while (true) {
      const entry = await directory.read();
      if (entry === null) break;
      traversal.count += 1;
      if (traversal.count > traversal.ceiling) {
        result = { kind: "limit" };
        break;
      }
      entries.push(entry);
    }
  } catch {
    result = { kind: "unsafe" };
  }
  if (result.kind === "entries") entries.sort(compareNames);
  return result;
}

/** @param {string} parent @param {string} candidate */
function isWithin(parent: string, candidate: string) {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}

/**
 * Inspect each textual component below the project boundary so an in-project symlink cannot be
 * hidden by resolving only the final configured source-root pathname.
 * @param {string} projectDir
 * @param {string} realProjectDir
 * @param {string} absoluteSourceRoot
 * @param {import("node:fs").Dir[]} handles
 * @returns {Promise<
 *   | {kind: "present", stats: import("node:fs").BigIntStats, resolved: string | undefined, snapshots: DirectorySnapshot[]}
 *   | {kind: "missing", snapshots: DirectorySnapshot[], missingPath: string}
 *   | {kind: "symlink"}
 *   | {kind: "unsafe"}
 * >}
 */
async function inspectSourceRootPath(
  projectDir: string,
  realProjectDir: string,
  absoluteSourceRoot: string,
  handles: import("node:fs").Dir[],
): Promise<
  | {
      kind: "present";
      stats: import("node:fs").BigIntStats;
      resolved: string | undefined;
      snapshots: DirectorySnapshot[];
    }
  | { kind: "missing"; snapshots: DirectorySnapshot[]; missingPath: string }
  | { kind: "symlink" }
  | { kind: "unsafe" }
> {
  const relative = path.relative(projectDir, absoluteSourceRoot);
  const components = relative === "" ? [] : relative.split(path.sep);
  /** @type {DirectorySnapshot[]} */
  const snapshots: DirectorySnapshot[] = [];
  let current = projectDir;
  let finalStats: BigIntStats | undefined;
  for (const [index, component] of components.entries()) {
    current = path.join(current, component);
    try {
      finalStats = await lstat(current, { bigint: true });
    } catch (error) {
      if (hasErrorCode(error, "ENOENT"))
        return { kind: "missing", snapshots, missingPath: current };
      return { kind: "unsafe" };
    }
    if (finalStats.isSymbolicLink()) return { kind: "symlink" };
    const finalComponent = index === components.length - 1;
    if (!finalStats.isDirectory()) {
      if (!finalComponent) return { kind: "unsafe" };
      continue;
    }
    const snapshot = await bindDirectorySnapshot(
      current,
      realProjectDir,
      toPosix(path.relative(projectDir, current)),
      handles,
      { identityOnly: !finalComponent },
    );
    if (!snapshot) return { kind: "unsafe" };
    finalStats = snapshot.stats;
    snapshots.push(snapshot);
  }
  if (finalStats !== undefined) {
    return {
      kind: "present",
      stats: finalStats,
      resolved:
        snapshots.at(-1)?.absolutePath === absoluteSourceRoot
          ? snapshots.at(-1)?.resolved
          : undefined,
      snapshots,
    };
  }
  try {
    const stats = await lstat(absoluteSourceRoot, { bigint: true });
    return { kind: "present", stats, resolved: undefined, snapshots };
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return { kind: "missing", snapshots, missingPath: absoluteSourceRoot };
    }
    return { kind: "unsafe" };
  }
}

/** @param {unknown} error @param {string} code */
function hasErrorCode(error: unknown, code: string) {
  return error !== null && typeof error === "object" && "code" in error && error.code === code;
}

/** @param {unknown} error */
function isUnsafeFilesystemChange(error: unknown) {
  return ["EACCES", "ELOOP", "ENOENT", "ENOTDIR", "EPERM"].some((code) =>
    hasErrorCode(error, code),
  );
}

/** @param {import("node:fs").BigIntStats} left @param {import("node:fs").BigIntStats} right */
function sameIdentity(left: import("node:fs").BigIntStats, right: import("node:fs").BigIntStats) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}

/** @param {import("node:fs").BigIntStats} left @param {import("node:fs").BigIntStats} right */
function sameStableFile(left: import("node:fs").BigIntStats, right: import("node:fs").BigIntStats) {
  return (
    sameIdentity(left, right) &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

/** @param {import("node:fs").BigIntStats} left @param {import("node:fs").BigIntStats} right */
function sameStableDirectory(
  left: import("node:fs").BigIntStats,
  right: import("node:fs").BigIntStats,
) {
  return (
    sameIdentity(left, right) &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

/**
 * Open without following a final symlink where supported, bind the pathname to a descriptor,
 * allocate only the bounded declared size, and revalidate both identities after reading.
 * @param {string} absolutePath
 * @param {(size: number) => string | undefined} limitForSize
 * @returns {Promise<VerifiedFileResult>}
 */
async function readVerifiedFile(
  absolutePath: string,
  limitForSize: (size: number) => string | undefined,
): Promise<VerifiedFileResult> {
  try {
    return await readVerifiedFileUnchecked(absolutePath, limitForSize);
  } catch {
    return { kind: "unsafe" };
  }
}

/**
 * Keep filesystem calls in a single boundary so every unexpected stat/open/read/close failure is
 * converted by readVerifiedFile into the stable, sanitized unsafe result.
 * @param {string} absolutePath
 * @param {(size: number) => string | undefined} limitForSize
 * @returns {Promise<VerifiedFileResult>}
 */
async function readVerifiedFileUnchecked(
  absolutePath: string,
  limitForSize: (size: number) => string | undefined,
): Promise<VerifiedFileResult> {
  let pathBefore: BigIntStats;
  let retained = false;
  try {
    pathBefore = await lstat(absolutePath, { bigint: true });
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return { kind: "missing" };
    if (isUnsafeFilesystemChange(error)) return { kind: "unsafe" };
    throw error;
  }
  if (pathBefore.isSymbolicLink()) return { kind: "symlink" };
  if (!pathBefore.isFile()) return { kind: "special" };
  if (pathBefore.nlink > 1n) return { kind: "hardlink" };
  const pathSize = Number(pathBefore.size);
  if (!Number.isSafeInteger(pathSize) || pathSize < 0) return { kind: "unsafe" };
  const pathLimit = limitForSize(pathSize);
  if (pathLimit) return { kind: "limit", limit: pathLimit };

  let handle: FileHandle | undefined;
  try {
    handle = await open(absolutePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (isUnsafeFilesystemChange(error)) return { kind: "unsafe" };
    throw error;
  }

  try {
    const descriptorBefore = await handle.stat({ bigint: true });
    if (
      !descriptorBefore.isFile() ||
      descriptorBefore.nlink > 1n ||
      !sameIdentity(pathBefore, descriptorBefore)
    ) {
      return { kind: "unsafe" };
    }
    const size = Number(descriptorBefore.size);
    if (!Number.isSafeInteger(size) || size < 0) return { kind: "unsafe" };
    const limit = limitForSize(size);
    if (limit) return { kind: "limit", limit };

    const bytes = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < size) {
      const read = await handle.read(bytes, offset, size - offset, offset);
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
    const extra = await handle.read(Buffer.alloc(1), 0, 1, size);
    const descriptorAfter = await handle.stat({ bigint: true });
    let pathAfter: BigIntStats;
    try {
      pathAfter = await lstat(absolutePath, { bigint: true });
    } catch (error) {
      if (isUnsafeFilesystemChange(error)) return { kind: "unsafe" };
      throw error;
    }
    if (
      offset !== size ||
      extra.bytesRead !== 0 ||
      pathAfter.isSymbolicLink() ||
      !sameStableFile(descriptorBefore, descriptorAfter) ||
      !sameStableFile(descriptorAfter, pathAfter)
    ) {
      return { kind: "unsafe" };
    }
    retained = true;
    return {
      kind: "file",
      bytes,
      size,
      snapshot: { absolutePath, handle, stats: descriptorAfter },
    };
  } finally {
    if (!retained) await handle.close();
  }
}

/** @param {string} absolutePath */
async function readRealDirectoryIdentity(absolutePath: string) {
  try {
    const stats = await lstat(absolutePath, { bigint: true });
    if (stats.isSymbolicLink() || !stats.isDirectory()) return null;
    return { stats, resolved: await realpath(absolutePath) };
  } catch {
    return null;
  }
}

/** @param {string} absolutePath @param {string} realBoundary */
async function readDirectoryIdentity(absolutePath: string, realBoundary: string) {
  const identity = await readRealDirectoryIdentity(absolutePath);
  if (!identity || !isWithin(realBoundary, identity.resolved)) return null;
  return identity;
}

/**
 * Open and retain the exact directory generation after checking the pathname before and after the
 * open. Retaining the Dir handle prevents that directory object's inode from being recycled while
 * the snapshot is active.
 * @param {string} absolutePath
 * @param {string} realBoundary
 * @param {string} diagnosticPath
 * @param {import("node:fs").Dir[]} handles
 * @param {{skillName?: string, identityOnly?: boolean}} [options]
 */
async function bindDirectorySnapshot(
  absolutePath: string,
  realBoundary: string,
  diagnosticPath: string,
  handles: import("node:fs").Dir[],
  options: { skillName?: string; identityOnly?: boolean } = {},
) {
  let handle: Dir | undefined;
  try {
    const before = await lstat(absolutePath, { bigint: true });
    if (before.isSymbolicLink() || !before.isDirectory()) return null;
    const resolvedBefore = await realpath(absolutePath);
    if (!isWithin(realBoundary, resolvedBefore)) return null;
    handle = await opendir(absolutePath);
    const after = await lstat(absolutePath, { bigint: true });
    const resolvedAfter = await realpath(absolutePath);
    if (
      after.isSymbolicLink() ||
      !after.isDirectory() ||
      resolvedBefore !== resolvedAfter ||
      !(options.identityOnly ? sameIdentity(before, after) : sameStableDirectory(before, after))
    ) {
      await handle.close().catch(() => undefined);
      return null;
    }
    handles.push(handle);
    return {
      absolutePath,
      diagnosticPath,
      handle,
      realBoundary,
      resolved: resolvedAfter,
      stats: after,
      ...options,
    };
  } catch {
    if (handle) await handle.close().catch(() => undefined);
    return null;
  }
}

/**
 * Resolve platform aliases once, then bind every real directory from the filesystem root through
 * the project so later pathname traversal cannot pivot through an unobserved ancestor.
 * @param {string} requestedProjectDir
 */
async function inspectProjectDirectoryChain(requestedProjectDir: string) {
  let projectDir: string;
  try {
    const requestedStats = await lstat(requestedProjectDir, { bigint: true });
    if (requestedStats.isSymbolicLink() || !requestedStats.isDirectory()) return null;
    projectDir = await realpath(requestedProjectDir);
  } catch {
    return null;
  }

  const filesystemRoot = path.parse(projectDir).root;
  const relative = path.relative(filesystemRoot, projectDir);
  const components = relative === "" ? [] : relative.split(path.sep);
  const absolutePaths = [filesystemRoot];
  let current = filesystemRoot;
  for (const component of components) {
    current = path.join(current, component);
    absolutePaths.push(current);
  }

  /** @type {DirectorySnapshot[]} */
  const snapshots: DirectorySnapshot[] = [];
  /** @type {import("node:fs").Dir[]} */
  const handles: import("node:fs").Dir[] = [];
  for (const absolutePath of absolutePaths) {
    const snapshot = await bindDirectorySnapshot(absolutePath, filesystemRoot, ".", handles, {
      identityOnly: true,
    });
    if (!snapshot || path.relative(absolutePath, snapshot.resolved) !== "") {
      await Promise.allSettled(handles.map((handle) => handle.close()));
      return null;
    }
    snapshots.push(snapshot);
  }
  return { handles, projectDir, snapshots };
}

/** @param {string} projectDir @returns {Promise<AuthoringProjectSnapshot | null>} */
export async function createAuthoringProjectSnapshot(
  projectDir: string,
): Promise<AuthoringProjectSnapshot | null> {
  if (!projectDir.isWellFormed()) return null;
  const requestedProjectDir = path.resolve(projectDir);
  const state = await inspectProjectDirectoryChain(requestedProjectDir);
  if (!state) return null;
  return {
    requestedProjectDir,
    projectDir: state.projectDir,
    projectPathSnapshots: state.snapshots,
    directoryHandles: state.handles,
    fileHandles: [],
    fileSnapshots: [],
    missingFileSnapshots: [],
    closed: false,
  };
}

/** @param {FileSnapshot[]} snapshots */
async function firstChangedFile(snapshots: FileSnapshot[]) {
  for (const snapshot of snapshots) {
    try {
      const descriptor = await snapshot.handle.stat({ bigint: true });
      const pathname = await lstat(snapshot.absolutePath, { bigint: true });
      if (
        pathname.isSymbolicLink() ||
        !sameStableFile(snapshot.stats, descriptor) ||
        !sameStableFile(descriptor, pathname)
      ) {
        return snapshot;
      }
    } catch {
      return snapshot;
    }
  }
  return null;
}

/** @param {string[]} absolutePaths */
async function firstAppearedFile(absolutePaths: string[]) {
  for (const absolutePath of absolutePaths) {
    try {
      await lstat(absolutePath, { bigint: true });
      return absolutePath;
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT")) return absolutePath;
    }
  }
  return null;
}

/** @param {AuthoringProjectSnapshot} snapshot */
export async function verifyAuthoringProjectSnapshot(snapshot: AuthoringProjectSnapshot) {
  return (
    !snapshot.closed &&
    !(await firstChangedDirectory(snapshot.projectPathSnapshots)) &&
    !(await firstChangedFile(snapshot.fileSnapshots)) &&
    !(await firstAppearedFile(snapshot.missingFileSnapshots))
  );
}

/** @param {AuthoringProjectSnapshot} snapshot */
export async function closeAuthoringProjectSnapshot(snapshot: AuthoringProjectSnapshot) {
  if (snapshot.closed) return true;
  snapshot.closed = true;
  const results = await Promise.allSettled([
    ...snapshot.fileHandles.map((handle) => handle.close()),
    ...snapshot.directoryHandles.map((handle) => handle.close()),
  ]);
  return results.every(({ status }) => status === "fulfilled");
}

/**
 * Read a project-relative transaction input through a retained descriptor. The returned bytes are
 * not trusted unless the same snapshot is later passed to validateAuthoringProject.
 * @param {AuthoringProjectSnapshot} snapshot
 * @param {string} relativePath
 * @param {number} byteLimit
 */
export async function readAuthoringProjectFile(
  snapshot: AuthoringProjectSnapshot,
  relativePath: string,
  byteLimit: number,
) {
  if (
    snapshot.closed ||
    !isProjectRelativePath(relativePath) ||
    (await firstChangedDirectory(snapshot.projectPathSnapshots))
  ) {
    return { kind: "unsafe" };
  }
  const absolutePath = path.join(snapshot.projectDir, relativePath);
  const result = await readVerifiedFile(absolutePath, (size) =>
    size > byteLimit ? "fileBytes" : undefined,
  );
  if (result.kind === "file") {
    snapshot.fileHandles.push(result.snapshot.handle);
    snapshot.fileSnapshots.push({
      ...result.snapshot,
      diagnosticPath: relativePath,
    });
  } else if (result.kind === "missing") {
    snapshot.missingFileSnapshots.push(absolutePath);
  }
  if (await firstChangedDirectory(snapshot.projectPathSnapshots)) {
    return { kind: "unsafe" };
  }
  return result.kind === "file" ? { kind: "file", bytes: result.bytes, size: result.size } : result;
}

/** @param {DirectoryIdentity} before @param {string} absolutePath @param {string} realBoundary */
async function directoryIdentityUnchanged(
  before: DirectoryIdentity,
  absolutePath: string,
  realBoundary: string,
) {
  const after = await readDirectoryIdentity(absolutePath, realBoundary);
  return (
    after !== null &&
    before.resolved === after.resolved &&
    sameStableDirectory(before.stats, after.stats)
  );
}

/** @param {DirectorySnapshot[]} snapshots */
async function firstChangedDirectory(snapshots: DirectorySnapshot[]) {
  for (const snapshot of snapshots) {
    const after = await readDirectoryIdentity(snapshot.absolutePath, snapshot.realBoundary);
    if (
      after === null ||
      snapshot.resolved !== after.resolved ||
      !(snapshot.identityOnly
        ? sameIdentity(snapshot.stats, after.stats)
        : sameStableDirectory(snapshot.stats, after.stats))
    )
      return snapshot;
  }
  return null;
}

/**
 * @param {string} skillRoot
 * @param {string} realSkillRoot
 * @param {string} projectDir
 * @param {string} skillName
 * @param {{files: number, fileBytes: number, extractedBytes: number}} limits
 * @param {DirectorySnapshot[]} projectPathSnapshots
 * @param {DirectorySnapshot} rootSnapshot
 * @param {import("node:fs").Dir[]} directoryHandles
 * @param {import("node:fs/promises").FileHandle[]} fileHandles
 * @param {Extract<VerifiedFileResult, {kind: "file"}>} rootSkillFile
 * @param {DirectoryReadResult} rootDirectoryRead
 * @param {{count: number, ceiling: number}} traversal
 */
async function collectSkillFiles(
  skillRoot: string,
  realSkillRoot: string,
  projectDir: string,
  skillName: string,
  limits: { files: number; fileBytes: number; extractedBytes: number },
  projectPathSnapshots: DirectorySnapshot[],
  rootSnapshot: DirectorySnapshot,
  directoryHandles: import("node:fs").Dir[],
  fileHandles: import("node:fs/promises").FileHandle[],
  rootSkillFile: Extract<VerifiedFileResult, { kind: "file" }>,
  rootDirectoryRead: DirectoryReadResult,
  traversal: { count: number; ceiling: number },
) {
  /** @type {{path: string, size: number, bytes: Uint8Array}[]} */
  const files: { path: string; size: number; bytes: Uint8Array }[] = [];
  /** @type {import("./diagnostics.ts").AuthoringDiagnostic[]} */
  const diagnostics: import("./diagnostics.ts").AuthoringDiagnostic[] = [];
  /** @type {DirectorySnapshot[]} */
  const directorySnapshots: DirectorySnapshot[] = [];
  /** @type {FileSnapshot[]} */
  const fileSnapshots: FileSnapshot[] = [];
  /** @type {string[]} */
  const missingFileSnapshots: string[] = [];
  const portablePaths = new Set();
  let fileCount = 0;
  let totalBytes = 0;
  let stopped = false;
  let snapshotValid = true;

  function invalidateSnapshot() {
    snapshotValid = false;
    files.length = 0;
  }

  async function projectPathIsStable() {
    if (!(await firstChangedDirectory(projectPathSnapshots))) return true;
    diagnostics.push(projectPathChangedDiagnostic());
    invalidateSnapshot();
    stopped = true;
    return false;
  }

  /** @param {string} diagnosticPath @param {string} reason */
  function unsafeFile(diagnosticPath: string, reason: string) {
    diagnostics.push(
      authoringDiagnostic("error", "archive_unsafe", reason, {
        path: diagnosticPath,
        skill_name: skillName,
      }),
    );
    invalidateSnapshot();
  }

  const rootDiagnosticPath = toPosix(path.relative(projectDir, skillRoot));
  if (rootDirectoryRead.kind === "unsafe") {
    unsafeFile(rootDiagnosticPath, "included directory could not be enumerated safely");
    return {
      files,
      diagnostics,
      snapshotValid,
      directorySnapshots,
      fileSnapshots,
      missingFileSnapshots,
      isSkill: true,
    };
  }
  if (rootDirectoryRead.kind === "limit") {
    diagnostics.push(
      authoringDiagnostic(
        "error",
        "limit_exceeded",
        "skill traversal exceeds the directory-entry limit",
        {
          limit: "traversalEntries",
          path: rootDiagnosticPath,
          skill_name: skillName,
        },
      ),
    );
    invalidateSnapshot();
    return {
      files,
      diagnostics,
      snapshotValid,
      directorySnapshots,
      fileSnapshots,
      missingFileSnapshots,
      isSkill: true,
    };
  }
  let skillIgnore = createSkillIgnorePolicy();
  const skillIgnorePath = path.join(skillRoot, ".skillignore");
  const skillIgnoreResult = await readVerifiedFile(skillIgnorePath, (size) =>
    size > limits.fileBytes ? "fileBytes" : undefined,
  );
  if (skillIgnoreResult.kind === "file") {
    fileHandles.push(skillIgnoreResult.snapshot.handle);
  }
  if (!(await projectPathIsStable())) {
    return {
      files,
      diagnostics,
      snapshotValid,
      directorySnapshots,
      fileSnapshots,
      missingFileSnapshots,
      isSkill: true,
    };
  }
  let skillIgnoreValid = true;
  if (skillIgnoreResult.kind === "file") {
    fileSnapshots.push({
      ...skillIgnoreResult.snapshot,
      diagnosticPath: toPosix(path.relative(projectDir, skillIgnorePath)),
      skillName,
    });
    try {
      skillIgnore = createSkillIgnorePolicy(skillIgnoreResult.bytes);
    } catch {
      diagnostics.push(
        authoringDiagnostic("error", "catalog_invalid", ".skillignore must contain valid UTF-8", {
          field: ".skillignore",
          path: toPosix(path.relative(projectDir, skillIgnorePath)),
          skill_name: skillName,
        }),
      );
      invalidateSnapshot();
      skillIgnoreValid = false;
    }
  } else if (skillIgnoreResult.kind === "limit") {
    diagnostics.push(
      authoringDiagnostic("error", "limit_exceeded", ".skillignore exceeds the per-file limit", {
        limit: skillIgnoreResult.limit,
        path: toPosix(path.relative(projectDir, skillIgnorePath)),
        skill_name: skillName,
      }),
    );
    invalidateSnapshot();
    skillIgnoreValid = false;
  } else if (skillIgnoreResult.kind === "unsafe") {
    unsafeFile(
      toPosix(path.relative(projectDir, skillIgnorePath)),
      ".skillignore could not be read safely",
    );
    skillIgnoreValid = false;
  } else if (skillIgnoreResult.kind === "missing") {
    missingFileSnapshots.push(skillIgnorePath);
  } else {
    diagnostics.push(
      authoringDiagnostic("error", "archive_unsafe", ".skillignore must be a single regular file", {
        path: toPosix(path.relative(projectDir, skillIgnorePath)),
        skill_name: skillName,
      }),
    );
    invalidateSnapshot();
    skillIgnoreValid = false;
  }
  if (!skillIgnoreValid) {
    return {
      files,
      diagnostics,
      snapshotValid,
      directorySnapshots,
      fileSnapshots,
      missingFileSnapshots,
      isSkill: true,
    };
  }

  /** @param {string} relativePath @param {string} diagnosticPath */
  function registerPortablePath(relativePath: string, diagnosticPath: string) {
    const portable = normalizePortableRelativePath(relativePath);
    if (!portable) {
      diagnostics.push(
        authoringDiagnostic(
          "error",
          "path_invalid",
          "included paths must use safe POSIX separators",
          {
            path: diagnosticPath,
            skill_name: skillName,
          },
        ),
      );
      invalidateSnapshot();
      return null;
    }
    if (portablePaths.has(portable.collisionKey)) {
      diagnostics.push(
        authoringDiagnostic(
          "error",
          "archive_unsafe",
          "included paths must not have normalized or portable case collisions",
          { path: portable.path, skill_name: skillName },
        ),
      );
      invalidateSnapshot();
      return null;
    }
    portablePaths.add(portable.collisionKey);
    return portable;
  }

  const rootSkillDiagnosticPath = toPosix(
    path.relative(projectDir, rootSkillFile.snapshot.absolutePath),
  );
  const rootSkillPortable = registerPortablePath("SKILL.md", rootSkillDiagnosticPath);
  if (rootSkillPortable) {
    fileCount = 1;
    totalBytes = rootSkillFile.size;
    fileSnapshots.push({
      ...rootSkillFile.snapshot,
      diagnosticPath: rootSkillDiagnosticPath,
      skillName,
    });
    if (snapshotValid) {
      files.push({
        path: rootSkillPortable.path,
        size: rootSkillFile.size,
        bytes: rootSkillFile.bytes,
      });
    }
  } else {
    stopped = true;
  }

  /**
   * @param {DirectorySnapshot} snapshot
   * @param {string} relativeDirectory
   * @param {import("node:fs").Dirent[]} [preloadedEntries]
   */
  async function visit(
    snapshot: DirectorySnapshot,
    relativeDirectory: string,
    preloadedEntries?: import("node:fs").Dirent[],
  ) {
    const current = snapshot.absolutePath;
    const directoryRead: DirectoryReadResult = preloadedEntries
      ? { kind: "entries", entries: preloadedEntries }
      : await readBoundedDirectory(snapshot, traversal);
    if (directoryRead.kind === "unsafe") {
      unsafeFile(
        toPosix(path.relative(projectDir, current)),
        "included directory could not be enumerated safely",
      );
      stopped = true;
      return;
    }
    if (directoryRead.kind === "limit") {
      diagnostics.push(
        authoringDiagnostic(
          "error",
          "limit_exceeded",
          "skill traversal exceeds the directory-entry limit",
          {
            limit: "traversalEntries",
            path: toPosix(path.relative(projectDir, current)),
            skill_name: skillName,
          },
        ),
      );
      invalidateSnapshot();
      stopped = true;
      return;
    }
    if (!(await projectPathIsStable())) return;
    const { entries } = directoryRead;
    for (const entry of entries) {
      if (stopped) break;
      const relativePath = toPosix(path.join(relativeDirectory, entry.name));
      const absolutePath = path.join(current, entry.name);
      const diagnosticPath = toPosix(path.relative(projectDir, absolutePath));
      const entryKind = await classifyDirectoryEntry(entry, absolutePath);
      if (entryKind === "unsafe") {
        unsafeFile(diagnosticPath, "filesystem entry could not be classified safely");
        stopped = true;
        continue;
      }
      if (entryKind === "symlink") {
        unsafeFile(diagnosticPath, "filesystem symlinks are not permitted");
        continue;
      }
      if (entryKind === "special") {
        unsafeFile(diagnosticPath, "special filesystem entries are not permitted");
        continue;
      }
      const isDirectory = entryKind === "directory";
      if (ignoredByDefaults(relativePath, isDirectory)) continue;

      if (relativeDirectory === "" && entry.name === "SKILL.md") {
        if (entryKind !== "file") {
          unsafeFile(diagnosticPath, "SKILL.md must remain a regular file");
          stopped = true;
        }
        continue;
      }
      const portable = registerPortablePath(relativePath, diagnosticPath);
      if (!portable) continue;
      if (skillIgnore(portable.path, isDirectory)) {
        continue;
      }
      if (isDirectory) {
        const childSnapshot = await bindDirectorySnapshot(
          absolutePath,
          realSkillRoot,
          diagnosticPath,
          directoryHandles,
          { skillName },
        );
        if (!childSnapshot) {
          unsafeFile(diagnosticPath, "included directories must remain inside the skill root");
          continue;
        }
        directorySnapshots.push(childSnapshot);
        await visit(childSnapshot, relativePath);
        if (!(await directoryIdentityUnchanged(childSnapshot, absolutePath, realSkillRoot))) {
          unsafeFile(diagnosticPath, "included directory changed during validation");
          stopped = true;
        }
        continue;
      }

      const verified = await readVerifiedFile(absolutePath, (size) => {
        if (fileCount + 1 > limits.files) return "files";
        if (size > limits.fileBytes) return "fileBytes";
        if (totalBytes + size > limits.extractedBytes) return "extractedBytes";
        return undefined;
      });
      if (verified.kind === "file") {
        fileHandles.push(verified.snapshot.handle);
      }
      if (!(await projectPathIsStable())) break;
      if (verified.kind === "limit") {
        diagnostics.push(
          authoringDiagnostic("error", "limit_exceeded", "skill input exceeds a configured limit", {
            limit: verified.limit,
            path: diagnosticPath,
            skill_name: skillName,
          }),
        );
        stopped = true;
      } else if (verified.kind === "file") {
        fileSnapshots.push({
          ...verified.snapshot,
          diagnosticPath,
          skillName,
        });
        fileCount += 1;
        totalBytes += verified.size;
        if (snapshotValid) {
          files.push({ path: portable.path, size: verified.size, bytes: verified.bytes });
        }
      } else if (verified.kind === "symlink") {
        unsafeFile(diagnosticPath, "filesystem symlinks are not permitted");
      } else if (verified.kind === "hardlink") {
        unsafeFile(diagnosticPath, "hard-linked files are not permitted");
      } else if (verified.kind === "special") {
        unsafeFile(diagnosticPath, "special filesystem entries are not permitted");
      } else {
        unsafeFile(diagnosticPath, "included file changed during validation");
        stopped = true;
      }
    }
    if (!(await directoryIdentityUnchanged(snapshot, current, realSkillRoot))) {
      unsafeFile(
        toPosix(path.relative(projectDir, current)),
        "included directory changed during validation",
      );
      stopped = true;
    }
  }

  directorySnapshots.push(rootSnapshot);
  await visit(rootSnapshot, "", rootDirectoryRead.entries);
  return {
    files,
    diagnostics,
    snapshotValid,
    directorySnapshots,
    fileSnapshots,
    missingFileSnapshots,
    isSkill: true,
  };
}

/** @param {string} target */
function normalizeLocalReference(target: string) {
  if (/^[A-Za-z]:/u.test(target)) return { invalid: true, path: INVALID_LOCAL_REFERENCE };
  if (/^file:/iu.test(target)) return { invalid: true, path: INVALID_LOCAL_REFERENCE };
  if (
    target === "" ||
    target.startsWith("#") ||
    target.startsWith("?") ||
    target.startsWith("//") ||
    /^[a-z][a-z0-9+.-]*:/iu.test(target)
  ) {
    return { external: true };
  }
  const rawPath = target.split(/[?#]/u, 1)[0] ?? "";
  if (rawPath.includes("\\")) return { invalid: true, path: INVALID_LOCAL_REFERENCE };
  let decoded: string;
  try {
    const skillRootPath = "/__skill_root__/";
    const resolved = new URL(rawPath, `https://skill.invalid${skillRootPath}SKILL.md`);
    if (
      resolved.origin !== "https://skill.invalid" ||
      !resolved.pathname.startsWith(skillRootPath)
    ) {
      return { invalid: true, path: INVALID_LOCAL_REFERENCE };
    }
    decoded = decodeURIComponent(resolved.pathname.slice(skillRootPath.length));
  } catch {
    return { invalid: true, path: INVALID_LOCAL_REFERENCE };
  }
  const portable = normalizePortableRelativePath(decoded);
  if (!portable) return { invalid: true, path: INVALID_LOCAL_REFERENCE };
  return { path: portable.path };
}

/** @param {string} body @returns {MarkdownTargetsResult} */
function markdownTargets(body: string): MarkdownTargetsResult {
  let tree: MarkdownNode;
  try {
    tree = fromMarkdown(body);
  } catch {
    return { kind: "invalid" };
  }
  const definitions = new Map();
  /** @type {MarkdownNode} */
  const root: MarkdownNode = tree;
  /** @type {MarkdownNode[]} */
  const pending: MarkdownNode[] = [root];
  /** @type {({kind: "target", value: string} | {kind: "reference", identifier: string})[]} */
  const orderedTargets: (
    | { kind: "target"; value: string }
    | { kind: "reference"; identifier: string }
  )[] = [];
  let visitedNodes = 0;
  while (pending.length > 0) {
    const node = pending.pop();
    if (!node) continue;
    visitedNodes += 1;
    if (visitedNodes > MARKDOWN_NODE_LIMIT) return { kind: "limit" };
    if (node.type === "definition" && node.identifier && node.url) {
      if (!definitions.has(node.identifier)) definitions.set(node.identifier, node.url);
    }
    if ((node.type === "link" || node.type === "image") && node.url) {
      orderedTargets.push({ kind: "target", value: node.url });
    }
    if ((node.type === "linkReference" || node.type === "imageReference") && node.identifier) {
      orderedTargets.push({ kind: "reference", identifier: node.identifier });
    }
    const children = node.children ?? [];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (child) pending.push(child);
    }
  }
  return {
    kind: "targets",
    targets: orderedTargets.flatMap((target) => {
      if (target.kind === "target") return [target.value];
      const definition = definitions.get(target.identifier);
      return definition ? [definition] : [];
    }),
  };
}

/**
 * @param {string} body
 * @param {Set<string>} includedPaths
 * @param {string} skillName
 * @param {string} sourcePath
 */
function validateLocalReferences(
  body: string,
  includedPaths: Set<string>,
  skillName: string,
  sourcePath: string,
) {
  /** @type {import("./diagnostics.ts").AuthoringDiagnostic[]} */
  const diagnostics: import("./diagnostics.ts").AuthoringDiagnostic[] = [];
  const markdown = markdownTargets(body);
  if (markdown.kind === "limit") {
    return [
      authoringDiagnostic(
        "error",
        "limit_exceeded",
        "SKILL.md Markdown exceeds the validation node limit",
        { limit: "markdownNodes", path: sourcePath, skill_name: skillName },
      ),
    ];
  }
  if (markdown.kind === "invalid") {
    return [
      authoringDiagnostic("error", "catalog_invalid", "SKILL.md Markdown could not be parsed", {
        field: "SKILL.md.body",
        path: sourcePath,
        skill_name: skillName,
      }),
    ];
  }
  const seen = new Set();
  for (const target of markdown.targets) {
    const normalized = normalizeLocalReference(target);
    if (normalized.external || seen.has(normalized.path)) continue;
    if (normalized.path) seen.add(normalized.path);
    if (normalized.invalid) {
      diagnostics.push(
        authoringDiagnostic(
          "error",
          "path_invalid",
          "local Markdown reference must remain inside the skill root",
          { path: normalized.path ?? target, skill_name: skillName },
        ),
      );
    } else if (normalized.path && !includedPaths.has(normalized.path)) {
      diagnostics.push(
        authoringDiagnostic(
          "error",
          "resource_not_found",
          "local Markdown reference does not identify an included resource",
          { path: normalized.path, skill_name: skillName },
        ),
      );
    }
  }
  return diagnostics;
}

/**
 * @param {{
 *   projectDir: string;
 *   config?: AuthoringConfig;
 *   strict?: boolean;
 *   snapshot?: AuthoringProjectSnapshot;
 * }} options
 * @param {{snapshot: AuthoringProjectSnapshot | null | undefined}} ownership
 */
async function validateAuthoringProjectWithinSnapshot(
  options: {
    projectDir: string;
    config?: AuthoringConfig;
    strict?: boolean;
    snapshot?: AuthoringProjectSnapshot;
  },
  ownership: { snapshot: AuthoringProjectSnapshot | null | undefined },
) {
  const sourceRoots = options.config?.sourceRoots ?? DEFAULT_CONFIG.sourceRoots;
  const invalidSourceRoots = sourceRoots.filter((sourceRoot) => !isProjectRelativePath(sourceRoot));
  if (invalidSourceRoots.length > 0) {
    const result = {
      valid: false,
      skills: [],
      errors: invalidSourceRoots.map(() =>
        authoringDiagnostic("error", "path_invalid", "source root must remain inside the project", {
          field: "sourceRoots",
          path: INVALID_CONFIG_PATH,
        }),
      ),
      warnings: [],
    };
    return result;
  }
  if (!options.projectDir.isWellFormed()) {
    const result = {
      valid: false,
      skills: [],
      errors: [
        authoringDiagnostic(
          "error",
          "archive_unsafe",
          "project directory must be an accessible stable real directory",
          { path: "." },
        ),
      ],
      warnings: [],
    };
    return result;
  }
  const requestedProjectDir = path.resolve(options.projectDir);
  const limits = {
    files: options.config?.limits?.files ?? DEFAULT_CONFIG.limits.files,
    fileBytes: options.config?.limits?.fileBytes ?? DEFAULT_CONFIG.limits.fileBytes,
    extractedBytes: options.config?.limits?.extractedBytes ?? DEFAULT_CONFIG.limits.extractedBytes,
  };
  const strict = options.strict ?? options.config?.strict ?? DEFAULT_CONFIG.strict;
  const skillNames = new Set();
  /** @type {import("./diagnostics.ts").AuthoringDiagnostic[]} */
  const errors: import("./diagnostics.ts").AuthoringDiagnostic[] = [];
  /** @type {import("./diagnostics.ts").AuthoringDiagnostic[]} */
  const warnings: import("./diagnostics.ts").AuthoringDiagnostic[] = [];
  const snapshot = options.snapshot ?? (await createAuthoringProjectSnapshot(options.projectDir));
  ownership.snapshot = snapshot;
  if (
    !snapshot ||
    snapshot.closed ||
    snapshot.requestedProjectDir !== requestedProjectDir ||
    (await firstChangedDirectory(snapshot.projectPathSnapshots)) ||
    (await firstChangedFile(snapshot.fileSnapshots)) ||
    (await firstAppearedFile(snapshot.missingFileSnapshots))
  ) {
    errors.push(
      authoringDiagnostic(
        "error",
        "archive_unsafe",
        "project directory must be an accessible stable real directory",
        { path: "." },
      ),
    );
    return { valid: false, skills: [], errors, warnings };
  }
  const skills = [];
  const projectDir = snapshot.projectDir;
  const realProjectDir = projectDir;
  const projectPathSnapshots = snapshot.projectPathSnapshots;
  /** @type {DirectorySnapshot[]} */
  const directorySnapshots: DirectorySnapshot[] = [...projectPathSnapshots];
  /** @type {FileSnapshot[]} */
  const fileSnapshots: FileSnapshot[] = [...snapshot.fileSnapshots];
  /** @type {{absolutePath: string, diagnosticPath: string, skillName?: string}[]} */
  const missingPaths: { absolutePath: string; diagnosticPath: string; skillName?: string }[] = [];
  const exactSourceRoots = new Set();
  const sourceRootKeys = new Map();

  for (const sourceRoot of sourceRoots) {
    const absoluteSourceRoot = path.resolve(projectDir, sourceRoot);
    if (!isWithin(projectDir, absoluteSourceRoot)) {
      errors.push(
        authoringDiagnostic("error", "path_invalid", "source root must remain inside the project", {
          field: "sourceRoots",
          path: sourceRoot,
        }),
      );
      continue;
    }
    const portableSourceRoot = normalizePortableRelativePath(sourceRoot);
    if (exactSourceRoots.has(sourceRoot)) continue;
    exactSourceRoots.add(sourceRoot);
    if (portableSourceRoot) {
      const collisionOwner = sourceRootKeys.get(portableSourceRoot.collisionKey);
      if (collisionOwner !== undefined) {
        errors.push(
          authoringDiagnostic(
            "error",
            "path_invalid",
            "source roots must not have portable path collisions",
            { field: "sourceRoots", path: sourceRoot },
          ),
        );
        continue;
      }
      sourceRootKeys.set(portableSourceRoot.collisionKey, sourceRoot);
    }
    const sourcePathState = await inspectSourceRootPath(
      projectDir,
      realProjectDir,
      absoluteSourceRoot,
      snapshot.directoryHandles,
    );
    if (sourcePathState.kind === "missing") {
      directorySnapshots.push(...sourcePathState.snapshots);
      missingPaths.push({
        absolutePath: sourcePathState.missingPath,
        diagnosticPath: sourceRoot,
      });
      continue;
    }
    if (sourcePathState.kind === "symlink" || sourcePathState.kind === "unsafe") {
      errors.push(
        authoringDiagnostic(
          "error",
          "archive_unsafe",
          "source root and its project-relative ancestors must be stable real directories",
          { path: sourceRoot },
        ),
      );
      continue;
    }
    const sourceRootStats = sourcePathState.stats;
    if (!sourceRootStats.isDirectory()) {
      errors.push(
        authoringDiagnostic("error", "path_invalid", "source root must be a directory", {
          field: "sourceRoots",
          path: sourceRoot,
        }),
      );
      continue;
    }
    const realSourceRoot = sourcePathState.resolved;
    if (!realSourceRoot) {
      errors.push(
        authoringDiagnostic("error", "archive_unsafe", "source root could not be resolved safely", {
          path: sourceRoot,
        }),
      );
      continue;
    }
    if (!isWithin(realProjectDir, realSourceRoot)) {
      errors.push(
        authoringDiagnostic("error", "path_invalid", "source root resolves outside the project", {
          field: "sourceRoots",
          path: sourceRoot,
        }),
      );
      continue;
    }
    const sourceSnapshot = sourcePathState.snapshots.at(-1);
    if (!sourceSnapshot || sourceSnapshot.absolutePath !== absoluteSourceRoot) {
      errors.push(
        authoringDiagnostic("error", "archive_unsafe", "source root could not be bound safely", {
          path: sourceRoot,
        }),
      );
      continue;
    }
    const sourceIdentity = sourceSnapshot;
    const sourceDirectorySnapshots = [...sourcePathState.snapshots];
    const sourceSkillStart = skills.length;
    /** @type {string[]} */
    const sourceSkillNames: string[] = [];
    const directoryRead = await readBoundedDirectory(sourceSnapshot, {
      count: 0,
      ceiling: traversalEntryCeiling(limits.files),
    });
    if (directoryRead.kind === "unsafe") {
      errors.push(
        authoringDiagnostic(
          "error",
          "archive_unsafe",
          "source root could not be enumerated safely",
          { path: sourceRoot },
        ),
      );
      continue;
    }
    if (directoryRead.kind === "limit") {
      errors.push(
        authoringDiagnostic(
          "error",
          "limit_exceeded",
          "source-root traversal exceeds the directory-entry limit",
          { limit: "traversalEntries", path: sourceRoot },
        ),
      );
      continue;
    }
    if (await firstChangedDirectory(projectPathSnapshots)) {
      errors.push(projectPathChangedDiagnostic());
      skills.length = 0;
      break;
    }
    const { entries } = directoryRead;
    for (const entry of entries) {
      const candidatePath = path.join(absoluteSourceRoot, entry.name);
      const candidateDiagnosticPath = toPosix(path.relative(projectDir, candidatePath));
      const entryKind = await classifyDirectoryEntry(entry, candidatePath);
      if (entryKind === "unsafe") {
        errors.push(
          authoringDiagnostic(
            "error",
            "archive_unsafe",
            "source-root entry could not be classified safely",
            { path: candidateDiagnosticPath, skill_name: entry.name },
          ),
        );
        continue;
      }
      if (entryKind === "symlink") {
        errors.push(
          authoringDiagnostic("error", "archive_unsafe", "filesystem symlinks are not permitted", {
            path: candidateDiagnosticPath,
            skill_name: entry.name,
          }),
        );
        continue;
      }
      const isDirectory = entryKind === "directory";
      if (ignoredByDefaults(entry.name, isDirectory)) continue;
      if (!isDirectory) {
        if (entryKind === "special") {
          errors.push(
            authoringDiagnostic(
              "error",
              "archive_unsafe",
              "special filesystem entries are not permitted",
              {
                path: candidateDiagnosticPath,
                skill_name: entry.name,
              },
            ),
          );
        }
        continue;
      }
      const candidateSnapshot = await bindDirectorySnapshot(
        candidatePath,
        realSourceRoot,
        candidateDiagnosticPath,
        snapshot.directoryHandles,
        { skillName: entry.name },
      );
      if (!candidateSnapshot) {
        errors.push(
          authoringDiagnostic(
            "error",
            "archive_unsafe",
            "skill directory changed during validation",
            {
              path: candidateDiagnosticPath,
              skill_name: entry.name,
            },
          ),
        );
        continue;
      }
      const skillPath = path.join(candidatePath, "SKILL.md");
      const sourcePath = toPosix(path.relative(projectDir, skillPath));
      const rootSkillFile = await readVerifiedFile(skillPath, (size) => {
        if (limits.files < 1) return "files";
        if (size > limits.fileBytes) return "fileBytes";
        if (size > limits.extractedBytes) return "extractedBytes";
        return undefined;
      });
      if (rootSkillFile.kind === "missing") {
        missingPaths.push({
          absolutePath: skillPath,
          diagnosticPath: sourcePath,
          skillName: entry.name,
        });
        continue;
      }
      if (rootSkillFile.kind === "limit") {
        errors.push(
          authoringDiagnostic("error", "limit_exceeded", "skill input exceeds a configured limit", {
            limit: rootSkillFile.limit,
            path: sourcePath,
            skill_name: entry.name,
          }),
        );
        continue;
      }
      if (rootSkillFile.kind !== "file") {
        errors.push(
          authoringDiagnostic(
            "error",
            "archive_unsafe",
            rootSkillFile.kind === "unsafe"
              ? "SKILL.md could not be read safely"
              : "SKILL.md must be a single regular file",
            { path: sourcePath, skill_name: entry.name },
          ),
        );
        continue;
      }
      snapshot.fileHandles.push(rootSkillFile.snapshot.handle);
      if (
        (await firstChangedDirectory(projectPathSnapshots)) ||
        !(await directoryIdentityUnchanged(candidateSnapshot, candidatePath, realSourceRoot))
      ) {
        errors.push(
          authoringDiagnostic(
            "error",
            "archive_unsafe",
            "skill directory changed during SKILL.md discovery",
            { path: candidateDiagnosticPath, skill_name: entry.name },
          ),
        );
        continue;
      }
      if (!normalizePortableRelativePath(entry.name)) {
        errors.push(
          authoringDiagnostic(
            "error",
            "path_invalid",
            "skill directories must use portable names",
            {
              path: candidateDiagnosticPath,
              skill_name: entry.name,
            },
          ),
        );
        continue;
      }
      const skillTraversal = { count: 0, ceiling: traversalEntryCeiling(limits.files) };
      const skillRootRead = await readBoundedDirectory(candidateSnapshot, skillTraversal);
      const collected = await collectSkillFiles(
        candidatePath,
        candidateSnapshot.resolved,
        projectDir,
        entry.name,
        limits,
        projectPathSnapshots,
        candidateSnapshot,
        snapshot.directoryHandles,
        snapshot.fileHandles,
        rootSkillFile,
        skillRootRead,
        skillTraversal,
      );
      errors.push(...collected.diagnostics);
      if (!collected.isSkill) continue;
      if (!collected.snapshotValid) continue;
      if (!(await directoryIdentityUnchanged(candidateSnapshot, candidatePath, realSourceRoot))) {
        errors.push(
          authoringDiagnostic(
            "error",
            "archive_unsafe",
            "skill directory changed during validation",
            {
              path: candidateDiagnosticPath,
              skill_name: entry.name,
            },
          ),
        );
        continue;
      }
      sourceDirectorySnapshots.push(...collected.directorySnapshots);
      fileSnapshots.push(...collected.fileSnapshots);
      missingPaths.push(
        ...collected.missingFileSnapshots.map((absolutePath) => ({
          absolutePath,
          diagnosticPath: toPosix(path.relative(projectDir, absolutePath)),
          skillName: entry.name,
        })),
      );
      const skillFile = collected.files.find(({ path: filePath }) => filePath === "SKILL.md");
      if (!skillFile) continue;
      const validation = validateSkillMarkdown(skillFile.bytes, {
        directoryName: entry.name,
        sourcePath,
      });
      for (const item of validation.diagnostics) {
        if (item.severity === "warning") warnings.push(item);
        else errors.push(item);
      }
      if (!validation.skill) continue;
      if (skillNames.has(validation.skill.name)) {
        errors.push(
          authoringDiagnostic("error", "catalog_invalid", "skill names must be globally unique", {
            field: "name",
            path: sourcePath,
            skill_name: validation.skill.name,
          }),
        );
        continue;
      }
      skillNames.add(validation.skill.name);
      sourceSkillNames.push(validation.skill.name);
      const skillSource = new TextDecoder("utf-8", { fatal: true }).decode(skillFile.bytes);
      const lineCount = logicalLineCount(skillSource);
      if (lineCount > 500) {
        warnings.push(
          authoringDiagnostic(
            "warning",
            "catalog_invalid",
            "SKILL.md exceeds the recommended 500-line writing limit",
            { field: "SKILL.md.lines", path: sourcePath, skill_name: validation.skill.name },
          ),
        );
      }
      errors.push(
        ...validateLocalReferences(
          validation.skill.body,
          new Set(collected.files.map(({ path: filePath }) => filePath)),
          validation.skill.name,
          sourcePath,
        ),
      );
      skills.push({
        ...validation.skill,
        rootPath: toPosix(path.relative(projectDir, candidatePath)),
        files: collected.files,
      });
    }
    if (!(await directoryIdentityUnchanged(sourceIdentity, absoluteSourceRoot, realProjectDir))) {
      errors.push(
        authoringDiagnostic("error", "archive_unsafe", "source root changed during validation", {
          path: sourceRoot,
        }),
      );
      skills.length = sourceSkillStart;
      for (const skillName of sourceSkillNames) skillNames.delete(skillName);
    } else {
      directorySnapshots.push(...sourceDirectorySnapshots);
    }
  }

  for (const missingPath of missingPaths) {
    let remainedMissing = false;
    try {
      await lstat(missingPath.absolutePath, { bigint: true });
    } catch (error) {
      remainedMissing = hasErrorCode(error, "ENOENT");
    }
    if (!remainedMissing) {
      errors.push(
        authoringDiagnostic(
          "error",
          "archive_unsafe",
          "filesystem path appeared during validation",
          {
            path: missingPath.diagnosticPath,
            ...(missingPath.skillName ? { skill_name: missingPath.skillName } : {}),
          },
        ),
      );
      skills.length = 0;
      break;
    }
  }

  const changedDirectory = await firstChangedDirectory(directorySnapshots);
  if (changedDirectory) {
    errors.push(
      authoringDiagnostic(
        "error",
        "archive_unsafe",
        "directory changed before the project snapshot completed",
        {
          path: changedDirectory.diagnosticPath,
          ...(changedDirectory.skillName ? { skill_name: changedDirectory.skillName } : {}),
        },
      ),
    );
    skills.length = 0;
  }

  const changedFile = changedDirectory ? null : await firstChangedFile(fileSnapshots);
  if (changedFile) {
    errors.push(
      authoringDiagnostic(
        "error",
        "archive_unsafe",
        "file changed before the project snapshot completed",
        {
          path: changedFile.diagnosticPath,
          ...(changedFile.skillName ? { skill_name: changedFile.skillName } : {}),
        },
      ),
    );
    skills.length = 0;
  }

  if (await firstAppearedFile(snapshot.missingFileSnapshots)) {
    errors.push(
      authoringDiagnostic(
        "error",
        "archive_unsafe",
        "configuration file appeared before the project snapshot completed",
        { path: "remote-skills.json" },
      ),
    );
    skills.length = 0;
  }

  if (strict && warnings.length > 0) {
    errors.push(
      ...warnings.map((item) =>
        authoringDiagnostic("error", item.code, item.message, { ...item.context }),
      ),
    );
    warnings.length = 0;
  }
  return { valid: errors.length === 0, skills, errors, warnings };
}

/**
 * A supplied snapshot transfers ownership to validation and is closed before this promise settles.
 * @param {{
 *   projectDir: string;
 *   config?: AuthoringConfig;
 *   strict?: boolean;
 *   snapshot?: AuthoringProjectSnapshot;
 * }} options
 */
export async function validateAuthoringProject(options: {
  projectDir: string;
  config?: AuthoringConfig;
  strict?: boolean;
  snapshot?: AuthoringProjectSnapshot;
}) {
  /** @type {{snapshot: AuthoringProjectSnapshot | null | undefined}} */
  const ownership: { snapshot: AuthoringProjectSnapshot | null | undefined } = {
    snapshot: options.snapshot,
  };
  /** @type {Awaited<ReturnType<typeof validateAuthoringProjectWithinSnapshot>> | undefined} */
  let result: Awaited<ReturnType<typeof validateAuthoringProjectWithinSnapshot>> | undefined;
  try {
    result = await validateAuthoringProjectWithinSnapshot(options, ownership);
    return result;
  } finally {
    const snapshot = ownership.snapshot;
    if (
      snapshot &&
      !snapshot.closed &&
      !(await closeAuthoringProjectSnapshot(snapshot)) &&
      result
    ) {
      result.errors.push(
        authoringDiagnostic("error", "archive_unsafe", "project snapshot could not close safely", {
          path: ".",
        }),
      );
      result.skills.length = 0;
      result.valid = false;
    }
  }
}

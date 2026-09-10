// @ts-check

import { constants as bufferConstants } from "node:buffer";
import { createHash } from "node:crypto";
import type { Dir } from "node:fs";
import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { lstat, open, opendir } from "node:fs/promises";
import path from "node:path";
import { validatePublishedArtifact } from "./archive-validation.ts";
import { DISCOVERY_SCHEMA, encodeCatalogBounded } from "./catalog-json.ts";
import { buildLimit, invalidBuild } from "./errors.ts";
import { compareReleaseDescriptors, parseStrictSemVer } from "./semver.ts";

const ARTIFACT_URL = /^artifacts\/sha256-(?<digest>[0-9a-f]{64})\.(?<extension>md|tar\.gz|zip)$/u;
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const MIN_ARTIFACT_URL_BYTES = Buffer.byteLength(`artifacts/sha256-${"0".repeat(64)}.md`);

type ParsedRelease = {
  version: string;
  type: "skill-md" | "archive";
  url: string;
  digest: string;
  parsedVersion: import("./semver.ts").ParsedSemVer;
};
export type ParsedPriorEntry = {
  name: string;
  description: string;
  type: "skill-md" | "archive";
  url: string;
  digest: string;
  extension?: { version: string; releases: ParsedRelease[] };
};

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** @param {Record<string, unknown>} value @param {string[]} expected */
function hasExactKeys(value: Record<string, unknown>, expected: string[]) {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

/** @param {Record<string, unknown>} value @param {string[]} expected */
function hasExactKeyOrder(value: Record<string, unknown>, expected: string[]) {
  const actual = Object.keys(value);
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

type PriorDirectoryAnchor = {
  path: string;
  stats: import("node:fs").BigIntStats;
  handle: import("node:fs/promises").FileHandle | undefined;
  directory: import("node:fs").Dir | undefined;
};
type PriorAnchorState = {
  verify: (preparedOutputDir?: string) => Promise<void>;
  close: () => Promise<void>;
};
type PriorArtifactSource = {
  source: string;
  descriptor: { type: "skill-md" | "archive"; url: string; digest: string; skillName: string };
  prior: PriorAnchorState;
};

/** @param {import("node:fs").BigIntStats} left @param {import("node:fs").BigIntStats} right */
function sameFileGeneration(
  left: import("node:fs").BigIntStats,
  right: import("node:fs").BigIntStats,
) {
  return (
    left.isFile() &&
    right.isFile() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
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
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

/** @param {string} parent @param {string} child */
function isWithin(parent: string, child: string) {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}

/** @param {string} target @returns {Promise<PriorDirectoryAnchor>} */
async function retainDirectory(target: string): Promise<PriorDirectoryAnchor> {
  const stats = await lstat(target, { bigint: true });
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw invalidBuild("prior output contains a non-directory or symlinked boundary", {
      field: "priorOutput",
    });
  }
  let handle: FileHandle | undefined;
  let directory: Dir | undefined;
  try {
    handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
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
  try {
    const opened = handle
      ? await handle.stat({ bigint: true })
      : await lstat(target, { bigint: true });
    const current = await lstat(target, { bigint: true });
    if (!sameDirectoryGeneration(stats, opened) || !sameDirectoryGeneration(opened, current)) {
      throw invalidBuild("prior output directory ancestry changed while it was anchored", {
        field: "priorOutput",
      });
    }
    return { path: target, stats, handle, directory };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await directory?.close().catch(() => undefined);
    throw error;
  }
}

/** @param {PriorDirectoryAnchor[]} anchors */
async function verifyPriorAnchors(anchors: PriorDirectoryAnchor[]) {
  for (const anchor of anchors) {
    const opened = anchor.handle
      ? await anchor.handle.stat({ bigint: true })
      : await lstat(anchor.path, { bigint: true });
    const current = await lstat(anchor.path, { bigint: true });
    if (
      !sameDirectoryGeneration(anchor.stats, opened) ||
      !sameDirectoryGeneration(opened, current)
    ) {
      throw invalidBuild("prior output directory ancestry changed during the build", {
        field: "priorOutput",
      });
    }
  }
}

/**
 * Output preparation may create configured output components beneath shared prior ancestors.
 * Re-arm only those ancestor generations after verifying every retained identity and every
 * unrelated prior generation. All subsequent reads return to strict generation verification.
 * @param {PriorDirectoryAnchor[]} anchors
 * @param {string} outputDir
 */
async function rearmAfterOutputPreparation(anchors: PriorDirectoryAnchor[], outputDir: string) {
  for (const anchor of anchors) {
    const opened = anchor.handle
      ? await anchor.handle.stat({ bigint: true })
      : await lstat(anchor.path, { bigint: true });
    const current = await lstat(anchor.path, { bigint: true });
    const outputDescendsFromAnchor = isWithin(anchor.path, outputDir);
    const matchesSnapshot = outputDescendsFromAnchor
      ? sameDirectoryIdentity(anchor.stats, opened)
      : sameDirectoryGeneration(anchor.stats, opened);
    if (!matchesSnapshot || !sameDirectoryGeneration(opened, current)) {
      throw invalidBuild("prior output directory ancestry changed during output preparation", {
        field: "priorOutput",
      });
    }
    if (outputDescendsFromAnchor) anchor.stats = opened;
  }
}

/** @param {PriorDirectoryAnchor[]} anchors */
async function closePriorAnchors(anchors: PriorDirectoryAnchor[]) {
  let firstError: unknown;
  for (const anchor of [...anchors].reverse()) {
    try {
      if (anchor.handle) await anchor.handle.close();
      else await anchor.directory?.close();
    } catch (error) {
      firstError ??= error;
    }
  }
  if (firstError) {
    throw invalidBuild("prior output directory anchors could not be closed safely", {
      field: "priorOutput",
    });
  }
}

/** @param {string} target @param {number} maximum @param {PriorAnchorState} prior */
async function boundedDirectoryNames(target: string, maximum: number, prior: PriorAnchorState) {
  await prior.verify();
  const directory = await opendir(target);
  const names = [];
  try {
    while (true) {
      const entry = await directory.read();
      if (entry === null) break;
      names.push(entry.name);
      if (names.length > maximum) {
        throw invalidBuild("prior output contains unexpected filesystem entries", {
          field: "priorOutput",
        });
      }
    }
  } finally {
    await directory.close().catch(() => undefined);
  }
  await prior.verify();
  names.sort();
  return names;
}

/** @param {string} target @param {number} byteLimit @param {PriorAnchorState} prior */
async function readBoundedRegularFile(target: string, byteLimit: number, prior: PriorAnchorState) {
  const noFollow = constants.O_NOFOLLOW ?? 0;
  let handle: FileHandle | undefined;
  try {
    await prior.verify();
    handle = await open(target, constants.O_RDONLY | noFollow);
    const before = await handle.stat({ bigint: true });
    const beforePath = await lstat(target, { bigint: true });
    const size = Number(before.size);
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      !sameFileGeneration(before, beforePath) ||
      !Number.isSafeInteger(size) ||
      size < 0
    ) {
      throw invalidBuild("prior output file is not a trusted single regular file", {
        field: "priorOutput",
      });
    }
    await prior.verify();
    if (size > byteLimit || size > bufferConstants.MAX_LENGTH) {
      throw buildLimit("prior output file exceeds a configured limit", { limit: byteLimit });
    }
    const bytes = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const result = await handle.read(bytes, offset, size - offset, offset);
      if (result.bytesRead === 0)
        throw invalidBuild("prior output file changed while reading", { field: "priorOutput" });
      offset += result.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const afterPath = await lstat(target, { bigint: true });
    if (!sameFileGeneration(before, after) || !sameFileGeneration(after, afterPath)) {
      throw invalidBuild("prior output file changed while reading", { field: "priorOutput" });
    }
    await prior.verify();
    return bytes;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ELOOP") {
      throw invalidBuild("prior output file must not be a symlink", { field: "priorOutput" });
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Independently re-read, digest, and validate a retained artifact immediately before publication.
 * @param {PriorArtifactSource} retained
 * @param {{archiveBytes: number, files: number, fileBytes: number, extractedBytes: number}} limits
 */
export async function readVerifiedPriorArtifact(
  retained: PriorArtifactSource,
  limits: { archiveBytes: number; files: number; fileBytes: number; extractedBytes: number },
) {
  const { source, descriptor, prior } = retained;
  await prior.verify();
  const byteLimit =
    descriptor.type === "skill-md"
      ? Math.min(limits.archiveBytes, limits.fileBytes, limits.extractedBytes)
      : limits.archiveBytes;
  const bytes = await readBoundedRegularFile(source, byteLimit, prior);
  if (createHash("sha256").update(bytes).digest("hex") !== descriptor.digest.slice(7)) {
    throw invalidBuild("prior artifact digest or filesystem identity is invalid", {
      field: "priorOutput",
    });
  }
  validatePublishedArtifact(bytes, {
    type: descriptor.type,
    url: descriptor.url,
    skillName: descriptor.skillName,
    limits,
  });
  await prior.verify();
  return bytes;
}

/** @param {unknown} value @returns {ParsedRelease} */
function parseDescriptor(value: unknown): ParsedRelease {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["digest", "type", "url", "version"]) ||
    !hasExactKeyOrder(value, ["version", "type", "url", "digest"])
  ) {
    throw invalidBuild("prior output contains a malformed release descriptor", {
      field: "priorOutput",
    });
  }
  const version = value.version;
  const parsedVersion = parseStrictSemVer(version);
  if (!parsedVersion)
    throw invalidBuild("prior output contains an invalid release version", {
      field: "priorOutput",
    });
  const descriptor = parseArtifactDescriptor(value);
  if (typeof version !== "string") {
    throw invalidBuild("prior output contains an invalid release version", {
      field: "priorOutput",
    });
  }
  return { version, ...descriptor, parsedVersion };
}

/** @param {Record<string, unknown>} value @returns {{type: "skill-md" | "archive", url: string, digest: string}} */
function parseArtifactDescriptor(value: Record<string, unknown>): {
  type: "skill-md" | "archive";
  url: string;
  digest: string;
} {
  if (value.type !== "skill-md" && value.type !== "archive") {
    throw invalidBuild("prior output contains an unsupported artifact type", {
      field: "priorOutput",
    });
  }
  if (typeof value.url !== "string" || typeof value.digest !== "string") {
    throw invalidBuild("prior output contains a malformed artifact descriptor", {
      field: "priorOutput",
    });
  }
  const match = ARTIFACT_URL.exec(value.url);
  if (!match?.groups || value.digest !== `sha256:${match.groups.digest}`) {
    throw invalidBuild("prior output artifact identity is not content-addressed", {
      field: "priorOutput",
    });
  }
  const extension = match.groups.extension;
  if ((value.type === "skill-md") !== (extension === "md")) {
    throw invalidBuild("prior output artifact type and filename disagree", {
      field: "priorOutput",
    });
  }
  return {
    type: value.type,
    url: value.url,
    digest: value.digest,
  };
}

/** @param {unknown} value @returns {ParsedPriorEntry} */
function parseEntry(value: unknown): ParsedPriorEntry {
  if (!isRecord(value))
    throw invalidBuild("prior output contains a malformed skill entry", { field: "priorOutput" });
  const hasExtension = Object.hasOwn(value, "x-remote-skills");
  const expectedKeys = hasExtension
    ? ["description", "digest", "name", "type", "url", "x-remote-skills"]
    : ["description", "digest", "name", "type", "url"];
  const expectedKeyOrder = hasExtension
    ? ["name", "description", "type", "url", "digest", "x-remote-skills"]
    : ["name", "description", "type", "url", "digest"];
  if (!hasExactKeys(value, expectedKeys) || !hasExactKeyOrder(value, expectedKeyOrder)) {
    throw invalidBuild("prior output contains unexpected skill entry fields", {
      field: "priorOutput",
    });
  }
  if (
    typeof value.name !== "string" ||
    !SKILL_NAME.test(value.name) ||
    typeof value.description !== "string" ||
    !value.description.isWellFormed()
  ) {
    throw invalidBuild("prior output contains invalid skill metadata", { field: "priorOutput" });
  }
  const descriptor = parseArtifactDescriptor(value);
  /** @type {ParsedPriorEntry} */
  const entry: ParsedPriorEntry = {
    name: value.name,
    description: value.description,
    ...descriptor,
  };
  if (!hasExtension) return entry;
  const extension = value["x-remote-skills"];
  if (
    !isRecord(extension) ||
    !hasExactKeys(extension, ["releases", "version"]) ||
    !hasExactKeyOrder(extension, ["version", "releases"])
  ) {
    throw invalidBuild("prior output contains a malformed version extension", {
      field: "priorOutput",
    });
  }
  const extensionVersion = extension.version;
  const currentVersion = parseStrictSemVer(extensionVersion);
  if (!currentVersion || !Array.isArray(extension.releases) || extension.releases.length === 0) {
    throw invalidBuild("prior output contains an invalid version extension", {
      field: "priorOutput",
    });
  }
  if (extension.releases.length > 100) {
    throw buildLimit("prior release history exceeds the supported bound", {
      skill_name: value.name,
      limit: 100,
    });
  }
  const releases = extension.releases.map(parseDescriptor);
  const exactVersions = new Set();
  for (const release of releases) {
    if (exactVersions.has(release.version)) {
      throw invalidBuild("prior release history contains a duplicate version", {
        field: "priorOutput",
      });
    }
    exactVersions.add(release.version);
  }
  const sorted = [...releases].sort(compareReleaseDescriptors);
  if (releases.some((release, index) => release.version !== sorted[index]?.version)) {
    throw invalidBuild("prior release history is not deterministically ordered", {
      field: "priorOutput",
    });
  }
  const current = releases.find((release) => release.version === extension.version);
  if (
    !current ||
    current.type !== descriptor.type ||
    current.url !== descriptor.url ||
    current.digest !== descriptor.digest
  ) {
    throw invalidBuild("prior current release does not match the standard entry", {
      field: "priorOutput",
    });
  }
  if (typeof extensionVersion !== "string") {
    throw invalidBuild("prior output contains an invalid current release version", {
      field: "priorOutput",
    });
  }
  entry.extension = { version: extensionVersion, releases };
  return entry;
}

/**
 * @param {{projectDir: string, priorOutputDir: string, catalogBytes: number, archiveBytes: number, files: number, fileBytes: number, extractedBytes: number}} options
 */
export async function verifyPriorOutput(options: {
  projectDir: string;
  priorOutputDir: string;
  catalogBytes: number;
  archiveBytes: number;
  files: number;
  fileBytes: number;
  extractedBytes: number;
}) {
  const projectDir = path.resolve(options.projectDir);
  const priorRoot = path.resolve(projectDir, options.priorOutputDir);
  if (!isWithin(projectDir, priorRoot) || priorRoot === projectDir) {
    throw invalidBuild("prior output must remain below the canonical project", {
      field: "priorOutput",
    });
  }
  const wellKnown = path.join(priorRoot, ".well-known");
  const agentSkills = path.join(wellKnown, "agent-skills");
  const artifacts = path.join(agentSkills, "artifacts");
  const priorRelative = path.relative(projectDir, priorRoot);
  const directoryPaths = [projectDir];
  let current = projectDir;
  for (const component of priorRelative.split(path.sep)) {
    current = path.join(current, component);
    directoryPaths.push(current);
  }
  directoryPaths.push(wellKnown, agentSkills, artifacts);

  /** @type {PriorDirectoryAnchor[]} */
  const anchors: PriorDirectoryAnchor[] = [];
  let closed = false;
  /** @type {PriorAnchorState} */
  const prior: PriorAnchorState = {
    async verify(preparedOutputDir: string | undefined) {
      if (closed) {
        throw invalidBuild("prior output directory anchors are already closed", {
          field: "priorOutput",
        });
      }
      if (preparedOutputDir === undefined) await verifyPriorAnchors(anchors);
      else await rearmAfterOutputPreparation(anchors, preparedOutputDir);
    },
    async close() {
      if (closed) return;
      closed = true;
      await closePriorAnchors(anchors);
    },
  };

  try {
    for (const directoryPath of directoryPaths) {
      anchors.push(await retainDirectory(directoryPath));
    }
    await prior.verify();

    if (
      JSON.stringify(await boundedDirectoryNames(priorRoot, 1, prior)) !==
        JSON.stringify([".well-known"]) ||
      JSON.stringify(await boundedDirectoryNames(wellKnown, 1, prior)) !==
        JSON.stringify(["agent-skills"]) ||
      JSON.stringify(await boundedDirectoryNames(agentSkills, 2, prior)) !==
        JSON.stringify(["artifacts", "index.json"])
    ) {
      throw invalidBuild("prior output does not have the exact publisher layout", {
        field: "priorOutput",
      });
    }

    const indexBytes = await readBoundedRegularFile(
      path.join(agentSkills, "index.json"),
      options.catalogBytes,
      prior,
    );
    let catalog: unknown;
    try {
      catalog = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(indexBytes));
    } catch {
      throw invalidBuild("prior output index is not valid UTF-8 JSON", { field: "priorOutput" });
    }
    if (
      !isRecord(catalog) ||
      !hasExactKeys(catalog, ["$schema", "skills"]) ||
      !hasExactKeyOrder(catalog, ["$schema", "skills"]) ||
      catalog.$schema !== DISCOVERY_SCHEMA ||
      !Array.isArray(catalog.skills)
    ) {
      throw invalidBuild("prior output index is not discovery v0.2.0", { field: "priorOutput" });
    }
    const canonicalIndex = /** @type {Buffer} */ (
      encodeCatalogBounded(catalog.skills, options.catalogBytes)
    );
    if (!indexBytes.equals(canonicalIndex)) {
      throw invalidBuild("prior output index is not canonical publisher JSON", {
        field: "priorOutput",
      });
    }
    const entries = catalog.skills.map(parseEntry);
    const names = new Set();
    for (const [index, entry] of entries.entries()) {
      if (names.has(entry.name) || (index > 0 && (entries[index - 1]?.name ?? "") >= entry.name)) {
        throw invalidBuild("prior output skill names are duplicate or unsorted", {
          field: "priorOutput",
        });
      }
      names.add(entry.name);
    }
    const descriptors = entries.flatMap((entry) =>
      [entry, ...(entry.extension?.releases ?? [])].map((descriptor) => ({
        ...descriptor,
        skillName: entry.name,
      })),
    );
    const expectedUrls = [...new Set(descriptors.map(({ url }) => url))].sort();
    // Publication also retains the entire previous catalog generation, which may have
    // more skills than this one. Each distinct reference consumes at least one artifact
    // URL in that bounded catalog, independently of the per-skill release-history limit.
    const maximumPreviousArtifacts = Math.floor(options.catalogBytes / MIN_ARTIFACT_URL_BYTES);
    const actualArtifactNames = await boundedDirectoryNames(
      artifacts,
      expectedUrls.length + maximumPreviousArtifacts,
      prior,
    );
    const expectedArtifactNames = expectedUrls.map((url) => path.posix.basename(url)).sort();
    if (expectedArtifactNames.some((name) => !actualArtifactNames.includes(name))) {
      throw invalidBuild("prior output artifacts do not exactly match its catalog", {
        field: "priorOutput",
      });
    }
    for (const name of actualArtifactNames) {
      const match = ARTIFACT_URL.exec(`artifacts/${name}`);
      if (!match?.groups) {
        throw invalidBuild("prior output contains an unknown artifact entry", {
          field: "priorOutput",
        });
      }
      const byteLimit =
        match.groups.extension === "md"
          ? Math.min(options.archiveBytes, options.fileBytes, options.extractedBytes)
          : options.archiveBytes;
      const bytes = await readBoundedRegularFile(path.join(artifacts, name), byteLimit, prior);
      if (createHash("sha256").update(bytes).digest("hex") !== match.groups.digest) {
        throw invalidBuild("prior output contains a tampered immutable artifact", {
          field: "priorOutput",
        });
      }
    }

    /** @type {Map<string, PriorArtifactSource>} */
    const artifactSources: Map<string, PriorArtifactSource> = new Map();
    for (const descriptor of descriptors) {
      const source = path.join(agentSkills, ...descriptor.url.split("/"));
      const retained = { source, descriptor, prior };
      // A shared URL does not establish the name-dependent semantics of a later
      // descriptor. Validate every association before deduplicating byte sources.
      await readVerifiedPriorArtifact(retained, options);
      if (artifactSources.has(descriptor.url)) continue;
      artifactSources.set(descriptor.url, retained);
    }

    await prior.verify();
    return { entries, artifactSources, verify: prior.verify, close: prior.close };
  } catch (error) {
    await prior.close().catch(() => undefined);
    if (error instanceof Error && "code" in error && error.code === "limit_exceeded") throw error;
    if (error instanceof Error && "code" in error && error.code === "configuration_invalid") {
      throw error;
    }
    throw invalidBuild("prior output is missing, inaccessible, or unstable", {
      field: "priorOutput",
    });
  }
}

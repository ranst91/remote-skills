// @ts-check

import { constants as bufferConstants } from "node:buffer";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";

import { normalizePortableRelativePath } from "../authoring/paths.ts";
import { encodeTarGzip, encodeZip } from "./archive.ts";
import { encodeCatalogBounded } from "./catalog-json.ts";
import { buildLimit, invalidBuild, PublisherBuildError } from "./errors.ts";
import { readVerifiedPriorArtifact, verifyPriorOutput } from "./prior-output.ts";
import {
  commitIndex,
  prepareStableOutput,
  publishArtifact,
  releaseStableOutput,
} from "./publication.ts";
import { compareReleaseDescriptors, parseStrictSemVer } from "./semver.ts";

type InternalRelease = {
  version: string;
  type: "skill-md" | "archive";
  url: string;
  digest: string;
  parsedVersion: import("./semver.ts").ParsedSemVer;
};
type CurrentEntry = {
  name: string;
  description: string;
  type: "skill-md" | "archive";
  url: string;
  digest: string;
  parsedVersion: import("./semver.ts").ParsedSemVer | null;
};

/** @param {string} parent @param {string} child */
function isWithin(parent: string, child: string) {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}

/** @param {Uint8Array} bytes */
function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** @param {import("../config-schema.ts").PublisherConfig} config */
function requireSafeBuildLimits(config: import("../config-schema.ts").PublisherConfig) {
  for (const [name, value] of Object.entries(config.limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw invalidBuild("build limits must be positive safe integers", {
        field: `limits.${name}`,
      });
    }
    if (name !== "files" && value > bufferConstants.MAX_LENGTH) {
      throw invalidBuild("build byte limits exceed the runtime allocation bound", {
        field: `limits.${name}`,
      });
    }
  }
}

/**
 * Recheck the public validated-snapshot shape and integer bounds before archive allocation.
 * @param {unknown} validation
 * @param {import("../config-schema.ts").PublisherConfig} config
 */
function normalizedSkills(
  validation: unknown,
  config: import("../config-schema.ts").PublisherConfig,
) {
  if (
    validation === null ||
    typeof validation !== "object" ||
    !("valid" in validation) ||
    validation.valid !== true ||
    !("skills" in validation) ||
    !Array.isArray(validation.skills)
  ) {
    throw invalidBuild("build requires a successful validated authoring snapshot", {
      field: "validation",
    });
  }
  const names = new Set();
  /** @type {{name: string, description: string, frontmatter: Record<string, unknown>, files: {path: string, bytes: Uint8Array}[]}[]} */
  const skills: {
    name: string;
    description: string;
    frontmatter: Record<string, unknown>;
    files: { path: string; bytes: Uint8Array }[];
  }[] = [];
  for (const candidate of validation.skills) {
    if (
      candidate === null ||
      typeof candidate !== "object" ||
      !("name" in candidate) ||
      typeof candidate.name !== "string" ||
      !("description" in candidate) ||
      typeof candidate.description !== "string" ||
      !("frontmatter" in candidate) ||
      candidate.frontmatter === null ||
      typeof candidate.frontmatter !== "object" ||
      !("files" in candidate) ||
      !Array.isArray(candidate.files) ||
      names.has(candidate.name)
    ) {
      throw invalidBuild("validated authoring snapshot has an invalid skill shape", {
        field: "validation",
      });
    }
    names.add(candidate.name);
    if (candidate.files.length < 1 || candidate.files.length > config.limits.files) {
      throw buildLimit("validated skill exceeds the configured file-count limit", {
        skill_name: candidate.name,
        limit: "files",
      });
    }
    const paths = new Set();
    let totalBytes = 0;
    const files = [];
    for (const file of candidate.files) {
      if (
        file === null ||
        typeof file !== "object" ||
        !("path" in file) ||
        typeof file.path !== "string" ||
        !("bytes" in file) ||
        !(file.bytes instanceof Uint8Array) ||
        !("size" in file) ||
        typeof file.size !== "number" ||
        !Number.isSafeInteger(file.size) ||
        file.size < 0 ||
        file.size !== file.bytes.byteLength
      ) {
        throw invalidBuild("validated authoring snapshot has an invalid file shape", {
          field: "validation",
        });
      }
      const normalized = normalizePortableRelativePath(file.path);
      if (!normalized || normalized.path !== file.path || paths.has(normalized.collisionKey)) {
        throw invalidBuild("validated authoring snapshot has an unsafe or duplicate path", {
          field: "validation",
        });
      }
      paths.add(normalized.collisionKey);
      if (file.size > config.limits.fileBytes) {
        throw buildLimit("validated file exceeds the configured per-file limit", {
          skill_name: candidate.name,
          limit: "fileBytes",
        });
      }
      totalBytes += file.size;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > config.limits.extractedBytes) {
        throw buildLimit("validated skill exceeds the configured extracted-size limit", {
          skill_name: candidate.name,
          limit: "extractedBytes",
        });
      }
      files.push({ path: file.path, bytes: file.bytes });
    }
    if (!files.some(({ path: filePath }) => filePath === "SKILL.md")) {
      throw invalidBuild("validated skill is missing root SKILL.md", { field: "validation" });
    }
    skills.push({
      name: candidate.name,
      description: candidate.description,
      frontmatter: /** @type {Record<string, unknown>} */ (candidate.frontmatter),
      files,
    });
  }
  skills.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  return skills;
}

/** @param {string} skillName @param {unknown} metadata */
function currentVersion(skillName: string, metadata: unknown) {
  if (metadata === undefined) return null;
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw invalidBuild("metadata.version must be strict SemVer", {
      field: `skills[${skillName}].metadata.version`,
    });
  }
  if (!("version" in metadata)) return null;
  const version = metadata.version;
  if (version === undefined) return null;
  const parsedVersion = parseStrictSemVer(version);
  if (!parsedVersion) {
    throw invalidBuild("metadata.version must be strict SemVer", {
      field: `skills[${skillName}].metadata.version`,
    });
  }
  return parsedVersion;
}

/** @param {InternalRelease} release */
function publicRelease(release: InternalRelease) {
  return {
    version: release.version,
    type: release.type,
    url: release.url,
    digest: release.digest,
  };
}

/** @param {InternalRelease} left @param {InternalRelease} right */
function sameDescriptor(left: InternalRelease, right: InternalRelease) {
  return left.type === right.type && left.url === right.url && left.digest === right.digest;
}

/** @param {unknown} prune */
function normalizedPrune(prune: unknown) {
  if (prune === undefined) return new Map();
  if (prune === null || typeof prune !== "object" || Array.isArray(prune)) {
    throw invalidBuild("prune must map skill names to exact versions", { field: "prune" });
  }
  const result = new Map();
  for (const [skillName, versions] of Object.entries(prune)) {
    if (!Array.isArray(versions))
      throw invalidBuild("prune must map skill names to exact versions", { field: "prune" });
    const exact = new Set();
    for (const version of versions) {
      if (!parseStrictSemVer(version))
        throw invalidBuild("prune versions must be strict SemVer", { field: "prune" });
      exact.add(version);
    }
    result.set(skillName, exact);
  }
  return result;
}

/**
 * @param {string} extension
 * @param {Uint8Array} bytes
 * @param {number} byteLimit
 * @param {string} skillName
 */
function currentArtifact(
  extension: string,
  bytes: Uint8Array,
  byteLimit: number,
  skillName: string,
) {
  if (bytes.byteLength > byteLimit) {
    throw buildLimit("artifact exceeds the configured artifact limit", {
      skill_name: skillName,
      limit: "archiveBytes",
    });
  }
  const digestHex = sha256(bytes);
  const filename = `sha256-${digestHex}.${extension}`;
  return {
    bytes,
    filename,
    url: `artifacts/${filename}`,
    digest: `sha256:${digestHex}`,
  };
}

/**
 * Plan a skill's artifact shape without copying or encoding its bytes.
 * @param {{name: string, description: string, frontmatter: Record<string, unknown>, files: {path: string, bytes: Uint8Array}[]}} skill
 * @param {boolean} forceArchive
 * @param {"tar.gz" | "zip"} format
 */
function planCurrentEntry(
  skill: {
    name: string;
    description: string;
    frontmatter: Record<string, unknown>;
    files: { path: string; bytes: Uint8Array }[];
  },
  forceArchive: boolean,
  format: "tar.gz" | "zip",
): {
  shouldArchive: boolean;
  type: "skill-md" | "archive";
  extension: "md" | "tar.gz" | "zip";
  rootSkillFile: { path: string; bytes: Uint8Array };
  parsedVersion: import("./semver.ts").ParsedSemVer | null;
} {
  const shouldArchive = forceArchive || skill.files.length > 1;
  const type: "skill-md" | "archive" = shouldArchive ? "archive" : "skill-md";
  const extension = shouldArchive ? format : "md";
  const rootSkillFile = skill.files.find(({ path: filePath }) => filePath === "SKILL.md");
  if (!rootSkillFile) {
    throw invalidBuild("validated skill is missing root SKILL.md", { field: "validation" });
  }
  return {
    shouldArchive,
    type,
    extension,
    rootSkillFile,
    parsedVersion: currentVersion(skill.name, skill.frontmatter.metadata),
  };
}

/**
 * Build one final-shape catalog entry. Planned entries skip the digest immutability comparison
 * because their all-zero digest is replaced by an equal-width actual digest after preflight.
 * @param {CurrentEntry} current
 * @param {Map<string, import("./prior-output.ts").ParsedPriorEntry>} priorByName
 * @param {Map<string, Set<string>>} prune
 * @param {{enforceImmutable: boolean, retainedUrls?: Set<string>}} options
 */
function buildCatalogEntry(
  current: CurrentEntry,
  priorByName: Map<string, import("./prior-output.ts").ParsedPriorEntry>,
  prune: Map<string, Set<string>>,
  options: { enforceImmutable: boolean; retainedUrls?: Set<string> },
) {
  const standard = {
    name: current.name,
    description: current.description,
    type: current.type,
    url: current.url,
    digest: current.digest,
  };
  if (!current.parsedVersion) return standard;
  /** @type {InternalRelease} */
  const currentRelease: InternalRelease = {
    version: current.parsedVersion.source,
    type: current.type,
    url: current.url,
    digest: current.digest,
    parsedVersion: current.parsedVersion,
  };
  const priorEntry = priorByName.get(current.name);
  const priorReleases = priorEntry?.extension?.releases ?? [];
  if (options.enforceImmutable) {
    const immutable = priorReleases.find(({ version }) => version === currentRelease.version);
    if (immutable && !sameDescriptor(immutable, currentRelease)) {
      throw invalidBuild("a previously supplied skill version cannot be remapped", {
        field: `skills[${current.name}].metadata.version`,
      });
    }
  }
  const pruned = prune.get(current.name) ?? new Set();
  if (pruned.has(currentRelease.version)) {
    throw invalidBuild("the current release cannot be pruned", { field: "prune" });
  }
  /** @type {Map<string, InternalRelease>} */
  const byVersion: Map<string, InternalRelease> = new Map();
  for (const release of priorReleases) {
    if (!pruned.has(release.version)) byVersion.set(release.version, release);
  }
  byVersion.set(currentRelease.version, currentRelease);
  const releases = [...byVersion.values()].sort(compareReleaseDescriptors);
  if (releases.length > 100) {
    throw buildLimit("release history exceeds the supported bound", {
      skill_name: current.name,
      limit: 100,
    });
  }
  if (options.retainedUrls) {
    for (const release of releases) {
      if (release.url !== currentRelease.url) options.retainedUrls.add(release.url);
    }
  }
  return {
    ...standard,
    "x-remote-skills": {
      version: currentRelease.version,
      releases: releases.map(publicRelease),
    },
  };
}

/**
 * @param {{
 *   projectDir: string;
 *   config: import("../config-schema.ts").PublisherConfig;
 *   validation: unknown;
 *   forceArchive?: boolean;
 *   priorOutputDir?: string;
 *   prune?: Record<string, string[]>;
 * }} options
 */
export async function buildPublisherOutput(options: {
  projectDir: string;
  config: import("../config-schema.ts").PublisherConfig;
  validation: unknown;
  forceArchive?: boolean;
  priorOutputDir?: string;
  prune?: Record<string, string[]>;
}) {
  requireSafeBuildLimits(options.config);
  const requestedProject = path.resolve(options.projectDir);
  const skills = normalizedSkills(options.validation, options.config);
  const prune = normalizedPrune(options.prune);
  for (const skillName of prune.keys()) {
    if (!skills.some((skill) => skill.name === skillName)) {
      throw invalidBuild("prune identifies a skill outside the current build", { field: "prune" });
    }
  }

  let publication: Awaited<ReturnType<typeof prepareStableOutput>> | undefined;
  let prior: Awaited<ReturnType<typeof verifyPriorOutput>> | undefined;
  let primaryError: PublisherBuildError | undefined;
  let result:
    | {
        outputDir: string;
        indexPath: string;
        skills: unknown[];
      }
    | undefined;
  try {
    const projectDir = await realpath(requestedProject);
    const requestedOutput = path.resolve(projectDir, options.config.outDir);
    if (!isWithin(projectDir, requestedOutput) || requestedOutput === projectDir) {
      throw invalidBuild("output directory must remain below the project", { field: "outDir" });
    }
    if (options.priorOutputDir !== undefined) {
      const requestedPrior = path.resolve(requestedProject, options.priorOutputDir);
      let priorRelative: string;
      if (isWithin(requestedProject, requestedPrior) && requestedPrior !== requestedProject) {
        priorRelative = path.relative(requestedProject, requestedPrior);
      } else if (isWithin(projectDir, requestedPrior) && requestedPrior !== projectDir) {
        priorRelative = path.relative(projectDir, requestedPrior);
      } else {
        throw invalidBuild("prior output must remain below the canonical project", {
          field: "priorOutput",
        });
      }
      prior = await verifyPriorOutput({
        projectDir,
        priorOutputDir: path.join(projectDir, priorRelative),
        catalogBytes: options.config.limits.catalogBytes,
        archiveBytes: options.config.limits.archiveBytes,
        files: options.config.limits.files,
        fileBytes: options.config.limits.fileBytes,
        extractedBytes: options.config.limits.extractedBytes,
      });
    }
    const priorByName = new Map<string, import("./prior-output.ts").ParsedPriorEntry>(
      (prior?.entries ?? []).map((entry) => [entry.name, entry]),
    );
    const sentinelHex = "0".repeat(64);
    function* plannedEntries() {
      for (const skill of skills) {
        const plan = planCurrentEntry(skill, options.forceArchive === true, options.config.format);
        yield buildCatalogEntry(
          {
            name: skill.name,
            description: skill.description,
            type: plan.type,
            url: `artifacts/sha256-${sentinelHex}.${plan.extension}`,
            digest: `sha256:${sentinelHex}`,
            parsedVersion: plan.parsedVersion,
          },
          priorByName,
          prune,
          { enforceImmutable: false },
        );
      }
    }
    encodeCatalogBounded(plannedEntries(), options.config.limits.catalogBytes, {
      collect: false,
    });

    const retainedUrls = new Set<string>();
    const catalogEntries: unknown[] = [];
    const currentArtifacts: { filename: string; bytes: Uint8Array }[] = [];
    for (const skill of skills) {
      const plan = planCurrentEntry(skill, options.forceArchive === true, options.config.format);
      const artifactBytes = plan.shouldArchive
        ? options.config.format === "zip"
          ? encodeZip(skill.files, options.config.limits.archiveBytes)
          : encodeTarGzip(skill.files, options.config.limits.archiveBytes)
        : Buffer.from(plan.rootSkillFile.bytes);
      const artifact = currentArtifact(
        plan.extension,
        artifactBytes,
        options.config.limits.archiveBytes,
        skill.name,
      );
      const current: CurrentEntry = {
        name: skill.name,
        description: skill.description,
        type: plan.type,
        ...artifact,
        parsedVersion: plan.parsedVersion,
      };
      currentArtifacts.push(artifact);
      catalogEntries.push(
        buildCatalogEntry(current, priorByName, prune, {
          enforceImmutable: true,
          retainedUrls,
        }),
      );
    }

    const indexBytes = /** @type {Buffer} */ (
      encodeCatalogBounded(catalogEntries, options.config.limits.catalogBytes)
    );
    publication = await prepareStableOutput(projectDir, options.config.outDir, {
      catalogBytes: options.config.limits.catalogBytes,
      archiveBytes: options.config.limits.archiveBytes,
    });
    if (prior) await prior.verify(publication.outputDir);
    const retainedBytes = new Map<string, Uint8Array>();
    if (prior) {
      // An in-place publication changes the prior artifact directory generation.
      // Read only required history, under the existing catalog and artifact bounds,
      // while prior anchors can still verify it; publication verifies these bytes again.
      for (const [url, retained] of prior.artifactSources) {
        if (!retainedUrls.has(url) || path.dirname(retained.source) !== publication.artifactsDir) {
          continue;
        }
        retainedBytes.set(url, await readVerifiedPriorArtifact(retained, options.config.limits));
      }
    }
    for (const artifact of currentArtifacts) {
      await publishArtifact(publication, artifact.filename, artifact.bytes);
    }
    if (prior) {
      for (const [url, retained] of prior.artifactSources) {
        if (!retainedUrls.has(url)) continue;
        const bytes =
          retainedBytes.get(url) ??
          (await readVerifiedPriorArtifact(retained, options.config.limits));
        await publishArtifact(publication, path.posix.basename(url), bytes);
        retainedBytes.delete(url);
      }
    }
    await commitIndex(publication, indexBytes);
    result = {
      outputDir: publication.outputDir,
      indexPath: path.join(publication.agentSkillsDir, "index.json"),
      skills: catalogEntries,
    };
  } catch (error) {
    primaryError =
      error instanceof PublisherBuildError
        ? error
        : new PublisherBuildError("archive_unsafe", "publisher build failed safely", {});
  }

  let cleanupError: unknown;
  if (publication) {
    try {
      await releaseStableOutput(publication);
    } catch (error) {
      cleanupError = error;
    }
  }
  if (prior) {
    try {
      await prior.close();
    } catch (error) {
      cleanupError ??= error;
    }
  }
  if (primaryError) throw primaryError;
  if (cleanupError instanceof PublisherBuildError) throw cleanupError;
  if (cleanupError) {
    throw new PublisherBuildError("archive_unsafe", "publisher build cleanup failed safely", {});
  }
  if (!result) {
    throw new PublisherBuildError("archive_unsafe", "publisher build failed safely", {});
  }
  return result;
}

export { PublisherBuildError } from "./errors.ts";

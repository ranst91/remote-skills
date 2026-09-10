import {
  closeAuthoringProjectSnapshot,
  createAuthoringProjectSnapshot,
  INVALID_CONFIG_PATH,
  isProjectRelativePath,
  normalizePortableRelativePath,
  readAuthoringProjectFile,
  verifyAuthoringProjectSnapshot,
} from "@remote-skills/core/authoring";
import { ConfigValidationError, validateConfig } from "@remote-skills/core/config-schema";

/** @param {string} parent @param {string} candidate */
function portablePathContains(parent: string, candidate: string): boolean {
  return candidate === parent || candidate.startsWith(`${parent}/`);
}

/** @param {string} left @param {string} right */
function portablePathsOverlap(left: string, right: string): boolean {
  const leftPath = normalizePortableRelativePath(left);
  const rightPath = normalizePortableRelativePath(right);
  if (!leftPath || !rightPath) return false;
  return (
    portablePathContains(leftPath.collisionKey, rightPath.collisionKey) ||
    portablePathContains(rightPath.collisionKey, leftPath.collisionKey)
  );
}

export type ConfigOverrides = {
  $schema?: string;
  sourceRoots?: string[];
  outDir?: string;
  format?: "tar.gz" | "zip";
  strict?: boolean;
  limits?: {
    catalogBytes?: number;
    archiveBytes?: number;
    extractedBytes?: number;
    files?: number;
    fileBytes?: number;
  };
  dev?: { host?: string; port?: number };
};

type AuthoringProjectSnapshot = NonNullable<
  Awaited<ReturnType<typeof createAuthoringProjectSnapshot>>
>;

/**
 * A supplied snapshot is borrowed so the caller can bind config loading and validation together.
 * @param {{
 *   projectDir: string;
 *   overrides?: ConfigOverrides;
 *   snapshot?: NonNullable<Awaited<ReturnType<typeof createAuthoringProjectSnapshot>>>;
 * }} options
 */
export async function loadPublisherConfig(options: {
  projectDir: string;
  overrides?: ConfigOverrides;
  snapshot?: AuthoringProjectSnapshot;
}) {
  const overrides = options.overrides ?? {};
  const invalidOverridePaths = [
    ...(overrides.sourceRoots ?? []).filter((sourceRoot) => !isProjectRelativePath(sourceRoot)),
    ...(overrides.outDir !== undefined && !isProjectRelativePath(overrides.outDir)
      ? [overrides.outDir]
      : []),
  ];
  if (invalidOverridePaths.length > 0) {
    throw new ConfigValidationError(
      invalidOverridePaths.map(
        () => `/path must remain inside the project: ${INVALID_CONFIG_PATH}`,
      ),
    );
  }

  const ownsSnapshot = options.snapshot === undefined;
  const snapshot = options.snapshot ?? (await createAuthoringProjectSnapshot(options.projectDir));
  if (!snapshot) {
    throw new ConfigValidationError(["/project must be an accessible directory"]);
  }
  const outcome = await (async () => {
    const configFile = await readAuthoringProjectFile(snapshot, "remote-skills.json", 65_536);
    if (configFile.kind === "limit") {
      throw new ConfigValidationError(["/config exceeds the 65536-byte limit"]);
    }
    if (configFile.kind !== "file" && configFile.kind !== "missing") {
      throw new ConfigValidationError(["/config could not be read safely"]);
    }
    let input: unknown = {};
    if (configFile.kind === "file") {
      try {
        const source = new TextDecoder("utf-8", { fatal: true }).decode(configFile.bytes);
        input = JSON.parse(source);
      } catch {
        throw new ConfigValidationError(["/ must be valid JSON"]);
      }
    }

    const fileConfig = validateConfig(input);
    const merged = validateConfig({
      ...fileConfig,
      ...overrides,
      limits: { ...fileConfig.limits, ...overrides.limits },
      dev: { ...fileConfig.dev, ...overrides.dev },
    });

    const invalidPaths = [
      ...merged.sourceRoots
        .filter((sourceRoot) => !isProjectRelativePath(sourceRoot))
        .map(() => `/sourceRoots path must remain inside the project: ${INVALID_CONFIG_PATH}`),
      ...(!isProjectRelativePath(merged.outDir)
        ? [`/outDir path must remain inside the project: ${INVALID_CONFIG_PATH}`]
        : []),
    ];
    if (
      invalidPaths.length === 0 &&
      merged.sourceRoots.some((sourceRoot) => portablePathsOverlap(sourceRoot, merged.outDir))
    ) {
      invalidPaths.push("/outDir must not overlap sourceRoots");
    }
    if (invalidPaths.length > 0) throw new ConfigValidationError(invalidPaths);

    if (ownsSnapshot && !(await verifyAuthoringProjectSnapshot(snapshot))) {
      throw new ConfigValidationError(["/config could not be read safely"]);
    }

    return merged;
  })().then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  if (ownsSnapshot && !(await closeAuthoringProjectSnapshot(snapshot))) {
    throw new ConfigValidationError(["/config could not be read safely"]);
  }
  if ("error" in outcome) throw outcome.error;
  return outcome.value;
}

import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

import { DiskCache } from "../../../src/cache/index.ts";

const [
  directory,
  artifactPath,
  metadataPath,
  readyPath,
  releasePath,
  publicationStartPath,
  observationCompletePath,
  finishPath,
] = process.argv.slice(2);
if (
  !directory ||
  !artifactPath ||
  !metadataPath ||
  !readyPath ||
  !releasePath ||
  !publicationStartPath ||
  !observationCompletePath ||
  !finishPath
) {
  throw new Error(
    "usage: race-writer <directory> <artifact> <metadata> <ready> <release> <publish> <observed> <finish>",
  );
}

async function waitForFile(path: string): Promise<void> {
  for (;;) {
    try {
      await readFile(path);
      return;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      await delay(2);
    }
  }
}

const parsedMetadata: unknown = JSON.parse(await readFile(metadataPath, "utf8"));
if (
  parsedMetadata === null ||
  typeof parsedMetadata !== "object" ||
  Array.isArray(parsedMetadata)
) {
  throw new TypeError("object metadata must be an object");
}
const metadata = Object.fromEntries(Object.entries(parsedMetadata));
function metadataString(field: string): string {
  const value = metadata[field];
  if (typeof value !== "string") throw new TypeError(`object metadata ${field} must be a string`);
  return value;
}
const archiveFormat = metadata.archive_format;
if (archiveFormat !== null && typeof archiveFormat !== "string") {
  throw new TypeError("object metadata archive_format must be a string or null");
}
const artifact = new Uint8Array(await readFile(artifactPath));

const cache = new DiskCache({
  directory,
  coordinationHooks: {
    afterObjectStaging: async () => {
      await writeFile(readyPath, "staged");
      await waitForFile(releasePath);
      process.send?.({ type: "released" });
      await waitForFile(publicationStartPath);
    },
    beforeObjectPublicationCommit: async () => {
      process.send?.({ type: "critical-section" });
      await waitForFile(observationCompletePath);
    },
  },
});
const published = await cache.publishObject({
  digest: metadataString("digest"),
  artifactType: metadataString("artifact_type"),
  archiveFormat,
  artifact,
  files: new Map([["SKILL.md", artifact]]),
  mediaTypes: new Map([["SKILL.md", "text/markdown"]]),
  verifiedAt: metadataString("verified_at"),
  accessedAt: metadataString("accessed_at"),
});
process.send?.({
  type: "published",
  digest: published.metadata.digest,
  verifiedAt: published.metadata.verifiedAt,
});
await waitForFile(finishPath);

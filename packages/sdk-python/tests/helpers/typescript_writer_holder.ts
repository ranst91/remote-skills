import { access, cp, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { DiskCache } from "../../../sdk-typescript/src/cache/index.ts";

async function waitFor(path: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${path}`);
}

const [fixtureRoot, cacheRoot, digest, ready, release] = process.argv.slice(2);
if (!(fixtureRoot && cacheRoot && digest && ready && release)) {
  throw new Error("TypeScript writer holder arguments missing");
}
async function main(
  validFixtureRoot: string,
  validCacheRoot: string,
  validDigest: string,
  validReady: string,
  validRelease: string,
): Promise<void> {
  const sourceRoot = resolve(validCacheRoot, "fixture-source");
  await cp(resolve(validFixtureRoot, "cache-v1"), resolve(sourceRoot, "cache-v1"), {
    recursive: true,
  });
  const source = await new DiskCache({ directory: sourceRoot }).getObject(validDigest);
  if (source === null) throw new Error("fixture object is missing");
  await new DiskCache({
    directory: validCacheRoot,
    coordinationHooks: {
      afterObjectStaging: async () => {
        await writeFile(validReady, "ready");
        await waitFor(validRelease);
      },
    },
  }).publishObject({
    digest: source.metadata.digest,
    artifactType: source.metadata.artifactType,
    archiveFormat: source.metadata.archiveFormat,
    artifact: source.artifact,
    files: source.root,
    mediaTypes: new Map(source.metadata.files.map((file) => [file.path, file.mediaType])),
    verifiedAt: source.metadata.verifiedAt,
    accessedAt: source.metadata.accessedAt,
  });
}

void main(fixtureRoot, cacheRoot, digest, ready, release);

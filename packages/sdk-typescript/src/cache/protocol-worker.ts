import { open, writeFile } from "node:fs/promises";

import { DiskCache } from "./index.ts";

async function waitForMarker(path: string, timeoutMilliseconds = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    try {
      await open(path, "r").then((handle) => handle.close());
      return;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`cache race marker timed out: ${path}`);
}

async function publish(
  fixtureRoot: string,
  cacheRoot: string,
  coordinationRoot: string,
  label: string,
  digest: string,
): Promise<void> {
  const expected = await new DiskCache({ directory: fixtureRoot }).getObject(digest);
  if (expected === null) throw new Error("race fixture object is missing");
  const cache = new DiskCache({
    directory: cacheRoot,
    coordinationHooks: {
      afterObjectStaging: async () => {
        await writeFile(`${coordinationRoot}/ready-${label}`, "ready");
        await waitForMarker(`${coordinationRoot}/start-${label}`);
      },
    },
  });
  const published = await cache.publishObject({
    digest: expected.metadata.digest,
    artifactType: expected.metadata.artifactType,
    archiveFormat: expected.metadata.archiveFormat,
    artifact: expected.artifact,
    files: expected.root,
    mediaTypes: new Map(expected.metadata.files.map((file) => [file.path, file.mediaType])),
    verifiedAt: expected.metadata.verifiedAt,
    accessedAt: expected.metadata.accessedAt,
  });
  try {
    const winner = await open(`${coordinationRoot}/winner`, "wx");
    await winner.writeFile(label);
    await winner.sync();
    await winner.close();
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
  }
  await writeFile(`${coordinationRoot}/result-${label}`, published.metadata.digest);
  await writeFile(`${coordinationRoot}/done-${label}`, "done");
}

function parseArguments(
  arguments_: readonly string[],
): readonly [string, string, string, string, string] {
  if (arguments_.length !== 6 || arguments_[0] !== "--race-publisher") {
    throw new Error("invalid cache protocol worker arguments");
  }
  const [, fixtureRoot, cacheRoot, coordinationRoot, label, digest] = arguments_;
  if (
    fixtureRoot === undefined ||
    cacheRoot === undefined ||
    coordinationRoot === undefined ||
    label === undefined ||
    digest === undefined
  ) {
    throw new Error("invalid cache protocol worker arguments");
  }
  return [fixtureRoot, cacheRoot, coordinationRoot, label, digest];
}

export async function main(): Promise<void> {
  await publish(...parseArguments(process.argv.slice(2)));
}

await main();

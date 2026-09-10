import { access, writeFile } from "node:fs/promises";

import { DiskCache } from "../../../sdk-typescript/src/cache/index.ts";

const [cacheRoot, digest, ready, release, pauseMode, pauseEntered, pauseResume] =
  process.argv.slice(2);
if (!(cacheRoot && digest && ready && release)) throw new Error("lease holder arguments missing");

const cache = new DiskCache({
  directory: cacheRoot,
  now: () => new Date("2026-08-25T10:00:00.000Z"),
  leaseExpirySeconds: 1,
  renewIntervalSeconds: 0,
  processNonce: "typescript-mixed-live",
  coordinationHooks: {
    ...(pauseMode === "turn" && pauseEntered !== undefined && pauseResume !== undefined
      ? {
          beforeMutationTurnState: async () => {
            await waitAtPausePoint(pauseEntered, pauseResume, "TypeScript mutation-turn" as const);
          },
        }
      : {}),
    ...(pauseMode === "prepublish" && pauseEntered !== undefined && pauseResume !== undefined
      ? {
          afterObjectGenerationGuardOpen: async () => {
            await waitAtPausePoint(pauseEntered, pauseResume, "TypeScript prepublication" as const);
          },
        }
      : {}),
  },
});

async function waitAtPausePoint(entered: string, resume: string, label: string): Promise<void> {
  await writeFile(entered, "paused", "utf8");
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      await access(resume);
      break;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      if (Date.now() >= deadline) throw new Error(`${label} resume timed out`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}

async function main(validDigest: string, validReady: string, validRelease: string): Promise<void> {
  const lease = await cache.acquireLease(validDigest, "typescript-mixed-session");
  await writeFile(validReady, "ready", "utf8");
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      await access(validRelease);
      break;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      if (Date.now() >= deadline)
        throw new Error("TypeScript mixed-runtime lease release timed out");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  await lease.release();
}

void main(digest, ready, release);

import { access, writeFile } from "node:fs/promises";
import { basename } from "node:path";

import { DiskCache } from "../../../src/cache/index.ts";

const [cacheRoot, paused, resume, resultPath] = process.argv.slice(2);
if (!(cacheRoot && paused && resume && resultPath)) {
  throw new Error("TypeScript eviction pauser arguments missing");
}

const cache = new DiskCache({
  directory: cacheRoot,
  maxBytes: 0,
  maxAgeSeconds: 0,
  renewIntervalSeconds: 0,
  coordinationHooks: {
    beforeDirectoryRemoval: async (path) => {
      if (!basename(path).startsWith("evict-")) return;
      await writeFile(paused, "paused", "utf8");
      const deadline = Date.now() + 15_000;
      for (;;) {
        try {
          await access(resume);
          break;
        } catch (error) {
          if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
            throw error;
          }
          if (Date.now() >= deadline) throw new Error("TypeScript eviction resume timed out");
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      }
    },
  },
});
const result = await cache.evict();
await writeFile(
  resultPath,
  JSON.stringify({ removed: result.evicted, pinned: result.retainedPinned }),
  "utf8",
);

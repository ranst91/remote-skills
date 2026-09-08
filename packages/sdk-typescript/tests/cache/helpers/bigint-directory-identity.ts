import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import { mock } from "node:test";

const digest = "sha256:e4bb9c0cb022778c3e22703220eb387a5405b2025dad77b870291fc692c4e21d";
const firstGeneration = 9_007_199_254_740_992n;
const replacementGeneration = 9_007_199_254_740_993n;
assert.equal(Number(firstGeneration), Number(replacementGeneration));

let replaced = false;
let openedHandles = 0;
let closedHandles = 0;

function identityFor(path: string): bigint {
  return path.endsWith(digest.slice(9))
    ? replaced
      ? replacementGeneration
      : firstGeneration
    : BigInt(path.length + 100);
}

function syntheticDirectoryStats(path: string, bigint: boolean) {
  const identity = identityFor(path);
  const value = bigint ? identity : Number(identity);
  return {
    dev: bigint ? 1n : 1,
    ino: value,
    mode: bigint ? 16_877n : 16_877,
    ctimeNs: bigint ? 1n : undefined,
    mtimeNs: bigint ? 1n : undefined,
    nlink: bigint ? 1n : 1,
    isDirectory: () => true,
    isSymbolicLink: () => false,
  };
}

mock.module("node:fs/promises", {
  namedExports: {
    ...fsPromises,
    lstat: async (path: string, options?: { bigint?: boolean }) =>
      syntheticDirectoryStats(path, options?.bigint === true),
    open: async (path: string) => {
      openedHandles += 1;
      return {
        stat: async (options?: { bigint?: boolean }) =>
          syntheticDirectoryStats(path, options?.bigint === true),
        close: async () => {
          closedHandles += 1;
        },
      };
    },
  },
});

interface BigIntGenerationGuard {
  directories: readonly {
    identity: { dev: bigint; ino: bigint; mode: bigint };
  }[];
}

interface BigIntCache {
  closeObjectGenerationGuard(guard: BigIntGenerationGuard): Promise<void>;
  openObjectGenerationGuard(digest: string): Promise<BigIntGenerationGuard | undefined>;
  validateObjectGenerationGuard(guard: BigIntGenerationGuard): Promise<void>;
}

interface BigIntCacheModule {
  DiskCache: new (options: { directory: string; renewIntervalSeconds: number }) => BigIntCache;
}

function isBigIntCacheModule(value: unknown): value is BigIntCacheModule {
  return typeof value === "object" && value !== null && "DiskCache" in value;
}

const moduleUrl = new URL("../../../src/cache/disk-cache.ts", import.meta.url);
moduleUrl.search = "bigint-identity-collision";
const loaded: unknown = await import(moduleUrl.href);
assert.ok(isBigIntCacheModule(loaded));
const { DiskCache } = loaded;
const cache = new DiskCache({ directory: "/cache", renewIntervalSeconds: 0 });
const guard = await cache.openObjectGenerationGuard(digest);
assert.ok(guard);
for (const directory of guard.directories) {
  assert.equal(typeof directory.identity.dev, "bigint");
  assert.equal(typeof directory.identity.ino, "bigint");
  assert.equal(typeof directory.identity.mode, "bigint");
}

replaced = true;
await assert.rejects(
  cache.validateObjectGenerationGuard(guard),
  (error) => error instanceof Error && "code" in error && error.code === "cache_corrupt",
);
await cache.closeObjectGenerationGuard(guard);
assert.equal(closedHandles, openedHandles);

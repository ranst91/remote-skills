import type { NormalizedActivationLimits } from "../activation/types.ts";
import { RemoteSkillsError } from "../catalog/errors.ts";
import { DiskCache, type DiskCacheOptions } from "./disk-cache.ts";
import { CacheConfigurationError } from "./errors.ts";
import { MemoryCache, type MemoryCacheOptions } from "./memory-cache.ts";
import type { CacheBackend } from "./types.ts";

export type CacheSelection = "disk" | "memory" | CacheBackend;

export function resolveCache(
  selection: CacheSelection = "disk",
  options: DiskCacheOptions | MemoryCacheOptions = {},
  limits?: NormalizedActivationLimits,
): CacheBackend {
  if ((selection === "disk" || selection === "memory") && limits !== undefined) {
    const required = {
      maxArtifactBytes: limits.archiveBytes,
      maxExtractedBytes: limits.extractedBytes,
      maxExtractedFileBytes: limits.fileBytes,
      maxFilesPerObject: limits.files,
    };
    for (const key of Object.keys(required) as (keyof typeof required)[]) {
      const override = options[key];
      if (override !== undefined && override < required[key]) {
        throw new RemoteSkillsError("configuration_invalid", { field: `cacheOptions.${key}` });
      }
      required[key] = override ?? required[key];
    }
    // Capacity and age govern eviction, independently of per-object admission.
    options = { ...options, ...required };
  }
  if (selection === "disk") return new DiskCache(options as DiskCacheOptions);
  if (selection === "memory") return new MemoryCache(options as MemoryCacheOptions);
  const requiredMethods = [
    "getCatalog",
    "getCatalogState",
    "putCatalog",
    "replaceCatalog",
    "deleteCatalog",
    "getObject",
    "publishObject",
    "acquireLease",
    "evict",
    "cleanup",
  ];
  if (
    selection === null ||
    typeof selection !== "object" ||
    !requiredMethods.every(
      (method) => typeof selection[method as keyof CacheBackend] === "function",
    )
  ) {
    throw new CacheConfigurationError("cache");
  }
  return selection;
}

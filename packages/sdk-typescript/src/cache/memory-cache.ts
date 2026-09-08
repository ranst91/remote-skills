import { randomBytes, randomUUID } from "node:crypto";

import {
  CacheConfigurationError,
  CacheCorruptError,
  requireFiniteLimit,
  requireSafeNonce,
} from "./errors.ts";
import {
  canonicalOriginIdentifier,
  catalogAbsenceGeneration,
  sanitizeCanonicalUrl,
} from "./paths.ts";
import {
  CACHE_LAYOUT_NAMESPACE,
  type CacheBackend,
  type CacheClock,
  type CachedCatalog,
  type CachedObject,
  type CacheLease,
  type CatalogMetadataInput,
  type CatalogState,
  type CleanupResult,
  type EvictionResult,
  type ExtractedContentsVerifier,
  type PublishObjectInput,
} from "./types.ts";
import {
  CACHE_MAX_ARTIFACT_BYTES,
  CACHE_MAX_CATALOG_BODY_BYTES,
  CACHE_MAX_CATALOG_METADATA_BYTES,
  CACHE_MAX_EXTRACTED_BYTES,
  CACHE_MAX_EXTRACTED_FILE_BYTES,
  CACHE_MAX_FILES_PER_OBJECT,
  CACHE_MAX_OBJECT_METADATA_BYTES,
  catalogMetadataWireByteLength,
  compareCatalogMetadataFreshness,
  digestHex,
  isTimestamp,
  objectMetadataWireByteLength,
  sha256,
  snapshotCatalogBody,
  snapshotCatalogMetadataInput,
  snapshotPublishObjectInput,
  validateExtractedContentBinding,
  validatePortablePaths,
} from "./validation.ts";

export type MemoryCacheOptions = {
  maxBytes?: number;
  maxAgeSeconds?: number;
  maxObjectMetadataBytes?: number;
  maxFilesPerObject?: number;
  maxArtifactBytes?: number;
  maxExtractedBytes?: number;
  maxExtractedFileBytes?: number;
  now?: CacheClock;
  verifyExtractedContents?: ExtractedContentsVerifier;
};

function cloneBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes);
}

function cloneObject(value: CachedObject): CachedObject {
  return {
    artifact: cloneBytes(value.artifact),
    root: new Map([...value.root].map(([path, bytes]) => [path, cloneBytes(bytes)])),
    metadata: {
      ...value.metadata,
      files: value.metadata.files.map((file) => ({ ...file })),
    },
  };
}

function objectSize(value: CachedObject): number {
  return value.metadata.artifactBytes + value.metadata.extractedBytes;
}

function catalogSize(value: CachedCatalog): number {
  return (
    value.body.byteLength +
    catalogMetadataWireByteLength(value.metadata.canonicalUrl, value.metadata)
  );
}

function snapshotCatalogValue(
  canonicalUrl: string,
  body: Uint8Array,
  metadata: CatalogMetadataInput,
  maxMetadataBytes: number,
): CachedCatalog {
  const bodySnapshot = snapshotCatalogBody(body);
  const metadataSnapshot = snapshotCatalogMetadataInput(metadata);
  const sanitizedUrl = sanitizeCanonicalUrl(canonicalUrl);
  if (
    catalogMetadataWireByteLength(sanitizedUrl, metadataSnapshot) >
    Math.min(maxMetadataBytes, CACHE_MAX_CATALOG_METADATA_BYTES)
  ) {
    throw new CacheCorruptError("catalog cache metadata exceeds its protocol limit", {
      layout_version: CACHE_LAYOUT_NAMESPACE,
    });
  }
  return {
    body: bodySnapshot,
    metadata: { canonicalUrl: sanitizedUrl, ...metadataSnapshot },
  };
}

function compareCandidateKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export class MemoryCache implements CacheBackend {
  readonly maxCatalogBytes = CACHE_MAX_CATALOG_BODY_BYTES;
  readonly maxBytes: number;
  readonly maxAgeSeconds: number;
  readonly maxObjectMetadataBytes: number;
  readonly maxFilesPerObject: number;
  readonly maxArtifactBytes: number;
  readonly maxExtractedBytes: number;
  readonly maxExtractedFileBytes: number;
  private readonly now: CacheClock;
  private readonly verifyExtractedContents: ExtractedContentsVerifier | undefined;
  private readonly catalogs = new Map<string, CachedCatalog>();
  private readonly catalogGenerations = new Map<string, string>();
  private catalogEpoch = 0;
  private readonly objects = new Map<string, CachedObject>();
  private readonly leases = new Map<string, Set<string>>();

  constructor(options: MemoryCacheOptions = {}) {
    this.maxBytes = requireFiniteLimit("maxBytes", options.maxBytes ?? 512 * 1024 * 1024, {
      allowZero: true,
    });
    this.maxAgeSeconds = requireFiniteLimit(
      "maxAgeSeconds",
      options.maxAgeSeconds ?? 30 * 24 * 60 * 60,
      { allowZero: true },
    );
    this.maxObjectMetadataBytes = Math.min(
      requireFiniteLimit(
        "maxObjectMetadataBytes",
        options.maxObjectMetadataBytes ?? CACHE_MAX_OBJECT_METADATA_BYTES,
      ),
      CACHE_MAX_OBJECT_METADATA_BYTES,
    );
    this.maxFilesPerObject = requireFiniteLimit(
      "maxFilesPerObject",
      options.maxFilesPerObject ?? CACHE_MAX_FILES_PER_OBJECT,
      { allowZero: true },
    );
    this.maxArtifactBytes = requireFiniteLimit(
      "maxArtifactBytes",
      options.maxArtifactBytes ?? CACHE_MAX_ARTIFACT_BYTES,
      { allowZero: true },
    );
    this.maxExtractedBytes = requireFiniteLimit(
      "maxExtractedBytes",
      options.maxExtractedBytes ?? CACHE_MAX_EXTRACTED_BYTES,
      { allowZero: true },
    );
    this.maxExtractedFileBytes = requireFiniteLimit(
      "maxExtractedFileBytes",
      options.maxExtractedFileBytes ?? CACHE_MAX_EXTRACTED_FILE_BYTES,
      { allowZero: true },
    );
    this.now = options.now ?? (() => new Date());
    this.verifyExtractedContents = options.verifyExtractedContents;
  }

  async putCatalog(
    canonicalUrl: string,
    body: Uint8Array,
    metadata: CatalogMetadataInput,
  ): Promise<void> {
    const candidate = snapshotCatalogValue(
      canonicalUrl,
      body,
      metadata,
      this.maxObjectMetadataBytes,
    );
    for (;;) {
      const expected = await this.getCatalogState(
        candidate.metadata.canonicalUrl,
        candidate.metadata.confirmedScope,
      );
      if (
        expected.catalog !== null &&
        compareCatalogMetadataFreshness(candidate.metadata, expected.catalog.metadata) < 0
      ) {
        return;
      }
      if (await this.replaceCatalog(candidate, expected.generation)) return;
    }
  }

  async replaceCatalog(catalog: CachedCatalog, expectedGeneration: string): Promise<boolean> {
    return this.normalizeOperation(async () => {
      if (!/^sha256:[0-9a-f]{64}$/u.test(expectedGeneration)) {
        throw new CacheConfigurationError("catalogGeneration");
      }
      const candidate = snapshotCatalogValue(
        catalog.metadata.canonicalUrl,
        catalog.body,
        catalog.metadata,
        this.maxObjectMetadataBytes,
      );
      const catalogKey = canonicalOriginIdentifier(
        candidate.metadata.canonicalUrl,
        candidate.metadata.confirmedScope,
      );
      if (this.currentCatalogGeneration(catalogKey) !== expectedGeneration) return false;
      this.advanceCatalogEpoch();
      this.catalogs.set(catalogKey, candidate);
      this.catalogGenerations.set(catalogKey, `sha256:${randomBytes(32).toString("hex")}`);
      return true;
    });
  }

  async getCatalog(canonicalUrl: string, confirmedScope?: string): Promise<CachedCatalog | null> {
    return (await this.getCatalogState(canonicalUrl, confirmedScope)).catalog;
  }

  async getCatalogState(canonicalUrl: string, confirmedScope?: string): Promise<CatalogState> {
    return this.normalizeOperation(async () => {
      const catalogKey = canonicalOriginIdentifier(canonicalUrl, confirmedScope);
      const catalog = this.catalogs.get(catalogKey);
      return {
        catalog:
          catalog === undefined
            ? null
            : { body: cloneBytes(catalog.body), metadata: { ...catalog.metadata } },
        generation: this.currentCatalogGeneration(catalogKey),
      };
    });
  }

  async deleteCatalog(
    canonicalUrl: string,
    confirmedScope: string | undefined,
    expectedGeneration: string,
  ): Promise<boolean> {
    return this.normalizeOperation(async () => {
      if (!/^sha256:[0-9a-f]{64}$/u.test(expectedGeneration)) {
        throw new CacheConfigurationError("catalogGeneration");
      }
      const catalogKey = canonicalOriginIdentifier(canonicalUrl, confirmedScope);
      if (this.currentCatalogGeneration(catalogKey) !== expectedGeneration) return false;
      if (!this.catalogs.has(catalogKey)) return false;
      this.advanceCatalogEpoch();
      this.catalogs.delete(catalogKey);
      this.catalogGenerations.delete(catalogKey);
      return true;
    });
  }

  async publishObject(input: PublishObjectInput): Promise<CachedObject> {
    const digest =
      input !== null && typeof input === "object" && typeof input.digest === "string"
        ? input.digest
        : undefined;
    return this.normalizeOperation(async () => {
      const snapshot = snapshotPublishObjectInput(input, {
        maxArtifactBytes: this.maxArtifactBytes,
        maxExtractedBytes: this.maxExtractedBytes,
        maxExtractedFileBytes: this.maxExtractedFileBytes,
        maxFiles: this.maxFilesPerObject,
      });
      const hex = digestHex(snapshot.digest);
      if (sha256(snapshot.artifact) !== hex) {
        throw this.corrupt(snapshot.digest);
      }
      const paths = validatePortablePaths(snapshot.files.keys());
      if (paths.length !== snapshot.mediaTypes.size) throw this.corrupt(snapshot.digest);
      const root = new Map<string, Uint8Array>();
      const files = paths.map((path) => {
        const bytes = snapshot.files.get(path);
        const mediaType = snapshot.mediaTypes.get(path);
        if (bytes === undefined || mediaType === undefined) throw this.corrupt(snapshot.digest);
        root.set(path, cloneBytes(bytes));
        return { path, size: bytes.byteLength, mediaType };
      });
      const verifiedAt = snapshot.verifiedAt ?? this.now().toISOString();
      const accessedAt = snapshot.accessedAt ?? verifiedAt;
      if (!isTimestamp(verifiedAt) || !isTimestamp(accessedAt)) throw this.corrupt(snapshot.digest);
      const object: CachedObject = {
        artifact: cloneBytes(snapshot.artifact),
        root,
        metadata: {
          digest: snapshot.digest,
          artifactType: snapshot.artifactType,
          archiveFormat: snapshot.archiveFormat,
          artifactBytes: snapshot.artifact.byteLength,
          extractedBytes: files.reduce((sum, file) => sum + file.size, 0),
          files,
          verifiedAt,
          accessedAt,
        },
      };
      if (objectMetadataWireByteLength(object.metadata) > this.maxObjectMetadataBytes) {
        throw this.corrupt(snapshot.digest);
      }
      await validateExtractedContentBinding(object, this.verifyExtractedContents);
      const winner = this.objects.get(snapshot.digest);
      if (winner !== undefined) return cloneObject(winner);
      this.objects.set(snapshot.digest, object);
      return cloneObject(object);
    }, digest);
  }

  async getObject(digest: string): Promise<CachedObject | null> {
    return this.normalizeOperation(async () => {
      digestHex(digest);
      const object = this.objects.get(digest);
      if (object === undefined) return null;
      let accessedAt: string;
      try {
        accessedAt = this.now().toISOString();
      } catch {
        throw this.corrupt(digest);
      }
      if (!isTimestamp(accessedAt)) throw this.corrupt(digest);
      if (Date.parse(accessedAt) > Date.parse(object.metadata.accessedAt)) {
        object.metadata.accessedAt = accessedAt;
      }
      return cloneObject(object);
    }, digest);
  }

  async acquireLease(digest: string, sessionNonce: string): Promise<CacheLease> {
    return this.normalizeOperation(async () => {
      digestHex(digest);
      requireSafeNonce("sessionNonce", sessionNonce);
      const digestLeases = this.leases.get(digest) ?? new Set<string>();
      const handleNonce = randomUUID();
      digestLeases.add(handleNonce);
      this.leases.set(digest, digestLeases);
      let released = false;
      return {
        digest,
        renew: async () => {},
        release: async () => {
          if (released) return;
          released = true;
          digestLeases.delete(handleNonce);
          if (digestLeases.size === 0) this.leases.delete(digest);
        },
      };
    }, digest);
  }

  async evict(): Promise<EvictionResult> {
    return this.normalizeOperation(async () => {
      const current = this.now();
      const now = current.getTime();
      if (!Number.isFinite(now) || current.toISOString() !== new Date(now).toISOString()) {
        throw this.corrupt();
      }
      const retainedPinned: string[] = [];
      const evicted: string[] = [];
      const candidates = [
        ...[...this.catalogs.entries()].map(([canonicalUrl, value]) => ({
          kind: "catalog" as const,
          key: canonicalUrl,
          resultKey: `catalog:${sha256(new TextEncoder().encode(canonicalUrl))}`,
          accessedAt: value.metadata.validatedAt,
          bytes: catalogSize(value),
        })),
        ...[...this.objects.values()].map((value) => ({
          kind: "object" as const,
          key: value.metadata.digest,
          resultKey: value.metadata.digest,
          accessedAt: value.metadata.accessedAt,
          bytes: objectSize(value),
        })),
      ].sort(
        (left, right) =>
          Date.parse(left.accessedAt) - Date.parse(right.accessedAt) ||
          compareCandidateKeys(left.resultKey, right.resultKey),
      );
      let totalBytes = candidates.reduce((sum, candidate) => sum + candidate.bytes, 0);
      for (const candidate of candidates) {
        const pinned =
          candidate.kind === "object" && (this.leases.get(candidate.key)?.size ?? 0) > 0;
        if (pinned) {
          retainedPinned.push(candidate.key);
          continue;
        }
        const expired = now - Date.parse(candidate.accessedAt) > this.maxAgeSeconds * 1_000;
        if (!expired && totalBytes <= this.maxBytes) continue;
        if (candidate.kind === "catalog") {
          this.advanceCatalogEpoch();
          this.catalogs.delete(candidate.key);
          this.catalogGenerations.delete(candidate.key);
        } else this.objects.delete(candidate.key);
        totalBytes -= candidate.bytes;
        evicted.push(candidate.resultKey);
      }
      return { evicted, retainedPinned, totalBytes };
    });
  }

  async cleanup(): Promise<CleanupResult> {
    return this.normalizeOperation(async () => ({ removedTemporaryPaths: 0, reclaimedLeases: 0 }));
  }

  private async normalizeOperation<T>(action: () => Promise<T>, digest?: string): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (error instanceof CacheConfigurationError || error instanceof CacheCorruptError) {
        throw error;
      }
      throw this.corrupt(digest);
    }
  }

  private currentCatalogGeneration(catalogKey: string): string {
    const present = this.catalogGenerations.get(catalogKey);
    return present ?? catalogAbsenceGeneration(catalogKey, this.catalogEpoch);
  }

  private advanceCatalogEpoch(): void {
    if (this.catalogEpoch === Number.MAX_SAFE_INTEGER) throw this.corrupt();
    this.catalogEpoch += 1;
  }

  private corrupt(digest?: string): CacheCorruptError {
    return new CacheCorruptError("verified cache object is corrupt", {
      ...(digest === undefined ? {} : { expected_digest: digest }),
      layout_version: CACHE_LAYOUT_NAMESPACE,
    });
  }
}

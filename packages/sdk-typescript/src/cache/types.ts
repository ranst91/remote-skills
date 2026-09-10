export const CACHE_LAYOUT_NAMESPACE = "cache-v1" as const;

export type CacheClock = () => Date;
export type ProcessLiveness = (pid: number, processNonce: string) => boolean | Promise<boolean>;

export type ExtractedContentsVerifier = (object: CachedObject) => boolean | Promise<boolean>;

export type CatalogMetadataInput = {
  confirmedScope?: string;
  etag?: string;
  lastModified?: string;
  cacheControl?: string;
  retrievedAt: string;
  validatedAt: string;
};

export type CatalogMetadata = CatalogMetadataInput & {
  canonicalUrl: string;
};

export type CachedCatalog = {
  body: Uint8Array;
  metadata: CatalogMetadata;
};

export type CatalogState = {
  catalog: CachedCatalog | null;
  generation: string;
};

export type ExtractionFile = {
  path: string;
  size: number;
  mediaType: string;
};

export type ObjectMetadata = {
  digest: string;
  artifactType: string;
  archiveFormat: string | null;
  artifactBytes: number;
  extractedBytes: number;
  files: ExtractionFile[];
  verifiedAt: string;
  accessedAt: string;
};

export type PublishObjectInput = {
  digest: string;
  artifactType: string;
  archiveFormat: string | null;
  artifact: Uint8Array;
  files: ReadonlyMap<string, Uint8Array>;
  mediaTypes: ReadonlyMap<string, string>;
  verifiedAt?: string;
  accessedAt?: string;
};

export type CachedObject = {
  artifact: Uint8Array;
  root: ReadonlyMap<string, Uint8Array>;
  metadata: ObjectMetadata;
};

export type CacheLease = {
  readonly digest: string;
  readonly path?: string;
  renew(): Promise<void>;
  release(): Promise<void>;
};

export type EvictionResult = {
  evicted: string[];
  retainedPinned: string[];
  totalBytes: number;
};

export type CleanupResult = {
  removedTemporaryPaths: number;
  reclaimedLeases: number;
};

export interface CacheBackend {
  /** Optional admission bound; absence leaves custom catalog storage policy independent. */
  readonly maxCatalogBytes?: number;
  getCatalog(canonicalUrl: string, confirmedScope?: string): Promise<CachedCatalog | null>;
  getCatalogState(canonicalUrl: string, confirmedScope?: string): Promise<CatalogState>;
  putCatalog(canonicalUrl: string, body: Uint8Array, metadata: CatalogMetadataInput): Promise<void>;
  replaceCatalog(catalog: CachedCatalog, expectedGeneration: string): Promise<boolean>;
  deleteCatalog(
    canonicalUrl: string,
    confirmedScope: string | undefined,
    expectedGeneration: string,
  ): Promise<boolean>;
  getObject(digest: string): Promise<CachedObject | null>;
  publishObject(input: PublishObjectInput): Promise<CachedObject>;
  acquireLease(digest: string, sessionNonce: string): Promise<CacheLease>;
  evict(): Promise<EvictionResult>;
  cleanup(): Promise<CleanupResult>;
}

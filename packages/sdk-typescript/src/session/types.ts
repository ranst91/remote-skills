import type { ActivatedSkill, ActivationLimits, ActivationPin } from "../activation/index.ts";
import type { DiskCacheOptions, MemoryCacheOptions } from "../cache/index.ts";
import type { CacheSelection } from "../cache/resolve-cache.ts";
import type {
  AggregateCatalog,
  CatalogDefaults,
  CatalogDiscoveryDependencies,
  CatalogEntry,
  CatalogOptions,
  OriginMap,
} from "../catalog/index.ts";

export interface RemoteSkillsConfig {
  readonly origins: OriginMap;
  readonly defaults?: CatalogDefaults;
  readonly cache?: CacheSelection;
  readonly cacheOptions?: DiskCacheOptions | MemoryCacheOptions;
  readonly limits?: ActivationLimits;
}

export type RemoteSkillsDependencies = Omit<CatalogDiscoveryDependencies, "persistentCache"> & {
  readonly sessionNonce?: () => string;
};

export interface SessionMetadata {
  readonly originAlias: string;
  readonly requestedScope?: string;
  readonly confirmedScope?: string;
  readonly stale: boolean;
  readonly staleAgeMs?: number;
}

export type ActivatedSessionSkill = ActivatedSkill & ActivationPin;

export interface RemoteSkillsSession extends AsyncDisposable {
  readonly metadata: SessionMetadata;
  readonly stale: boolean;
  readonly staleAgeMs?: number;
  catalog(): Promise<readonly CatalogEntry[]>;
  activate(name: string, requestedRange?: string): Promise<ActivatedSessionSkill>;
  close(): Promise<void>;
}

export interface RemoteSkillsClient {
  catalog(options?: CatalogOptions): Promise<AggregateCatalog>;
  session(originAlias: string): Promise<RemoteSkillsSession>;
  refresh(originAlias?: string): Promise<void>;
}

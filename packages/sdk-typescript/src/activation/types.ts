import type { CacheBackend, CacheLease } from "../cache/types.ts";
import type { RequestRuntime } from "../catalog/http.ts";
import type { CatalogEntry, CatalogRelease, OriginCatalog } from "../catalog/types.ts";
import type { NormalizedOrigin } from "../origin.ts";

export const DEFAULT_ACTIVATION_LIMITS = Object.freeze({
  archiveBytes: 50 * 1_024 * 1_024,
  extractedBytes: 100 * 1_024 * 1_024,
  files: 1_000,
  fileBytes: 10 * 1_024 * 1_024,
});

export interface ActivationLimits {
  readonly archiveBytes?: number;
  readonly extractedBytes?: number;
  readonly files?: number;
  readonly fileBytes?: number;
}

export interface NormalizedActivationLimits {
  readonly archiveBytes: number;
  readonly extractedBytes: number;
  readonly files: number;
  readonly fileBytes: number;
}

export interface ActivatedResource {
  readonly path: string;
  readonly size: number;
  readonly media_type: string;
}

export interface ActivatedSkill {
  readonly name: string;
  readonly description: string;
  readonly digest: string;
  readonly version?: string;
  readonly instructions: string;
  readonly frontmatter: Readonly<Record<string, unknown>>;
  list(prefix?: string): Promise<readonly ActivatedResource[]>;
  read(path: string): Promise<string>;
  readBytes(path: string): Promise<Uint8Array>;
}

export interface ActivationPin {
  readonly originAlias: string;
  readonly confirmedScope?: string;
  readonly name: string;
  readonly version?: string;
  readonly descriptor: Readonly<CatalogRelease>;
  readonly digest: string;
}

export interface ActivationResult {
  readonly skill: ActivatedSkill;
  readonly pin: ActivationPin;
  readonly lease: CacheLease;
}

export interface ActivateSkillInput {
  readonly origin: NormalizedOrigin;
  readonly originAlias: string;
  readonly confirmedScope?: string;
  readonly entry: CatalogEntry;
  readonly release?: CatalogRelease;
  readonly cache: CacheBackend;
  readonly sessionNonce: string;
  readonly limits?: ActivationLimits;
}

export type ActivationDependencies = Partial<RequestRuntime>;

export interface ActivationCoordinatorInput {
  readonly origin: NormalizedOrigin;
  readonly catalog: OriginCatalog;
  readonly cache: CacheBackend;
  readonly sessionNonce: string;
  readonly limits?: ActivationLimits;
}

export interface ActivationCoordinator {
  activate(name: string, requestedRange?: string): Promise<ActivatedSkill & ActivationPin>;
  release(): Promise<void>;
}

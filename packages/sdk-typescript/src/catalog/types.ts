export const DISCOVERY_SCHEMA_V0_2 = "https://schemas.agentskills.io/discovery/0.2.0/schema.json";

export type CatalogArtifactType = "archive" | "skill-md";

export interface CatalogRelease {
  readonly version?: string;
  readonly artifactType: CatalogArtifactType;
  readonly url: string;
  readonly digest: string;
}

export interface CatalogEntry extends CatalogRelease {
  readonly originAlias: string;
  readonly name: string;
  readonly description: string;
  readonly releases?: readonly CatalogRelease[];
}

export interface OriginCatalog {
  readonly originAlias: string;
  readonly requestedScope?: string;
  readonly confirmedScope?: string;
  readonly catalogIdentifier?: string;
  readonly persistent?: boolean;
  readonly stale: boolean;
  readonly entries: readonly CatalogEntry[];
}

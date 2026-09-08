import type {
  AggregateCatalog,
  CatalogEntry,
  CatalogFailure,
  OriginCatalog,
  OriginConfig,
} from "../src/catalog/index.ts";

declare const aggregate: AggregateCatalog;
declare const aggregateEntry: AggregateCatalog["entries"][number];
declare const aggregateFailure: AggregateCatalog["failures"][number];
declare const entry: CatalogEntry;
declare const failure: CatalogFailure;
declare const origin: OriginCatalog;
declare const originEntry: OriginCatalog["entries"][number];
declare const release: NonNullable<CatalogEntry["releases"]>[number];

const scopedOrigin = {
  url: "https://skills.example.test",
  scope: "engineering",
} satisfies OriginConfig;
scopedOrigin.scope satisfies string;

// @ts-expect-error Catalog entries are immutable snapshots.
entry.name = "mutated";
// @ts-expect-error Origin catalog metadata is immutable.
origin.stale = true;
// @ts-expect-error Origin catalog snapshot properties are immutable.
origin.entries = [];
// @ts-expect-error Origin catalog entries are deeply immutable.
originEntry.description = "mutated";
// @ts-expect-error Origin catalog arrays are immutable.
origin.entries.push(entry);
// @ts-expect-error Release descriptor arrays are immutable.
entry.releases?.push(release);
// @ts-expect-error Release descriptors are immutable snapshots.
release.digest = "sha256:mutated";
// @ts-expect-error Confirmed scope is immutable catalog metadata.
origin.confirmedScope = "sales";
// @ts-expect-error Aggregate snapshot properties are immutable.
aggregate.entries = [];
// @ts-expect-error Aggregate entry snapshots are deeply immutable.
aggregateEntry.url = "https://mutated.example.test";
// @ts-expect-error Aggregate snapshot properties are immutable.
aggregate.failures = [];
// @ts-expect-error Aggregate failure arrays are immutable.
aggregate.failures.push(failure);
// @ts-expect-error Aggregate failure records are immutable.
aggregateFailure.originAlias = "mutated";

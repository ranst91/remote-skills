import { RemoteSkillsError } from "./errors.ts";
import type { CatalogEntry, CatalogRelease } from "./types.ts";

const MAX_SEMVER_BYTES = 1_024;
const MAX_RANGE_COMPARATORS = 8;
const CORE_NUMBER = "(?:0|[1-9][0-9]*)";
const SEMVER_PATTERN = new RegExp(
  `^(${CORE_NUMBER})\\.(${CORE_NUMBER})\\.(${CORE_NUMBER})(?:-([0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?(?:\\+([0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?$`,
  "u",
);

export interface ParsedSemVer {
  readonly source: string;
  readonly major: string;
  readonly minor: string;
  readonly patch: string;
  readonly prerelease: readonly string[];
}

function compareNumeric(left: string, right: string): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

export function parseStrictSemVer(value: unknown): ParsedSemVer | undefined {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_SEMVER_BYTES) {
    return undefined;
  }
  const match = SEMVER_PATTERN.exec(value);
  if (!match) return undefined;
  const major = match[1];
  const minor = match[2];
  const patch = match[3];
  if (major === undefined || minor === undefined || patch === undefined) return undefined;
  const prerelease = match[4]?.split(".") ?? [];
  if (
    prerelease.some(
      (identifier) =>
        /^[0-9]+$/u.test(identifier) && identifier.length > 1 && identifier.startsWith("0"),
    )
  ) {
    return undefined;
  }
  return {
    source: value,
    major,
    minor,
    patch,
    prerelease,
  };
}

export function compareSemVerPrecedence(left: ParsedSemVer, right: ParsedSemVer): number {
  for (const key of ["major", "minor", "patch"] as const) {
    const comparison = compareNumeric(left[key], right[key]);
    if (comparison !== 0) return comparison;
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    if (left.prerelease.length === right.prerelease.length) return 0;
    return left.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = left.prerelease[index];
    const rightIdentifier = right.prerelease[index];
    if (leftIdentifier === undefined || rightIdentifier === undefined) {
      return leftIdentifier === rightIdentifier ? 0 : leftIdentifier === undefined ? -1 : 1;
    }
    if (leftIdentifier === rightIdentifier) continue;
    const leftNumeric = /^[0-9]+$/u.test(leftIdentifier);
    const rightNumeric = /^[0-9]+$/u.test(rightIdentifier);
    if (leftNumeric && rightNumeric) return compareNumeric(leftIdentifier, rightIdentifier);
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftIdentifier < rightIdentifier ? -1 : 1;
  }
  return 0;
}

export function compareVersionStrings(left: string, right: string): number | undefined {
  const parsedLeft = parseStrictSemVer(left);
  const parsedRight = parseStrictSemVer(right);
  if (!parsedLeft || !parsedRight) return undefined;
  const precedence = compareSemVerPrecedence(parsedLeft, parsedRight);
  if (precedence !== 0) return precedence;
  return left < right ? -1 : left > right ? 1 : 0;
}

type Comparator = {
  operator: "<" | "<=" | ">" | ">=" | "=";
  version: ParsedSemVer;
};

type ParsedRange = {
  comparators: readonly Comparator[];
  prereleaseCores: ReadonlySet<string>;
};

function core(version: ParsedSemVer): string {
  return `${version.major}.${version.minor}.${version.patch}`;
}

function increment(value: string): string {
  return (BigInt(value) + 1n).toString();
}

function stableVersion(major: string, minor: string, patch: string): ParsedSemVer {
  const source = `${major}.${minor}.${patch}`;
  return { source, major, minor, patch, prerelease: [] };
}

function rangeFromComparators(comparators: readonly Comparator[]): ParsedRange {
  return {
    comparators,
    prereleaseCores: new Set(
      comparators
        .filter(({ version }) => version.prerelease.length > 0)
        .map(({ version }) => core(version)),
    ),
  };
}

function parseRange(value: string | undefined): ParsedRange | undefined {
  if (value === undefined || value === "*") return rangeFromComparators([]);
  if (value.length === 0 || value.trim() !== value || Buffer.byteLength(value) > MAX_SEMVER_BYTES) {
    return undefined;
  }

  let match = /^((?:0|[1-9][0-9]*))\.[xX*]$/u.exec(value);
  if (match) {
    const major = match[1];
    if (major === undefined) return undefined;
    return rangeFromComparators([
      { operator: ">=", version: stableVersion(major, "0", "0") },
      { operator: "<", version: stableVersion(increment(major), "0", "0") },
    ]);
  }
  match = /^((?:0|[1-9][0-9]*))\.((?:0|[1-9][0-9]*))\.[xX*]$/u.exec(value);
  if (match) {
    const major = match[1];
    const minor = match[2];
    if (major === undefined || minor === undefined) return undefined;
    return rangeFromComparators([
      { operator: ">=", version: stableVersion(major, minor, "0") },
      { operator: "<", version: stableVersion(major, increment(minor), "0") },
    ]);
  }

  const prefixed = /^([~^])(.*)$/u.exec(value);
  if (prefixed) {
    const baseline = parseStrictSemVer(prefixed[2]);
    if (!baseline) return undefined;
    let upper: ParsedSemVer;
    if (prefixed[1] === "~") {
      upper = stableVersion(baseline.major, increment(baseline.minor), "0");
    } else if (baseline.major !== "0") {
      upper = stableVersion(increment(baseline.major), "0", "0");
    } else if (baseline.minor !== "0") {
      upper = stableVersion("0", increment(baseline.minor), "0");
    } else {
      upper = stableVersion("0", "0", increment(baseline.patch));
    }
    return rangeFromComparators([
      { operator: ">=", version: baseline },
      { operator: "<", version: upper },
    ]);
  }

  const exact = parseStrictSemVer(value);
  if (exact) return rangeFromComparators([{ operator: "=", version: exact }]);

  const members = value.split(" ");
  if (
    members.length === 0 ||
    members.length > MAX_RANGE_COMPARATORS ||
    members.some((member) => member.length === 0)
  ) {
    return undefined;
  }
  const comparators: Comparator[] = [];
  for (const member of members) {
    const comparator = /^(<=|>=|<|>)(.+)$/u.exec(member);
    const version = parseStrictSemVer(comparator?.[2]);
    if (!comparator || !version) return undefined;
    comparators.push({ operator: comparator[1] as Comparator["operator"], version });
  }
  return rangeFromComparators(comparators);
}

function satisfies(version: ParsedSemVer, range: ParsedRange): boolean {
  if (version.prerelease.length > 0 && !range.prereleaseCores.has(core(version))) return false;
  return range.comparators.every((comparator) => {
    const comparison = compareSemVerPrecedence(version, comparator.version);
    switch (comparator.operator) {
      case "<":
        return comparison < 0;
      case "<=":
        return comparison <= 0;
      case ">":
        return comparison > 0;
      case ">=":
        return comparison >= 0;
      case "=":
        return comparison === 0;
    }
    return false;
  });
}

function unavailable(entry: CatalogEntry, requestedRange: string | undefined): never {
  throw new RemoteSkillsError("version_unavailable", {
    origin_alias: entry.originAlias,
    skill_name: entry.name,
    ...(requestedRange === undefined ? {} : { requested_range: requestedRange }),
  });
}

export function selectCatalogRelease(entry: CatalogEntry, requestedRange?: string): CatalogRelease {
  if (entry.version === undefined || entry.releases === undefined) {
    if (requestedRange === undefined || requestedRange === "*") {
      return Object.freeze({
        artifactType: entry.artifactType,
        url: entry.url,
        digest: entry.digest,
      });
    }
    return unavailable(entry, requestedRange);
  }
  const range = parseRange(requestedRange);
  if (!range) return unavailable(entry, requestedRange);
  for (const release of entry.releases) {
    const version = parseStrictSemVer(release.version);
    if (version && satisfies(version, range)) return release;
  }
  return unavailable(entry, requestedRange);
}

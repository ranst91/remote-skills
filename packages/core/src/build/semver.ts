// @ts-check

const STRICT_SEMVER =
  /^(?<major>0|[1-9][0-9]*)\.(?<minor>0|[1-9][0-9]*)\.(?<patch>0|[1-9][0-9]*)(?:-(?<prerelease>(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+(?<build>[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;

export interface ParsedSemVer {
  major: string;
  minor: string;
  patch: string;
  prerelease: string[];
  source: string;
}

/** @param {unknown} value @returns {ParsedSemVer | null} */
export function parseStrictSemVer(value: unknown): ParsedSemVer | null {
  if (typeof value !== "string" || !value.isWellFormed()) return null;
  const match = STRICT_SEMVER.exec(value);
  if (!match?.groups) return null;
  return {
    source: value,
    major: match.groups.major ?? "0",
    minor: match.groups.minor ?? "0",
    patch: match.groups.patch ?? "0",
    prerelease: match.groups.prerelease?.split(".") ?? [],
  };
}

/** @param {string} left @param {string} right */
function compareNumeric(left: string, right: string) {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/**
 * SemVer precedence only; build metadata is intentionally ignored.
 * @param {ParsedSemVer} left
 * @param {ParsedSemVer} right
 */
export function compareSemVerPrecedence(left: ParsedSemVer, right: ParsedSemVer) {
  for (const field of ["major", "minor", "patch"] as const) {
    const comparison = compareNumeric(left[field], right[field]);
    if (comparison !== 0) return comparison;
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    if (left.prerelease.length === right.prerelease.length) return 0;
    return left.prerelease.length === 0 ? 1 : -1;
  }
  const shared = Math.min(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < shared; index += 1) {
    const leftIdentifier = left.prerelease[index] ?? "";
    const rightIdentifier = right.prerelease[index] ?? "";
    if (leftIdentifier === rightIdentifier) continue;
    const leftNumeric = /^[0-9]+$/u.test(leftIdentifier);
    const rightNumeric = /^[0-9]+$/u.test(rightIdentifier);
    if (leftNumeric && rightNumeric) return compareNumeric(leftIdentifier, rightIdentifier);
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftIdentifier < rightIdentifier ? -1 : 1;
  }
  if (left.prerelease.length === right.prerelease.length) return 0;
  return left.prerelease.length < right.prerelease.length ? -1 : 1;
}

/** @param {{version: string, parsedVersion: ParsedSemVer}} left @param {{version: string, parsedVersion: ParsedSemVer}} right */
export function compareReleaseDescriptors(
  left: { version: string; parsedVersion: ParsedSemVer },
  right: { version: string; parsedVersion: ParsedSemVer },
) {
  const precedence = compareSemVerPrecedence(left.parsedVersion, right.parsedVersion);
  if (precedence !== 0) return -precedence;
  if (left.version === right.version) return 0;
  return left.version < right.version ? -1 : 1;
}

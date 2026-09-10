const STRICT_SEMVER =
  /^(?<major>0|[1-9][0-9]*)\.(?<minor>0|[1-9][0-9]*)\.(?<patch>0|[1-9][0-9]*)(?:-(?<prerelease>(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+(?<build>[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;

/** @param {unknown} value */
export function parseStrictSemVer(value: unknown) {
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
function compareNumeric(left: string, right: string): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  return left === right ? 0 : left < right ? -1 : 1;
}

/** @param {NonNullable<ReturnType<typeof parseStrictSemVer>>} left @param {NonNullable<ReturnType<typeof parseStrictSemVer>>} right */
export function compareSemVerPrecedence(
  left: NonNullable<ReturnType<typeof parseStrictSemVer>>,
  right: NonNullable<ReturnType<typeof parseStrictSemVer>>,
): number {
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
    const a = left.prerelease[index] ?? "";
    const b = right.prerelease[index] ?? "";
    if (a === b) continue;
    const aNumeric = /^[0-9]+$/u.test(a);
    const bNumeric = /^[0-9]+$/u.test(b);
    if (aNumeric && bNumeric) return compareNumeric(a, b);
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return a < b ? -1 : 1;
  }
  return left.prerelease.length === right.prerelease.length
    ? 0
    : left.prerelease.length < right.prerelease.length
      ? -1
      : 1;
}

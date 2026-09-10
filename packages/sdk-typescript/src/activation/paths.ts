import { pinnedUnicodeCaseFold } from "../cache/unicode-casefold.ts";
import { RemoteSkillsError } from "../catalog/errors.ts";

const WINDOWS_DRIVE_PREFIX = /^[A-Za-z]:/u;
const WINDOWS_FORBIDDEN = /[<>:"|?*]/u;
const WINDOWS_RESERVED_BASENAME =
  /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM(?:[1-9]|[¹²³])|LPT(?:[1-9]|[¹²³]))$/iu;

function safeSegment(segment: string): boolean {
  if (
    segment.length === 0 ||
    segment === "." ||
    segment === ".." ||
    segment.endsWith(".") ||
    segment.endsWith(" ") ||
    WINDOWS_FORBIDDEN.test(segment) ||
    [...segment].some((character) => {
      const point = character.codePointAt(0);
      return point !== undefined && (point < 0x20 || point === 0x7f);
    })
  )
    return false;
  const basename = segment.split(".", 1)[0]?.replace(/[ .]+$/u, "") ?? "";
  return !WINDOWS_RESERVED_BASENAME.test(basename);
}

export interface NormalizedPath {
  readonly path: string;
  readonly collisionKey: string;
}

export function normalizedArchivePath(rawPath: string): NormalizedPath | null {
  if (
    rawPath.length === 0 ||
    !rawPath.isWellFormed() ||
    rawPath.includes("\0") ||
    rawPath.includes("\\") ||
    rawPath.startsWith("/") ||
    WINDOWS_DRIVE_PREFIX.test(rawPath)
  )
    return null;
  const path = rawPath.normalize("NFC");
  if (path.split("/").some((segment) => !safeSegment(segment))) return null;
  return { path, collisionKey: pinnedUnicodeCaseFold(path) };
}

export function normalizedResourcePath(rawPath: unknown, allowPrefix = false): string {
  if (typeof rawPath !== "string") throw new RemoteSkillsError("path_invalid", {});
  if (allowPrefix && rawPath === "") return "";
  const trailingSlash = allowPrefix && rawPath.endsWith("/");
  const candidate = trailingSlash ? rawPath.slice(0, -1) : rawPath;
  const normalized = normalizedArchivePath(candidate);
  if (normalized === null || normalized.path !== candidate)
    throw new RemoteSkillsError("path_invalid", { path: rawPath });
  return trailingSlash ? `${normalized.path}/` : normalized.path;
}

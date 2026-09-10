// @ts-check

import path from "node:path";

import { unicodeCaseFoldV15 } from "./unicode-case-fold-v15.mjs";

const WINDOWS_DRIVE_PREFIX = /^[A-Za-z]:/u;
const WINDOWS_FORBIDDEN = /[<>:"|?*]/u;
const WINDOWS_RESERVED_BASENAME =
  /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM(?:[1-9]|[¹²³])|LPT(?:[1-9]|[¹²³]))$/iu;

export const INVALID_CONFIG_PATH = "[invalid-path]";

/** @param {string} segment */
function isPortableSegment(segment: string) {
  if (
    segment.length === 0 ||
    segment === "." ||
    segment === ".." ||
    segment.endsWith(".") ||
    segment.endsWith(" ") ||
    WINDOWS_FORBIDDEN.test(segment) ||
    Array.from(segment).some((character) => {
      const point = character.codePointAt(0);
      return point !== undefined && (point < 0x20 || point === 0x7f);
    })
  ) {
    return false;
  }
  const basename = segment.split(".", 1)[0]?.replace(/[ .]+$/u, "") ?? "";
  return !WINDOWS_RESERVED_BASENAME.test(basename);
}

/** @param {string} value */
export function isProjectRelativePath(value: string) {
  const portable = normalizePortableRelativePath(value);
  return (
    portable !== null &&
    portable.path === value &&
    !path.isAbsolute(value) &&
    !path.win32.isAbsolute(value)
  );
}

/**
 * @param {string} value
 * @returns {{path: string, collisionKey: string} | null}
 */
export function normalizePortableRelativePath(
  value: string,
): { path: string; collisionKey: string } | null {
  if (
    value.length === 0 ||
    !value.isWellFormed() ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.startsWith("/") ||
    WINDOWS_DRIVE_PREFIX.test(value)
  ) {
    return null;
  }
  const normalized = value.normalize("NFC");
  const segments = normalized.split("/");
  if (segments.some((segment) => !isPortableSegment(segment))) {
    return null;
  }
  const portablePath = segments.join("/");
  return { path: portablePath, collisionKey: unicodeCaseFoldV15(portablePath) };
}

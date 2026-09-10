import { PublisherVerifyError } from "./verify-errors.ts";
import { compareSemVerPrecedence, parseStrictSemVer } from "./verify-semver.ts";

const SCHEMA = "https://schemas.agentskills.io/discovery/0.2.0/schema.json";
const V01_SCHEMA = "https://schemas.agentskills.io/discovery/0.1/schema.json";
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const EXTENSION_KEYS = new Set(["version", "releases"]);
const RELEASE_KEYS = new Set(["version", "type", "url", "digest"]);

type JsonObject = { [key: string]: unknown };
type ArtifactDescriptor = {
  type: "skill-md" | "archive";
  rawUrl: string;
  url: URL;
  digest: string;
};

/** @param {unknown} value */
function object(value: unknown): JsonObject | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null
    ? Object.fromEntries(Object.entries(value))
    : null;
}

/** @param {string} field @returns {never} */
function invalid(field: string): never {
  throw new PublisherVerifyError("catalog_invalid", { field });
}

/** @param {unknown} value @param {string} field */
function string(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) invalid(field);
  return value;
}

/** @param {string} raw @param {URL} catalogUrl @param {string} field */
function artifactUrl(raw: string, catalogUrl: URL, field: string): URL {
  if (raw !== raw.trim() || /[\\\t\r\n]/u.test(raw) || raw.includes("?") || raw.includes("#"))
    invalid(field);
  let url: URL;
  try {
    url = new URL(raw, catalogUrl);
  } catch {
    invalid(field);
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    invalid(field);
  return url;
}

/** @param {Record<string, unknown>} value @param {URL} catalogUrl @param {string} prefix @param {boolean} allowUnsupported */
function descriptor(
  value: JsonObject,
  catalogUrl: URL,
  prefix: string,
  allowUnsupported: boolean,
): ArtifactDescriptor | null {
  const type = string(value.type, `${prefix}.type`);
  if (type !== "skill-md" && type !== "archive") {
    if (allowUnsupported) return null;
    invalid(`${prefix}.type`);
  }
  const artifactType = type;
  const rawUrl = string(value.url, `${prefix}.url`);
  const rawDigest = string(value.digest, `${prefix}.digest`);
  if (!DIGEST.test(rawDigest)) invalid(`${prefix}.digest`);
  return {
    type: artifactType,
    rawUrl,
    url: artifactUrl(rawUrl, catalogUrl, `${prefix}.url`),
    digest: rawDigest,
  };
}

/** @param {string} previous @param {string} next */
function correctOrder(previous: string, next: string): boolean {
  const a = parseStrictSemVer(previous);
  const b = parseStrictSemVer(next);
  if (!a || !b) return false;
  const precedence = compareSemVerPrecedence(a, b);
  return precedence !== 0 ? precedence > 0 : previous < next;
}

/** @param {unknown} value @param {URL} catalogUrl @param {number} index @param {{type: string, rawUrl: string, url: URL, digest: string}} current */
function extension(value: unknown, catalogUrl: URL, index: number, current: ArtifactDescriptor) {
  if (value === undefined) return null;
  const prefix = `skills[${index}].x-remote-skills`;
  const raw = object(value);
  if (!raw || Object.keys(raw).some((key) => !EXTENSION_KEYS.has(key))) invalid(prefix);
  const version = string(raw.version, `${prefix}.version`);
  if (!parseStrictSemVer(version)) invalid(`${prefix}.version`);
  const rawReleases = raw.releases;
  if (!Array.isArray(rawReleases) || rawReleases.length < 1 || rawReleases.length > 100)
    invalid(`${prefix}.releases`);
  const versions = new Set<string>();
  const releases = rawReleases.map((member, releaseIndex) => {
    const releasePrefix = `${prefix}.releases[${releaseIndex}]`;
    const release = object(member);
    if (
      !release ||
      Object.keys(release).length !== 4 ||
      Object.keys(release).some((key) => !RELEASE_KEYS.has(key))
    )
      invalid(releasePrefix);
    const releaseVersion = string(release.version, `${releasePrefix}.version`);
    if (!parseStrictSemVer(releaseVersion) || versions.has(releaseVersion))
      invalid(`${releasePrefix}.version`);
    versions.add(releaseVersion);
    const parsed = descriptor(release, catalogUrl, releasePrefix, false);
    if (!parsed) invalid(releasePrefix);
    return { version: releaseVersion, ...parsed };
  });
  for (let releaseIndex = 1; releaseIndex < releases.length; releaseIndex += 1) {
    if (
      !correctOrder(
        releases[releaseIndex - 1]?.version ?? "",
        releases[releaseIndex]?.version ?? "",
      )
    )
      invalid(`${prefix}.releases.order`);
  }
  const matching = releases.find((release) => release.version === version);
  if (
    !matching ||
    matching.type !== current.type ||
    matching.rawUrl !== current.rawUrl ||
    matching.digest !== current.digest
  )
    invalid(`${prefix}.releases.current`);
  return { version, releases };
}

/** @param {unknown} value @param {number} index @param {URL} catalogUrl */
function entry(value: unknown, index: number, catalogUrl: URL) {
  const prefix = `skills[${index}]`;
  const raw = object(value);
  if (!raw) invalid(prefix);
  const name = string(raw.name, `${prefix}.name`);
  if (name.length > 64 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(name) || name.includes("--"))
    invalid(`${prefix}.name`);
  const description = string(raw.description, `${prefix}.description`);
  if ([...description].length > 1_024) invalid(`${prefix}.description`);
  const current = descriptor(raw, catalogUrl, prefix, true);
  if (!current) return null;
  return {
    name,
    description,
    ...current,
    extension: extension(raw["x-remote-skills"], catalogUrl, index, current),
  };
}

/** @param {unknown} root @param {number} maxBytes */
function boundedDepth(root: unknown, maxBytes: number): void {
  const pending = [{ value: root, depth: 1 }];
  let visited = 0;
  while (pending.length > 0) {
    const item = pending.pop();
    if (!item) break;
    visited += 1;
    if (item.depth > 64 || visited > maxBytes + 1) invalid("$document");
    if (Array.isArray(item.value))
      for (const value of item.value) pending.push({ value, depth: item.depth + 1 });
    else {
      const raw = object(item.value);
      if (raw)
        for (const value of Object.values(raw)) pending.push({ value, depth: item.depth + 1 });
    }
  }
}

/** @param {Uint8Array} bytes @param {URL} catalogUrl @param {number} [maxBytes] */
export function parseVerifyCatalog(bytes: Uint8Array, catalogUrl: URL, maxBytes = 1_048_576) {
  if (!(bytes instanceof Uint8Array)) invalid("$document");
  if (bytes.byteLength > maxBytes)
    throw new PublisherVerifyError("limit_exceeded", { limit: "catalogBytes" });
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    invalid("$document");
  }
  const raw = object(value);
  if (!raw) invalid("$document");
  boundedDepth(raw, maxBytes);
  if (raw.$schema !== SCHEMA)
    throw new PublisherVerifyError("unsupported_schema", {
      ...(raw.$schema === V01_SCHEMA ? { schema: V01_SCHEMA } : {}),
    });
  const rawSkills = raw.skills;
  if (!Array.isArray(rawSkills)) invalid("skills");
  const names = new Set<string>();
  const entries: NonNullable<ReturnType<typeof entry>>[] = [];
  for (let index = 0; index < rawSkills.length; index += 1) {
    const parsed = entry(rawSkills[index], index, catalogUrl);
    if (!parsed) continue;
    if (names.has(parsed.name)) invalid(`skills[${index}].name`);
    names.add(parsed.name);
    entries.push(parsed);
  }
  return entries;
}

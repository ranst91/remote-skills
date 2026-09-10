import { RemoteSkillsError } from "./errors.ts";
import {
  hasRawUrlUserinfo,
  hasUrlQueryOrFragment,
  isCanonicalRawUrlReference,
} from "./network-policy.ts";
import { compareSemVerPrecedence, parseStrictSemVer } from "./semver.ts";
import {
  type CatalogArtifactType,
  type CatalogEntry,
  type CatalogRelease,
  DISCOVERY_SCHEMA_V0_2,
  type OriginCatalog,
} from "./types.ts";

type JsonPrimitive = boolean | null | number | string;
type JsonValue = JsonObject | JsonPrimitive | readonly JsonValue[];
interface JsonObject {
  readonly [key: string]: JsonValue | undefined;
}

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const DISCOVERY_SCHEMA_V0_1 = "https://schemas.agentskills.io/discovery/0.1/schema.json";
const MAX_CATALOG_BYTES = 1_048_576;
const MAX_RELEASES = 100;
const CATALOG_KEYS = new Set(["$schema", "skills"]);
const ENTRY_KEYS = new Set(["name", "description", "type", "url", "digest", "x-remote-skills"]);
const EXTENSION_KEYS = new Set(["releases", "version"]);
const RELEASE_KEYS = new Set(["digest", "type", "url", "version"]);

function isJsonObject(value: unknown): value is JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function catalogInvalid(originAlias: string, field: string): never {
  throw new RemoteSkillsError("catalog_invalid", { origin_alias: originAlias, field });
}

function validateRecognizedMembers(text: string, originAlias: string): void {
  type Role = "catalog" | "skills" | "entry" | "extension" | "releases" | "release" | "ignored";
  interface Frame {
    kind: "{" | "[";
    role: Role;
    key?: string;
    seen: Set<string>;
  }
  const stack: Frame[] = [];
  let ignoredDepth = 0;
  // Inspect structure and decoded member names before JSON.parse collapses duplicates.
  // JSON.parse remains responsible for syntax; scalar values need no projection here.
  // Sticky matching prevents retrying an incomplete string at later character offsets.
  const tokens = /"(?:[^"\\]|\\[\s\S])*"|[{}[\],:]|[^"\s{}[\],:]+|\s+/guy;
  for (const match of text.matchAll(tokens)) {
    const token = match[0];
    // Ignored values need only balanced traversal here; JSON.parse checks their syntax.
    // The wire byte cap bounds this iterative scan without imposing a semantic depth limit.
    if (ignoredDepth > 0) {
      if (token === "{" || token === "[") ignoredDepth += 1;
      else if (token === "}" || token === "]") ignoredDepth -= 1;
      continue;
    }
    const parent = stack.at(-1);
    if (token === "{" || token === "[") {
      let role: Role = "ignored";
      if (token === "{") {
        if (!parent) role = "catalog";
        else if (parent.role === "skills") role = "entry";
        else if (parent.role === "releases") role = "release";
        else if (parent.role === "entry" && parent.key === "x-remote-skills") role = "extension";
      } else if (parent?.role === "catalog" && parent.key === "skills") {
        role = "skills";
      } else if (parent?.role === "extension" && parent.key === "releases") {
        role = "releases";
      }
      if (role === "ignored") ignoredDepth = 1;
      else stack.push({ kind: token, role, seen: new Set() });
    } else if (token === "}" || token === "]") {
      stack.pop();
    } else if (token === "," && parent) {
      delete parent.key;
    } else if (token.startsWith('"') && parent?.kind === "{" && parent.key === undefined) {
      const key: unknown = JSON.parse(token);
      if (typeof key !== "string") catalogInvalid(originAlias, "$document");
      parent.key = key;
      const recognized =
        parent.role === "catalog"
          ? CATALOG_KEYS
          : parent.role === "entry"
            ? ENTRY_KEYS
            : parent.role === "extension"
              ? EXTENSION_KEYS
              : parent.role === "release"
                ? RELEASE_KEYS
                : undefined;
      if (recognized?.has(key)) {
        if (parent.seen.has(key)) catalogInvalid(originAlias, "$document");
        parent.seen.add(key);
      }
    }
  }
}

function requiredString(value: JsonValue | undefined, originAlias: string, field: string): string {
  if (typeof value !== "string" || value.length === 0) catalogInvalid(originAlias, field);
  return value;
}

function parseArtifactType(
  value: JsonValue | undefined,
  originAlias: string,
  field: string,
  allowUnknown: boolean,
): CatalogArtifactType | undefined {
  if (typeof value !== "string") catalogInvalid(originAlias, field);
  if (value !== "archive" && value !== "skill-md") {
    if (allowUnknown) return undefined;
    catalogInvalid(originAlias, field);
  }
  return value;
}

type ParsedDescriptor = CatalogRelease & {
  readonly rawType: CatalogArtifactType;
  readonly rawUrl: string;
};

function parseDescriptor(
  value: JsonObject,
  originAlias: string,
  indexUrl: URL,
  field: (name: string) => string,
  allowUnknownType: boolean,
): ParsedDescriptor | undefined {
  const artifactType = parseArtifactType(value.type, originAlias, field("type"), allowUnknownType);
  if (artifactType === undefined) return undefined;
  const urlValue = requiredString(value.url, originAlias, field("url"));
  if (
    urlValue.includes("?") ||
    urlValue.includes("#") ||
    !isCanonicalRawUrlReference(urlValue) ||
    hasRawUrlUserinfo(urlValue)
  ) {
    catalogInvalid(originAlias, field("url"));
  }
  const digest = requiredString(value.digest, originAlias, field("digest"));
  if (!DIGEST_PATTERN.test(digest)) catalogInvalid(originAlias, field("digest"));

  let url: URL;
  try {
    url = new URL(urlValue, indexUrl);
  } catch {
    catalogInvalid(originAlias, field("url"));
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password ||
    hasUrlQueryOrFragment(url)
  ) {
    catalogInvalid(originAlias, field("url"));
  }
  return {
    artifactType,
    url: url.href,
    digest,
    rawType: artifactType,
    rawUrl: urlValue,
  };
}

function isReleaseOrderValid(previous: string, next: string): boolean {
  const parsedPrevious = parseStrictSemVer(previous);
  const parsedNext = parseStrictSemVer(next);
  if (!parsedPrevious || !parsedNext) return false;
  const precedence = compareSemVerPrecedence(parsedPrevious, parsedNext);
  if (precedence !== 0) return precedence > 0;
  return previous < next;
}

function parseVersionExtension(
  value: JsonValue | undefined,
  index: number,
  originAlias: string,
  indexUrl: URL,
  current: ParsedDescriptor,
): { version?: string; releases?: readonly CatalogRelease[] } {
  if (value === undefined) return {};
  const prefix = `skills[${index}].x-remote-skills`;
  if (!isJsonObject(value) || Object.keys(value).some((key) => !EXTENSION_KEYS.has(key))) {
    catalogInvalid(originAlias, prefix);
  }
  const version = requiredString(value.version, originAlias, `${prefix}.version`);
  if (!parseStrictSemVer(version)) catalogInvalid(originAlias, `${prefix}.version`);
  if (
    !Array.isArray(value.releases) ||
    value.releases.length < 1 ||
    value.releases.length > MAX_RELEASES
  ) {
    catalogInvalid(originAlias, `${prefix}.releases`);
  }

  const releases: CatalogRelease[] = [];
  const rawReleases: Array<ParsedDescriptor & { version: string }> = [];
  const versions = new Set<string>();
  for (let releaseIndex = 0; releaseIndex < value.releases.length; releaseIndex += 1) {
    const rawRelease = value.releases[releaseIndex];
    const releasePrefix = `${prefix}.releases[${releaseIndex}]`;
    if (
      !isJsonObject(rawRelease) ||
      Object.keys(rawRelease).length !== RELEASE_KEYS.size ||
      Object.keys(rawRelease).some((key) => !RELEASE_KEYS.has(key))
    ) {
      catalogInvalid(originAlias, releasePrefix);
    }
    const releaseVersion = requiredString(
      rawRelease.version,
      originAlias,
      `${releasePrefix}.version`,
    );
    if (!parseStrictSemVer(releaseVersion)) catalogInvalid(originAlias, `${releasePrefix}.version`);
    if (versions.has(releaseVersion)) catalogInvalid(originAlias, `${releasePrefix}.version`);
    versions.add(releaseVersion);
    const descriptor = parseDescriptor(
      rawRelease,
      originAlias,
      indexUrl,
      (name) => `${releasePrefix}.${name}`,
      false,
    );
    if (!descriptor) catalogInvalid(originAlias, releasePrefix);
    rawReleases.push({ ...descriptor, version: releaseVersion });
    releases.push(
      Object.freeze({
        version: releaseVersion,
        artifactType: descriptor.artifactType,
        url: descriptor.url,
        digest: descriptor.digest,
      }),
    );
    const previous = rawReleases[releaseIndex - 1];
    if (releaseIndex > 0 && (!previous || !isReleaseOrderValid(previous.version, releaseVersion))) {
      catalogInvalid(originAlias, `${prefix}.releases.order`);
    }
  }

  const matching = rawReleases.find((release) => release.version === version);
  if (
    !matching ||
    matching.rawType !== current.rawType ||
    matching.rawUrl !== current.rawUrl ||
    matching.digest !== current.digest
  ) {
    catalogInvalid(originAlias, `${prefix}.releases.current`);
  }
  return { version, releases: Object.freeze(releases) };
}

function parseEntry(
  value: JsonValue,
  index: number,
  originAlias: string,
  indexUrl: URL,
): CatalogEntry | undefined {
  const field = (name: string) => `skills[${index}].${name}`;
  if (!isJsonObject(value)) catalogInvalid(originAlias, `skills[${index}]`);

  const name = requiredString(value.name, originAlias, field("name"));
  if (name.length > 64 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(name) || name.includes("--")) {
    catalogInvalid(originAlias, field("name"));
  }
  const description = requiredString(value.description, originAlias, field("description"));
  if ([...description].length > 1024) catalogInvalid(originAlias, field("description"));
  const descriptor = parseDescriptor(value, originAlias, indexUrl, field, true);
  if (!descriptor) return undefined;
  const extension = parseVersionExtension(
    value["x-remote-skills"],
    index,
    originAlias,
    indexUrl,
    descriptor,
  );

  return Object.freeze({
    originAlias,
    name,
    description,
    artifactType: descriptor.artifactType,
    url: descriptor.url,
    digest: descriptor.digest,
    ...extension,
  });
}

export function parseCatalog(
  bytes: Uint8Array,
  originAlias: string,
  indexUrl: URL,
  maxBytes: number = MAX_CATALOG_BYTES,
): OriginCatalog {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new RemoteSkillsError("configuration_invalid", { field: "catalogBytes" });
  }
  if (!(bytes instanceof Uint8Array)) {
    catalogInvalid(originAlias, "$document");
  }
  if (bytes.byteLength > maxBytes) {
    throw new RemoteSkillsError("limit_exceeded", {
      origin_alias: originAlias,
      limit: "catalog_bytes",
    });
  }
  let value: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    validateRecognizedMembers(text, originAlias);
    value = JSON.parse(text);
  } catch {
    catalogInvalid(originAlias, "$document");
  }

  if (!isJsonObject(value)) catalogInvalid(originAlias, "$document");
  if (value.$schema !== DISCOVERY_SCHEMA_V0_2) {
    throw new RemoteSkillsError("unsupported_schema", {
      origin_alias: originAlias,
      ...(value.$schema === DISCOVERY_SCHEMA_V0_1 ? { schema: DISCOVERY_SCHEMA_V0_1 } : {}),
    });
  }
  if (!Array.isArray(value.skills)) catalogInvalid(originAlias, "skills");

  const entries: CatalogEntry[] = [];
  const names = new Set<string>();
  for (let index = 0; index < value.skills.length; index += 1) {
    const rawEntry = value.skills[index];
    if (rawEntry === undefined) catalogInvalid(originAlias, `skills[${index}]`);
    const entry = parseEntry(rawEntry, index, originAlias, indexUrl);
    if (!entry) continue;
    if (names.has(entry.name)) catalogInvalid(originAlias, `skills[${index}].name`);
    names.add(entry.name);
    entries.push(entry);
  }

  return Object.freeze({
    originAlias,
    stale: false,
    entries: Object.freeze(entries),
  });
}

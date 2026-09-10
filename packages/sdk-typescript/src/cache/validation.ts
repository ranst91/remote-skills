import { createHash } from "node:crypto";
import { posix } from "node:path";

import { CacheCorruptError } from "./errors.ts";
import {
  CACHE_LAYOUT_NAMESPACE,
  type CachedObject,
  type CatalogMetadataInput,
  type ExtractedContentsVerifier,
  type ObjectMetadata,
  type PublishObjectInput,
} from "./types.ts";
import { pinnedUnicodeCaseFold } from "./unicode-casefold.ts";

export const CACHE_MAX_CATALOG_BODY_BYTES = 1_048_576;
export const CACHE_MAX_CATALOG_METADATA_BYTES = 65_536;
export const CACHE_MAX_OBJECT_METADATA_BYTES = 1_048_576;
export const CACHE_MAX_ARTIFACT_BYTES = 50 * 1_024 * 1_024;
export const CACHE_MAX_EXTRACTED_BYTES = 100 * 1_024 * 1_024;
export const CACHE_MAX_EXTRACTED_FILE_BYTES = 10 * 1_024 * 1_024;
export const CACHE_MAX_FILES_PER_OBJECT = 1_000;

const FATAL_UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const SENSITIVE_URL_PARAMETER_NAMES = new Set([
  "access_token",
  "api_key",
  "apikey",
  "auth",
  "authorization",
  "bearer",
  "client_secret",
  "code_verifier",
  "credential",
  "credentials",
  "id_token",
  "key",
  "password",
  "passwd",
  "private_key",
  "refresh_token",
  "secret",
  "sig",
  "signature",
  "session_token",
  "token",
  "x_amz_credential",
  "x_amz_security_token",
  "x_amz_signature",
  "x_goog_credential",
  "x_goog_signature",
  "x_api_key",
]);

export type ObjectPublicationLimits = {
  maxArtifactBytes: number;
  maxExtractedBytes: number;
  maxExtractedFileBytes: number;
  maxFiles: number;
};

function catalogBodyCorrupt(): CacheCorruptError {
  return new CacheCorruptError("catalog cache body is corrupt", {
    layout_version: CACHE_LAYOUT_NAMESPACE,
  });
}

function isCredentialBearingUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value, "https://catalog-cache.invalid/");
  } catch {
    return false;
  }
  if (url.username !== "" || url.password !== "") return true;
  const containsSensitiveParameter = (parameters: URLSearchParams): boolean => {
    for (const name of parameters.keys()) {
      const normalized = name.toLowerCase().replace(/[.-]/gu, "_");
      if (SENSITIVE_URL_PARAMETER_NAMES.has(normalized)) return true;
    }
    return false;
  };
  if (containsSensitiveParameter(url.searchParams)) return true;
  const fragment = url.hash.slice(1);
  if (fragment === "") return false;
  const queryStart = fragment.indexOf("?");
  const fragmentParameters = new URLSearchParams(
    queryStart === -1 ? fragment : fragment.slice(queryStart + 1),
  );
  for (const name of fragmentParameters.keys()) {
    const normalized = name.toLowerCase().replace(/[.-]/gu, "_");
    if (SENSITIVE_URL_PARAMETER_NAMES.has(normalized)) return true;
  }
  return false;
}

export function snapshotCatalogBody(body: Uint8Array): Uint8Array {
  if (!(body instanceof Uint8Array) || body.byteLength > CACHE_MAX_CATALOG_BODY_BYTES) {
    throw catalogBodyCorrupt();
  }
  const snapshot = new Uint8Array(body);
  let parsed: unknown;
  try {
    parsed = JSON.parse(FATAL_UTF8_DECODER.decode(snapshot));
  } catch {
    throw catalogBodyCorrupt();
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw catalogBodyCorrupt();
  }
  const pending: unknown[] = [parsed];
  let visited = 0;
  while (pending.length > 0) {
    const value = pending.pop();
    visited += 1;
    if (visited > snapshot.byteLength + 1) throw catalogBodyCorrupt();
    if (Array.isArray(value)) {
      for (const item of value) pending.push(item);
      continue;
    }
    if (value === null || typeof value !== "object") continue;
    for (const [key, item] of Object.entries(value)) {
      if (key === "url" && typeof item === "string" && isCredentialBearingUrl(item)) {
        throw catalogBodyCorrupt();
      }
      pending.push(item);
    }
  }
  return snapshot;
}

function cloneCachedObject(object: CachedObject): CachedObject {
  return {
    artifact: new Uint8Array(object.artifact),
    root: new Map([...object.root].map(([path, bytes]) => [path, new Uint8Array(bytes)])),
    metadata: {
      ...object.metadata,
      files: object.metadata.files.map((file) => ({ ...file })),
    },
  };
}

export function snapshotPublishObjectInput(
  input: PublishObjectInput,
  limits: ObjectPublicationLimits = {
    maxArtifactBytes: CACHE_MAX_ARTIFACT_BYTES,
    maxExtractedBytes: CACHE_MAX_EXTRACTED_BYTES,
    maxExtractedFileBytes: CACHE_MAX_EXTRACTED_FILE_BYTES,
    maxFiles: CACHE_MAX_FILES_PER_OBJECT,
  },
): PublishObjectInput {
  const corrupt = (): CacheCorruptError =>
    new CacheCorruptError("cache object publication input is corrupt", {
      layout_version: CACHE_LAYOUT_NAMESPACE,
    });
  if (
    input === null ||
    typeof input !== "object" ||
    typeof input.digest !== "string" ||
    typeof input.artifactType !== "string" ||
    (input.archiveFormat !== null && typeof input.archiveFormat !== "string") ||
    !(input.artifact instanceof Uint8Array)
  ) {
    throw corrupt();
  }
  if (input.artifact.byteLength > limits.maxArtifactBytes) {
    throw corrupt();
  }
  const snapshotMap = <Value>(
    source: ReadonlyMap<string, Value>,
    copyValue: (value: unknown) => Value,
  ): Map<string, Value> => {
    try {
      if (source === null || typeof source !== "object") throw corrupt();
      const size = source.size;
      if (
        !Number.isSafeInteger(size) ||
        size < 0 ||
        size > limits.maxFiles ||
        typeof source.get !== "function" ||
        typeof source.has !== "function" ||
        typeof source.forEach !== "function" ||
        typeof source.keys !== "function" ||
        typeof source.values !== "function" ||
        typeof source.entries !== "function" ||
        typeof source[Symbol.iterator] !== "function"
      ) {
        throw corrupt();
      }
      const snapshot = new Map<string, Value>();
      let entryCount = 0;
      for (const entry of source) {
        entryCount += 1;
        if (
          entryCount > limits.maxFiles ||
          !Array.isArray(entry) ||
          entry.length !== 2 ||
          typeof entry[0] !== "string"
        ) {
          throw corrupt();
        }
        snapshot.set(entry[0], copyValue(entry[1]));
      }
      return snapshot;
    } catch {
      throw corrupt();
    }
  };
  let extractedBytes = 0;
  const files = snapshotMap(input.files, (bytes) => {
    if (!(bytes instanceof Uint8Array)) throw corrupt();
    extractedBytes += bytes.byteLength;
    if (
      bytes.byteLength > limits.maxExtractedFileBytes ||
      !Number.isSafeInteger(extractedBytes) ||
      extractedBytes > limits.maxExtractedBytes
    ) {
      throw corrupt();
    }
    return new Uint8Array(bytes);
  });
  const mediaTypes = snapshotMap(input.mediaTypes, (mediaType) => {
    if (typeof mediaType !== "string") throw corrupt();
    return mediaType;
  });
  return {
    digest: input.digest,
    artifactType: input.artifactType,
    archiveFormat: input.archiveFormat,
    artifact: new Uint8Array(input.artifact),
    files,
    mediaTypes,
    ...(input.verifiedAt === undefined ? {} : { verifiedAt: input.verifiedAt }),
    ...(input.accessedAt === undefined ? {} : { accessedAt: input.accessedAt }),
  };
}

export function catalogMetadataWireByteLength(
  canonicalUrl: string,
  metadata: CatalogMetadataInput,
): number {
  const stored = {
    schema: "remote-skills-catalog-metadata-v1",
    canonical_url: canonicalUrl,
    ...(metadata.confirmedScope === undefined ? {} : { confirmed_scope: metadata.confirmedScope }),
    ...(metadata.etag === undefined ? {} : { etag: metadata.etag }),
    ...(metadata.lastModified === undefined ? {} : { last_modified: metadata.lastModified }),
    ...(metadata.cacheControl === undefined ? {} : { cache_control: metadata.cacheControl }),
    retrieved_at: metadata.retrievedAt,
    validated_at: metadata.validatedAt,
  };
  return Buffer.byteLength(`${JSON.stringify(stored, null, 2)}\n`);
}

export function compareCatalogMetadataFreshness(
  left: Pick<CatalogMetadataInput, "retrievedAt" | "validatedAt">,
  right: Pick<CatalogMetadataInput, "retrievedAt" | "validatedAt">,
): number {
  const validatedDifference = Date.parse(left.validatedAt) - Date.parse(right.validatedAt);
  if (validatedDifference !== 0) return validatedDifference;
  return Date.parse(left.retrievedAt) - Date.parse(right.retrievedAt);
}

export function objectMetadataWireByteLength(metadata: ObjectMetadata): number {
  const stored = {
    schema: "remote-skills-object-metadata-v1",
    digest: metadata.digest,
    artifact_type: metadata.artifactType,
    archive_format: metadata.archiveFormat,
    artifact_bytes: metadata.artifactBytes,
    extracted_bytes: metadata.extractedBytes,
    files: metadata.files.map((file) => ({
      path: file.path,
      size: file.size,
      media_type: file.mediaType,
    })),
    verified_at: metadata.verifiedAt,
    accessed_at: metadata.accessedAt,
  };
  return Buffer.byteLength(`${JSON.stringify(stored, null, 2)}\n`);
}

export function digestHex(digest: string): string {
  if (!/^sha256:[0-9a-f]{64}$/u.test(digest)) {
    throw new CacheCorruptError("cache object digest is invalid", {
      layout_version: CACHE_LAYOUT_NAMESPACE,
    });
  }
  return digest.slice("sha256:".length);
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function isTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value)) {
    return false;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

export function snapshotCatalogMetadataInput(value: CatalogMetadataInput): CatalogMetadataInput {
  const corrupt = (): CacheCorruptError =>
    new CacheCorruptError("catalog cache metadata is corrupt", {
      layout_version: CACHE_LAYOUT_NAMESPACE,
    });
  if (value === null || typeof value !== "object") throw corrupt();
  const snapshot = { ...value };
  const required = ["retrievedAt", "validatedAt"];
  if (
    !required.every((key) => Object.hasOwn(snapshot, key)) ||
    !isTimestamp(snapshot.retrievedAt) ||
    !isTimestamp(snapshot.validatedAt) ||
    (snapshot.etag !== undefined && typeof snapshot.etag !== "string") ||
    (snapshot.lastModified !== undefined && typeof snapshot.lastModified !== "string") ||
    (snapshot.cacheControl !== undefined && typeof snapshot.cacheControl !== "string") ||
    (snapshot.confirmedScope !== undefined &&
      (typeof snapshot.confirmedScope !== "string" ||
        snapshot.confirmedScope.length < 1 ||
        snapshot.confirmedScope.length > 128 ||
        snapshot.confirmedScope.includes(",") ||
        !/^[\x21-\x7e]+$/u.test(snapshot.confirmedScope)))
  ) {
    throw corrupt();
  }
  return {
    ...(snapshot.confirmedScope === undefined ? {} : { confirmedScope: snapshot.confirmedScope }),
    ...(snapshot.etag === undefined ? {} : { etag: snapshot.etag }),
    ...(snapshot.lastModified === undefined ? {} : { lastModified: snapshot.lastModified }),
    ...(snapshot.cacheControl === undefined ? {} : { cacheControl: snapshot.cacheControl }),
    retrievedAt: snapshot.retrievedAt,
    validatedAt: snapshot.validatedAt,
  };
}

function isUnicodeScalarString(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && codePoint >= 0xd800 && codePoint <= 0xdfff) return false;
  }
  return true;
}

function hasWindowsForbiddenCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      (codePoint !== undefined && (codePoint < 0x20 || codePoint === 0x7f)) ||
      '<>:"\\|?*'.includes(character)
    ) {
      return true;
    }
  }
  return false;
}

export function validatePortablePaths(paths: Iterable<string>): string[] {
  const candidates = [...paths];
  if (candidates.some((path) => typeof path !== "string" || !isUnicodeScalarString(path))) {
    throw new CacheCorruptError("cache object file table is corrupt", {
      layout_version: CACHE_LAYOUT_NAMESPACE,
    });
  }
  const sorted = candidates.sort((left, right) =>
    Buffer.compare(Buffer.from(left), Buffer.from(right)),
  );
  const portable = new Set<string>();
  for (const path of sorted) {
    const components = path.split("/");
    if (
      path.length === 0 ||
      hasWindowsForbiddenCharacter(path) ||
      path.startsWith("/") ||
      path.normalize("NFC") !== path ||
      posix.normalize(path) !== path ||
      components.some(
        (part) =>
          part === "" ||
          part === "." ||
          part === ".." ||
          /[. ]$/u.test(part) ||
          /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(part),
      )
    ) {
      throw new CacheCorruptError("cache object file table is corrupt", {
        layout_version: CACHE_LAYOUT_NAMESPACE,
      });
    }
    const key = pinnedUnicodeCaseFold(path);
    if (portable.has(key)) {
      throw new CacheCorruptError("cache object file table is corrupt", {
        layout_version: CACHE_LAYOUT_NAMESPACE,
      });
    }
    portable.add(key);
  }
  return sorted;
}

export async function validateExtractedContentBinding(
  object: CachedObject,
  verifier?: ExtractedContentsVerifier,
): Promise<void> {
  const corrupt = (): CacheCorruptError =>
    new CacheCorruptError("verified cache object is corrupt", {
      expected_digest: object.metadata.digest,
      layout_version: CACHE_LAYOUT_NAMESPACE,
    });
  if (object.metadata.artifactType === "skill-md") {
    const skill = object.root.get("SKILL.md");
    if (
      object.metadata.archiveFormat !== null ||
      object.root.size !== 1 ||
      skill === undefined ||
      Buffer.compare(Buffer.from(skill), Buffer.from(object.artifact)) !== 0
    ) {
      throw corrupt();
    }
    return;
  }
  if (object.metadata.artifactType !== "archive" || verifier === undefined) {
    throw corrupt();
  }
  let verified = false;
  try {
    verified = await verifier(cloneCachedObject(object));
  } catch {
    throw corrupt();
  }
  if (!verified) throw corrupt();
}

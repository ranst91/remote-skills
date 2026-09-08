import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import type { CachedObject } from "../cache/types.ts";
import { RemoteSkillsError } from "../catalog/errors.ts";
import { type RequestRuntime, requestWithPolicy } from "../catalog/http.ts";
import { defaultResolveHost, defaultTransport } from "../catalog/transport.ts";
import type { CatalogRelease } from "../catalog/types.ts";
import { activatedSkillFromObject } from "./activated-skill.ts";
import { extractTarGzip, extractZip } from "./archive.ts";
import { parseSkillMarkdown } from "./frontmatter.ts";
import { mediaTypeForPath } from "./media-types.ts";
import {
  type ActivateSkillInput,
  type ActivationDependencies,
  type ActivationLimits,
  type ActivationPin,
  type ActivationResult,
  DEFAULT_ACTIVATION_LIMITS,
  type NormalizedActivationLimits,
} from "./types.ts";

function configuration(field: string): never {
  throw new RemoteSkillsError("configuration_invalid", { field });
}

function bounded(value: unknown, fallback: number, field: string): number {
  const selected = value ?? fallback;
  if (typeof selected !== "number" || !Number.isSafeInteger(selected) || selected < 1) {
    configuration(field);
  }
  return selected;
}

export function normalizeActivationLimits(
  limits: ActivationLimits = {},
): NormalizedActivationLimits {
  if (typeof limits !== "object" || limits === null || Array.isArray(limits)) {
    configuration("limits");
  }
  return Object.freeze({
    archiveBytes: bounded(
      limits.archiveBytes,
      DEFAULT_ACTIVATION_LIMITS.archiveBytes,
      "limits.archiveBytes",
    ),
    extractedBytes: bounded(
      limits.extractedBytes,
      DEFAULT_ACTIVATION_LIMITS.extractedBytes,
      "limits.extractedBytes",
    ),
    files: bounded(limits.files, DEFAULT_ACTIVATION_LIMITS.files, "limits.files"),
    fileBytes: bounded(limits.fileBytes, DEFAULT_ACTIVATION_LIMITS.fileBytes, "limits.fileBytes"),
  });
}

function runtime(dependencies: ActivationDependencies): RequestRuntime {
  return {
    now: dependencies.now ?? Date.now,
    random: dependencies.random ?? Math.random,
    sleep: dependencies.sleep ?? (async (milliseconds) => delay(milliseconds)),
    resolve: dependencies.resolve ?? defaultResolveHost,
    transport: dependencies.transport ?? defaultTransport,
  };
}

function validateDescriptor(input: ActivateSkillInput): CatalogRelease {
  const descriptor = input.release ?? input.entry;
  if (!/^sha256:[0-9a-f]{64}$/u.test(descriptor.digest)) {
    throw new RemoteSkillsError("catalog_invalid", { field: "digest" });
  }
  if (descriptor.artifactType !== "skill-md" && descriptor.artifactType !== "archive") {
    throw new RemoteSkillsError("artifact_unsupported", {
      artifact_type: String(descriptor.artifactType),
    });
  }
  try {
    const url = new URL(descriptor.url);
    if (url.href !== descriptor.url) throw new TypeError("non-canonical URL");
  } catch {
    throw new RemoteSkillsError("catalog_invalid", { field: "url" });
  }
  return descriptor;
}

function archiveFormat(
  descriptor: CatalogRelease,
  contentType: string | undefined,
): "tar.gz" | "zip" {
  const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType === "application/zip") return "zip";
  if (mediaType === "application/gzip" || mediaType === "application/x-gzip") return "tar.gz";
  const pathname = new URL(descriptor.url).pathname.toLowerCase();
  if (pathname.endsWith(".tar.gz") || pathname.endsWith(".tgz")) return "tar.gz";
  if (pathname.endsWith(".zip")) return "zip";
  throw new RemoteSkillsError("artifact_unsupported", { artifact_type: "archive" });
}

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function filesForArtifact(
  descriptor: CatalogRelease,
  bytes: Uint8Array,
  limits: NormalizedActivationLimits,
  contentType?: string,
): Promise<{ files: ReadonlyMap<string, Uint8Array>; format: string | null }> {
  if (descriptor.artifactType === "skill-md") {
    if (bytes.byteLength > limits.fileBytes) {
      throw new RemoteSkillsError("limit_exceeded", { limit: "file_bytes" });
    }
    if (bytes.byteLength > limits.extractedBytes) {
      throw new RemoteSkillsError("limit_exceeded", { limit: "extracted_bytes" });
    }
    return { files: new Map([["SKILL.md", new Uint8Array(bytes)]]), format: null };
  }
  const format = archiveFormat(descriptor, contentType);
  return {
    files: format === "zip" ? extractZip(bytes, limits) : await extractTarGzip(bytes, limits),
    format,
  };
}

export function createActivationPin(
  input: Pick<ActivateSkillInput, "originAlias" | "confirmedScope" | "entry">,
  descriptor: CatalogRelease,
): ActivationPin {
  const frozenDescriptor = Object.freeze({
    ...(descriptor.version === undefined ? {} : { version: descriptor.version }),
    artifactType: descriptor.artifactType,
    url: descriptor.url,
    digest: descriptor.digest,
  });
  return Object.freeze({
    originAlias: input.originAlias,
    ...(input.confirmedScope === undefined ? {} : { confirmedScope: input.confirmedScope }),
    name: input.entry.name,
    ...(descriptor.version === undefined ? {} : { version: descriptor.version }),
    descriptor: frozenDescriptor,
    digest: descriptor.digest,
  });
}

function requireObjectBinding(object: CachedObject, descriptor: CatalogRelease): void {
  if (
    object.metadata.digest !== descriptor.digest ||
    object.metadata.artifactType !== descriptor.artifactType
  ) {
    throw new RemoteSkillsError("cache_corrupt", {
      expected_digest: descriptor.digest,
      layout_version: "cache-v1",
    });
  }
}

function requireObjectLimits(object: CachedObject, limits: NormalizedActivationLimits): void {
  if (object.metadata.artifactBytes > limits.archiveBytes) {
    throw new RemoteSkillsError("limit_exceeded", { limit: "archive_bytes" });
  }
  if (object.metadata.files.length > limits.files) {
    throw new RemoteSkillsError("limit_exceeded", { limit: "files" });
  }
  if (object.metadata.extractedBytes > limits.extractedBytes) {
    throw new RemoteSkillsError("limit_exceeded", { limit: "extracted_bytes" });
  }
  if (object.metadata.files.some(({ size }) => size > limits.fileBytes)) {
    throw new RemoteSkillsError("limit_exceeded", { limit: "file_bytes" });
  }
}

export async function activateSkill(
  input: ActivateSkillInput,
  dependencies: ActivationDependencies = {},
): Promise<ActivationResult> {
  const descriptor = validateDescriptor(input);
  // Validated catalog history binds the current version to the top-level descriptor.
  const expectedDescription =
    descriptor.version === input.entry.version ? input.entry.description : undefined;
  const limits = normalizeActivationLimits(input.limits);
  const lease = await input.cache.acquireLease(descriptor.digest, input.sessionNonce);
  try {
    let object = await input.cache.getObject(descriptor.digest);
    if (object === null) {
      const response = await requestWithPolicy(
        {
          origin: input.origin,
          url: new URL(descriptor.url),
          purpose: "artifact",
          accept:
            descriptor.artifactType === "skill-md"
              ? "text/markdown"
              : descriptor.url.toLowerCase().endsWith(".zip")
                ? "application/zip"
                : "application/gzip",
          maxBytes: limits.archiveBytes,
        },
        runtime(dependencies),
      );
      if (response.status !== 200) {
        throw new RemoteSkillsError("origin_unavailable", {
          origin_alias: input.originAlias,
          status: response.status,
        });
      }
      if (digest(response.body) !== descriptor.digest) {
        throw new RemoteSkillsError("digest_mismatch", {
          origin_alias: input.originAlias,
          skill_name: input.entry.name,
          expected_digest: descriptor.digest,
        });
      }
      const extracted = await filesForArtifact(
        descriptor,
        response.body,
        limits,
        response.headers["content-type"],
      );
      const skillMarkdown = extracted.files.get("SKILL.md");
      if (skillMarkdown === undefined) {
        throw new RemoteSkillsError("archive_unsafe", { path: "SKILL.md" });
      }
      const parsed = parseSkillMarkdown(skillMarkdown, input.entry.name);
      if (expectedDescription !== undefined && parsed.description !== expectedDescription) {
        throw new RemoteSkillsError("catalog_invalid", { field: "description" });
      }
      const mediaTypes = new Map(
        [...extracted.files.keys()].map((path) => [path, mediaTypeForPath(path)]),
      );
      object = await input.cache.publishObject({
        digest: descriptor.digest,
        artifactType: descriptor.artifactType,
        archiveFormat: extracted.format,
        artifact: response.body,
        files: extracted.files,
        mediaTypes,
      });
    }
    requireObjectBinding(object, descriptor);
    requireObjectLimits(object, limits);
    const skill = activatedSkillFromObject(
      object,
      input.entry.name,
      descriptor.version,
      expectedDescription,
    );
    return Object.freeze({ skill, pin: createActivationPin(input, descriptor), lease });
  } catch (error) {
    await lease.release();
    throw error;
  }
}

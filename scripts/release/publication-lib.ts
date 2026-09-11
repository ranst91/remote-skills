import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface PublicationFile {
  path: string;
  sha256: string;
  integrity: string;
}
export interface PublicationPackage {
  name: string;
  version: string;
  registry: "npm" | "pypi";
  npmTag: string;
  files: PublicationFile[];
}
export interface PublicationRelease {
  scope: string;
  version: string;
  gitTag: string;
  prerelease: boolean;
  notes: string;
}
export interface PublicationPlan {
  packages: PublicationPackage[];
  releases: PublicationRelease[];
}
export function artifactFile(root: string, path: string): PublicationFile {
  if (!/^(?:npm|python)\/[a-zA-Z0-9_.-]+$/u.test(path))
    throw new Error("Invalid publication artifact path");
  const bytes = readFileSync(join(root, path));
  return {
    path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
  };
}
export function verifyPublicationFiles(root: string, plan: PublicationPlan) {
  if (!plan.packages.length || !plan.releases.length) throw new Error("Empty publication plan");
  for (const entry of plan.packages) {
    if (!entry.files.length) throw new Error("Package has no verified artifacts");
    for (const file of entry.files) {
      const actual = artifactFile(root, file.path);
      if (actual.sha256 !== file.sha256 || actual.integrity !== file.integrity)
        throw new Error("Publication artifact digest mismatch");
    }
  }
}
export interface RegistryResponse {
  status: number;
  json(): Promise<unknown>;
}
export type RegistryLookup = (url: string) => Promise<RegistryResponse>;
export function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Invalid registry metadata");
  return value as Record<string, unknown>;
}
/** A retry may skip only identical bytes already present at the exact version. */
export async function publishedFiles(
  entry: PublicationPackage,
  lookup: RegistryLookup,
): Promise<string[]> {
  const url =
    entry.registry === "npm"
      ? `https://registry.npmjs.org/${encodeURIComponent(entry.name)}/${encodeURIComponent(entry.version)}`
      : `https://pypi.org/pypi/${encodeURIComponent(entry.name)}/${encodeURIComponent(entry.version)}/json`;
  const response = await lookup(url);
  if (response.status === 404) return [];
  if (response.status !== 200) throw new Error("Registry lookup failed; refusing publication");
  const metadata = object(await response.json());
  if (entry.registry === "npm") {
    if (metadata.version !== entry.version) throw new Error("Registry version mismatch");
    const dist = object(metadata.dist);
    const file = entry.files[0];
    if (entry.files.length !== 1 || !file || dist.integrity !== file.integrity)
      throw new Error("Published npm version has different artifact bytes");
    return [file.path];
  }
  if (object(metadata.info).version !== entry.version) throw new Error("Registry version mismatch");
  if (!Array.isArray(metadata.urls)) throw new Error("Invalid Python registry file metadata");
  const found: string[] = [];
  for (const file of entry.files) {
    const match = metadata.urls
      .map(object)
      .find((item) => item.filename === file.path.split("/")[1]);
    if (!match) continue;
    if (object(match.digests).sha256 !== file.sha256)
      throw new Error("Published Python version has different artifact bytes");
    found.push(file.path);
  }
  return found;
}
export async function missingFiles(entry: PublicationPackage, lookup: RegistryLookup) {
  const found = new Set(await publishedFiles(entry, lookup));
  return entry.files.filter((file) => !found.has(file.path));
}

export function textField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string") throw new Error(`Invalid metadata field: ${key}`);
  return field;
}
export function arrayField(value: Record<string, unknown>, key: string): unknown[] {
  const field = value[key];
  if (!Array.isArray(field)) throw new Error(`Invalid metadata array: ${key}`);
  return field;
}
export function parsePublicationPlan(value: unknown): PublicationPlan {
  const plan = object(value);
  return {
    packages: arrayField(plan, "packages").map((item) => {
      const entry = object(item);
      const registry = textField(entry, "registry");
      if (registry !== "npm" && registry !== "pypi")
        throw new Error("Invalid publication registry");
      const npmTag = textField(entry, "npmTag");
      if (npmTag !== "alpha" && npmTag !== "latest") throw new Error("Invalid publication channel");
      return {
        name: textField(entry, "name"),
        version: textField(entry, "version"),
        registry,
        npmTag,
        files: arrayField(entry, "files").map((item) => {
          const file = object(item);
          return {
            path: textField(file, "path"),
            sha256: textField(file, "sha256"),
            integrity: textField(file, "integrity"),
          };
        }),
      };
    }),
    releases: arrayField(plan, "releases").map((item) => {
      const release = object(item);
      if (typeof release.prerelease !== "boolean") throw new Error("Invalid prerelease metadata");
      const notes = textField(release, "notes");
      if (!/^release-notes-[a-z0-9-]+\.md$/u.test(notes))
        throw new Error("Invalid release notes path");
      return {
        scope: textField(release, "scope"),
        version: textField(release, "version"),
        gitTag: textField(release, "gitTag"),
        prerelease: release.prerelease,
        notes,
      };
    }),
  };
}

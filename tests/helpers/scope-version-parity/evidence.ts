import { createHash } from "node:crypto";

export const scopeVersionEvidence = Object.freeze([
  "scope_request_not_grant",
  "authentication_401",
  "authorization_403",
  "artifact_authorization",
  "scope_and_credential_isolation",
  "non_persistence",
  "semver_parity",
  "immutable_mapping",
  "authoritative_removal",
  "bounded_stale",
  "session_pins",
  "v0_2_extension_ignored",
]);

interface StandardDescriptor {
  description: string;
  digest: string;
  name: string;
  type: "archive" | "skill-md";
  url: string;
}

function invalidStandardDescriptor(): never {
  throw new Error("invalid standard v0.2 current descriptor");
}

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

function parseDescriptor(value: unknown): StandardDescriptor {
  if (!isObject(value)) invalidStandardDescriptor();
  const name: unknown = Reflect.get(value, "name");
  const description: unknown = Reflect.get(value, "description");
  const type: unknown = Reflect.get(value, "type");
  const url: unknown = Reflect.get(value, "url");
  const digest: unknown = Reflect.get(value, "digest");
  if (
    typeof name !== "string" ||
    typeof description !== "string" ||
    (type !== "archive" && type !== "skill-md") ||
    typeof url !== "string" ||
    typeof digest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(digest)
  ) {
    invalidStandardDescriptor();
  }
  return { name, description, type, url, digest };
}

export async function consumeStandardV02(
  document: unknown,
  catalogUrl: string | URL,
  fetchBytes: (url: URL) => Promise<Uint8Array>,
) {
  if (
    !isObject(document) ||
    Reflect.get(document, "$schema") !==
      "https://schemas.agentskills.io/discovery/0.2.0/schema.json"
  ) {
    invalidStandardDescriptor();
  }
  const skills: unknown = Reflect.get(document, "skills");
  if (!Array.isArray(skills) || skills.length < 1) invalidStandardDescriptor();
  const current = parseDescriptor(skills[0]);
  let artifactUrl: URL;
  try {
    artifactUrl = new URL(current.url, catalogUrl);
  } catch {
    invalidStandardDescriptor();
  }
  if (!new Set(["http:", "https:"]).has(artifactUrl.protocol)) invalidStandardDescriptor();
  const bytes = Buffer.from(await fetchBytes(artifactUrl));
  const observedDigest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (observedDigest !== current.digest) invalidStandardDescriptor();
  return Object.freeze({
    name: current.name,
    type: current.type,
    url: artifactUrl.href,
    digest: current.digest,
    bytes,
  });
}

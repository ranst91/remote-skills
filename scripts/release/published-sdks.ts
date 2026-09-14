import {
  type PublishedSdkVersions,
  parseVersion,
  UnavailableSdkVersionError,
} from "./release-lib.ts";

export interface SdkArchive {
  url: string;
  algorithm: "sha256" | "sha512";
  digest: string;
  encoding: "hex" | "base64";
}
export interface PublishedSdks {
  versions: PublishedSdkVersions;
  npm: Map<string, SdkArchive>;
  pypi: Map<string, { wheel: SdkArchive; sdist: SdkArchive }>;
}
function record(value: unknown): object {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Invalid published SDK metadata");
  return value;
}
function supported(version: string, python = false) {
  try {
    parseVersion(python ? version.replace(/a([0-9]+)$/u, "-alpha.$1") : version);
    return true;
  } catch {
    return false;
  }
}
function archive(value: unknown, registry: "npm" | "pypi"): SdkArchive {
  const source = record(value);
  const url: unknown = Reflect.get(source, registry === "npm" ? "tarball" : "url");
  const integrity: unknown =
    registry === "npm"
      ? Reflect.get(source, "integrity")
      : Reflect.get(record(Reflect.get(source, "digests")), "sha256");
  if (typeof url !== "string" || typeof integrity !== "string")
    throw new Error("Published SDK archive metadata is missing");
  const parsed = new URL(url);
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.hostname !== (registry === "npm" ? "registry.npmjs.org" : "files.pythonhosted.org")
  )
    throw new Error("Unexpected published SDK archive origin");
  if (
    registry === "npm"
      ? !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(integrity)
      : !/^[a-f0-9]{64}$/u.test(integrity)
  )
    throw new Error("Invalid published SDK archive digest");
  return {
    url,
    algorithm: registry === "npm" ? "sha512" : "sha256",
    digest: registry === "npm" ? integrity.slice(7) : integrity,
    encoding: registry === "npm" ? "base64" : "hex",
  };
}
export async function readPublishedSdks(
  lookup: typeof fetch = fetch,
  registries: readonly ("npm" | "pypi")[] = ["npm", "pypi"],
): Promise<PublishedSdks> {
  async function metadata(url: string, identity: string) {
    let value: unknown;
    try {
      const response = await lookup(url, {
        signal: AbortSignal.timeout(30_000),
        redirect: "error",
      });
      if (response.status === 404)
        return identity === "npm client"
          ? { name: "@remote-skills/client", versions: {} }
          : { info: { name: "remote-skills" }, releases: {} };
      if (response.status !== 200) throw new Error("Registry unavailable");
      value = await response.json();
    } catch {
      throw new Error(`Cannot verify published ${identity} versions`);
    }
    return record(value);
  }
  const [npmData, pythonData] = await Promise.all([
    registries.includes("npm")
      ? metadata("https://registry.npmjs.org/@remote-skills%2Fclient", "npm client")
      : { name: "@remote-skills/client", versions: {} },
    registries.includes("pypi")
      ? metadata("https://pypi.org/pypi/remote-skills/json", "Python SDK")
      : { info: { name: "remote-skills" }, releases: {} },
  ]);
  if (
    Reflect.get(npmData, "name") !== "@remote-skills/client" ||
    Reflect.get(record(Reflect.get(pythonData, "info")), "name") !== "remote-skills"
  )
    throw new Error("Unexpected published SDK identity");
  const npm = new Map<string, SdkArchive>();
  for (const [version, value] of Object.entries(record(Reflect.get(npmData, "versions")))) {
    if (!supported(version)) continue;
    const entry = record(value);
    if (
      Reflect.get(entry, "version") !== version ||
      Reflect.get(entry, "name") !== "@remote-skills/client"
    )
      throw new Error("Published SDK version metadata disagrees");
    npm.set(version, archive(Reflect.get(entry, "dist"), "npm"));
  }
  const pypi = new Map<string, { wheel: SdkArchive; sdist: SdkArchive }>();
  for (const [version, files] of Object.entries(record(Reflect.get(pythonData, "releases")))) {
    if (!supported(version, true)) continue;
    if (!Array.isArray(files)) throw new Error("Invalid published Python SDK files");
    const eligible = files.map(record).filter((file) => Reflect.get(file, "yanked") === false);
    const wheel = eligible.find((file) => Reflect.get(file, "packagetype") === "bdist_wheel");
    const sdist = eligible.find((file) => Reflect.get(file, "packagetype") === "sdist");
    if (wheel && sdist)
      pypi.set(version, { wheel: archive(wheel, "pypi"), sdist: archive(sdist, "pypi") });
  }
  return {
    versions: { npm: [...npm.keys()].reverse(), pypi: [...pypi.keys()].reverse() },
    npm,
    pypi,
  };
}

// Probe without writes: a compatible co-released SDK needs no registry lookup.
// Each required registry is fetched once; an unavailable dependency remains fatal.
export async function resolvePublishedSdks(
  validate: (versions: PublishedSdkVersions) => void,
  lookup: typeof fetch = fetch,
): Promise<PublishedSdks> {
  const result: PublishedSdks = {
    versions: { npm: [], pypi: [] },
    npm: new Map(),
    pypi: new Map(),
  };
  const checked = new Set<"npm" | "pypi">();
  for (;;) {
    try {
      validate(result.versions);
      return result;
    } catch (error) {
      if (!(error instanceof UnavailableSdkVersionError) || checked.has(error.registry))
        throw error;
      checked.add(error.registry);
      const available = await readPublishedSdks(lookup, [error.registry]);
      if (error.registry === "npm") result.npm = available.npm;
      else result.pypi = available.pypi;
      result.versions[error.registry] = available.versions[error.registry];
    }
  }
}

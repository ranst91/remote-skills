import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type PublishedSdks, readPublishedSdks, type SdkArchive } from "./published-sdks.ts";
import {
  clientPeerCompatible,
  manifestObject,
  npmSdkRequirement,
  pythonSdkRequirement,
  readReleaseState,
  selectSdkVersion,
  stringField,
} from "./release-lib.ts";

interface NpmSdk {
  version: string;
  path?: string;
}
interface PythonSdk {
  version: string;
  wheel?: string;
  sdist?: string;
}
export interface SdkDependencies {
  npm: Record<string, NpmSdk>;
  python: Record<string, PythonSdk>;
}
export function readSdkDependencies(path?: string): SdkDependencies {
  if (!path) return { npm: {}, python: {} };
  const value = manifestObject(readFileSync(path, "utf8"));
  const result: SdkDependencies = { npm: {}, python: {} };
  for (const [key, item] of Object.entries(
    manifestObject(JSON.stringify(Reflect.get(value, "npm"))),
  )) {
    const entry = manifestObject(JSON.stringify(item));
    result.npm[key] = {
      version: stringField(entry, "version"),
      ...(Reflect.has(entry, "path") ? { path: stringField(entry, "path") } : {}),
    };
  }
  for (const [key, item] of Object.entries(
    manifestObject(JSON.stringify(Reflect.get(value, "python"))),
  )) {
    const entry = manifestObject(JSON.stringify(item));
    result.python[key] = {
      version: stringField(entry, "version"),
      ...(Reflect.has(entry, "wheel")
        ? { wheel: stringField(entry, "wheel"), sdist: stringField(entry, "sdist") }
        : {}),
    };
  }
  return result;
}
export async function installedNpmSdk(root: string, name: string, directory: string) {
  const dependencies = readSdkDependencies(process.env.REMOTE_SKILLS_SDK_DEPENDENCIES);
  if (dependencies.npm[name]) return dependencies.npm[name];
  const state = readReleaseState(root);
  const integration = state.manifests.find((entry) => entry.name === name);
  if (!integration) throw new Error(`Unknown integration ${name}`);
  const requirement = npmSdkRequirement(integration.manifest);
  if (!requirement || clientPeerCompatible(requirement, state.npmVersion))
    return { version: state.npmVersion };
  return (await prepareSdkDependencies(state, directory)).npm[name];
}
export async function downloadSdkArchive(
  source: SdkArchive,
  path: string,
  lookup: typeof fetch = fetch,
) {
  const response = await lookup(source.url, {
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status !== 200 || !response.body)
    throw new Error("Published SDK archive unavailable");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > 16 * 1024 * 1024) throw new Error("Published SDK archive exceeds size limit");
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  if (createHash(source.algorithm).update(bytes).digest(source.encoding) !== source.digest)
    throw new Error("Published SDK archive digest mismatch");
  writeFileSync(path, bytes);
}
export async function prepareSdkDependencies(
  state: ReturnType<typeof readReleaseState>,
  directory: string,
  inventory?: PublishedSdks,
  lookup: typeof fetch = fetch,
): Promise<SdkDependencies> {
  const published = inventory ?? (await readPublishedSdks());
  mkdirSync(directory, { recursive: true });
  const result: SdkDependencies = { npm: {}, python: {} };
  const candidateAllowed = !state.intent || state.selectedScopes.includes("core");
  const downloaded = new Map<string, string>();
  async function download(key: string, archive: SdkArchive | undefined, filename: string) {
    const existing = downloaded.get(key);
    if (existing) return existing;
    if (!archive) throw new Error("Selected published SDK archive is unavailable");
    const path = join(directory, filename);
    await downloadSdkArchive(archive, path, lookup);
    downloaded.set(key, path);
    return path;
  }
  for (const entry of state.manifests.filter((entry) => entry.scope !== "core")) {
    const requirement = npmSdkRequirement(entry.manifest);
    if (!requirement) continue;
    const candidate = candidateAllowed ? state.npmVersion : undefined;
    const version = selectSdkVersion("npm", requirement, candidate, published.versions.npm);
    result.npm[entry.name] =
      candidate === version
        ? { version }
        : {
            version,
            path: await download(
              `npm:${version}`,
              published.npm.get(version),
              `remote-skills-client-${version}.tgz`,
            ),
          };
  }
  for (const entry of state.pythonManifests.filter((entry) => entry.scope !== "core")) {
    const requirement = pythonSdkRequirement(entry.source);
    if (!requirement) continue;
    const candidate = candidateAllowed ? state.pythonVersion : undefined;
    const version = selectSdkVersion("pypi", requirement, candidate, published.versions.pypi);
    const archives = published.pypi.get(version);
    result.python[entry.name] =
      candidate === version
        ? { version }
        : {
            version,
            wheel: await download(
              `wheel:${version}`,
              archives?.wheel,
              `remote_skills-${version}-py3-none-any.whl`,
            ),
            sdist: await download(
              `sdist:${version}`,
              archives?.sdist,
              `remote_skills-${version}.tar.gz`,
            ),
          };
  }
  return result;
}

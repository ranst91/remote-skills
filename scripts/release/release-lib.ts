// Coordinated release policy adapted from the original release-ci implementation.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const releasePackages = [
  { id: "cli", name: "@remote-skills/cli", manifest: "packages/cli/package.json" },
  { id: "client", name: "@remote-skills/client", manifest: "packages/sdk-typescript/package.json" },
  { id: "ai_sdk", name: "@remote-skills/ai-sdk", manifest: "integrations/ai-sdk/package.json" },
] as const;
export const pythonManifest = "packages/sdk-python/pyproject.toml";
export type Bump = "patch" | "minor" | "major";
export const releaseIntent = "release-state.json";
export type Channel = "stable" | "alpha";
const pattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-alpha\.(0|[1-9]\d*))?$/u;

export function parseVersion(version: string) {
  const match = pattern.exec(version);
  if (!match) throw new Error(`Unsupported release version: ${version}`);
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    alpha: match[4] === undefined ? undefined : Number(match[4]),
  };
}
export function toPythonVersion(version: string) {
  parseVersion(version);
  return version.replace("-alpha.", "a");
}
export function nextReleaseVersion(version: string, bump: Bump, channel: Channel) {
  const current = parseVersion(version);
  if (current.alpha !== undefined)
    return `${current.major}.${current.minor}.${current.patch}${channel === "alpha" ? `-alpha.${current.alpha + 1}` : ""}`;
  const base =
    bump === "major"
      ? `${current.major + 1}.0.0`
      : bump === "minor"
        ? `${current.major}.${current.minor + 1}.0`
        : `${current.major}.${current.minor}.${current.patch + 1}`;
  return base + (channel === "alpha" ? "-alpha.0" : "");
}
export function manifestObject(source: string): object {
  const value: unknown = JSON.parse(source);
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Invalid package manifest");
  return value;
}
export function stringField(value: object, key: string): string {
  const field: unknown = Reflect.get(value, key);
  if (typeof field !== "string") throw new Error(`Expected string ${key}`);
  return field;
}
export function readPythonVersion(source: string) {
  const project = source.split(/^\[project\]\s*$/mu)[1]?.split(/^\[/mu)[0];
  const version = project?.match(/^version\s*=\s*"([^"]+)"/mu)?.[1];
  if (!version) throw new Error("Missing Python project version");
  return version;
}
export function readReleaseState(root = process.cwd()) {
  const manifests = releasePackages.map((entry) => {
    const manifest = manifestObject(readFileSync(join(root, entry.manifest), "utf8"));
    if (stringField(manifest, "name") !== entry.name)
      throw new Error(`Unexpected package identity: ${entry.manifest}`);
    return {
      ...entry,
      manifestPath: entry.manifest,
      manifest,
      version: stringField(manifest, "version"),
    };
  });
  const npmVersion = manifests[0]?.version;
  if (!npmVersion) throw new Error("Missing release packages");
  parseVersion(npmVersion);
  const pythonVersion = readPythonVersion(readFileSync(join(root, pythonManifest), "utf8"));
  if (
    manifests.some((entry) => entry.version !== npmVersion) ||
    pythonVersion !== toPythonVersion(npmVersion)
  )
    throw new Error("Coordinated package version drift");
  const peers: unknown = Reflect.get(manifests[2]?.manifest ?? {}, "peerDependencies");
  if (
    typeof peers !== "object" ||
    peers === null ||
    Reflect.get(peers, "@remote-skills/client") !== `^${npmVersion}`
  )
    throw new Error("Integration client peer version drift");
  return {
    manifests,
    npmVersion,
    pythonVersion,
    prerelease: npmVersion.includes("-alpha."),
    npmTag: npmVersion.includes("-alpha.") ? "alpha" : "latest",
    gitTag: `v${npmVersion}`,
  };
}
export function changelogSection(source: string, version: string) {
  const marker = `## [${version}]`;
  const lines = source.split(/\r?\n/u);
  const start = lines.findIndex((line) => line === marker || line.startsWith(`${marker} - `));
  if (start < 0) throw new Error(`Missing changelog section ${marker}`);
  let end = start + 1;
  while (end < lines.length && !lines[end]?.startsWith("## [")) end++;
  const section = lines.slice(start, end);
  if (!section.slice(1).some((line) => line.trim() && !line.startsWith("#")))
    throw new Error("Empty changelog section");
  return `${section.join("\n").trim()}\n`;
}
export function prepareRelease(
  root: string,
  bump: Bump | "initial",
  channel: Channel,
  dryRun: boolean,
) {
  const state = readReleaseState(root);
  if (bump === "initial" && (state.npmVersion !== "0.0.1" || existsSync(join(root, releaseIntent))))
    throw new Error("The initial release has already been prepared or versions are not 0.0.1");
  const npmVersion =
    bump === "initial"
      ? `0.0.1${channel === "alpha" ? "-alpha.0" : ""}`
      : nextReleaseVersion(state.npmVersion, bump, channel);
  const pythonVersion = toPythonVersion(npmVersion);
  const source = readFileSync(join(root, "CHANGELOG.md"), "utf8");
  changelogSection(source, "Unreleased");
  const changelog = source.replace(
    "## [Unreleased]",
    `## [Unreleased]\n\n## [${npmVersion}] - ${new Date().toISOString().slice(0, 10)}`,
  );
  const writes: { path: string; source: string }[] = state.manifests.map((entry) => {
    Reflect.set(entry.manifest, "version", npmVersion);
    const peers: unknown = Reflect.get(entry.manifest, "peerDependencies");
    if (typeof peers === "object" && peers !== null && "@remote-skills/client" in peers)
      Reflect.set(peers, "@remote-skills/client", `^${npmVersion}`);
    return { path: entry.manifestPath, source: `${JSON.stringify(entry.manifest, null, 2)}\n` };
  });
  const pythonSource = readFileSync(join(root, pythonManifest), "utf8");
  writes.push(
    {
      path: pythonManifest,
      source: pythonSource.replace(
        `version = "${state.pythonVersion}"`,
        `version = "${pythonVersion}"`,
      ),
    },
    { path: "CHANGELOG.md", source: changelog },
    {
      path: releaseIntent,
      source: `${JSON.stringify({ version: npmVersion, previousVersion: state.npmVersion, initial: bump === "initial" }, null, 2)}\n`,
    },
  );
  if (!dryRun) for (const write of writes) writeFileSync(join(root, write.path), write.source);
  return {
    npmVersion,
    pythonVersion,
    previousNpmVersion: state.npmVersion,
    dryRun,
    changedFiles: writes.map((write) => write.path),
  };
}
export function validateReleaseCommit(root: string, sha: string) {
  if (!/^[0-9a-f]{40}$/u.test(sha)) throw new Error("Release SHA must be a full commit SHA");
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const subject = git("show", "-s", "--format=%s", sha);
  const match = /^chore: release v([^\s]+)(?: \(#\d+\))?$/u.exec(subject);
  const version = match?.[1];
  if (!version) throw new Error("Not an intentional release commit");
  parseVersion(version);
  const intent = manifestObject(git("show", `${sha}:${releaseIntent}`));
  if (stringField(intent, "version") !== version)
    throw new Error("Release intent version does not match");
  const initial = Reflect.get(intent, "initial") === true;
  if (initial) {
    if (version !== "0.0.1" && version !== "0.0.1-alpha.0")
      throw new Error("Invalid initial release version");
    const parentFiles = git("ls-tree", "--name-only", `${sha}^1`, releaseIntent);
    if (parentFiles) throw new Error("The initial release was already prepared");
  }
  for (const entry of releasePackages) {
    const current = manifestObject(git("show", `${sha}:${entry.manifest}`));
    const previous = manifestObject(git("show", `${sha}^1:${entry.manifest}`));
    if (stringField(current, "version") !== version)
      throw new Error("Release package version drift");
    const previousVersion = stringField(previous, "version");
    if (initial ? previousVersion !== "0.0.1" : previousVersion === version)
      throw new Error("Release version did not change or initial baseline is invalid");
    if (previousVersion !== stringField(intent, "previousVersion"))
      throw new Error("Release previous version drift");
  }
  const pythonVersion = readPythonVersion(git("show", `${sha}:${pythonManifest}`));
  if (pythonVersion !== toPythonVersion(version)) throw new Error("Release Python version drift");
  const previousPython = readPythonVersion(git("show", `${sha}^1:${pythonManifest}`));
  if (initial ? previousPython !== "0.0.1" : previousPython === pythonVersion)
    throw new Error("Python release version did not change");
  changelogSection(git("show", `${sha}:CHANGELOG.md`), version);
  return { npmVersion: version, pythonVersion };
}

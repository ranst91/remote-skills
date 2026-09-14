// Coordinated release policy adapted from the original release-ci implementation.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  isScope,
  pythonManifest,
  pythonPackages,
  releasePackages,
  releaseScopes,
  type Scope,
} from "./release-scopes.ts";

export {
  pythonManifest,
  pythonPackages,
  releasePackages,
  releaseScopes,
  type Scope,
} from "./release-scopes.ts";
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
export interface ScopeIntent {
  version: string;
  previousVersion: string;
  bump: Bump | "initial";
  channel: Channel;
}
export interface ReleaseIntent {
  schemaVersion: 2;
  baseSha: string;
  scopes: Partial<Record<Scope, ScopeIntent>>;
}
export interface SelectedPackage {
  id: string;
  name: string;
  version: string;
  registry: "npm" | "pypi";
  scope: Scope;
}
export function parseReleaseIntent(source: string): ReleaseIntent | undefined {
  const value = manifestObject(source);
  if (Reflect.get(value, "schemaVersion") !== 2) {
    // Read the original coordinated alpha intent, but never accumulate onto it.
    if (typeof Reflect.get(value, "version") === "string") return undefined;
    throw new Error("Unsupported release intent schema");
  }
  const baseSha = stringField(value, "baseSha");
  if (!/^[0-9a-f]{40}$/u.test(baseSha)) throw new Error("Invalid release baseline SHA");
  const raw: unknown = Reflect.get(value, "scopes");
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new Error("Invalid release scopes");
  const scopes: ReleaseIntent["scopes"] = {};
  for (const [scope, entry] of Object.entries(raw)) {
    if (!isScope(scope) || typeof entry !== "object" || entry === null)
      throw new Error("Invalid release scope");
    const version = stringField(entry, "version");
    const previousVersion = stringField(entry, "previousVersion");
    const bump = stringField(entry, "bump");
    const channel = stringField(entry, "channel");
    parseVersion(version);
    parseVersion(previousVersion);
    if (
      (bump !== "initial" && bump !== "patch" && bump !== "minor" && bump !== "major") ||
      (channel !== "stable" && channel !== "alpha")
    )
      throw new Error("Invalid release selection");
    if (version !== plannedVersion(previousVersion, bump, channel))
      throw new Error("Release version does not match its selection");
    scopes[scope] = { version, previousVersion, bump, channel };
  }
  if (!Object.keys(scopes).length) throw new Error("Empty release selection");
  return { schemaVersion: 2, baseSha, scopes };
}
function plannedVersion(previous: string, bump: Bump | "initial", channel: Channel) {
  if (bump !== "initial") return nextReleaseVersion(previous, bump, channel);
  if (previous !== "0.0.1")
    throw new Error("The initial release requires baseline 0.0.1; use patch to promote an alpha");
  return `0.0.1${channel === "alpha" ? "-alpha.0" : ""}`;
}
// The supported internal peer contract is an exact version or a caret range.
// Reject unfamiliar ranges for explicit maintainer review instead of widening them.
export function clientPeerCompatible(range: string, version: string) {
  if (range === version) return true;
  if (!range.startsWith("^"))
    throw new Error("Unsupported client peer range; use an exact version or caret range");
  const lower = parseVersion(range.slice(1));
  const candidate = parseVersion(version);
  const parts = [
    candidate.major - lower.major,
    candidate.minor - lower.minor,
    candidate.patch - lower.patch,
  ];
  const comparison = parts.find((part) => part !== 0) ?? 0;
  if (comparison < 0) return false;
  if (
    candidate.alpha !== undefined &&
    (comparison !== 0 || lower.alpha === undefined || candidate.alpha < lower.alpha)
  )
    return false;
  return lower.major > 0
    ? candidate.major === lower.major
    : lower.minor > 0
      ? candidate.major === 0 && candidate.minor === lower.minor
      : comparison === 0;
}
const legacyPackageIds = new Set<string>(["cli", "client", "ai_sdk"]);
const legacyScopes: Scope[] = ["core", "integration-ai-sdk"];
export function readReleaseState(root = process.cwd()) {
  const intentSource = existsSync(join(root, releaseIntent))
    ? readFileSync(join(root, releaseIntent), "utf8")
    : undefined;
  const intent = intentSource ? parseReleaseIntent(intentSource) : undefined;
  const legacy = intentSource !== undefined && intent === undefined;
  const availableManifest = (manifest: string) =>
    existsSync(join(root, manifest)) ||
    Boolean(
      execFileSync("git", ["ls-tree", "--name-only", "HEAD", "--", manifest], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim(),
    );
  const manifests = releasePackages
    .filter(
      (entry) => !legacy || legacyPackageIds.has(entry.id) || availableManifest(entry.manifest),
    )
    .map((entry) => {
      const manifest = manifestObject(readFileSync(join(root, entry.manifest), "utf8"));
      if (stringField(manifest, "name") !== entry.name)
        throw new Error(`Unexpected package identity: ${entry.manifest}`);
      const version = stringField(manifest, "version");
      parseVersion(version);
      return { ...entry, manifestPath: entry.manifest, manifest, version };
    });
  const npmVersion = manifests.find((entry) => entry.id === "client")?.version;
  if (!npmVersion) throw new Error("Missing core release packages");
  const pythonManifests = pythonPackages
    .filter((entry) => !legacy || entry.scope === "core" || availableManifest(entry.manifest))
    .map((entry) => {
      const source = readFileSync(join(root, entry.manifest), "utf8");
      const project = source.split(/^\[project\]\s*$/mu)[1]?.split(/^\[/mu)[0];
      if (project?.match(/^name\s*=\s*"([^"]+)"/mu)?.[1] !== entry.name)
        throw new Error(`Unexpected Python identity: ${entry.manifest}`);
      return { ...entry, manifestPath: entry.manifest, source, version: readPythonVersion(source) };
    });
  const pythonVersion = pythonManifests.find((entry) => entry.scope === "core")?.version;
  if (!pythonVersion) throw new Error("Missing core Python package");
  for (const scope of Object.keys(releaseScopes)) {
    const versions = manifests
      .filter((entry) => entry.scope === scope)
      .map((entry) => entry.version);
    if (!versions.length && legacy) continue;
    if (
      new Set(versions).size !== 1 ||
      pythonManifests.some(
        (entry) => entry.scope === scope && entry.version !== toPythonVersion(versions[0] ?? ""),
      )
    )
      throw new Error(`Coordinated ${scope} package version drift`);
  }
  const selectedScopes = intent
    ? Object.keys(intent.scopes).filter(isScope)
    : legacy
      ? legacyScopes
      : Object.keys(releaseScopes).filter(isScope);
  const selectedPackages: SelectedPackage[] = [
    ...manifests
      .filter((entry) => selectedScopes.includes(entry.scope))
      .map((entry) => ({
        id: entry.id,
        name: entry.name,
        version: entry.version,
        registry: "npm" as const,
        scope: entry.scope,
      })),
    ...pythonManifests
      .filter((entry) => selectedScopes.includes(entry.scope))
      .map((entry) => ({
        id: entry.id,
        name: entry.name,
        version: entry.version,
        registry: "pypi" as const,
        scope: entry.scope,
      })),
  ];
  const releases = selectedScopes.map((scope) => {
    const version = manifests.find((entry) => entry.scope === scope)?.version;
    if (!version) throw new Error(`Missing scope ${scope}`);
    if (intent && intent.scopes[scope]?.version !== version)
      throw new Error(`Release intent version drift for ${scope}`);
    return {
      scope,
      version,
      gitTag: intent ? `${scope}/v${version}` : `v${version}`,
      npmTag: version.includes("-alpha.") ? "alpha" : "latest",
      prerelease: version.includes("-alpha."),
      packages: selectedPackages.filter((entry) => entry.scope === scope),
    };
  });
  return {
    manifests,
    pythonManifests,
    npmVersion,
    pythonVersion,
    intent,
    selectedScopes,
    selectedPackages,
    releases,
    prerelease: npmVersion.includes("-alpha."),
    npmTag: npmVersion.includes("-alpha.") ? "alpha" : "latest",
    gitTag: `v${npmVersion}`,
  };
}
export function releaseSelections(root = process.cwd()) {
  return readReleaseState(root).releases;
}
function checkPeers(
  manifests: ReturnType<typeof readReleaseState>["manifests"],
  clientVersion: string,
) {
  for (const entry of manifests) {
    const peers: unknown = Reflect.get(entry.manifest, "peerDependencies");
    const range: unknown =
      typeof peers === "object" && peers !== null
        ? Reflect.get(peers, "@remote-skills/client")
        : undefined;
    if (
      range !== undefined &&
      (typeof range !== "string" || !clientPeerCompatible(range, clientVersion))
    )
      throw new Error(
        `${entry.name} client peer is incompatible with ${clientVersion}; review its peer range and select its integration scope before releasing`,
      );
  }
}
// The integration currently declares an exact SDK pin. Unknown requirement syntax
// requires explicit policy support rather than silently widening compatibility.
function checkPythonPeers(
  manifests: ReturnType<typeof readReleaseState>["pythonManifests"],
  sdkVersion: string,
) {
  for (const entry of manifests) {
    const project = entry.source.split(/^\[project\]\s*$/mu)[1]?.split(/^\[/mu)[0] ?? "";
    const dependencies = project.match(/^dependencies\s*=\s*\[([\s\S]*?)\]/mu)?.[1] ?? "";
    for (const match of dependencies.matchAll(/["'](remote[-_]skills(?:\b)[^"']*)["']/gu)) {
      const dependency = match[1] ?? "";
      if (/^remote[-_]skills[-_]/u.test(dependency)) continue;
      if (
        dependency !== `remote-skills==${sdkVersion}` &&
        dependency !== `remote_skills==${sdkVersion}`
      )
        throw new Error(
          `${entry.name} Python SDK dependency is incompatible with ${sdkVersion}; review its exact requirement and select its integration scope before releasing`,
        );
    }
  }
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
  scope: Scope = "core",
  baseSha?: string,
) {
  const state = readReleaseState(root);
  const baseline =
    baseSha ??
    state.intent?.baseSha ??
    execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  if (!/^[0-9a-f]{40}$/u.test(baseline)) throw new Error("Invalid release baseline SHA");
  // A merged intent belongs to the old cycle; only a distinct baseline starts anew.
  const accumulated = state.intent?.baseSha === baseline ? state.intent.scopes : {};
  const baselineFile = (path: string) =>
    execFileSync("git", ["show", `${baseline}:${path}`], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  for (const entry of state.manifests) {
    const baselineVersion = stringField(
      manifestObject(baselineFile(entry.manifestPath)),
      "version",
    );
    const pending = accumulated[entry.scope];
    if (
      entry.version !== (pending?.version ?? baselineVersion) ||
      (pending && pending.previousVersion !== baselineVersion)
    )
      throw new Error(`Package version differs from release baseline: ${entry.name}`);
  }
  for (const entry of state.pythonManifests) {
    const baselineVersion = readPythonVersion(baselineFile(entry.manifestPath));
    const pending = accumulated[entry.scope];
    if (
      entry.version !== (pending ? toPythonVersion(pending.version) : baselineVersion) ||
      (pending && toPythonVersion(pending.previousVersion) !== baselineVersion)
    )
      throw new Error(`Python release baseline drift: ${entry.name}`);
  }
  const previous =
    accumulated[scope]?.previousVersion ??
    state.manifests.find((entry) => entry.scope === scope)?.version;
  if (!previous) throw new Error(`Unknown release scope ${scope}`);
  if (
    bump === "initial" &&
    execFileSync("git", ["ls-tree", "--name-only", baseline, releaseIntent], {
      cwd: root,
      encoding: "utf8",
    }).trim()
  )
    throw new Error("The initial release has already been prepared; select a version bump instead");
  const version = plannedVersion(previous, bump, channel);
  const intent: ReleaseIntent = {
    schemaVersion: 2,
    baseSha: baseline,
    scopes: { ...accumulated, [scope]: { previousVersion: previous, version, bump, channel } },
  };
  const writes: { path: string; source: string }[] = [];
  for (const entry of state.manifests) {
    if (entry.scope !== scope) continue;
    Reflect.set(entry.manifest, "version", version);
    writes.push({
      path: entry.manifestPath,
      source: `${JSON.stringify(entry.manifest, null, 2)}\n`,
    });
  }
  const clientVersion = scope === "core" ? version : state.npmVersion;
  checkPeers(state.manifests, clientVersion);
  checkPeers(
    state.manifests
      .filter((entry) => !intent.scopes[entry.scope])
      .map((entry) => ({ ...entry, manifest: manifestObject(baselineFile(entry.manifestPath)) })),
    clientVersion,
  );
  const pythonClientVersion = toPythonVersion(clientVersion);
  checkPythonPeers(state.pythonManifests, pythonClientVersion);
  checkPythonPeers(
    state.pythonManifests
      .filter((entry) => !intent.scopes[entry.scope])
      .map((entry) => ({ ...entry, source: baselineFile(entry.manifestPath) })),
    pythonClientVersion,
  );
  for (const entry of state.pythonManifests.filter((entry) => entry.scope === scope))
    writes.push({
      path: entry.manifestPath,
      source: entry.source.replace(
        /(^\[project\][\s\S]*?^version\s*=\s*")[^"]+(".*$)/mu,
        `$1${toPythonVersion(version)}$2`,
      ),
    });
  let changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
  const oldSelection = accumulated[scope];
  if (oldSelection) {
    // Change only the generated heading; keep the maintainer's notes verbatim.
    changelogSection(changelog, `${scope}/v${oldSelection.version}`);
    changelog = changelog.replace(
      `## [${scope}/v${oldSelection.version}]`,
      `## [${scope}/v${version}]`,
    );
  } else {
    const lines = changelog.split("\n");
    const unreleasedIndex = lines.findIndex((line) => line === "## [Unreleased]");
    if (unreleasedIndex < 0) throw new Error("Missing changelog section ## [Unreleased]");
    const nextIndex = lines.findIndex(
      (line, index) => index > unreleasedIndex && line.startsWith("## ["),
    );
    const unreleased = lines
      .slice(unreleasedIndex + 1, nextIndex < 0 ? lines.length : nextIndex)
      .join("\n")
      .trim();
    const packageNames: string[] = state.manifests
      .filter((entry) => entry.scope === scope)
      .map((entry) => entry.name);
    packageNames.push(
      ...state.pythonManifests.filter((entry) => entry.scope === scope).map((entry) => entry.name),
    );
    // A factual scope summary allows preparation after a prior release consumed
    // Unreleased. The heading records the version, so revising a selection never
    // leaves a stale version in these notes or rewrites a maintainer's prose.
    const notes =
      unreleased || `- Release ${packageNames.join(", ")} at the version named in this section.`;
    lines.splice(
      nextIndex < 0 ? lines.length : nextIndex,
      0,
      `## [${scope}/v${version}] - ${new Date().toISOString().slice(0, 10)}`,
      "",
      notes,
      "",
    );
    changelog = lines.join("\n");
    // Unreleased text remains available to additional independently selected scopes.
  }
  writes.push(
    { path: "CHANGELOG.md", source: changelog },
    { path: releaseIntent, source: `${JSON.stringify(intent, null, 2)}\n` },
  );
  if (!dryRun) for (const write of writes) writeFileSync(join(root, write.path), write.source);
  return {
    scope,
    version,
    npmVersion: version,
    pythonVersion: scope === "core" ? toPythonVersion(version) : state.pythonVersion,
    previousNpmVersion: previous,
    intent,
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
  const legacyVersion = /^chore: release v([^\s]+)(?: \(#\d+\))?$/u.exec(subject)?.[1];
  if (legacyVersion) {
    validateLegacyRelease(git, sha, legacyVersion);
    if (git("rev-parse", "HEAD") !== sha)
      throw new Error("Release validation requires the exact commit checked out");
    const state = readReleaseState(root);
    checkPeers(state.manifests, state.npmVersion);
    return state;
  }
  if (!/^chore: release packages(?: \(#\d+\))?$/u.test(subject))
    throw new Error("Not an intentional release commit");
  const intent = parseReleaseIntent(git("show", `${sha}:${releaseIntent}`));
  if (!intent) throw new Error("Scoped release intent required");
  git("merge-base", "--is-ancestor", intent.baseSha, `${sha}^1`);
  const parentIntent = git("ls-tree", "--name-only", `${sha}^1`, releaseIntent)
    ? git("show", `${sha}^1:${releaseIntent}`)
    : undefined;
  if (parentIntent && parseReleaseIntent(parentIntent)?.baseSha === intent.baseSha)
    throw new Error("Release intent was already merged; start a new release cycle");
  for (const entry of releasePackages) {
    const current = stringField(manifestObject(git("show", `${sha}:${entry.manifest}`)), "version");
    const previous = stringField(
      manifestObject(git("show", `${sha}^1:${entry.manifest}`)),
      "version",
    );
    const selection = intent.scopes[entry.scope];
    if (
      selection
        ? current !== selection.version || previous !== selection.previousVersion
        : current !== previous
    )
      throw new Error(`Release package version drift: ${entry.name}`);
    if (selection && selection.bump !== "initial" && current === previous)
      throw new Error("Release version did not change");
  }
  for (const entry of pythonPackages) {
    const current = readPythonVersion(git("show", `${sha}:${entry.manifest}`));
    const previous = readPythonVersion(git("show", `${sha}^1:${entry.manifest}`));
    const selection = intent.scopes[entry.scope];
    if (
      selection
        ? current !== toPythonVersion(selection.version) ||
          previous !== toPythonVersion(selection.previousVersion)
        : current !== previous
    )
      throw new Error(`Release Python version drift: ${entry.name}`);
  }
  for (const [scope, selection] of Object.entries(intent.scopes))
    changelogSection(git("show", `${sha}:CHANGELOG.md`), `${scope}/v${selection.version}`);
  if (git("rev-parse", "HEAD") !== sha)
    throw new Error("Release validation requires the exact commit checked out");
  const state = readReleaseState(root);
  checkPeers(state.manifests, state.npmVersion);
  checkPythonPeers(state.pythonManifests, state.pythonVersion);
  return state;
}

// Historical coordinated releases remain retryable from their exact commit.
// Preparation only writes schema 2; this reader cannot create new legacy intent.
function validateLegacyRelease(git: (...args: string[]) => string, sha: string, version: string) {
  parseVersion(version);
  const intent = manifestObject(git("show", `${sha}:${releaseIntent}`));
  if (
    Reflect.get(intent, "schemaVersion") !== undefined ||
    stringField(intent, "version") !== version
  )
    throw new Error("Legacy release intent version does not match");
  const previousVersion = stringField(intent, "previousVersion");
  parseVersion(previousVersion);
  const initial = Reflect.get(intent, "initial") === true;
  if (initial) {
    if ((version !== "0.0.1" && version !== "0.0.1-alpha.0") || previousVersion !== "0.0.1")
      throw new Error("Invalid initial release version");
    if (git("ls-tree", "--name-only", `${sha}^1`, releaseIntent))
      throw new Error("The initial release was already prepared");
  }
  for (const entry of releasePackages.filter((entry) => legacyPackageIds.has(entry.id))) {
    const current = stringField(manifestObject(git("show", `${sha}:${entry.manifest}`)), "version");
    const previous = stringField(
      manifestObject(git("show", `${sha}^1:${entry.manifest}`)),
      "version",
    );
    if (current !== version || previous !== previousVersion)
      throw new Error("Legacy coordinated package version drift");
    if (!initial && previous === current) throw new Error("Release version did not change");
  }
  if (
    readPythonVersion(git("show", `${sha}:${pythonManifest}`)) !== toPythonVersion(version) ||
    readPythonVersion(git("show", `${sha}^1:${pythonManifest}`)) !==
      toPythonVersion(previousVersion)
  )
    throw new Error("Legacy coordinated Python version drift");
  changelogSection(git("show", `${sha}:CHANGELOG.md`), version);
}

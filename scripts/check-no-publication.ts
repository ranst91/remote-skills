import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ownRepository = realpathSync(fileURLToPath(new URL("..", import.meta.url)));
const argumentsByName = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index];
  const value = process.argv[index + 1];
  if (
    name === undefined ||
    !["--repository", "--readiness-evidence", "--output"].includes(name) ||
    value === undefined ||
    argumentsByName.has(name)
  ) {
    throw new Error(
      "usage: check-no-publication.ts [--repository PATH] [--readiness-evidence PATH] [--output PATH]",
    );
  }
  argumentsByName.set(name, value);
}
const nodeMajor = process.versions.node.split(".")[0];
if (nodeMajor === undefined || Number.parseInt(nodeMajor, 10) < 24) {
  throw new Error("no-publication boundary inspection requires Node.js 24 or newer");
}

const repository = realpathSync(resolve(argumentsByName.get("--repository") ?? ownRepository));

function runGit(args: readonly string[]): string {
  const result = spawnSync("git", args, {
    cwd: repository,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git inspection failed: ${args.join(" ")}`);
  }
  return result.stdout;
}

function runGitBytes(args: readonly string[]): Buffer {
  const result = spawnSync("git", args, {
    cwd: repository,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git inspection failed: ${args.join(" ")}`);
  }
  return result.stdout;
}

function repositoryState(expectedCommit?: string): string {
  const commit = runGit(["rev-parse", "--verify", "HEAD"]).trim();
  if (expectedCommit !== undefined && commit !== expectedCommit) {
    throw new Error(`repository HEAD changed during no-publication inspection`);
  }
  const status = runGit(["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status !== "") {
    throw new Error("no-publication inspection requires a fully clean repository");
  }
  return commit;
}

function canonicalAbsentPath(value: string, label: string): string {
  const unresolved = [basename(value)];
  let ancestor = dirname(resolve(value));
  while (!existsSync(ancestor)) {
    unresolved.unshift(basename(ancestor));
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new Error(`cannot resolve ${label} path`);
    ancestor = parent;
  }
  const result = join(realpathSync(ancestor), ...unresolved);
  if (lstatSync(result, { throwIfNoEntry: false }) !== undefined) {
    throw new Error(`${label} must not already exist`);
  }
  return result;
}

function canonicalExistingPath(value: string, label: string): string {
  try {
    return realpathSync(resolve(value));
  } catch {
    throw new Error(`${label} does not exist`);
  }
}

function requireOutsideRepository(path: string, label: string): void {
  const relation = relative(repository, path);
  if (relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation)) {
    throw new Error(`${label} must be outside the repository`);
  }
}

const sourceCommit = repositoryState();
const sourceTree = runGit(["rev-parse", `${sourceCommit}^{tree}`]).trim();
const readinessPath = canonicalExistingPath(
  argumentsByName.get("--readiness-evidence") ??
    process.env.NO_PUBLICATION_READINESS_INPUT ??
    join(tmpdir(), `remote-skills-publication-readiness-${process.platform}.json`),
  "readiness evidence",
);
const outputPath = canonicalAbsentPath(
  argumentsByName.get("--output") ??
    process.env.NO_PUBLICATION_EVIDENCE_OUTPUT ??
    join(tmpdir(), `remote-skills-no-publication-${process.platform}.json`),
  "no-publication evidence output",
);
requireOutsideRepository(readinessPath, "readiness evidence");
requireOutsideRepository(outputPath, "no-publication evidence output");

const classifications = {
  localPackageOperations: 0,
  negativeBoundaryStatements: 0,
  staticOriginPublishingLanguage: 0,
  offlineRegistrySentinels: 0,
  boundaryDefinitions: 0,
};
const coverage = {
  commandManifests: 0,
  scripts: 0,
  workflows: 0,
  documentation: 0,
  readinessOutputs: 1,
};
interface Finding {
  kind: string;
  path: string;
  line: number;
}

type InspectionCategory =
  | "boundaryDefinition"
  | "commandManifest"
  | "documentation"
  | "script"
  | "workflow";

const findings: Finding[] = [];

function addFinding(kind: string, path: string, line = 1): void {
  findings.push({ kind, path, line });
}

function lineNumber(text: string, offset: number): number {
  return text.slice(0, Math.max(0, offset)).split("\n").length;
}

function isDocumentation(path: string): boolean {
  return (
    /(?:^|\/)(?:README|AGENTS)(?:\.[^.]+)?$/iu.test(path) ||
    /^(?:docs|apps\/docs|openspec)\//u.test(path) ||
    /\.(?:md|mdx|txt)$/iu.test(path)
  );
}

function category(path: string): InspectionCategory | undefined {
  if (path === "scripts/check-no-publication.ts") return "boundaryDefinition";
  if (path.startsWith("tests/")) return undefined;
  if (/^\.github\/workflows\/[^/]+\.ya?ml$/u.test(path)) return "workflow";
  if (
    basename(path) === "package.json" ||
    basename(path) === "pyproject.toml" ||
    [".npmrc", ".pypirc", "pip.conf", "uv.toml"].includes(basename(path))
  ) {
    return "commandManifest";
  }
  if (
    path.startsWith("scripts/") ||
    path.startsWith(".github/actions/") ||
    /\.(?:[cm]?[jt]s|py|rb|sh|ps1|cmd|bat)$/iu.test(path) ||
    /^(?:Dockerfile|GNUmakefile|Makefile|justfile|Taskfile\.ya?ml)$/iu.test(basename(path))
  ) {
    return "script";
  }
  if (isDocumentation(path)) return "documentation";
  return undefined;
}

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9_@./:+${}-]+/gu) ?? [];
}

function follows(
  tokens: readonly string[],
  first: ReadonlySet<string>,
  second: ReadonlySet<string>,
  distance = 4,
): boolean {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined || !first.has(token)) continue;
    const end = Math.min(tokens.length, index + distance + 1);
    if (tokens.slice(index + 1, end).some((token) => second.has(token))) return true;
  }
  return false;
}

function scanCommands(text: string, path: string, line = 1, findingPrefix = ""): void {
  const tokens = tokenize(text);
  const packageTools = new Set(["npm", "npm.cmd", "pnpm", "pnpm.cmd", "yarn"]);
  const publishes = new Set(["publish"]);
  if (
    follows(tokens, packageTools, publishes) ||
    follows(tokens, new Set(["uv", "uv.exe"]), publishes, 3) ||
    follows(tokens, new Set(["twine"]), new Set(["upload", "register"]), 3) ||
    (follows(tokens, new Set(["python", "python3"]), new Set(["twine"]), 3) &&
      tokens.includes("upload"))
  ) {
    addFinding(`${findingPrefix}package-publication-command`, path, line);
  }
  if (
    follows(tokens, packageTools, new Set(["access", "owner", "login", "adduser", "token"]), 3) ||
    (follows(tokens, packageTools, new Set(["config"]), 2) && tokens.includes("registry"))
  ) {
    addFinding(`${findingPrefix}publication-registry-or-credential`, path, line);
  }
  if (
    follows(tokens, new Set(["git"]), new Set(["tag"]), 2) ||
    (follows(tokens, new Set(["gh"]), new Set(["release"]), 2) && tokens.includes("create"))
  ) {
    addFinding(`${findingPrefix}trusted-publishing-or-tag-trigger`, path, line);
  }
  if (
    follows(tokens, packageTools, new Set(["pack"]), 4) ||
    follows(tokens, new Set(["uv", "python", "python3"]), new Set(["build", "install"]), 5)
  ) {
    classifications.localPackageOperations += 1;
  }
}

function scanRegistryConfiguration(text: string, path: string, kind: InspectionCategory): void {
  const credential =
    /\b(?:NODE_AUTH_TOKEN|NPM_TOKEN|PYPI_TOKEN|TWINE_PASSWORD|TWINE_USERNAME|UV_PUBLISH_TOKEN)\b/u;
  if (credential.test(text)) {
    addFinding(
      "publication-registry-or-credential",
      path,
      lineNumber(text, text.search(credential)),
    );
  }

  if (kind === "commandManifest" && basename(path) === ".npmrc") {
    for (const [index, line] of text.split(/\r?\n/u).entries()) {
      const value = line.trim();
      if (value === "" || value.startsWith("#") || value.startsWith(";")) continue;
      if (/^(?:registry|@[^:]+:registry|.*:_auth(?:Token)?)\s*=/iu.test(value)) {
        addFinding("publication-registry-or-credential", path, index + 1);
      }
    }
  }

  if (kind === "commandManifest" && basename(path) === ".pypirc") {
    for (const [index, line] of text.split(/\r?\n/u).entries()) {
      if (/^\s*(?:repository|repository_url|username|password)\s*=/iu.test(line)) {
        addFinding("publication-registry-or-credential", path, index + 1);
      }
    }
  }

  if (kind === "workflow" && /^\s*(?:registry-url|repository-url)\s*:/imu.test(text)) {
    addFinding("publication-registry-or-credential", path);
  }

  if (/"publishConfig"\s*:/u.test(text)) {
    addFinding(
      "publication-registry-or-credential",
      path,
      lineNumber(text, text.indexOf('"publishConfig"')),
    );
  }

  const hasNpmRegistryOverride = /\bnpm_config_registry\b/u.test(text);
  const hasUvRegistryOverride = /\bUV_(?:DEFAULT_INDEX|INDEX)\b/u.test(text);
  if (hasNpmRegistryOverride || hasUvRegistryOverride) {
    const offlineSentinel =
      (!hasNpmRegistryOverride ||
        (/npm_config_offline["']?\s*[:=]\s*["']?true/iu.test(text) &&
          /npm_config_registry["']?\s*[:=]\s*["']?http:\/\/127\.0\.0\.1:9/iu.test(text))) &&
      (!hasUvRegistryOverride ||
        (/UV_OFFLINE["']?\s*[:=]\s*["']?true/iu.test(text) &&
          /UV_(?:DEFAULT_INDEX|INDEX)["']?\s*[:=]\s*["']?http:\/\/127\.0\.0\.1:9(?:\/simple)?/iu.test(
            text,
          )));
    if (offlineSentinel) classifications.offlineRegistrySentinels += 1;
    else addFinding("publication-registry-or-credential", path);
  }
}

function scanWorkflow(text: string, path: string): void {
  const trustedPublishing =
    /\bid-token\s*:\s*write\b/iu.test(text) ||
    /^\s*tags(?:-ignore)?\s*:/imu.test(text) ||
    /pypa\/gh-action-pypi-publish|npm\/action-publish/iu.test(text);
  if (trustedPublishing) addFinding("trusted-publishing-or-tag-trigger", path);
}

function scanDocumentation(text: string, path: string, findingPrefix = ""): void {
  const negator =
    /\b(?:no|not|never|without|does not|do not|shall not|cannot|did not|doesn't|isn't|aren't|wasn't|weren't)\b/iu;
  const relevant =
    /\b(?:npm|pypi|registry|publication|publish(?:ed|ing)?|reserved|trusted publishing)\b/iu;
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    const phrases = line
      .split(/[.!?;]+|:\s+|\s+[—–]\s+|\b(?:and|but|however|yet)\b/iu)
      .map((phrase) => phrase.trim())
      .filter(Boolean);
    for (const phrase of phrases) {
      const isNegative = negator.test(phrase);
      if (relevant.test(phrase) && isNegative) {
        classifications.negativeBoundaryStatements += 1;
      }
      if (/\bpublish(?:er|ing|ed)\b/iu.test(phrase) && !/\b(?:npm|pypi)\b/iu.test(phrase)) {
        classifications.staticOriginPublishingLanguage += 1;
      }
      if (!isNegative) scanCommands(phrase, path, index + 1, findingPrefix);
      if (
        !isNegative &&
        (/\b(?:is|are|was|were|has been|have been)\s+(?:now\s+)?published(?:\s+(?:on|to))?\s+(?:npm|pypi)\b/iu.test(
          phrase,
        ) ||
          /\b(?:available|released)\s+(?:on|from|to)\s+(?:npm|pypi)\b/iu.test(phrase))
      ) {
        addFinding(`${findingPrefix}completed-publication-claim`, path, index + 1);
      }
      if (
        !isNegative &&
        /\b(?:npm|pypi|package(?: name)?|organization)\b.{0,100}\b(?:already reserved|is reserved|has been (?:reserved|claimed)|is claimed)\b/iu.test(
          phrase,
        )
      ) {
        addFinding(`${findingPrefix}package-name-claim`, path, index + 1);
      }
      if (
        !isNegative &&
        /\btrusted publishing\b/iu.test(phrase) &&
        /\b(?:configured|enabled|release|uses?|via)\b/iu.test(phrase)
      ) {
        addFinding(`${findingPrefix}trusted-publishing-or-tag-trigger`, path, index + 1);
      }
    }
  }
}

function scanReadinessStrings(value: unknown): void {
  if (typeof value === "string") {
    scanDocumentation(value, "readiness-output", "readiness-");
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) scanReadinessStrings(item);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) scanReadinessStrings(item);
  }
}

interface NormalizedReadiness {
  artifacts: Array<{
    ecosystem: unknown;
    format: unknown;
    localArtifact: unknown;
    name: unknown;
  }>;
  kind: string;
  registryAccess: unknown;
  publication: unknown;
  source: { commit: unknown; trackedTreeClean: unknown };
  statement: unknown;
  status: string;
}

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

function property(value: object, name: string): unknown {
  return Reflect.get(value, name);
}

function normalizeReadiness(value: unknown): NormalizedReadiness | undefined {
  if (!isObject(value)) return undefined;
  const sourceValue = property(value, "source");
  const artifactsValue = property(value, "artifacts");
  if (!isObject(sourceValue) || !Array.isArray(artifactsValue)) return undefined;
  const artifacts: NormalizedReadiness["artifacts"] = [];
  for (const artifact of artifactsValue) {
    if (!isObject(artifact)) return undefined;
    artifacts.push({
      ecosystem: property(artifact, "ecosystem"),
      format: property(artifact, "format"),
      localArtifact: property(artifact, "localArtifact"),
      name: property(artifact, "name"),
    });
  }
  const kind = property(value, "kind");
  const status = property(value, "status");
  if (typeof kind !== "string" || typeof status !== "string") return undefined;
  return {
    artifacts,
    kind,
    registryAccess: property(value, "registryAccess"),
    publication: property(value, "publication"),
    source: {
      commit: property(sourceValue, "commit"),
      trackedTreeClean: property(sourceValue, "trackedTreeClean"),
    },
    statement: property(value, "statement"),
    status,
  };
}

function invalidReadiness(): NormalizedReadiness {
  return {
    artifacts: [],
    kind: "",
    publication: undefined,
    registryAccess: undefined,
    source: { commit: undefined, trackedTreeClean: undefined },
    statement: undefined,
    status: "",
  };
}

function inspectReadiness(): NormalizedReadiness {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(readinessPath, "utf8"));
  } catch {
    addFinding("readiness-publication-claim", "readiness-output");
    return invalidReadiness();
  }
  const readiness = normalizeReadiness(parsed);
  if (readiness === undefined) {
    addFinding("readiness-publication-claim", "readiness-output");
    return invalidReadiness();
  }
  const expectedArtifacts = new Set([
    "npm:@remote-skills/cli:",
    "npm:@remote-skills/client:",
    "pypi:remote-skills:wheel",
    "pypi:remote-skills:sdist",
  ]);
  const artifacts = Array.isArray(readiness.artifacts) ? readiness.artifacts : [];
  for (const artifact of artifacts) {
    expectedArtifacts.delete(`${artifact.ecosystem}:${artifact.name}:${artifact.format ?? ""}`);
  }
  if (
    readiness.kind !== "remote-skills-local-publication-readiness" ||
    readiness.status !== "local-artifacts-verified" ||
    readiness.publication !== false ||
    readiness.registryAccess !== false ||
    readiness.source?.commit !== sourceCommit ||
    readiness.source?.trackedTreeClean !== true ||
    artifacts.length !== 4 ||
    artifacts.some((artifact) => artifact.localArtifact !== true) ||
    expectedArtifacts.size !== 0 ||
    readiness.statement !== "No package was published; these are local artifact checks only."
  ) {
    addFinding("readiness-publication-claim", "readiness-output");
  }
  scanReadinessStrings(parsed);
  return readiness;
}

const readiness = inspectReadiness();
const treeEntries = runGit(["ls-tree", "-r", "-z", "--full-tree", sourceCommit])
  .split("\0")
  .filter(Boolean)
  .map((entry) => {
    const match = entry.match(/^\d+ blob ([0-9a-f]+)\t(.+)$/u);
    if (!match) throw new Error("unexpected tracked tree entry");
    const object = match[1];
    const path = match[2];
    if (object === undefined || path === undefined)
      throw new Error("unexpected tracked tree entry");
    return { object, path };
  });
const inventoryHash = createHash("sha256");
let inspectedFiles = 0;
for (const entry of treeEntries) {
  inventoryHash.update(`${entry.path}\0${entry.object}\0`);
  const kind = category(entry.path);
  if (kind === undefined) continue;
  inspectedFiles += 1;
  if (kind === "boundaryDefinition") {
    classifications.boundaryDefinitions += 1;
    continue;
  }
  if (kind === "commandManifest") coverage.commandManifests += 1;
  else if (kind === "script") coverage.scripts += 1;
  else if (kind === "workflow") coverage.workflows += 1;
  else coverage.documentation += 1;
  const blob = runGitBytes(["cat-file", "blob", entry.object]);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(blob);
  } catch {
    addFinding("inspection-input-invalid", entry.path);
    continue;
  }
  if (kind !== "documentation") {
    scanCommands(text, entry.path);
    scanRegistryConfiguration(text, entry.path, kind);
  }
  if (kind === "workflow") scanWorkflow(text, entry.path);
  if (kind === "documentation") scanDocumentation(text, entry.path);
}

if (findings.length > 0) {
  for (const finding of findings) {
    process.stderr.write(`${finding.kind} ${finding.path}:${finding.line}\n`);
  }
  throw new Error(`no-publication boundary has ${findings.length} prohibited finding(s)`);
}

repositoryState(sourceCommit);
const evidence = {
  schemaVersion: 1,
  kind: "remote-skills-no-publication-boundary",
  status: "no-publication-boundary-verified",
  statement:
    "No npm or PyPI publication, upload, package-name reservation, registry or Trusted Publishing configuration, publication credential, or tag-triggered publication was found or claimed.",
  source: {
    commit: sourceCommit,
    tree: sourceTree,
    trackedTreeClean: true,
    inventorySha256: inventoryHash.digest("hex"),
  },
  publication: false,
  registryAccess: false,
  readiness: {
    kind: readiness.kind,
    status: readiness.status,
    commit: readiness.source.commit,
    localArtifacts: readiness.artifacts.length,
  },
  inspection: {
    trackedFiles: treeEntries.length,
    inspectedFiles,
    coverage,
    prohibitedFindings: 0,
    allowedClassifications: classifications,
  },
};
writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, {
  encoding: "utf8",
  flag: "wx",
  mode: 0o600,
});
process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);

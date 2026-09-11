import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import { createPnpmCommand } from "./lib/pnpm-command.ts";
import { resolveCompatibleUvCommand } from "./lib/uv-command.ts";
import { checkInstalledIntegration } from "./release/installed-integration.ts";
import { readReleaseState } from "./release/release-lib.ts";
import { installPythonArtifact } from "./release/python-artifacts.ts";

const repositoryRoot = realpathSync(
  process.env.REMOTE_SKILLS_SOURCE_ROOT ?? fileURLToPath(new URL("..", import.meta.url)),
);
const contract = {
  schemaVersion: 1,
  kind: "remote-skills-local-publication-readiness",
  artifacts: [
    "@remote-skills/cli npm tarball",
    "@remote-skills/client npm tarball",
    "@remote-skills/ai-sdk npm tarball",
    "remote-skills Python wheel",
    "remote-skills Python source distribution",
  ],
  registryAccess: false,
  publication: false,
  pythonRequirement: "3.11",
  deterministicEnvironment: true,
  independentArchiveInspection: true,
  evidenceIncludesCommit: true,
  evidenceIncludesPlatform: true,
};

interface PackedFile {
  path: string;
}

interface PackedNpm {
  filename: string;
  files: PackedFile[];
  name: string;
  version: string;
}

interface RunOptions {
  cwd?: string;
}

interface ArtifactIdentity {
  ecosystem: string;
  format?: string;
  name: string;
  version: string;
}

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

function property(value: object, name: string): unknown {
  return Reflect.get(value, name);
}

function requireString(value: object, name: string, label: string): string {
  const result = property(value, name);
  if (typeof result !== "string") throw new Error(`${label}.${name} must be a string`);
  return result;
}

function parsePackedNpm(serialized: string): PackedNpm {
  const value: unknown = JSON.parse(serialized);
  if (!isObject(value)) throw new Error("pack result must be an object");
  const filesValue = property(value, "files");
  if (!Array.isArray(filesValue)) throw new Error("pack result files must be an array");
  const files: PackedFile[] = filesValue.map((file: unknown) => {
    if (!isObject(file)) throw new Error("pack result file must be an object");
    return { path: requireString(file, "path", "pack result file") };
  });
  return {
    filename: requireString(value, "filename", "pack result"),
    files,
    name: requireString(value, "name", "pack result"),
    version: requireString(value, "version", "pack result"),
  };
}

const [mode, expectedCommit] = process.argv.slice(2);
if (mode === "--describe" && expectedCommit === undefined) {
  process.stdout.write(`${JSON.stringify(contract, null, 2)}\n`);
  process.exit(0);
}
if (
  (mode !== undefined && mode !== "--check-repository-state") ||
  (mode === undefined && expectedCommit !== undefined) ||
  process.argv.length > 4
) {
  throw new Error(
    "usage: check-publication-readiness.ts [--describe | --check-repository-state [expected-commit]]",
  );
}
const nodeMajor = process.versions.node.split(".")[0];
if (nodeMajor === undefined || Number.parseInt(nodeMajor, 10) < 24) {
  throw new Error("publication readiness requires Node.js 24 or newer");
}

const offlineEnvironment: NodeJS.ProcessEnv = {
  ...process.env,
  FORCE_COLOR: "0",
  PYTHONHASHSEED: "0",
  SOURCE_DATE_EPOCH: "0",
  TZ: "UTC",
  COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
  npm_config_offline: "true",
  npm_config_registry: "http://127.0.0.1:9",
  UV_OFFLINE: "true",
  UV_PYTHON_DOWNLOADS: "never",
};

function run(command: string, args: readonly string[], options: RunOptions = {}): string {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repositoryRoot,
    encoding: "utf8",
    env: offlineEnvironment,
    maxBuffer: 16 * 1024 * 1024,
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    throw new Error(
      "command failed (" +
        (result.status ?? result.signal ?? "unknown") +
        "): " +
        command +
        " " +
        args.join(" "),
    );
  }
  return result.stdout.trim();
}

function runPnpm(arguments_: readonly string[], options: RunOptions = {}): string {
  const launch = createPnpmCommand(arguments_);
  return run(launch.command, launch.args, options);
}

function version(command: string, args: readonly string[]): string {
  const value = run(command, args).split(/\r?\n/u).at(-1);
  if (value === undefined) throw new Error(`${command} returned no version output`);
  return value.trim();
}

function pnpmVersion(): string {
  const value = runPnpm(["--version"]).split(/\r?\n/u).at(-1);
  if (value === undefined) throw new Error("pnpm returned no version output");
  return value.trim();
}

function requireRepositoryState(expected?: string): string {
  const head = run("git", ["rev-parse", "--verify", "HEAD"]);
  if (expected !== undefined && head !== expected) {
    throw new Error(`repository HEAD changed during publication readiness: ${expected} -> ${head}`);
  }
  const status = run("git", ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status !== "") {
    throw new Error(`publication readiness requires a fully clean repository:\n${status}`);
  }
  return head;
}

function canonicalOutputPath(value: string): string {
  const unresolved = [basename(value)];
  let ancestor = dirname(resolve(value));
  while (!existsSync(ancestor)) {
    unresolved.unshift(basename(ancestor));
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new Error(`cannot resolve evidence output path: ${value}`);
    ancestor = parent;
  }
  return join(realpathSync(ancestor), ...unresolved);
}

if (mode === "--check-repository-state") {
  process.stdout.write(`${requireRepositoryState(expectedCommit)}\n`);
  process.exit(0);
}

const uvCommand = resolveCompatibleUvCommand({ environment: offlineEnvironment });
offlineEnvironment.REMOTE_SKILLS_UV = uvCommand;

const evidenceOutput = canonicalOutputPath(
  process.env.PUBLICATION_READINESS_OUTPUT ??
    join(tmpdir(), `remote-skills-publication-readiness-${process.platform}.json`),
);
const outputWithinRepository = relative(repositoryRoot, evidenceOutput);
const outputIsOutsideRepository =
  outputWithinRepository === ".." ||
  outputWithinRepository.startsWith(`..${sep}`) ||
  isAbsolute(outputWithinRepository);
if (!outputIsOutsideRepository) {
  throw new Error("publication-readiness evidence must be written outside the repository");
}
if (lstatSync(evidenceOutput, { throwIfNoEntry: false }) !== undefined) {
  throw new Error("publication-readiness evidence output must not already exist");
}

const sourceCommit = requireRepositoryState();
const releaseState = readReleaseState(repositoryRoot);

function packNpm(packageName: string, artifactDirectory: string): PackedNpm {
  const output = runPnpm([
    "--silent",
    "--filter",
    packageName,
    "run",
    "pack:local",
    "--",
    "--pack-destination",
    artifactDirectory,
  ]);
  const packed = parsePackedNpm(output);
  const required = new Set(["LICENSE", "README.md", "package.json"]);
  for (const file of packed.files) required.delete(file.path);
  if (required.size > 0) {
    throw new Error(`${packageName} tarball is missing ${[...required].join(", ")}`);
  }
  if (packed.name !== packageName || packed.version !== releaseState.npmVersion) {
    throw new Error(`unexpected packed identity: ${packed.name}@${packed.version}`);
  }
  return packed;
}

function tarString(bytes: Buffer): string {
  const terminator = bytes.indexOf(0);
  return bytes.subarray(0, terminator < 0 ? bytes.length : terminator).toString("utf8");
}

function inspectNpmTarball(packed: PackedNpm) {
  const archive = gunzipSync(readFileSync(packed.filename));
  const files = new Map<string, Buffer>();
  let offset = 0;
  let extendedPath: string | undefined;
  while (offset + 512 <= archive.byteLength) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = tarString(header.subarray(0, 100));
    const prefix = tarString(header.subarray(345, 500));
    const archivePath = prefix ? `${prefix}/${name}` : name;
    const rawSize = tarString(header.subarray(124, 136)).trim();
    const size = rawSize === "" ? 0 : Number.parseInt(rawSize, 8);
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new Error(`invalid tar entry size in ${packed.filename}: ${archivePath}`);
    }
    const contentStart = offset + 512;
    const contentEnd = contentStart + size;
    if (contentEnd > archive.byteLength) {
      throw new Error(`truncated tar entry in ${packed.filename}: ${archivePath}`);
    }
    const content = archive.subarray(contentStart, contentEnd);
    if (header[156] === 76) {
      extendedPath = tarString(content);
    } else if (header[156] === 120) {
      const pathRecord = content.toString("utf8").match(/(?:^|\n)[0-9]+ path=([^\n]+)\n/u);
      const path = pathRecord?.[1];
      if (path !== undefined) extendedPath = path;
    } else if (header[156] === 0 || header[156] === 48) {
      files.set(extendedPath ?? archivePath, content);
      extendedPath = undefined;
    }
    offset = contentStart + Math.ceil(size / 512) * 512;
  }

  const expected = packed.files.map(({ path }) => `package/${path}`).sort();
  const actual = [...files.keys()].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    const mismatch = Math.min(
      ...actual.map((value, index) =>
        value === expected[index] ? Number.MAX_SAFE_INTEGER : index,
      ),
    );
    throw new Error(
      `${packed.name} tarball inventory differs from its pack result at ${mismatch}: ` +
        `${actual[mismatch] ?? "<missing>"} != ${expected[mismatch] ?? "<missing>"} ` +
        `(${actual.length} actual, ${expected.length} expected)`,
    );
  }
  const manifestBytes = files.get("package/package.json");
  if (!manifestBytes) throw new Error(`${packed.name} tarball has no package.json`);
  const manifestValue: unknown = JSON.parse(manifestBytes.toString("utf8"));
  if (!isObject(manifestValue)) throw new Error(`${packed.name} manifest must be an object`);
  const manifest = {
    license: requireString(manifestValue, "license", "npm artifact manifest"),
    name: requireString(manifestValue, "name", "npm artifact manifest"),
    version: requireString(manifestValue, "version", "npm artifact manifest"),
  };
  if (
    manifest.name !== packed.name ||
    manifest.version !== packed.version ||
    manifest.license !== "Apache-2.0"
  ) {
    throw new Error(`unexpected npm artifact manifest: ${manifest.name}@${manifest.version}`);
  }
  if (!files.has("package/LICENSE") || !files.has("package/README.md")) {
    throw new Error(`${packed.name} tarball is missing its license or README`);
  }
  return {
    entries: actual.length,
    manifest: {
      name: manifest.name,
      version: manifest.version,
      license: manifest.license,
    },
    requiredFiles: {
      license: files.has("package/LICENSE"),
      readme: files.has("package/README.md"),
    },
  };
}

function cleanInstallNpm(packed: PackedNpm, workRoot: string): void {
  const label = packed.name.endsWith("/cli") ? "cli" : "client";
  const project = join(workRoot, `npm-install-${label}`);
  const store = join(workRoot, `npm-store-${label}`);
  mkdirSync(project);
  writeFileSync(
    join(project, "package.json"),
    `${JSON.stringify({
      name: `remote-skills-readiness-${label}`,
      private: true,
      type: "module",
      packageManager: "pnpm@10.33.4",
    })}\n`,
  );
  runPnpm(["add", "--offline", "--ignore-scripts", "--store-dir", store, packed.filename], {
    cwd: project,
  });
  if (label === "cli") {
    const entrypoint = join(project, "node_modules", "@remote-skills", "cli", "dist", "cli.js");
    const output = run(process.execPath, [entrypoint, "--version"], { cwd: project });
    if (output !== packed.version) throw new Error(`installed CLI reported ${output}`);
  } else {
    run(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        'const value = await import("@remote-skills/client"); if (typeof value.createRemoteSkills !== "function") throw new Error("missing createRemoteSkills");',
      ],
      { cwd: project },
    );
  }
}

function cleanInstallPython(distribution: string, label: string, workRoot: string): string {
  const environmentRoot = join(workRoot, `python-install-${label}`);
  run(uvCommand, [
    "venv",
    "--python",
    "3.11",
    "--no-python-downloads",
    "--no-config",
    environmentRoot,
  ]);
  const python =
    process.platform === "win32"
      ? join(environmentRoot, "Scripts", "python.exe")
      : join(environmentRoot, "bin", "python");
  const constraints = process.env.REMOTE_SKILLS_PYTHON_CONSTRAINTS;
  if (!constraints) throw new Error("Python artifact dependencies must be prepared explicitly");
  if (label === "wheel") {
    const emptyCache = join(workRoot, "missing-python-dependencies");
    mkdirSync(emptyCache);
    let missingDependency = false;
    try {
      installPythonArtifact(
        distribution,
        python,
        constraints,
        { ...offlineEnvironment, UV_CACHE_DIR: emptyCache },
        repositoryRoot,
      );
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !/not found in the cache/u.test(error.message) ||
        !/requirements are unsatisfiable/u.test(error.message)
      )
        throw error;
      missingDependency = true;
    }
    if (!missingDependency)
      throw new Error("The artifact unexpectedly installed without its required dependency cache");
    console.log("Verified: an empty cache rejects the wheel's missing runtime dependencies.");
  }
  installPythonArtifact(distribution, python, constraints, offlineEnvironment, repositoryRoot);
  run(python, [
    "-I",
    "-c",
    'from importlib.metadata import version; from pathlib import Path; import remote_skills, sys, uts46; root = Path(sys.prefix).resolve(); assert version("remote-skills") == sys.argv[1]; assert version("uts46") == "0.2.0"; assert Path(remote_skills.__file__).resolve().is_relative_to(root); assert Path(uts46.__file__).resolve().is_relative_to(root)',
    releaseState.pythonVersion,
  ]);
  return version(python, ["--version"]);
}

function artifactEvidence(path: string, identity: ArtifactIdentity, inspection: unknown) {
  const bytes = readFileSync(path);
  return {
    ...identity,
    file: path.split(/[\\/]/u).at(-1),
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    inspection,
    cleanInstall: "passed",
    localArtifact: true,
  };
}

const workRoot = mkdtempSync(join(tmpdir(), "remote-skills-publication-readiness-"));
try {
  const artifactDirectory = join(workRoot, "artifacts");
  mkdirSync(artifactDirectory);

  runPnpm(["package:check"]);
  const cli = packNpm("@remote-skills/cli", artifactDirectory);
  const client = packNpm("@remote-skills/client", artifactDirectory);
  const integration = packNpm("@remote-skills/ai-sdk", artifactDirectory);
  run(uvCommand, [
    "build",
    "--offline",
    "--no-index",
    "--no-python-downloads",
    "--no-config",
    "--no-create-gitignore",
    "--out-dir",
    artifactDirectory,
    "packages/sdk-python",
  ]);

  const names = readdirSync(artifactDirectory).sort();
  const wheelName = names.find((name) => name.endsWith(".whl"));
  const sourceName = names.find((name) => name.endsWith(".tar.gz"));
  if (!wheelName || !sourceName || names.length !== 5) {
    throw new Error(`expected five local artifacts, found: ${names.join(", ")}`);
  }
  const wheel = join(artifactDirectory, wheelName);
  const source = join(artifactDirectory, sourceName);
  const pythonInspectionValue: unknown = JSON.parse(
    run(uvCommand, [
      "run",
      "--project",
      "packages/sdk-python",
      "--locked",
      "--no-sync",
      "python",
      "scripts/inspect-python-distributions.py",
      wheel,
      source,
    ]),
  );
  if (!Array.isArray(pythonInspectionValue) || pythonInspectionValue.length !== 2) {
    throw new Error("Python artifact inspection must describe exactly two distributions");
  }
  cleanInstallNpm(cli, workRoot);
  cleanInstallNpm(client, workRoot);
  checkInstalledIntegration([client.filename, integration.filename], repositoryRoot);
  const wheelPython = cleanInstallPython(wheel, "wheel", workRoot);
  const sourcePython = cleanInstallPython(source, "sdist", workRoot);
  if (wheelPython !== sourcePython || !/^Python 3\.11\./u.test(wheelPython)) {
    throw new Error("Python clean-install versions differ or are unsupported");
  }

  const artifacts = [
    artifactEvidence(
      integration.filename,
      { ecosystem: "npm", name: integration.name, version: integration.version },
      inspectNpmTarball(integration),
    ),
    artifactEvidence(
      cli.filename,
      { ecosystem: "npm", name: cli.name, version: cli.version },
      inspectNpmTarball(cli),
    ),
    artifactEvidence(
      client.filename,
      { ecosystem: "npm", name: client.name, version: client.version },
      inspectNpmTarball(client),
    ),
    artifactEvidence(
      wheel,
      {
        ecosystem: "pypi",
        name: "remote-skills",
        version: releaseState.pythonVersion,
        format: "wheel",
      },
      pythonInspectionValue[0],
    ),
    artifactEvidence(
      source,
      {
        ecosystem: "pypi",
        name: "remote-skills",
        version: releaseState.pythonVersion,
        format: "sdist",
      },
      pythonInspectionValue[1],
    ),
  ];
  const environment = {
    integrationDependencies: "preseeded runtime dependency cache; offline resolution",
    platform: process.platform,
    architecture: process.arch,
    node: process.version,
    pnpm: pnpmVersion(),
    python: wheelPython,
    uv: version(uvCommand, ["--version"]),
  };
  requireRepositoryState(sourceCommit);
  const retained = process.env.PUBLICATION_ARTIFACT_OUTPUT;
  if (retained) {
    for (const [kind, files] of [
      ["npm", [cli.filename, client.filename, integration.filename]],
      ["python", [wheel, source]],
    ] as const) {
      mkdirSync(join(retained, kind), { recursive: true });
      for (const file of files) copyFileSync(file, join(retained, kind, basename(file)));
    }
  }
  const evidence = {
    ...contract,
    status: "local-artifacts-verified",
    statement: "No package was published; these are local artifact checks only.",
    source: {
      commit: sourceCommit,
      trackedTreeClean: true,
    },
    environment,
    checks: {
      packageArtifactGate: "passed",
      registryAccess: false,
      cleanInstall: "passed",
    },
    artifacts,
  };
  const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
  mkdirSync(dirname(evidenceOutput), { recursive: true });
  writeFileSync(evidenceOutput, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
  process.stdout.write(serialized);
  process.stderr.write(`local publication-readiness evidence: ${evidenceOutput}\n`);
} finally {
  rmSync(workRoot, { recursive: true, force: true });
}

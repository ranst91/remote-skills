import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const coreRoot = fileURLToPath(new URL("../../core", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const DEVELOPMENT_DIRECTORIES = new Set([
  ".github",
  ".nyc_output",
  "benchmark",
  "benchmarks",
  "coverage",
  "demo",
  "demos",
  "docs",
  "example",
  "examples",
  "fixture",
  "fixtures",
  "spec",
  "specs",
  "test",
  "tests",
]);
const RUNTIME_EXTENSIONS = new Set(["", ".cjs", ".js", ".json", ".mjs", ".node", ".wasm"]);
const WORKSPACE_CONFIG =
  /^(?:biome\.jsonc?|lerna\.json|pnpm-workspace\.yaml|tsconfig(?:\..*)?\.json|turbo\.json)$/iu;
const TOOL_CONFIG =
  /^(?:\.(?:eslint|npm|prettier|yarn)rc|(?:eslint|prettier|rollup|vite|vitest|webpack)\.config)(?:\..*)?$/iu;
const DOCUMENTATION_FILE =
  /^(?:authors?|changelog|code_of_conduct|contributing|readme)(?:\..*)?$/iu;
const LICENSE_FILE = /^(?:copying|licen[cs]e|notice)(?:\..*)?$/iu;
const LOCAL_DEPENDENCY_PROTOCOL = /^(?:catalog|file|link|workspace):/u;
const DEPENDENCY_FIELDS = ["dependencies", "optionalDependencies", "peerDependencies"];
const RUNTIME_MANIFEST_FIELDS = [
  "name",
  "version",
  "description",
  "repository",
  "type",
  "main",
  "module",
  "exports",
  "imports",
  "browser",
  "bin",
  "engines",
  "os",
  "cpu",
  "license",
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
  "peerDependenciesMeta",
  "bundledDependencies",
] as const;

type DependencyMap = Record<string, string>;
type PackageManifest = {
  [key: string]: unknown;
  name?: string;
  version?: string;
  dependencies?: DependencyMap;
  optionalDependencies?: DependencyMap;
  peerDependencies?: DependencyMap;
};

function dependencyMap(value: unknown, field: string): DependencyMap {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`invalid ${field} manifest field`);
  }
  const dependencies: DependencyMap = {};
  for (const [name, range] of Object.entries(value)) {
    if (typeof range !== "string") throw new Error(`invalid dependency range for ${name}`);
    dependencies[name] = range;
  }
  return dependencies;
}

/** @param {string} file */
function readManifest(file: string): PackageManifest {
  const value: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`invalid package manifest: ${file}`);
  }
  return Object.fromEntries(Object.entries(value));
}

function runtimeManifest(manifest: PackageManifest): PackageManifest {
  const sanitized: PackageManifest = Object.fromEntries(
    RUNTIME_MANIFEST_FIELDS.flatMap((field) =>
      manifest[field] === undefined ? [] : [[field, manifest[field]]],
    ),
  );
  for (const field of DEPENDENCY_FIELDS) {
    for (const [name, range] of Object.entries(dependencyMap(sanitized[field], field))) {
      if (LOCAL_DEPENDENCY_PROTOCOL.test(range)) {
        throw new Error(
          `non-runtime dependency protocol in ${manifest.name ?? "package"} ${field}.${name}`,
        );
      }
    }
  }
  return sanitized;
}

/** @param {string} root */
function sanitizeManifestTree(root: string): void {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) sanitizeManifestTree(target);
    if (entry.isFile() && entry.name === "package.json") {
      writeFileSync(target, `${JSON.stringify(runtimeManifest(readManifest(target)), null, 2)}\n`);
    }
  }
}

/** @param {string} issuerRoot @param {string} packageName */
function resolvePackageRoot(issuerRoot: string, packageName: string): string {
  const require = createRequire(path.join(issuerRoot, "package.json"));
  try {
    return path.dirname(require.resolve(`${packageName}/package.json`));
  } catch {
    const resolved = require.resolve(packageName);
    let candidate = path.dirname(resolved);
    for (;;) {
      const manifestPath = path.join(candidate, "package.json");
      if (existsSync(manifestPath) && readManifest(manifestPath).name === packageName)
        return candidate;
      const parent = path.dirname(candidate);
      if (parent === candidate)
        throw new Error(`could not resolve package root for ${packageName}`);
      candidate = parent;
    }
  }
}

/** @param {string} sourceRoot @param {string} targetRoot */
function copyPackageFiles(sourceRoot: string, targetRoot: string): void {
  cpSync(sourceRoot, targetRoot, {
    recursive: true,
    filter: (source) => {
      const relative = path.relative(sourceRoot, source);
      if (relative === "") return true;
      const segments = relative.split(path.sep);
      const normalizedSegments = segments.map((segment) => segment.toLowerCase());
      if (
        normalizedSegments.includes("node_modules") ||
        normalizedSegments.includes(".git") ||
        normalizedSegments.some((segment) => DEVELOPMENT_DIRECTORIES.has(segment))
      ) {
        return false;
      }

      const name = segments.at(-1);
      if (lstatSync(source).isDirectory()) return true;
      if (name === undefined) return false;
      if (name === "package.json" || LICENSE_FILE.test(name)) return true;
      if (name.startsWith(".")) return false;
      if (WORKSPACE_CONFIG.test(name) || TOOL_CONFIG.test(name) || DOCUMENTATION_FILE.test(name)) {
        return false;
      }
      return RUNTIME_EXTENSIONS.has(path.extname(name).toLowerCase());
    },
  });
}

/**
 * @param {string} sourceRoot
 * @param {string} targetRoot
 * @param {Set<string>} ancestors
 */
function copyDependencyTree(sourceRoot: string, targetRoot: string, ancestors: Set<string>): void {
  const manifest = readManifest(path.join(sourceRoot, "package.json"));
  const identity = `${manifest.name}@${manifest.version}`;
  if (ancestors.has(identity)) return;
  const descendants = new Set(ancestors).add(identity);
  copyPackageFiles(sourceRoot, targetRoot);

  const dependencies = {
    ...dependencyMap(manifest.dependencies, "dependencies"),
    ...dependencyMap(manifest.optionalDependencies, "optionalDependencies"),
  };
  for (const packageName of Object.keys(dependencies).sort()) {
    let dependencyRoot: string;
    try {
      dependencyRoot = resolvePackageRoot(sourceRoot, packageName);
    } catch (error) {
      if (
        Object.hasOwn(
          dependencyMap(manifest.optionalDependencies, "optionalDependencies"),
          packageName,
        )
      )
        continue;
      throw error;
    }
    copyDependencyTree(
      dependencyRoot,
      path.join(targetRoot, "node_modules", ...packageName.split("/")),
      descendants,
    );
  }
}

/** @param {string[]} args */
function parsePackDestination(args: string[]): string {
  const values = args[0] === "--" ? args.slice(1) : args;
  if (values.length !== 2 || values[0] !== "--pack-destination" || !values[1]) {
    throw new Error("usage: pack-local.ts --pack-destination <directory>");
  }
  return path.resolve(values[1]);
}

const packDestination = parsePackDestination(process.argv.slice(2));
function requiredPnpmEntrypoint(): string {
  const entrypoint = process.env.npm_execpath;
  if (!entrypoint) throw new Error("pack:local must run through the locked pnpm toolchain");
  return entrypoint;
}
const pnpmEntrypoint = requiredPnpmEntrypoint();

function runWorkspaceBuild(directory: string): void {
  const result = spawnSync(process.execPath, [pnpmEntrypoint, "--dir", directory, "build"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    shell: false,
    stdio: "inherit",
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`package build failed with exit code ${result.status ?? "unknown"}`);
  }
}

function copyBuildInputs(sourceRoot: string, targetRoot: string): void {
  mkdirSync(path.join(targetRoot, "scripts"), { recursive: true });
  for (const entry of ["package.json", "tsconfig.build.json", "scripts/build.ts", "src"]) {
    cpSync(path.join(sourceRoot, entry), path.join(targetRoot, entry), { recursive: true });
  }
}

const temporaryRoot = mkdtempSync(path.join(tmpdir(), "remote-skills-cli-pack-stage-"));
const stageRoot = path.join(temporaryRoot, "package");
try {
  // Build against a private core package so packing never replaces output used by
  // other tests or callers. Only declared build inputs and installed dependencies
  // are needed; neither package reads the workspace's existing dist tree.
  const buildRoot = path.join(temporaryRoot, "build");
  const buildCore = path.join(buildRoot, "packages", "core");
  const buildCli = path.join(buildRoot, "packages", "cli");
  copyBuildInputs(coreRoot, buildCore);
  copyBuildInputs(packageRoot, buildCli);
  for (const entry of ["package.json", "tsconfig.base.json"]) {
    cpSync(path.join(repositoryRoot, entry), path.join(buildRoot, entry));
  }
  symlinkSync(
    path.join(repositoryRoot, "node_modules"),
    path.join(buildRoot, "node_modules"),
    "junction",
  );
  symlinkSync(
    path.join(coreRoot, "node_modules"),
    path.join(buildCore, "node_modules"),
    "junction",
  );
  const cliScope = path.join(buildCli, "node_modules", "@remote-skills");
  mkdirSync(cliScope, { recursive: true });
  symlinkSync(buildCore, path.join(cliScope, "core"), "junction");
  runWorkspaceBuild(buildCore);
  runWorkspaceBuild(buildCli);

  mkdirSync(path.join(stageRoot, "dist"), { recursive: true });
  cpSync(path.join(buildCli, "dist"), path.join(stageRoot, "dist"), { recursive: true });
  for (const file of ["LICENSE", "README.md"]) {
    cpSync(path.join(repositoryRoot, file), path.join(stageRoot, file));
  }

  const cliManifest = readManifest(path.join(packageRoot, "package.json"));
  const coreManifest = readManifest(path.join(coreRoot, "package.json"));
  if (typeof coreManifest.version !== "string") throw new Error("core package version is missing");
  cliManifest.dependencies = {
    ...dependencyMap(cliManifest.dependencies, "dependencies"),
    "@remote-skills/core": coreManifest.version,
  };
  writeFileSync(
    path.join(stageRoot, "package.json"),
    `${JSON.stringify(runtimeManifest(cliManifest), null, 2)}\n`,
  );

  const stagedCore = path.join(stageRoot, "node_modules", "@remote-skills", "core");
  mkdirSync(stagedCore, { recursive: true });
  cpSync(path.join(buildCore, "dist"), path.join(stagedCore, "dist"), { recursive: true });
  cpSync(path.join(repositoryRoot, "LICENSE"), path.join(stagedCore, "LICENSE"));
  writeFileSync(
    path.join(stagedCore, "package.json"),
    `${JSON.stringify(runtimeManifest(coreManifest), null, 2)}\n`,
  );
  const coreDependencies = Object.keys(
    dependencyMap(coreManifest.dependencies, "dependencies"),
  ).sort();
  for (const packageName of coreDependencies) {
    copyDependencyTree(
      resolvePackageRoot(coreRoot, packageName),
      path.join(stagedCore, "node_modules", ...packageName.split("/")),
      new Set(),
    );
  }
  sanitizeManifestTree(stageRoot);

  mkdirSync(packDestination, { recursive: true });
  const result = spawnSync(
    process.execPath,
    [
      pnpmEntrypoint,
      "--config.node-linker=hoisted",
      "pack",
      "--json",
      "--pack-destination",
      packDestination,
    ],
    { cwd: stageRoot, encoding: "utf8", env: process.env },
  );
  if (result.error) throw result.error;
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}

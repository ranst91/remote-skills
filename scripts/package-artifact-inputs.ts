import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const LOCAL_DEPENDENCY_PROTOCOL = /^(?:catalog|file|link|workspace):/u;
const PACKAGE_EXCLUSIONS = new Set([
  "packages/sdk-python/src/remote_skills/cache/protocol.py",
  "packages/sdk-python/src/remote_skills/protocol_adapter.py",
  "packages/sdk-typescript/src/protocol-adapter.ts",
  "packages/sdk-typescript/src/cache/protocol-worker.mjs",
  "packages/sdk-typescript/src/cache/protocol-worker.ts",
]);

interface NpmManifest {
  name: string;
  version: string;
  license: string;
  dependencies: Record<string, string>;
  bundledDependencies: string[];
}

interface PackageMaterial {
  bytes: number;
  path: string;
  sha256: string;
}

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

function requireStringProperty(value: object, property: string, context: string): string {
  const propertyValue: unknown = Reflect.get(value, property);
  if (typeof propertyValue !== "string") {
    throw new Error(`${context} must declare string ${property}`);
  }
  return propertyValue;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function readNpmManifest(relativePath: string): NpmManifest {
  const parsed: unknown = JSON.parse(readFileSync(path.join(repositoryRoot, relativePath), "utf8"));
  if (!isObject(parsed)) throw new Error(`${relativePath} must contain a JSON object`);
  const dependenciesValue: unknown = Reflect.get(parsed, "dependencies");
  if (dependenciesValue !== undefined && !isObject(dependenciesValue)) {
    throw new Error(`${relativePath} dependencies must be an object`);
  }
  const dependencies: Record<string, string> = {};
  for (const [name, version] of Object.entries(dependenciesValue ?? {})) {
    if (typeof version !== "string") {
      throw new Error(`${relativePath} dependency ${name} must have a string version`);
    }
    dependencies[name] = version;
  }
  const bundledValue: unknown = Reflect.get(parsed, "bundledDependencies");
  if (
    bundledValue !== undefined &&
    (!Array.isArray(bundledValue) || !bundledValue.every((value) => typeof value === "string"))
  ) {
    throw new Error(`${relativePath} bundledDependencies must be a string array`);
  }
  return {
    name: requireStringProperty(parsed, "name", relativePath),
    version: requireStringProperty(parsed, "version", relativePath),
    license: requireStringProperty(parsed, "license", relativePath),
    dependencies,
    bundledDependencies: bundledValue ?? [],
  };
}

function pythonProjectMetadata(): {
  dependencies: string[];
  license: string;
  name: string;
  readme: string;
  requiresPython: string;
  version: string;
} {
  const source = readFileSync(
    path.join(repositoryRoot, "packages/sdk-python/pyproject.toml"),
    "utf8",
  );
  const projectStart = source.indexOf("[project]\n");
  if (projectStart < 0) throw new Error("packages/sdk-python/pyproject.toml is missing [project]");
  const bodyStart = projectStart + "[project]\n".length;
  const nextSection = source.indexOf("\n[", bodyStart);
  const project = source.slice(bodyStart, nextSection < 0 ? source.length : nextSection);

  const stringField = (name: string): string => {
    const matches = [...project.matchAll(new RegExp(`^${name} = "([^"]+)"$`, "gmu"))];
    if (matches.length !== 1) throw new Error(`Python project must declare one ${name}`);
    const match = matches[0]?.[1];
    if (match === undefined) throw new Error(`Python project ${name} capture is missing`);
    return match;
  };
  const dependencyMatch = project.match(/^dependencies = (?<value>\[[^\n]*\])$/mu);
  if (!dependencyMatch?.groups?.value) {
    throw new Error("Python project dependencies must use one deterministic inline array");
  }

  const dependencies: unknown = JSON.parse(dependencyMatch.groups.value);
  if (!Array.isArray(dependencies) || !dependencies.every((value) => typeof value === "string")) {
    throw new Error("Python project dependencies must be strings");
  }
  return {
    dependencies,
    license: stringField("license"),
    name: stringField("name"),
    readme: stringField("readme"),
    requiresPython: stringField("requires-python"),
    version: stringField("version"),
  };
}

function npmDependencies(
  manifest: NpmManifest,
  bundledDependencies: ReadonlySet<string> = new Set(),
  localVersions: ReadonlyMap<string, string> = new Map(),
): { bundled: boolean; name: string; version: string }[] {
  return Object.entries(manifest.dependencies)
    .map(([name, declaredVersion]) => {
      if (typeof declaredVersion !== "string") {
        throw new Error(`${manifest.name} dependency ${name} has a non-string version`);
      }
      if (LOCAL_DEPENDENCY_PROTOCOL.test(declaredVersion) && !bundledDependencies.has(name)) {
        throw new Error(`${manifest.name} has an unbundled local dependency ${name}`);
      }
      const version = LOCAL_DEPENDENCY_PROTOCOL.test(declaredVersion)
        ? localVersions.get(name)
        : declaredVersion;
      if (!version) throw new Error(`${manifest.name} dependency ${name} has no artifact version`);
      return { bundled: bundledDependencies.has(name), name, version };
    })
    .sort((left, right) => compareText(left.name, right.name));
}

function addFile(materials: Map<string, PackageMaterial>, relativePath: string): void {
  const normalized = relativePath.split(path.sep).join("/");
  if (PACKAGE_EXCLUSIONS.has(normalized)) return;
  const absolutePath = path.join(repositoryRoot, normalized);
  const metadata = lstatSync(absolutePath);
  if (metadata.isSymbolicLink())
    throw new Error(`package material must not be a symlink: ${normalized}`);
  if (!metadata.isFile()) throw new Error(`package material must be a regular file: ${normalized}`);
  const bytes = readFileSync(absolutePath);
  materials.set(normalized, {
    bytes: bytes.byteLength,
    path: normalized,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}

function addTree(materials: Map<string, PackageMaterial>, relativeRoot: string): void {
  const absoluteRoot = path.join(repositoryRoot, relativeRoot);
  for (const entry of readdirSync(absoluteRoot, { withFileTypes: true })) {
    if (entry.name === "__pycache__" || entry.name.endsWith(".pyc")) continue;
    const relativePath = path.join(relativeRoot, entry.name);
    if (entry.isDirectory()) addTree(materials, relativePath);
    else addFile(materials, relativePath);
  }
}

const cli = readNpmManifest("packages/cli/package.json");
const core = readNpmManifest("packages/core/package.json");
const client = readNpmManifest("packages/sdk-typescript/package.json");
const python = pythonProjectMetadata();
for (const [name, license] of [
  [cli.name, cli.license],
  [client.name, client.license],
  [python.name, python.license],
]) {
  if (license !== "Apache-2.0") throw new Error(`${name} must declare Apache-2.0`);
}

const materials = new Map<string, PackageMaterial>();
for (const file of [
  "LICENSE",
  "README.md",
  "package.json",
  "packages/cli/package.json",
  "packages/cli/scripts/build.ts",
  "packages/cli/scripts/pack-local.ts",
  "packages/cli/tsconfig.build.json",
  "packages/core/package.json",
  "packages/core/scripts/build.ts",
  "packages/core/tsconfig.build.json",
  "packages/sdk-python/LICENSE",
  "packages/sdk-python/README.md",
  "packages/sdk-python/package.json",
  "packages/sdk-python/pyproject.toml",
  "packages/sdk-typescript/package.json",
  "packages/sdk-typescript/scripts/pack-local.ts",
  "packages/sdk-typescript/tsconfig.build.json",
  "packages/sdk-typescript/tsconfig.json",
  "pnpm-lock.yaml",
  "pyproject.toml",
  "tsconfig.base.json",
  "uv.lock",
]) {
  addFile(materials, file);
}
for (const directory of [
  "packages/cli/src",
  "packages/core/src",
  "packages/sdk-python/src",
  "packages/sdk-typescript/src",
]) {
  addTree(materials, directory);
}

const inventory = {
  kind: "remote-skills-package-inputs",
  materials: [...materials.values()].sort((left, right) => compareText(left.path, right.path)),
  packages: [
    {
      dependencies: npmDependencies(
        cli,
        new Set(cli.bundledDependencies),
        new Map([[core.name, core.version]]),
      ),
      ecosystem: "npm",
      license: "LICENSE",
      manifest: "packages/cli/package.json",
      name: cli.name,
      readme: "README.md",
      version: cli.version,
    },
    {
      dependencies: npmDependencies(client, new Set(["yaml"])),
      ecosystem: "npm",
      license: "LICENSE",
      manifest: "packages/sdk-typescript/package.json",
      name: client.name,
      readme: "README.md",
      version: client.version,
    },
    {
      dependencies: python.dependencies.map((requirement) => ({ requirement })),
      ecosystem: "pypi",
      license: "packages/sdk-python/LICENSE",
      manifest: "packages/sdk-python/pyproject.toml",
      name: python.name,
      readme: `packages/sdk-python/${python.readme}`,
      requiresPython: python.requiresPython,
      version: python.version,
    },
  ],
  schemaVersion: 1,
};

process.stdout.write(`${JSON.stringify(inventory, null, 2)}\n`);

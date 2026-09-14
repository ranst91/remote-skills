// @ts-check

import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const runtimeManifestFields = [
  "name",
  "version",
  "description",
  "repository",
  "type",
  "types",
  "main",
  "exports",
  "engines",
  "license",
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
  "peerDependenciesMeta",
  "bundledDependencies",
];
const localDependencyProtocol = /^(?:catalog|file|link|workspace):/u;

function readManifest(file: string): object {
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`package manifest is not an object: ${file}`);
  }
  return parsed;
}

function runtimeManifest(manifest: object): object {
  const sanitized = {};
  for (const field of runtimeManifestFields) {
    const value: unknown = Reflect.get(manifest, field);
    if (value !== undefined) Reflect.set(sanitized, field, value);
  }
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    const section: unknown = Reflect.get(sanitized, field);
    if (section === undefined) continue;
    if (typeof section !== "object" || section === null || Array.isArray(section)) {
      throw new Error(`invalid dependency section: ${field}`);
    }
    for (const [name, range] of Object.entries(section)) {
      if (typeof range !== "string" || localDependencyProtocol.test(range)) {
        throw new Error(`non-runtime dependency protocol in ${field}.${name}`);
      }
    }
  }
  return sanitized;
}

function parsePackDestination(arguments_: readonly string[]): string {
  const values = arguments_[0] === "--" ? arguments_.slice(1) : arguments_;
  if (values.length !== 2 || values[0] !== "--pack-destination" || !values[1]) {
    throw new Error("usage: pack-local.ts --pack-destination <directory>");
  }
  return path.resolve(values[1]);
}

function buildWithLockedPnpm(pnpmEntrypoint: string, outputDirectory: string): void {
  const result = spawnSync(
    process.execPath,
    [pnpmEntrypoint, "run", "build", "--outDir", outputDirectory],
    {
      cwd: packageRoot,
      encoding: "utf8",
      env: process.env,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    throw new Error("Mastra integration build failed");
  }
}

const packDestination = parsePackDestination(process.argv.slice(2));
const pnpmEntrypoint = process.env.npm_execpath;
if (!pnpmEntrypoint) throw new Error("pack:local must run through the locked pnpm toolchain");

const stageRoot = mkdtempSync(path.join(tmpdir(), "remote-skills-mastra-pack-stage-"));
try {
  buildWithLockedPnpm(pnpmEntrypoint, path.join(stageRoot, "dist"));
  cpSync(path.join(repositoryRoot, "LICENSE"), path.join(stageRoot, "LICENSE"));
  for (const file of ["README.md", "DESIGN.md", "VERIFICATION.md"]) {
    cpSync(path.join(packageRoot, file), path.join(stageRoot, file));
  }

  const manifest = readManifest(path.join(packageRoot, "package.json"));
  writeFileSync(
    path.join(stageRoot, "package.json"),
    `${JSON.stringify(runtimeManifest(manifest), null, 2)}\n`,
  );

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
  rmSync(stageRoot, { recursive: true, force: true });
}

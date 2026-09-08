import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

type JsonObject = { [key: string]: unknown };
type PackedPackage = {
  filename: string;
  files: Array<{ path: string }>;
};

function readJsonObject(file: string | URL): JsonObject {
  const value: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected a JSON object in ${String(file)}`);
  }
  return Object.fromEntries(Object.entries(value));
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`expected string field ${field}`);
  return value;
}

function stringMap(value: unknown, field: string): Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected object field ${field}`);
  }
  const result: Record<string, string> = {};
  for (const [key, member] of Object.entries(value)) {
    result[key] = requiredString(member, `${field}.${key}`);
  }
  return result;
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`expected array field ${field}`);
  return value.map((member, index) => requiredString(member, `${field}[${index}]`));
}

function parsePackedPackage(source: string): PackedPackage {
  const raw: unknown = JSON.parse(source);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("pack output must be an object");
  }
  const object = Object.fromEntries(Object.entries(raw));
  if (!Array.isArray(object.files)) throw new Error("pack output files must be an array");
  const files = object.files.map((member, index) => {
    if (member === null || typeof member !== "object" || Array.isArray(member)) {
      throw new Error(`pack output files[${index}] must be an object`);
    }
    const file = Object.fromEntries(Object.entries(member));
    const path = requiredString(file.path, `files[${index}].path`);
    return { path };
  });
  return { filename: requiredString(object.filename, "filename"), files };
}

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const manifestObject = readJsonObject(new URL("../package.json", import.meta.url));
const manifest = {
  name: requiredString(manifestObject.name, "name"),
  version: requiredString(manifestObject.version, "version"),
  private: manifestObject.private,
  bin: stringMap(manifestObject.bin, "bin"),
  files: stringArray(manifestObject.files, "files"),
  bundledDependencies: stringArray(manifestObject.bundledDependencies, "bundledDependencies"),
  scripts: stringMap(manifestObject.scripts, "scripts"),
};
const rootManifest = readJsonObject(new URL("../../../package.json", import.meta.url));
const offlineEnvironment = {
  ...process.env,
  COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
  npm_config_offline: "true",
  npm_config_registry: "http://127.0.0.1:9",
};
let temporaryRoot: string | undefined;
let packed: PackedPackage | undefined;
let firstPackHash: string | undefined;
let secondPackHash: string | undefined;
let sharedOutputBefore: ReturnType<typeof sharedOutputSnapshot>;
let sharedOutputAfter: ReturnType<typeof sharedOutputSnapshot>;

const DEVELOPMENT_DIRECTORY = /^(?:__)?(?:tests?|specs?|fixtures?)(?:__)?$/u;
const WORKSPACE_CONFIG =
  /^(?:biome\.jsonc?|pnpm-workspace\.yaml|tsconfig(?:\..*)?\.json|turbo\.json)$/u;
const LOCAL_DEPENDENCY_PROTOCOL = /^(?:catalog|file|link|workspace):/u;
const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

function run(command: string, args: string[], cwd: string) {
  return spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: offlineEnvironment,
    shell: false,
  });
}

function requiredPnpmEntrypoint(): string {
  const entrypoint = process.env.npm_execpath;
  if (!entrypoint) throw new Error("package test must run through locked pnpm");
  return entrypoint;
}

function describeSpawnFailure(
  launch: { command: string; args: string[] },
  result: ReturnType<typeof spawnSync>,
): string {
  return [
    `command: ${[launch.command, ...launch.args].map((value) => JSON.stringify(value)).join(" ")}`,
    `error: ${result.error?.message ?? "<none>"}`,
    `status: ${String(result.status)}`,
    `stdout: ${String(result.stdout ?? "").trimEnd() || "<empty>"}`,
    `stderr: ${String(result.stderr ?? "").trimEnd() || "<empty>"}`,
  ].join("\n");
}

function runPnpm(args: string[], cwd: string) {
  const launch = { command: process.execPath, args: [requiredPnpmEntrypoint(), ...args] };
  const result = run(launch.command, launch.args, cwd);
  assert.equal(result.status, 0, describeSpawnFailure(launch, result));
  return result;
}

function runNode(entrypoint: string, args: string[], cwd: string) {
  const launch = { command: process.execPath, args: [entrypoint, ...args] };
  const result = run(launch.command, launch.args, cwd);
  assert.equal(result.error, undefined, describeSpawnFailure(launch, result));
  return { launch, result };
}

function listPackageFiles(root: string, relative = ""): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const entryPath = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...listPackageFiles(root, entryPath));
    if (entry.isFile()) files.push(entryPath);
  }
  return files;
}

function assertRuntimePackageTree(root: string): void {
  const files = listPackageFiles(root);
  const violations: string[] = [];
  for (const file of files) {
    const segments = file.split(path.sep);
    if (segments.slice(0, -1).some((segment) => DEVELOPMENT_DIRECTORY.test(segment))) {
      violations.push(`development directory: ${file}`);
    }
    if (WORKSPACE_CONFIG.test(segments.at(-1) ?? "")) violations.push(`workspace config: ${file}`);
  }

  for (const file of files.filter((entry) => path.basename(entry) === "package.json")) {
    const bundledManifest = readJsonObject(path.join(root, file));
    if (bundledManifest.scripts !== undefined) violations.push(`scripts in ${file}`);
    if (bundledManifest.devDependencies !== undefined) {
      violations.push(`devDependencies in ${file}`);
    }
    for (const field of DEPENDENCY_FIELDS) {
      const dependencies =
        bundledManifest[field] === undefined ? {} : stringMap(bundledManifest[field], field);
      for (const [name, range] of Object.entries(dependencies)) {
        if (LOCAL_DEPENDENCY_PROTOCOL.test(range)) {
          violations.push(`local dependency protocol in ${file} ${field}.${name}`);
        }
      }
    }
  }
  assert.deepEqual(violations, []);
}

function packageFixture(): { temporaryRoot: string; packed: PackedPackage } {
  if (temporaryRoot === undefined || packed === undefined)
    throw new Error("package fixture missing");
  return { temporaryRoot, packed };
}

function packInto(destination: string): PackedPackage {
  mkdirSync(destination, { recursive: true });
  const result = runPnpm(
    ["--silent", "run", "pack:local", "--", "--pack-destination", destination],
    packageRoot,
  );
  return parsePackedPackage(result.stdout);
}

function fileHash(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function sharedOutputSnapshot() {
  return ["core", "cli"].map((name) => {
    const root = path.join(repositoryRoot, "packages", name, "dist");
    return {
      name,
      exists: existsSync(root),
      files: existsSync(root)
        ? listPackageFiles(root)
            .sort()
            .map((file) => {
              const absolutePath = path.join(root, file);
              const metadata = statSync(absolutePath, { bigint: true });
              return {
                file,
                hash: fileHash(absolutePath),
                inode: metadata.ino,
                modified: metadata.mtimeNs,
                changed: metadata.ctimeNs,
              };
            })
        : [],
    };
  });
}

function packedTarEntry(
  file: string,
  memberName: string,
): { mode: number; bytes: Buffer } | undefined {
  const archive = gunzipSync(readFileSync(file));
  for (let offset = 0; offset + 512 <= archive.length; ) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) return undefined;
    const nul = header.indexOf(0);
    const name = header.subarray(0, nul < 0 ? 100 : nul).toString("utf8");
    const sizeText = header
      .subarray(124, 136)
      .toString("ascii")
      .replace(/[\0 ]+$/u, "");
    const modeText = header
      .subarray(100, 108)
      .toString("ascii")
      .replace(/[\0 ]+$/u, "");
    const size = Number.parseInt(sizeText, 8);
    if (!Number.isSafeInteger(size)) throw new Error(`invalid tar size for ${name}`);
    if (name === memberName) {
      const mode = Number.parseInt(modeText, 8);
      if (!Number.isSafeInteger(mode)) throw new Error(`invalid tar mode for ${name}`);
      return { mode, bytes: archive.subarray(offset + 512, offset + 512 + size) };
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return undefined;
}

before(() => {
  temporaryRoot = mkdtempSync(path.join(tmpdir(), "remote-skills-cli-package-"));
  const version = runPnpm(["--version"], repositoryRoot);
  assert.equal(`pnpm@${version.stdout.trim()}`, rootManifest.packageManager);

  sharedOutputBefore = sharedOutputSnapshot();
  packed = packInto(path.join(temporaryRoot, "first-pack"));
  const secondPack = packInto(path.join(temporaryRoot, "second-pack"));
  sharedOutputAfter = sharedOutputSnapshot();
  firstPackHash = fileHash(packed.filename);
  secondPackHash = fileHash(secondPack.filename);
});

after(() => {
  if (temporaryRoot) rmSync(temporaryRoot, { recursive: true, force: true });
});

test("the public package manifest exposes only the remote-skills binary", () => {
  assert.equal(manifest.name, "@remote-skills/cli");
  assert.equal(manifest.version, "0.0.1");
  assert.equal(manifest.private, undefined);
  assert.deepEqual(manifest.bin, { "remote-skills": "dist/cli.js" });
  assert.deepEqual(manifest.files, ["dist"]);
  assert.deepEqual(manifest.bundledDependencies, ["@remote-skills/core"]);
  assert.equal(manifest.scripts.build, "node scripts/build.ts");
  assert.equal(manifest.scripts.prepack, "pnpm build");
  assert.equal(manifest.scripts["pack:local"], "node scripts/pack-local.ts");
});

test("the declared binary target is an executable Node entrypoint", () => {
  const binaryUrl = new URL(`../${manifest.bin["remote-skills"]}`, import.meta.url);
  const trackedPath = path
    .relative(repositoryRoot, fileURLToPath(binaryUrl))
    .split(path.sep)
    .join("/");
  const tracked = run("git", ["ls-files", "--stage", "--", trackedPath], repositoryRoot);

  const binary = packedTarEntry(
    packageFixture().packed.filename,
    `package/${trackedPath.replace(/^packages\/cli\//u, "")}`,
  );
  assert.ok(binary, "the declared entrypoint must exist in the packed package");
  assert.match(binary.bytes.toString("utf8"), /^#!\/usr\/bin\/env node\n/u);
  assert.equal(binary.mode, 0o755);
  assert.equal(tracked.status, 0, tracked.stderr);
  assert.equal(tracked.stdout, "", "the generated executable must not be tracked as source");
});

test("local packing leaves shared core and CLI build output untouched", () => {
  assert.deepEqual(sharedOutputAfter, sharedOutputBefore);
});

test("two isolated local packs are byte-for-byte deterministic", () => {
  assert.equal(firstPackHash, secondPackHash);
});

test("the tarball contains only runtime package content", () => {
  const { packed } = packageFixture();
  const paths = packed.files.map((file) => file.path);

  for (const required of [
    "LICENSE",
    "README.md",
    "package.json",
    "dist/cli.js",
    "dist/cli.d.ts",
    "dist/validate.js",
    "dist/validate.d.ts",
    "dist/build.js",
    "dist/build.d.ts",
    "dist/dev.js",
    "dist/dev.d.ts",
    "dist/verify.js",
    "dist/verify.d.ts",
    "node_modules/@remote-skills/core/package.json",
    "node_modules/@remote-skills/core/dist/authoring/index.js",
    "node_modules/@remote-skills/core/dist/authoring/index.d.ts",
    "node_modules/@remote-skills/core/dist/authoring/unicode-case-fold-v15.mjs",
    "node_modules/@remote-skills/core/dist/authoring/unicode-case-fold-v15.d.mts",
    "node_modules/@remote-skills/core/dist/build/index.js",
    "node_modules/@remote-skills/core/dist/build/index.d.ts",
  ]) {
    assert.equal(paths.includes(required), true, `missing packed runtime file: ${required}`);
  }
  for (const unwanted of [".gitkeep", "tsconfig.json"]) {
    assert.equal(paths.includes(unwanted), false, `packed workspace-only file: ${unwanted}`);
  }
  assert.equal(
    paths.some((entry) => entry.startsWith("src/")),
    false,
    "packed raw CLI source",
  );
  assert.equal(
    paths.some((entry) => entry.startsWith("node_modules/@remote-skills/core/src/")),
    false,
    "packed raw core source",
  );
  assert.equal(
    paths.some(
      (entry) =>
        (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) ||
        (entry.endsWith(".mjs") &&
          (entry.startsWith("dist/") ||
            entry.startsWith("node_modules/@remote-skills/core/dist/")) &&
          entry !== "node_modules/@remote-skills/core/dist/build/vendor/pako-deflate.mjs" &&
          entry !== "node_modules/@remote-skills/core/dist/authoring/unicode-case-fold-v15.mjs"),
    ),
    false,
    "packed authored TypeScript or JavaScript-module source",
  );
  assert.equal(
    paths.some((entry) =>
      entry
        .split("/")
        .slice(0, -1)
        .some((segment) => DEVELOPMENT_DIRECTORY.test(segment)),
    ),
    false,
    "packed dependency test, spec, or fixture sources",
  );
  assert.equal(
    paths.some((entry) => WORKSPACE_CONFIG.test(entry.split("/").at(-1) ?? "")),
    false,
    "packed workspace configuration",
  );
  assert.equal(
    paths.some((entry) => entry.split("/").some((segment) => segment.startsWith("."))),
    false,
    "packed dependency development metadata",
  );
  assert.equal(
    packedTarEntry(packed.filename, "package/dist/cli.js")?.mode,
    0o755,
    "packed CLI entrypoint mode",
  );
});

test("the local tarball installs offline and runs through direct and no-install binaries", () => {
  const { temporaryRoot, packed } = packageFixture();
  const cleanProject = path.join(temporaryRoot, "clean project with spaces");
  mkdirSync(path.join(cleanProject, "skills", "fixture-skill"), { recursive: true });
  writeFileSync(
    path.join(cleanProject, "package.json"),
    '{"name":"remote-skills-cli-smoke","private":true}\n',
  );
  writeFileSync(
    path.join(cleanProject, "skills", "fixture-skill", "SKILL.md"),
    "---\nname: fixture-skill\ndescription: Exercises the installed publisher CLI.\n---\n\n# Fixture\n",
  );

  runPnpm(
    [
      "add",
      "--offline",
      "--ignore-scripts",
      "--store-dir",
      path.join(temporaryRoot, "pnpm-store"),
      packed.filename,
    ],
    cleanProject,
  );
  const installedManifest = readJsonObject(
    path.join(cleanProject, "node_modules", "@remote-skills", "cli", "package.json"),
  );
  const installedDependencies = stringMap(installedManifest.dependencies, "dependencies");
  assert.equal(
    requiredString(
      installedDependencies["@remote-skills/core"],
      "dependencies.@remote-skills/core",
    ).startsWith("workspace:"),
    false,
  );
  assert.equal(installedManifest.scripts, undefined);
  assertRuntimePackageTree(path.join(cleanProject, "node_modules", "@remote-skills", "cli"));

  const installedBin = stringMap(installedManifest.bin, "bin");

  const binary = path.join(
    cleanProject,
    "node_modules",
    "@remote-skills",
    "cli",
    requiredString(installedBin["remote-skills"], "bin.remote-skills"),
  );
  if (process.platform !== "win32") accessSync(binary, constants.X_OK);
  const directVersionRun = runNode(binary, ["--version"], cleanProject);
  const directVersion = directVersionRun.result;
  assert.equal(
    directVersion.status,
    0,
    describeSpawnFailure(directVersionRun.launch, directVersion),
  );
  assert.equal(directVersion.stdout, "0.0.1\n");
  const directValidateRun = runNode(binary, ["validate"], cleanProject);
  assert.equal(
    directValidateRun.result.status,
    0,
    describeSpawnFailure(directValidateRun.launch, directValidateRun.result),
  );
  const directBuildRun = runNode(binary, ["build"], cleanProject);
  assert.equal(
    directBuildRun.result.status,
    0,
    describeSpawnFailure(directBuildRun.launch, directBuildRun.result),
  );
  assert.equal(
    existsSync(path.join(cleanProject, "dist", ".well-known", "agent-skills", "index.json")),
    true,
  );
  const forbiddenLaunch = { command: process.execPath, args: [binary, "deploy"] };
  const forbidden = run(forbiddenLaunch.command, forbiddenLaunch.args, cleanProject);
  assert.equal(forbidden.error, undefined, describeSpawnFailure(forbiddenLaunch, forbidden));
  assert.equal(forbidden.status, 2);

  const noInstall = runPnpm(["exec", "remote-skills", "--version"], cleanProject);
  assert.equal(noInstall.stdout, "0.0.1\n");

  writeFileSync(
    path.join(cleanProject, "skills", "fixture-skill", "SKILL.md"),
    "---\nname: fixture-skill\n---\nBenign instructions.\n",
  );
  const invalidValidate = runNode(binary, ["validate"], cleanProject).result;
  assert.equal(invalidValidate.status, 1);
  assert.equal(invalidValidate.stdout, "");
  assert.equal(
    invalidValidate.stderr,
    'remote-skills: error catalog_invalid skill_name="fixture-skill" path="skills/fixture-skill/SKILL.md" field="description"\n',
  );
});

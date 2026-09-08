import assert from "node:assert/strict";
import type { SpawnSyncReturns } from "node:child_process";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { type TestContext, test } from "node:test";

import {
  createPnpmCommand,
  describeSpawnFailure,
  spawnPnpmSync,
} from "../../../scripts/lib/pnpm-command.ts";

const packageRoot = resolve(import.meta.dirname, "..");
const repositoryRoot = resolve(packageRoot, "../..");
const testRunner = resolve(packageRoot, "scripts/run-tests.ts");
const sdkMigrationPairs = [
  ["scripts/pack-local.mjs", "scripts/pack-local.ts"],
  ["scripts/run-tests.mjs", "scripts/run-tests.ts"],
  ["src/protocol-adapter.mjs", "src/protocol-adapter.ts"],
  ["tests/activation/activation-protocol.test.mjs", "tests/activation/activation-protocol.test.ts"],
  ["tests/activation/activation.test.mjs", "tests/activation/activation.test.ts"],
  ["tests/cache/cache.test.mjs", "tests/cache/cache.test.ts"],
  [
    "tests/cache/helpers/bigint-directory-identity.mjs",
    "tests/cache/helpers/bigint-directory-identity.ts",
  ],
  ["tests/cache/helpers/live-lease-holder.mjs", "tests/cache/helpers/live-lease-holder.ts"],
  ["tests/cache/helpers/race-writer.mjs", "tests/cache/helpers/race-writer.ts"],
  [
    "tests/cache/helpers/typescript-eviction-pauser.mjs",
    "tests/cache/helpers/typescript-eviction-pauser.ts",
  ],
  ["tests/catalog-discovery.test.mjs", "tests/catalog-discovery.test.ts"],
  ["tests/catalog-protocol.test.mjs", "tests/catalog-protocol.test.ts"],
  ["tests/package-gate.test.mjs", "tests/package-gate.test.ts"],
  ["tests/session/session.test.mjs", "tests/session/session.test.ts"],
] as const;
const pythonHelperMigrationPairs = [
  ["typescript_lease_holder.mjs", "typescript_lease_holder.ts"],
  ["typescript_orphan_registration.mjs", "typescript_orphan_registration.ts"],
  ["typescript_writer_holder.mjs", "typescript_writer_holder.ts"],
] as const;
const developmentDirectory = /^(?:__)?(?:tests?|specs?|fixtures?)(?:__)?$/u;
const developmentFile = /^(?:tests?|specs?|fixtures?)(?:[.-]|$)/u;
const workspaceConfig =
  /^(?:biome\.jsonc?|pnpm-workspace\.yaml|tsconfig(?:\..*)?\.json|turbo\.json)$/u;

function runPnpm(
  arguments_: readonly string[],
  cwd = packageRoot,
  environment: NodeJS.ProcessEnv = {},
): SpawnSyncReturns<string | Buffer> {
  const result = spawnPnpmSync(arguments_, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
      PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`,
      ...environment,
    },
  });
  assert.equal(result.status, 0, describeSpawnFailure(createPnpmCommand(arguments_), result));
  return result;
}

interface PackedFile {
  path: string;
}

interface PackedPackage {
  filename: string;
  files: PackedFile[];
  name: string;
  version: string;
}

function jsonRecord(text: string, label = "JSON document"): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError(`${label} must be an object`);
  }
  return Object.fromEntries(Object.entries(parsed));
}

function recordField(record: Record<string, unknown>, field: string): Record<string, unknown> {
  const value = record[field];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return Object.fromEntries(Object.entries(value));
}

function stringField(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string") throw new TypeError(`${field} must be a string`);
  return value;
}

function stringArrayJson(text: string, label: string): string[] {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new TypeError(`${label} must be an array`);
  return parsed.map((value, index) => {
    if (typeof value !== "string") throw new TypeError(`${label}[${index}] must be a string`);
    return value;
  });
}

function packedPackageJson(text: string): PackedPackage {
  const raw = jsonRecord(text, "packed package");
  const rawFiles = raw.files;
  if (!Array.isArray(rawFiles)) throw new TypeError("packed package files must be an array");
  return {
    filename: stringField(raw, "filename"),
    files: rawFiles.map((value, index) => {
      const file = recordField({ value }, "value");
      if (typeof file.path !== "string") {
        throw new TypeError(`packed package files[${index}].path must be a string`);
      }
      return { path: file.path };
    }),
    name: stringField(raw, "name"),
    version: stringField(raw, "version"),
  };
}

async function packSdk(t: TestContext): Promise<{ packed: PackedPackage; temporaryRoot: string }> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "remote-skills-client-pack-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const result = runPnpm([
    "--silent",
    "run",
    "pack:local",
    "--",
    "--pack-destination",
    temporaryRoot,
  ]);
  assert.equal(result.status, 0, String(result.stderr || result.stdout));
  const packed = packedPackageJson(String(result.stdout));
  return { packed, temporaryRoot };
}

async function installSdk(
  t: TestContext,
): Promise<{ cleanProject: string; packed: PackedPackage }> {
  const { packed, temporaryRoot } = await packSdk(t);
  const cleanProject = join(temporaryRoot, "clean-project");
  const emptyStore = join(temporaryRoot, "empty-pnpm-store");
  await mkdir(cleanProject);
  await writeFile(
    join(cleanProject, "package.json"),
    `${JSON.stringify({
      name: "remote-skills-client-smoke",
      private: true,
      type: "module",
      packageManager: "pnpm@10.33.4",
    })}\n`,
  );
  const installation = runPnpm(
    ["add", "--offline", "--ignore-scripts", "--store-dir", emptyStore, packed.filename],
    cleanProject,
    {
      npm_config_offline: "true",
      npm_config_registry: "http://127.0.0.1:9",
    },
  );
  assert.equal(installation.status, 0, `${installation.stdout}\n${installation.stderr}`);
  return { cleanProject, packed };
}

function runTestRunner(arguments_: readonly string[]): SpawnSyncReturns<string> {
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, [testRunner, ...arguments_], {
    cwd: packageRoot,
    encoding: "utf8",
    env: environment,
  });
}

test("TypeScript SDK package gates execute its tests and strict compiler", async () => {
  const manifest = jsonRecord(await readFile(resolve(packageRoot, "package.json"), "utf8"));
  const scripts = recordField(manifest, "scripts");

  assert.equal(scripts.test, "node scripts/run-tests.ts");
  assert.match(stringField(scripts, "typecheck"), /^tsc -p tsconfig\.json --noEmit$/);
  assert.equal(scripts.check, "pnpm typecheck && pnpm test");
  assert.equal(
    Object.values(scripts).some(
      (script) => typeof script === "string" && script.includes("run-package-gate"),
    ),
    false,
  );
  assert.deepEqual(manifest.devDependencies, {
    "@types/node": "catalog:",
    typescript: "catalog:",
  });
});

test("the SDK source inventory contains only its typed successors and stable worker shim", async () => {
  for (const [baseline, successor] of sdkMigrationPairs) {
    assert.equal(
      await readFile(resolve(packageRoot, baseline)).then(
        () => true,
        () => false,
      ),
      false,
      `baseline JavaScript remains: ${baseline}`,
    );
    assert.equal(
      await readFile(resolve(packageRoot, successor)).then(
        () => true,
        () => false,
      ),
      true,
      `typed successor is missing: ${successor}`,
    );
  }

  const pythonHelpers = resolve(repositoryRoot, "packages/sdk-python/tests/helpers");
  for (const [baseline, successor] of pythonHelperMigrationPairs) {
    assert.equal(
      await readFile(resolve(pythonHelpers, baseline)).then(
        () => true,
        () => false,
      ),
      false,
      `baseline Python test helper remains: ${baseline}`,
    );
    assert.equal(
      await readFile(resolve(pythonHelpers, successor)).then(
        () => true,
        () => false,
      ),
      true,
      `typed Python test helper is missing: ${successor}`,
    );
  }
});

test("the stable cache worker path is an import-and-launch-only shim", async () => {
  const shim = await readFile(resolve(packageRoot, "src/cache/protocol-worker.mjs"), "utf8");
  assert.equal(shim, 'import "./protocol-worker.ts";\n');
});

test("workspace-only protocol support is excluded from emitted package output", async () => {
  const buildConfig = jsonRecord(
    await readFile(resolve(packageRoot, "tsconfig.build.json"), "utf8"),
  );
  assert.deepEqual(buildConfig.exclude, [
    "src/cache/protocol-worker.ts",
    "src/protocol-adapter.ts",
    "tests",
  ]);

  const build = runPnpm(["run", "build"]);
  assert.equal(build.status, 0, String(build.stderr || build.stdout));
  for (const internalPath of [
    "dist/cache/protocol-worker.js",
    "dist/cache/protocol-worker.d.ts",
    "dist/protocol-adapter.js",
    "dist/protocol-adapter.d.ts",
  ]) {
    assert.equal(
      await readFile(resolve(packageRoot, internalPath)).then(
        () => true,
        () => false,
      ),
      false,
      `workspace-only file leaked into build output: ${internalPath}`,
    );
  }
});

test("the public package manifest exposes an ESM-only Node runtime", async () => {
  const manifest = jsonRecord(await readFile(resolve(packageRoot, "package.json"), "utf8"));

  assert.equal(manifest.name, "@remote-skills/client");
  assert.equal(manifest.version, "0.0.1");
  assert.equal(manifest.private, undefined);
  assert.equal(manifest.type, "module");
  assert.equal(manifest.types, "./dist/index.d.ts");
  assert.deepEqual(manifest.files, ["dist"]);
  assert.deepEqual(manifest.exports, {
    ".": {
      types: "./dist/index.d.ts",
      browser: "./dist/browser-rejection.js",
      import: "./dist/index.js",
      require: "./dist/require-rejection.cjs",
    },
  });
  const scripts = recordField(manifest, "scripts");
  assert.equal(scripts.build, "tsc -p tsconfig.build.json");
  assert.equal(scripts["pack:local"], "node scripts/pack-local.ts");
});

test("the package build emits every declared runtime and declaration target", async () => {
  const rootManifest = jsonRecord(await readFile(resolve(repositoryRoot, "package.json"), "utf8"));
  const version = runPnpm(["--version"], repositoryRoot);
  assert.equal(version.status, 0, String(version.stderr));
  assert.equal(`pnpm@${String(version.stdout).trim()}`, rootManifest.packageManager);

  const build = runPnpm(["run", "build"]);
  assert.equal(build.status, 0, String(build.stderr || build.stdout));
  for (const target of [
    "dist/index.js",
    "dist/index.d.ts",
    "dist/browser-rejection.js",
    "dist/require-rejection.cjs",
  ]) {
    assert.equal(
      await readFile(resolve(packageRoot, target), "utf8").then(
        () => true,
        () => false,
      ),
      true,
      `missing build target: ${target}`,
    );
  }
});

test("the locked package manager creates a local SDK tarball", async (t) => {
  const { packed } = await packSdk(t);
  assert.equal(packed.name, "@remote-skills/client");
  assert.equal(packed.version, "0.0.1");
  assert.equal(await readFile(packed.filename).then((bytes) => bytes.byteLength > 0), true);
});

test("packing rebuilds in isolation without mutating shared output", async (t) => {
  const staleOutput = resolve(packageRoot, "dist/stale.test.js");
  const staleBytes = "throw new Error('stale output');\n";
  await writeFile(staleOutput, staleBytes);
  t.after(() => rm(staleOutput, { force: true }));

  const { packed } = await packSdk(t);
  assert.equal(await readFile(staleOutput, "utf8"), staleBytes);
  assert.equal(
    packed.files.some(({ path }) => path === "dist/stale.test.js"),
    false,
  );
});

test("the tarball contains runtime files without test or workspace leakage", async (t) => {
  const { packed } = await packSdk(t);
  const paths = packed.files.map(({ path }) => path);

  for (const required of [
    "LICENSE",
    "README.md",
    "package.json",
    "dist/index.js",
    "dist/index.d.ts",
    "dist/browser-rejection.js",
    "dist/require-rejection.cjs",
    "node_modules/yaml/LICENSE",
    "node_modules/yaml/package.json",
  ]) {
    assert.equal(paths.includes(required), true, `missing packed runtime file: ${required}`);
  }
  const leaked = paths.filter((entry) => {
    const segments = entry.split("/");
    const file = segments.at(-1) ?? "";
    return (
      segments.slice(0, -1).some((segment) => developmentDirectory.test(segment)) ||
      developmentFile.test(file) ||
      workspaceConfig.test(file)
    );
  });
  assert.deepEqual(leaked, []);
});

test("the local tarball installs from an empty offline store and executes a real session", async (t) => {
  const { cleanProject } = await installSdk(t);
  const installedRoot = join(cleanProject, "node_modules", "@remote-skills", "client");
  const installedManifest = jsonRecord(await readFile(join(installedRoot, "package.json"), "utf8"));
  const yamlManifest = jsonRecord(
    await readFile(join(installedRoot, "node_modules", "yaml", "package.json"), "utf8"),
  );
  assert.equal(installedManifest.scripts, undefined);
  assert.equal(installedManifest.devDependencies, undefined);
  assert.deepEqual(installedManifest.bundledDependencies, ["yaml"]);
  assert.equal(recordField(installedManifest, "dependencies").yaml, "2.9.0");
  assert.equal(yamlManifest.scripts, undefined);
  assert.equal(yamlManifest.devDependencies, undefined);
  for (const manifest of [installedManifest, yamlManifest]) {
    for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      const dependencySet = manifest[field];
      if (dependencySet === undefined) continue;
      if (
        dependencySet === null ||
        typeof dependencySet !== "object" ||
        Array.isArray(dependencySet)
      ) {
        throw new TypeError(`${field} must be an object`);
      }
      for (const range of Object.values(dependencySet)) {
        assert.equal(typeof range, "string");
        if (typeof range === "string") {
          assert.doesNotMatch(range, /^(?:catalog|file|link|workspace):/u);
        }
      }
    }
  }

  await writeFile(
    join(cleanProject, "smoke.mjs"),
    `import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRemoteSkills } from "@remote-skills/client";

const skill = new TextEncoder().encode("---\\nname: fixture-skill\\ndescription: Installed package smoke.\\n---\\n\\n# Installed\\n");
const digest = \`sha256:\${createHash("sha256").update(skill).digest("hex")}\`;
const catalog = new TextEncoder().encode(JSON.stringify({
  $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
  skills: [{ name: "fixture-skill", description: "Installed package smoke.", type: "skill-md", url: "artifacts/fixture.md", digest }],
}));
const client = createRemoteSkills(
  { origins: { fixture: { url: "https://skills.example.test", retries: 0 } }, cache: "memory" },
  {
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    transport: async ({ url }) => url.endsWith("index.json")
      ? { status: 200, headers: { "cache-control": "no-store" }, body: catalog }
      : { status: 200, headers: { "content-type": "text/markdown; charset=utf-8" }, body: skill },
    random: () => 0,
    sleep: async () => {},
    sessionNonce: () => "package-smoke-session",
  },
);
const session = await client.session("fixture");
assert.equal((await session.catalog())[0].name, "fixture-skill");
const activated = await session.activate("fixture-skill");
assert.match(activated.instructions, /Installed/);
assert.match(await activated.read("SKILL.md"), /fixture-skill/);
await session.close();
process.stdout.write(JSON.stringify({ name: activated.name, digest: activated.digest }) + "\\n");
`,
  );
  const smoke = spawnSync(process.execPath, [join(cleanProject, "smoke.mjs")], {
    cwd: cleanProject,
    encoding: "utf8",
    env: { ...process.env, NODE_PATH: "" },
  });
  assert.equal(smoke.status, 0, smoke.stderr || smoke.stdout);
  const smokeResult = jsonRecord(String(smoke.stdout), "SDK smoke result");
  assert.equal(smokeResult.name, "fixture-skill");
  assert.match(stringField(smokeResult, "digest"), /^sha256:[0-9a-f]{64}$/u);

  await writeFile(
    join(cleanProject, "declarations.ts"),
    `import { createRemoteSkills, type RemoteSkillsClient, type RemoteSkillsConfig } from "@remote-skills/client";

const config = { origins: { fixture: { url: "https://skills.example.test" } }, cache: "memory" } satisfies RemoteSkillsConfig;
const client: RemoteSkillsClient = createRemoteSkills(config);
void client;
`,
  );
  const declarations = spawnSync(
    process.execPath,
    [
      resolve(repositoryRoot, "node_modules/typescript/bin/tsc"),
      "--noEmit",
      "--strict",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--target",
      "ES2024",
      "--lib",
      "ES2024,ESNext.Disposable",
      "--typeRoots",
      resolve(repositoryRoot, "node_modules/@types"),
      "--types",
      "node",
      join(cleanProject, "declarations.ts"),
    ],
    { cwd: cleanProject, encoding: "utf8", env: { ...process.env, NODE_PATH: "" } },
  );
  assert.equal(declarations.status, 0, declarations.stderr || declarations.stdout);
});

test("CommonJS consumers receive an explicit ESM-only rejection", async (t) => {
  const { cleanProject } = await installSdk(t);
  const result = spawnSync(
    process.execPath,
    ["--input-type=commonjs", "--eval", 'require("@remote-skills/client")'],
    { cwd: cleanProject, encoding: "utf8", env: { ...process.env, NODE_PATH: "" } },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /@remote-skills\/client is ESM-only; use import\(\) from Node\.js/u);
});

test("browser-condition consumers receive an explicit server-runtime rejection", async (t) => {
  const { cleanProject } = await installSdk(t);
  const result = spawnSync(
    process.execPath,
    ["--conditions=browser", "--input-type=module", "--eval", 'import("@remote-skills/client")'],
    { cwd: cleanProject, encoding: "utf8", env: { ...process.env, NODE_PATH: "" } },
  );

  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /@remote-skills\/client is server-runtime-only and does not support browsers/u,
  );
});

test("the package test runner recursively executes nested suites", async (t) => {
  const testRoot = await mkdtemp(join(tmpdir(), "remote-skills-typescript-tests-"));
  t.after(() => rm(testRoot, { recursive: true, force: true }));
  const nested = resolve(testRoot, "cache");
  await mkdir(nested);
  await writeFile(
    resolve(testRoot, "root.test.ts"),
    `import { test } from "node:test";\ntest("root suite", () => {});\n`,
  );
  await writeFile(
    resolve(nested, "cache.test.ts"),
    `import assert from "node:assert/strict";\nimport { test } from "node:test";\ntest("nested suite selected", () => assert.fail("nested suite executed"));\n`,
  );

  const selected = runTestRunner(["--list", testRoot]);
  assert.equal(selected.status, 0, selected.stderr || selected.stdout);
  assert.deepEqual(stringArrayJson(selected.stdout, "selected test paths"), [
    resolve(nested, "cache.test.ts"),
    resolve(testRoot, "root.test.ts"),
  ]);

  const result = runTestRunner([testRoot]);
  assert.equal(result.status, 1, result.stderr || result.stdout || "nested suite was not executed");
});

test("the package test runner selects every tracked package test suite", () => {
  const tracked = spawnSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "packages/sdk-typescript/tests"],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
    },
  );
  assert.equal(tracked.status, 0, tracked.stderr);
  const expected = tracked.stdout
    .trim()
    .split("\n")
    .filter((file) => file.endsWith(".test.ts"))
    .map((file) => resolve(repositoryRoot, file))
    .sort();

  const selected = runTestRunner(["--list", resolve(packageRoot, "tests")]);
  assert.equal(selected.status, 0, selected.stderr || selected.stdout);
  assert.deepEqual(stringArrayJson(selected.stdout, "selected package test paths"), expected);
});

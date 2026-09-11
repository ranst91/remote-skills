import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const rootMigrationPairs = [
  ["scripts/check-config-schema.mjs", "scripts/check-config-schema.ts"],
  ["scripts/check-no-publication.mjs", "scripts/check-no-publication.ts"],
  ["scripts/check-package-artifacts.mjs", "scripts/check-package-artifacts.ts"],
  ["scripts/check-publication-readiness.mjs", "scripts/check-publication-readiness.ts"],
  ["scripts/generate-config-schema.mjs", "scripts/generate-config-schema.ts"],
  ["scripts/lib/pnpm-command.mjs", "scripts/lib/pnpm-command.ts"],
  ["scripts/lib/turbo-command.mjs", "scripts/lib/turbo-command.ts"],
  ["scripts/package-artifact-inputs.mjs", "scripts/package-artifact-inputs.ts"],
  ["scripts/run-ci-test-group.mjs", "scripts/run-ci-test-group.ts"],
  ["scripts/run-package-gate.mjs", "scripts/run-package-gate.ts"],
  ["scripts/run-turbo.mjs", "scripts/run-turbo.ts"],
  ["scripts/validate-config-fixture.mjs", "scripts/validate-config-fixture.ts"],
  ["scripts/verify-project-gates.mjs", "scripts/verify-project-gates.ts"],
  ["tests/repository/ci-bootstrap.test.mjs", "tests/repository/ci-bootstrap.test.ts"],
  ["tests/repository/determinism-gate.test.mjs", "tests/repository/determinism-gate.test.ts"],
  ["tests/repository/foundation.test.mjs", "tests/repository/foundation.test.ts"],
  [
    "tests/repository/network-security-gate.test.mjs",
    "tests/repository/network-security-gate.test.ts",
  ],
  ["tests/repository/no-publication-gate.test.mjs", "tests/repository/no-publication-gate.test.ts"],
  ["tests/repository/package-artifacts.test.mjs", "tests/repository/package-artifacts.test.ts"],
  ["tests/repository/process-launch.test.mjs", "tests/repository/process-launch.test.ts"],
  [
    "tests/repository/publication-readiness.test.mjs",
    "tests/repository/publication-readiness.test.ts",
  ],
  ["tests/repository/python-turbo.test.mjs", "tests/repository/python-turbo.test.ts"],
  [
    "tests/repository/scope-version-parity-gate.test.mjs",
    "tests/repository/scope-version-parity-gate.test.ts",
  ],
  [
    "tests/repository/windows-core-mutation-probes.test.mjs",
    "tests/repository/windows-core-mutation-probes.test.ts",
  ],
] as const;

function readRootScripts(): object {
  const manifest: unknown = JSON.parse(readFileSync("package.json", "utf8"));
  assert.ok(typeof manifest === "object" && manifest !== null && "scripts" in manifest);
  assert.ok(typeof manifest.scripts === "object" && manifest.scripts !== null);
  return manifest.scripts;
}

function script(scripts: object, name: string): string {
  assert.ok(name in scripts, `missing root script ${name}`);
  const value: unknown = Reflect.get(scripts, name);
  assert.ok(typeof value === "string", `root script ${name} must be a string`);
  return value;
}

function listTypeScriptFiles(root: string): string[] {
  const paths: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) paths.push(...listTypeScriptFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".ts")) paths.push(path);
  }
  return paths;
}

function inventoryBaselines(): string[] {
  const parsed: unknown = JSON.parse(
    readFileSync("tests/repository/typescript-migration-inventory.json", "utf8"),
  );
  assert.ok(typeof parsed === "object" && parsed !== null && "stableMigrationPairs" in parsed);
  assert.ok(Array.isArray(parsed.stableMigrationPairs));
  return parsed.stableMigrationPairs.map((entry: unknown) => {
    assert.ok(typeof entry === "object" && entry !== null && "baseline" in entry);
    const baseline: unknown = entry.baseline;
    assert.ok(typeof baseline === "string");
    return baseline;
  });
}

test("all root tooling and repository gates use only their exact TypeScript successors", () => {
  for (const [baseline, successor] of rootMigrationPairs) {
    assert.equal(existsSync(baseline), false, `stale root migration baseline: ${baseline}`);
    assert.equal(existsSync(successor), true, `missing root TypeScript successor: ${successor}`);
  }
});

test("root commands use native Node.js TypeScript paths", () => {
  const scripts = readRootScripts();
  assert.equal(
    script(scripts, "test:repository"),
    "pnpm ci:build:repository && pnpm test:repository:prepared",
  );
  assert.equal(
    script(scripts, "test:repository:prepared"),
    "node --test tests/repository/*.test.ts",
  );
  assert.equal(script(scripts, "test:protocol"), "node --test tests/protocol/*.test.ts");
  assert.equal(script(scripts, "package:check"), "node scripts/check-package-artifacts.ts");
  assert.equal(script(scripts, "package:inputs"), "node scripts/package-artifact-inputs.ts");
  assert.equal(
    script(scripts, "publication:readiness"),
    "node scripts/release/verify-artifacts.ts",
  );
  assert.equal(script(scripts, "schema:generate"), "node scripts/generate-config-schema.ts");
  assert.equal(script(scripts, "schema:check"), "node scripts/check-config-schema.ts");
  assert.equal(script(scripts, "ci:verify-projects"), "node scripts/verify-project-gates.ts");
  assert.equal(script(scripts, "typecheck"), "pnpm ci:build:repository && pnpm typecheck:prepared");
  assert.match(script(scripts, "typecheck:prepared"), /node scripts\/run-turbo\.ts typecheck/u);
  assert.match(script(scripts, "test"), /node scripts\/run-turbo\.ts test/u);
  assert.match(script(scripts, "check"), /node scripts\/run-turbo\.ts check/u);
  for (const group of ["core", "typescript", "python", "protocol", "examples"] as const) {
    assert.equal(script(scripts, `ci:test:${group}`), `node scripts/run-ci-test-group.ts ${group}`);
  }
});

test("Turbo hashes the shared compiler configuration for workspace tasks", () => {
  const turbo: unknown = JSON.parse(readFileSync("turbo.json", "utf8"));
  assert.ok(typeof turbo === "object" && turbo !== null && "globalDependencies" in turbo);
  assert.deepEqual(turbo.globalDependencies, ["tsconfig.base.json"]);
});

test("CI retains the exact eight public job names", () => {
  const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
  const jobs = workflow.split("\njobs:\n")[1];
  assert.ok(jobs !== undefined, "CI workflow must declare jobs");
  const jobIds = [...jobs.matchAll(/^ {2}([a-z]+):$/gmu)].map((match) => match[1]);
  assert.deepEqual(jobIds, ["check", "test", "package", "windows"]);
  const publicNames = [...jobs.matchAll(/^ {4}name: (.+)$/gmu)].map((match) => match[1]);
  assert.deepEqual(publicNames, [
    "check (repository)",
    `test (\${{ matrix.label }})`,
    "test (packaging)",
    "test (packages windows)",
  ]);
  for (const group of ["core", "typescript", "python", "protocol", "examples"] as const) {
    assert.match(workflow, new RegExp(`^ {10}- group: ${group}$`, "mu"));
  }
});

test("root consumers contain no stale non-release migration path", () => {
  const consumerPaths = [
    "package.json",
    ...rootMigrationPairs.map(([, successor]) => successor).filter((path) => existsSync(path)),
  ];
  for (const consumerPath of consumerPaths) {
    const source = readFileSync(consumerPath, "utf8");
    for (const [baseline] of rootMigrationPairs) {
      assert.equal(source.includes(baseline), false, `${consumerPath} references ${baseline}`);
    }
  }
});

test("root consumers contain no stale core, CLI, SDK, protocol, or surface path", () => {
  const staleBaselines = inventoryBaselines();
  const consumerPaths = [
    "package.json",
    ...listTypeScriptFiles("scripts"),
    ...listTypeScriptFiles("tests/repository").filter(
      (path) => !path.endsWith("root-typescript-convergence.test.ts"),
    ),
  ];
  for (const consumerPath of consumerPaths) {
    const source = readFileSync(consumerPath, "utf8");
    for (const baseline of staleBaselines) {
      assert.equal(source.includes(baseline), false, `${consumerPath} references ${baseline}`);
    }
  }
});

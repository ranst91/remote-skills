import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";

import { runCommand } from "../helpers/run-command.ts";

const rootManifest: unknown = JSON.parse(readFileSync("package.json", "utf8"));
assert.ok(typeof rootManifest === "object" && rootManifest !== null);
const rootScripts: unknown = Reflect.get(rootManifest, "scripts");
assert.ok(typeof rootScripts === "object" && rootScripts !== null);
const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
const readinessScript = readFileSync("scripts/check-publication-readiness.ts", "utf8");

function git(repository: string, args: readonly string[]) {
  return spawnSync("git", args, { cwd: repository, encoding: "utf8" });
}

function makeRepositoryFixture(testContext: TestContext): string {
  const repository = mkdtempSync(join(tmpdir(), "remote-skills-readiness-state-"));
  testContext.after(() => rmSync(repository, { recursive: true, force: true }));
  mkdirSync(join(repository, "scripts", "lib"), { recursive: true });
  mkdirSync(join(repository, "scripts", "release"), { recursive: true });
  for (const name of [
    "release-lib.ts",
    "release-scopes.ts",
    "installed-integration.ts",
    "python-artifacts.ts",
    "integration-dependencies.ts",
  ])
    copyFileSync(`scripts/release/${name}`, join(repository, "scripts/release", name));
  copyFileSync(
    "scripts/check-publication-readiness.ts",
    join(repository, "scripts/check-publication-readiness.ts"),
  );
  copyFileSync("scripts/lib/pnpm-command.ts", join(repository, "scripts/lib/pnpm-command.ts"));
  copyFileSync("scripts/lib/uv-command.ts", join(repository, "scripts/lib/uv-command.ts"));
  writeFileSync(join(repository, "tracked.txt"), "baseline\n");
  for (const args of [
    ["init", "--quiet"],
    ["config", "user.name", "Readiness Test"],
    ["config", "user.email", "readiness@example.invalid"],
    ["add", "."],
    ["commit", "--quiet", "-m", "fixture baseline"],
  ]) {
    const result = git(repository, args);
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }
  return repository;
}

function checkRepositoryState(repository: string, expectedHead?: string) {
  const args = [
    join(repository, "scripts/check-publication-readiness.ts"),
    "--check-repository-state",
  ];
  if (expectedHead) args.push(expectedHead);
  return spawnSync(process.execPath, args, { cwd: repository, encoding: "utf8" });
}

function runReadiness(repository: string, output: string) {
  return spawnSync(process.execPath, [join(repository, "scripts/check-publication-readiness.ts")], {
    cwd: repository,
    encoding: "utf8",
    env: { ...process.env, PUBLICATION_READINESS_OUTPUT: output },
  });
}

test("publication readiness remains a registry-free local artifact gate in full CI", () => {
  assert.equal(
    Reflect.get(rootScripts, "publication:readiness"),
    "node scripts/release/verify-artifacts.ts",
  );
  assert.match(workflow, /pnpm --dir \.\.\/release-tooling publication:readiness/u);
  assert.match(workflow, /\$\{\{ runner\.temp \}\}/u);
  assert.doesNotMatch(workflow, /(?:npm|pypi|twine).*publish|id-token:\s*write/iu);
  assert.match(readinessScript, /installPythonArtifact/u);
  assert.doesNotMatch(readinessScript, /--default-index/u);
  assert.match(
    readinessScript,
    /join\(project, "node_modules", "@remote-skills", "cli", "dist", "cli\.js"\)/u,
  );
  assert.doesNotMatch(readinessScript, /"src", "cli\.mjs"/u);
  assert.match(
    readinessScript,
    /createPnpmCommand\(arguments_\)/u,
    "readiness must launch pnpm through its resolved JavaScript entrypoint",
  );
  assert.doesNotMatch(readinessScript, /process\.platform === "win32" \? "pnpm\.cmd" : "pnpm"/u);
});

test("readiness command exposes a local-only evidence contract", () => {
  const result = runCommand(process.execPath, [
    "scripts/check-publication-readiness.ts",
    "--describe",
  ]);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const contract: unknown = JSON.parse(result.stdout);
  assert.ok(typeof contract === "object" && contract !== null);
  assert.equal(Reflect.get(contract, "schemaVersion"), 1);
  assert.equal(Reflect.get(contract, "kind"), "remote-skills-local-publication-readiness");
  assert.deepEqual(Reflect.get(contract, "artifacts"), [
    "@remote-skills/cli npm tarball",
    "@remote-skills/client npm tarball",
    "@remote-skills/ai-sdk npm tarball",
    "remote-skills Python wheel",
    "remote-skills Python source distribution",
  ]);
  assert.equal(Reflect.get(contract, "registryAccess"), false);
  assert.equal(Reflect.get(contract, "publication"), false);
  assert.equal(Reflect.get(contract, "pythonRequirement"), "3.11");
  assert.equal(Reflect.get(contract, "deterministicEnvironment"), true);
  assert.equal(Reflect.get(contract, "independentArchiveInspection"), true);
  assert.equal(Reflect.get(contract, "evidenceIncludesCommit"), true);
  assert.equal(Reflect.get(contract, "evidenceIncludesPlatform"), true);
});

test("readiness state check captures a clean exact HEAD", (testContext) => {
  const repository = makeRepositoryFixture(testContext);
  const expectedHead = git(repository, ["rev-parse", "HEAD"]).stdout.trim();

  const result = checkRepositoryState(repository);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout.trim(), expectedHead);
});

for (const dirtyCase of [
  { name: "untracked input", path: "untracked.txt" },
  { name: "tracked modification", path: "tracked.txt" },
]) {
  test(`readiness state check rejects ${dirtyCase.name}`, (testContext) => {
    const repository = makeRepositoryFixture(testContext);
    writeFileSync(join(repository, dirtyCase.path), "changed\n");

    const result = checkRepositoryState(repository);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /publication readiness requires a fully clean repository/u);
  });
}

test("readiness state check rejects HEAD drift", (testContext) => {
  const repository = makeRepositoryFixture(testContext);
  const originalHead = git(repository, ["rev-parse", "HEAD"]).stdout.trim();
  writeFileSync(join(repository, "tracked.txt"), "next commit\n");
  for (const args of [
    ["add", "tracked.txt"],
    ["commit", "--quiet", "-m", "move head"],
  ]) {
    const result = git(repository, args);
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }

  const result = checkRepositoryState(repository, originalHead);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /repository HEAD changed during publication readiness/u);
});

test("readiness rejects evidence paths inside the repository before artifact work", (testContext) => {
  const repository = makeRepositoryFixture(testContext);
  const output = join(repository, "..evidence.json");

  const result = runReadiness(repository, output);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /publication-readiness evidence must be written outside/u);
});

for (const linkCase of [
  { name: "symlink", create: symlinkSync },
  { name: "hardlink", create: linkSync },
]) {
  test(`readiness refuses an outside ${linkCase.name} to a repository file`, (testContext) => {
    const repository = makeRepositoryFixture(testContext);
    const outputDirectory = mkdtempSync(join(tmpdir(), "remote-skills-readiness-output-"));
    testContext.after(() => rmSync(outputDirectory, { recursive: true, force: true }));
    const target = join(repository, "tracked.txt");
    const original = readFileSync(target);
    const output = join(outputDirectory, "evidence.json");
    linkCase.create(target, output);

    const result = runReadiness(repository, output);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /publication-readiness evidence output must not already exist/u);
    assert.deepEqual(readFileSync(target), original);
  });
}

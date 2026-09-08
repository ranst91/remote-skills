import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { runCommand } from "../helpers/run-command.ts";

const expectedProjectFiles = [
  "apps/docs/package.json",
  "packages/core/package.json",
  "packages/cli/package.json",
  "packages/sdk-typescript/package.json",
  "packages/sdk-python/pyproject.toml",
  "tests/protocol/fixtures/archive/archive-cases.json",
  "tests/protocol/expected-results/archive-results.json",
];
const expectedExampleFiles = [
  "examples/publisher/remote-skills.json",
  "examples/publisher/skills/code-review/SKILL.md",
  "examples/consumers/typescript/src/index.ts",
  "examples/consumers/python/main.py",
];

function readRootManifest(): { engines: object; packageManager: string; scripts: object } {
  const manifest: unknown = JSON.parse(readFileSync("package.json", "utf8"));
  assert.ok(typeof manifest === "object" && manifest !== null);
  assert.ok("packageManager" in manifest && typeof manifest.packageManager === "string");
  assert.ok(
    "engines" in manifest && typeof manifest.engines === "object" && manifest.engines !== null,
  );
  assert.ok(
    "scripts" in manifest && typeof manifest.scripts === "object" && manifest.scripts !== null,
  );
  return {
    packageManager: manifest.packageManager,
    engines: manifest.engines,
    scripts: manifest.scripts,
  };
}

function requireString(value: object, property: string): string {
  const propertyValue: unknown = Reflect.get(value, property);
  assert.ok(typeof propertyValue === "string", `${property} must be a string`);
  return propertyValue;
}

test("the root manifest defines the approved toolchain and quality commands", () => {
  const manifest = readRootManifest();

  assert.match(manifest.packageManager, /^pnpm@/u);
  assert.equal(requireString(manifest.engines, "node"), ">=24.0.0");
  for (const script of ["format", "format:check", "lint", "typecheck", "test", "check"]) {
    requireString(manifest.scripts, script);
  }
});

test("the approved monorepo directories and populated examples are represented in the workspace", () => {
  const workspace = readFileSync("pnpm-workspace.yaml", "utf8");

  for (const projectFile of expectedProjectFiles) {
    assert.ok(readFileSync(projectFile, "utf8").length > 0, `${projectFile} must be populated`);
  }
  for (const exampleFile of expectedExampleFiles) {
    assert.ok(readFileSync(exampleFile, "utf8").length > 0, `${exampleFile} must be populated`);
  }
  for (const workspacePattern of ["apps/*", "packages/*", "examples/*", "examples/consumers/*"])
    assert.ok(workspace.includes(workspacePattern), `missing ${workspacePattern}`);
});

test("the Python workspace and Apache-2.0 license are explicit", () => {
  const pythonWorkspace = readFileSync("pyproject.toml", "utf8");
  const license = readFileSync("LICENSE", "utf8");

  assert.ok(pythonWorkspace.includes('requires-python = ">=3.11"'));
  assert.ok(pythonWorkspace.includes('members = ["packages/sdk-python"]'));
  assert.ok(license.startsWith("Apache License\nVersion 2.0, January 2004"));
});

test("root test and check commands execute repository and protocol contract tests", () => {
  const manifest = readRootManifest();

  assert.equal(
    requireString(manifest.scripts, "test:repository"),
    "pnpm ci:build:repository && pnpm test:repository:prepared",
  );
  assert.equal(
    requireString(manifest.scripts, "test:repository:prepared"),
    "node --test tests/repository/*.test.ts",
  );
  assert.equal(
    requireString(manifest.scripts, "test:protocol"),
    "node --test tests/protocol/*.test.ts",
  );
  assert.match(requireString(manifest.scripts, "test"), /\btest:repository\b/u);
  assert.match(requireString(manifest.scripts, "test"), /\btest:protocol\b/u);
  assert.match(requireString(manifest.scripts, "check"), /\btest:repository\b/u);
  assert.match(requireString(manifest.scripts, "check"), /\btest:protocol\b/u);
});

test("generated schemas are checked out with stable LF bytes", () => {
  const result = runCommand("git", [
    "check-attr",
    "eol",
    "--",
    "remote-skills.schema.json",
    "apps/docs/public/schemas/config/0.0.1.json",
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    [
      "remote-skills.schema.json: eol: lf",
      "apps/docs/public/schemas/config/0.0.1.json: eol: lf",
      "",
    ].join("\n"),
  );
});

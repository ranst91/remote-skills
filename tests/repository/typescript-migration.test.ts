import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { test } from "node:test";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const inventoryPath = resolve(import.meta.dirname, "typescript-migration-inventory.json");
const javaScriptExtensions = [".cjs", ".js", ".mjs"] as const;
const excludedDirectoryNames = new Set([
  ".git",
  ".mypy_cache",
  ".next",
  ".pytest_cache",
  ".ruff_cache",
  ".source",
  ".turbo",
  ".venv",
  "__pycache__",
  "coverage",
  "dist",
  "node_modules",
]);
const expectedFinalAuthoredJavaScript = [
  "apps/docs/postcss.config.mjs",
  "packages/sdk-typescript/src/cache/protocol-worker.mjs",
  "tests/protocol/adapters/typescript-protocol-adapter.mjs",
] as const;
const expectedVendoredPako = "packages/core/src/build/vendor/pako-deflate.mjs";
const expectedGeneratedUnicode = "packages/core/src/authoring/unicode-case-fold-v15.mjs";
const expectedImmutableNoop = "tests/protocol/fixtures/adapters/typescript-noop.mjs";

interface MigrationTarget {
  baseline: string;
  successor: string;
  owner: string;
}

interface MigrationInventory {
  schemaVersion: number;
  baselineJavaScriptCount: number;
  migrationTargetCount: number;
  finalAuthoredJavaScript: string[];
  fixedExemptions: {
    generatedUnicode: string;
    vendoredPako: string;
    immutableNoopFixture: string;
  };
  stableMigrationPairs: MigrationTarget[];
}

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

function requireStringProperty(value: object, property: string): string {
  assert.ok(property in value, `inventory entry is missing ${property}`);
  const propertyValue: unknown = Reflect.get(value, property);
  assert.ok(typeof propertyValue === "string", `inventory ${property} must be a string`);
  return propertyValue;
}

function requireNumberProperty(value: object, property: string): number {
  assert.ok(property in value, `inventory is missing ${property}`);
  const propertyValue: unknown = Reflect.get(value, property);
  assert.ok(typeof propertyValue === "number", `inventory ${property} must be a number`);
  return propertyValue;
}

function readInventory(): MigrationInventory {
  const parsed: unknown = JSON.parse(readFileSync(inventoryPath, "utf8"));
  assert.ok(isObject(parsed), "migration inventory must be an object");
  assert.ok("finalAuthoredJavaScript" in parsed);
  assert.ok(Array.isArray(parsed.finalAuthoredJavaScript));
  assert.ok(parsed.finalAuthoredJavaScript.every((value) => typeof value === "string"));
  assert.ok("fixedExemptions" in parsed && isObject(parsed.fixedExemptions));
  assert.ok("stableMigrationPairs" in parsed && Array.isArray(parsed.stableMigrationPairs));

  const stableMigrationPairs = parsed.stableMigrationPairs.map((entry: unknown) => {
    assert.ok(isObject(entry), "stable migration pair entries must be objects");
    return {
      baseline: requireStringProperty(entry, "baseline"),
      successor: requireStringProperty(entry, "successor"),
      owner: requireStringProperty(entry, "owner"),
    };
  });

  return {
    schemaVersion: requireNumberProperty(parsed, "schemaVersion"),
    baselineJavaScriptCount: requireNumberProperty(parsed, "baselineJavaScriptCount"),
    migrationTargetCount: requireNumberProperty(parsed, "migrationTargetCount"),
    finalAuthoredJavaScript: parsed.finalAuthoredJavaScript,
    fixedExemptions: {
      generatedUnicode: requireStringProperty(parsed.fixedExemptions, "generatedUnicode"),
      vendoredPako: requireStringProperty(parsed.fixedExemptions, "vendoredPako"),
      immutableNoopFixture: requireStringProperty(parsed.fixedExemptions, "immutableNoopFixture"),
    },
    stableMigrationPairs,
  };
}

function listJavaScriptFiles(directory: string, scanRoot = repositoryRoot): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!excludedDirectoryNames.has(entry.name)) {
        files.push(...listJavaScriptFiles(path, scanRoot));
      }
      continue;
    }
    if (
      (entry.isFile() || entry.isSymbolicLink()) &&
      javaScriptExtensions.some((extension) => entry.name.endsWith(extension))
    ) {
      files.push(relative(scanRoot, path).split(sep).join("/"));
    }
  }
  return files.sort();
}

function listCurrentRepositoryJavaScriptFiles(root: string): string[] {
  return listJavaScriptFiles(root, root);
}

test("JavaScript inventory cannot be bypassed outside the historical source roots", (testContext) => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "remote-skills-javascript-inventory-"));
  testContext.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  const fixturePaths = [
    "root-probe.mjs",
    "docs/probe.js",
    ".github/probe.cjs",
    "future-surface/probe.mjs",
  ] as const;
  for (const path of fixturePaths) {
    const absolutePath = resolve(fixtureRoot, path);
    mkdirSync(resolve(absolutePath, ".."), { recursive: true });
    writeFileSync(absolutePath, "export {};\n");
  }

  assert.deepEqual(listCurrentRepositoryJavaScriptFiles(fixtureRoot), [...fixturePaths].sort());
});

function assertImportOnlyShim(path: string): void {
  const meaningfulLines = readFileSync(resolve(repositoryRoot, path), "utf8")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("//"));
  assert.ok(
    meaningfulLines.length <= 3,
    `${path} must remain tiny after its typed successor lands`,
  );
  for (const line of meaningfulLines) {
    assert.match(line, /^(?:#!.*|import\s+(?:["'][^"']+["']|.*\sfrom\s["'][^"']+["']);?)$/u);
  }
}

test("the stable pair inventory admits only current baselines and fixed JavaScript seams", () => {
  const inventory = readInventory();
  const actualJavaScript = listCurrentRepositoryJavaScriptFiles(repositoryRoot);
  const baselineInventory = [
    ...inventory.stableMigrationPairs.map(({ baseline }) => baseline),
    ...inventory.finalAuthoredJavaScript,
    inventory.fixedExemptions.generatedUnicode,
    inventory.fixedExemptions.vendoredPako,
    inventory.fixedExemptions.immutableNoopFixture,
  ].sort();
  const expectedCurrentJavaScript = [
    ...inventory.stableMigrationPairs
      .map(({ baseline }) => baseline)
      .filter((path) => existsSync(resolve(repositoryRoot, path))),
    ...inventory.finalAuthoredJavaScript,
    inventory.fixedExemptions.generatedUnicode,
    inventory.fixedExemptions.vendoredPako,
    inventory.fixedExemptions.immutableNoopFixture,
  ].sort();

  assert.equal(inventory.schemaVersion, 1);
  assert.equal(inventory.baselineJavaScriptCount, 134);
  assert.equal(inventory.migrationTargetCount, 128);
  assert.equal(new Set(baselineInventory).size, 134, "inventory paths must be unique");
  assert.deepEqual(actualJavaScript, expectedCurrentJavaScript);
  assert.deepEqual(inventory.finalAuthoredJavaScript, expectedFinalAuthoredJavaScript);
  assert.equal(inventory.fixedExemptions.generatedUnicode, expectedGeneratedUnicode);
  assert.equal(inventory.fixedExemptions.vendoredPako, expectedVendoredPako);
  assert.equal(inventory.fixedExemptions.immutableNoopFixture, expectedImmutableNoop);
});

test("every migration target is present only at its final TypeScript path", () => {
  const inventory = readInventory();
  for (const target of inventory.stableMigrationPairs) {
    const baselineExists = existsSync(resolve(repositoryRoot, target.baseline));
    const successorExists = existsSync(resolve(repositoryRoot, target.successor));
    assert.equal(baselineExists, false, `${target.owner}: stale baseline ${target.baseline}`);
    assert.equal(successorExists, true, `${target.owner}: missing successor ${target.successor}`);
  }
});

test("stable launch shims become tiny and import-only when their typed implementations land", () => {
  for (const [shim, successor] of [
    [
      "packages/sdk-typescript/src/cache/protocol-worker.mjs",
      "packages/sdk-typescript/src/cache/protocol-worker.ts",
    ],
    [
      "tests/protocol/adapters/typescript-protocol-adapter.mjs",
      "tests/protocol/adapters/typescript-protocol-adapter.ts",
    ],
  ] as const) {
    if (existsSync(resolve(repositoryRoot, successor))) assertImportOnlyShim(shim);
  }
});

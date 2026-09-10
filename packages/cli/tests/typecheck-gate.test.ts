import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const typescriptCli = fileURLToPath(
  new URL("../../../node_modules/typescript/bin/tsc", import.meta.url),
);

function jsonObject(value: unknown, label: string): object {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function parseJsonObject(file: string): object {
  const value: unknown = JSON.parse(readFileSync(file, "utf8"));
  return jsonObject(value, file);
}

function property(value: object, field: string): unknown {
  return Reflect.get(value, field);
}

function objectProperty(value: object, field: string): object {
  return jsonObject(property(value, field), field);
}

test("the CLI typecheck gate is strict and rejects a seeded source error", () => {
  const manifest = parseJsonObject(path.join(packageRoot, "package.json"));
  const scripts = objectProperty(manifest, "scripts");
  assert.equal(property(scripts, "typecheck"), "tsc -p tsconfig.json");

  const config = parseJsonObject(path.join(packageRoot, "tsconfig.json"));
  const configExtends = property(config, "extends");
  assert.equal(configExtends, "../../tsconfig.base.json");
  assert.equal(typeof configExtends, "string");
  const compilerOptions = objectProperty(config, "compilerOptions");
  assert.equal(property(compilerOptions, "allowJs"), false);
  assert.equal(property(compilerOptions, "checkJs"), false);
  assert.deepEqual(property(config, "include"), [
    "src/**/*.ts",
    "scripts/**/*.ts",
    "tests/**/*.ts",
  ]);
  const buildConfig = parseJsonObject(path.join(packageRoot, "tsconfig.build.json"));
  const buildCompilerOptions = objectProperty(buildConfig, "compilerOptions");
  assert.equal(property(buildCompilerOptions, "declaration"), true);
  assert.equal(property(buildCompilerOptions, "noEmit"), false);
  assert.equal(property(buildCompilerOptions, "outDir"), "dist");
  assert.equal(property(buildCompilerOptions, "rootDir"), "src");
  assert.equal(property(buildCompilerOptions, "rewriteRelativeImportExtensions"), true);
  assert.deepEqual(property(buildConfig, "include"), ["src/**/*.ts"]);
  const baseConfig = parseJsonObject(path.resolve(packageRoot, configExtends));
  const baseCompilerOptions = objectProperty(baseConfig, "compilerOptions");
  assert.equal(property(baseCompilerOptions, "allowJs"), true);
  assert.equal(property(baseCompilerOptions, "checkJs"), true);
  assert.equal(property(baseCompilerOptions, "strict"), true);
  assert.equal(property(baseCompilerOptions, "noImplicitAny"), true);
  assert.equal(property(baseCompilerOptions, "useUnknownInCatchVariables"), true);
  assert.equal(property(baseCompilerOptions, "exactOptionalPropertyTypes"), true);
  assert.equal(property(baseCompilerOptions, "noUncheckedIndexedAccess"), true);
  assert.equal(property(baseCompilerOptions, "forceConsistentCasingInFileNames"), true);
  assert.equal(property(baseCompilerOptions, "noEmit"), true);

  const seededProject = mkdtempSync(path.join(tmpdir(), "remote-skills-cli-typecheck-"));
  try {
    mkdirSync(path.join(seededProject, "src"));
    writeFileSync(
      path.join(seededProject, "src/seeded-error.ts"),
      "const invalid: string = 42;\nvoid invalid;\n",
    );
    writeFileSync(
      path.join(seededProject, "tsconfig.json"),
      `${JSON.stringify(
        {
          compilerOptions: { ...baseCompilerOptions, types: [] },
          include: ["src/**/*.ts"],
        },
        null,
        2,
      )}\n`,
    );

    const result = spawnSync(process.execPath, [typescriptCli, "-p", seededProject], {
      encoding: "utf8",
    });

    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /not assignable to type 'string'/u);
  } finally {
    rmSync(seededProject, { recursive: true, force: true });
  }
});

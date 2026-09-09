import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type TestContext, test } from "node:test";

import {
  checkEffectiveCompilerOptions,
  FINAL_AUTHORED_JAVASCRIPT_PATHS,
  findNoAnyDiagnostics,
  GENERATED_UNICODE_PATH,
  IMMUTABLE_NOOP_FIXTURE_PATH,
  TYPESCRIPT_PROJECT_CONFIG_PATHS,
  VENDORED_PAKO_PATH,
} from "../../scripts/typescript-policy.ts";

const requiredStrictOptions = [
  "strict",
  "noImplicitAny",
  "useUnknownInCatchVariables",
  "exactOptionalPropertyTypes",
  "noUncheckedIndexedAccess",
  "forceConsistentCasingInFileNames",
] as const;
const projectConfigs = [
  "tsconfig.repository.json",
  "packages/core/tsconfig.json",
  "packages/core/tsconfig.build.json",
  "packages/cli/tsconfig.json",
  "packages/cli/tsconfig.build.json",
  "packages/sdk-typescript/tsconfig.json",
  "packages/sdk-typescript/tsconfig.build.json",
  "integrations/ai-sdk/tsconfig.json",
  "integrations/ai-sdk/tsconfig.build.json",
  "apps/docs/tsconfig.json",
  "examples/tsconfig.json",
  "examples/consumers/typescript/tsconfig.json",
] as const;

function makePolicyFixture(testContext: TestContext, extension: ".js" | ".ts", source: string) {
  const directory = mkdtempSync(join(tmpdir(), "remote-skills-typescript-policy-"));
  testContext.after(() => rmSync(directory, { recursive: true, force: true }));
  const sourcePath = join(directory, `fixture${extension}`);
  const configPath = join(directory, "tsconfig.json");
  writeFileSync(sourcePath, source);
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        compilerOptions: {
          allowJs: true,
          checkJs: true,
          exactOptionalPropertyTypes: true,
          forceConsistentCasingInFileNames: true,
          module: "NodeNext",
          moduleResolution: "NodeNext",
          noEmit: true,
          noImplicitAny: true,
          noUncheckedIndexedAccess: true,
          strict: true,
          target: "ES2024",
          useUnknownInCatchVariables: true,
        },
        files: [sourcePath],
      },
      null,
      2,
    )}\n`,
  );
  return { configPath, sourcePath };
}

test("the root test command discovers every native TypeScript repository test", () => {
  const manifest: unknown = JSON.parse(readFileSync("package.json", "utf8"));
  assert.ok(typeof manifest === "object" && manifest !== null && "scripts" in manifest);
  const scripts = manifest.scripts;
  assert.ok(
    typeof scripts === "object" &&
      scripts !== null &&
      "test:repository" in scripts &&
      "test:repository:prepared" in scripts,
  );
  assert.equal(
    scripts["test:repository"],
    "pnpm ci:build:repository && pnpm test:repository:prepared",
  );
  assert.equal(scripts["test:repository:prepared"], "node --test tests/repository/*.test.ts");
});

test("the root typecheck covers native tools before enforcing the repository policy", () => {
  const manifest: unknown = JSON.parse(readFileSync("package.json", "utf8"));
  assert.ok(typeof manifest === "object" && manifest !== null && "scripts" in manifest);
  const scripts = manifest.scripts;
  assert.ok(
    typeof scripts === "object" &&
      scripts !== null &&
      "typecheck" in scripts &&
      "typecheck:prepared" in scripts,
  );
  assert.equal(scripts.typecheck, "pnpm ci:build:repository && pnpm typecheck:prepared");
  assert.equal(
    scripts["typecheck:prepared"],
    "tsc -p tsconfig.repository.json && node scripts/run-turbo.ts typecheck && node scripts/check-typescript-policy.ts",
  );

  const config: unknown = JSON.parse(readFileSync("tsconfig.repository.json", "utf8"));
  assert.ok(typeof config === "object" && config !== null && "include" in config);
  assert.deepEqual(config.include, ["scripts/**/*.ts", "tests/**/*.ts"]);
});

test("the root TypeScript policy explicitly enables every strictness flag", () => {
  const config: unknown = JSON.parse(readFileSync("tsconfig.base.json", "utf8"));
  assert.ok(typeof config === "object" && config !== null && "compilerOptions" in config);
  const compilerOptions = config.compilerOptions;
  assert.ok(typeof compilerOptions === "object" && compilerOptions !== null);
  for (const option of requiredStrictOptions) {
    assert.ok(option in compilerOptions);
    const value: unknown = Reflect.get(compilerOptions, option);
    assert.equal(value, true, `tsconfig.base.json must explicitly enable ${option}`);
  }
});

test("every authored TypeScript project receives the effective strict compiler policy", () => {
  assert.deepEqual(TYPESCRIPT_PROJECT_CONFIG_PATHS, projectConfigs);
  assert.deepEqual(checkEffectiveCompilerOptions(projectConfigs), []);
});

test("the JavaScript policy constants distinguish final seams from fixed exemptions", () => {
  assert.deepEqual(FINAL_AUTHORED_JAVASCRIPT_PATHS, [
    "apps/docs/postcss.config.mjs",
    "packages/sdk-typescript/src/cache/protocol-worker.mjs",
    "tests/protocol/adapters/typescript-protocol-adapter.mjs",
  ]);
  assert.equal(GENERATED_UNICODE_PATH, "packages/core/src/authoring/unicode-case-fold-v15.mjs");
  assert.equal(VENDORED_PAKO_PATH, "packages/core/src/build/vendor/pako-deflate.mjs");
  assert.equal(IMMUTABLE_NOOP_FIXTURE_PATH, "tests/protocol/fixtures/adapters/typescript-noop.mjs");
});

test("the no-any policy reports explicit TypeScript any with a path and line", (testContext) => {
  const fixture = makePolicyFixture(testContext, ".ts", "export const value: any = 1;\n");
  const diagnostics = findNoAnyDiagnostics({
    projectConfigPaths: [fixture.configPath],
    sourceFilePaths: [fixture.sourcePath],
  });

  assert.deepEqual(
    diagnostics.map(({ kind, path, line }) => ({ kind, path, line })),
    [{ kind: "explicit-any", path: fixture.sourcePath, line: 1 }],
  );
});

test("the no-any policy reports JSDoc any with a path and line", (testContext) => {
  const fixture = makePolicyFixture(
    testContext,
    ".js",
    "/** @type {any} */\nexport const value = 1;\n",
  );
  const diagnostics = findNoAnyDiagnostics({
    projectConfigPaths: [fixture.configPath],
    sourceFilePaths: [fixture.sourcePath],
  });

  assert.deepEqual(
    diagnostics.map(({ kind, path, line }) => ({ kind, path, line })),
    [{ kind: "explicit-any", path: fixture.sourcePath, line: 1 }],
  );
});

test("the no-any policy includes compiler-caught implicit any diagnostics", (testContext) => {
  const fixture = makePolicyFixture(
    testContext,
    ".ts",
    "export function identity(value) { return value; }\n",
  );
  const diagnostics = findNoAnyDiagnostics({
    projectConfigPaths: [fixture.configPath],
    sourceFilePaths: [fixture.sourcePath],
  });

  assert.deepEqual(
    diagnostics.map(({ kind, path, line }) => ({ kind, path, line })),
    [{ kind: "implicit-any", path: fixture.sourcePath, line: 1 }],
  );
});

test("the no-any policy reports an unquarantined any-returning API boundary", (testContext) => {
  const fixture = makePolicyFixture(testContext, ".ts", 'export const value = JSON.parse("{}");\n');
  const diagnostics = findNoAnyDiagnostics({
    projectConfigPaths: [fixture.configPath],
    sourceFilePaths: [fixture.sourcePath],
  });

  assert.deepEqual(
    diagnostics.map(({ kind, path, line }) => ({ kind, path, line })),
    [{ kind: "implicit-any", path: fixture.sourcePath, line: 1 }],
  );
});

test("the no-any policy accepts an any-returning API quarantined as unknown", (testContext) => {
  const fixture = makePolicyFixture(
    testContext,
    ".ts",
    'export const value: unknown = JSON.parse("{}");\n',
  );

  assert.deepEqual(
    findNoAnyDiagnostics({
      projectConfigPaths: [fixture.configPath],
      sourceFilePaths: [fixture.sourcePath],
    }),
    [],
  );
});

test("the no-any policy accepts assignment into a declared unknown boundary", (testContext) => {
  const fixture = makePolicyFixture(
    testContext,
    ".ts",
    'let value: unknown;\nvalue = JSON.parse("{}");\nexport { value };\n',
  );

  assert.deepEqual(
    findNoAnyDiagnostics({
      projectConfigPaths: [fixture.configPath],
      sourceFilePaths: [fixture.sourcePath],
    }),
    [],
  );
});

for (const [behavior, source] of [
  ["a concrete typed declaration", 'export const value: string = JSON.parse("{}");\n'],
  [
    "a concrete typed assignment",
    'let value: string;\nvalue = JSON.parse("{}");\nexport { value };\n',
  ],
  [
    "a concrete typed parameter",
    'function consume(value: string): void { void value; }\nconsume(JSON.parse("{}"));\n',
  ],
  [
    "a generic parameter",
    'function consume<T>(value: T): void { void value; }\nconsume(JSON.parse("{}"));\n',
  ],
  ["an alias of JSON.parse", 'const parse = JSON.parse;\nexport const value = parse("{}");\n'],
] as const) {
  test(`the no-any policy rejects an any-returning API forwarded through ${behavior}`, (testContext) => {
    const fixture = makePolicyFixture(testContext, ".ts", source);
    const diagnostics = findNoAnyDiagnostics({
      projectConfigPaths: [fixture.configPath],
      sourceFilePaths: [fixture.sourcePath],
    });

    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0]?.kind, "implicit-any");
  });
}

test("intentional expect-error negative type tests remain valid", (testContext) => {
  const fixture = makePolicyFixture(
    testContext,
    ".ts",
    'let value = "valid";\n// @ts-expect-error number assignment is intentionally rejected.\nvalue = 1;\n',
  );
  assert.deepEqual(
    findNoAnyDiagnostics({
      projectConfigPaths: [fixture.configPath],
      sourceFilePaths: [fixture.sourcePath],
    }),
    [],
  );
});

test("ts-nocheck is rejected except for the exact vendored path", (testContext) => {
  const fixture = makePolicyFixture(
    testContext,
    ".js",
    "// @ts-nocheck\nexport const value = 1;\n",
  );
  const rejected = findNoAnyDiagnostics({
    projectConfigPaths: [fixture.configPath],
    sourceFilePaths: [fixture.sourcePath],
  });
  const allowed = findNoAnyDiagnostics({
    allowedTsNoCheckPath: fixture.sourcePath,
    projectConfigPaths: [fixture.configPath],
    sourceFilePaths: [fixture.sourcePath],
  });

  assert.deepEqual(
    rejected.map(({ kind, path, line }) => ({ kind, path, line })),
    [{ kind: "forbidden-ts-nocheck", path: fixture.sourcePath, line: 1 }],
  );
  assert.deepEqual(allowed, []);
});

test("ts-nocheck text inside a template is not a directive and scanning terminates", (testContext) => {
  const interpolation = ["$", "{subject}"].join("");
  const fixture = makePolicyFixture(
    testContext,
    ".ts",
    `const subject = "policy";\nexport const message = \`${interpolation}: @ts-nocheck\`;\n`,
  );
  assert.deepEqual(
    findNoAnyDiagnostics({
      projectConfigPaths: [fixture.configPath],
      sourceFilePaths: [fixture.sourcePath],
    }),
    [],
  );
});

test("the repository contains only the single vendored ts-nocheck exception", () => {
  const diagnostics = findNoAnyDiagnostics({
    allowedTsNoCheckPath: resolve(VENDORED_PAKO_PATH),
    includeCompilerDiagnostics: false,
    projectConfigPaths: projectConfigs,
  }).filter(({ kind }) => kind === "forbidden-ts-nocheck");

  assert.deepEqual(diagnostics, []);
});

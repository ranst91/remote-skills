import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageDirectory = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

interface CorePackageJson {
  exports: {
    "./authoring": { types: string; import: string };
    "./build": { types: string; import: string };
    "./config-schema": { types: string; import: string };
  };
  files: string[];
  scripts: {
    build: string;
    prepack: string;
    test: string;
    typecheck: string;
  };
}

function isCorePackageJson(value: unknown): value is CorePackageJson {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  if (!("exports" in value) || !("files" in value) || !("scripts" in value)) {
    return false;
  }
  const { exports, files, scripts } = value;
  return (
    typeof exports === "object" &&
    exports !== null &&
    typeof scripts === "object" &&
    scripts !== null &&
    Array.isArray(files) &&
    files.every((entry) => typeof entry === "string") &&
    "build" in scripts &&
    typeof scripts.build === "string" &&
    "prepack" in scripts &&
    typeof scripts.prepack === "string" &&
    "test" in scripts &&
    typeof scripts.test === "string" &&
    "typecheck" in scripts &&
    typeof scripts.typecheck === "string" &&
    "./authoring" in exports &&
    "./build" in exports &&
    "./config-schema" in exports
  );
}

async function authoredJavaScriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "dist" || entry.name === "node_modules" || entry.name === ".turbo") {
          return [];
        }
        return authoredJavaScriptFiles(absolutePath);
      }
      return /\.(?:c|m)?js$/u.test(entry.name)
        ? [path.relative(packageDirectory, absolutePath)]
        : [];
    }),
  );
  return files.flat().sort();
}

async function distributionFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const absolutePath = path.join(directory, entry.name);
      return entry.isDirectory()
        ? distributionFiles(absolutePath)
        : [path.relative(path.join(packageDirectory, "dist"), absolutePath)];
    }),
  );
  return files.flat().sort();
}

test("core has only its fixed vendored and generated JavaScript exemptions", async () => {
  assert.deepEqual(await authoredJavaScriptFiles(packageDirectory), [
    path.join("src", "authoring", "unicode-case-fold-v15.mjs"),
    path.join("src", "build", "vendor", "pako-deflate.mjs"),
  ]);
});

test("the generated Unicode module remains byte-stable through compilation", async () => {
  const source = await readFile(
    path.join(packageDirectory, "src", "authoring", "unicode-case-fold-v15.mjs"),
  );
  const emitted = await readFile(
    path.join(packageDirectory, "dist", "authoring", "unicode-case-fold-v15.mjs"),
  );

  assert.equal(
    createHash("sha256").update(source).digest("hex"),
    "fc1f9ee25327d1dc447865cf6bdb0005f0c95ec04d7d5c10b3356a99a8b865e0",
  );
  assert.deepEqual(emitted, source);
});

test("core exposes only deterministic emitted JavaScript and declarations", async () => {
  const packageJsonValue: unknown = JSON.parse(
    await readFile(path.join(packageDirectory, "package.json"), "utf8"),
  );
  assert.ok(
    isCorePackageJson(packageJsonValue),
    "package.json must have the typed core package shape",
  );
  assert.deepEqual(packageJsonValue.files, ["dist"]);
  assert.deepEqual(packageJsonValue.exports, {
    "./authoring": {
      types: "./dist/authoring/index.d.ts",
      import: "./dist/authoring/index.js",
    },
    "./build": {
      types: "./dist/build/index.d.ts",
      import: "./dist/build/index.js",
    },
    "./config-schema": {
      types: "./dist/config-schema.d.ts",
      import: "./dist/config-schema.js",
    },
  });
  assert.equal(packageJsonValue.scripts.build, "node scripts/build.ts");
  assert.equal(packageJsonValue.scripts.prepack, "pnpm build");
  assert.equal(packageJsonValue.scripts.test, "node --test tests/*.test.ts");
  assert.equal(packageJsonValue.scripts.typecheck, "tsc -p tsconfig.json");
});

test("core build emits the complete deterministic runtime, declaration, and asset tree", async () => {
  const modules = [
    "authoring/diagnostics",
    "authoring/frontmatter",
    "authoring/inclusion",
    "authoring/index",
    "authoring/paths",
    "authoring/validate-project",
    "build/archive-validation",
    "build/archive",
    "build/catalog-json",
    "build/errors",
    "build/index",
    "build/output",
    "build/prior-output",
    "build/publication",
    "build/semver",
    "config-schema",
  ];
  assert.deepEqual(
    await distributionFiles(path.join(packageDirectory, "dist")),
    [
      ...modules.flatMap((module) => [`${module}.d.ts`, `${module}.js`]),
      "authoring/unicode-case-fold-v15.d.mts",
      "authoring/unicode-case-fold-v15.mjs",
      "build/vendor/pako-deflate.mjs",
      "build/vendor/pako.LICENSE.txt",
    ].sort(),
  );

  for (const module of modules) {
    const declaration = await readFile(
      path.join(packageDirectory, "dist", `${module}.d.ts`),
      "utf8",
    );
    assert.doesNotMatch(
      declaration,
      /["']\.\.?\/[^"']+\.ts["']/u,
      `${module}.d.ts must reference emitted JavaScript successors`,
    );
  }

  await Promise.all(
    ["authoring/index.js", "build/index.js", "config-schema.js"].map(
      (entrypoint) => import(pathToFileURL(path.join(packageDirectory, "dist", entrypoint)).href),
    ),
  );
});

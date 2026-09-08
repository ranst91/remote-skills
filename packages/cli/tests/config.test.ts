import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { ConfigValidationError, validateConfig } from "@remote-skills/core/config-schema";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));

function readFixture(name: string): unknown {
  return JSON.parse(
    readFileSync(path.join(repositoryRoot, "packages/core/tests/fixtures/config", name), "utf8"),
  );
}

const defaultConfig = {
  $schema: "https://remote-skills.dev/schemas/config/0.0.1.json",
  sourceRoots: ["skills"],
  outDir: "dist",
  format: "tar.gz",
  strict: false,
  limits: {
    catalogBytes: 1_048_576,
    archiveBytes: 52_428_800,
    extractedBytes: 104_857_600,
    files: 1_000,
    fileBytes: 10_485_760,
  },
  dev: { host: "127.0.0.1", port: 8_787 },
};

test("the CLI consumes all approved core config defaults", () => {
  assert.deepEqual(validateConfig(readFixture("defaults.json")), defaultConfig);
});

test("the CLI rejects an unknown core config typo field", () => {
  assert.throws(
    () => validateConfig(readFixture("unknown-field.json")),
    (error) => error instanceof ConfigValidationError && /outputDIr/u.test(error.message),
  );
});

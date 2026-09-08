import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  ConfigValidationError,
  serializedConfigSchema,
  validateAgainstConfigSchema,
  validateConfig,
} from "../src/config-schema.ts";

function readFixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`fixtures/config/${name}`, import.meta.url), "utf8"));
}

test("the published JSON Schema accepts the default configuration", () => {
  assert.doesNotThrow(() => validateAgainstConfigSchema(readFixture("defaults.json")));
});

test("the published JSON Schema rejects an unknown typo field", () => {
  assert.throws(() => validateAgainstConfigSchema(readFixture("unknown-field.json")), /outputDIr/u);
});

test("the checked-in and publication schemas match the runtime schema", () => {
  const expected = serializedConfigSchema();
  for (const target of [
    "../../../remote-skills.schema.json",
    "../../../apps/docs/public/schemas/config/0.0.1.json",
  ]) {
    assert.equal(readFileSync(new URL(target, import.meta.url), "utf8"), expected);
  }
});

test("nested unknown fields retain their full configuration path", () => {
  assert.throws(
    () => validateConfig({ limits: { outputDIr: 1 } }),
    (error) => {
      assert.ok(error instanceof ConfigValidationError);
      assert.deepEqual(error.issues, ["/limits/outputDIr must NOT have additional properties"]);
      return true;
    },
  );
});

test("configuration failures expose the shared stable error core", () => {
  assert.throws(
    () => validateConfig({ outputDIr: "dist" }),
    (error) => {
      assert.ok(error instanceof ConfigValidationError);
      assert.equal(error.code, "configuration_invalid");
      assert.equal(error.retryable, false);
      assert.deepEqual(error.context, { field: "/outputDIr" });
      return true;
    },
  );
});

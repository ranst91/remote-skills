import { readFileSync } from "node:fs";

import { validateAgainstConfigSchema, validateConfig } from "../packages/core/src/config-schema.ts";

const [mode, fixturePath] = process.argv.slice(2);
if (fixturePath === undefined || (mode !== "runtime" && mode !== "schema")) {
  throw new Error("usage: validate-config-fixture.ts <runtime|schema> <fixture>");
}

const input: unknown = JSON.parse(readFileSync(fixturePath, "utf8"));

try {
  if (mode === "runtime") {
    console.log(JSON.stringify(validateConfig(input)));
  } else {
    validateAgainstConfigSchema(input);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

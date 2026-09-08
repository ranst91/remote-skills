import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runCommand } from "../helpers/run-command.ts";

test("runs the complete local publishing and consumption example once", () => {
  const smoke = fileURLToPath(new URL("./run-smoke.ts", import.meta.url));
  const result = runCommand(process.execPath, [smoke], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
    timeout: 120_000,
  });

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /example smoke passed/u);
});

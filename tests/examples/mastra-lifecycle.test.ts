import assert from "node:assert/strict";
import test from "node:test";
import { validateEnvironment } from "../../scripts/examples/dev.ts";

test("Mastra reserved ports are configurable and leave the existing demo defaults unchanged", () => {
  const env = { REMOTE_SKILLS_EXAMPLE_TEST: "1" };
  assert.deepEqual(validateEnvironment(env), { appPort: 5173, skillsPort: 8787 });
  assert.deepEqual(validateEnvironment(env, { appPort: 5181, skillsPort: 8791 }), {
    appPort: 5181,
    skillsPort: 8791,
  });
  assert.deepEqual(
    validateEnvironment(
      { ...env, APP_PORT: "5182", SKILLS_PORT: "8792" },
      { appPort: 5181, skillsPort: 8791 },
    ),
    { appPort: 5182, skillsPort: 8792 },
  );
});

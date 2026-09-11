import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runCommand } from "../helpers/run-command.ts";
import {
  copyConsumer,
  installNpm,
  installPython,
  packageSource,
} from "./helpers/package-source.ts";

test("runs the complete local publishing and consumption example once", async (t) => {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" };
  delete env.NODE_TEST_CONTEXT;
  const source = await packageSource();
  if (source) {
    for (const name of [
      "NODE_OPTIONS",
      "NODE_PATH",
      "PYTHONPATH",
      "VIRTUAL_ENV",
      "UV_PROJECT_ENVIRONMENT",
    ])
      delete env[name];
    const work = await mkdtemp(resolve(tmpdir(), "remote-skills-installed-smoke-"));
    t.after(() => rm(work, { recursive: true, force: true }));
    await installNpm(work, source);
    env.REMOTE_SKILLS_E2E_PYTHON = await installPython(work, source);
    env.REMOTE_SKILLS_E2E_CONSUMER = await copyConsumer(
      work,
      resolve(import.meta.dirname, "../.."),
    );
    env.REMOTE_SKILLS_E2E_CLI = resolve(work, "node_modules/@remote-skills/cli/dist/cli.js");
  }
  const smoke = fileURLToPath(new URL("./run-smoke.ts", import.meta.url));
  const result = runCommand(process.execPath, [smoke], {
    encoding: "utf8",
    env,
    timeout: 120_000,
  });

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /example smoke passed/u);
});

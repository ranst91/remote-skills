import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const runner = resolve(repositoryRoot, "tests/protocol/tools/run-determinism-gate.ts");

test("the protocol CI group owns the determinism gate exactly once", () => {
  const workflow = readFileSync(resolve(repositoryRoot, ".github/workflows/ci.yml"), "utf8");
  const groupRunner = readFileSync(resolve(repositoryRoot, "scripts/run-ci-test-group.ts"), "utf8");
  const executions = groupRunner.match(/tests\/protocol\/tools\/run-determinism-gate\.ts/gu);

  assert.match(workflow, /^ {2}check:$/mu);
  assert.match(workflow, /^ {2}test:$/mu);
  assert.match(workflow, /^ {2}windows:$/mu);
  assert.match(workflow, /^ {10}- group: protocol$/mu);
  assert.doesNotMatch(workflow, /run: node tests\/protocol\/tools\/run-determinism-gate\.ts/u);
  assert.equal(executions?.length, 1, "only the protocol CI group runs determinism");
  assert.doesNotMatch(workflow, /macos-latest/u);
});

test("the determinism gate exposes a platform-neutral Node entrypoint", () => {
  const result = spawnSync(process.execPath, [runner, "--help"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout, "Usage: node tests/protocol/tools/run-determinism-gate.ts\n");
});

test("the Python probe runs from the locked uv project without syncing", () => {
  const source = readFileSync(runner, "utf8");

  assert.match(source, /executable: "uv"/u);
  assert.match(
    source,
    /arguments_: \[\s*"run",\s*"--project",\s*pythonProject,\s*"--locked",\s*"--no-sync",\s*"python",\s*pythonProbe,/u,
  );
  assert.doesNotMatch(source, /REMOTE_SKILLS_PYTHON|const python =/u);
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { createRemoteSkillsCommand } from "./helpers/public-cli.ts";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const exampleRoot = resolve(repositoryRoot, "examples");
const inspected = [
  resolve(exampleRoot, "publisher/package.json"),
  resolve(import.meta.dirname, "helpers/public-cli.ts"),
  resolve(import.meta.dirname, "helpers/build-history.ts"),
  resolve(import.meta.dirname, "helpers/verify-origin.ts"),
  resolve(repositoryRoot, "tests/examples/run-smoke.ts"),
  resolve(exampleRoot, "consumers/python/package.json"),
  resolve(import.meta.dirname, "helpers/run-python.ts"),
];

test("runnable examples use installed public package boundaries", async () => {
  const source = await Promise.all(inspected.map((path) => readFile(path, "utf8"))).then((files) =>
    files.join("\n"),
  );
  const cliSourcePath = ["packages", "cli", "src", "cli.mjs"].join("/");
  const pythonSourcePath = ["packages", "sdk-python", "src"].join("/");
  const pythonPathVariable = ["PYTHON", "PATH"].join("");

  assert.ok(!source.includes(cliSourcePath), `forbidden CLI source path: ${cliSourcePath}`);
  assert.ok(
    !source.includes(pythonSourcePath),
    `forbidden Python source path: ${pythonSourcePath}`,
  );
  assert.ok(
    !source.includes(pythonPathVariable),
    `forbidden Python source injection: ${pythonPathVariable}`,
  );
  assert.match(
    source,
    /publisher[/\\]node_modules[/\\]@remote-skills[/\\]cli[/\\]dist[/\\]cli\.js/u,
  );
  assert.doesNotMatch(source, /node_modules[/\\]\.bin|remote-skills\.cmd/u);
  assert.doesNotMatch(source, /run\("pnpm"/u);
  assert.match(source, /createPnpmCommand\(\["--filter", "@remote-skills\/client", "build"\]\)/u);
  assert.match(source, /remote_skills-0\.0\.1-py3-none-any\.whl/u);
  assert.match(source, /--offline/u);
  assert.match(source, /--no-index/u);
});

test("the public CLI launcher preserves Windows paths and argv without a shell", () => {
  const nodeExecutable = String.raw`C:\Program Files\nodejs\node.exe`;
  const cliEntrypoint = String.raw`C:\example with spaces\node_modules\@remote-skills\cli\dist\cli.js`;

  assert.deepEqual(
    createRemoteSkillsCommand(["verify", String.raw`C:\origin path\catalog.json`], {
      cliEntrypoint,
      nodeExecutable,
    }),
    {
      command: nodeExecutable,
      args: [cliEntrypoint, "verify", String.raw`C:\origin path\catalog.json`],
    },
  );
});

test("the Python example reuses dependencies from the synced workspace environment", async () => {
  const source = await readFile(resolve(import.meta.dirname, "helpers/run-python.ts"), "utf8");

  assert.match(source, /accepted-project-environment\.pth/u);
  assert.match(source, /sysconfig\.get_path/u);
  assert.doesNotMatch(source, /["']sync["']/u);
  assert.doesNotMatch(source, /uts46==/u);
});

test("the Git Pages workflow builds the CLI and its dependencies before the publisher", async () => {
  const workflow = await readFile(
    resolve(import.meta.dirname, "fixtures/build-static-origin.yml"),
    "utf8",
  );
  const buildCli = "      - run: pnpm --filter '@remote-skills/cli...' build";
  const buildPublisher = "      - run: pnpm --dir examples/publisher build";
  const cliIndex = workflow.indexOf(buildCli);
  const publisherIndex = workflow.indexOf(buildPublisher);

  assert.notEqual(cliIndex, -1, `missing workflow step: ${buildCli.trim()}`);
  assert.notEqual(publisherIndex, -1, `missing workflow step: ${buildPublisher.trim()}`);
  assert.doesNotMatch(
    workflow,
    /^\s+- run: pnpm --filter @remote-skills\/cli build$/mu,
    "the CLI-only filter omits workspace dependencies",
  );
  assert.ok(cliIndex < publisherIndex, "the CLI dependency build must precede the publisher build");
});

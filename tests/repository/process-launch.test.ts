import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import test from "node:test";

import {
  createPnpmCommand,
  describeSpawnFailure,
  spawnPnpmSync,
} from "../../scripts/lib/pnpm-command.ts";
import { createTurboCommand } from "../../scripts/lib/turbo-command.ts";
import { resolveCompatibleUvCommand } from "../../scripts/lib/uv-command.ts";

function writeUvFixture(directory: string, version: string, commandStatus = 0): string {
  const command = join(directory, "uv");
  writeFileSync(
    command,
    [
      `#!${process.execPath}`,
      `const arguments_ = process.argv.slice(2);`,
      `if (arguments_[0] === "--version") process.stdout.write(${JSON.stringify(`uv ${version} (fixture)\n`)});`,
      `else process.stdout.write(JSON.stringify(arguments_));`,
      `if (arguments_[0] !== "--version") process.exitCode = ${commandStatus};`,
      "",
    ].join("\n"),
  );
  chmodSync(command, 0o755);
  return command;
}

test("Turbo commands use the Node executable even for Windows-style paths", () => {
  const nodeExecutable = String.raw`C:\Program Files\nodejs\node.exe`;
  const turboCli = String.raw`C:\repo with spaces\node_modules\turbo\bin\turbo`;
  const result = createTurboCommand(["run", "check"], { nodeExecutable, turboCli });

  assert.deepEqual(result, {
    command: nodeExecutable,
    args: [turboCli, "run", "check"],
  });
});

test("the resolved Turbo JavaScript entrypoint executes without a command shell", () => {
  const turbo = createTurboCommand(["--version"]);
  const result = spawnSync(turbo.command, turbo.args, { encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^2\.10\.11\s*$/u);
});

test("locked pnpm commands use Node even with a Windows entrypoint path", () => {
  const nodeExecutable = String.raw`C:\Program Files\nodejs\node.exe`;
  const pnpmEntrypoint = String.raw`C:\pnpm with spaces\pnpm.cjs`;

  assert.deepEqual(createPnpmCommand(["--version"], { nodeExecutable, pnpmEntrypoint }), {
    command: nodeExecutable,
    args: [pnpmEntrypoint, "--version"],
  });
});

test("locked Node launches preserve entrypoint and argument paths containing spaces", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "remote skills launch "));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const entrypoint = join(directory, "pnpm entrypoint.cjs");
  writeFileSync(entrypoint, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");

  const result = spawnPnpmSync(
    [String.raw`C:\project path\fixture.ts`, "value with spaces"],
    { encoding: "utf8" },
    { pnpmEntrypoint: entrypoint },
  );

  assert.equal(result.status, 0, result.stderr);
  const observed: unknown = JSON.parse(result.stdout);
  assert.deepEqual(observed, [String.raw`C:\project path\fixture.ts`, "value with spaces"]);
});

test("spawn failures report the exact command, error, status, and stderr", () => {
  const launch = {
    command: String.raw`C:\Program Files\nodejs\node.exe`,
    args: [String.raw`C:\pnpm\pnpm.cjs`, "--version"],
  };
  const error = Object.assign(new Error("spawn EINVAL"), { code: "EINVAL" });

  assert.equal(
    describeSpawnFailure(launch, {
      error,
      status: null,
      stdout: "",
      stderr: "launcher stderr",
    }),
    [
      String.raw`command: "C:\\Program Files\\nodejs\\node.exe" "C:\\pnpm\\pnpm.cjs" "--version"`,
      "error: EINVAL: spawn EINVAL",
      "status: null",
      "stdout: <empty>",
      "stderr: launcher stderr",
    ].join("\n"),
  );
});

test("every CI job pins the same uv version accepted by TypeScript and Python builds", {
  skip: process.platform === "win32",
}, (context) => {
  const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
  const setupSteps = workflow.split("uses: astral-sh/setup-uv@").slice(1);
  assert.equal(setupSteps.length, 4);
  const versions = setupSteps.map((step, index) => {
    const version = step.split("\n      - ")[0]?.match(/\n {10}version: "(\d+\.\d+\.\d+)"/u)?.[1];
    assert.ok(version, `uv setup step ${index + 1} must select an exact version`);
    return version;
  });
  assert.equal(new Set(versions).size, 1, "all jobs must use the same uv version");
  const version = versions[0];
  assert.ok(version);
  const directory = mkdtempSync(join(tmpdir(), "remote-skills-ci-uv-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const command = realpathSync(writeUvFixture(directory, version));
  const environment = { ...process.env, REMOTE_SKILLS_UV: command };

  assert.equal(resolveCompatibleUvCommand({ environment }), realpathSync(command));
  const python = process.env.REMOTE_SKILLS_PYTHON ?? resolve(".venv/bin/python");
  const result = spawnSync(
    python,
    [
      "-c",
      "import runpy; print(runpy.run_path('packages/sdk-python/tests/test_package.py', run_name='toolchain_contract')['UV_COMMAND'])",
    ],
    { encoding: "utf8", env: environment },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), realpathSync(command));
});

test("uv resolution accepts Windows-style Path casing and skips an old executable", {
  skip: process.platform === "win32",
}, (context) => {
  const oldDirectory = mkdtempSync(join(tmpdir(), "remote-skills-old-uv-"));
  const compatibleDirectory = mkdtempSync(join(tmpdir(), "remote-skills-compatible-uv-"));
  context.after(() => rmSync(oldDirectory, { recursive: true, force: true }));
  context.after(() => rmSync(compatibleDirectory, { recursive: true, force: true }));
  writeUvFixture(oldDirectory, "0.11.8");
  const compatible = writeUvFixture(compatibleDirectory, "0.11.33");
  const environment: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.toUpperCase() === "PATH") delete environment[key];
  }
  environment.Path = [oldDirectory, compatibleDirectory].join(delimiter);
  delete environment.REMOTE_SKILLS_UV;

  assert.equal(resolveCompatibleUvCommand({ environment }), realpathSync(compatible));
});

test("an explicit incompatible uv command fails with the required version", {
  skip: process.platform === "win32",
}, (context) => {
  const directory = mkdtempSync(join(tmpdir(), "remote-skills-incompatible-uv-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const command = writeUvFixture(directory, "0.11.8");

  assert.throws(
    () =>
      resolveCompatibleUvCommand({
        environment: { ...process.env, REMOTE_SKILLS_UV: command },
      }),
    /offline builds require uv >=0\.11\.33,<0\.12\.0.*uv 0\.11\.8/u,
  );
});

test("the uv launcher selects the compatible binary before forwarding exact arguments", {
  skip: process.platform === "win32",
}, (context) => {
  const oldDirectory = mkdtempSync(join(tmpdir(), "remote-skills-old-uv-launch-"));
  const compatibleDirectory = mkdtempSync(join(tmpdir(), "remote-skills-compatible-uv-launch-"));
  context.after(() => rmSync(oldDirectory, { recursive: true, force: true }));
  context.after(() => rmSync(compatibleDirectory, { recursive: true, force: true }));
  writeUvFixture(oldDirectory, "0.11.8");
  writeUvFixture(compatibleDirectory, "0.11.33", 23);
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: [oldDirectory, compatibleDirectory].join(delimiter),
  };
  delete environment.REMOTE_SKILLS_UV;

  const result = spawnSync(process.execPath, ["scripts/run-uv.ts", "build", "path with spaces"], {
    encoding: "utf8",
    env: environment,
  });

  assert.equal(result.status, 23, result.stderr);
  assert.equal(result.stdout, JSON.stringify(["build", "path with spaces"]));
});

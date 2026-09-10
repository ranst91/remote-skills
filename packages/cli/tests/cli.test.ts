import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type TestContext, test } from "node:test";
import { fileURLToPath } from "node:url";
import { runBuildCommand } from "../src/build.ts";
import * as cli from "../src/cli.ts";
import { runValidateCommand } from "../src/validate.ts";
import { runVerifyCommand } from "../src/verify.ts";
import { PublisherVerifyError } from "../src/verify-errors.ts";

type CliCommands = NonNullable<Parameters<typeof cli.dispatchCli>[1]>;
type CommandCall = { command: string; options: object };
const expectedMetadata: unknown = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
assert.ok(
  typeof expectedMetadata === "object" &&
    expectedMetadata !== null &&
    "version" in expectedMetadata &&
    typeof expectedMetadata.version === "string",
);
const expectedVersion = expectedMetadata.version;

async function runDispatcher(args: string[], commands: CliCommands = {}, projectDir = "/project") {
  let stdout = "";
  let stderr = "";
  const exitCode = await cli.dispatchCli(
    {
      args,
      projectDir,
      env: {},
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
    },
    commands,
  );
  return { exitCode, stdout, stderr };
}

function createProject(t: TestContext, skill: string): string {
  const projectDir = mkdtempSync(path.join(tmpdir(), "remote-skills-dispatch-"));
  t.after(() => rmSync(projectDir, { recursive: true, force: true }));
  mkdirSync(path.join(projectDir, "skills", "fixture-skill"), { recursive: true });
  writeFileSync(path.join(projectDir, "skills", "fixture-skill", "SKILL.md"), skill);
  return projectDir;
}

for (const command of ["validate", "build"] as const) {
  test(`${command} renders real authoring errors with skill and path`, async (t) => {
    const projectDir = createProject(t, "---\nname: fixture-skill\n---\nBenign instructions.\n");
    const result = await runDispatcher(
      [command],
      { validate: runValidateCommand, build: runBuildCommand },
      projectDir,
    );
    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, "");
    assert.equal(
      result.stderr,
      'remote-skills: error catalog_invalid skill_name="fixture-skill" path="skills/fixture-skill/SKILL.md" field="description"\n',
    );
  });
}

for (const command of ["validate", "build"] as const) {
  test(`${command} renders real writing warnings`, async (t) => {
    const projectDir = createProject(
      t,
      `---\nname: fixture-skill\ndescription: Dispatcher fixture.\n---\n${"Benign line.\n".repeat(501)}`,
    );
    const result = await runDispatcher(
      [command],
      { validate: runValidateCommand, build: runBuildCommand },
      projectDir,
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "");
    assert.match(
      result.stderr,
      /^remote-skills: warning catalog_invalid skill_name="fixture-skill" path="skills\/fixture-skill\/SKILL.md"/u,
    );
    if (command === "validate") {
      const strict = await runDispatcher(
        [command, "--strict"],
        { validate: runValidateCommand },
        projectDir,
      );
      assert.equal(strict.exitCode, 1);
      assert.equal(strict.stderr, result.stderr.replace(": warning ", ": error "));
    }
  });
}

test("verify renders an ordinary transport failure for the selected skill", async () => {
  const result = await runDispatcher(["verify", "https://skills.example.test", "--retries=0"], {
    verify: (options) =>
      runVerifyCommand(options, {
        resolve: async () => [{ address: "93.184.216.34", family: 4 }],
        transport: async (request) => {
          if (!request.url.endsWith("index.json")) throw new Error("transport detail");
          return {
            status: 200,
            headers: {},
            body: Buffer.from(
              JSON.stringify({
                $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
                skills: [
                  {
                    name: "fixture-skill",
                    description: "Dispatcher fixture.",
                    type: "skill-md",
                    url: "artifacts/fixture.md",
                    digest: `sha256:${"0".repeat(64)}`,
                  },
                ],
              }),
            ),
          };
        },
      }),
  });
  assert.deepEqual(result, {
    exitCode: 1,
    stdout: "",
    stderr: 'remote-skills: error origin_unavailable skill_name="fixture-skill"\n',
  });
});

test("real configuration errors identify their safe field", async (t) => {
  const projectDir = createProject(t, "");
  writeFileSync(path.join(projectDir, "remote-skills.json"), '{"limits":{"files":0}}');
  assert.deepEqual(
    await runDispatcher(["validate"], { validate: runValidateCommand }, projectDir),
    {
      exitCode: 2,
      stdout: "",
      stderr: 'remote-skills: error configuration_invalid field="/limits/files"\n',
    },
  );
  assert.deepEqual(
    await runDispatcher(["verify", "https://skills.example.test", "--retries=-1"], {
      verify: runVerifyCommand,
    }),
    {
      exitCode: 2,
      stdout: "",
      stderr: 'remote-skills: error configuration_invalid field="--retries"\n',
    },
  );
});

test("typed failures preserve known codes and only allowlisted context", async () => {
  assert.deepEqual(
    await runDispatcher(["verify"], {
      verify: async () => {
        throw new PublisherVerifyError(
          "request_timeout",
          { status: 503, body: "benign body", headers: "benign headers", field: "catalog" },
          "benign message",
        );
      },
    }),
    {
      exitCode: 1,
      stdout: "",
      stderr: 'remote-skills: error request_timeout field="catalog" status=503\n',
    },
  );
});

test("verify reports invalid budgets as usage errors and advertises their flags", async () => {
  const flags = [
    "--catalog-bytes",
    "--archive-bytes",
    "--extracted-bytes",
    "--files",
    "--file-bytes",
  ];
  const help = await runDispatcher(["--help"]);
  for (const flag of flags) {
    assert.ok(help.stdout.includes(`${flag} N`));
    assert.deepEqual(
      await runDispatcher(["verify", "https://skills.example.test", `${flag}=0`], {
        verify: runVerifyCommand,
      }),
      {
        exitCode: 2,
        stdout: "",
        stderr: `remote-skills: error configuration_invalid field="${flag}"\n`,
      },
    );
  }
});

function createCommandHarness() {
  const calls: CommandCall[] = [];
  const commands: CliCommands = {
    validate: async (options) => {
      calls.push({ command: "validate", options });
      return { exitCode: 0, valid: true, skills: [], errors: [], warnings: [] };
    },
    build: async (options) => {
      calls.push({ command: "build", options });
      return { exitCode: 0, valid: true, skills: [], errors: [], warnings: [] };
    },
    dev: async (options) => {
      calls.push({ command: "dev", options });
      return { origin: "http://127.0.0.1:8787", closed: Promise.resolve() };
    },
    verify: async (options) => {
      calls.push({ command: "verify", options });
      return {
        exitCode: 0,
        origin: "https://skills.example.test",
        verified: true,
        entries: [],
        failures: [],
      };
    },
  };
  return {
    calls,
    commands,
  };
}

test("the entrypoint exposes a testable dispatcher and stable exit codes", () => {
  assert.equal(typeof cli.dispatchCli, "function");
  assert.deepEqual(cli.CLI_EXIT_CODES, { success: 0, failure: 1, usage: 2 });
});

for (const args of [[], ["help"], ["--help"], ["-h"]]) {
  test(`${args.join(" ") || "no arguments"} prints the command help`, async () => {
    const result = await runDispatcher(args);

    assert.equal(result.exitCode, cli.CLI_EXIT_CODES.success);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /^Remote Skills\n\nUsage:\n {2}remote-skills <command>/u);
    for (const command of ["validate", "build", "dev", "verify"]) {
      assert.match(result.stdout, new RegExp(`^  ${command}(?: |$)`, "mu"));
    }
  });
}

for (const args of [["--version"], ["-V"]]) {
  test(`${args[0]} prints the package version`, async () => {
    assert.deepEqual(await runDispatcher(args), {
      exitCode: cli.CLI_EXIT_CODES.success,
      stdout: `${expectedVersion}\n`,
      stderr: "",
    });
  });
}

const commandCases: Array<readonly [string, string[], object]> = [
  ["validate", ["--strict"], { projectDir: "/project", args: ["--strict"] }],
  ["build", ["--archive"], { projectDir: "/project", args: ["--archive"] }],
  ["dev", ["--port", "9000"], { projectDir: "/project", args: ["--port", "9000"] }],
  ["verify", ["https://skills.example.test"], { args: ["https://skills.example.test"], env: {} }],
];
for (const [command, args, expectedOptions] of commandCases) {
  test(`${command} invokes only its owned command boundary`, async () => {
    const harness = createCommandHarness();

    const result = await runDispatcher([command, ...args], harness.commands);

    assert.equal(result.exitCode, cli.CLI_EXIT_CODES.success);
    assert.deepEqual(harness.calls, [{ command, options: expectedOptions }]);
  });
}

for (const command of ["bridge", "deploy", "publish", "unknown"]) {
  test(`${command} is not a CLI command`, async () => {
    const harness = createCommandHarness();

    const result = await runDispatcher([command], harness.commands);

    assert.deepEqual(result, {
      exitCode: cli.CLI_EXIT_CODES.usage,
      stdout: "",
      stderr: `remote-skills: unknown command: ${command}\n`,
    });
    assert.deepEqual(harness.calls, []);
  });
}

test("command outcomes are normalized to the stable failure exit code", async () => {
  const harness = createCommandHarness();
  harness.commands.validate = async () => ({
    exitCode: 99,
    valid: false,
    skills: [],
    errors: [],
    warnings: [],
  });

  const result = await runDispatcher(["validate"], harness.commands);

  assert.equal(result.exitCode, cli.CLI_EXIT_CODES.failure);
});

test("configuration errors use the stable usage exit without exposing the message", async () => {
  const harness = createCommandHarness();
  const error = Object.assign(new Error("credential-canary"), {
    code: "configuration_invalid",
  });
  harness.commands.validate = async () => {
    throw error;
  };

  assert.deepEqual(await runDispatcher(["validate"], harness.commands), {
    exitCode: cli.CLI_EXIT_CODES.usage,
    stdout: "",
    stderr: "remote-skills: configuration_invalid\n",
  });
});

test("unexpected command errors fail stably without exposing the message", async () => {
  const harness = createCommandHarness();
  harness.commands.build = async () => {
    throw new Error("credential-canary");
  };

  assert.deepEqual(await runDispatcher(["build"], harness.commands), {
    exitCode: cli.CLI_EXIT_CODES.failure,
    stdout: "",
    stderr: "remote-skills: internal_error\n",
  });
});

test("launching the Node entrypoint executes the dispatcher", () => {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("../src/cli.ts", import.meta.url)), "--version"],
    {
      encoding: "utf8",
    },
  );

  assert.equal(result.status, cli.CLI_EXIT_CODES.success, result.stderr);
  assert.equal(result.stdout, `${expectedVersion}\n`);
  assert.equal(result.stderr, "");
});

test("the launched entrypoint preserves the stable unknown-command exit", () => {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("../src/cli.ts", import.meta.url)), "deploy"],
    {
      encoding: "utf8",
    },
  );

  assert.equal(result.status, cli.CLI_EXIT_CODES.usage);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "remote-skills: unknown command: deploy\n");
});

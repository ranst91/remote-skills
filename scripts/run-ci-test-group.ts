import { spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { createPnpmCommand, describeSpawnFailure, spawnPnpmSync } from "./lib/pnpm-command.ts";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const buildCliCommand = {
  kind: "node",
  args: ["scripts/run-turbo.ts", "build", "--filter=@remote-skills/cli"],
} as const;
const groups = {
  core: {
    owners: ["@remote-skills/core", "@remote-skills/cli"],
    commands: [
      { kind: "pnpm", args: ["--filter", "@remote-skills/core", "run", "build"] },
      { kind: "pnpm", args: ["--filter", "@remote-skills/core", "run", "check"] },
      { kind: "pnpm", args: ["--filter", "@remote-skills/cli", "run", "build"] },
      { kind: "pnpm", args: ["--filter", "@remote-skills/cli", "run", "check"] },
    ],
  },
  typescript: {
    owners: ["@remote-skills/client"],
    commands: [{ kind: "pnpm", args: ["--filter", "@remote-skills/client", "run", "check"] }],
  },
  python: {
    owners: ["@remote-skills/python-workspace"],
    commands: [
      { kind: "pnpm", args: ["--filter", "@remote-skills/python-workspace", "run", "check"] },
    ],
  },
  protocol: {
    owners: ["test:protocol", "determinism"],
    commands: [
      buildCliCommand,
      { kind: "pnpm", args: ["run", "test:protocol"] },
      { kind: "node", args: ["tests/protocol/tools/run-determinism-gate.ts"] },
    ],
  },
  examples: {
    owners: [
      "@remote-skills/docs",
      "@remote-skills/example-publisher",
      "@remote-skills/example-typescript-consumer",
      "@remote-skills/example-python-consumer",
      "@remote-skills/example-basic-typescript",
      "@remote-skills/example-basic-typescript-agent",
      "@remote-skills/example-basic-typescript-app",
      "@remote-skills/example-basic-python",
      "@remote-skills/example-basic-python-agent",
      "@remote-skills/example-basic-python-app",
    ],
    commands: [
      buildCliCommand,
      { kind: "pnpm", args: ["--filter", "@remote-skills/client", "run", "build"] },
      { kind: "pnpm", args: ["--filter", "@remote-skills/docs", "run", "check"] },
      { kind: "pnpm", args: ["--filter", "@remote-skills/example-publisher", "run", "check"] },
      {
        kind: "pnpm",
        args: ["--filter", "@remote-skills/example-typescript-consumer", "run", "check"],
      },
      {
        kind: "pnpm",
        args: ["--filter", "@remote-skills/example-python-consumer", "run", "check"],
      },
      {
        kind: "pnpm",
        args: ["--filter", "@remote-skills/example-basic-typescript", "run", "check"],
      },
      {
        kind: "pnpm",
        args: ["--filter", "@remote-skills/example-basic-typescript-agent", "run", "check"],
      },
      {
        kind: "pnpm",
        args: ["--filter", "@remote-skills/example-basic-typescript-app", "run", "check"],
      },
      { kind: "pnpm", args: ["--filter", "@remote-skills/example-basic-python", "run", "check"] },
      {
        kind: "pnpm",
        args: ["--filter", "@remote-skills/example-basic-python-agent", "run", "check"],
      },
      {
        kind: "pnpm",
        args: ["--filter", "@remote-skills/example-basic-python-app", "run", "check"],
      },
      { kind: "pnpm", args: ["run", "test:basic-chat"] },
    ],
  },
} as const;

type GroupName = keyof typeof groups;

function isGroupName(value: string | undefined): value is GroupName {
  return value !== undefined && value in groups;
}

const [groupName, ...extraArguments] = process.argv.slice(2);
if (groupName === "--describe" && extraArguments.length === 0) {
  const description = Object.fromEntries(
    Object.entries(groups).map(([name, group]) => [name, group.owners]),
  );
  process.stdout.write(`${JSON.stringify(description)}\n`);
  process.exit(0);
}
if (
  groupName === "--describe-commands" &&
  extraArguments.length === 1 &&
  isGroupName(extraArguments[0])
) {
  const commands = groups[extraArguments[0]].commands.map((entry) =>
    [entry.kind, ...entry.args].join(" "),
  );
  process.stdout.write(`${JSON.stringify(commands)}\n`);
  process.exit(0);
}
if (!isGroupName(groupName) || extraArguments.length > 0) {
  throw new Error(`usage: run-ci-test-group.ts <${Object.keys(groups).join(" | ")}>`);
}

for (const entry of groups[groupName].commands) {
  if (entry.kind === "node") {
    const result = spawnSync(process.execPath, entry.args, {
      cwd: repositoryRoot,
      env: process.env,
      shell: false,
      stdio: "inherit",
    });
    if (result.error) throw result.error;
    if (result.status !== 0)
      throw new Error(`CI test command failed: node ${entry.args.join(" ")}`);
    continue;
  }

  const result = spawnPnpmSync(entry.args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: process.env,
  });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  if (result.status !== 0) {
    throw new Error(
      `CI test command failed\n${describeSpawnFailure(createPnpmCommand(entry.args), result)}`,
    );
  }
}

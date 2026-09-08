import { spawn } from "node:child_process";
import { resolve } from "node:path";

interface RunRemoteSkillsOptions {
  cwd?: string;
  env?: Readonly<NodeJS.ProcessEnv>;
  inherit?: boolean;
}

interface ProcessStatus {
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface RemoteSkillsCommandOptions {
  cliEntrypoint?: string;
  nodeExecutable?: string;
}

const exampleRoot = resolve(import.meta.dirname, "../../../examples");
export const remoteSkillsEntrypoint = resolve(
  exampleRoot,
  "publisher/node_modules/@remote-skills/cli/dist/cli.js",
);

export function createRemoteSkillsCommand(
  arguments_: readonly string[],
  {
    cliEntrypoint = remoteSkillsEntrypoint,
    nodeExecutable = process.execPath,
  }: RemoteSkillsCommandOptions = {},
) {
  return { command: nodeExecutable, args: [cliEntrypoint, ...arguments_] };
}

export async function runRemoteSkills(
  arguments_: readonly string[],
  { cwd, env, inherit = false }: RunRemoteSkillsOptions = {},
) {
  const launch = createRemoteSkillsCommand(arguments_);
  const child = spawn(launch.command, launch.args, {
    cwd: cwd ?? exampleRoot,
    env: { ...process.env, ...env, NO_COLOR: "1" },
    stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    shell: false,
  });
  let stdout = "";
  let stderr = "";
  if (child.stdout !== null && child.stderr !== null) {
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
  }
  const status = await new Promise<ProcessStatus>((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("close", (code, signal) => resolveExit({ code, signal }));
  });
  if (status.code !== 0) {
    throw new Error(
      `remote-skills ${arguments_.join(" ")} failed (${status.signal ?? status.code})\n${stdout}${stderr}`,
    );
  }
  return { stdout, stderr };
}

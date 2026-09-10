import {
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
  spawnSync,
} from "node:child_process";

export interface ProcessLaunch {
  command: string;
  args: string[];
}

export interface PnpmCommandOptions {
  nodeExecutable?: string;
  pnpmEntrypoint?: string;
}

export interface SpawnFailureResult {
  error?: Error & { code?: unknown };
  status: number | null;
  stdout: string | Buffer | null | undefined;
  stderr: string | Buffer | null | undefined;
}

export function createPnpmCommand(
  args: readonly string[],
  {
    nodeExecutable = process.execPath,
    pnpmEntrypoint = process.env.npm_execpath,
  }: PnpmCommandOptions = {},
): ProcessLaunch {
  if (typeof pnpmEntrypoint !== "string" || pnpmEntrypoint.length === 0) {
    throw new Error("locked pnpm JavaScript entrypoint is unavailable");
  }
  return { command: nodeExecutable, args: [pnpmEntrypoint, ...args] };
}

function output(value: unknown): string {
  const rendered = String(value ?? "").trimEnd();
  return rendered.length === 0 ? "<empty>" : rendered;
}

export function describeSpawnFailure(launch: ProcessLaunch, result: SpawnFailureResult): string {
  const command = [launch.command, ...launch.args].map((value) => JSON.stringify(value)).join(" ");
  const error = result.error
    ? `${result.error.code ?? result.error.name}: ${result.error.message}`
    : "<none>";
  return [
    `command: ${command}`,
    `error: ${error}`,
    `status: ${String(result.status)}`,
    `stdout: ${output(result.stdout)}`,
    `stderr: ${output(result.stderr)}`,
  ].join("\n");
}

export function spawnPnpmSync(
  args: readonly string[],
  options: SpawnSyncOptionsWithStringEncoding,
  commandOptions: PnpmCommandOptions = {},
): SpawnSyncReturns<string> {
  const launch = createPnpmCommand(args, commandOptions);
  const result = spawnSync(launch.command, launch.args, { ...options, shell: false });
  if (result.error) {
    throw new Error(
      `locked pnpm command failed to launch\n${describeSpawnFailure(launch, result)}`,
      {
        cause: result.error,
      },
    );
  }
  return result;
}

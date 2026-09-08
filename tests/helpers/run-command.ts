import type { SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

export function runCommand(
  command: string,
  args: readonly string[],
  options: SpawnSyncOptionsWithStringEncoding = { encoding: "utf8" },
) {
  return spawnSync(command, args, {
    cwd: repositoryRoot,
    ...options,
    encoding: "utf8",
    shell: false,
  });
}

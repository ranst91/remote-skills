import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { createTurboCommand } from "./lib/turbo-command.ts";

const [task, ...args] = process.argv.slice(2);
if (!task) throw new Error("usage: run-turbo.ts <task> [...args]");

const turbo = createTurboCommand(["run", task, `--cache-dir=${resolve(".turbo/cache")}`, ...args]);
const result = spawnSync(turbo.command, turbo.args, {
  encoding: "utf8",
  shell: false,
  stdio: "inherit",
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;

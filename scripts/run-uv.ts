import { spawnSync } from "node:child_process";
import process from "node:process";

import { resolveCompatibleUvCommand } from "./lib/uv-command.ts";

const arguments_ = process.argv.slice(2);
if (arguments_.length === 0) throw new Error("usage: run-uv.ts UV_ARGUMENT...");

const command = resolveCompatibleUvCommand();
const result = spawnSync(command, arguments_, {
  env: process.env,
  shell: false,
  stdio: "inherit",
});
if (result.error) throw result.error;
if (result.status === null) {
  throw new Error(`uv terminated without an exit status (${result.signal ?? "unknown signal"})`);
}
process.exit(result.status);

import { spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { createPnpmCommand, describeSpawnFailure, spawnPnpmSync } from "./lib/pnpm-command.ts";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const [nodeMajorText] = process.versions.node.split(".");
if (nodeMajorText === undefined) throw new Error("unable to determine Node.js major version");
const nodeMajor = Number.parseInt(nodeMajorText, 10);
if (nodeMajor < 24) throw new Error("package artifact checks require Node.js 24 or newer");

const inventory = spawnSync(process.execPath, ["scripts/package-artifact-inputs.ts"], {
  cwd: repositoryRoot,
  encoding: "utf8",
  env: process.env,
});
if (inventory.error) throw inventory.error;
if (inventory.status !== 0) {
  process.stdout.write(inventory.stdout);
  process.stderr.write(inventory.stderr);
  throw new Error("package artifact input inventory failed");
}
const parsedInventory: unknown = JSON.parse(inventory.stdout);
if (
  typeof parsedInventory !== "object" ||
  parsedInventory === null ||
  !("packages" in parsedInventory) ||
  !Array.isArray(parsedInventory.packages) ||
  !("materials" in parsedInventory) ||
  !Array.isArray(parsedInventory.materials)
) {
  throw new Error("package artifact input inventory returned an invalid document");
}
console.log(
  `package-inputs ${parsedInventory.packages.length} packages ${parsedInventory.materials.length} materials`,
);

for (const packageName of [
  "@remote-skills/cli",
  "@remote-skills/client",
  "@remote-skills/python-workspace",
  "@remote-skills/ai-sdk",
]) {
  console.log(`package-check ${packageName}`);
  const args = ["--filter", packageName, "run", "package:check"];
  const result = spawnPnpmSync(args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
      npm_config_offline: "true",
    },
  });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  if (result.status !== 0) {
    throw new Error(
      `package check failed for ${packageName}\n${describeSpawnFailure(createPnpmCommand(args), result)}`,
    );
  }
}

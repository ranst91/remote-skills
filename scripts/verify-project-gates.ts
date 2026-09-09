import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { createTurboCommand } from "./lib/turbo-command.ts";

const expectedProjects = [
  "@remote-skills/docs",
  "@remote-skills/core",
  "@remote-skills/cli",
  "@remote-skills/client",
  "@remote-skills/python-workspace",
  "@remote-skills/example-publisher",
  "@remote-skills/example-typescript-consumer",
  "@remote-skills/example-python-consumer",
  "@remote-skills/example-basic-typescript",
  "@remote-skills/example-basic-typescript-agent",
  "@remote-skills/example-basic-typescript-app",
  "@remote-skills/example-basic-python",
  "@remote-skills/example-basic-python-agent",
  "@remote-skills/example-basic-python-app",
];

const turbo = createTurboCommand([
  "run",
  "check",
  "--dry=json",
  `--cache-dir=${resolve(".turbo/cache")}`,
]);
const result = spawnSync(turbo.command, turbo.args, { encoding: "utf8", shell: false });

if (result.status !== 0) throw new Error(result.stderr || "unable to inspect Turborepo graph");

const graph: unknown = JSON.parse(result.stdout);
if (
  typeof graph !== "object" ||
  graph === null ||
  !("tasks" in graph) ||
  !Array.isArray(graph.tasks)
) {
  throw new Error("Turborepo dry-run returned an invalid task graph");
}
const tasks = new Set(
  graph.tasks.map((task: unknown) => {
    if (typeof task !== "object" || task === null || !("taskId" in task)) {
      throw new Error("Turborepo dry-run returned an invalid task entry");
    }
    const taskId: unknown = task.taskId;
    if (typeof taskId !== "string") throw new Error("Turborepo task ID must be a string");
    return taskId;
  }),
);
const missing = expectedProjects.filter((project) => !tasks.has(`${project}#check`));

if (missing.length > 0) throw new Error(`projects missing check gates: ${missing.join(", ")}`);

console.log(`verified check gates for ${expectedProjects.length} workspace projects`);

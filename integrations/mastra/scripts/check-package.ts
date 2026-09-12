import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnPnpmSync } from "../../../scripts/lib/pnpm-command.ts";
import {
  assertLockedIntegrationResolution,
  writeLockedIntegrationProject,
} from "../../../scripts/release/integration-dependencies.ts";

import { manifestObject, stringField } from "../../../scripts/release/release-lib.ts";

const root = resolve(import.meta.dirname, "../../..");
const work = mkdtempSync(join(tmpdir(), "remote-skills-mastra-package-"));
function pnpm(args: string[], cwd: string) {
  const result = spawnPnpmSync(args, { cwd, encoding: "utf8" });
  if (result.status !== 0)
    throw new Error(`Package command failed: ${result.stdout}\n${result.stderr}`);
}
try {
  for (const name of ["client", "mastra"]) {
    pnpm(["--filter", `@remote-skills/${name}`, "pack:local", "--pack-destination", work], root);
  }
  const archives = readdirSync(work)
    .filter((file) => file.endsWith(".tgz"))
    .map((file) => join(work, file));
  assert.equal(archives.length, 2);
  writeLockedIntegrationProject(root, work, "integrations/mastra");
  pnpm(["add", "--offline", "--ignore-scripts", "--strict-peer-dependencies", ...archives], work);
  assertLockedIntegrationResolution(root, work, archives);
  copyFileSync(
    join(root, "integrations/mastra/tests/installed-consumer.ts"),
    join(work, "check.ts"),
  );
  const result = spawnSync(
    process.execPath,
    [
      "check.ts",
      stringField(
        manifestObject(readFileSync(join(root, "integrations/mastra/package.json"), "utf8")),
        "version",
      ),
    ],
    {
      cwd: work,
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`Installed Mastra check failed: ${result.stdout}\n${result.stderr}`);
  process.stdout.write(result.stdout);
} finally {
  rmSync(work, { recursive: true, force: true });
}

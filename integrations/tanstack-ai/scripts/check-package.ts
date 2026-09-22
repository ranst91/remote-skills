import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnPnpmSync } from "../../../scripts/lib/pnpm-command.ts";
import { checkInstalledIntegration } from "../../../scripts/release/installed-integration.ts";
import { installedNpmSdk } from "../../../scripts/release/sdk-dependencies.ts";

const root = resolve(import.meta.dirname, "../../..");
const work = mkdtempSync(join(tmpdir(), "remote-skills-tanstack-ai-package-"));
try {
  for (const name of ["client", "tanstack-ai"]) {
    const result = spawnPnpmSync(
      ["--filter", `@remote-skills/${name}`, "pack:local", "--pack-destination", work],
      { cwd: root, encoding: "utf8" },
    );
    if (result.error) throw result.error;
    if (result.status !== 0)
      throw new Error(`Local packing failed: ${result.stdout}\n${result.stderr}`);
  }
  const sdk = await installedNpmSdk(root, "@remote-skills/tanstack-ai", join(work, "dependencies"));
  const archives = readdirSync(work)
    .filter((file) => file.endsWith(".tgz"))
    .map((file) =>
      file.startsWith("remote-skills-client-") ? (sdk?.path ?? join(work, file)) : join(work, file),
    );
  assert.equal(archives.length, 2);
  const repeat = join(work, "repeat");
  const repeated = spawnPnpmSync(
    ["--filter", "@remote-skills/tanstack-ai", "pack:local", "--pack-destination", repeat],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(repeated.status, 0, `${repeated.stdout}\n${repeated.stderr}`);
  const name = readdirSync(repeat).find((file) => file.endsWith(".tgz"));
  assert.ok(name);
  assert.deepEqual(
    readFileSync(join(work, name)),
    readFileSync(join(repeat, name)),
    "Repeated isolated packs have identical bytes.",
  );

  console.log(checkInstalledIntegration(archives, root, "integrations/tanstack-ai"));
} finally {
  rmSync(work, { recursive: true, force: true });
}

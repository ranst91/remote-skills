import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { spawnPnpmSync } from "../../../scripts/lib/pnpm-command.ts";
import { checkInstalledIntegration } from "../../../scripts/release/installed-integration.ts";

test("the packed integration installs with its client peer and runs the native skills loader", (t) => {
  const root = resolve(import.meta.dirname, "../../..");
  const directory = mkdtempSync(join(tmpdir(), "ai-sdk-packages-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const name of ["@remote-skills/client", "@remote-skills/ai-sdk"]) {
    const result = spawnPnpmSync(
      ["--silent", "--filter", name, "run", "pack:local", "--", "--pack-destination", directory],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
  const archives = readdirSync(directory).map((file) => join(directory, file));
  assert.equal(archives.length, 2);
  assert.match(
    checkInstalledIntegration(archives, root),
    /native discovery, lazy activation and file read passed/,
  );
});

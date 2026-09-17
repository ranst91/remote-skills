import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { installNpm, packageSource } from "./helpers/package-source.ts";

test("TanStack demo consumes the selected release artifacts in an isolated application", {
  timeout: 120_000,
}, async () => {
  const example = resolve(import.meta.dirname, "../../examples/tanstack-ai");
  const source = await packageSource();
  const root = source ? await mkdtemp(join(tmpdir(), "tanstack-candidate-")) : example;
  try {
    if (source) {
      for (const file of ["agent", "tests", "skills/source", "app.ts", "remote-skills.json"]) {
        await cp(join(example, file), join(root, file), { recursive: true });
      }
      const required = [
        "@remote-skills/cli",
        "@remote-skills/client",
        "@remote-skills/tanstack-ai",
      ];
      const selected = source.npm.filter((entry) => required.includes(entry.name));
      assert.deepEqual(selected.map((entry) => entry.name).sort(), required.sort());
      await installNpm(
        root,
        { npm: selected, python: [] },
        await readFile(join(example, "package.json"), "utf8"),
        "examples/tanstack-ai",
      );
    }
    const result = spawnSync(process.execPath, ["--test", "tests/agent.test.ts"], {
      cwd: root,
      encoding: "utf8",
      timeout: 60_000,
    });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    if (source) await rm(root, { recursive: true, force: true });
  }
});

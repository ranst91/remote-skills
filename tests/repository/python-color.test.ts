import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { resolveCompatibleUvCommand } from "../../scripts/lib/uv-command.ts";
import { freezePythonRequirements } from "../../scripts/release/python-artifacts.ts";

test("Python build constraints contain exact plain pins even when CI forces color", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "remote-skills-python-color-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const environment: NodeJS.ProcessEnv = { ...process.env, UV_CACHE_DIR: join(directory, "cache") };
  // The local shell may set NO_COLOR, while GitHub CI sets FORCE_COLOR=0.
  // uv treats either nonempty FORCE_COLOR value as enabling color.
  delete environment.NO_COLOR;
  const uv = resolveCompatibleUvCommand({ environment });
  const sourcePython =
    environment.REMOTE_SKILLS_PYTHON ??
    resolve(".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  const venv = join(directory, "venv");
  const created = spawnSync(
    uv,
    ["venv", "--python", sourcePython, "--offline", "--no-python-downloads", "--no-config", venv],
    { env: environment, encoding: "utf8" },
  );
  assert.equal(created.status, 0, created.stderr);
  const python = join(venv, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  const location = spawnSync(
    python,
    ["-I", "-c", "import sysconfig; print(sysconfig.get_path('purelib'))"],
    {
      env: environment,
      encoding: "utf8",
    },
  );
  assert.equal(location.status, 0, location.stderr);
  const metadata = join(location.stdout.trim(), "color_fixture-1.2.3.dist-info");
  mkdirSync(metadata);
  writeFileSync(
    join(metadata, "METADATA"),
    "Metadata-Version: 2.1\nName: color-fixture\nVersion: 1.2.3\n",
  );
  for (const color of ["0", "1"]) {
    const pins = freezePythonRequirements(
      python,
      { ...environment, FORCE_COLOR: color },
      directory,
    );
    assert.equal(pins, "color-fixture==1.2.3", `FORCE_COLOR=${color}`);
    const constraints = join(directory, "constraints.txt");
    writeFileSync(constraints, `${pins}\n`);
    const install = spawnSync(
      uv,
      [
        "pip",
        "install",
        "--python",
        python,
        "--offline",
        "--no-index",
        "--no-config",
        "--constraint",
        constraints,
        "color-fixture==1.2.3",
      ],
      { env: environment, encoding: "utf8" },
    );
    assert.equal(install.status, 0, install.stderr);
  }
});

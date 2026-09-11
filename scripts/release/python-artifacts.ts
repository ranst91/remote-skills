import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveCompatibleUvCommand } from "../lib/uv-command.ts";

function run(command: string, args: string[], environment: NodeJS.ProcessEnv, cwd: string) {
  const result = spawnSync(command, args, {
    cwd,
    env: environment,
    encoding: "utf8",
    timeout: 120_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Python artifact command failed: ${result.stderr}`);
  return result.stdout.trim();
}

export function preparePythonArtifactCache(
  root: string,
  directory: string,
  environment: NodeJS.ProcessEnv,
) {
  const uv = resolveCompatibleUvCommand({ environment });
  const python = environment.REMOTE_SKILLS_PYTHON;
  if (!python) throw new Error("REMOTE_SKILLS_PYTHON must select the synced Python interpreter");
  const requirements = join(directory, "locked-runtime.txt");
  const exported = run(
    uv,
    [
      "export",
      "--locked",
      "--package",
      "remote-skills",
      "--no-emit-workspace",
      "--no-header",
      "--no-annotate",
    ],
    environment,
    root,
  );
  writeFileSync(requirements, `${exported}\n`);
  const constraints = join(directory, "runtime-constraints.txt");
  writeFileSync(
    constraints,
    `${run(uv, ["export", "--locked", "--package", "remote-skills", "--no-emit-workspace", "--no-header", "--no-annotate", "--no-hashes"], environment, root)}\n`,
  );
  const venv = join(directory, "prepare-python");
  run(
    uv,
    ["venv", "--python", python, "--no-python-downloads", "--no-config", venv],
    environment,
    root,
  );
  const preparedPython = join(
    venv,
    process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
  );
  // Resolve named, hash-locked requirements, not uv.lock's direct archive URLs. This
  // populates the index metadata needed by a later isolated offline resolution.
  run(
    uv,
    [
      "pip",
      "install",
      "--python",
      preparedPython,
      "--require-hashes",
      "--no-config",
      "-r",
      requirements,
    ],
    environment,
    root,
  );
  const buildRequirements: unknown = JSON.parse(
    run(
      python,
      [
        "-I",
        "-c",
        'import json,tomllib; print(json.dumps(tomllib.load(open("packages/sdk-python/pyproject.toml", "rb"))["build-system"]["requires"]))',
      ],
      environment,
      root,
    ),
  );
  if (
    !Array.isArray(buildRequirements) ||
    !buildRequirements.every((item): item is string => typeof item === "string")
  )
    throw new Error("Invalid Python build requirements");
  run(
    uv,
    ["pip", "install", "--python", preparedPython, "--no-config", ...buildRequirements],
    environment,
    root,
  );
  return constraints;
}

export function installPythonArtifact(
  distribution: string,
  python: string,
  constraints: string,
  environment: NodeJS.ProcessEnv,
  cwd: string,
) {
  run(
    resolveCompatibleUvCommand({ environment }),
    [
      "pip",
      "install",
      "--python",
      python,
      "--offline",
      "--no-python-downloads",
      "--no-config",
      "--constraint",
      constraints,
      distribution,
    ],
    environment,
    cwd,
  );
}

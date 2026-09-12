import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { resolveCompatibleUvCommand } from "../lib/uv-command.ts";
import { pythonPackages } from "./release-scopes.ts";

function run(command: string, args: string[], environment: NodeJS.ProcessEnv, cwd: string) {
  const result = spawnSync(command, args, {
    cwd,
    env: environment,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Python artifact command failed: ${result.stderr}`);
  return result.stdout.trim();
}

export function inspectionPython(constraints: string) {
  return join(
    dirname(constraints),
    "inspection-python",
    process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
  );
}

export function freezePythonRequirements(
  python: string,
  environment: NodeJS.ProcessEnv,
  cwd: string,
) {
  return run(
    resolveCompatibleUvCommand({ environment }),
    // stdout becomes a requirements file; FORCE_COLOR=0 still enables uv color.
    ["pip", "freeze", "--python", python, "--no-config", "--color", "never"],
    environment,
    cwd,
  );
}

export function preparePythonInspector(
  root: string,
  directory: string,
  environment: NodeJS.ProcessEnv,
) {
  const uv = resolveCompatibleUvCommand({ environment });
  const python = environment.REMOTE_SKILLS_PYTHON;
  if (!python) throw new Error("REMOTE_SKILLS_PYTHON must select the synced Python interpreter");
  const inspector = inspectionPython(join(directory, "runtime-constraints.txt"));
  run(
    uv,
    [
      "venv",
      "--python",
      python,
      "--no-python-downloads",
      "--no-config",
      join(directory, "inspection-python"),
    ],
    environment,
    root,
  );
  run(
    uv,
    [
      "pip",
      "install",
      "--python",
      inspector,
      "--no-config",
      "--require-hashes",
      "--only-binary=:all:",
      "--requirement",
      join(import.meta.dirname, "python-inspection-requirements.txt"),
    ],
    environment,
    root,
  );
  return inspector;
}

export function preparePythonArtifactCache(
  root: string,
  directory: string,
  environment: NodeJS.ProcessEnv,
  packages: readonly { name: string; manifest: string; example?: string }[] = pythonPackages,
) {
  const uv = resolveCompatibleUvCommand({ environment });
  const python = environment.REMOTE_SKILLS_PYTHON;
  if (!python) throw new Error("REMOTE_SKILLS_PYTHON must select the synced Python interpreter");
  if (!packages.length || new Set(packages.map((entry) => entry.name)).size !== packages.length)
    throw new Error("Python artifact descriptors must be nonempty and unique");
  const inspector = preparePythonInspector(root, directory, environment);
  const projects: unknown = JSON.parse(
    run(
      inspector,
      [
        "-I",
        "-c",
        `import json,sys,tomllib
from packaging.requirements import Requirement
from packaging.utils import canonicalize_name
entries = json.loads(sys.argv[1])
projects = [tomllib.load(open(entry["manifest"], "rb")) for entry in entries]
versions = {canonicalize_name(p["project"]["name"]): p["project"]["version"] for p in projects}
build = set()
for entry, project in zip(entries, projects):
    metadata = project["project"]
    if metadata["name"] != entry["name"]:
        raise RuntimeError("Python artifact descriptor identity differs from project")
    internal = []
    for value in metadata.get("dependencies", []):
        requirement = Requirement(value)
        if requirement.url:
            raise RuntimeError("Python artifact dependencies must be registry requirements")
        name = canonicalize_name(requirement.name)
        if name in versions:
            if requirement.marker or requirement.extras or not requirement.specifier.contains(versions[name], prereleases=True):
                raise RuntimeError("Python artifact dependency is incompatible with candidate " + name)
            internal.append(name)
    if metadata["name"] == "remote-skills-langchain" and internal.count("remote-skills") != 1:
        raise RuntimeError("Python integration must declare exactly one candidate SDK dependency")
    for value in project["build-system"]["requires"]:
        requirement = Requirement(value)
        if requirement.url:
            raise RuntimeError("Python build dependencies must be registry requirements")
        build.add(value)
print(json.dumps({"versions": versions, "build": sorted(build)}))`,
        JSON.stringify(
          packages.map((entry) => ({ ...entry, manifest: resolve(root, entry.manifest) })),
        ),
      ],
      environment,
      root,
    ),
  );
  if (typeof projects !== "object" || projects === null) throw new Error("Invalid Python projects");
  const versions: unknown = Reflect.get(projects, "versions");
  const buildRequirements: unknown = Reflect.get(projects, "build");
  if (
    typeof versions !== "object" ||
    versions === null ||
    Array.isArray(versions) ||
    !Object.values(versions).every((value) => typeof value === "string") ||
    !Array.isArray(buildRequirements) ||
    !buildRequirements.every((item): item is string => typeof item === "string")
  )
    throw new Error("Invalid Python project dependencies");
  const exportArguments = [
    "export",
    "--locked",
    ...packages.flatMap((entry) => [
      "--package",
      entry.name,
      ...(entry.example ? ["--package", entry.example] : []),
    ]),
    "--no-emit-workspace",
    "--no-header",
    "--no-annotate",
    "--no-default-groups",
  ];
  const requirements = join(directory, "locked-runtime.txt");
  const exported = run(uv, exportArguments, environment, root);
  writeFileSync(requirements, `${exported}\n`);
  const constraints = join(directory, "runtime-constraints.txt");
  const lockedRuntime = run(uv, [...exportArguments, "--no-hashes"], environment, root);
  // Exported constraints must remain named, exact registry pins. Local archives
  // enter the consumer only through installPythonArtifact's explicit arguments.
  run(
    inspector,
    [
      "-I",
      "-c",
      `import sys
from packaging.requirements import Requirement
for line in sys.argv[1].splitlines():
    if not line.strip():
        continue
    requirement = Requirement(line)
    if requirement.url or requirement.extras or len(requirement.specifier) != 1:
        raise RuntimeError("Invalid locked Python runtime requirement")
    pin = next(iter(requirement.specifier))
    if pin.operator != "==" or "*" in pin.version:
        raise RuntimeError("Python runtime dependencies must be exactly locked")`,
      lockedRuntime,
    ],
    environment,
    root,
  );
  writeFileSync(
    constraints,
    `${lockedRuntime}\n${Object.entries(versions)
      .map(([name, version]) => `${name}==${version}`)
      .join("\n")}\n`,
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
  run(
    uv,
    [
      "pip",
      "install",
      "--python",
      preparedPython,
      "--no-config",
      "--constraint",
      constraints,
      ...buildRequirements,
    ],
    environment,
    root,
  );
  // Readiness also installs on the minimum supported Python. Cache its platform
  // wheels explicitly when the synced workspace uses a newer interpreter.
  const currentMinor = run(
    python,
    ["-I", "-c", "import sys; print('.'.join(map(str,sys.version_info[:2])))"],
    environment,
    root,
  );
  if (currentMinor !== "3.11") {
    const minimum = join(directory, "prepare-python-minimum");
    run(
      uv,
      ["venv", "--python", "3.11", "--no-python-downloads", "--no-config", minimum],
      environment,
      root,
    );
    run(
      uv,
      [
        "pip",
        "install",
        "--python",
        join(minimum, process.platform === "win32" ? "Scripts/python.exe" : "bin/python"),
        "--require-hashes",
        "--no-config",
        "-r",
        requirements,
      ],
      environment,
      root,
    );
  }
  // Record the actual isolated build dependency versions too. A later sdist
  // installation cannot resolve a different cached backend or build dependency.
  const preparedPins = freezePythonRequirements(preparedPython, environment, root);
  const canonicalName = (name: string) => name.toLowerCase().replaceAll(/[-_.]+/gu, "-");
  const runtimeNames = new Set(
    lockedRuntime.split("\n").map((line) => canonicalName(line.split("==")[0] ?? "")),
  );
  const buildPins = preparedPins
    .split("\n")
    .filter((line) => !runtimeNames.has(canonicalName(line.split("==")[0] ?? "")));
  writeFileSync(
    constraints,
    `${lockedRuntime}\n${Object.entries(versions)
      .map(([name, version]) => `${name}==${version}`)
      .join("\n")}\n${buildPins.join("\n")}\n`,
  );
  return constraints;
}

export function installPythonArtifact(
  distribution: string | readonly string[],
  python: string,
  constraints: string,
  environment: NodeJS.ProcessEnv,
  cwd: string,
) {
  const distributions = typeof distribution === "string" ? [distribution] : distribution;
  if (!distributions.length) throw new Error("At least one local Python artifact is required");
  for (const artifact of distributions) {
    if (!artifact.endsWith(".whl") && !artifact.endsWith(".tar.gz"))
      throw new Error("Python artifact installs require explicit wheel or sdist files");
  }
  const isolated = { ...environment };
  for (const name of ["PYTHONPATH", "PYTHONHOME", "VIRTUAL_ENV", "UV_PROJECT_ENVIRONMENT"])
    delete isolated[name];
  run(
    resolveCompatibleUvCommand({ environment: isolated }),
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
      "--build-constraint",
      constraints,
      ...distributions.map((artifact) => resolve(cwd, artifact)),
    ],
    isolated,
    cwd,
  );
  run(
    resolveCompatibleUvCommand({ environment: isolated }),
    ["pip", "check", "--python", python, "--offline", "--no-config"],
    isolated,
    cwd,
  );
}

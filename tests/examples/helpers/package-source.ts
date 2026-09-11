import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createPnpmCommand } from "../../../scripts/lib/pnpm-command.ts";

export interface PackageSelection {
  name: string;
  version: string;
  spec: string;
}
export interface PackageSource {
  npm: PackageSelection[];
  python: { version: string; spec: string };
}
const names = ["@remote-skills/cli", "@remote-skills/client", "@remote-skills/ai-sdk"];

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function packageSource(): Promise<PackageSource | undefined> {
  const manifest = process.env.REMOTE_SKILLS_E2E_PACKAGES;
  if (!manifest) return undefined;
  assert.ok(isAbsolute(manifest), "Package-source manifest must be an absolute path.");
  const source: unknown = JSON.parse(await readFile(manifest, "utf8"));
  assert.ok(object(source) && Array.isArray(source.npm) && object(source.python));
  const npm = source.npm.map((entry: unknown): PackageSelection => {
    assert.ok(object(entry));
    assert.equal(typeof entry.name, "string");
    assert.equal(typeof entry.version, "string");
    assert.equal(typeof entry.spec, "string");
    const { name, version, spec } = entry;
    assert.ok(typeof name === "string" && typeof version === "string" && typeof spec === "string");
    assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u);
    assert.ok((isAbsolute(spec) && spec.endsWith(".tgz")) || spec === `${name}@${version}`);
    return { name, version, spec };
  });
  assert.deepEqual(npm.map((entry) => entry.name).sort(), [...names].sort());
  const { version, spec } = source.python;
  assert.ok(typeof version === "string" && typeof spec === "string");
  assert.match(version, /^\d+\.\d+\.\d+(?:(?:a|b|rc)\d+)?$/u);
  assert.ok((isAbsolute(spec) && spec.endsWith(".whl")) || spec === `remote-skills==${version}`);
  return { npm, python: { version, spec } };
}

export async function installCommand(command: string, args: string[], cwd: string) {
  const env = { ...process.env, CI: "true", PYTHONNOUSERSITE: "1" };
  for (const key of [
    "NODE_PATH",
    "NODE_OPTIONS",
    "PYTHONPATH",
    "VIRTUAL_ENV",
    "UV_PROJECT_ENVIRONMENT",
  ]) {
    Reflect.deleteProperty(env, key);
  }
  const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  const code = await new Promise<number | null>((done, reject) => {
    child.once("error", reject);
    child.once("close", done);
  });
  assert.equal(code, 0, `Isolated package installation/check failed.\n${output}`);
  return output;
}

export async function installNpm(root: string, source: PackageSource, exampleManifest?: string) {
  const parsedManifest: unknown = JSON.parse(exampleManifest ?? '{"type":"module"}');
  const manifest = parsedManifest;
  assert.ok(object(manifest));
  const dependencies = object(manifest.dependencies) ? { ...manifest.dependencies } : {};
  for (const entry of source.npm)
    dependencies[entry.name] = isAbsolute(entry.spec) ? entry.spec : entry.version;
  if (object(manifest.devDependencies)) {
    const repositoryManifest: unknown = JSON.parse(
      await readFile(resolve(import.meta.dirname, "../../../package.json"), "utf8"),
    );
    assert.ok(object(repositoryManifest) && object(repositoryManifest.devDependencies));
    const development = { ...manifest.devDependencies };
    for (const [name, version] of Object.entries(development)) {
      if (version === "catalog:") {
        const pinned: unknown = repositoryManifest.devDependencies[name];
        assert.equal(typeof pinned, "string", `Missing pinned development dependency ${name}`);
        development[name] = pinned;
      }
    }
    manifest.devDependencies = development;
  }
  await mkdir(root, { recursive: true });
  await writeFile(
    resolve(root, "package.json"),
    JSON.stringify({ ...manifest, private: true, dependencies }),
  );
  const launch = createPnpmCommand([
    "install",
    "--ignore-workspace",
    "--no-frozen-lockfile",
    "--config.link-workspace-packages=false",
  ]);
  await installCommand(launch.command, launch.args, root);
  await assertInstalledNpm(root, source);
}

export async function assertInstalledNpm(root: string, source: PackageSource) {
  const modules = await realpath(resolve(root, "node_modules"));
  for (const entry of source.npm) {
    const packageRoot = await realpath(resolve(root, "node_modules", entry.name));
    const installed: unknown = JSON.parse(
      await readFile(resolve(packageRoot, "package.json"), "utf8"),
    );
    assert.ok(object(installed));
    assert.equal(installed.version, entry.version, `${entry.name} exact version`);
    const path = relative(modules, packageRoot);
    assert.ok(
      path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path),
      `${entry.name} must be installed locally`,
    );
    if (entry.name !== "@remote-skills/cli") {
      const resolved = await realpath(
        fileURLToPath(
          (
            await installCommand(
              process.execPath,
              [
                "--input-type=module",
                "-e",
                "console.log(import.meta.resolve(process.argv[1]))",
                entry.name,
              ],
              root,
            )
          ).trim(),
        ),
      );
      assert.ok(
        resolved.startsWith(`${packageRoot}${sep}`),
        `${entry.name} resolution cannot use the workspace`,
      );
    }
    process.stderr.write(`Verified ${entry.name}@${entry.version} at ${packageRoot}\n`);
  }
}

export async function installPython(root: string, source: PackageSource) {
  const venv = resolve(root, ".venv");
  await installCommand("uv", ["venv", "--no-project", "--no-config", venv], root);
  const python = resolve(venv, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  await installCommand(
    "uv",
    ["pip", "install", "--no-config", "--python", python, source.python.spec],
    root,
  );
  const installedPath = await installCommand(
    python,
    [
      "-I",
      "-c",
      'import importlib.metadata, pathlib, remote_skills, sys; assert importlib.metadata.version("remote-skills") == sys.argv[1]; p = pathlib.Path(remote_skills.__file__).resolve(); assert p.is_relative_to(pathlib.Path(sys.prefix).resolve()); print(p)',
      source.python.version,
    ],
    root,
  );
  process.stderr.write(
    `Verified remote-skills==${source.python.version} at ${installedPath.trim()}\n`,
  );
  return python;
}

export async function copyConsumer(root: string, repository: string) {
  const target = resolve(root, "consumer.ts");
  await copyFile(resolve(repository, "examples/consumers/typescript/src/index.ts"), target);
  return target;
}

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createPnpmCommand } from "../../../scripts/lib/pnpm-command.ts";
import { resolveCompatibleUvCommand } from "../../../scripts/lib/uv-command.ts";
import { releasePackages } from "../../../scripts/release/release-scopes.ts";

export interface PackageSelection {
  name: string;
  version: string;
  spec: string;
}
export interface PackageSource {
  npm: PackageSelection[];
  python: { version: string; spec: string } | PackageSelection[];
}
const names: readonly string[] = releasePackages.map((entry) => entry.name);
const requiredNpm = ["@remote-skills/cli", "@remote-skills/client", "@remote-skills/ai-sdk"];

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function pythonSelections(source: PackageSource): PackageSelection[] {
  return Array.isArray(source.python)
    ? source.python
    : [{ name: "remote-skills", ...source.python }];
}

function pythonSelection(value: unknown): PackageSelection {
  assert.ok(object(value));
  const { name, version, spec } = value;
  assert.ok(typeof name === "string" && typeof version === "string" && typeof spec === "string");
  assert.match(name, /^remote-skills(?:-[a-z0-9]+)*$/u);
  assert.match(version, /^\d+\.\d+\.\d+(?:(?:a|b|rc)\d+)?$/u);
  assert.ok((isAbsolute(spec) && spec.endsWith(".whl")) || spec === `${name}==${version}`);
  return { name, version, spec };
}

export async function packageSource(
  manifest = process.env.REMOTE_SKILLS_E2E_PACKAGES,
): Promise<PackageSource | undefined> {
  if (!manifest) return undefined;
  assert.ok(isAbsolute(manifest), "Package-source manifest must be an absolute path.");
  const source: unknown = JSON.parse(await readFile(manifest, "utf8"));
  assert.ok(object(source) && Array.isArray(source.npm));
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
  const selectedNpm = new Set(npm.map((entry) => entry.name));
  assert.equal(selectedNpm.size, npm.length, "npm package selections must be unique.");
  assert.ok(
    requiredNpm.every((name) => selectedNpm.has(name)),
    "Core npm selections are required.",
  );
  assert.ok(
    npm.every((entry) => names.includes(entry.name)),
    "Unsupported npm package selection.",
  );
  if (Array.isArray(source.python)) {
    const python = source.python.map(pythonSelection);
    const selected = new Set(python.map((entry) => entry.name));
    assert.equal(selected.size, python.length, "Python package selections must be unique.");
    assert.ok(selected.has("remote-skills"), "The Python SDK must be selected explicitly.");
    return { npm, python };
  }
  assert.ok(object(source.python) && !Object.hasOwn(source.python, "name"));
  const { version, spec } = pythonSelection({ name: "remote-skills", ...source.python });
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
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const code = await new Promise<number | null>((done, reject) => {
    child.once("error", reject);
    child.once("close", done);
  });
  assert.equal(code, 0, `Isolated package installation/check failed.\n${stdout}${stderr}`);
  return stdout;
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
    JSON.stringify({
      ...manifest,
      private: true,
      dependencies,
      pnpm: {
        ...(object(manifest.pnpm) ? manifest.pnpm : {}),
        overrides: {
          ...(object(manifest.pnpm) && object(manifest.pnpm.overrides)
            ? manifest.pnpm.overrides
            : {}),
          ...Object.fromEntries(
            source.npm.map((entry) => [
              entry.name,
              isAbsolute(entry.spec) ? entry.spec : entry.version,
            ]),
          ),
        },
      },
    }),
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

async function npmEntry(root: string, name: string) {
  return realpath(
    fileURLToPath(
      (
        await installCommand(
          process.execPath,
          ["--input-type=module", "-e", "console.log(import.meta.resolve(process.argv[1]))", name],
          root,
        )
      ).trim(),
    ),
  );
}

export async function assertInstalledNpm(root: string, source: PackageSource) {
  const modules = await realpath(resolve(root, "node_modules"));
  for (const entry of source.npm) {
    const packageRoot = await realpath(resolve(root, "node_modules", entry.name));
    const installed: unknown = JSON.parse(
      await readFile(resolve(packageRoot, "package.json"), "utf8"),
    );
    assert.ok(object(installed));
    assert.equal(installed.name, entry.name, "The installed package retains its selected name.");
    assert.equal(installed.version, entry.version, `${entry.name} exact version`);
    const path = relative(modules, packageRoot);
    assert.ok(
      path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path),
      `${entry.name} must be installed locally`,
    );
    if (isAbsolute(entry.spec)) {
      const integrity = `sha512-${createHash("sha512")
        .update(await readFile(entry.spec))
        .digest("base64")}`;
      const lock = await readFile(resolve(modules, ".pnpm/lock.yaml"), "utf8");
      assert.ok(
        lock.split(/\n(?= {2}\S)/u).some((block) => {
          const heading = block.split("\n", 1)[0] ?? "";
          return (
            heading.includes(`${entry.name}@file:`) && block.includes(`integrity: ${integrity}`)
          );
        }),
        `${entry.name} lock provenance must identify the exact candidate archive bytes`,
      );
    }
    if (entry.name !== "@remote-skills/cli") {
      const resolved = await npmEntry(root, entry.name);
      assert.ok(
        resolved.startsWith(`${packageRoot}${sep}`),
        `${entry.name} resolution cannot use the workspace`,
      );
      if (entry.name !== "@remote-skills/client") {
        assert.equal(
          await npmEntry(packageRoot, "@remote-skills/client"),
          await npmEntry(root, "@remote-skills/client"),
          `${entry.name} must resolve the separately selected SDK candidate`,
        );
      }
    }
    process.stderr.write(`Verified ${entry.name}@${entry.version} at ${packageRoot}\n`);
  }
}

export async function installPython(
  root: string,
  source: PackageSource,
  options: { requirementsFile?: string } = {},
) {
  const selections = pythonSelections(source);
  const uv = resolveCompatibleUvCommand();
  const venv = resolve(root, ".venv");
  await installCommand(uv, ["venv", "--no-project", "--no-config", venv], root);
  const python = resolve(venv, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  await installCommand(
    uv,
    [
      "pip",
      "install",
      "--no-config",
      "--python",
      python,
      ...(options.requirementsFile ? ["--requirement", options.requirementsFile] : []),
      ...selections.map((entry) => entry.spec),
    ],
    root,
  );
  await assertInstalledPython(root, python, source);
  return python;
}

export async function assertInstalledPython(root: string, python: string, source: PackageSource) {
  for (const entry of pythonSelections(source)) {
    const archive = isAbsolute(entry.spec) ? entry.spec : "";
    const digest = archive
      ? createHash("sha256")
          .update(await readFile(archive))
          .digest("hex")
      : "";
    const installedPath = await installCommand(
      python,
      [
        "-I",
        "-c",
        [
          "import importlib, importlib.metadata, json, pathlib, sys",
          "name, version, archive, digest = sys.argv[1:]",
          "distribution = importlib.metadata.distribution(name)",
          'assert distribution.version == version, "Selected Python version differs"',
          'module = importlib.import_module(name.replace("-", "_"))',
          "path = pathlib.Path(module.__file__).resolve()",
          'assert path.is_relative_to(pathlib.Path(sys.prefix).resolve()), "Python import escaped isolated environment"',
          "if archive:",
          '    direct = json.loads(distribution.read_text("direct_url.json") or "{}")',
          '    assert direct.get("url") == pathlib.Path(archive).resolve().as_uri(), "Python archive provenance differs"',
          '    assert direct.get("archive_info", {}).get("hashes", {}).get("sha256") == digest, "Python archive bytes differ"',
          "print(path)",
        ].join("\n"),
        entry.name,
        entry.version,
        archive,
        digest,
      ],
      root,
    );
    process.stderr.write(`Verified ${entry.name}==${entry.version} at ${installedPath.trim()}\n`);
  }
}

export async function copyConsumer(root: string, repository: string) {
  const target = resolve(root, "consumer.ts");
  await copyFile(resolve(repository, "examples/consumers/typescript/src/index.ts"), target);
  return target;
}

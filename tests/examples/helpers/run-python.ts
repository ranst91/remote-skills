import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  parseUvCacheDirectory,
  uvCacheDirectoryArguments,
  uvCacheQueryEnvironment,
} from "./uv-cache.ts";

interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  inherit?: boolean;
  baseEnvironment?: NodeJS.ProcessEnv;
}

interface ProcessStatus {
  code: number | null;
  signal: NodeJS.Signals | null;
}

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const packageRoot = resolve(repositoryRoot, "packages/sdk-python");
const basePython =
  process.env.REMOTE_SKILLS_PYTHON ??
  resolve(
    repositoryRoot,
    process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python",
  );
const blockedEnvironment = new Set([
  ["PYTHON", "PATH"].join(""),
  "UV_PROJECT_ENVIRONMENT",
  "VIRTUAL_ENV",
]);
const cleanEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !blockedEnvironment.has(name)),
);

async function run(
  command: string,
  arguments_: readonly string[],
  { cwd, env = {}, inherit = false, baseEnvironment = cleanEnvironment }: RunOptions = {},
) {
  const child = spawn(command, arguments_, {
    cwd: cwd ?? import.meta.dirname,
    env: { ...baseEnvironment, ...env },
    stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  if (child.stdout !== null && child.stderr !== null) {
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
  }
  const status = await new Promise<ProcessStatus>((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("close", (code, signal) => resolveExit({ code, signal }));
  });
  if (status.code !== 0) {
    throw new Error(`${command} failed (${status.signal ?? status.code})\n${stdout}${stderr}`);
  }
  return stdout;
}

const work = await mkdtemp(resolve(tmpdir(), "remote-skills-python-example-"));
try {
  const uvToolEnvironment = uvCacheQueryEnvironment(cleanEnvironment);
  const sharedCache = parseUvCacheDirectory(
    await run("uv", uvCacheDirectoryArguments, {
      cwd: work,
      baseEnvironment: uvToolEnvironment,
    }),
  );
  const distributions = resolve(work, "dist");
  const buildEnvironment = {
    UV_CACHE_DIR: sharedCache,
    UV_DEFAULT_INDEX: "http://127.0.0.1:9/simple",
    UV_OFFLINE: "true",
    UV_PYTHON_DOWNLOADS: "never",
  };
  await run(
    "uv",
    [
      "build",
      "--wheel",
      "--offline",
      "--no-index",
      "--no-python-downloads",
      "--no-config",
      "--no-create-gitignore",
      "--out-dir",
      distributions,
      packageRoot,
    ],
    { cwd: packageRoot, env: buildEnvironment },
  );
  const wheelName = "remote_skills-0.0.1-py3-none-any.whl";
  const built = await readdir(distributions);
  if (built.length !== 1 || built[0] !== wheelName) {
    throw new Error("local Python build did not produce the expected single wheel");
  }
  const virtualEnvironment = resolve(work, ".venv");
  const installEnvironment = {
    PYTHONNOUSERSITE: "1",
    UV_CACHE_DIR: sharedCache,
    UV_OFFLINE: "true",
    UV_PYTHON_DOWNLOADS: "never",
  };
  const baseSitePackages = (
    await run(basePython, ["-I", "-c", 'import sysconfig; print(sysconfig.get_path("purelib"))'], {
      cwd: work,
      env: { PYTHONNOUSERSITE: "1" },
    })
  ).trim();
  await run(
    "uv",
    [
      "venv",
      "--python",
      basePython,
      "--offline",
      "--no-python-downloads",
      "--no-config",
      virtualEnvironment,
    ],
    { cwd: work, env: installEnvironment },
  );
  const installedPython = resolve(
    virtualEnvironment,
    process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
  );
  const installedSitePackages = (
    await run(
      installedPython,
      ["-I", "-c", 'import sysconfig; print(sysconfig.get_path("purelib"))'],
      { cwd: work, env: { PYTHONNOUSERSITE: "1" } },
    )
  ).trim();
  const acceptedEnvironment = Buffer.from(baseSitePackages, "utf8").toString("base64");
  await writeFile(
    resolve(installedSitePackages, "accepted-project-environment.pth"),
    `import sys;sys.path.append(__import__("base64").b64decode("${acceptedEnvironment}").decode())\n`,
    "ascii",
  );
  await run(
    "uv",
    [
      "pip",
      "install",
      "--python",
      installedPython,
      "--offline",
      "--no-index",
      "--no-deps",
      "--no-config",
      resolve(distributions, wheelName),
    ],
    { cwd: work, env: installEnvironment },
  );
  await run(installedPython, ["-I", ...process.argv.slice(2)], {
    cwd: process.cwd(),
    env: { PYTHONNOUSERSITE: "1" },
    inherit: true,
  });
} finally {
  await rm(work, { recursive: true, force: true });
}

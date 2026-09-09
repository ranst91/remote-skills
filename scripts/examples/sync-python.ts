import { spawnSync } from "node:child_process";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

interface SyncPythonOptions {
  cwd: string;
  executable?: string;
  required: boolean;
}

interface UvAvailabilityOptions {
  cwd: string;
  executable?: string;
}

function environmentVariable(name: string): string | undefined {
  const value: unknown = Reflect.get(process.env, name);
  return typeof value === "string" ? value : undefined;
}

function setupEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.OPENAI_API_KEY;
  delete env.OPENAI_MODEL;
  delete env.OPENAI_BASE_URL;
  return env;
}

function isInside(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return path === "" || (!path.startsWith("..") && !path.startsWith("/"));
}

export function syncPython({
  cwd,
  executable = environmentVariable("REMOTE_SKILLS_UV") ?? "uv",
  required,
}: SyncPythonOptions): boolean {
  if (!uvAvailable({ cwd, executable })) {
    if (required) throw new Error("uv is required to install the Python example.");
    return false;
  }

  const sync = spawnSync(executable, ["sync", "--project", ".", "--locked"], {
    cwd,
    encoding: "utf8",
    env: setupEnvironment(),
    shell: false,
    stdio: "inherit",
  });
  if (sync.error || sync.status !== 0) {
    throw new Error("uv sync failed for the Python example.");
  }
  return true;
}

export function uvAvailable({
  cwd,
  executable = environmentVariable("REMOTE_SKILLS_UV") ?? "uv",
}: UvAvailabilityOptions): boolean {
  const version = spawnSync(executable, ["--version"], {
    cwd,
    encoding: "utf8",
    env: setupEnvironment(),
    shell: false,
    stdio: "ignore",
  });
  return !version.error && version.status === 0;
}

function runPostinstall(): void {
  const repositoryRoot = resolve(import.meta.dirname, "../..");
  const pythonRoot = resolve(repositoryRoot, "examples/basic-python");
  const invocationRoot = resolve(environmentVariable("INIT_CWD") ?? process.cwd());

  if (invocationRoot === repositoryRoot) {
    syncPython({ cwd: resolve(pythonRoot, "agent"), required: false });
    return;
  }
  if (isInside(pythonRoot, invocationRoot)) {
    syncPython({ cwd: resolve(pythonRoot, "agent"), required: true });
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  try {
    runPostinstall();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Python setup failed."}\n`);
    process.exitCode = 1;
  }
}

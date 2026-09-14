import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createPnpmCommand } from "../lib/pnpm-command.ts";

export interface ServiceDefinition {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<NodeJS.ProcessEnv>;
  readonly readyUrl: string;
}

interface RunServicesOptions {
  readonly signal: AbortSignal;
  readonly readinessTimeoutMs?: number;
  readonly onStarted?: (name: string, pid: number) => void;
  readonly onReady?: (name: string, pid: number) => void;
}

interface ExampleEnvironment {
  readonly appPort: number;
  readonly skillsPort: number;
}

interface ManagedChild {
  readonly definition: ServiceDefinition;
  readonly process: ChildProcess;
  readonly exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

const CATALOG_PATH = "/.well-known/agent-skills/index.json";
const DEFAULT_READINESS_TIMEOUT_MS = 60_000;
const SHUTDOWN_GRACE_MS = 1_500;

function environmentVariable(name: string): string | undefined {
  const value: unknown = Reflect.get(process.env, name);
  return typeof value === "string" ? value : undefined;
}

function parsePort(env: Readonly<NodeJS.ProcessEnv>, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^[0-9]+$/u.test(raw)) throw new Error(`${name} must be a port between 1 and 65535.`);
  const port = Number(raw);
  if (port < 1 || port > 65_535) {
    throw new Error(`${name} must be a port between 1 and 65535.`);
  }
  return port;
}

export function validateEnvironment(
  env: Readonly<NodeJS.ProcessEnv>,
  defaults: ExampleEnvironment = { appPort: 5_173, skillsPort: 8_787 },
): ExampleEnvironment {
  if (env.REMOTE_SKILLS_EXAMPLE_TEST !== "1" && !env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required.");
  }
  const ports = {
    appPort: parsePort(env, "APP_PORT", defaults.appPort),
    skillsPort: parsePort(env, "SKILLS_PORT", defaults.skillsPort),
  };
  if (new Set(Object.values(ports)).size !== 2) {
    throw new Error("APP_PORT and SKILLS_PORT must be distinct.");
  }
  return ports;
}

function checkPort(port: number): Promise<void> {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.unref();
    server.once("error", () => rejectPort(new Error(`Port ${port} is unavailable.`)));
    server.listen(port, "127.0.0.1", () => {
      server.close((error) =>
        error ? rejectPort(new Error(`Port ${port} is unavailable.`)) : resolvePort(),
      );
    });
  });
}

export async function assertPortsAvailable(ports: readonly number[]): Promise<void> {
  for (const port of ports) await checkPort(port);
}

function startService(definition: ServiceDefinition): ManagedChild {
  const child = spawn(definition.command, [...definition.args], {
    cwd: definition.cwd,
    env: { ...definition.env },
    shell: false,
    stdio: "inherit",
  });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolveExit, rejectExit) => {
      child.once("error", () => rejectExit(new Error(`${definition.name} failed to start.`)));
      child.once("close", (code, signal) => resolveExit({ code, signal }));
    },
  );
  return { definition, process: child, exit };
}

function abortPromise(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolveAbort) =>
    signal.addEventListener("abort", () => resolveAbort(), { once: true }),
  );
}

async function waitForReady(
  child: ManagedChild,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const aborted = abortPromise(signal).then(() => "abort" as const);
  while (Date.now() < deadline) {
    if (signal.aborted) return false;
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(250)]);
    const outcome = await Promise.race([
      child.exit.then(() => "exit" as const),
      aborted,
      fetch(child.definition.readyUrl, { signal: requestSignal })
        .then((response) => (response.ok ? "ready" : "retry"))
        .catch(() => "retry" as const),
    ]);
    if (outcome === "exit") {
      throw new Error(`${child.definition.name} exited before becoming ready.`);
    }
    if (outcome === "abort") return false;
    if (outcome === "ready") return true;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error(`${child.definition.name} did not become ready in time.`);
}

async function stopChild(child: ManagedChild): Promise<void> {
  if (child.process.exitCode !== null || child.process.signalCode !== null) {
    await child.exit.catch(() => undefined);
    return;
  }
  child.process.kill("SIGTERM");
  const exited = await Promise.race([
    child.exit.then(
      () => true,
      () => true,
    ),
    new Promise<false>((resolveGrace) => setTimeout(() => resolveGrace(false), SHUTDOWN_GRACE_MS)),
  ]);
  if (!exited) {
    child.process.kill("SIGKILL");
    await child.exit.catch(() => undefined);
  }
}

export async function runServices(
  definitions: readonly ServiceDefinition[],
  options: RunServicesOptions,
): Promise<void> {
  const children: ManagedChild[] = [];
  try {
    for (const definition of definitions) {
      if (options.signal.aborted) return;
      const child = startService(definition);
      children.push(child);
      if (child.process.pid === undefined) throw new Error(`${definition.name} failed to start.`);
      options.onStarted?.(definition.name, child.process.pid);
      const ready = await waitForReady(
        child,
        options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS,
        options.signal,
      );
      if (!ready) return;
      options.onReady?.(definition.name, child.process.pid);
    }

    await Promise.race([
      abortPromise(options.signal),
      ...children.map((child) =>
        child.exit.then(() => {
          throw new Error(`${child.definition.name} exited unexpectedly.`);
        }),
      ),
    ]);
  } finally {
    await Promise.all(children.map(stopChild));
  }
}

function withoutKeys(
  env: Readonly<NodeJS.ProcessEnv>,
  keys: readonly string[],
  additions: Readonly<NodeJS.ProcessEnv>,
): NodeJS.ProcessEnv {
  const result = { ...env, ...additions };
  for (const key of keys) delete result[key];
  return result;
}

function exampleServices(
  root: string,
  ports: ExampleEnvironment,
  env: Readonly<NodeJS.ProcessEnv>,
  example: "vercel-ai-sdk" | "mastra" = "vercel-ai-sdk",
): ServiceDefinition[] {
  const exampleRoot = resolve(root, `examples/${example}`);
  const skillsOrigin = `http://127.0.0.1:${ports.skillsPort}`;
  const publisherEnv = withoutKeys(
    env,
    ["OPENAI_API_KEY", "OPENAI_MODEL", "OPENAI_BASE_URL", "REMOTE_SKILLS_ORIGIN"],
    {},
  );
  return [
    {
      name: "publisher",
      command: process.execPath,
      args: [
        resolve(exampleRoot, "node_modules/@remote-skills/cli/dist/cli.js"),
        "dev",
        "--host",
        "127.0.0.1",
        "--port",
        String(ports.skillsPort),
      ],
      cwd: resolve(exampleRoot, "skills"),
      env: publisherEnv,
      readyUrl: `${skillsOrigin}${CATALOG_PATH}`,
    },
    {
      name: "browser",
      command: process.execPath,
      args: [
        resolve(exampleRoot, "node_modules/next/dist/bin/next"),
        "dev",
        "--webpack",
        "--hostname",
        "127.0.0.1",
        "--port",
        String(ports.appPort),
      ],
      cwd: exampleRoot,
      env: { ...env, REMOTE_SKILLS_ORIGIN: skillsOrigin },
      readyUrl: `http://127.0.0.1:${ports.appPort}`,
    },
  ];
}

function verifyToolchain(root: string): void {
  if (Number(process.versions.node.split(".")[0]) < 24) {
    throw new Error("Node.js 24 or newer is required.");
  }
  const manifest: unknown = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  if (
    manifest === null ||
    typeof manifest !== "object" ||
    !("packageManager" in manifest) ||
    typeof manifest.packageManager !== "string"
  ) {
    throw new Error("The repository must declare its pinned pnpm version in packageManager.");
  }
  const expected = manifest.packageManager;
  const actual = environmentVariable("npm_config_user_agent")?.split(" ")[0] ?? "";
  if (!process.env.npm_execpath || actual !== expected.replace("@", "/")) {
    throw new Error(`Run this example with ${expected || "the repository's pinned pnpm"}.`);
  }
}

async function runBuild(root: string, signal: AbortSignal): Promise<void> {
  const launch = createPnpmCommand(["ci:build:repository"]);
  const child = spawn(launch.command, launch.args, {
    cwd: root,
    env: withoutKeys(process.env, ["OPENAI_API_KEY", "OPENAI_MODEL", "OPENAI_BASE_URL"], {}),
    shell: false,
    stdio: "inherit",
  });
  let killTimer: NodeJS.Timeout | undefined;
  const stop = () => {
    child.kill("SIGTERM");
    killTimer = setTimeout(() => child.kill("SIGKILL"), SHUTDOWN_GRACE_MS);
  };
  signal.addEventListener("abort", stop, { once: true });
  try {
    const code = await new Promise<number | null>((resolveExit, rejectExit) => {
      child.once("error", () => rejectExit(new Error("Repository build failed to start.")));
      child.once("close", resolveExit);
    });
    if (code !== 0) throw new Error("Repository build failed.");
  } finally {
    if (killTimer) clearTimeout(killTimer);
    signal.removeEventListener("abort", stop);
  }
}

async function main(): Promise<void> {
  const root = resolve(import.meta.dirname, "../..");
  const example = process.argv[2] ?? "vercel-ai-sdk";
  if (example !== "vercel-ai-sdk" && example !== "mastra") throw new Error("Unknown example.");
  const exampleRoot = resolve(root, `examples/${example}`);
  const envFile = resolve(exampleRoot, ".env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  verifyToolchain(root);
  const ports = validateEnvironment(
    process.env,
    example === "mastra" ? { appPort: 5_181, skillsPort: 8_791 } : undefined,
  );
  await assertPortsAvailable([ports.appPort, ports.skillsPort]);

  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    if (!process.env.REMOTE_SKILLS_E2E_PACKAGES) await runBuild(root, controller.signal);
    const services = exampleServices(root, ports, process.env, example);
    await runServices(services, {
      signal: controller.signal,
      onReady: (name) => {
        if (name === "browser") {
          process.stdout.write(`Chat ready at http://127.0.0.1:${ports.appPort}\n`);
        }
      },
    });
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Example startup failed."}\n`);
    process.exitCode = 1;
  });
}

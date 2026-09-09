import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createPnpmCommand } from "../../../scripts/lib/pnpm-command.ts";

export const DUMMY_KEY = "not-a-real-key-vercel-ai-sdk-private-sentinel";
const repository = resolve(import.meta.dirname, "../../..");

export async function until(
  check: () => boolean | Promise<boolean>,
  label: string,
  timeout = 15_000,
) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(40);
  }
  throw new Error(`Timed out: ${label}`);
}

export function cleanEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1", CI: "true" };
  for (const key of [
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "OPENAI_MODEL",
    "REMOTE_SKILLS_EXAMPLE_TEST",
    "REMOTE_SKILLS_ORIGIN",
    "APP_PORT",
    "AGENT_PORT",
    "SKILLS_PORT",
    "NODE_OPTIONS",
  ])
    delete env[key];
  return env;
}

export async function reservePort() {
  const server = createServer();
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", done);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    port: address.port,
    close: () =>
      new Promise<void>((done, reject) =>
        server.close((error) => (error ? reject(error) : done())),
      ),
  };
}

async function ports() {
  const reserved = await Promise.all([reservePort(), reservePort()]);
  const [app, skills] = reserved.map((entry) => entry.port);
  assert.ok(app && skills);
  await Promise.all(reserved.map((entry) => entry.close()));
  return { app, skills };
}

function ownedProcesses(rootPid: number) {
  const result = spawnSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" });
  assert.equal(result.status, 0, "Process inventory is available.");
  const rows = result.stdout.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/u.exec(line);
    return match
      ? [{ pid: Number(match[1]), parent: Number(match[2]), command: match[3] ?? "" }]
      : [];
  });
  const owned = new Set([rootPid]);
  for (let index = 0; index < rows.length; index += 1)
    for (const row of rows) if (owned.has(row.parent)) owned.add(row.pid);
  return rows.filter((row) => owned.has(row.pid));
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

async function deadline<T>(promise: Promise<T>, milliseconds: number, label: string) {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_done, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function command(args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const launch = createPnpmCommand(args);
  // Own a dedicated process group, equivalent to Ctrl-C in the user's terminal.
  const child = spawn(launch.command, launch.args, {
    cwd,
    env,
    shell: false,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    output += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    output += chunk;
  });
  const exited = new Promise<number | null>((done, reject) => {
    child.once("error", reject);
    child.once("close", done);
  });
  const terminate = async () => {
    const pid = child.pid;
    if (!pid) return;
    const children = ownedProcesses(pid);
    if (alive(pid)) process.kill(-pid, "SIGINT");
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        exited,
        new Promise<never>((_done, reject) => {
          timer = setTimeout(() => {
            try {
              process.kill(-pid, "SIGKILL");
            } catch {
              /* The owned group already exited. */
            }
            reject(new Error("The dev process did not stop after Ctrl-C."));
          }, 8_000);
        }),
      ]);
      await until(() => children.every((entry) => !alive(entry.pid)), "all owned process IDs exit");
    } finally {
      clearTimeout(timer);
    }
  };
  return { child, exited, terminate, output: () => output };
}

export async function disposableExample() {
  const root = await mkdtemp(resolve(tmpdir(), "remote-skills-vercel-ai-sdk-"));
  const files = spawnSync("git", ["ls-files", "-z"], { cwd: repository, encoding: "utf8" });
  assert.equal(files.status, 0);
  // Copy current tracked sources, never .env, node_modules, caches or prebuilt dist.
  for (const file of files.stdout.split("\0").filter(Boolean)) {
    const target = resolve(root, file);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(resolve(repository, file), target);
  }
  const exampleRoot = resolve(root, "examples/vercel-ai-sdk");
  const clean = () => rm(root, { recursive: true, force: true });
  try {
    const env = cleanEnvironment();
    // The TypeScript install must not need uv merely because pnpm sees the Python workspace.
    env.REMOTE_SKILLS_UV = resolve(root, "unavailable-uv");
    const install = command(["install", "--frozen-lockfile", "--offline"], exampleRoot, env);
    try {
      assert.equal(
        await deadline(install.exited, 120_000, "example install"),
        0,
        `Install from vercel-ai-sdk succeeds.\n${install.output()}`,
      );
    } finally {
      await install.terminate();
    }
    assert.equal(
      existsSync(resolve(root, "packages/cli/dist")),
      false,
      "Install requires no prebuilt CLI.",
    );
    assert.equal(
      existsSync(resolve(root, "packages/sdk-typescript/dist")),
      false,
      "Install requires no prebuilt SDK.",
    );
    return { root, exampleRoot, clean };
  } catch (error) {
    await clean();
    throw error;
  }
}

export async function startChat(exampleRoot: string, modelUrl: string) {
  const selected = await ports();
  const envFile = resolve(exampleRoot, ".env");
  await copyFile(resolve(exampleRoot, ".env.example"), envFile);
  const template = await readFile(envFile, "utf8");
  await writeFile(
    envFile,
    template
      .replace(/^OPENAI_API_KEY=.*$/mu, `OPENAI_API_KEY=${DUMMY_KEY}`)
      .replace(/^OPENAI_MODEL=.*$/mu, "OPENAI_MODEL=overridden-by-shell"),
  );
  const env = {
    ...cleanEnvironment(),
    OPENAI_MODEL: "gpt-4.1-mini",
    OPENAI_BASE_URL: `${modelUrl}/v1`,
    REMOTE_SKILLS_EXAMPLE_TEST: "1",
    APP_PORT: String(selected.app),
    SKILLS_PORT: String(selected.skills),
  };
  const dev = command(["run", "dev"], exampleRoot, env);
  try {
    await until(
      () => {
        assert.equal(
          dev.child.exitCode,
          null,
          `Dev stays running until ready.\n${dev.output().replaceAll(DUMMY_KEY, "[redacted]")}`,
        );
        return dev.output().includes(`Chat ready at http://127.0.0.1:${selected.app}`);
      },
      "both example services become ready",
      120_000,
    );
    assert.ok(dev.child.pid);
    const processes = ownedProcesses(dev.child.pid);
    assert.ok(
      processes.some((entry) => entry.command.includes("/cli/dist/cli.js dev")),
      "The installed publisher CLI is running.",
    );
    assert.ok(
      processes.some((entry) => entry.command.includes("next/dist/bin/next")),
      "The app is running.",
    );
    const origin = `http://127.0.0.1:${selected.app}`;
    const catalog = await fetch(
      `http://127.0.0.1:${selected.skills}/.well-known/agent-skills/index.json`,
    );
    assert.equal(catalog.status, 200);
    assert.equal((await fetch(origin)).status, 200);
    assert.ok(
      existsSync(resolve(exampleRoot, "skills/dist")),
      "Publisher output lives under its skills working directory.",
    );
    return {
      origin,
      output: dev.output,
      stop: async () => {
        await dev.terminate();
        for (const port of Object.values(selected)) {
          const server = createServer();
          await new Promise<void>((done, reject) => {
            server.once("error", reject);
            server.listen(port, "127.0.0.1", done);
          });
          await new Promise<void>((done) => server.close(() => done()));
        }
        assert.equal(
          dev.output().includes(DUMMY_KEY),
          false,
          "Startup/shutdown never disclose the dummy key.",
        );
      },
    };
  } catch (error) {
    await dev.terminate();
    throw error;
  }
}

export async function startupFails(
  exampleRoot: string,
  overrides: NodeJS.ProcessEnv,
  expected: RegExp,
) {
  // These negative cases deliberately start without the disposable example's configured key.
  await rm(resolve(exampleRoot, ".env"), { force: true });
  const dev = command(["run", "dev"], exampleRoot, { ...cleanEnvironment(), ...overrides });
  try {
    assert.notEqual(
      await deadline(dev.exited, 15_000, "invalid startup"),
      0,
      "Invalid startup exits nonzero.",
    );
    assert.match(dev.output().replaceAll(DUMMY_KEY, "[redacted]"), expected);
    assert.equal(dev.output().includes(DUMMY_KEY), false);
  } finally {
    await dev.terminate();
  }
}

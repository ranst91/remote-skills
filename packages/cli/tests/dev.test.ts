import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { getEventListeners } from "node:events";
import fs, { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, Server } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import { ConfigValidationError } from "@remote-skills/core/config-schema";
import { createRemoteSkills } from "../../sdk-typescript/src/index.ts";

import { dispatchCli } from "../src/cli.ts";
import {
  type DevelopmentOrigin,
  type PublisherDevErrorEvent,
  parseDevArgs,
  runDevCommand,
} from "../src/dev.ts";
import { completesWithin } from "./helpers/async.ts";

const INDEX_PATH = "/.well-known/agent-skills/index.json";
type CatalogEntry = { url: string; digest: string };
type WorkerExit = { code: number | null; signal: NodeJS.Signals | null };
type WorkerOutcome =
  | { timedOut: false; exit: WorkerExit; stdout: string; stderr: string }
  | { timedOut: true; stdout: string; stderr: string };

const temporaryProjects: string[] = [];
const developmentServers: DevelopmentOrigin[] = [];

afterEach(async () => {
  await Promise.all(developmentServers.splice(0).map((server) => server.close()));
  for (const projectDir of temporaryProjects.splice(0)) {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

function skillMarkdown(marker: string): string {
  return `---\nname: local-origin\ndescription: Exercise the local development origin.\n---\n# ${marker}\n`;
}

function createProject(marker = "generation-one"): string {
  const projectDir = mkdtempSync(path.join(tmpdir(), "remote-skills-cli-dev-"));
  temporaryProjects.push(projectDir);
  mkdirSync(path.join(projectDir, "skills", "local-origin"), { recursive: true });
  writeFileSync(path.join(projectDir, "skills", "local-origin", "SKILL.md"), skillMarkdown(marker));
  return projectDir;
}

async function availableLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert(address && typeof address === "object");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function assertLoopbackPortReusable(port: number): Promise<void> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

function abortAfterNextObservation(controller: AbortController): AbortSignal {
  let scheduled = false;
  return new Proxy(controller.signal, {
    get(target, property): unknown {
      if (property === "aborted" && !scheduled) {
        scheduled = true;
        queueMicrotask(() => controller.abort());
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function runStartupWorker(
  projectDir: string,
  port: number,
  mode: "listener-failure" | "edit-before-listen" = "listener-failure",
): Promise<WorkerOutcome> {
  const workerPath = fileURLToPath(new URL("./dev-startup-worker.ts", import.meta.url));
  const child = spawn(process.execPath, [workerPath, projectDir, String(port), mode], {
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  } as const);
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exited = new Promise<WorkerExit>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  let timeout: NodeJS.Timeout | undefined;
  const outcome = await Promise.race([
    exited.then((exit) => ({ timedOut: false as const, exit })),
    new Promise<{ timedOut: true }>((resolve) => {
      timeout = setTimeout(
        () => resolve({ timedOut: true }),
        mode === "edit-before-listen" ? 8_000 : 2_000,
      );
    }),
  ]);
  if (timeout) clearTimeout(timeout);
  if (outcome.timedOut) {
    child.kill("SIGKILL");
    await exited;
  }
  return { ...outcome, stdout, stderr };
}

function catalogEntry(value: unknown): CatalogEntry {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("catalog entry must be an object");
  }
  const object = Object.fromEntries(Object.entries(value));
  if (typeof object.url !== "string" || typeof object.digest !== "string") {
    throw new Error("catalog entry URL and digest must be strings");
  }
  return { url: object.url, digest: object.digest };
}

async function firstCatalogEntry(response: Response): Promise<CatalogEntry> {
  const value: unknown = await response.json();
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("catalog must be an object");
  }
  const object = Object.fromEntries(Object.entries(value));
  if (!Array.isArray(object.skills) || object.skills.length !== 1) {
    throw new Error("catalog must contain one skill");
  }
  return catalogEntry(object.skills[0]);
}

async function fetchCompleteGeneration(origin: string): Promise<string> {
  const indexResponse = await fetch(`${origin}${INDEX_PATH}`);
  assert.equal(indexResponse.status, 200);
  assert.match(indexResponse.headers.get("content-type") ?? "", /^application\/json\b/u);
  const entry = await firstCatalogEntry(indexResponse);
  return fetchArtifact(origin, entry);
}

async function fetchArtifact(origin: string, entry: CatalogEntry): Promise<string> {
  const response = await fetch(new URL(entry.url, `${origin}${INDEX_PATH}`));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/markdown; charset=utf-8\b/u);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(`sha256:${createHash("sha256").update(bytes).digest("hex")}`, entry.digest);
  return bytes.toString("utf8");
}

async function waitForGeneration(origin: string, marker: string): Promise<string> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5_000) {
    const artifact = await fetchCompleteGeneration(origin);
    if (artifact.includes(marker)) return artifact;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`timed out waiting for ${marker}`);
}

test("parses host and port overrides with explicit unsafe-host acknowledgement", () => {
  assert.deepEqual(parseDevArgs([]), { overrides: {}, unsafeHost: false });
  assert.deepEqual(parseDevArgs(["--host", "0.0.0.0", "--port=9000", "--unsafe-host"]), {
    overrides: { dev: { host: "0.0.0.0", port: 9_000 } },
    unsafeHost: true,
  });
  for (const args of [["--host"], ["--port", "0"], ["--port", "65536"], ["--unknown"]]) {
    assert.throws(
      () => parseDevArgs(args),
      (error) => error instanceof ConfigValidationError,
      JSON.stringify(args),
    );
  }
});

test("rejects a non-loopback bind before producing output without --unsafe-host", async () => {
  const projectDir = createProject();
  const port = await availableLoopbackPort();

  await assert.rejects(
    runDevCommand({ projectDir, args: ["--host", "0.0.0.0", "--port", String(port)] }),
    (error) => error instanceof ConfigValidationError && /unsafe-host/u.test(error.message),
  );

  assert.equal(existsSync(path.join(projectDir, "dist")), false);
});

test("permits an acknowledged non-loopback bind", async () => {
  const projectDir = createProject();
  const port = await availableLoopbackPort();
  const server = await runDevCommand({
    projectDir,
    args: ["--host", "0.0.0.0", "--port", String(port), "--unsafe-host"],
  });
  developmentServers.push(server);

  assert.equal(server.host, "0.0.0.0");
  assert.match(await fetchCompleteGeneration(`http://127.0.0.1:${port}`), /generation-one/u);
});

test("observes an abort before asynchronous startup work and releases the requested port", async () => {
  const projectDir = createProject();
  const port = await availableLoopbackPort();
  const controller = new AbortController();
  const signal = abortAfterNextObservation(controller);
  let returnedServer: DevelopmentOrigin | undefined;
  let startupError: unknown;

  try {
    returnedServer = await runDevCommand({
      projectDir,
      args: ["--port", String(port)],
      signal,
    });
  } catch (error) {
    startupError = error;
  }
  if (returnedServer) await returnedServer.close();

  assert(
    startupError instanceof ConfigValidationError && /aborted/u.test(startupError.message),
    "startup must reject with the public abort diagnostic",
  );
  await assertLoopbackPortReusable(port);
});

test("a startup failure does not leave a server handle keeping the process alive", async () => {
  const projectDir = createProject();
  const port = await availableLoopbackPort();
  const outcome = await runStartupWorker(projectDir, port);

  assert.equal(
    outcome.timedOut,
    false,
    `startup worker retained a live handle\nstdout: ${outcome.stdout}\nstderr: ${outcome.stderr}`,
  );
  assert.deepEqual(outcome.exit, { code: 0, signal: null });
  await assertLoopbackPortReusable(port);
});

test("publishes an included source edit made during startup without a second edit", async () => {
  const projectDir = createProject();
  const port = await availableLoopbackPort();
  const outcome = await runStartupWorker(projectDir, port, "edit-before-listen");

  assert.equal(outcome.timedOut, false, `startup worker timed out\n${outcome.stderr}`);
  assert.deepEqual(outcome.exit, { code: 0, signal: null }, outcome.stderr);
  assert.match(outcome.stdout, /startup edit published/u);
  await assertLoopbackPortReusable(port);
});

test("serves an SDK-consumable origin with complete generations and retains the last good rebuild", async () => {
  const projectDir = createProject();
  const port = await availableLoopbackPort();
  let reportRebuildFailure = (_event: PublisherDevErrorEvent) => {};
  const rebuildFailed = new Promise<void>((resolve) => {
    reportRebuildFailure = () => resolve();
  });
  const server = await runDevCommand({
    projectDir,
    args: ["--port", String(port)],
    onRebuildError: reportRebuildFailure,
  });
  developmentServers.push(server);

  assert.equal(server.origin, `http://127.0.0.1:${port}`);
  const client = createRemoteSkills({
    origins: {
      development: { url: server.origin, allowLoopbackHttp: true, retries: 0 },
    },
    cache: "memory",
  });
  const session = await client.session("development");
  const activated = await session.activate("local-origin");
  assert.match(activated.instructions, /generation-one/u);
  await session.close();
  assert.match(await fetchCompleteGeneration(server.origin), /generation-one/u);
  const generationOneEntry = await firstCatalogEntry(await fetch(`${server.origin}${INDEX_PATH}`));

  writeFileSync(
    path.join(projectDir, "skills", "local-origin", "SKILL.md"),
    skillMarkdown("generation-two"),
  );
  await waitForGeneration(server.origin, "generation-two");
  assert.match(await fetchArtifact(server.origin, generationOneEntry), /generation-one/u);

  writeFileSync(
    path.join(projectDir, "skills", "local-origin", "SKILL.md"),
    "# interrupted rebuild without frontmatter\n",
  );
  await rebuildFailed;
  assert.match(await fetchCompleteGeneration(server.origin), /generation-two/u);

  writeFileSync(
    path.join(projectDir, "skills", "local-origin", "SKILL.md"),
    skillMarkdown("generation-three"),
  );
  await waitForGeneration(server.origin, "generation-three");

  for (let generation = 4; generation <= 20; generation += 1) {
    writeFileSync(
      path.join(projectDir, "skills", "local-origin", "SKILL.md"),
      skillMarkdown(`generation-${generation}`),
    );
  }
  await waitForGeneration(server.origin, "generation-20");
});

for (const failsClose of [false, true]) {
  test(`closes every scan handle after a scan failure with cleanup ${failsClose ? "failure" : "success"}`, async () => {
    const projectDir = createProject();
    const skillRoot = path.join(projectDir, "skills", "local-origin");
    writeFileSync(path.join(skillRoot, ".skillignore"), "drafts/\n");
    const originalOpen = fs.promises.open;
    const originalOpendir = fs.promises.opendir;
    const originalReaddir = fs.promises.readdir;
    const scanFailure = Object.assign(new Error("directory is unreadable"), { code: "EACCES" });
    const handles: Array<{ closeAttempts: number }> = [];
    let handlesAtScanFailure = 0;
    let scanFailed = false;
    let closeFailures = 0;
    const track = <Handle extends fs.Dir | fs.promises.FileHandle>(handle: Handle): Handle => {
      const state = { closeAttempts: 0 };
      handles.push(state);
      const originalClose = handle.close.bind(handle);
      handle.close = async () => {
        state.closeAttempts += 1;
        await originalClose();
        if (scanFailed && failsClose && closeFailures === 0) {
          closeFailures += 1;
          throw new Error("ordinary close failure");
        }
      };
      return handle;
    };
    Reflect.set(fs.promises, "open", async (...args: Parameters<typeof originalOpen>) =>
      track(await originalOpen(...args)),
    );
    Reflect.set(fs.promises, "opendir", async (...args: Parameters<typeof originalOpendir>) =>
      track(await originalOpendir(...args)),
    );
    Reflect.set(fs.promises, "readdir", (...args: Parameters<typeof originalReaddir>) => {
      if (args[0] === skillRoot) {
        handlesAtScanFailure = handles.filter(({ closeAttempts }) => closeAttempts === 0).length;
        scanFailed = true;
        return Promise.reject(scanFailure);
      }
      return originalReaddir(...args);
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(runDevCommand({ projectDir, args: [] }), (error) =>
        failsClose
          ? error instanceof Error &&
            error.message === "development scan handles could not be closed"
          : error === scanFailure,
      );
      assert.equal(scanFailed, true);
      assert.equal(closeFailures, failsClose ? 1 : 0);
      assert(handlesAtScanFailure > 1, "the failing scan must own multiple handles");
      assert(handles.every(({ closeAttempts }) => closeAttempts === 1));
    } finally {
      Reflect.set(fs.promises, "open", originalOpen);
      Reflect.set(fs.promises, "opendir", originalOpendir);
      Reflect.set(fs.promises, "readdir", originalReaddir);
      syncBuiltinESMExports();
    }
  });
}

test("skips inaccessible excluded directories during startup and included edit scans", async () => {
  const projectDir = createProject();
  const skillRoot = path.join(projectDir, "skills", "local-origin");
  const excluded = [
    path.join(projectDir, "skills", "node_modules"),
    path.join(skillRoot, "node_modules"),
    path.join(skillRoot, "drafts"),
  ];
  for (const directory of excluded) {
    mkdirSync(directory);
    writeFileSync(path.join(directory, "notes.txt"), "Ordinary unpublished notes.");
  }
  writeFileSync(path.join(skillRoot, ".skillignore"), "drafts/\n");
  const originalReaddir = fs.promises.readdir;
  let excludedReads = 0;
  let sourceReads = 0;
  Reflect.set(fs.promises, "readdir", (...args: Parameters<typeof originalReaddir>) => {
    if (args[0] === path.join(projectDir, "skills")) sourceReads += 1;
    if (typeof args[0] === "string" && excluded.includes(args[0])) {
      excludedReads += 1;
      return Promise.reject(
        Object.assign(new Error("directory is unreadable"), { code: "EACCES" }),
      );
    }
    return originalReaddir(...args);
  });
  syncBuiltinESMExports();
  let server: DevelopmentOrigin | undefined;
  const errors: PublisherDevErrorEvent[] = [];
  try {
    server = await runDevCommand({
      projectDir,
      args: ["--port", String(await availableLoopbackPort())],
      onRebuildError: (event) => errors.push(event),
    });
    assert.match(await fetchCompleteGeneration(server.origin), /generation-one/u);
    writeFileSync(path.join(skillRoot, "SKILL.md"), skillMarkdown("included-edit"));
    await waitForGeneration(server.origin, "included-edit");
    const indexPath = path.join(projectDir, "dist", INDEX_PATH);
    const publishedAt = fs.statSync(indexPath, { bigint: true }).mtimeNs;
    writeFileSync(path.join(skillRoot, "drafts", "notes.txt"), "Updated unpublished notes.");
    writeFileSync(path.join(skillRoot, ".env-notes"), "Ordinary excluded notes.");
    const nextScans = sourceReads + 3;
    const deadline = Date.now() + 5_000;
    while (sourceReads < nextScans && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert(sourceReads >= nextScans, "the watcher must keep scanning included inputs");
    assert.equal(fs.statSync(indexPath, { bigint: true }).mtimeNs, publishedAt);
    assert.equal(excludedReads, 0);
    assert.deepEqual(errors, []);
  } finally {
    await server?.close();
    Reflect.set(fs.promises, "readdir", originalReaddir);
    syncBuiltinESMExports();
  }
});

test("reloads ignore rules and configured source roots while watching", async () => {
  const projectDir = createProject();
  const skillRoot = path.join(projectDir, "skills", "local-origin");
  writeFileSync(path.join(skillRoot, "notes.txt"), "Publish these notes after the rule changes.");
  writeFileSync(path.join(skillRoot, ".skillignore"), "notes.txt\n");
  const server = await runDevCommand({
    projectDir,
    args: ["--port", String(await availableLoopbackPort())],
  });
  developmentServers.push(server);
  assert.match(await fetchCompleteGeneration(server.origin), /generation-one/u);
  writeFileSync(path.join(skillRoot, ".skillignore"), "");
  async function waitForFormat(extension: string) {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const entry = await firstCatalogEntry(await fetch(`${server.origin}${INDEX_PATH}`));
      if (entry.url.endsWith(extension)) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.fail("ignore rule change was not published");
  }
  await waitForFormat(".tar.gz");
  writeFileSync(path.join(skillRoot, ".skillignore"), "notes.txt\n");
  await waitForFormat(".md");

  const otherRoot = path.join(projectDir, "other-skills", "local-origin");
  mkdirSync(otherRoot, { recursive: true });
  writeFileSync(path.join(otherRoot, "SKILL.md"), skillMarkdown("configured-root"));
  writeFileSync(
    path.join(projectDir, "remote-skills.json"),
    JSON.stringify({ sourceRoots: ["other-skills"] }),
  );
  await waitForGeneration(server.origin, "configured-root");
  writeFileSync(path.join(otherRoot, "SKILL.md"), skillMarkdown("configured-root-edit"));
  await waitForGeneration(server.origin, "configured-root-edit");
});

test("uses ordinary HTTP refresh with no push endpoint and shuts down on abort", async () => {
  const projectDir = createProject();
  const port = await availableLoopbackPort();
  const controller = new AbortController();
  const server = await runDevCommand({
    projectDir,
    args: ["--host=127.0.0.1", "--port", String(port)],
    signal: controller.signal,
  });
  developmentServers.push(server);

  const refresh = await fetch(`${server.origin}${INDEX_PATH}`, {
    headers: { accept: "text/event-stream" },
  });
  assert.equal(refresh.status, 200);
  assert.match(refresh.headers.get("content-type") ?? "", /^application\/json\b/u);
  assert.equal((await fetch(`${server.origin}/__remote_skills_events`)).status, 404);
  const head = await fetch(`${server.origin}${INDEX_PATH}`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  const post = await fetch(`${server.origin}${INDEX_PATH}`, { method: "POST" });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get("allow"), "GET, HEAD");

  controller.abort();
  await completesWithin(server.closed, 500, "abort shutdown did not complete promptly");
  await assert.rejects(fetch(`${server.origin}${INDEX_PATH}`));
});

for (const trigger of ["close", "abort"] as const) {
  for (const fails of [false, true]) {
    test(`${trigger} propagates ${fails ? "failed" : "successful"} shutdown after cleanup`, async (t) => {
      const projectDir = createProject();
      const port = await availableLoopbackPort();
      const controller = new AbortController();
      const errors: PublisherDevErrorEvent[] = [];
      const interval = t.mock.method(globalThis, "setInterval");
      const clear = t.mock.method(globalThis, "clearInterval");
      const server = await runDevCommand({
        projectDir,
        args: ["--port", String(port)],
        signal: controller.signal,
        onRebuildError: (event) => errors.push(event),
      });
      t.after(() => server.close().catch(() => {}));
      const failure = new Error("ordinary close failure detail");
      const originalClose = Server.prototype.close;
      const close = t.mock.method(
        Server.prototype,
        "close",
        function (this: Server, callback?: (error?: Error) => void) {
          return originalClose.call(this, (error) =>
            callback?.(error ?? (fails ? failure : undefined)),
          );
        },
      );
      assert.equal(getEventListeners(controller.signal, "abort").length, 1);
      if (trigger === "abort") controller.abort();
      const closing = server.close();
      if (fails) await assert.rejects(closing, (error) => error === failure);
      else await completesWithin(closing, 500, "shutdown did not complete promptly");
      // Consumers may observe closed later, or only await close; neither may leak a rejection.
      await new Promise<void>((resolve) => setImmediate(resolve));
      let stdout = "";
      let stderr = "";
      const exitCode = await dispatchCli(
        {
          args: ["dev"],
          projectDir,
          env: {},
          stdout: (text) => {
            stdout += text;
          },
          stderr: (text) => {
            stderr += text;
          },
        },
        { dev: async () => server },
      );
      assert.equal(exitCode, fails ? 1 : 0);
      assert.equal(stdout, `${server.origin}\n`);
      assert.equal(stderr, fails ? "remote-skills: internal_error\n" : "");
      assert.deepEqual(
        errors.map((event) => ({ error: event.error, context: event.context })),
        fails ? [{ error: failure, context: { phase: "shutdown" } }] : [],
      );
      if (fails) await assert.rejects(server.close(), (error) => error === failure);
      else await server.close();
      assert.equal(close.mock.callCount(), 1);
      assert.equal(getEventListeners(controller.signal, "abort").length, 0);
      assert.equal(interval.mock.callCount(), 1);
      assert.deepEqual(
        clear.mock.calls.map((call) => call.arguments),
        [[interval.mock.calls[0]?.result]],
      );
      close.mock.restore();
      await assertLoopbackPortReusable(port);
    });
  }
}

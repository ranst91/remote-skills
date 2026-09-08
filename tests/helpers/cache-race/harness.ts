import assert from "node:assert/strict";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CacheRaceRuntime, CacheRaceSchedule } from "./schedules.ts";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const NODE_WORKER = fileURLToPath(new URL("node-worker.ts", import.meta.url));
const PYTHON_PROJECT = fileURLToPath(new URL("../../../packages/sdk-python", import.meta.url));
const PYTHON_WORKER = fileURLToPath(new URL("python_worker.py", import.meta.url));
const COMPLETION_TIMEOUT_MS = 15_000;
const OLD_INSTANT = "2000-01-01T00:00:00.000Z";
const CLEANUP_INSTANT = "2040-01-01T00:00:00.000Z";
const ARTIFACT = Buffer.from(`---
name: cache-race
description: Cross-process cache publication gate.
---

# Cache race

The immutable artifact was observed only after complete digest verification.
`);
const DIGEST = `sha256:${createHash("sha256").update(ARTIFACT).digest("hex")}`;

type WorkerMode =
  | "activate"
  | "cleanup"
  | "evict"
  | "hold-lease"
  | "publish"
  | "read"
  | "stage-crash";

interface WorkerConfiguration {
  cacheRoot: string;
  leaseExpirySeconds?: number;
  mode: WorkerMode;
  now?: string;
  origin?: string;
  temporaryExpirySeconds?: number;
}

interface WorkerMessage {
  artifact?: string | null;
  code?: string;
  digest?: string;
  event: string;
  instructions?: string;
  leasePath?: string;
  leases?: number;
  pinned?: string[];
  removed?: string[];
  temporary?: number;
}

interface WorkerOutcome {
  code: number | null;
  remainingStdout: string;
  signal: NodeJS.Signals | null;
  stderr: string;
}

interface WorkerWaiter {
  event: string;
  reject: (error: Error) => void;
  resolve: (message: WorkerMessage) => void;
}

interface WorkerHandle {
  child: ChildProcessWithoutNullStreams;
  completion: Promise<WorkerOutcome>;
  messages: WorkerMessage[];
  release(): void;
  runtime: CacheRaceRuntime;
  waitFor(event: string): Promise<WorkerMessage>;
}

interface WorkerCommand {
  args: string[];
  command: string;
}

function withTimeout<Value>(
  promise: Promise<Value>,
  label: string,
  milliseconds = COMPLETION_TIMEOUT_MS,
): Promise<Value> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), milliseconds);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

function encodedConfiguration(configuration: WorkerConfiguration): string {
  return Buffer.from(
    JSON.stringify({ ...configuration, artifact: ARTIFACT.toString("base64") }),
  ).toString("base64url");
}

export function createPythonWorkerCommand(configurationArgument: string): WorkerCommand {
  return {
    command: "uv",
    args: [
      "run",
      "--project",
      PYTHON_PROJECT,
      "--locked",
      "--no-sync",
      "python",
      PYTHON_WORKER,
      configurationArgument,
    ],
  };
}

export function createNodeWorkerCommand(
  configurationArgument: string,
  workerPath = NODE_WORKER,
): WorkerCommand {
  return { command: process.execPath, args: [workerPath, configurationArgument] };
}

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

function parseWorkerMessage(value: unknown): WorkerMessage {
  if (!isObject(value)) throw new TypeError("worker message must be an object");
  const event: unknown = Reflect.get(value, "event");
  if (typeof event !== "string") throw new TypeError("worker message must name an event");
  const message: WorkerMessage = { event };
  for (const field of ["artifact", "code", "digest", "instructions", "leasePath"] as const) {
    const property: unknown = Reflect.get(value, field);
    if (property !== undefined && property !== null && typeof property !== "string") {
      throw new TypeError(`worker message ${field} must be a string`);
    }
    if (property !== undefined) Object.assign(message, { [field]: property });
  }
  for (const field of ["leases", "temporary"] as const) {
    const property: unknown = Reflect.get(value, field);
    if (property !== undefined && typeof property !== "number") {
      throw new TypeError(`worker message ${field} must be a number`);
    }
    if (property !== undefined) Object.assign(message, { [field]: property });
  }
  for (const field of ["pinned", "removed"] as const) {
    const property: unknown = Reflect.get(value, field);
    if (
      property !== undefined &&
      (!Array.isArray(property) || !property.every((item) => typeof item === "string"))
    ) {
      throw new TypeError(`worker message ${field} must be a string array`);
    }
    if (property !== undefined) Object.assign(message, { [field]: property });
  }
  return message;
}

export function parseWorkerOutputChunk(buffer: string, chunk: string) {
  let pending = buffer + chunk;
  const messages: WorkerMessage[] = [];
  for (;;) {
    const newline = pending.indexOf("\n");
    if (newline < 0) break;
    const line = pending.slice(0, newline).replace(/\r$/u, "");
    pending = pending.slice(newline + 1);
    if (line.length === 0) continue;
    const rawMessage: unknown = JSON.parse(line);
    messages.push(parseWorkerMessage(rawMessage));
  }
  return { messages, remaining: pending };
}

function startWorker(runtime: CacheRaceRuntime, configuration: WorkerConfiguration): WorkerHandle {
  const configurationArgument = encodedConfiguration(configuration);
  const invocation =
    runtime === "node"
      ? createNodeWorkerCommand(configurationArgument)
      : createPythonWorkerCommand(configurationArgument);
  const child = spawn(invocation.command, invocation.args, {
    cwd: REPOSITORY_ROOT,
    detached: runtime === "python" && process.platform !== "win32",
    env: { ...process.env },
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const messages: WorkerMessage[] = [];
  const waiters: WorkerWaiter[] = [];
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    const parsed = parseWorkerOutputChunk(stdout, chunk);
    stdout = parsed.remaining;
    for (const message of parsed.messages) {
      messages.push(message);
      for (const waiter of [...waiters]) {
        if (waiter.event !== message.event) continue;
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      }
    }
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const completion = new Promise<WorkerOutcome>((resolveCompletion) => {
    child.once("exit", (code, signal) => {
      const outcome = { code, signal, stderr, remainingStdout: stdout };
      for (const waiter of waiters.splice(0)) {
        waiter.reject(
          new Error(`${runtime} worker exited before ${waiter.event}: ${JSON.stringify(outcome)}`),
        );
      }
      resolveCompletion(outcome);
    });
  });
  return {
    runtime,
    child,
    completion,
    messages,
    waitFor(event: string) {
      const existing = messages.find((message) => message.event === event);
      if (existing !== undefined) return Promise.resolve(existing);
      return withTimeout(
        new Promise<WorkerMessage>((resolveMessage, rejectMessage) => {
          waiters.push({ event, resolve: resolveMessage, reject: rejectMessage });
        }),
        `${runtime} ${event}`,
      );
    },
    release() {
      child.stdin.end("release\n");
    },
  };
}

function signalWorkerCrash(worker: WorkerHandle): void {
  if (worker.child.exitCode !== null || worker.child.signalCode !== null) return;
  if (worker.runtime === "python") {
    const pid = worker.child.pid;
    if (pid === undefined) throw new Error("Python worker has no process identifier");
    if (process.platform === "win32") {
      const outcome = spawnSync("taskkill", ["/pid", String(pid), "/t", "/f"], {
        encoding: "utf8",
      });
      assert.equal(outcome.status, 0, `taskkill failed: ${outcome.stderr}`);
    } else {
      process.kill(-pid, "SIGKILL");
    }
    return;
  }
  worker.child.kill("SIGKILL");
}

async function expectSuccessful(worker: WorkerHandle): Promise<void> {
  const outcome = await withTimeout(worker.completion, `${worker.runtime} worker exit`);
  assert.equal(outcome.code, 0, `${worker.runtime} worker failed: ${outcome.stderr}`);
  assert.equal(outcome.remainingStdout, "", `${worker.runtime} worker emitted a partial event`);
}

async function killWorker(worker: WorkerHandle): Promise<void> {
  signalWorkerCrash(worker);
  const outcome = await withTimeout(worker.completion, `${worker.runtime} crash exit`);
  assert.ok(
    outcome.signal !== null || outcome.code !== 0,
    `${worker.runtime} crash worker exited successfully`,
  );
}

async function runOneShot(
  runtime: CacheRaceRuntime,
  configuration: WorkerConfiguration,
  event: string,
): Promise<WorkerMessage> {
  const worker = startWorker(runtime, configuration);
  const message = await worker.waitFor(event);
  await expectSuccessful(worker);
  return message;
}

function objectDirectory(cacheRoot: string): string {
  const hex = DIGEST.slice("sha256:".length);
  return join(cacheRoot, "cache-v1", "objects", "sha256", hex.slice(0, 2), hex.slice(2));
}

function isErrorWithCode(error: unknown): error is Error & { code: string } {
  return (
    error instanceof Error && "code" in error && typeof Reflect.get(error, "code") === "string"
  );
}

async function assertMissing(path: string, label: string): Promise<void> {
  await assert.rejects(access(path), (error) => {
    assert.ok(isErrorWithCode(error));
    assert.equal(error.code, "ENOENT", `${label} failed for an unexpected reason`);
    return true;
  });
}

async function assertCompleteObject(cacheRoot: string): Promise<void> {
  const directory = objectDirectory(cacheRoot);
  const artifact = await readFile(join(directory, "artifact"));
  const rootSkill = await readFile(join(directory, "root", "SKILL.md"));
  const metadata: unknown = JSON.parse(await readFile(join(directory, "object.json"), "utf8"));
  if (!isObject(metadata) || Array.isArray(metadata)) {
    throw new TypeError("cache object metadata must be an object");
  }
  const metadataDigest: unknown = Reflect.get(metadata, "digest");
  const artifactBytes: unknown = Reflect.get(metadata, "artifact_bytes");
  if (typeof metadataDigest !== "string") {
    throw new TypeError("cache object metadata digest must be a string");
  }
  if (typeof artifactBytes !== "number") {
    throw new TypeError("cache object metadata artifact_bytes must be a number");
  }
  assert.equal(`sha256:${createHash("sha256").update(artifact).digest("hex")}`, DIGEST);
  assert.deepEqual(artifact, ARTIFACT);
  assert.deepEqual(rootSkill, ARTIFACT);
  assert.equal(metadataDigest, DIGEST);
  assert.equal(artifactBytes, ARTIFACT.byteLength);
  assert.deepEqual((await readdir(directory)).sort(), ["artifact", "object.json", "root"]);
}

async function writerDirectories(cacheRoot: string): Promise<string[]> {
  const temporaryRoot = join(cacheRoot, "cache-v1", "tmp");
  try {
    return (await readdir(temporaryRoot)).filter((name) => name.startsWith("writer-"));
  } catch (error) {
    // A cache that never staged a writer legitimately has no temporary root.
    if (isErrorWithCode(error) && error.code === "ENOENT") return [];
    throw error;
  }
}

async function ageTree(path: string): Promise<void> {
  let information: Awaited<ReturnType<typeof stat>>;
  try {
    information = await stat(path);
  } catch (error) {
    // A peer cleanup may already have achieved the requested absent state.
    if (isErrorWithCode(error) && error.code === "ENOENT") return;
    throw error;
  }
  if (information.isDirectory()) {
    for (const name of await readdir(path)) await ageTree(join(path, name));
  }
  const old = new Date(OLD_INSTANT);
  await utimes(path, old, old);
}

async function rewriteExpiredRecords(path: string): Promise<void> {
  let information: Awaited<ReturnType<typeof stat>>;
  try {
    information = await stat(path);
  } catch (error) {
    // A peer cleanup may already have removed an expired coordination generation.
    if (isErrorWithCode(error) && error.code === "ENOENT") return;
    throw error;
  }
  if (information.isDirectory()) {
    for (const name of await readdir(path)) await rewriteExpiredRecords(join(path, name));
    await ageTree(path);
    return;
  }
  if (path.endsWith(".json")) {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isObject(value) || Array.isArray(value)) {
      throw new TypeError(`coordination record ${path} must be an object`);
    }
    for (const key of ["created_at", "renewed_at", "generation"]) {
      const field: unknown = Reflect.get(value, key);
      if (typeof field === "string" && !field.startsWith("sha256:")) {
        Reflect.set(value, key, OLD_INSTANT);
      }
    }
    await writeFile(path, `${JSON.stringify(value)}\n`);
  }
  await ageTree(path);
}

function catalogBytes(): Buffer {
  return Buffer.from(
    `${JSON.stringify({
      $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
      skills: [
        {
          name: "cache-race",
          description: "Cross-process cache publication gate.",
          type: "skill-md",
          url: "artifacts/cache-race.md",
          digest: DIGEST,
        },
      ],
    })}\n`,
  );
}

interface ArtifactRequest {
  response: ServerResponse;
  runtime: CacheRaceRuntime;
}

async function createDownloadGate() {
  const artifactRequests: ArtifactRequest[] = [];
  const { promise: ready, resolve: resolveReady } = Promise.withResolvers<void>();
  const body = catalogBytes();
  const server = createServer((request, response) => {
    if (request.url === "/.well-known/agent-skills/index.json") {
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-length": body.byteLength,
        "content-type": "application/json",
      });
      response.end(body);
      return;
    }
    if (request.url !== "/.well-known/agent-skills/artifacts/cache-race.md") {
      response.writeHead(404).end();
      return;
    }
    const runtime = request.headers["x-cache-race-worker"];
    if (runtime !== "node" && runtime !== "python") {
      response.writeHead(400).end();
      return;
    }
    artifactRequests.push({ runtime, response });
    response.writeHead(200, {
      "content-length": ARTIFACT.byteLength,
      "content-type": "text/markdown; charset=utf-8",
    });
    if (artifactRequests.length === 2) resolveReady();
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("cache-race gate has no TCP address");
  }
  return {
    artifactRequests,
    ready,
    origin: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise<void>((resolveClose, rejectClose) =>
        server.close((error) => (error === undefined ? resolveClose() : rejectClose(error))),
      );
    },
  };
}

function writeResponseChunk(response: ServerResponse, bytes: Uint8Array): Promise<void> {
  return new Promise<void>((resolveWrite, rejectWrite) => {
    response.once("error", rejectWrite);
    response.write(bytes, () => {
      response.removeListener("error", rejectWrite);
      resolveWrite();
    });
  });
}

async function runDownload(schedule: CacheRaceSchedule, cacheRoot: string): Promise<void> {
  const gate = await createDownloadGate();
  const node = startWorker("node", { mode: "activate", cacheRoot, origin: gate.origin });
  const python = startWorker("python", { mode: "activate", cacheRoot, origin: gate.origin });
  const workers = { node, python };
  try {
    await withTimeout(
      Promise.race([
        gate.ready,
        node.completion.then((outcome) => {
          throw new Error(`node exited before both downloads: ${JSON.stringify(outcome)}`);
        }),
        python.completion.then((outcome) => {
          throw new Error(`python exited before both downloads: ${JSON.stringify(outcome)}`);
        }),
      ]),
      "both artifact downloads",
    );
    assert.deepEqual(
      new Set(gate.artifactRequests.map(({ runtime }) => runtime)),
      new Set(["node", "python"]),
    );
    const boundary = Math.floor(ARTIFACT.byteLength / 2);
    await Promise.all(
      gate.artifactRequests.map(({ response }) =>
        writeResponseChunk(response, ARTIFACT.subarray(0, boundary)),
      ),
    );
    await assertMissing(objectDirectory(cacheRoot), "partial download visibility");

    const winningRequest = gate.artifactRequests.find(
      ({ runtime }) => runtime === schedule.primary,
    );
    const losingRequest = gate.artifactRequests.find(
      ({ runtime }) => runtime === schedule.secondary,
    );
    assert.ok(winningRequest);
    assert.ok(losingRequest);
    winningRequest.response.end(ARTIFACT.subarray(boundary));
    const winner = await workers[schedule.primary].waitFor("activated");
    assert.equal(winner.digest, DIGEST);
    await assertCompleteObject(cacheRoot);

    losingRequest.response.end(ARTIFACT.subarray(boundary));
    const loser = await workers[schedule.secondary].waitFor("activated");
    assert.equal(loser.digest, DIGEST);
    assert.equal(loser.instructions, winner.instructions);
    await Promise.all([expectSuccessful(node), expectSuccessful(python)]);
    assert.deepEqual(await writerDirectories(cacheRoot), []);
  } finally {
    for (const worker of [node, python]) signalWorkerCrash(worker);
    await Promise.all([node.completion, python.completion]);
    await gate.close();
  }
}

function requiredNumber(message: WorkerMessage, field: "leases" | "temporary"): number {
  const value = message[field];
  if (value === undefined) throw new Error(`${message.event} omits ${field}`);
  return value;
}

function requiredString(message: WorkerMessage, field: "leasePath"): string {
  const value = message[field];
  if (value === undefined) throw new Error(`${message.event} omits ${field}`);
  return value;
}

async function runStageCrash(schedule: CacheRaceSchedule, cacheRoot: string): Promise<void> {
  const crashed = startWorker(schedule.primary, { mode: "stage-crash", cacheRoot });
  await crashed.waitFor("staged");
  await assertMissing(objectDirectory(cacheRoot), "pre-publication stage visibility");
  assert.equal((await writerDirectories(cacheRoot)).length, 1);
  await killWorker(crashed);
  await ageTree(join(cacheRoot, "cache-v1", "tmp"));

  const cleaned = await runOneShot(
    schedule.secondary,
    {
      mode: "cleanup",
      cacheRoot,
      now: CLEANUP_INSTANT,
      leaseExpirySeconds: 1,
      temporaryExpirySeconds: 1,
    },
    "cleaned",
  );
  assert.ok(requiredNumber(cleaned, "temporary") >= 1, "crashed private stage was not reclaimed");
  assert.deepEqual(await writerDirectories(cacheRoot), []);
  await runOneShot(schedule.secondary, { mode: "publish", cacheRoot }, "published");
  await assertCompleteObject(cacheRoot);
}

async function publish(runtime: CacheRaceRuntime, cacheRoot: string): Promise<void> {
  const result = await runOneShot(runtime, { mode: "publish", cacheRoot }, "published");
  assert.equal(result.digest, DIGEST);
  await assertCompleteObject(cacheRoot);
}

async function runLeaseExpiry(schedule: CacheRaceSchedule, cacheRoot: string): Promise<void> {
  await publish(schedule.primary, cacheRoot);
  const holder = startWorker(schedule.primary, {
    mode: "hold-lease",
    cacheRoot,
    leaseExpirySeconds: 120,
  });
  const ready = await holder.waitFor("lease-ready");
  const leasePath = requiredString(ready, "leasePath");
  await access(leasePath);
  await killWorker(holder);
  await rewriteExpiredRecords(dirname(leasePath));
  await rewriteExpiredRecords(join(cacheRoot, "cache-v1", "tmp", "coordination-v1"));

  const cleaned = await runOneShot(
    schedule.secondary,
    { mode: "cleanup", cacheRoot, now: CLEANUP_INSTANT, leaseExpirySeconds: 1 },
    "cleaned",
  );
  assert.ok(requiredNumber(cleaned, "leases") >= 1, "expired dead-process lease was not reclaimed");
  await assertMissing(leasePath, "expired lease cleanup");
  await assertCompleteObject(cacheRoot);
}

async function runActivePin(schedule: CacheRaceSchedule, cacheRoot: string): Promise<void> {
  await publish(schedule.primary, cacheRoot);
  const holder = startWorker(schedule.primary, {
    mode: "hold-lease",
    cacheRoot,
    leaseExpirySeconds: 120,
  });
  await holder.waitFor("lease-ready");
  const protectedRun = await runOneShot(
    schedule.secondary,
    { mode: "evict", cacheRoot, leaseExpirySeconds: 120 },
    "evicted",
  );
  assert.deepEqual(protectedRun.removed, []);
  assert.deepEqual(protectedRun.pinned, [DIGEST]);
  await assertCompleteObject(cacheRoot);

  holder.release();
  await holder.waitFor("lease-released");
  await expectSuccessful(holder);
  const unpinnedRun = await runOneShot(
    schedule.secondary,
    { mode: "evict", cacheRoot, leaseExpirySeconds: 120 },
    "evicted",
  );
  assert.deepEqual(unpinnedRun.removed, [DIGEST]);
  await assertMissing(objectDirectory(cacheRoot), "post-release eviction");
}

async function runCorruption(schedule: CacheRaceSchedule, cacheRoot: string): Promise<void> {
  await publish(schedule.primary, cacheRoot);
  const artifactPath = join(objectDirectory(cacheRoot), "artifact");
  const corrupt = await readFile(artifactPath);
  const lastIndex = corrupt.length - 1;
  const lastByte = corrupt[lastIndex];
  if (lastByte === undefined) throw new Error("cache-race artifact unexpectedly empty");
  corrupt[lastIndex] = lastByte ^ 0xff;
  await writeFile(artifactPath, corrupt);
  const observed = await runOneShot(schedule.secondary, { mode: "read", cacheRoot }, "read-error");
  assert.equal(observed.code, "cache_corrupt");
}

export async function runCacheRaceSchedule(schedule: CacheRaceSchedule): Promise<void> {
  const majorText = process.versions.node.split(".")[0];
  if (majorText === undefined) throw new Error(`invalid Node.js version: ${process.versions.node}`);
  const major = Number.parseInt(majorText, 10);
  assert.ok(major >= 24, `cache-race gate requires Node 24+, received ${process.version}`);
  const cacheRoot = await mkdtemp(join(tmpdir(), `remote-skills-${schedule.name}-`));
  try {
    if (schedule.operation === "download") await runDownload(schedule, cacheRoot);
    else if (schedule.operation === "stage-crash") await runStageCrash(schedule, cacheRoot);
    else if (schedule.operation === "lease-expiry") await runLeaseExpiry(schedule, cacheRoot);
    else if (schedule.operation === "active-pin") await runActivePin(schedule, cacheRoot);
    else if (schedule.operation === "corruption") await runCorruption(schedule, cacheRoot);
    else throw new Error(`unknown cache-race schedule operation: ${schedule.operation}`);
  } finally {
    await rm(cacheRoot, { recursive: true, force: true });
  }
}

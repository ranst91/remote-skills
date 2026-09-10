import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  createNodeWorkerCommand,
  createPythonWorkerCommand,
  parseWorkerOutputChunk,
  runCacheRaceSchedule,
} from "../helpers/cache-race/harness.ts";
import { CACHE_RACE_SCHEDULES } from "../helpers/cache-race/schedules.ts";

const PYTHON_PROJECT = fileURLToPath(new URL("../../packages/sdk-python", import.meta.url));
const PYTHON_WORKER = fileURLToPath(
  new URL("../helpers/cache-race/python_worker.py", import.meta.url),
);

const REQUIRED_SCHEDULES = Object.freeze([
  "node-download-wins",
  "python-download-wins",
  "node-stage-crash-python-recovers",
  "python-stage-crash-node-recovers",
  "node-expired-lease-python-reclaims",
  "python-expired-lease-node-reclaims",
  "node-pin-python-evicts",
  "python-pin-node-evicts",
  "node-publishes-python-rejects-corruption",
  "python-publishes-node-rejects-corruption",
]);
test("task 7.2 registers every required cross-runtime cache-race schedule", () => {
  assert.deepEqual(
    CACHE_RACE_SCHEDULES.map(({ name }) => name),
    REQUIRED_SCHEDULES,
  );
});

test("Python cache-race workers use the locked uv project without syncing", () => {
  assert.deepEqual(createPythonWorkerCommand("configuration"), {
    command: "uv",
    args: [
      "run",
      "--project",
      PYTHON_PROJECT,
      "--locked",
      "--no-sync",
      "python",
      PYTHON_WORKER,
      "configuration",
    ],
  });
});

test("Node cache-race workers preserve Windows-style paths as one process argument", () => {
  const workerPath = String.raw`C:\Program Files\Remote Skills\node-worker.ts`;
  assert.deepEqual(createNodeWorkerCommand("configuration", workerPath), {
    command: process.execPath,
    args: [workerPath, "configuration"],
  });
});

test("cache-race worker messages tolerate fragmented CRLF and preserve Windows paths", () => {
  const first = parseWorkerOutputChunk(
    "",
    `${String.raw`{"event":"lease-ready","leasePath":"C:\\cache dir\\lease.json"}`}\r`,
  );
  assert.deepEqual(first.messages, []);
  const second = parseWorkerOutputChunk(first.remaining, "\n\r\n");
  assert.deepEqual(second, {
    messages: [
      {
        event: "lease-ready",
        leasePath: String.raw`C:\cache dir\lease.json`,
      },
    ],
    remaining: "",
  });
});

for (const schedule of CACHE_RACE_SCHEDULES) {
  test(`${schedule.name} completes without partial observation, corruption, eviction races, or deadlock`, {
    timeout: 30_000,
  }, async () => {
    await runCacheRaceSchedule(schedule);
  });
}

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { pythonAgent } from "../server/python-process.ts";
import type { ChatEvent } from "../server/typescript-agent.ts";

const example = resolve(import.meta.dirname, "..");
const executable = resolve(
  example,
  "../..",
  process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python",
);

test("Python transport preserves split UTF-8 and acknowledges completion after cleanup", async (t) => {
  const dir = await mkdtemp(resolve(tmpdir(), "langchain-python-transport-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const script = resolve(dir, "split.py");
  const marker = resolve(dir, "cleaned");
  await writeFile(
    script,
    `import os, time\nfrom pathlib import Path\ndata = '{"type":"text","text":"café 🦜 東京"}\\n'.encode('utf-8')\nfor byte in data:\n    os.write(1, bytes([byte]))\n    time.sleep(0.004)\nos.write(1, b'{"type":"done"}\\n')\ntime.sleep(0.05)\nPath(os.environ['CLEANUP_MARKER']).write_text('cleaned')\n`,
  );
  const events: ChatEvent[] = [];
  for await (const event of pythonAgent(
    "Hello!",
    "langchain-python",
    new AbortController().signal,
    { executable, script, cwd: example, env: { ...process.env, CLEANUP_MARKER: marker } },
  )) {
    if (event.type === "done") assert.equal(await readFile(marker, "utf8"), "cleaned");
    events.push(event);
  }
  assert.deepEqual(events, [{ type: "text", text: "café 🦜 東京" }, { type: "done" }]);
});

test("Python transport abort reaps its process before returning", { timeout: 10000 }, async (t) => {
  const dir = await mkdtemp(resolve(tmpdir(), "langchain-python-cancel-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const script = resolve(dir, "wait.py");
  await writeFile(
    script,
    `import json, os, time\nprint(json.dumps({"type":"pid", "pid":os.getpid()}), flush=True)\nwhile True:\n    time.sleep(1)\n`,
  );
  const controller = new AbortController();
  let pid: unknown;
  await assert.rejects(async () => {
    for await (const event of pythonAgent("Hello!", "langchain-python", controller.signal, {
      executable,
      script,
      cwd: example,
    })) {
      pid = event.pid;
      controller.abort();
    }
  });
  assert.equal(typeof pid, "number");
  if (typeof pid !== "number") throw new Error("Missing child PID");
  const childPid = pid;
  assert.throws(() => process.kill(childPid, 0), { code: "ESRCH" });
});

test("Python transport never acknowledges done followed by a failing process", async (t) => {
  const dir = await mkdtemp(resolve(tmpdir(), "langchain-python-exit-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const script = resolve(dir, "failed.py");
  await writeFile(script, `import sys\nprint('{"type":"done"}', flush=True)\nsys.exit(1)\n`);
  const events: ChatEvent[] = [];
  await assert.rejects(async () => {
    for await (const event of pythonAgent(
      "Hello!",
      "langchain-python",
      new AbortController().signal,
      { executable, script, cwd: example },
    ))
      events.push(event);
  }, /Python agent did not finish/);
  assert.deepEqual(events, []);
});

test("Python transport sanitizes startup failures", async () => {
  await assert.rejects(
    Array.fromAsync(
      pythonAgent("Hello!", "langchain-python", new AbortController().signal, {
        executable: resolve(tmpdir(), "missing-langchain-python"),
        cwd: example,
      }),
    ),
    /Python agent could not start/,
  );
});

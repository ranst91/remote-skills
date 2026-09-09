import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import test from "node:test";

import {
  assertPortsAvailable,
  runServices,
  type ServiceDefinition,
  validateEnvironment,
} from "../../scripts/examples/dev.ts";

const childServer = `
  const http = require("node:http");
  const port = Number(process.argv[1]);
  if (process.argv[2] === "exit") process.exit(7);
  const server = http.createServer((_request, response) => response.end("ready"));
  server.listen(port, "127.0.0.1");
  const stop = () => server.close(() => process.exit(0));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
`;

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function assertPortReusable(port: number): Promise<void> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

async function waitForExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`child ${pid} remained alive`);
}

function service(name: string, port: number, mode = "serve"): ServiceDefinition {
  return {
    name,
    command: process.execPath,
    args: ["-e", childServer, String(port), mode],
    cwd: process.cwd(),
    env: {},
    readyUrl: `http://127.0.0.1:${port}`,
  };
}

test("missing credentials fail without disclosing their value", () => {
  const sentinel = "credential-that-must-not-appear";
  assert.throws(
    () => validateEnvironment({ OPENAI_MODEL: sentinel }),
    (error: unknown) => {
      assert(error instanceof Error);
      assert.match(error.message, /OPENAI_API_KEY/u);
      assert.equal(error.message.includes(sentinel), false);
      return true;
    },
  );
});

test("occupied ports fail before startup", async () => {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  try {
    await assert.rejects(assertPortsAvailable([address.port]), {
      message: `Port ${address.port} is unavailable.`,
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("readiness failure stops a service that already became ready", async () => {
  const firstPort = await availablePort();
  const secondPort = await availablePort();
  const pids: number[] = [];

  await assert.rejects(
    runServices([service("first", firstPort), service("second", secondPort, "exit")], {
      signal: new AbortController().signal,
      readinessTimeoutMs: 1_000,
      onStarted: (_name, pid) => pids.push(pid),
    }),
    /second exited before becoming ready/u,
  );

  assert.equal(pids.length, 2);
  await Promise.all(pids.map(waitForExit));
  await assertPortReusable(firstPort);
  await assertPortReusable(secondPort);
});

test("shutdown stops all three successfully started services", async () => {
  const ports = await Promise.all([availablePort(), availablePort(), availablePort()]);
  const controller = new AbortController();
  const pids: number[] = [];
  const ready: string[] = [];
  const services = ports.map((port, index) => service(`service-${index + 1}`, port));

  await runServices(services, {
    signal: controller.signal,
    readinessTimeoutMs: 1_000,
    onStarted: (_name, pid) => pids.push(pid),
    onReady: (name) => {
      ready.push(name);
      if (ready.length === services.length) controller.abort();
    },
  });

  assert.equal(pids.length, 3);
  assert.equal(ready.length, 3);
  await Promise.all(pids.map(waitForExit));
  await Promise.all(ports.map(assertPortReusable));
  for (const pid of pids) {
    const result = spawnSync(process.execPath, ["-e", `process.kill(${pid}, 0)`], {
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
  }
});

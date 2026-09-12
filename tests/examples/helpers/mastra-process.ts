import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { runServices } from "../../../scripts/examples/dev.ts";
import { createPnpmCommand } from "../../../scripts/lib/pnpm-command.ts";
import { cleanEnvironment, DUMMY_KEY, reservePort } from "./vercel-ai-sdk-process.ts";

/** Observe real published bytes without substituting catalogs, archives, SDK or tools. */
export async function startMastra(root: string, modelUrl: string) {
  const exampleRoot = resolve(root, "examples/mastra");
  const env = { ...cleanEnvironment(), NEXT_TELEMETRY_DISABLED: "1" };
  if (!process.env.REMOTE_SKILLS_E2E_PACKAGES) {
    const build = createPnpmCommand(["ci:build:repository"]);
    assert.equal(
      spawnSync(build.command, build.args, { cwd: root, env, timeout: 120_000 }).status,
      0,
      "The clean checkout builds its publisher and integration.",
    );
  }
  if (process.env.REMOTE_SKILLS_E2E_PACKAGES) {
    for (const path of [
      "packages/cli/dist",
      "packages/sdk-typescript/dist",
      "integrations/mastra/dist",
    ])
      assert.equal(
        existsSync(resolve(root, path)),
        false,
        "Candidate journey has no workspace build output.",
      );
  }
  const reserved = await Promise.all([reservePort(), reservePort()]);
  const appPort = reserved[0]?.port;
  const publisherPort = reserved[1]?.port;
  assert.ok(appPort && publisherPort);
  await Promise.all(reserved.map((port) => port.close()));
  const paths: string[] = [];
  const proxy = createServer(async (request, response) => {
    paths.push(request.url ?? "/");
    try {
      const upstream = await fetch(`http://127.0.0.1:${publisherPort}${request.url ?? "/"}`);
      response.writeHead(upstream.status, Object.fromEntries(upstream.headers));
      response.end(Buffer.from(await upstream.arrayBuffer()));
    } catch {
      response.writeHead(502).end();
    }
  });
  await new Promise<void>((done) => proxy.listen(0, "127.0.0.1", done));
  const address = proxy.address();
  assert.ok(address && typeof address === "object");
  const controller = new AbortController();
  let ready: (() => void) | undefined;
  const readiness = new Promise<void>((done) => {
    ready = done;
  });
  const origin = `http://127.0.0.1:${appPort}`;
  const running = runServices(
    [
      {
        name: "publisher",
        command: process.execPath,
        args: [
          resolve(exampleRoot, "node_modules/@remote-skills/cli/dist/cli.js"),
          "dev",
          "--host",
          "127.0.0.1",
          "--port",
          String(publisherPort),
        ],
        cwd: resolve(exampleRoot, "skills"),
        env,
        readyUrl: `http://127.0.0.1:${publisherPort}/.well-known/agent-skills/index.json`,
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
          String(appPort),
        ],
        cwd: exampleRoot,
        env: {
          ...env,
          OPENAI_API_KEY: DUMMY_KEY,
          OPENAI_MODEL: "gpt-4.1",
          OPENAI_BASE_URL: `${modelUrl}/v1`,
          REMOTE_SKILLS_EXAMPLE_TEST: "1",
          REMOTE_SKILLS_ORIGIN: `http://127.0.0.1:${address.port}`,
        },
        readyUrl: origin,
      },
    ],
    {
      signal: controller.signal,
      onReady: (name) => {
        if (name === "browser") ready?.();
      },
    },
  );
  const stop = async () => {
    controller.abort();
    try {
      await running;
    } finally {
      proxy.closeAllConnections();
      await new Promise<void>((done, reject) =>
        proxy.close((error) => (error ? reject(error) : done())),
      );
    }
  };
  try {
    await Promise.race([readiness, running]);
    return { origin, paths, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

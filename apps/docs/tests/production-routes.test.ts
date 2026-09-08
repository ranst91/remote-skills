import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import test from "node:test";
import { fileURLToPath } from "node:url";

const appRoot = new URL("../", import.meta.url);
const appRootPath = fileURLToPath(appRoot);
const nextBin = fileURLToPath(new URL("node_modules/next/dist/bin/next", appRoot));
const expectedMarkdownRoutes = [
  "/docs/index.md",
  "/docs/publisher.md",
  "/docs/typescript.md",
  "/docs/python.md",
  "/docs/hosting/archive-to-origin.md",
  "/docs/hosting/git-pages.md",
  "/docs/cli.md",
  "/docs/authentication-and-scopes.md",
  "/docs/versions.md",
  "/docs/cache-and-offline.md",
  "/docs/trust-and-security.md",
  "/docs/api-reference.md",
];

function generatedMarkdownRoute(publicRoute: string) {
  if (publicRoute === "/docs/index.md") return "/markdown";
  return `/markdown/${publicRoute.slice("/docs/".length, -".md".length)}`;
}

function prerenderRoutes(value: unknown): object {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("prerender manifest must be an object");
  }
  const routes: unknown = Reflect.get(value, "routes");
  if (routes === null || typeof routes !== "object" || Array.isArray(routes)) {
    throw new TypeError("prerender manifest routes must be an object");
  }
  return routes;
}

async function availablePort() {
  const server = createServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await new Promise<void>((resolveClose, rejectClose) =>
    server.close((error) => (error ? rejectClose(error) : resolveClose())),
  );
  return address.port;
}

async function waitUntilReady(baseUrl: string, child: ChildProcess) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    assert.equal(child.exitCode, null, "production docs server exited before becoming ready");
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return;
    } catch {
      // The TCP listener is not ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail("production docs server did not become ready");
}

test("production build serves llms.txt and every indexed canonical Markdown route", async () => {
  const rawPrerenderManifest: unknown = JSON.parse(
    readFileSync(new URL(".next/prerender-manifest.json", appRoot), "utf8"),
  );
  const routes = prerenderRoutes(rawPrerenderManifest);
  for (const route of expectedMarkdownRoutes) {
    assert.ok(
      Object.hasOwn(routes, generatedMarkdownRoute(route)),
      `${route} must map to an independently generated production route`,
    );
  }

  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(
    process.execPath,
    [nextBin, "start", "--hostname", "127.0.0.1", "--port", `${port}`],
    {
      cwd: appRootPath,
      env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
      stdio: "ignore",
    },
  );

  try {
    await waitUntilReady(baseUrl, child);
    const indexResponse = await fetch(`${baseUrl}/llms.txt`);
    assert.equal(indexResponse.status, 200);
    assert.match(indexResponse.headers.get("content-type") ?? "", /^text\/plain\b/u);

    const index = await indexResponse.text();
    assert.match(index, /^# Remote Skills$/mu);
    const linkedRoutes = [...index.matchAll(/\]\((\/docs\/[^)]+\.md)\)/gu)].map(
      (match) => match[1],
    );
    assert.deepEqual(linkedRoutes, expectedMarkdownRoutes);

    for (const route of linkedRoutes) {
      const response = await fetch(`${baseUrl}${route}`);
      assert.equal(response.status, 200, route);
      assert.match(response.headers.get("content-type") ?? "", /^text\/markdown\b/u, route);
      const markdown = await response.text();
      assert.match(markdown, /^# .+/u, route);
      assert.doesNotMatch(markdown, /&#x[0-9a-f]+;/iu, route);
      if (route === "/docs/hosting/archive-to-origin.md") {
        assert.match(markdown, /\*\*Do not unpack, recompress, rename, or wrap archives\.\*\*/u);
      }
    }
  } finally {
    child.kill("SIGTERM");
  }
});

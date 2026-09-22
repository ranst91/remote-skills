import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRemoteSkills } from "@remote-skills/client";

/** Build the demo's actual files with the public CLI and serve only those bytes. */
export async function publishedOrigin() {
  const root = await mkdtemp(join(tmpdir(), "tanstack-origin-"));
  const example = resolve(import.meta.dirname, "..");
  try {
    await cp(join(example, "skills/source"), join(root, "source"), { recursive: true });
    await writeFile(
      join(root, "remote-skills.json"),
      JSON.stringify({ sourceRoots: ["source"], outDir: "dist", format: "tar.gz" }),
    );
    execFileSync(
      process.execPath,
      [resolve(example, "node_modules/@remote-skills/cli/dist/cli.js"), "build"],
      {
        cwd: root,
        timeout: 30_000,
      },
    );
    const base = join(root, "dist/.well-known/agent-skills");
    const files = new Map<string, Buffer>([
      ["/.well-known/agent-skills/index.json", await readFile(join(base, "index.json"))],
    ]);
    for (const name of await readdir(join(base, "artifacts"))) {
      files.set(
        `/.well-known/agent-skills/artifacts/${name}`,
        await readFile(join(base, "artifacts", name)),
      );
    }
    const paths: string[] = [];
    const server = createServer((request, response) => {
      const path = request.url ?? "";
      paths.push(path);
      const body = files.get(path);
      response.statusCode = body ? 200 : 404;
      response.end(body);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    return {
      client: createRemoteSkills({
        origins: {
          demo: { url: `http://127.0.0.1:${address.port}`, allowLoopbackHttp: true, retries: 0 },
        },
        cache: "memory",
      }),
      artifactRequests: () => paths.filter((path) => !path.endsWith("index.json")),
      async close() {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        await rm(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

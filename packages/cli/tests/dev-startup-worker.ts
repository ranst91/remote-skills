import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { Server } from "node:http";
import path from "node:path";
import { mock } from "node:test";

import { runDevCommand } from "../src/dev.ts";

const [projectDir, port, mode] = process.argv.slice(2);
if (!projectDir || !port) throw new Error("dev startup worker requires a project and port");

if (mode === "edit-before-listen") {
  const skillPath = path.join(projectDir, "skills", "local-origin", "SKILL.md");
  const updatedMarkdown = readFileSync(skillPath, "utf8").replace("generation-one", "startup-edit");
  const digest = createHash("sha256").update(updatedMarkdown).digest("hex");
  const originalListen = Server.prototype.listen;
  const listen = mock.method(
    Server.prototype,
    "listen",
    function (this: Server, ...args: Parameters<Server["listen"]>) {
      writeFileSync(skillPath, updatedMarkdown);
      return Reflect.apply(originalListen, this, args);
    },
    { times: 1 },
  );
  const server = await runDevCommand({ projectDir, args: ["--port", port] });
  try {
    assert.equal(listen.mock.callCount(), 1);
    const deadline = Date.now() + 5_000;
    let published = false;
    while (Date.now() < deadline) {
      const response = await fetch(`${server.origin}/.well-known/agent-skills/index.json`);
      assert.equal(response.status, 200);
      if ((await response.text()).includes(`sha256:${digest}`)) {
        published = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert(published, "startup edit must be published without another source edit");
    const artifact = await fetch(
      `${server.origin}/.well-known/agent-skills/artifacts/sha256-${digest}.md`,
    );
    assert.equal(artifact.status, 200);
    assert.equal(await artifact.text(), updatedMarkdown);
    process.stdout.write("startup edit published\n");
  } finally {
    await server.close();
    listen.mock.restore();
  }
} else {
  const controller = new AbortController();
  const signal = new Proxy(controller.signal, {
    get(target, property): unknown {
      if (property === "addEventListener") {
        return (
          type: keyof AbortSignalEventMap,
          listener: (this: AbortSignal, event: Event) => unknown,
          options?: boolean | AddEventListenerOptions,
        ) => {
          target.addEventListener(type, listener, options);
          throw new Error("listener registration failed");
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  try {
    await runDevCommand({ projectDir, args: ["--port", port], signal });
    process.stderr.write("startup unexpectedly succeeded\n");
    process.exitCode = 2;
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "listener registration failed") {
      throw error;
    }
    process.stdout.write("startup failed as expected\n");
  }
}

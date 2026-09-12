import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { Agent } from "@mastra/core/agent";
import { createRemoteSkills } from "@remote-skills/client";
import { remoteSkills } from "@remote-skills/mastra";

const packageRoot = new URL("../", import.meta.resolve("@remote-skills/mastra"));
const manifest: unknown = JSON.parse(readFileSync(new URL("package.json", packageRoot), "utf8"));
assert.ok(manifest && typeof manifest === "object");
assert.ok(process.argv[2], "The caller supplies the exact expected package version.");
assert.equal(Reflect.get(manifest, "version"), process.argv[2]);
assert.equal(Reflect.get(manifest, "devDependencies"), undefined);
assert.equal(Reflect.get(manifest, "scripts"), undefined);
for (const file of ["README.md", "DESIGN.md", "VERIFICATION.md", "LICENSE", "dist/index.d.ts"]) {
  assert.equal(existsSync(new URL(file, packageRoot)), true, `Missing packed file: ${file}`);
}

const instruction = "Greet the visitor with a friendly ahoy.";
const artifact = Buffer.from(
  `---\nname: greeting\ndescription: A friendly greeting\n---\n${instruction}\n`,
);
let artifactRequests = 0;
const server = createServer((request, response) => {
  if (request.url === "/.well-known/agent-skills/index.json") {
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
        skills: [
          {
            name: "greeting",
            description: "A friendly greeting",
            type: "skill-md",
            url: "artifacts/greeting.md",
            digest: `sha256:${createHash("sha256").update(artifact).digest("hex")}`,
          },
        ],
      }),
    );
  } else if (request.url === "/.well-known/agent-skills/artifacts/greeting.md") {
    artifactRequests++;
    response.end(artifact);
  } else {
    response.statusCode = 404;
    response.end();
  }
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
try {
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const client = createRemoteSkills({
    origins: {
      local: { url: `http://127.0.0.1:${address.port}`, allowLoopbackHttp: true, retries: 0 },
    },
    cache: "memory",
  });
  await using integration = await remoteSkills({ client, origin: "local" });
  const agent = new Agent({
    id: "installed",
    name: "Installed",
    model: "openai/gpt-4.1",
    ...integration.agentOptions,
  });
  const tools = await agent.getToolsForExecution({});
  assert.equal(artifactRequests, 0);
  assert.deepEqual(Object.keys(tools).sort(), ["skill", "skill_read", "skill_search"]);
  assert.equal(
    JSON.stringify(await integration.agentOptions.workspace.skills?.list()).includes(instruction),
    false,
  );
  const tool = tools.skill;
  assert.ok(tool?.execute);
  const loaded = await tool.execute(
    { name: "greeting" },
    { toolCallId: "installed", messages: [] },
  );
  assert.equal(typeof loaded, "string");
  assert.ok(String(loaded).includes(instruction));
  assert.equal(artifactRequests, 1);
  const reader = tools.skill_read;
  assert.ok(reader?.execute);
  const read = await reader.execute(
    { skillName: "greeting", path: "SKILL.md" },
    { toolCallId: "read", messages: [] },
  );
  assert.equal(read === artifact.toString(), true);
  assert.equal(artifactRequests, 1);
  console.log(
    JSON.stringify({
      installedArchives: true,
      strictAlphaPeers: true,
      lockedResolution: true,
      nativeTools: ["skill", "skill_read"],
      lazyArtifactFetch: true,
      exactRead: true,
    }),
  );
} finally {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { remoteSkills } from "@remote-skills/ai-sdk";
import { createRemoteSkills } from "@remote-skills/client";

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
  assert.equal(artifactRequests, 0);
  assert.equal(integration.agentOptions.instructions.includes(instruction), false);
  const tool = integration.tools.skill;
  assert.ok(tool.execute);
  const loaded = await tool.execute(
    { skillName: "greeting" },
    { toolCallId: "installed", messages: [], context: {} },
  );
  assert.ok(loaded && typeof loaded === "object" && "success" in loaded && loaded.success);
  assert.ok("instructions" in loaded && typeof loaded.instructions === "string");
  assert.equal(loaded.instructions.trim(), instruction);
  assert.equal(artifactRequests, 1);
  assert.ok(integration.tools.readFile.execute);
  const read = await integration.tools.readFile.execute(
    { path: "skills/greeting/SKILL.md" },
    { toolCallId: "read", messages: [], context: {} },
  );
  assert.ok(
    read && typeof read === "object" && "content" in read && typeof read.content === "string",
  );
  assert.ok(read.content.includes(instruction));
  console.log(
    "Installed AI SDK integration: native discovery, lazy activation and file read passed",
  );
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

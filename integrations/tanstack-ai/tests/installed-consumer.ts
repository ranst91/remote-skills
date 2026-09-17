import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRemoteSkills } from "@remote-skills/client";
import { remoteSkills } from "@remote-skills/tanstack-ai";
import { createLoadSkillTool } from "@tanstack/ai-skills";

const packageRoot = new URL("../", import.meta.resolve("@remote-skills/tanstack-ai"));
const manifest: unknown = JSON.parse(readFileSync(new URL("package.json", packageRoot), "utf8"));
assert.ok(manifest && typeof manifest === "object");
assert.ok(process.argv[2], "The caller supplies the exact expected package version.");
assert.equal(Reflect.get(manifest, "version"), process.argv[2]);
assert.equal(Reflect.get(manifest, "devDependencies"), undefined);
assert.equal(Reflect.get(manifest, "scripts"), undefined);
for (const file of ["README.md", "LICENSE", "dist/index.d.ts"]) {
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
  assert.equal(artifactRequests, 0);
  const skills = await integration.list();
  assert.equal(JSON.stringify(skills).includes(instruction), false);
  const tool = createLoadSkillTool({ source: integration, skills, activated: new Set() });
  assert.ok(tool.execute);
  assert.deepEqual(await tool.execute({ name: "greeting" }), {
    skill: "greeting",
    content: instruction,
    resources: [],
    scripts: [],
  });
  assert.equal(artifactRequests, 1);
  console.log(
    "Installed TanStack native load passed; metadata-only discovery and verified activation.",
  );
} finally {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

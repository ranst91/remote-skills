import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnPnpmSync } from "../../../scripts/lib/pnpm-command.ts";

const repository = fileURLToPath(new URL("../../../", import.meta.url));
const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const directory = await mkdtemp(join(tmpdir(), "remote-skills-langchain-package-"));
const artifacts = join(directory, "artifacts");
const consumer = join(directory, "consumer");

function pnpm(args: string[], cwd: string) {
  const result = spawnPnpmSync(args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

try {
  await mkdir(artifacts);
  await mkdir(consumer);
  pnpm(["build"], packageRoot);
  pnpm(["pack", "--pack-destination", artifacts], packageRoot);
  pnpm(
    ["--filter", "@remote-skills/client", "pack:local", "--", "--pack-destination", artifacts],
    repository,
  );
  const tarball = join(artifacts, "remote-skills-langchain-0.0.1.tgz");
  const sdk = join(artifacts, "remote-skills-client-0.0.1.tgz");
  const listed = spawnSync("tar", ["-tf", tarball], { encoding: "utf8", shell: false });
  assert.equal(listed.status, 0, listed.stderr);
  const files = listed.stdout.trim().split("\n");
  assert.ok(files.includes("package/dist/index.js"));
  assert.ok(files.includes("package/dist/index.d.ts"));
  assert.ok(files.includes("package/LICENSE"));
  assert.ok(files.includes("package/README.md"));
  assert.ok(files.every((file) => !/\/(?:src|tests|node_modules)\//u.test(file)));
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify(
      {
        name: "remote-skills-langchain-installed-consumer",
        private: true,
        type: "module",
        dependencies: {
          "@remote-skills/langchain": `file:${tarball}`,
          "@remote-skills/client": `file:${sdk}`,
          deepagents: "1.13.4",
          langchain: "1.5.11",
          "@langchain/core": "1.2.10",
          "@langchain/langgraph": "1.4.14",
          langsmith: "0.9.0",
          zod: "4.3.6",
          typescript: "7.0.2",
          "@types/node": "24.13.3",
        },
      },
      null,
      2,
    ),
  );
  pnpm(
    [
      "install",
      "--offline",
      "--ignore-scripts",
      "--strict-peer-dependencies",
      "--config.lockfile=false",
    ],
    consumer,
  );
  await writeFile(
    join(consumer, "consumer.ts"),
    `
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRemoteSkills } from "@remote-skills/client";
import { remoteSkills } from "@remote-skills/langchain";
import { BaseChatModel, type BindToolsInput } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage, ToolMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { createAgent } from "langchain";
import { createDeepAgent } from "deepagents";
import { END, MessagesAnnotation, START, StateGraph } from "@langchain/langgraph";

const artifact = Buffer.from('---\\nname: greeting\\ndescription: Greeting\\n---\\nInstalled artifact instructions.\\n');
const digest = "sha256:" + createHash("sha256").update(artifact).digest("hex");
let downloads = 0;
const client = createRemoteSkills({ origins: { team: { url: "https://skills.example.test" } }, cache: "memory" }, {
  resolve: async () => [{ address: "93.184.216.34", family: 4 }],
  transport: async (request) => {
    const catalog = new URL(request.url).pathname.endsWith("index.json");
    if (!catalog) downloads += 1;
    return { status: 200, headers: { "content-type": catalog ? "application/json" : "text/markdown" }, body: catalog ? Buffer.from(JSON.stringify({ $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json", skills: [{ name: "greeting", description: "Greeting", type: "skill-md", url: "greeting.md", digest }] })) : artifact };
  },
});
class Model extends BaseChatModel {
  _llmType() { return "installed-model"; }
  bindTools(_tools: BindToolsInput[]) { return this; }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const loaded = messages.some(ToolMessage.isInstance);
    if (!loaded) assert.equal(downloads, 0);
    else assert.ok(JSON.stringify(messages).includes("Installed artifact instructions."));
    const message = loaded ? new AIMessage("loaded") : new AIMessage({ content: "", tool_calls: [{ id: "load", name: "read_file", args: { file_path: "/skills/greeting/SKILL.md" } }] });
    return { generations: [{ message, text: "" }] };
  }
}
await using session = await client.session("team");
await using remote = await remoteSkills({ session });
const model = new Model({});
const native = createAgent({ model, middleware: remote.middleware });
createDeepAgent({ model, ...remote.deepAgentOptions });
new StateGraph(MessagesAnnotation).addNode("skills", native.graph).addEdge(START, "skills").addEdge("skills", END).compile();
const result = await native.invoke({ messages: [{ role: "user", content: "Use greeting." }] });
assert.equal(result.messages.at(-1)?.content, "loaded");
assert.equal(downloads, 1);
console.log("Installed native LangChain consumer passed.");
`,
  );
  pnpm(
    [
      "exec",
      "tsc",
      "--noEmit",
      "--strict",
      "--exactOptionalPropertyTypes",
      "--skipLibCheck",
      "--target",
      "ES2024",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--types",
      "node",
      "--lib",
      "ES2024,ESNext.Disposable",
      "consumer.ts",
    ],
    consumer,
  );
  const result = spawnSync(process.execPath, [join(consumer, "consumer.ts")], {
    cwd: consumer,
    encoding: "utf8",
    shell: false,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  process.stdout.write(result.stdout);
  const hash = createHash("sha256")
    .update(await readFile(tarball))
    .digest("hex");
  console.log(`Local npm artifact SHA-256: ${hash}`);
} finally {
  await rm(directory, { recursive: true, force: true });
}

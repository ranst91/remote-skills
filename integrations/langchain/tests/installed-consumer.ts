import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { BaseChatModel, type BindToolsInput } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage, ToolMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { END, MessagesAnnotation, START, StateGraph } from "@langchain/langgraph";
import { createRemoteSkills } from "@remote-skills/client";
import { remoteSkills } from "@remote-skills/langchain";
import { createDeepAgent } from "deepagents";
import { createAgent } from "langchain";

const consumer = realpathSync(process.cwd());
for (const name of ["@remote-skills/client", "@remote-skills/langchain"]) {
  const installed = realpathSync(fileURLToPath(import.meta.resolve(name)));
  assert.ok(
    relative(consumer, installed).startsWith(`node_modules${sep}`),
    "Installed packages must resolve inside the isolated consumer.",
  );
}
const entrypoint = fileURLToPath(import.meta.resolve("@remote-skills/langchain"));
const manifest: unknown = JSON.parse(
  readFileSync(join(dirname(entrypoint), "../package.json"), "utf8"),
);
assert.ok(manifest && typeof manifest === "object" && "version" in manifest);
assert.equal(manifest.version, process.argv[2]);

const instructions = "Installed artifact instructions.";
const artifact = Buffer.from(
  `---\nname: greeting\ndescription: Use this skill for greetings.\n---\n${instructions}\n`,
);
const digest = `sha256:${createHash("sha256").update(artifact).digest("hex")}`;

for (const mode of ["deepagents", "langchain", "langgraph"] as const) {
  let downloads = 0;
  const client = createRemoteSkills(
    { origins: { team: { url: "https://skills.example.test" } }, cache: "memory" },
    {
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      transport: async (request) => {
        const catalog = new URL(request.url).pathname.endsWith("index.json");
        if (!catalog) downloads += 1;
        return {
          status: 200,
          headers: { "content-type": catalog ? "application/json" : "text/markdown" },
          body: catalog
            ? Buffer.from(
                JSON.stringify({
                  $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
                  skills: [
                    {
                      name: "greeting",
                      description: "Use this skill for greetings.",
                      type: "skill-md",
                      url: "greeting.md",
                      digest,
                    },
                  ],
                }),
              )
            : artifact,
        };
      },
    },
  );
  class Model extends BaseChatModel {
    calls = 0;
    _llmType() {
      return "installed-langchain-fixture";
    }
    bindTools(_tools: BindToolsInput[]) {
      return this;
    }
    async _generate(messages: BaseMessage[]): Promise<ChatResult> {
      this.calls += 1;
      const loaded = messages.find(ToolMessage.isInstance);
      if (loaded) {
        assert.ok(String(loaded.content).includes(instructions));
        assert.equal(downloads, 1);
      } else {
        assert.equal(downloads, 0, "Native discovery must remain metadata-only.");
        assert.ok(JSON.stringify(messages).includes("/skills/greeting/SKILL.md"));
        assert.ok(!JSON.stringify(messages).includes(instructions));
      }
      const message = loaded
        ? new AIMessage("loaded")
        : new AIMessage({
            content: "",
            tool_calls: [
              {
                id: "load",
                name: "read_file",
                args: { file_path: "/skills/greeting/SKILL.md" },
              },
            ],
          });
      return { generations: [{ message, text: "" }] };
    }
  }
  await using session = await client.session("team");
  await using remote = await remoteSkills({ session });
  const model = new Model({});
  const native = createAgent({ model, middleware: remote.middleware });
  const agent =
    mode === "deepagents"
      ? createDeepAgent({ model, ...remote.deepAgentOptions })
      : mode === "langchain"
        ? native
        : new StateGraph(MessagesAnnotation)
            .addNode("skills", native.graph)
            .addEdge(START, "skills")
            .addEdge("skills", END)
            .compile();
  const result = await agent.invoke({
    messages: [{ role: "user", content: "Use the greeting skill." }],
  });
  assert.equal(result.messages.at(-1)?.content, "loaded");
  assert.equal(downloads, 1);
  assert.equal(model.calls, 2);
}
console.log("Installed DeepAgents, LangChain, and LangGraph consumers passed.");

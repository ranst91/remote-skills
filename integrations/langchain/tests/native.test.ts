import assert from "node:assert/strict";
import test from "node:test";
import { BaseChatModel, type BindToolsInput } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage, ToolMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { END, MessagesAnnotation, START, StateGraph } from "@langchain/langgraph";
import { createDeepAgent } from "deepagents";
import { createAgent } from "langchain";
import { fixture, INSTRUCTIONS, TEXT, TOKEN } from "../../ai-sdk/tests/fixture.ts";
import { remoteSkills } from "../src/index.ts";

/** A deterministic model, with actual upstream model/tool/graph execution. */
class SkillSelectingModel extends BaseChatModel {
  readonly requested: boolean;
  readonly artifactCount: () => number;
  calls = 0;
  boundTools: string[] = [];

  constructor(requested: boolean, artifactCount: () => number) {
    super({});
    this.requested = requested;
    this.artifactCount = artifactCount;
  }
  _llmType() {
    return "remote-skills-deterministic-model";
  }
  bindTools(tools: BindToolsInput[]) {
    this.boundTools = tools.flatMap((tool) =>
      "name" in tool && typeof tool.name === "string" ? [tool.name] : [],
    );
    return this;
  }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.calls += 1;
    const system = messages
      .filter((message) => message.getType() === "system")
      .map((message) =>
        typeof message.content === "string" ? message.content : JSON.stringify(message.content),
      )
      .join("\n");
    assert.match(system, /Available Skills/);
    assert.match(system, /greeting/);
    assert.match(system, /\/skills\/greeting\/SKILL\.md/);
    assert.ok(!system.includes(INSTRUCTIONS));
    assert.ok(!JSON.stringify(messages).includes(TOKEN));
    assert.ok(this.boundTools.includes("read_file"));
    assert.ok(!this.boundTools.includes("execute"));
    assert.ok(!this.boundTools.includes("write_file"));
    const results = messages.filter(ToolMessage.isInstance);
    let response: AIMessage;
    if (!this.requested) {
      assert.equal(this.artifactCount(), 0);
      response = new AIMessage("Direct answer without a matching skill.");
    } else if (results.length === 0) {
      assert.equal(this.artifactCount(), 0);
      response = new AIMessage({
        content: "",
        tool_calls: [
          {
            id: "skill-read",
            name: "read_file",
            args: { file_path: "/skills/greeting/SKILL.md", limit: 1000 },
          },
        ],
      });
    } else if (results.length === 1) {
      assert.equal(this.artifactCount(), 1);
      assert.ok(JSON.stringify(results[0]?.content).includes(INSTRUCTIONS));
      assert.ok(!JSON.stringify(results[0]?.content).includes(TEXT));
      response = new AIMessage({
        content: "",
        tool_calls: [
          {
            id: "resource-read",
            name: "read_file",
            args: { file_path: "/skills/greeting/references/greeting.md" },
          },
        ],
      });
    } else {
      assert.equal(this.artifactCount(), 1);
      assert.ok(JSON.stringify(results[1]?.content).includes(`${TEXT} 1.0.0`));
      response = new AIMessage(TEXT);
    }
    return {
      generations: [
        { message: response, text: typeof response.content === "string" ? response.content : "" },
      ],
    };
  }
}

class DelegatingModel extends SkillSelectingModel {
  readonly subagentType: string;

  constructor(artifactCount: () => number, subagentType: string) {
    super(true, artifactCount);
    this.subagentType = subagentType;
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const delegated = messages.some(
      (message) =>
        message.getType() === "human" && String(message.content).includes("DELEGATED_GREETING"),
    );
    if (delegated) return super._generate(messages);
    const completed = messages.find(ToolMessage.isInstance);
    if (completed) assert.ok(JSON.stringify(completed.content).includes(TEXT));
    else assert.equal(this.artifactCount(), 0);
    const message = completed
      ? new AIMessage("Delegated greeting completed.")
      : new AIMessage({
          content: "",
          tool_calls: [
            {
              id: "delegate",
              name: "task",
              args: {
                subagent_type: this.subagentType,
                description: "DELEGATED_GREETING: Use the greeting skill to greet me.",
              },
            },
          ],
        });
    return { generations: [{ message, text: "" }] };
  }
}

for (const subagentType of ["general-purpose", "specialist"]) {
  test(`DeepAgents ${subagentType} subagent receives native metadata and the shared verified pin`, async () => {
    const host = fixture();
    await using session = await host.client.session("team");
    await using remote = await remoteSkills({ session, versions: { greeting: "^1.0.0" } });
    const model = new DelegatingModel(() => host.artifactRequests().length, subagentType);
    const agent = createDeepAgent({
      model,
      ...remote.deepAgentOptions,
      ...(subagentType === "specialist"
        ? {
            subagents: [
              {
                name: "specialist",
                description: "Greeting specialist",
                systemPrompt: "Use the available greeting skill.",
                middleware: remote.middleware,
              },
            ],
          }
        : {}),
    });
    const result = await agent.invoke({
      messages: [{ role: "user", content: "Delegate a greeting to the general-purpose agent." }],
    });
    assert.equal(result.messages.at(-1)?.content, "Delegated greeting completed.");
    assert.equal(host.artifactRequests().length, 1);
    await remote.contentBackend.read("/skills/greeting/SKILL.md");
    assert.equal(host.artifactRequests().length, 1);
  });
}

for (const mode of ["deepagents", "langchain", "langgraph-subgraph"] as const) {
  for (const requested of [true, false]) {
    test(`${mode}: native metadata discovery, selection=${requested}, loading and context-lazy resource access`, async () => {
      const host = fixture();
      await using session = await host.client.session("team");
      await using remote = await remoteSkills({ session, versions: { greeting: "^1.0.0" } });
      const model = new SkillSelectingModel(requested, () => host.artifactRequests().length);
      const native =
        mode === "deepagents"
          ? createDeepAgent({
              model,
              ...remote.deepAgentOptions,
            })
          : createAgent({ model, middleware: remote.middleware });
      const agent =
        mode === "langgraph-subgraph"
          ? new StateGraph(MessagesAnnotation)
              .addNode("prepare", () => ({}))
              .addNode("nativeSkills", native.graph)
              .addNode("complete", () => ({}))
              .addEdge(START, "prepare")
              .addEdge("prepare", "nativeSkills")
              .addEdge("nativeSkills", "complete")
              .addEdge("complete", END)
              .compile()
          : native;
      const result = await agent.invoke({
        messages: [
          {
            role: "user",
            content: requested ? "Greet me using the greeting skill." : "What is two plus two?",
          },
        ],
      });
      assert.equal(
        result.messages.at(-1)?.content,
        requested ? TEXT : "Direct answer without a matching skill.",
      );
      assert.equal(host.artifactRequests().length, requested ? 1 : 0);
      assert.equal(model.calls, requested ? 3 : 1);
      assert.equal(remote.middleware[0].name, "SkillsMiddleware");
      assert.equal(remote.middleware[1].name, "FilesystemMiddleware");
    });
  }
}

import assert from "node:assert/strict";
import test from "node:test";
import { Agent } from "@mastra/core/agent";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { remoteSkills } from "../src/index.ts";
import { fixture, INSTRUCTIONS, TEXT } from "./fixture.ts";

type StreamChunk =
  Awaited<ReturnType<MockLanguageModelV4["doStream"]>>["stream"] extends ReadableStream<infer Chunk>
    ? Chunk
    : never;
const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

test("the actual Mastra model loop sees native instructions, then resource contents, then answers", async () => {
  const f = fixture();
  await using remote = await remoteSkills({ client: f.client, origin: "team" });
  let calls = 0;
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      const call = calls++;
      const prompt = JSON.stringify(options.prompt);
      if (call === 0) {
        assert.equal(f.artifactRequests().length, 0);
        assert.equal(prompt.includes(INSTRUCTIONS), false);
        assert.ok(prompt.includes("greeting"));
      } else {
        assert.equal(f.artifactRequests().length, 1);
        assert.ok(
          prompt.includes(INSTRUCTIONS),
          "Native instructions must be present in the next model step",
        );
        if (call === 2)
          assert.ok(
            prompt.includes(`${TEXT} 2.0.0`),
            "The native reference result must reach the final model step",
          );
      }
      const chunks: StreamChunk[] =
        call < 2
          ? [
              {
                type: "tool-call",
                toolCallId: `call-${call}`,
                toolName: call === 0 ? "skill" : "skill_read",
                input: JSON.stringify(
                  call === 0
                    ? { name: "greeting" }
                    : { skillName: "greeting", path: "references/greeting.md" },
                ),
              },
              { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage },
            ]
          : [
              { type: "text-start", id: "answer" },
              { type: "text-delta", id: "answer", delta: "Verified answer." },
              { type: "text-end", id: "answer" },
              { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
            ];
      return { stream: simulateReadableStream({ chunks }) };
    },
  });
  const agent = new Agent({
    id: "native-loop",
    name: "Native loop",
    model,
    ...remote.agentOptions,
  });
  const result = await agent.stream("Hello!", { maxSteps: 5 });
  const events = [];
  for await (const event of result.fullStream) events.push(event);
  assert.equal(await result.text, "Verified answer.");
  assert.equal(calls, 3);
  assert.deepEqual(
    events.filter((event) => event.type === "tool-call").map((event) => event.payload.toolName),
    ["skill", "skill_read"],
  );
});

test("a direct Mastra answer is permitted with zero artifact requests", async () => {
  const f = fixture();
  await using remote = await remoteSkills({ client: f.client, origin: "team" });
  const model = new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream<StreamChunk>({
        chunks: [
          { type: "text-start", id: "answer" },
          { type: "text-delta", id: "answer", delta: "Four." },
          { type: "text-end", id: "answer" },
          { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
        ],
      }),
    }),
  });
  const agent = new Agent({ id: "direct", name: "Direct", model, ...remote.agentOptions });
  const result = await agent.stream("What is two plus two?");
  assert.equal(await result.text, "Four.");
  assert.equal(f.artifactRequests().length, 0);
});

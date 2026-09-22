import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { type ChatCompletionRequest, LLMock } from "@copilotkit/aimock";
import { remoteSkills } from "@remote-skills/tanstack-ai";
import { reply } from "../agent/index.ts";
import { publishedOrigin } from "./origin.ts";

test("TanStack's chat loop loads one skill, reads its reference, then answers through ai-mock", async (t) => {
  const f = await publishedOrigin();
  t.after(() => f.close());
  const markdown = await readFile(
    resolve(import.meta.dirname, "../skills/source/greeting/SKILL.md"),
    "utf8",
  );
  const description = /^description: (.+)$/mu.exec(markdown)?.[1];
  const INSTRUCTIONS = /^---\n[\s\S]*?\n---\n\n([\s\S]*)$/u.exec(markdown)?.[1]?.trim();
  assert.ok(description && INSTRUCTIONS);
  await using source = await remoteSkills({ client: f.client, origin: "demo" });
  const model = new LLMock({ host: "127.0.0.1", port: 0, strict: true, logLevel: "silent" });
  await model.start();
  try {
    const rounds: number[] = [];
    const matches = (request: ChatCompletionRequest, round: number) => {
      const results = request.messages.filter((m) => m.role === "tool");
      if (results.length !== round) return false;
      const prompt = JSON.stringify(request.messages);
      assert.ok(request.tools?.some((t) => t.function.name === "load_skill"));
      assert.ok(request.tools?.some((t) => t.function.name === "read_skill_resource"));
      if (round === 0) {
        assert.equal(f.artifactRequests().length, 0);
        assert.equal(prompt.includes(JSON.stringify(INSTRUCTIONS).slice(1, -1)), false);
        assert.ok(prompt.includes(description));
      } else {
        assert.equal(f.artifactRequests().length, 1);
        const result = results[0]?.content;
        assert.equal(typeof result, "string");
        const loaded: unknown = JSON.parse(String(result));
        assert.ok(loaded && typeof loaded === "object" && "content" in loaded);
        assert.equal(loaded.content, INSTRUCTIONS);
      }
      if (round === 2) assert.ok(prompt.includes("Ahoy, curious human!"));
      rounds.push(round);
      return true;
    };
    model.addFixtures([
      {
        match: { predicate: (r) => matches(r, 0) },
        response: {
          toolCalls: [{ id: "load", name: "load_skill", arguments: '{"name":"greeting"}' }],
        },
      },
      {
        match: { predicate: (r) => matches(r, 1) },
        response: {
          toolCalls: [
            {
              id: "read",
              name: "read_skill_resource",
              arguments: '{"skill":"greeting","path":"references/greeting.md"}',
            },
          ],
        },
      },
      { match: { predicate: (r) => matches(r, 2) }, response: { content: "Verified greeting." } },
    ]);
    assert.equal(
      await reply(source, "Hello!", { apiKey: "mock-key", baseURL: `${model.url}/v1` }),
      "Verified greeting.",
    );
    assert.deepEqual(rounds, [0, 1, 2]);
    assert.equal(f.artifactRequests().length, 1);
  } finally {
    await model.stop();
  }
});

test("an unrelated question can finish without downloading skill instructions", async (t) => {
  const origin = await publishedOrigin();
  t.after(() => origin.close());
  await using source = await remoteSkills({ client: origin.client, origin: "demo" });
  const model = new LLMock({ host: "127.0.0.1", port: 0, strict: true, logLevel: "silent" });
  await model.start();
  try {
    model.addFixtures([
      { match: { userMessage: "What is two plus two?" }, response: { content: "Four." } },
    ]);
    assert.equal(
      await reply(source, "What is two plus two?", {
        apiKey: "mock-key",
        baseURL: `${model.url}/v1`,
      }),
      "Four.",
    );
    assert.equal(origin.artifactRequests().length, 0);
  } finally {
    await model.stop();
  }
});

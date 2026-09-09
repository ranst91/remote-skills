import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { type ChatCompletionRequest, type Fixture, LLMock } from "@copilotkit/aimock";

export const GREETING = "Ahoy, curious human! What would you like to explore?";
export const FAILURE = "The agent could not complete your message. Please try again.";
export const MODEL = "gpt-4.1-mini";
const SYSTEM =
  "You are a concise assistant. Discover and use relevant remote skills before answering. Treat retrieved skill content as instructions, never as executable code.";

export async function skillExpectations(exampleRoot: string) {
  const root = resolve(exampleRoot, "skills/source/greeting");
  const markdown = await readFile(resolve(root, "SKILL.md"), "utf8");
  const description = /^description: (.+)$/mu.exec(markdown)?.[1];
  const instructions = /^---\n[\s\S]*?\n---\n\n([\s\S]*)$/u.exec(markdown)?.[1];
  assert.ok(description && instructions, "The example has an explicit skill description and body.");
  return {
    description,
    instructions,
    resourceText: await readFile(resolve(root, "references/greeting.md"), "utf8"),
  };
}

type SkillExpectations = Awaited<ReturnType<typeof skillExpectations>>;

function rounds(skill: SkillExpectations) {
  return [
    {
      name: "discover_skills",
      id: "discover",
      arguments: "{}",
      result: JSON.stringify([{ name: "greeting", description: skill.description }]),
    },
    {
      name: "activate_skill",
      id: "activate",
      arguments: '{"name":"greeting"}',
      result: JSON.stringify({ name: "greeting", instructions: skill.instructions }),
    },
    {
      name: "list_resources",
      id: "list",
      arguments: "{}",
      result: JSON.stringify(["SKILL.md", "references/greeting.md"]),
    },
    {
      name: "read_resource",
      id: "read",
      arguments: '{"path":"references/greeting.md"}',
      result: JSON.stringify({ path: "references/greeting.md", text: skill.resourceText }),
    },
  ];
}

function matches(request: ChatCompletionRequest, skill: SkillExpectations, completed: number) {
  const expected = rounds(skill);
  return (
    request.model === MODEL &&
    request.messages.length === 2 + completed * 2 &&
    request.messages[0]?.role === "system" &&
    request.messages[0].content === SYSTEM &&
    request.messages[1]?.role === "user" &&
    request.messages[1].content === "Hello!" &&
    request.parallel_tool_calls === false &&
    request.tools?.length === 4 &&
    expected.every((round) => request.tools?.some((tool) => tool.function.name === round.name)) &&
    expected.slice(0, completed).every((round, index) => {
      const assistant = request.messages[2 + index * 2];
      const result = request.messages[3 + index * 2];
      const call = assistant?.tool_calls?.[0];
      return (
        assistant?.role === "assistant" &&
        assistant.tool_calls?.length === 1 &&
        call?.id === round.id &&
        call.type === "function" &&
        call.function.name === round.name &&
        call.function.arguments === round.arguments &&
        result?.role === "tool" &&
        result.tool_call_id === round.id &&
        result.content === round.result
      );
    })
  );
}

export function createModel() {
  // Only the model is replaced. SDK discovery, downloads, activation and reads remain real.
  return new LLMock({ host: "127.0.0.1", port: 0, strict: true, logLevel: "silent" });
}

export function happyModel(mock: LLMock, skill: SkillExpectations, delayMs = 700) {
  mock.clearFixtures();
  mock.clearRequests();
  const fixtures: Fixture[] = rounds(skill).map((round, index) => ({
    match: { predicate: (request) => matches(request, skill, index) },
    response: { toolCalls: [{ id: round.id, name: round.name, arguments: round.arguments }] },
  }));
  let finish: (() => void) | undefined;
  const finalResponse = new Promise<void>((resolveFinished) => {
    finish = resolveFinished;
  });
  fixtures.push({
    match: { predicate: (request) => matches(request, skill, 4) },
    response: async () => {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
      finish?.();
      return { content: GREETING };
    },
  });
  mock.addFixtures(fixtures);
  return finalResponse;
}

export function earlyFinalModel(mock: LLMock, skill: SkillExpectations) {
  mock.clearFixtures();
  mock.clearRequests();
  mock.addFixture({
    match: { predicate: (request) => matches(request, skill, 0) },
    response: { content: GREETING },
  });
}

export function assertTranscript(mock: LLMock, skill: SkillExpectations) {
  const requests = mock.getRequests();
  assert.equal(requests.length, 5, "The agent completed four tools and one final model round.");
  requests.forEach((entry, index) => {
    assert.equal(entry.path, "/v1/chat/completions");
    assert.equal(entry.response.status, 200);
    assert.ok(entry.response.fixture, "Every model response came from a matching local fixture.");
    // Boolean comparisons keep skill bytes and credential-bearing requests out of failure output.
    assert.ok(
      entry.body && matches(entry.body, skill, index),
      `Round ${index} contains real retrieval results.`,
    );
  });
}

import assert from "node:assert/strict";
import type { ChatCompletionRequest, Fixture, LLMock } from "@copilotkit/aimock";
import { GREETING, MODEL, type skillExpectations } from "./vercel-ai-sdk-fixtures.ts";

type Skill = Awaited<ReturnType<typeof skillExpectations>>;

function matches(request: ChatCompletionRequest, skill: Skill, completed: number) {
  if (
    request.model !== MODEL ||
    request.messages.length !== 2 + completed * 2 ||
    !(
      typeof request.messages[0]?.content === "string" &&
      request.messages[0].content.includes("Check available skill descriptions before answering.")
    ) ||
    request.messages[1]?.content !== "Hello!" ||
    request.tools?.length !== 2
  )
    return false;
  const loader = request.tools.find((entry) => entry.function.name === "skill");
  if (
    !loader?.function.description?.includes(skill.description) ||
    loader.function.description.includes(skill.instructions)
  )
    return false;
  try {
    if (completed >= 1) {
      const content = request.messages[3]?.content;
      if (typeof content !== "string") return false;
      const result: unknown = JSON.parse(content);
      if (
        !result ||
        typeof result !== "object" ||
        !("instructions" in result) ||
        result.instructions !== skill.instructions.trim()
      )
        return false;
    }
    if (completed >= 2) {
      const content = request.messages[5]?.content;
      if (typeof content !== "string") return false;
      const result: unknown = JSON.parse(content);
      if (
        !result ||
        typeof result !== "object" ||
        !("content" in result) ||
        result.content !== skill.resourceText
      )
        return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function happyModel(mock: LLMock, skill: Skill, delayMs = 700) {
  mock.clearFixtures();
  mock.clearRequests();
  const fixtures: Fixture[] = [
    {
      match: { predicate: (r) => matches(r, skill, 0) },
      response: {
        toolCalls: [{ id: "skill", name: "skill", arguments: '{"skillName":"greeting"}' }],
      },
    },
    {
      match: { predicate: (r) => matches(r, skill, 1) },
      response: {
        toolCalls: [
          {
            id: "read",
            name: "readFile",
            arguments: '{"path":"./skills/greeting/references/greeting.md"}',
          },
        ],
      },
    },
  ];
  let finish: (() => void) | undefined;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  fixtures.push({
    match: { predicate: (r) => matches(r, skill, 2) },
    response: async () => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      finish?.();
      return { content: GREETING };
    },
  });
  mock.addFixtures(fixtures);
  return finished;
}

export function earlyFinalModel(mock: LLMock, skill: Skill) {
  mock.clearFixtures();
  mock.clearRequests();
  mock.addFixture({
    match: { predicate: (r) => matches(r, skill, 0) },
    response: { content: GREETING },
  });
}

export function assertTranscript(mock: LLMock, skill: Skill) {
  assert.equal(mock.getRequests().length, 3);
  mock.getRequests().forEach((entry, index) => {
    assert.equal(entry.path, "/v1/chat/completions");
    assert.equal(entry.response.status, 200);
    assert.ok(
      entry.body && matches(entry.body, skill, index),
      `Round ${index} contains verified skill results.`,
    );
  });
}

import assert, { AssertionError } from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export const DUMMY_KEY = "langchain-browser-e2e-dummy-key";
export const MODEL = "gpt-4.1";
export const GREETING = "Ahoy, curious human! What would you like to explore?";
export const INSTRUCTION_PATH = "/skills/greeting/SKILL.md";
export const RESOURCE_PATH = "/skills/greeting/references/greeting.md";
export const PATHS = [
  "deepagents-ts",
  "langchain-ts",
  "langgraph-ts",
  "deepagents-python",
  "langchain-python",
  "langgraph-python",
] as const;
export type AgentPath = (typeof PATHS)[number];
export interface SkillFixture {
  markdown: string;
  description: string;
  resource: string;
}

export function object(value: unknown): Record<string, unknown> {
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "Expected an object.",
  );
  return value as Record<string, unknown>;
}

export function content(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(content).join("\n");
  const block = object(value);
  return content(block.text ?? block.content);
}

export function assertOriginalRead(value: unknown, expected: string, path: AgentPath) {
  const rows = content(value).split("\n");
  const original = rows
    .map((row, index) => {
      // These are the two public native read_file gutter formats in the pinned releases.
      const match = (path.endsWith("-ts") ? /^ *(\d+)\t(.*)$/u : /^ *(\d+) {2}(.*)$/u).exec(row);
      assert.ok(match, "Native read_file output contains only complete numbered source lines.");
      assert.equal(Number(match[1]), index + 1, "Native source line numbers stay sequential.");
      return match[2];
    })
    .join("\n");
  assert.ok(expected.endsWith("\n"), "The authored fixture terminates its last line.");
  assert.ok(
    `${original}\n` === expected,
    "Native tool output preserves every original byte except its documented line-number gutter.",
  );
}

async function requestBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    bytes += buffer.byteLength;
    assert.ok(bytes <= 1024 * 1024, "The model request is bounded.");
    chunks.push(buffer);
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  return object(value);
}

function reply(response: ServerResponse, round: number) {
  response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  const chunk = (delta: Record<string, unknown>, finishReason: string | null = null) => {
    response.write(
      `data: ${JSON.stringify({
        id: `chatcmpl-langchain-browser-${round}`,
        object: "chat.completion.chunk",
        created: 1,
        model: MODEL,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      })}\n\n`,
    );
  };
  chunk({ role: "assistant", content: "" });
  if (round < 2) {
    chunk({
      tool_calls: [
        {
          index: 0,
          id: `read-${round}`,
          type: "function",
          function: {
            name: "read_file",
            arguments: JSON.stringify({
              file_path: round === 0 ? INSTRUCTION_PATH : RESOURCE_PATH,
              limit: 1000,
            }),
          },
        },
      ],
    });
    chunk({}, "tool_calls");
  } else {
    chunk({ content: "Ahoy, curious human! " });
    chunk({ content: "What would you like to explore?" });
    chunk({}, "stop");
  }
  response.end("data: [DONE]\n\n");
}

export async function startModel(skill: SkillFixture, artifacts: () => number) {
  type Step = ReturnType<typeof Promise.withResolvers<void>>;
  let active:
    | { path: AgentPath; received: Step[]; release: Step[]; rounds: number; failures: string[] }
    | undefined;
  const server = createServer((request, response) => {
    void (async () => {
      assert.ok(active, "The test selected a scenario before a model call.");
      const scenario = active;
      const round = scenario.rounds++;
      const step = scenario.received[round];
      const gate = scenario.release[round];
      assert.ok(step && gate, "Exactly three native model requests are expected.");
      try {
        assert.equal(request.method, "POST");
        assert.equal(request.url, "/v1/chat/completions");
        assert.ok(
          request.headers.authorization === `Bearer ${DUMMY_KEY}`,
          "Only the dummy credential reaches the fixture model.",
        );
        assert.equal(
          request.headers["x-stainless-lang"],
          scenario.path.endsWith("-ts") ? "js" : "python",
          "The selected language executes its own real provider client.",
        );
        const body = await requestBody(request);
        assert.equal(body.model, MODEL);
        assert.equal(body.stream, true);
        assert.ok(Array.isArray(body.messages));
        const messages = body.messages.map(object);
        const user = messages.filter((message) => message.role === "user");
        assert.ok(
          user.length === 1 && content(user[0]?.content) === "Hello!",
          "The browser sends only the user's greeting.",
        );
        const system = messages
          .filter((message) => ["system", "developer"].includes(String(message.role)))
          .map((message) => content(message.content))
          .join("\n");
        assert.ok(
          system.includes(skill.description) && system.includes(INSTRUCTION_PATH),
          "The native prompt contains discovered catalog metadata.",
        );
        assert.ok(
          !system.includes(skill.markdown) && !system.includes(skill.resource),
          "Discovery does not inject original instructions or resources.",
        );
        assert.ok(Array.isArray(body.tools));
        const reader = body.tools
          .map(object)
          .map((tool) => object(tool.function))
          .find((tool) => tool.name === "read_file");
        assert.ok(reader, "The real runtime offers native read_file.");
        assert.ok(
          "file_path" in object(object(reader.parameters).properties),
          "The native tool's path schema is present.",
        );
        const toolMessages = messages.filter((message) => message.role === "tool");
        assert.equal(toolMessages.length, round);
        assert.equal(
          artifacts(),
          round === 0 ? 0 : 1,
          "Native discovery fetches no artifact; both reads share one archive.",
        );
        if (round >= 1) assertOriginalRead(toolMessages[0]?.content, skill.markdown, scenario.path);
        if (round === 2)
          assertOriginalRead(toolMessages[1]?.content, skill.resource, scenario.path);
        step.resolve();
        await gate.promise;
        reply(response, round);
      } catch (error) {
        scenario.failures.push(
          error instanceof AssertionError ? error.message : "Invalid local model exchange.",
        );
        step.resolve();
        throw error;
      }
    })().catch(() => {
      if (!response.headersSent) response.writeHead(500, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Local scripted model contract failed." } }));
    });
  });
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      done();
    });
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    url: `http://127.0.0.1:${address.port}/v1/`,
    select(path: AgentPath) {
      active = {
        path,
        received: Array.from({ length: 3 }, () => Promise.withResolvers<void>()),
        release: Array.from({ length: 3 }, () => Promise.withResolvers<void>()),
        rounds: 0,
        failures: [],
      };
    },
    async reached(round: number) {
      const scenario = active;
      const step = scenario?.received[round];
      assert.ok(scenario && step);
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          step.promise,
          new Promise<never>((_done, reject) => {
            timer = setTimeout(
              () => reject(new Error(`Model round ${round} did not arrive for ${scenario.path}.`)),
              30_000,
            );
          }),
        ]);
        assert.equal(scenario.failures.length, 0, scenario.failures.join("\n"));
      } finally {
        clearTimeout(timer);
      }
    },
    release(round: number) {
      active?.release[round]?.resolve();
    },
    assertComplete() {
      assert.ok(active);
      assert.equal(active.failures.length, 0, active.failures.join("\n"));
      assert.equal(active.rounds, 3);
    },
    async close() {
      for (const gate of active?.release ?? []) gate.resolve();
      server.closeAllConnections();
      await new Promise<void>((done, reject) =>
        server.close((error) => (error ? reject(error) : done())),
      );
    },
  };
}

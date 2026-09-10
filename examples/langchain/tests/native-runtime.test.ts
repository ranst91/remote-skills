import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { runRemoteSkills } from "../../../tests/examples/helpers/public-cli.ts";
import {
  startStaticOrigin,
  staticResourceKind,
} from "../../../tests/examples/helpers/static-host.ts";
import { POST } from "../app/api/chat/route.ts";
import type { AgentPath, ChatEvent } from "../server/typescript-agent.ts";

const example = resolve(import.meta.dirname, "..");
const greeting = "Ahoy, curious human! What would you like to explore?";
const modelName = "gpt-4.1-mini";
const dummyKey = "local-native-runtime-test-key";
const instructionPath = "/skills/greeting/SKILL.md";
const resourcePath = "/skills/greeting/references/greeting.md";
const paths: readonly (
  | AgentPath
  | "deepagents-python"
  | "langchain-python"
  | "langgraph-python"
)[] = [
  "deepagents-ts",
  "langchain-ts",
  "langgraph-ts",
  "deepagents-python",
  "langchain-python",
  "langgraph-python",
];

function object(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function content(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(content).join("\n");
  if (value && typeof value === "object") {
    if ("text" in value) return content(value.text);
    if ("content" in value) return content(value.content);
  }
  return "";
}

function assertLines(actual: string, expected: string) {
  for (const line of expected.trim().split("\n").filter(Boolean)) {
    assert.ok(actual.includes(line), "Native output preserves each exact fixture line.");
  }
}

function toolInput(event: ChatEvent | undefined, path: string): Record<string, unknown> {
  const input = object(event?.input);
  if (!path.endsWith("-ts")) return input;
  // LangChain JS v2 callbacks wrap serialized tool arguments in { input }.
  // The demo preserves that native event; the Python bridge exposes parsed fields.
  assert.equal(typeof input.input, "string");
  const parsed: unknown = JSON.parse(String(input.input));
  return object(parsed);
}

async function readRequest(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += bytes.length;
    assert.ok(size <= 1024 * 1024, "The fixture model request is bounded.");
    chunks.push(bytes);
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  return object(parsed);
}

function streamResponse(response: ServerResponse, round: number) {
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  function chunk(delta: Record<string, unknown>, finishReason: string | null = null) {
    response.write(
      `data: ${JSON.stringify({
        id: `chatcmpl-local-${round}`,
        object: "chat.completion.chunk",
        created: 1,
        model: modelName,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      })}\n\n`,
    );
  }
  chunk({ role: "assistant", content: "" });
  if (round < 2) {
    chunk({
      tool_calls: [
        {
          index: 0,
          id: round === 0 ? "read-instructions" : "read-reference",
          type: "function",
          function: {
            name: "read_file",
            arguments: JSON.stringify({
              file_path: round === 0 ? instructionPath : resourcePath,
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

async function modelServer(instructions: string, resource: string, artifactCount: () => number) {
  let requests = 0;
  const failures: unknown[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/v1/chat/completions");
      assert.ok(
        request.headers.authorization === `Bearer ${dummyKey}`,
        "Only the dummy model credential is sent.",
      );
      const body = await readRequest(request);
      assert.equal(body.model, modelName);
      assert.equal(body.stream, true);
      assert.ok(Array.isArray(body.messages));
      const messages = body.messages.map(object);
      const system = messages
        .filter((message) => ["system", "developer"].includes(String(message.role)))
        .map((message) => content(message.content))
        .join("\n");
      assert.match(system, /greeting/);
      assert.match(system, /\/skills\/greeting\/SKILL\.md/);
      assert.ok(!system.includes(instructions.trim()));
      assert.ok(Array.isArray(body.tools));
      const reader = body.tools
        .map(object)
        .map((tool) => object(tool.function))
        .find((tool) => tool.name === "read_file");
      assert.ok(reader, "The actual agent advertises the native read_file tool.");
      assert.equal(typeof reader.description, "string");
      assert.ok("file_path" in object(object(reader.parameters).properties));
      const tools = messages.filter((message) => message.role === "tool");
      const round = requests++;
      assert.ok(round < 3, "Each deterministic run has exactly three model requests.");
      assert.equal(tools.length, round);
      assert.equal(artifactCount(), round === 0 ? 0 : 1);
      if (round >= 1) {
        const loaded = content(tools[0]?.content);
        assertLines(loaded, instructions);
        assert.match(loaded, /references\/greeting\.md/);
        assert.ok(!loaded.includes("Ahoy, curious human!"));
      }
      if (round === 2) assertLines(content(tools[1]?.content), resource);
      streamResponse(response, round);
    })().catch((error: unknown) => {
      failures.push(error);
      if (!response.headersSent) response.writeHead(500, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          error: { message: "Local fixture request failed", type: "fixture_error" },
        }),
      );
    });
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    url: `http://127.0.0.1:${address.port}/v1/`,
    assertComplete() {
      assert.equal(failures.length, 0, String(failures[0] ?? ""));
      assert.equal(requests, 3);
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolveClose, rejectClose) =>
        server.close((error) => (error ? rejectClose(error) : resolveClose())),
      );
    },
  };
}

function configureEnvironment(origin: string, model: string) {
  const values: Record<string, string | undefined> = {
    OPENAI_API_KEY: dummyKey,
    OPENAI_MODEL: modelName,
    OPENAI_BASE_URL: model,
    OPENAI_API_BASE: undefined,
    OPENAI_ORGANIZATION: undefined,
    OPENAI_ORG_ID: undefined,
    OPENAI_PROJECT: undefined,
    REMOTE_SKILLS_EXAMPLE_TEST: "1",
    REMOTE_SKILLS_ORIGIN: origin,
    LANGSMITH_TRACING: "false",
    LANGCHAIN_TRACING_V2: "false",
    LANGCHAIN_TRACING: "false",
    LANGSMITH_API_KEY: undefined,
    LANGCHAIN_API_KEY: undefined,
    NO_PROXY: "127.0.0.1,localhost,::1",
    no_proxy: "127.0.0.1,localhost,::1",
  };
  const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

async function readEvents(response: Response, events: ChatEvent[]) {
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /application\/x-ndjson/);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.ok(response.body);
  const decoder = new TextDecoder();
  let pending = "";
  for await (const chunk of response.body) {
    pending += decoder.decode(chunk, { stream: true });
    let boundary = pending.indexOf("\n");
    while (boundary >= 0) {
      const parsed: unknown = JSON.parse(pending.slice(0, boundary));
      const event = object(parsed);
      assert.equal(typeof event.type, "string");
      events.push(event as ChatEvent);
      pending = pending.slice(boundary + 1);
      boundary = pending.indexOf("\n");
    }
  }
  pending += decoder.decode();
  assert.equal(pending, "", "The actual route emits complete NDJSON events.");
}

for (const path of paths) {
  test(`demo route ${path}: built origin, native streaming tools, verified resource, and completion`, {
    timeout: 45000,
    concurrency: false,
  }, async (t) => {
    const directory = await mkdtemp(resolve(tmpdir(), "langchain-native-runtime-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const publisher = resolve(directory, "publisher");
    await mkdir(publisher);
    await cp(resolve(example, "skills/source"), resolve(publisher, "source"), { recursive: true });
    await cp(
      resolve(example, "skills/remote-skills.json"),
      resolve(publisher, "remote-skills.json"),
    );
    await runRemoteSkills(["build"], { cwd: publisher });
    const skill = await readFile(resolve(publisher, "source/greeting/SKILL.md"), "utf8");
    const instructions = skill.replace(/^---\n[\s\S]*?\n---\n/u, "").trim();
    const resource = await readFile(
      resolve(publisher, "source/greeting/references/greeting.md"),
      "utf8",
    );
    const originRequests: string[] = [];
    const origin = await startStaticOrigin({
      root: resolve(publisher, "dist"),
      authorize: ({ pathname, request }) => {
        assert.ok(
          request.headers.authorization === undefined,
          "Model credentials never reach the skill origin.",
        );
        originRequests.push(pathname);
        return undefined;
      },
    });
    t.after(() => origin.close());
    const artifacts = () =>
      originRequests.filter((pathname) => staticResourceKind(pathname) === "artifact").length;
    const model = await modelServer(instructions, resource, artifacts);
    t.after(() => model.close());
    const restoreEnvironment = configureEnvironment(origin.origin, model.url);
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 30000);
    const events: ChatEvent[] = [];
    let failure: unknown;
    const previousDirectory = process.cwd();
    try {
      // Match the real Next app cwd so the unmodified route starts its Python bridge.
      // This invokes the actual route handler directly, without a Next router server.
      process.chdir(example);
      const response = await POST(
        new Request("http://127.0.0.1/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: "Hello! Please use the greeting skill.", path }),
          signal: controller.signal,
        }),
      );
      await readEvents(response, events);
    } catch (error) {
      failure = error;
    } finally {
      clearTimeout(deadline);
      controller.abort();
      process.chdir(previousDirectory);
      restoreEnvironment();
    }
    model.assertComplete();
    if (failure) throw failure;
    assert.deepEqual(
      events.filter((event) => event.type !== "text").map((event) => event.type),
      ["catalog", "tool-start", "tool-end", "tool-start", "tool-end", "done"],
    );
    const catalog = events[0];
    assert.ok(Array.isArray(catalog?.skills));
    assert.equal(object(catalog.skills[0]).name, "greeting");
    const starts = events.filter((event) => event.type === "tool-start");
    const ends = events.filter((event) => event.type === "tool-end");
    assert.ok(starts.every((event) => event.name === "read_file"));
    assert.ok(ends.every((event) => event.name === "read_file"));
    assert.equal(toolInput(starts[0], path).file_path, instructionPath);
    assert.equal(toolInput(starts[1], path).file_path, resourcePath);
    assertLines(content(ends[0]?.output), instructions);
    assertLines(content(ends[1]?.output), resource);
    const textEvents = events.filter((event) => event.type === "text");
    assert.ok(textEvents.length >= 2, "Multiple model stream chunks cross the real NDJSON route.");
    assert.equal(textEvents.map((event) => event.text).join(""), greeting);
    const resourceEnd = ends[1];
    assert.ok(resourceEnd);
    assert.ok(events.findIndex((event) => event.type === "text") > events.indexOf(resourceEnd));
    assert.equal(events.at(-1)?.type, "done");
    assert.equal(artifacts(), 1);
    assert.equal(
      originRequests.length,
      2,
      "Only the catalog and one full artifact cross the network.",
    );
  });
}

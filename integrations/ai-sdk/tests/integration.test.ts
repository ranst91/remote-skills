import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { simulateReadableStream, type Tool, ToolLoopAgent } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { remoteSkills } from "../src/index.ts";
import { fixture, INSTRUCTIONS, TEXT, TOKEN } from "./fixture.ts";

type StreamChunk =
  Awaited<ReturnType<MockLanguageModelV4["doStream"]>>["stream"] extends ReadableStream<infer Chunk>
    ? Chunk
    : never;

async function invoke<I, O>(definition: Tool<I, O>, input: NoInfer<I>): Promise<O> {
  assert.ok(definition.execute);
  const result = await definition.execute(input, { toolCallId: "test", messages: [], context: {} });
  assert.ok(!(Symbol.asyncIterator in Object(result)));
  // Tool.execute permits streaming output; exhaust it while preserving its output type.
  if (result != null && typeof result === "object" && Symbol.asyncIterator in result) {
    for await (const output of result) return output;
    throw new Error("Tool returned an empty stream");
  }
  return result;
}

for (const cache of ["memory", "disk"] as const) {
  test(`native Vercel loader: ${cache} discovery, lazy hydration, pinned file reads, disposal`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "native-skill-cache-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const f = fixture({ cache, cacheOptions: { directory } });
    const integration = await remoteSkills({
      client: f.client,
      origin: "team",
      versions: { greeting: "^1.0.0" },
    });
    t.after(() => integration.close());
    const { tools } = integration.agentOptions;
    assert.deepEqual(Object.keys(tools), ["skill", "readFile"]);
    // These are upstream descriptions, not our previous replacement tool definitions.
    assert.equal(typeof tools.skill.description, "string");
    assert.match(
      String(tools.skill.description),
      /Load a skill's instructions to learn how to use it/u,
    );
    assert.equal(tools.readFile.description, "Read the contents of a file from the sandbox.");
    assert.equal(f.artifactRequests().length, 0);
    assert.equal(JSON.stringify(integration.agentOptions).includes(INSTRUCTIONS), false);
    assert.equal(JSON.stringify(integration.agentOptions).includes(TOKEN), false);
    const loaded = await invoke(tools.skill, { skillName: "greeting" });
    assert.ok(loaded.success);
    assert.equal(loaded.instructions, INSTRUCTIONS);
    assert.equal(loaded.skill.path, "./skills/greeting");
    assert.deepEqual(loaded.files.sort(), ["assets/icon.bin", "references/greeting.md"]);
    assert.equal(f.artifactRequests().length, 1);
    const file = await invoke(tools.readFile, {
      path: `${loaded.skill.path}/references/greeting.md`,
    });
    assert.equal(file.content, `${TEXT} 1.0.0`);
    f.update();
    await f.client.refresh("team");
    f.offline();
    assert.equal(
      (await invoke(tools.readFile, { path: "skills/greeting/references/greeting.md" })).content,
      file.content,
    );
    assert.equal(f.artifactRequests().length, 1);
    await assert.rejects(invoke(tools.readFile, { path: "/etc/passwd" }), { code: "path_invalid" });
    await assert.rejects(invoke(tools.readFile, { path: "skills/greeting/assets/icon.bin" }), {
      code: "resource_not_text",
    });
    await integration.close();
    await assert.rejects(invoke(tools.skill, { skillName: "greeting" }), {
      code: "session_closed",
    });
    await assert.rejects(invoke(tools.readFile, { path: "skills/greeting/SKILL.md" }), {
      code: "session_closed",
    });
  });
}

test("native loader preserves integrity failures and borrowed-session ownership", async (t) => {
  const f = fixture();
  const session = await f.client.session("team");
  t.after(() => session.close());
  const integration = await remoteSkills({ session });
  t.after(() => integration.close());
  f.corrupt();
  await assert.rejects(invoke(integration.agentOptions.tools.skill, { skillName: "greeting" }), {
    code: "digest_mismatch",
  });
  await integration.close();
  assert.equal((await session.catalog()).length, 1);
});

test("closing a borrowed session invalidates already hydrated native skills", async (t) => {
  const f = fixture();
  const session = await f.client.session("team");
  const integration = await remoteSkills({ session });
  t.after(() => integration.close());
  await invoke(integration.agentOptions.tools.skill, { skillName: "greeting" });
  await session.close();
  await assert.rejects(invoke(integration.agentOptions.tools.skill, { skillName: "greeting" }), {
    code: "session_closed",
  });
});

test("missing versions, digest failures and admission limits keep SDK error codes", async (t) => {
  for (const expected of ["version_unavailable", "digest_mismatch", "limit_exceeded"] as const) {
    const f = fixture(expected === "limit_exceeded" ? { limits: { fileBytes: 4 } } : {});
    const integration = await remoteSkills({
      client: f.client,
      origin: "team",
      versions: { greeting: expected === "version_unavailable" ? "^9.0.0" : "^1.0.0" },
    });
    t.after(() => integration.close());
    if (expected === "digest_mismatch") f.corrupt();
    await assert.rejects(invoke(integration.tools.skill, { skillName: "greeting" }), {
      code: expected,
    });
  }
});

test("authentication failure is fail-closed and safe before model execution", async () => {
  const f = fixture();
  f.status(401);
  await assert.rejects(remoteSkills({ client: f.client, origin: "team" }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message.includes(TOKEN), false);
    return "code" in error && error.code === "authentication_failed";
  });
});

test("real ToolLoopAgent accepts direct answers without activating a skill", async (t) => {
  const f = fixture();
  const skills = await remoteSkills({ client: f.client, origin: "team" });
  t.after(() => skills.close());
  const model = new MockLanguageModelV4({
    doGenerate: {
      content: [{ type: "text", text: "Four." }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      },
      warnings: [],
    },
  });
  const result = await new ToolLoopAgent({
    model,
    ...skills.agentOptions,
  }).generate({ prompt: "What is two plus two?" });
  assert.equal(result.text, "Four.");
  assert.equal(f.artifactRequests().length, 0);
  assert.equal(JSON.stringify(model.doGenerateCalls).includes(INSTRUCTIONS), false);
});

test("activation transport failures cannot expose credentials through tool results", async (t) => {
  const f = fixture();
  const skills = await remoteSkills({ client: f.client, origin: "team" });
  t.after(() => skills.close());
  f.offline();
  await assert.rejects(invoke(skills.tools.skill, { skillName: "greeting" }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message.includes(TOKEN), false);
    assert.equal(JSON.stringify(error).includes(TOKEN), false);
    return true;
  });
});

test("invalid source lists and version keys fail before any activation", async () => {
  const f = fixture();
  for (const origins of [[], ["team", "team"]]) {
    await assert.rejects(remoteSkills({ client: f.client, origins }), {
      code: "configuration_invalid",
    });
  }
  await assert.rejects(
    remoteSkills({
      client: f.client,
      origin: "team",
      versions: { unknown: "^1.0.0" },
    }),
    { code: "configuration_invalid" },
  );
  assert.equal(f.artifactRequests().length, 0);
});

test("streaming agent activates lazily and receives verified instructions", async (t) => {
  const f = fixture();
  const skills = await remoteSkills({ client: f.client, origin: "team" });
  t.after(() => skills.close());
  let calls = 0;
  const usage = {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  };
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      const first = calls++ === 0;
      if (first) {
        assert.equal(f.artifactRequests().length, 0);
        assert.equal(JSON.stringify(options.prompt).includes(INSTRUCTIONS), false);
      } else {
        assert.ok(JSON.stringify(options.prompt).includes(INSTRUCTIONS));
        assert.equal(f.artifactRequests().length, 1);
      }
      return {
        stream: simulateReadableStream<StreamChunk>({
          chunks: first
            ? [
                {
                  type: "tool-call",
                  toolCallId: "load",
                  toolName: "skill",
                  input: '{"skillName":"greeting"}',
                },
                {
                  type: "finish",
                  finishReason: { unified: "tool-calls", raw: "tool_calls" },
                  usage,
                },
              ]
            : [
                { type: "text-start", id: "answer" },
                { type: "text-delta", id: "answer", delta: "Hello." },
                { type: "text-end", id: "answer" },
                { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
              ],
        }),
      };
    },
  });
  const result = await new ToolLoopAgent({ model, ...skills.agentOptions }).stream({
    prompt: "Hi",
  });
  assert.equal(await result.text, "Hello.");
  assert.equal(calls, 2);
});

test("multiple origins retain separate native paths and version pins", async (t) => {
  const f = fixture();
  const skills = await remoteSkills({
    client: f.client,
    origins: ["team", "other"],
    versions: {
      "team/greeting": "^1.0.0",
      "other/greeting": "^2.0.0",
    },
  });
  t.after(() => skills.close());
  for (const [origin, version] of [
    ["team", "1.0.0"],
    ["other", "2.0.0"],
  ] as const) {
    const loaded = await invoke(skills.tools.skill, { skillName: `${origin}/greeting` });
    assert.ok(loaded.success);
    assert.equal(loaded.skill.path, `./skills/${origin}%2Fgreeting`);
    assert.equal(
      (
        await invoke(skills.tools.readFile, {
          path: `${loaded.skill.path}/references/greeting.md`,
        })
      ).content,
      `${TEXT} ${version}`,
    );
  }
  assert.equal((await invoke(skills.tools.skill, { skillName: "greeting" })).success, false);
  assert.equal(f.artifactRequests().length, 2);
  assert.ok(f.requests.every((r) => r.headers.authorization === `Bearer ${TOKEN}`));
  assert.ok(
    f.requests
      .filter((r) => r.path.endsWith("index.json"))
      .every((r) => r.headers["remote-skills-scope"] === "engineering"),
  );
});

test("concurrent native loads share hydration and pre-cancelled loads fetch nothing", async (t) => {
  const f = fixture();
  const skills = await remoteSkills({ client: f.client, origin: "team" });
  t.after(() => skills.close());
  assert.ok(skills.tools.skill.execute);
  await assert.rejects(
    Promise.resolve(
      skills.tools.skill.execute(
        { skillName: "greeting" },
        {
          toolCallId: "cancelled",
          messages: [],
          context: {},
          abortSignal: AbortSignal.abort(),
        },
      ),
    ),
    { message: "Skill request aborted" },
  );
  assert.equal(f.artifactRequests().length, 0);
  assert.ok(skills.tools.readFile.execute);
  await assert.rejects(
    Promise.resolve(
      skills.tools.readFile.execute(
        { path: "skills/greeting/SKILL.md" },
        {
          toolCallId: "cancelled-read",
          messages: [],
          context: {},
          abortSignal: AbortSignal.abort(),
        },
      ),
    ),
    { message: "Skill request aborted" },
  );
  assert.equal(f.artifactRequests().length, 0);
  const loaded = await Promise.all(
    Array.from({ length: 8 }, () => invoke(skills.tools.skill, { skillName: "greeting" })),
  );
  for (const result of loaded) {
    assert.ok(result.success);
    assert.equal(result.instructions, INSTRUCTIONS);
  }
  assert.equal(f.artifactRequests().length, 1);
  const closing = skills.close();
  assert.equal(skills.close(), closing);
  await closing;
});

test("configured retries and catalog byte limits remain effective", async (t) => {
  const f = fixture({}, { retries: 1 });
  f.failNext();
  const skills = await remoteSkills({ client: f.client, origin: "team" });
  t.after(() => skills.close());
  assert.equal(f.requests.length, 2);
  f.failNext();
  assert.ok((await invoke(skills.tools.skill, { skillName: "greeting" })).success);
  assert.equal(f.artifactRequests().length, 2);
  const limited = fixture({}, { catalogBytes: 1 });
  await assert.rejects(remoteSkills({ client: limited.client, origin: "team" }), {
    code: "limit_exceeded",
  });
  assert.equal(limited.artifactRequests().length, 0);
});

test("bounded stale policy reuses verified artifacts through the native loader", async (t) => {
  const f = fixture({}, { stale: { maxAgeMs: 60_000 } });
  const fresh = await remoteSkills({ client: f.client, origin: "team" });
  t.after(() => fresh.close());
  const loaded = await invoke(fresh.tools.skill, { skillName: "greeting" });
  await fresh.close();
  f.offline();
  const stale = await remoteSkills({ client: f.client, origin: "team" });
  t.after(() => stale.close());
  assert.equal(stale.sessions[0]?.metadata.stale, true);
  assert.deepEqual(await invoke(stale.tools.skill, { skillName: "greeting" }), loaded);
  assert.equal(f.artifactRequests().length, 1);
});

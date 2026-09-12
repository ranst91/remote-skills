import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Agent } from "@mastra/core/agent";
import { remoteSkills } from "../src/index.ts";
import { RemoteSkillSource } from "../src/source.ts";
import { fixture, INSTRUCTIONS, TEXT } from "./fixture.ts";

async function harness(options: Parameters<typeof remoteSkills>[0]) {
  const skills = await remoteSkills(options);
  const agent = new Agent({
    id: "test",
    name: "Test",
    model: "openai/gpt-4.1-mini",
    ...skills.agentOptions,
  });
  const tools = await agent.getToolsForExecution({});
  async function invoke(name: string, input: Record<string, unknown>) {
    const tool = tools[name];
    assert.ok(tool?.execute);
    return tool.execute(input, { toolCallId: crypto.randomUUID(), messages: [] });
  }
  return { skills, tools, invoke };
}

test("real Mastra discovery, selection, activation and read remain native and lazy", async (t) => {
  const f = fixture();
  const h = await harness({ client: f.client, origin: "team" });
  t.after(() => h.skills.close());
  assert.deepEqual(Object.keys(h.tools).sort(), ["skill", "skill_read", "skill_search"]);
  assert.match(
    String(h.tools.skill?.description),
    /Activate a skill to load its full instructions/u,
  );
  assert.equal(f.artifactRequests().length, 0);
  const catalog = await h.skills.agentOptions.workspace.skills?.list();
  assert.deepEqual(
    catalog?.map((s) => s.name),
    ["greeting"],
  );
  assert.equal(JSON.stringify(catalog).includes(INSTRUCTIONS), false);
  const activated = await h.invoke("skill", { name: "greeting" });
  assert.equal(typeof activated, "string");
  assert.match(String(activated), new RegExp(INSTRUCTIONS, "u"));
  assert.match(String(activated), /references\/greeting.md/u);
  assert.equal(f.artifactRequests().length, 1);
  const read = await h.invoke("skill_read", {
    skillName: "greeting",
    path: "references/greeting.md",
  });
  assert.equal(read, `${TEXT} 2.0.0`);
  assert.equal(f.artifactRequests().length, 1);
});

test("read-first activation, refresh and repeated turns preserve the original version pin", async (t) => {
  const f = fixture();
  const h = await harness({ client: f.client, origin: "team", versions: { greeting: "^1.0.0" } });
  t.after(() => h.skills.close());
  assert.equal(
    await h.invoke("skill_read", {
      skillName: "skills/greeting/SKILL.md",
      path: "references/greeting.md",
    }),
    `${TEXT} 1.0.0`,
  );
  f.update();
  await f.client.refresh("team");
  await h.skills.agentOptions.workspace.skills?.refresh();
  await h.skills.agentOptions.workspace.skills?.maybeRefresh();
  f.offline();
  assert.match(String(await h.invoke("skill", { name: "greeting" })), /Read references/u);
  assert.equal(
    await h.invoke("skill_read", { skillName: "greeting", path: "references/greeting.md" }),
    `${TEXT} 1.0.0`,
  );
  assert.equal(f.artifactRequests().length, 1);
});

test("native search requires names and shares one pin with concurrent load and read", async (t) => {
  const f = fixture();
  const h = await harness({ client: f.client, origin: "team" });
  t.after(() => h.skills.close());
  await assert.rejects(
    h.invoke("skill_search", { query: "Ahoy" }),
    /requires a nonempty skillNames/u,
  );
  assert.equal(f.artifactRequests().length, 0);
  const results = await Promise.all([
    h.invoke("skill", { name: "greeting" }),
    h.invoke("skill_read", { skillName: "greeting", path: "references/greeting.md" }),
    h.invoke("skill_search", { query: "Ahoy", skillNames: ["greeting"] }),
    h.invoke("skill", { name: "skills/greeting" }),
  ]);
  assert.match(String(results[2]), /\[greeting\].*score: 0.80/u);
  assert.equal(f.artifactRequests().length, 1);
});

test("caller hooks preserve denial, input preparation and completion", async (t) => {
  const f = fixture();
  const calls: string[] = [];
  let deny = true;
  const h = await harness({
    client: f.client,
    origin: "team",
    instructions: "Keep this host instruction.",
    hooks: {
      beforeToolCall: (context) => {
        calls.push(`before:${context.toolName}`);
        if (deny) return { proceed: false, output: "denied by host" };
      },
      afterToolCall: (context) => {
        calls.push(`after:${context.toolName}`);
      },
    },
  });
  t.after(() => h.skills.close());
  assert.ok(h.skills.agentOptions.instructions.startsWith("Keep this host instruction."));
  assert.equal(await h.invoke("skill", { name: "greeting" }), "denied by host");
  assert.equal(f.artifactRequests().length, 0);
  deny = false;
  await h.invoke("skill", { name: "greeting" });
  assert.deepEqual(calls, ["before:skill", "before:skill", "after:skill"]);
});

test("path and binary failures remain safe and do not activate on invalid paths", async (t) => {
  const f = fixture();
  const h = await harness({ client: f.client, origin: "team" });
  t.after(() => h.skills.close());
  for (const path of [
    "../outside",
    "/outside",
    "references/../../outside",
    "references\\outside",
  ]) {
    await assert.rejects(h.invoke("skill_read", { skillName: "greeting", path }), {
      code: "path_invalid",
    });
  }
  assert.equal(f.artifactRequests().length, 0);
  await assert.rejects(h.invoke("skill_read", { skillName: "greeting", path: "missing.md" }), {
    code: "resource_not_found",
  });
  await assert.rejects(h.invoke("skill_read", { skillName: "greeting", path: "assets/icon.bin" }), {
    code: "resource_not_text",
  });
  assert.equal(f.artifactRequests().length, 1);
});

test("digest failures never publish partial native instructions", async (t) => {
  const f = fixture();
  const h = await harness({ client: f.client, origin: "team" });
  t.after(() => h.skills.close());
  f.corrupt();
  for (let attempt = 0; attempt < 2; attempt++)
    await assert.rejects(h.invoke("skill", { name: "greeting" }), { code: "digest_mismatch" });
  assert.equal((await h.skills.agentOptions.workspace.skills?.get("greeting"))?.instructions, "");
});

test("borrowed ownership, already-loaded close invalidation and idempotent cleanup", async (t) => {
  const f = fixture();
  const session = await f.client.session("team");
  t.after(() => session.close());
  const h = await harness({ session });
  await h.invoke("skill", { name: "greeting" });
  const closing = h.skills.close();
  assert.equal(h.skills.close(), closing);
  await closing;
  assert.equal((await session.catalog()).length, 1);
  await assert.rejects(h.invoke("skill", { name: "greeting" }), { code: "session_closed" });
  const second = await harness({ session });
  t.after(() => second.skills.close());
  await second.invoke("skill", { name: "greeting" });
  await session.close();
  await assert.rejects(second.invoke("skill", { name: "greeting" }), { code: "session_closed" });
});

for (const expected of [
  "version_unavailable",
  "limit_exceeded",
  "authentication_failed",
] as const) {
  test(`SDK ${expected} errors survive native activation without leaking response contents`, async (t) => {
    const f = fixture(expected === "limit_exceeded" ? { limits: { fileBytes: 4 } } : {});
    const h = await harness({
      client: f.client,
      origin: "team",
      versions: { greeting: expected === "version_unavailable" ? "^9.0.0" : "^1.0.0" },
    });
    t.after(() => h.skills.close());
    if (expected === "authentication_failed") f.status(401);
    await assert.rejects(h.invoke("skill", { name: "greeting" }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(JSON.stringify(error).includes("private-test-auth-sentinel"), false);
      assert.equal(error.message.includes("private-test-auth-sentinel"), false);
      return "code" in error && error.code === expected;
    });
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("close drains the exact active call including caller after hooks despite denied and aborted peers", async () => {
  const f = fixture();
  const entered = deferred();
  const finish = deferred();
  let deny = false;
  const h = await harness({
    client: f.client,
    origin: "team",
    hooks: {
      beforeToolCall: () => {
        if (deny) return { proceed: false, output: "denied" };
      },
      afterToolCall: async () => {
        entered.resolve();
        await finish.promise;
      },
    },
  });
  const running = h.invoke("skill", { name: "greeting" });
  const rejected = assert.rejects(running, { code: "session_closed" });
  await entered.promise;
  deny = true;
  assert.equal(await h.invoke("skill", { name: "greeting" }), "denied");
  const tool = h.tools.skill;
  assert.ok(tool?.execute);
  await assert.rejects(
    Promise.resolve(
      tool.execute(
        { name: "greeting" },
        { toolCallId: "aborted", messages: [], abortSignal: AbortSignal.abort() },
      ),
    ),
    /Skill request aborted/u,
  );
  // An unmatched after callback must not release the active call's lease.
  await h.skills.agentOptions.hooks.afterToolCall?.({
    toolName: "skill",
    input: { name: "greeting" },
    context: { toolCallId: "unmatched" },
  });
  let drained = false;
  const closing = h.skills.close().then(() => {
    drained = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(drained, false);
  finish.resolve();
  await rejected;
  await closing;
  assert.equal(drained, true);
});

test("native addSkill read failure rolls back and retries from the same verified artifact", async (t) => {
  const f = fixture();
  const h = await harness({ client: f.client, origin: "team" });
  t.after(() => h.skills.close());
  const readFile = RemoteSkillSource.prototype.readFile;
  let failing = true;
  // Inject an I/O failure into our source while the real native addSkill parses it.
  t.mock.method(
    RemoteSkillSource.prototype,
    "readFile",
    async function (this: RemoteSkillSource, path: string) {
      if (failing && path.endsWith("SKILL.md")) throw new Error("private-test-auth-sentinel");
      return readFile.call(this, path);
    },
  );
  await assert.rejects(h.invoke("skill", { name: "greeting" }), {
    message: "Remote Skills operation failed",
  });
  assert.equal(await h.skills.agentOptions.workspace.skills?.get("greeting"), null);
  failing = false;
  assert.match(String(await h.invoke("skill", { name: "greeting" })), /Read references/u);
  assert.equal(f.artifactRequests().length, 1);
});

test("explicit search hydrates only named skills and discovery indexes no remote resources", async (t) => {
  const f = fixture({}, {}, { extraSkill: true });
  const h = await harness({ client: f.client, origin: "team" });
  t.after(() => h.skills.close());
  assert.equal((await h.skills.agentOptions.workspace.skills?.list())?.length, 2);
  await h.skills.agentOptions.workspace.skills?.refresh();
  assert.equal(f.artifactRequests().length, 0);
  assert.match(
    String(await h.invoke("skill_search", { query: "Ahoy", skillNames: ["greeting"] })),
    /Ahoy/u,
  );
  assert.equal(f.artifactRequests().length, 1);
  assert.equal(
    f.artifactRequests().some((r) => r.path.endsWith("weather.zip")),
    false,
  );
});

for (const cache of ["memory", "disk"] as const) {
  test(`${cache} cache reuses verified artifacts while sessions own independent pins`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "mastra-cache-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const f = fixture({ cache, ...(cache === "disk" ? { cacheOptions: { directory } } : {}) });
    const first = await harness({
      client: f.client,
      origin: "team",
      versions: { greeting: "^1.0.0" },
    });
    await first.invoke("skill", { name: "greeting" });
    await first.skills.close();
    const second = await harness({
      client: f.client,
      origin: "team",
      versions: { greeting: "^1.0.0" },
    });
    t.after(() => second.skills.close());
    await second.invoke("skill", { name: "greeting" });
    assert.equal(f.artifactRequests().length, 1);
    assert.ok(
      f.requests.every((r) => r.headers.authorization === "Bearer private-test-auth-sentinel"),
    );
    assert.ok(
      f.requests
        .filter((r) => r.path.endsWith("index.json"))
        .every((r) => r.headers["remote-skills-scope"] === "engineering"),
    );
  });
}

test("different credentials sharing a disk directory must independently authorize discovery", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "mastra-auth-cache-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = fixture({ cache: "disk", cacheOptions: { directory } }, {}, { token: "tenant-a" });
  const a = await harness({ client: first.client, origin: "team" });
  await a.invoke("skill", { name: "greeting" });
  await a.skills.close();
  const second = fixture({ cache: "disk", cacheOptions: { directory } }, {}, { token: "tenant-b" });
  second.status(401);
  await assert.rejects(remoteSkills({ client: second.client, origin: "team" }), {
    code: "authentication_failed",
  });
  assert.equal(second.artifactRequests().length, 0);
  assert.ok(second.requests.every((r) => r.headers.authorization === "Bearer tenant-b"));
});

test("a failed multi-skill search still drains its other activation before close", async (t) => {
  const f = fixture({}, {}, { extraSkill: true });
  const session = await f.client.session("team");
  t.after(() => session.close());
  const entered = deferred();
  const finish = deferred();
  const h = await harness({
    session: {
      metadata: session.metadata,
      stale: session.stale,
      catalog: () => session.catalog(),
      activate: async (name, range) => {
        if (name === "greeting") throw new Error("private-test-auth-sentinel");
        entered.resolve();
        await finish.promise;
        return session.activate(name, range);
      },
      close: () => session.close(),
      [Symbol.asyncDispose]: () => session.close(),
    },
  });
  const search = h.invoke("skill_search", { query: "Ahoy", skillNames: ["greeting", "weather"] });
  const rejected = assert.rejects(search, /Remote Skills operation failed/u);
  await entered.promise;
  let drained = false;
  const closing = h.skills.close().then(() => {
    drained = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  try {
    assert.equal(drained, false);
  } finally {
    finish.resolve();
    await rejected;
    await closing;
  }
});

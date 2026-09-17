import assert from "node:assert/strict";
import test from "node:test";
import { createLoadSkillTool, createResourceTool } from "@tanstack/ai-skills";
import { fixture, INSTRUCTIONS, TEXT, TOKEN } from "../../../tests/helpers/remote-skills-origin.ts";
import { remoteSkills } from "../src/index.ts";

test("native tools discover metadata, load verified instructions and read UTF-8/base64 resources", async () => {
  const f = fixture({}, {}, { extraSkill: true });
  await using source = await remoteSkills({
    client: f.client,
    origin: "team",
    versions: { greeting: "1.0.0" },
  });
  const skills = await source.list();
  assert.deepEqual(skills.map((s) => s.name).sort(), ["greeting", "weather"]);
  assert.equal(JSON.stringify(skills).includes(INSTRUCTIONS), false);
  assert.equal(f.artifactRequests().length, 0);
  const load = createLoadSkillTool({ source, skills, activated: new Set() });
  assert.ok(load.execute);
  const result: unknown = await load.execute({ name: "greeting" });
  assert.deepEqual(result, {
    skill: "greeting",
    content: INSTRUCTIONS,
    resources: ["assets/icon.bin", "references/greeting.md"],
    scripts: [],
  });
  const read = createResourceTool(source);
  assert.ok(read.execute);
  assert.deepEqual(await read.execute({ skill: "greeting", path: "references/greeting.md" }), {
    skill: "greeting",
    path: "references/greeting.md",
    content: `${TEXT} 1.0.0`,
    encoding: "utf8",
  });
  assert.deepEqual(await read.execute({ skill: "greeting", path: "assets/icon.bin" }), {
    skill: "greeting",
    path: "assets/icon.bin",
    content: "AP+A",
    encoding: "base64",
  });
  assert.equal(f.artifactRequests().length, 1);
  assert.equal(f.artifactRequests()[0]?.path.includes("weather"), false);
});

test("pins survive refresh and offline reads while new conversations select independently", async () => {
  const f = fixture();
  await using first = await remoteSkills({
    client: f.client,
    origin: "team",
    versions: { greeting: "1.0.0" },
  });
  await first.load("greeting");
  f.update();
  await f.client.refresh("team");
  await using second = await remoteSkills({
    client: f.client,
    origin: "team",
    versions: { greeting: "2.0.0" },
  });
  assert.match(await second.load("greeting"), /2\.0\.0/u);
  f.offline();
  assert.match(await first.load("greeting"), /1\.0\.0/u);
  assert.equal(await first.readResource?.("greeting", "references/greeting.md"), `${TEXT} 1.0.0`);
  assert.equal(f.artifactRequests().length, 2);
});

test("verification failures never become instructions or mark a native skill loaded", async () => {
  const f = fixture();
  f.corrupt();
  await using source = await remoteSkills({ client: f.client, origin: "team" });
  const activated = new Set<string>();
  const load = createLoadSkillTool({ source, skills: await source.list(), activated });
  assert.ok(load.execute);
  const execute = load.execute;
  await assert.rejects(() => execute({ name: "greeting" }), { code: "digest_mismatch" });
  assert.equal(activated.size, 0);
});

test("unsafe and non-resource paths fail before activation; missing names and files fail closed", async () => {
  const f = fixture();
  await using source = await remoteSkills({ client: f.client, origin: "team" });
  assert.ok(source.readResource);
  for (const path of [
    "../secret",
    "/etc/passwd",
    "references/../secret",
    "references\\note.md",
    "scripts/run.py",
    "SKILL.md",
    "references//note.md",
  ]) {
    await assert.rejects(() => source.readResource("greeting", path), { code: "path_invalid" });
  }
  assert.equal(f.artifactRequests().length, 0);
  await assert.rejects(() => source.load("missing"), { code: "skill_not_found" });
  await assert.rejects(() => source.readResource("greeting", "references/missing.md"), {
    code: "resource_not_found",
  });
});

test("close is idempotent, guards every source method and preserves borrowed session ownership", async () => {
  const f = fixture();
  await using session = await f.client.session("team");
  const source = await remoteSkills({ session });
  await source.load("greeting");
  await source.close();
  await source.close();
  await assert.rejects(() => source.list(), { code: "session_closed" });
  await assert.rejects(() => source.load("greeting"), { code: "session_closed" });
  await assert.rejects(() => source.listResources("greeting"), { code: "session_closed" });
  await assert.rejects(() => source.readResource("greeting", "references/greeting.md"), {
    code: "session_closed",
  });
  assert.equal((await session.catalog()).length, 1);
  const owned = await remoteSkills({ client: f.client, origin: "team" });
  await owned.close();
  await assert.rejects(() => owned.session.catalog(), { code: "session_closed" });
});

test("a caller closing its session invalidates the source and sanitized errors omit credentials", async () => {
  const f = fixture();
  await using session = await f.client.session("team");
  await using source = await remoteSkills({ session });
  await session.close();
  await assert.rejects(() => source.list(), { code: "session_closed" });
  const g = fixture();
  await using other = await remoteSkills({ client: g.client, origin: "team" });
  g.status(403);
  await assert.rejects(
    () => other.load("greeting"),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(JSON.stringify(error).includes(TOKEN), false);
      assert.equal(error.message.includes(TOKEN), false);
      return true;
    },
  );
});

test("close drains an in-flight source call before releasing the owned session", async () => {
  const f = fixture();
  const session = await f.client.session("team");
  const original = session.activate.bind(session);
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let resume!: () => void;
  const blocked = new Promise<void>((resolve) => {
    resume = resolve;
  });
  let released = false;
  const ownedSession = {
    ...session,
    catalog: session.catalog.bind(session),
    activate: async (name: string, range?: string) => {
      entered();
      await blocked;
      return original(name, range);
    },
    close: async () => {
      released = true;
      await session.close();
    },
    [Symbol.asyncDispose]: session.close.bind(session),
  };
  const source = await remoteSkills({
    client: { ...f.client, session: async () => ownedSession },
    origin: "team",
  });
  const loading = source.load("greeting");
  const rejected = assert.rejects(() => loading, { code: "session_closed" });
  await started;
  const closing = source.close();
  assert.equal(released, false);
  resume();
  await Promise.all([closing, rejected]);
  assert.equal(released, true);
});

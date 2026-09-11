import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { RemoteSkillsError, type RemoteSkillsSession } from "@remote-skills/client";
import { fixture, INSTRUCTIONS, TEXT, TOKEN } from "../../ai-sdk/tests/fixture.ts";
import { remoteSkills } from "../src/index.ts";

test("discovery projects metadata while content reads activate the original whole archive", async () => {
  const host = fixture();
  await using session = await host.client.session("team");
  await using remote = await remoteSkills({ session, versions: { greeting: "^1.0.0" } });
  assert.equal(host.artifactRequests().length, 0);
  assert.deepEqual(remote.sources, ["/skills/"]);
  assert.deepEqual(await remote.discoveryBackend.ls("/skills/"), {
    files: [{ path: "/skills/greeting/", is_dir: true }],
  });
  const projection = await remote.discoveryBackend.read("/skills/greeting/SKILL.md");
  assert.match(String(projection.content), /name: "greeting"/);
  assert.ok(!String(projection.content).includes(INSTRUCTIONS));
  assert.equal(host.artifactRequests().length, 0);
  const original = await remote.contentBackend.read("/skills/greeting/SKILL.md", 0, 1000);
  assert.ok(String(original.content).includes(INSTRUCTIONS));
  assert.equal(host.artifactRequests().length, 1);
  const resource = await remote.contentBackend.read("/skills/greeting/references/greeting.md");
  assert.equal(resource.content, `${TEXT} 1.0.0`);
  assert.equal(host.artifactRequests().length, 1);
});

test("native backend download returns original bytes and supports binary resources and pagination", async () => {
  const host = fixture();
  await using session = await host.client.session("team");
  await using remote = await remoteSkills({ session, root: "/remote/team/" });
  assert.ok(remote.contentBackend.downloadFiles);
  const [download] = await remote.contentBackend.downloadFiles(["/remote/team/greeting/SKILL.md"]);
  assert.deepEqual(
    download?.content,
    await (await session.activate("greeting")).readBytes("SKILL.md"),
  );
  const page = await remote.contentBackend.read("/remote/team/greeting/SKILL.md", 1, 2);
  assert.equal(page.content, "name: greeting\ndescription: Greeting");
  assert.equal(page.startLine, 2);
  assert.equal(page.endLine, 3);
  assert.equal(page.nextOffset, 3);
  const full = await remote.contentBackend.read("/remote/team/greeting/SKILL.md", 0, 1000);
  assert.equal(full.totalLines, 7);
  assert.equal(full.endLine, 7);
  assert.equal(full.nextOffset, undefined);
  const eof = await remote.contentBackend.read("/remote/team/greeting/SKILL.md", 7, 10);
  assert.equal(eof.content, "");
  assert.equal(eof.startLine, undefined);
  const binary = await remote.contentBackend.read("/remote/team/greeting/assets/icon.bin");
  assert.deepEqual(binary.content, new Uint8Array([0, 255, 128]));
  assert.deepEqual(await remote.contentBackend.ls("/remote/team/greeting/references/"), {
    files: [
      {
        path: "/remote/team/greeting/references/greeting.md",
        is_dir: false,
        size: Buffer.byteLength(`${TEXT} 1.0.0`),
      },
    ],
  });
  assert.equal(host.artifactRequests().length, 1);
});

test("concurrent reads share SDK activation and authorization without exposing credentials", async () => {
  const host = fixture();
  await using session = await host.client.session("team");
  await using remote = await remoteSkills({ session, versions: { greeting: "^1.0.0" } });
  const reads = await Promise.all(
    Array.from({ length: 8 }, () =>
      remote.contentBackend.read("/skills/greeting/references/greeting.md"),
    ),
  );
  assert.equal(host.artifactRequests().length, 1);
  assert.ok(reads.every((result) => result.content === `${TEXT} 1.0.0`));
  assert.ok(host.requests.every((request) => request.headers.authorization === `Bearer ${TOKEN}`));
  assert.ok(!JSON.stringify(remote.catalog).includes(TOKEN));
});

test("session pins survive refresh and offline resource reads while later sessions select a new release", async () => {
  const host = fixture();
  await using session = await host.client.session("team");
  await using remote = await remoteSkills({ session, versions: { greeting: "^1.0.0" } });
  await remote.contentBackend.read("/skills/greeting/SKILL.md");
  host.update();
  await host.client.refresh();
  await using laterSession = await host.client.session("team");
  await using later = await remoteSkills({ session: laterSession });
  const newResource = await later.contentBackend.read("/skills/greeting/references/greeting.md");
  assert.equal(newResource.content, `${TEXT} 2.0.0`);
  host.offline();
  const before = host.requests.length;
  assert.equal(
    (await remote.contentBackend.read("/skills/greeting/references/greeting.md")).content,
    `${TEXT} 1.0.0`,
  );
  assert.equal(host.requests.length, before);
});

test("host version policy chooses retained history without artifact discovery", async () => {
  const host = fixture();
  host.update();
  await using session = await host.client.session("team");
  await using remote = await remoteSkills({ session, versions: { greeting: "^1.0.0" } });
  assert.equal(host.artifactRequests().length, 0);
  assert.equal(
    (await remote.contentBackend.read("/skills/greeting/references/greeting.md")).content,
    `${TEXT} 1.0.0`,
  );
  assert.ok(host.artifactRequests()[0]?.path.endsWith("1.0.0.zip"));
});

test("a disk cache is reused through the caller's SDK client", async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-skills-langchain-cache-"));
  try {
    const host = fixture({ cache: "disk", cacheOptions: { directory } });
    {
      await using session = await host.client.session("team");
      await using remote = await remoteSkills({ session, versions: { greeting: "^1.0.0" } });
      await remote.contentBackend.read("/skills/greeting/SKILL.md");
    }
    const count = host.artifactRequests().length;
    await using session = await host.client.session("team");
    await using remote = await remoteSkills({ session, versions: { greeting: "^1.0.0" } });
    await remote.contentBackend.read("/skills/greeting/SKILL.md");
    assert.equal(host.artifactRequests().length, count);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("invalid paths cannot select outside the remote root or make artifact requests", async () => {
  const host = fixture();
  await using session = await host.client.session("team");
  await using remote = await remoteSkills({ session, versions: { greeting: "^1.0.0" } });
  for (const path of [
    "/etc/passwd",
    "/skills/greeting/../SKILL.md",
    "/skills/greeting//SKILL.md",
    "/skills/greeting/\\SKILL.md",
    "/skills/greeting/./SKILL.md",
  ]) {
    await assert.rejects(
      async () => remote.contentBackend.read(path),
      (error: unknown) => error instanceof RemoteSkillsError && error.code === "path_invalid",
    );
  }
  assert.equal(host.artifactRequests().length, 0);
  assert.ok((await remote.contentBackend.write("/skills/greeting/SKILL.md", "changed")).error);
});

for (const status of [401, 403]) {
  test(`artifact HTTP ${status} propagates a sanitized stable error`, async () => {
    const host = fixture();
    await using session = await host.client.session("team");
    await using remote = await remoteSkills({ session, versions: { greeting: "^1.0.0" } });
    host.status(status);
    await assert.rejects(
      async () => remote.contentBackend.read("/skills/greeting/SKILL.md"),
      (error: unknown) => {
        assert.ok(error instanceof RemoteSkillsError);
        assert.equal(error.code, status === 401 ? "authentication_failed" : "authorization_denied");
        assert.ok(!JSON.stringify(error).includes(TOKEN));
        assert.ok(!String(error).includes(TOKEN));
        return true;
      },
    );
  });
}

test("digest failure reaches the caller without returning any unverified instructions", async () => {
  const host = fixture();
  await using session = await host.client.session("team");
  await using remote = await remoteSkills({ session, versions: { greeting: "^1.0.0" } });
  host.corrupt();
  await assert.rejects(
    async () => remote.contentBackend.read("/skills/greeting/SKILL.md"),
    (error: unknown) => error instanceof RemoteSkillsError && error.code === "digest_mismatch",
  );
});

test("adapter closure is idempotent and leaves its borrowed session usable", async () => {
  const host = fixture();
  await using session = await host.client.session("team");
  const remote = await remoteSkills({ session, versions: { greeting: "^1.0.0" } });
  await Promise.all([remote.close(), remote.close()]);
  await assert.rejects(
    async () => remote.contentBackend.read("/skills/greeting/SKILL.md"),
    (error: unknown) => error instanceof RemoteSkillsError && error.code === "session_closed",
  );
  assert.equal((await session.catalog()).length, 1);
  assert.equal((await session.activate("greeting")).name, "greeting");
});

test("closing the borrowed session also disables discovery and content reads", async () => {
  const host = fixture();
  const session = await host.client.session("team");
  await using remote = await remoteSkills({ session, versions: { greeting: "^1.0.0" } });
  await session.close();
  await assert.rejects(
    async () => remote.discoveryBackend.ls("/skills/"),
    (error: unknown) => error instanceof RemoteSkillsError && error.code === "session_closed",
  );
});

test("separate origin adapters with the same skill name retain independent pins", async () => {
  const host = fixture();
  await using firstSession = await host.client.session("team");
  await using otherSession = await host.client.session("other");
  await using first = await remoteSkills({
    session: firstSession,
    versions: { greeting: "^1.0.0" },
  });
  await using other = await remoteSkills({
    session: otherSession,
    versions: { greeting: "^2.0.0" },
  });
  const [firstRead, otherRead] = await Promise.all([
    first.contentBackend.read("/skills/greeting/references/greeting.md"),
    other.contentBackend.read("/skills/greeting/references/greeting.md"),
  ]);
  assert.equal(firstRead.content, `${TEXT} 1.0.0`);
  assert.equal(otherRead.content, `${TEXT} 2.0.0`);
  assert.equal(host.artifactRequests().length, 2);
});

test("invalid roots and unknown version selectors fail before activation", async () => {
  const host = fixture();
  await using session = await host.client.session("team");
  for (const root of ["skills/", "/skills", "/skills/../", "/", "/skills//"]) {
    await assert.rejects(
      () => remoteSkills({ session, root }),
      (error: unknown) =>
        error instanceof RemoteSkillsError && error.code === "configuration_invalid",
    );
  }
  await assert.rejects(
    () => remoteSkills({ session, versions: { unknown: "^1.0.0" } }),
    (error: unknown) =>
      error instanceof RemoteSkillsError && error.code === "configuration_invalid",
  );
  assert.equal(host.artifactRequests().length, 0);
});

test("adapter close drains pending activation without closing or leaking content from the borrowed session", async () => {
  const host = fixture();
  await using session = await host.client.session("team");
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  let sessionCloses = 0;
  const controlled: RemoteSkillsSession = {
    metadata: session.metadata,
    stale: session.stale,
    catalog: () => session.catalog(),
    async activate(name, range) {
      entered.resolve();
      await released.promise;
      return session.activate(name, range);
    },
    async close() {
      sessionCloses += 1;
      await session.close();
    },
    [Symbol.asyncDispose]: () => session.close(),
  };
  const remote = await remoteSkills({ session: controlled });
  const read = Promise.resolve(remote.contentBackend.read("/skills/greeting/SKILL.md"));
  const rejection = assert.rejects(
    read,
    (error: unknown) => error instanceof RemoteSkillsError && error.code === "session_closed",
  );
  await entered.promise;
  let settled = false;
  const closing = remote.close().then(() => {
    settled = true;
  });
  await setImmediate();
  assert.equal(settled, false);
  released.resolve();
  await rejection;
  await closing;
  assert.equal(sessionCloses, 0);
  assert.equal((await session.catalog()).length, 1);
});

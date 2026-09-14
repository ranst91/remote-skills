import assert from "node:assert/strict";
import test from "node:test";
import {
  type ActivatedSessionSkill,
  type CatalogEntry,
  RemoteSkillsError,
} from "@remote-skills/client";
import { RemoteSkillSource } from "../src/source.ts";

const entry: CatalogEntry = {
  originAlias: "local",
  name: "example",
  description: "Local source test",
  artifactType: "archive",
  url: "https://example.invalid/skill.zip",
  digest: `sha256:${"0".repeat(64)}`,
};

// A source-only stub: no archive creation, activation, or network access.
function selected(
  resources: readonly string[],
  instructions = "Instructions",
): ActivatedSessionSkill {
  const contents = new Map([
    ["SKILL.md", instructions],
    ...resources.map((path) => [path, `Content of ${path}`] as const),
  ]);
  const read = async (path: string) => {
    const content = contents.get(path);
    assert.ok(content !== undefined);
    return content;
  };
  return {
    ...entry,
    descriptor: entry,
    instructions,
    frontmatter: {},
    list: async () =>
      resources.map((path) => ({
        path,
        size: Buffer.byteLength(contents.get(path) ?? ""),
        media_type: "text/plain",
      })),
    read,
    readBytes: async (path) => Buffer.from(await read(path)),
  };
}

function source() {
  return new RemoteSkillSource([entry], () => {});
}

test("source rejects file-parent conflicts in either resource order without replacing its view", async () => {
  for (const paths of [
    ["references", "references/note.md"],
    ["references/note.md", "references"],
    ["SKILL.md/note.md"],
  ]) {
    const view = source();
    await view.publish(entry.name, selected(["previous.md"], "Previous instructions"));
    const before = await view.readdir("skills/example");
    await assert.rejects(
      view.publish(entry.name, selected(paths, "Replacement instructions")),
      (error: unknown) => error instanceof RemoteSkillsError && error.code === "archive_unsafe",
    );
    assert.deepEqual(await view.readdir("skills/example"), before);
    assert.equal(await view.readFile("skills/example/SKILL.md"), "Previous instructions");
    assert.equal(await view.readFile("skills/example/previous.md"), "Content of previous.md");
    assert.equal(await view.exists("skills/example/references"), false);
  }
});

test("source exposes consistent directory entries, stats and reads for nested resources", async () => {
  const view = source();
  await view.publish(
    entry.name,
    selected(["references/nested/note.md", "references/other.md", "references-extra.md"]),
  );
  assert.deepEqual(await view.readdir("skills/example"), [
    { name: "SKILL.md", type: "file" },
    { name: "references", type: "directory" },
    { name: "references-extra.md", type: "file" },
  ]);
  async function checkDirectory(path: string): Promise<void> {
    assert.equal((await view.stat(path)).type, "directory");
    for (const child of await view.readdir(path)) {
      const childPath = `${path}/${child.name}`;
      const stat = await view.stat(childPath);
      assert.equal(stat.type, child.type);
      if (child.type === "directory") await checkDirectory(childPath);
      else {
        const contents = await view.readFile(childPath);
        assert.equal(stat.size, Buffer.byteLength(contents));
        await assert.rejects(view.readdir(childPath), { code: "resource_not_found" });
      }
    }
  }
  await checkDirectory("skills/example");
  assert.equal(
    await view.readFile("skills/example/references/nested/note.md"),
    "Content of references/nested/note.md",
  );
});

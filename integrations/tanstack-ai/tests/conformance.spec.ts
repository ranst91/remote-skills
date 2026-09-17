import { createHash } from "node:crypto";
import { createRemoteSkills } from "@remote-skills/client";
import { runSkillSourceConformance } from "@tanstack/ai-skills/testing";
import { afterEach } from "vitest";
import { encodeZip } from "../../../packages/core/src/build/archive.ts";
import { type RemoteSkillSource, remoteSkills } from "../src/index.ts";

const sources: RemoteSkillSource[] = [];
afterEach(async () => {
  await Promise.all(sources.splice(0).map((source) => source.close()));
});
runSkillSourceConformance(async () => {
  const artifact = (name: string) =>
    encodeZip([
      {
        path: "SKILL.md",
        bytes: Buffer.from(
          `---\nname: ${name}\ndescription: Test skill\n---\nTest instructions.\n`,
        ),
      },
      { path: "references/note.md", bytes: Buffer.from("hello") },
    ]);
  const artifacts = new Map(["alpha", "beta"].map((name) => [name, artifact(name)]));
  const client = createRemoteSkills(
    { origins: { test: { url: "https://skills.example.test" } }, cache: "memory" },
    {
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      transport: async ({ url }) => {
        const path = new URL(url).pathname;
        const body = path.endsWith("index.json")
          ? Buffer.from(
              JSON.stringify({
                $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
                skills: [...artifacts].map(([name, bytes]) => ({
                  name,
                  description: "Test skill",
                  type: "archive",
                  url: `${name}.zip`,
                  digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
                })),
              }),
            )
          : artifacts.get(path.split("/").at(-1)?.replace(".zip", "") ?? "");
        if (!body) throw new Error("Unexpected request");
        return { status: 200, headers: {}, body };
      },
    },
  );
  const source = await remoteSkills({ client, origin: "test" });
  sources.push(source);
  return source;
}, "Remote Skills");

import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { runRemoteSkills } from "./public-cli.ts";

const exampleRoot = resolve(import.meta.dirname, "../../../examples");
const publisherRoot = resolve(exampleRoot, "publisher");

export async function buildVersionedOrigin(destination: string) {
  const projectDirectory = resolve(destination, "publisher-project");
  await mkdir(projectDirectory, { recursive: true });
  await cp(
    resolve(publisherRoot, "remote-skills.json"),
    resolve(projectDirectory, "remote-skills.json"),
  );
  await cp(resolve(publisherRoot, "skills"), resolve(projectDirectory, "skills"), {
    recursive: true,
  });
  const currentSkill = await readFile(resolve(projectDirectory, "skills/code-review/SKILL.md"));
  const priorSkill = await readFile(
    resolve(import.meta.dirname, "../fixtures/releases/1.4.7/SKILL.md"),
  );
  await writeFile(resolve(projectDirectory, "skills/code-review/SKILL.md"), priorSkill);
  await runRemoteSkills(["validate"], { cwd: projectDirectory });
  await runRemoteSkills(["build", "--out-dir", "prior-dist"], { cwd: projectDirectory });
  await writeFile(resolve(projectDirectory, "skills/code-review/SKILL.md"), currentSkill);
  await runRemoteSkills(["build", "--out-dir", "dist", "--prior-output", "prior-dist"], {
    cwd: projectDirectory,
  });
  return resolve(projectDirectory, "dist");
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const destination = process.argv[2];
  if (destination === undefined)
    throw new Error("usage: node build-history.ts <empty-work-directory>");
  process.stdout.write(`${await buildVersionedOrigin(destination)}\n`);
}

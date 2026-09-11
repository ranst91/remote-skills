import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { assertInstalledNpm, type PackageSource, packageSource } from "./helpers/package-source.ts";

const source: PackageSource = {
  npm: ["cli", "client", "ai-sdk"].map((name) => ({
    name: `@remote-skills/${name}`,
    version: "0.0.1-alpha.0",
    spec: `@remote-skills/${name}@0.0.1-alpha.0`,
  })),
  python: { version: "0.0.1a0", spec: "remote-skills==0.0.1a0" },
};

test("installed E2Es reject floating versions and duplicate package selections", async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), "remote-skills-source-contract-"));
  const previous = process.env.REMOTE_SKILLS_E2E_PACKAGES;
  t.after(async () => {
    if (previous === undefined) delete process.env.REMOTE_SKILLS_E2E_PACKAGES;
    else process.env.REMOTE_SKILLS_E2E_PACKAGES = previous;
    await rm(root, { recursive: true, force: true });
  });
  const path = resolve(root, "source.json");
  process.env.REMOTE_SKILLS_E2E_PACKAGES = path;
  await writeFile(path, JSON.stringify(source));
  assert.deepEqual(await packageSource(), source);
  await writeFile(
    path,
    JSON.stringify({ ...source, python: { version: "0.0.1a0", spec: "remote-skills" } }),
  );
  await assert.rejects(packageSource());
  await writeFile(path, JSON.stringify({ ...source, npm: [...source.npm, source.npm[0]] }));
  await assert.rejects(packageSource());
  await writeFile(
    path,
    JSON.stringify({
      ...source,
      npm: source.npm.map((entry) => ({ ...entry, spec: `${entry.name}@latest` })),
    }),
  );
  await assert.rejects(packageSource());
});

test("installed E2Es reject a workspace-linked package even with the correct version", async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), "remote-skills-resolution-contract-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const consumer = resolve(root, "consumer");
  const workspace = resolve(root, "workspace-cli");
  await mkdir(resolve(consumer, "node_modules/@remote-skills"), { recursive: true });
  await mkdir(workspace);
  await writeFile(
    resolve(workspace, "package.json"),
    JSON.stringify({ name: "@remote-skills/cli", version: "0.0.1-alpha.0" }),
  );
  await symlink(workspace, resolve(consumer, "node_modules/@remote-skills/cli"), "junction");
  await assert.rejects(assertInstalledNpm(consumer, source), /must be installed locally/u);
});

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { langchainCandidates } from "./helpers/langchain-process.ts";
import {
  assertInstalledNpm,
  installCommand,
  type PackageSource,
  packageSource,
  pythonSelections,
} from "./helpers/package-source.ts";

const source: PackageSource = {
  npm: ["cli", "client", "ai-sdk"].map((name) => ({
    name: `@remote-skills/${name}`,
    version: "0.0.1-alpha.0",
    spec: `@remote-skills/${name}@0.0.1-alpha.0`,
  })),
  python: { version: "0.0.1a0", spec: "remote-skills==0.0.1a0" },
};

async function manifestFixture(t: TestContext) {
  const root = await mkdtemp(resolve(tmpdir(), "remote-skills-source-contract-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = resolve(root, "source.json");
  return {
    root,
    async read(value: unknown) {
      await writeFile(path, JSON.stringify(value));
      return packageSource(path);
    },
  };
}

function candidates(root: string): PackageSource {
  return {
    npm: [
      ...source.npm,
      {
        name: "@remote-skills/langchain",
        version: "0.0.2-alpha.0",
        spec: "@remote-skills/langchain@0.0.2-alpha.0",
      },
    ].map((entry) => ({ ...entry, spec: resolve(root, `${entry.name.replaceAll("/", "-")}.tgz`) })),
    python: [
      {
        name: "remote-skills",
        version: "0.0.1a0",
        spec: resolve(root, "remote_skills-0.0.1a0-py3-none-any.whl"),
      },
      {
        name: "remote-skills-langchain",
        version: "0.0.2a0",
        spec: resolve(root, "remote_skills_langchain-0.0.2a0-py3-none-any.whl"),
      },
    ],
  };
}

test("package setup keeps parseable stdout separate from tool diagnostics", async (t) => {
  const fixture = await manifestFixture(t);
  const output = await installCommand(
    process.execPath,
    ["-e", "process.stderr.write('progress\\n'); process.stdout.write('runtime==1.0\\n');"],
    fixture.root,
  );
  assert.equal(output, "runtime==1.0\n");
  await assert.rejects(
    installCommand(
      process.execPath,
      ["-e", "process.stderr.write('installation failed'); process.exit(2);"],
      fixture.root,
    ),
    /installation failed/u,
  );
});

test("installed E2Es accept the legacy SDK source and reject floating or duplicate selections", async (t) => {
  const fixture = await manifestFixture(t);
  assert.deepEqual(await fixture.read(source), source);
  assert.deepEqual(pythonSelections(source), [{ name: "remote-skills", ...source.python }]);
  await assert.rejects(
    fixture.read({ ...source, python: { version: "0.0.1a0", spec: "remote-skills" } }),
  );
  await assert.rejects(fixture.read({ ...source, npm: [...source.npm, source.npm[0]] }));
  await assert.rejects(
    fixture.read({
      ...source,
      npm: source.npm.map((entry) => ({ ...entry, spec: `${entry.name}@latest` })),
    }),
  );
});

test("named Python candidates retain independent SDK and adapter versions and exact archives", async (t) => {
  const fixture = await manifestFixture(t);
  const selected = candidates(fixture.root);
  assert.deepEqual(await fixture.read(selected), selected);
  const consumer = langchainCandidates(selected);
  assert.deepEqual(
    consumer.npm.map((entry) => entry.name),
    ["@remote-skills/cli", "@remote-skills/client", "@remote-skills/langchain"],
  );
  assert.deepEqual(
    pythonSelections(consumer).map((entry) => [entry.name, entry.version]),
    [
      ["remote-skills", "0.0.1a0"],
      ["remote-skills-langchain", "0.0.2a0"],
    ],
  );
});

test("named Python sources reject duplicate identities, a missing SDK, and mismatched exact pins", async (t) => {
  const fixture = await manifestFixture(t);
  const selected = candidates(fixture.root);
  const python = pythonSelections(selected);
  await assert.rejects(
    fixture.read({ ...selected, python: [...python, python[0]] }),
    /must be unique/u,
  );
  await assert.rejects(
    fixture.read({ ...selected, python: python.slice(1) }),
    /SDK must be selected/u,
  );
  await assert.rejects(
    fixture.read({
      ...selected,
      python: python.map((entry) => ({ ...entry, spec: `remote-skills==${entry.version}` })),
    }),
  );
  await assert.rejects(
    fixture.read({
      ...selected,
      npm: [
        ...selected.npm,
        {
          name: "@remote-skills/unknown",
          version: "0.0.1",
          spec: "@remote-skills/unknown@0.0.1",
        },
      ],
    }),
    /Unsupported npm/u,
  );
});

test("LangChain candidate mode cannot fall back when an adapter archive is absent", async (t) => {
  const fixture = await manifestFixture(t);
  const selected = candidates(fixture.root);
  assert.throws(
    () => langchainCandidates({ ...selected, npm: selected.npm.slice(0, -1) }),
    /TypeScript adapter candidates/u,
  );
  assert.throws(
    () => langchainCandidates({ ...selected, python: source.python }),
    /distinct Python SDK and adapter/u,
  );
  assert.throws(
    () =>
      langchainCandidates({
        ...selected,
        python: pythonSelections(selected).map((entry) => ({
          ...entry,
          spec: `${entry.name}==${entry.version}`,
        })),
      }),
    /exact local archives only/u,
  );
});

test("installed E2Es reject matching versions whose lock provenance uses other archive bytes", async (t) => {
  const fixture = await manifestFixture(t);
  const root = resolve(fixture.root, "consumer");
  const packageRoot = resolve(root, "node_modules/@remote-skills/cli");
  await mkdir(packageRoot, { recursive: true });
  await mkdir(resolve(root, "node_modules/.pnpm"));
  const entry = candidates(fixture.root).npm[0];
  assert.ok(entry);
  await writeFile(entry.spec, "independent candidate bytes");
  await writeFile(
    resolve(packageRoot, "package.json"),
    JSON.stringify({ name: entry.name, version: entry.version }),
  );
  await writeFile(
    resolve(root, "node_modules/.pnpm/lock.yaml"),
    `packages:\n  '${entry.name}@file:${entry.spec}':\n    resolution: {integrity: sha512-unrelated}\n`,
  );
  await assert.rejects(
    assertInstalledNpm(root, { npm: [entry], python: source.python }),
    /exact candidate archive bytes/u,
  );
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

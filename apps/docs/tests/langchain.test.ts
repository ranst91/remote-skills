import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { verifyPythonSnippets, verifyTypeScriptSnippets } from "./verify-snippets.ts";

const page = new URL("../content/docs/integrations/langchain.mdx", import.meta.url);

async function examples(language: "ts" | "python") {
  const source = await readFile(page, "utf8");
  return Array.from(
    source.matchAll(
      new RegExp(`^\x60\x60\x60${language}([^\\n]*)\\n([\\s\\S]*?)^\x60\x60\x60$`, "gmu"),
    ),
    (match) => {
      assert.ok(match[2]);
      return {
        code: match[2],
        info: `${language}${match[1] ?? ""}`,
        language,
        path: fileURLToPath(page),
      };
    },
  );
}

test("LangChain guide provides complete native consumer examples for all six paths", async () => {
  const typescript = await examples("ts");
  const python = await examples("python");
  assert.equal(typescript.length, 3);
  assert.equal(python.length, 3);
  for (const snippet of typescript) {
    assert.match(snippet.code, /from "@remote-skills\/client"/u);
    assert.match(snippet.code, /from "@remote-skills\/langchain"/u);
    assert.match(snippet.code, /await using session = await client\.session\("team"\)/u);
    assert.match(snippet.code, /await using remote = await remoteSkills\(\{ session \}\)/u);
    assert.match(snippet.code, /return await (?:agent|graph)\.invoke\(/u);
    assert.doesNotMatch(snippet.code, /\.activate\(/u);
  }
  for (const snippet of python) {
    assert.match(snippet.code, /from remote_skills import Origin, RemoteSkills/u);
    assert.match(snippet.code, /from remote_skills_langchain import create_remote_skills_backend/u);
    assert.match(snippet.code, /async with client\.session\("team"\) as session:/u);
    assert.match(snippet.code, /source = await create_remote_skills_backend\(session\)/u);
    assert.match(snippet.code, /return await agent\.ainvoke\(/u);
    assert.doesNotMatch(snippet.code, /\.activate\(/u);
  }
  assert.match(typescript[0]?.code ?? "", /\.\.\.remote\.deepAgentOptions/u);
  assert.match(python[0]?.code ?? "", /\*\*source\.deep_agent_options\(\)/u);
  assert.match(typescript[1]?.code ?? "", /middleware: remote\.middleware/u);
  assert.match(python[1]?.code ?? "", /middleware=source\.middleware\(\)/u);
  assert.match(typescript[2]?.code ?? "", /\.addNode\("skills", nativeAgent\.graph\)/u);
  assert.match(python[2]?.code ?? "", /graph\.add_node\("skills", native_agent\)/u);
  await verifyTypeScriptSnippets(typescript);
  verifyPythonSnippets(python);
});

test("LangChain snippet checking rejects invented public adapter APIs", async () => {
  await assert.rejects(
    verifyTypeScriptSnippets([
      {
        code: 'import type { RemoteSkillsIntegration } from "@remote-skills/langchain";\ndeclare const adapter: RemoteSkillsIntegration;\nadapter.agentOptions;\n',
        info: "ts",
        language: "ts",
        path: fileURLToPath(page),
      },
    ]),
    /Property 'agentOptions' does not exist/u,
  );
  assert.throws(
    () =>
      verifyPythonSnippets([
        {
          code: "from remote_skills_langchain import invented_skill_loader\n",
          info: "python",
          language: "python",
          path: fileURLToPath(page),
        },
      ]),
    /has no attribute 'invented_skill_loader'/u,
  );
});

test("core snippet consumers do not inherit LangChain dependencies", async () => {
  await assert.rejects(
    verifyTypeScriptSnippets([
      {
        code: 'declare const backend: import("deepagents").BackendProtocolV2;\n',
        info: "ts",
        language: "ts",
        path: fileURLToPath(new URL("../content/docs/consume.mdx", import.meta.url)),
      },
    ]),
    /Cannot find module 'deepagents'/u,
  );
});

test("Python import checks never execute example bodies", () => {
  assert.doesNotThrow(() =>
    verifyPythonSnippets([
      {
        code: 'from remote_skills_langchain import create_remote_skills_backend\nraise AssertionError("Example bodies must not run during import verification")\n',
        info: "python",
        language: "python",
        path: fileURLToPath(page),
      },
    ]),
  );
});

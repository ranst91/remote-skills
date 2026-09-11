import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnPnpmSync } from "../../../scripts/lib/pnpm-command.ts";
import { assertLockedIntegrationResolution } from "../../../scripts/release/integration-dependencies.ts";

const repository = fileURLToPath(new URL("../../../", import.meta.url));
const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const directory = await mkdtemp(join(tmpdir(), "remote-skills-langchain-package-"));
const artifacts = join(directory, "artifacts");
const consumer = join(directory, "consumer");

function pnpm(args: string[], cwd: string) {
  // Offline resolution still uses the original registry metadata cache key.
  const env = { ...process.env };
  delete env.npm_config_registry;
  delete env.NPM_CONFIG_REGISTRY;
  const result = spawnPnpmSync(args, { cwd, encoding: "utf8", env });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

async function writeConsumerLock() {
  const lock = await readFile(join(repository, "pnpm-lock.yaml"), "utf8");
  assert.ok(lock.startsWith("lockfileVersion: '9.0'\n"));
  const marker = "\n  integrations/langchain:\n";
  const start = lock.indexOf(marker);
  assert.ok(start >= 0, "Locked LangChain importer exists.");
  const bodyStart = start + marker.length;
  const next = lock.slice(bodyStart).search(/\n {2}\S/u);
  const packages = lock.indexOf("\npackages:\n");
  assert.ok(packages > bodyStart);
  const body = lock.slice(bodyStart, next < 0 ? packages : bodyStart + next);
  const entries = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const line of body.split("\n")) {
    const match = /^ {6}([^ ].*):$/u.exec(line);
    if (match?.[1]) {
      current = [];
      entries.set(match[1].replace(/^'|'$/gu, ""), current);
    } else if (line && !line.startsWith("        ")) current = undefined;
    if (current && line) current.push(line);
  }
  const parsed: unknown = JSON.parse(await readFile(join(consumer, "package.json"), "utf8"));
  assert.ok(
    parsed &&
      typeof parsed === "object" &&
      "dependencies" in parsed &&
      parsed.dependencies &&
      typeof parsed.dependencies === "object",
  );
  const projected = Object.entries(parsed.dependencies).map(([name, version]) => {
    assert.equal(typeof version, "string");
    const lines = entries.get(name);
    assert.ok(lines, "Consumer dependency has a locked importer entry.");
    assert.ok(
      lines?.some((line) => /^ {8}version: /u.test(line)),
      "Consumer dependency exists in the source lock.",
    );
    return lines
      .map((line) => (/^ {8}specifier: /u.test(line) ? `        specifier: ${version}` : line))
      .join("\n");
  });
  const catalogs = lock.indexOf("\ncatalogs:\n");
  const headerEnd = catalogs < 0 ? lock.indexOf("\nimporters:\n") : catalogs;
  assert.ok(headerEnd > 0);
  await writeFile(
    join(consumer, "pnpm-lock.yaml"),
    `${lock.slice(0, headerEnd)}\nimporters:\n\n  .:\n    dependencies:\n${projected.join("\n")}\n${lock.slice(packages)}`,
  );
}

async function packageManifest(
  path: string,
): Promise<{ version: string; metadata: Record<string, unknown> }> {
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  assert.ok(
    value && typeof value === "object" && "version" in value && typeof value.version === "string",
  );
  const metadata: Record<string, unknown> = {};
  for (const field of ["peerDependencies", "engines", "license"]) {
    const fieldValue: unknown = Reflect.get(value, field);
    metadata[field] = fieldValue;
  }
  return { version: value.version, metadata };
}

try {
  await mkdir(artifacts);
  await mkdir(consumer);
  pnpm(["build"], packageRoot);
  pnpm(["pack:local", "--", "--pack-destination", artifacts], packageRoot);
  pnpm(
    ["--filter", "@remote-skills/client", "pack:local", "--", "--pack-destination", artifacts],
    repository,
  );
  const manifest = await packageManifest(join(packageRoot, "package.json"));
  const sdkManifest = await packageManifest(
    join(repository, "packages/sdk-typescript/package.json"),
  );
  const tarball = join(artifacts, `remote-skills-langchain-${manifest.version}.tgz`);
  const sdk = join(artifacts, `remote-skills-client-${sdkManifest.version}.tgz`);
  const repeated = join(directory, "repeated");
  await mkdir(repeated);
  pnpm(["pack:local", "--", "--pack-destination", repeated], packageRoot);
  assert.ok(
    (await readFile(tarball)).equals(
      await readFile(join(repeated, `remote-skills-langchain-${manifest.version}.tgz`)),
    ),
    "Repeated packs have identical bytes.",
  );
  const extracted = spawnSync("tar", ["-xOf", tarball, "package/package.json"], {
    encoding: "utf8",
    shell: false,
  });
  assert.equal(extracted.status, 0);
  const packed: unknown = JSON.parse(extracted.stdout);
  assert.ok(packed && typeof packed === "object" && !Array.isArray(packed));
  assert.equal(Reflect.get(packed, "version"), manifest.version);
  for (const [field, expected] of Object.entries(manifest.metadata)) {
    assert.deepEqual(
      Reflect.get(packed, field),
      expected,
      `Packed ${field} matches the source contract.`,
    );
  }
  for (const field of ["scripts", "devDependencies", "packageManager", "private"])
    assert.equal(Reflect.get(packed, field), undefined, `Runtime manifest excludes ${field}.`);
  assert.ok(
    !/workspace:|catalog:|file:|link:/u.test(extracted.stdout),
    "Runtime manifest has no local dependency protocols.",
  );
  const listed = spawnSync("tar", ["-tf", tarball], { encoding: "utf8", shell: false });
  assert.equal(listed.status, 0, listed.stderr);
  const files = listed.stdout.trim().split("\n");
  assert.ok(files.includes("package/dist/index.js"));
  assert.ok(files.includes("package/dist/index.d.ts"));
  assert.ok(files.includes("package/LICENSE"));
  assert.ok(files.includes("package/README.md"));
  assert.ok(files.every((file) => !/\/(?:src|tests|node_modules)\//u.test(file)));
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify(
      {
        name: "remote-skills-langchain-installed-consumer",
        private: true,
        type: "module",
        dependencies: {
          deepagents: "1.13.4",
          langchain: "1.5.11",
          "@langchain/core": "1.2.10",
          "@langchain/langgraph": "1.4.14",
          langsmith: "0.9.0",
          openai: "7.13.0",
          zod: "4.3.6",
          typescript: "7.0.2",
          "@types/node": "24.13.3",
        },
      },
      null,
      2,
    ),
  );
  await writeConsumerLock();
  pnpm(
    ["install", "--frozen-lockfile", "--offline", "--ignore-scripts", "--strict-peer-dependencies"],
    consumer,
  );
  pnpm(
    [
      "add",
      "--offline",
      "--ignore-scripts",
      "--strict-peer-dependencies",
      `file:${tarball}`,
      `file:${sdk}`,
    ],
    consumer,
  );
  assertLockedIntegrationResolution(repository, consumer, [tarball, sdk]);
  await writeFile(
    join(consumer, "consumer.ts"),
    `
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRemoteSkills } from "@remote-skills/client";
import { remoteSkills } from "@remote-skills/langchain";
import { BaseChatModel, type BindToolsInput } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage, ToolMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { createAgent } from "langchain";
import { createDeepAgent } from "deepagents";
import { END, MessagesAnnotation, START, StateGraph } from "@langchain/langgraph";
assert.ok(import.meta.resolve("@remote-skills/langchain").includes("node_modules"));
assert.ok(!import.meta.resolve("@remote-skills/langchain").includes(${JSON.stringify(repository)}));
assert.ok(!import.meta.resolve("@remote-skills/client").includes(${JSON.stringify(repository)}));

const artifact = Buffer.from('---\\nname: greeting\\ndescription: Greeting\\n---\\nInstalled artifact instructions.\\n');
const digest = "sha256:" + createHash("sha256").update(artifact).digest("hex");
let downloads = 0;
const client = createRemoteSkills({ origins: { team: { url: "https://skills.example.test" } }, cache: "memory" }, {
  resolve: async () => [{ address: "93.184.216.34", family: 4 }],
  transport: async (request) => {
    const catalog = new URL(request.url).pathname.endsWith("index.json");
    if (!catalog) downloads += 1;
    return { status: 200, headers: { "content-type": catalog ? "application/json" : "text/markdown" }, body: catalog ? Buffer.from(JSON.stringify({ $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json", skills: [{ name: "greeting", description: "Greeting", type: "skill-md", url: "greeting.md", digest }] })) : artifact };
  },
});
class Model extends BaseChatModel {
  _llmType() { return "installed-model"; }
  bindTools(_tools: BindToolsInput[]) { return this; }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const loaded = messages.some(ToolMessage.isInstance);
    if (!loaded) assert.equal(downloads, 0);
    else assert.ok(JSON.stringify(messages).includes("Installed artifact instructions."));
    const message = loaded ? new AIMessage("loaded") : new AIMessage({ content: "", tool_calls: [{ id: "load", name: "read_file", args: { file_path: "/skills/greeting/SKILL.md" } }] });
    return { generations: [{ message, text: "" }] };
  }
}
await using session = await client.session("team");
await using remote = await remoteSkills({ session });
const model = new Model({});
const native = createAgent({ model, middleware: remote.middleware });
createDeepAgent({ model, ...remote.deepAgentOptions });
new StateGraph(MessagesAnnotation).addNode("skills", native.graph).addEdge(START, "skills").addEdge("skills", END).compile();
const result = await native.invoke({ messages: [{ role: "user", content: "Use greeting." }] });
assert.equal(result.messages.at(-1)?.content, "loaded");
assert.equal(downloads, 1);
console.log("Installed native LangChain consumer passed.");
`,
  );
  pnpm(
    [
      "exec",
      "tsc",
      "--noEmit",
      "--strict",
      "--exactOptionalPropertyTypes",
      "--skipLibCheck",
      "--target",
      "ES2024",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--types",
      "node",
      "--lib",
      "ES2024,ESNext.Disposable",
      "consumer.ts",
    ],
    consumer,
  );
  const result = spawnSync(process.execPath, [join(consumer, "consumer.ts")], {
    cwd: consumer,
    encoding: "utf8",
    shell: false,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  process.stdout.write(result.stdout);
  const hash = createHash("sha256")
    .update(await readFile(tarball))
    .digest("hex");
  console.log(`Local npm artifact SHA-256: ${hash}`);
} finally {
  await rm(directory, { recursive: true, force: true });
}

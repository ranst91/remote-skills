import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  publicDocumentationFiles,
  verifyBashSnippet,
  verifyDocumentationSnippets,
  verifyExactHostedBuildBytes,
  verifyTypeScriptSnippets,
} from "./verify-snippets.ts";

const docsRoot = new URL("../content/docs/", import.meta.url);
const docsRootPath = fileURLToPath(docsRoot);
const appRootPath = fileURLToPath(new URL("../", import.meta.url));

const migratedTypeScriptFiles = [
  "next.config.ts",
  "tests/agent-accessibility.test.ts",
  "tests/docs-contract.test.ts",
  "tests/links.test.ts",
  "tests/production-routes.test.ts",
  "tests/verify-snippets.ts",
];

const rootNavigation = [
  "---Getting started---",
  "index",
  "quickstart",
  "---Publish---",
  "publisher",
  "hosting",
  "---Consume---",
  "consume",
  "integrations",
  "---Concepts---",
  "concepts",
  "hosting/local-or-remote",
  "cache-and-offline",
  "versions",
  "authentication-and-scopes",
  "trust-and-security",
  "---Reference---",
  "cli",
  "configuration",
  "api-reference",
  "release",
];

const hostingNavigation = ["archive-to-origin", "git-pages"];
const integrationNavigation = ["index", "[Vercel AI SDK](/docs/vercel-ai-sdk)"];
const navigation = rootNavigation
  .filter((slug) => !slug.startsWith("---"))
  .flatMap((slug) =>
    slug === "hosting"
      ? hostingNavigation.map((page) => `hosting/${page}`)
      : slug === "integrations"
        ? ["integrations/index", "vercel-ai-sdk"]
        : [slug],
  );

test("docs authored runtime and test modules use the final TypeScript paths", () => {
  for (const successor of migratedTypeScriptFiles) {
    assert.equal(existsSync(join(appRootPath, successor)), true, `${successor} must exist`);
    assert.equal(
      existsSync(join(appRootPath, successor.replace(/\.ts$/u, ".mjs"))),
      false,
      `${successor} must not keep its .mjs predecessor`,
    );
  }
  assert.equal(existsSync(join(appRootPath, "postcss.config.mjs")), true);
});

function readDoc(slug: string) {
  return readFileSync(new URL(`${slug}.mdx`, docsRoot), "utf8");
}

function allDocs() {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.name.endsWith(".mdx")) files.push(readFileSync(path, "utf8"));
    }
  };
  visit(docsRootPath);
  return files.join("\n");
}

test("canonical navigation lists every task 8.1 page and every page exists", () => {
  const meta: unknown = JSON.parse(
    readFileSync(new URL("../content/docs/meta.json", import.meta.url), "utf8"),
  );
  const hostingMeta: unknown = JSON.parse(
    readFileSync(new URL("../content/docs/hosting/meta.json", import.meta.url), "utf8"),
  );
  assert.ok(meta !== null && typeof meta === "object" && "pages" in meta);
  assert.ok(hostingMeta !== null && typeof hostingMeta === "object" && "pages" in hostingMeta);
  assert.deepEqual(meta.pages, rootNavigation);
  assert.deepEqual(hostingMeta.pages, hostingNavigation);
  const integrationsMeta: unknown = JSON.parse(
    readFileSync(new URL("../content/docs/integrations/meta.json", import.meta.url), "utf8"),
  );
  assert.ok(
    integrationsMeta !== null &&
      typeof integrationsMeta === "object" &&
      "pages" in integrationsMeta,
  );
  assert.deepEqual(integrationsMeta.pages, integrationNavigation);
  for (const slug of navigation) assert.equal(existsSync(new URL(`${slug}.mdx`, docsRoot)), true);
});

test("archive-to-origin guidance names the exact deployment unit and response contract", () => {
  const doc = readDoc("hosting/archive-to-origin");
  for (const phrase of [
    "dist/.well-known/agent-skills/index.json",
    "/.well-known/agent-skills/index.json",
    "application/json",
    "text/markdown; charset=utf-8",
    "application/zip",
    "application/gzip",
    "Archives are served exactly as built",
    "digest covers the exact response bytes",
  ]) {
    assert.match(doc, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  }
});

test("Git hosting guidance covers CI, Pages, custom domains, and the project-subpath caveat", () => {
  const doc = readDoc("hosting/git-pages");
  assert.match(doc, /build after the checkout and dependency-install steps/i);
  assert.match(doc, /`build` validates the skills and creates `dist\/`/i);
  assert.match(doc, /GitHub Pages/i);
  assert.match(doc, /GitLab Pages/i);
  assert.match(doc, /custom domain/i);
  assert.match(doc, /\/repository-name\//i);
  assert.match(doc, /origin-root/i);
});

test("local-or-remote guidance covers image-local decisions and container cache costs", () => {
  const doc = readDoc("hosting/local-or-remote");
  assert.match(doc, /Use skills from the local filesystem/i);
  assert.match(doc, /container image/i);
  assert.match(doc, /persistent (cache )?volume/i);
  assert.match(doc, /ephemeral/i);
  assert.match(doc, /network, hashing, extraction, and storage/i);
});

test("boundary language distinguishes downloads, context, scopes, versions, and trust", () => {
  const docs = allDocs();
  for (const phrase of [
    "complete artifact",
    "context-lazy",
    "does not grant access",
    "provider authorizes",
    "byte integrity",
    "does not prove",
    "future sessions",
    "Publishers can stop offering an older release",
    "fail closed",
  ]) {
    assert.match(docs, new RegExp(phrase, "i"));
  }
  assert.doesNotMatch(docs, /hosted Remote Skills service/i);
  assert.doesNotMatch(docs, /Remote Skills cloud/i);
});

test("CLI, SDK, config, API, and Quickstart pages use the public package names", () => {
  assert.match(readDoc("cli"), /remote-skills (?:validate|build|dev|verify)/);
  assert.match(readDoc("consume"), /createRemoteSkills/);
  assert.match(readDoc("consume"), /session\.activate/);
  assert.match(readDoc("consume"), /RemoteSkills/);
  assert.match(readDoc("consume"), /Origin/);
  assert.match(readDoc("configuration"), /remote-skills\.json/);
  assert.match(readDoc("api-reference"), /version_unavailable/);
  assert.match(readDoc("quickstart"), /npm install -D @remote-skills\/cli/);
  assert.match(readDoc("quickstart"), /npm install @remote-skills\/client/);
  assert.match(readDoc("quickstart"), /python -m pip install remote-skills/);
});

test("Quickstart keeps three steps with separately copyable installation and usage", () => {
  assert.equal(existsSync(new URL("installation.mdx", docsRoot)), false);
  assert.doesNotMatch(allDocs(), /\/docs\/installation|preview packages|locally built packages/i);
  const quickstart = readDoc("quickstart");
  const steps = Array.from(quickstart.matchAll(/<Step>\n([\s\S]*?)<\/Step>/gu), (match) => {
    assert.ok(match[1]);
    return match[1];
  });
  assert.deepEqual(
    steps.map((step) => step.match(/^## (.+)$/mu)?.[1]),
    ["Create a skill", "Serve it", "Use it in your agent"],
  );
  const [, serving, usage] = steps;
  assert.ok(serving);
  assert.ok(usage);
  for (const [section, commands, lastInstallation, firstUsage] of [
    [
      serving,
      [
        "npm install -D @remote-skills/cli",
        "pnpm add -D @remote-skills/cli",
        "bun add -D @remote-skills/cli",
        "npm exec -- remote-skills dev",
        "pnpm exec remote-skills dev",
        "bun run remote-skills dev",
      ],
      "bun add -D @remote-skills/cli",
      "npm exec -- remote-skills dev",
    ],
    [
      usage,
      [
        "npm install @remote-skills/client",
        "pnpm add @remote-skills/client",
        "bun add @remote-skills/client",
        "python -m pip install remote-skills",
        "uv add remote-skills",
      ],
      "uv add remote-skills",
      'import { createRemoteSkills } from "@remote-skills/client";',
    ],
  ] as const) {
    assert.deepEqual(
      Array.from(section.matchAll(/^```bash\n([\s\S]*?)^```$/gmu), (match) => match[1]?.trim()),
      commands,
      "Each command must have its own code block in the appropriate step",
    );
    const first = section.match(/^First, [^\n]+$/mu);
    const then = section.match(/^Then, [^\n]+$/mu);
    assert.ok(first);
    assert.ok(then);
    for (const leadIn of [first[0], then[0]]) {
      assert.ok(leadIn.split(/\s+/u).length <= 40, "Keep installation and usage lead-ins brief");
    }
    assert.ok(section.indexOf(first[0]) < section.indexOf(commands[0]));
    assert.ok(section.indexOf(lastInstallation) < section.indexOf(then[0]));
    assert.ok(section.indexOf(then[0]) < section.indexOf(firstUsage));
  }
  assert.match(usage, /import \{ createRemoteSkills \}/u);
  assert.match(usage, /from remote_skills import/u);
});

test("references expose command options, typed fields, and SDK method contracts", () => {
  const commands = readDoc("cli")
    .split(/^## `remote-skills /mu)
    .slice(1);
  assert.equal(commands.length, 4);
  for (const command of commands) {
    assert.match(command, /\| (?:Option|Argument or option) \| Default \| Effect \|/u);
  }
  assert.match(readDoc("configuration"), /\| Field \| Type \| Default \| Description \|/u);
  const api = readDoc("api-reference");
  for (const section of [
    "Client creation",
    "Origin settings",
    "Client methods",
    "Session methods",
    "Returned data",
    "Resource methods",
    "Activation limits",
  ]) {
    assert.ok(api.includes(`## ${section}\n`), `missing API reference section: ${section}`);
  }
  assert.match(api, /\| Language \| Signature \| Resolves to \|/u);
  assert.match(api, /\| Code \| Meaning \|/u);
  assert.match(api, /\| `timeoutMs` .*milliseconds/u);
  assert.match(api, /\| `timeout` .*seconds/u);
});

test("Vercel AI SDK guidance preserves model choice, streaming lifetime, and runtime limits", () => {
  const doc = readDoc("vercel-ai-sdk");
  assert.deepEqual(
    Array.from(doc.matchAll(/^```bash\n([\s\S]*?)^```$/gmu), (match) => match[1]?.trim()),
    [
      "npm install @remote-skills/ai-sdk @remote-skills/client ai",
      "pnpm add @remote-skills/ai-sdk @remote-skills/client ai",
      "bun add @remote-skills/ai-sdk @remote-skills/client ai",
    ],
  );
  const snippets = Array.from(doc.matchAll(/^```ts[^\n]*\n([\s\S]*?)^```$/gmu), (match) => {
    assert.ok(match[1]);
    return match[1];
  });
  assert.equal(snippets.length, 2);
  for (const snippet of snippets) {
    assert.match(snippet, /from "@remote-skills\/ai-sdk"/u);
    assert.match(snippet, /from "@remote-skills\/client"/u);
    assert.match(snippet, /from "ai"/u);
    assert.match(snippet, /model: "openai\/gpt-5\.2"/u);
    assert.match(snippet, /try \{[\s\S]+\} finally \{\s+await skills\.close\(\);/u);
    assert.doesNotMatch(snippet, /\.activate\(/u);
  }
  const [agent, stream] = snippets;
  assert.ok(agent);
  assert.ok(stream);
  assert.match(agent, /new ToolLoopAgent\(/u);
  assert.match(agent, /url: "https:\/\/skills\.example\.com"/u);
  assert.match(stream, /export async function\* streamReply\(client: RemoteSkillsClient/u);
  assert.match(stream, /stopWhen: stepCountIs\(6\)/u);
  assert.match(stream, /for await \(const text of result\.textStream\) yield text;/u);
  assert.ok(stream.indexOf("for await") < stream.indexOf("finally"));
  for (const phrase of [
    "AI_GATEWAY_API_KEY",
    "The model chooses whether",
    "direct answer is valid",
    "writable temporary directory",
    "does not run on Edge",
    "Only catalog metadata is loaded initially",
    "complete artifact",
    "no command-execution or file-write tool",
    "Binary resources remain available",
  ])
    assert.ok(doc.includes(phrase), `missing integration boundary: ${phrase}`);
  for (const slug of ["quickstart", "consume", "api-reference"]) {
    assert.match(readDoc(slug), /\/docs\/vercel-ai-sdk/u);
  }
  const api = readDoc("api-reference");
  for (const contract of [
    "## Vercel AI SDK integration",
    "RemoteSkillsOptions",
    "RemoteSkillsIntegration",
    "RemoteSkillsTools",
    "{ client, origin }",
    "{ client, origins }",
    "{ session }",
    "Unknown skill keys or empty constraints fail setup",
    "Does not close a caller-owned session",
    "without diagnostic context",
  ])
    assert.ok(api.includes(contract), `missing integration API contract: ${contract}`);
});

test("compatibility documents standards rather than release-process status", () => {
  const doc = readDoc("release");
  for (const field of ["Agent Skills", "v0.2.0", "skill-md", "archive", "x-remote-skills"]) {
    assert.ok(doc.includes(field), `missing compatibility contract: ${field}`);
  }
  assert.match(doc, /unsupported_schema/u);
  assert.doesNotMatch(doc, /Packages and runtimes|What v0 provides|Platform validation|0\.0\.1/u);
  assert.match(
    readDoc("concepts"),
    /same `SKILL\.md`, resources, and discover-then-load workflow/u,
  );
  assert.match(readDoc("concepts"), /instead of installing skill folders/u);
});

test("access-control guidance covers the host and client responsibilities together", () => {
  const doc = readDoc("authentication-and-scopes");
  assert.match(doc, /^title: Authentication and authorization$/mu);
  for (const phrase of [
    /### On the host/u,
    /### In the client/u,
    /both catalog and artifact requests/u,
    /Remote-Skills-Scope: engineering/u,
    /304 Not Modified/u,
    /does not grant access/u,
    /artifactHeaders/u,
    /artifact_headers/u,
    /Cache-Control: no-store/u,
  ]) {
    assert.match(doc, phrase);
  }
  assert.doesNotMatch(allDocs(), /\[Private origins\]|^title: Private origins$/mu);
});

test("security guidance explains verification without promising instruction safety", () => {
  const doc = readDoc("trust-and-security");
  for (const phrase of [
    /does not prove that the instructions are correct or safe/u,
    /never executes bundled scripts/u,
    /allowed-tools/u,
    /cannot write outside the skill's folder/u,
    /bytes actually received and unpacked/u,
    /each connection and redirect/u,
    /do not isolate the build/u,
  ]) {
    assert.match(doc, phrase);
  }
});

test("docs leave runtime version floors to package metadata", () => {
  const docs = `${allDocs()}\n${readFileSync(join(appRootPath, "README.md"), "utf8")}`;
  assert.doesNotMatch(docs, /\b(?:Node(?:\.js)?|Python)\s+v?\d+(?:\.\d+){0,2}\+/iu);
});

test("guides omit redundant SDK captions and text-art diagrams", () => {
  for (const slug of ["consume", "quickstart"]) {
    assert.doesNotMatch(readDoc(slug), /The TypeScript client runs|The Python distribution is/u);
  }
  const source = `${allDocs()}\n${readFileSync(new URL("../../../README.md", import.meta.url), "utf8")}`;
  assert.doesNotMatch(source, /[\u2500-\u257f]/u);
  for (const match of source.matchAll(/^```text\n([\s\S]*?)^```$/gmu)) {
    const content = match[1];
    assert.ok(content);
    assert.doesNotMatch(content, /[←→↑↓]|[-=]{2,}>/u);
  }
  assert.match(readDoc("publisher"), /skills\/howdy\/references\/welcome\.md/u);
});

test("every public documentation snippet has an executable contract gate", async () => {
  const report = await verifyDocumentationSnippets();
  assert.ok(report.files >= 20, `unexpected public documentation inventory: ${report.files}`);
  assert.ok(report.snippets >= 30, `unexpected snippet inventory: ${report.snippets}`);
  assert.ok(
    report.executable >= 20,
    `unexpected executable snippet inventory: ${report.executable}`,
  );
  for (const language of ["bash", "json", "md", "python", "ts"] as const) {
    assert.ok(report.languages[language] > 0, `missing ${language} snippet coverage`);
  }
  assert.equal(report.bash.classifiedSnippets, report.languages.bash);
  assert.ok(report.bash.executedCommands > 0);
  assert.ok(report.bash.staticCommands > 0);
});

test("Bash contracts reject invented CLI commands and flags", () => {
  const path = fileURLToPath(new URL("../../../README.md", import.meta.url));
  for (const code of ["remote-skills invent", "remote-skills build --invented-flag"]) {
    assert.throws(
      () => verifyBashSnippet({ code, info: "bash", language: "bash", ordinal: 1, path }),
      /unsupported documented Bash command/u,
    );
  }
});

test("package-manager tabs preserve the same validated CLI contract", () => {
  const path = fileURLToPath(new URL("publisher.mdx", docsRoot));
  const runners = ["npm exec --", "pnpm exec", "bun run"];
  for (const [ordinal, runner] of runners.entries()) {
    const snippet = { info: "bash", language: "bash" as const, ordinal, path };
    assert.doesNotThrow(() =>
      verifyBashSnippet({ ...snippet, code: `${runner} remote-skills validate` }),
    );
    assert.throws(
      () => verifyBashSnippet({ ...snippet, code: `${runner} remote-skills validate --invented` }),
      /unsupported documented Bash command/u,
    );
  }
});

test("integration snippet checking rejects APIs outside the real public package", async () => {
  await assert.rejects(
    verifyTypeScriptSnippets([
      {
        language: "ts",
        info: "ts",
        path: fileURLToPath(new URL("vercel-ai-sdk.mdx", docsRoot)),
        code: `import { remoteSkills } from "@remote-skills/ai-sdk";
import { createRemoteSkills } from "@remote-skills/client";
const client = createRemoteSkills({ origins: { team: { url: "https://skills.example.com" } } });
const skills = await remoteSkills({ client, origin: "team" });
skills.tools.bash;
`,
      },
    ]),
    /Property 'bash' does not exist/u,
  );
});

test("the documented static host returns exact CLI-built bytes", async () => {
  const report = await verifyExactHostedBuildBytes();
  assert.equal(report.artifacts, 1);
  assert.ok(report.indexBytes > 0);
});

test("public docs state the service and semantic boundaries without collapsing them", async () => {
  const source = (
    await Promise.all((await publicDocumentationFiles()).map((path) => readFileSync(path, "utf8")))
  ).join("\n");
  for (const phrase of [
    "byte integrity",
    "does not prove",
    "SDK keeps downloaded skills on disk",
    "Memory-only",
    "complete artifact",
    "context-lazy",
    "does not grant access",
    "provider authorizes",
    "does not require the publisher to keep a release available forever",
    "provider may prune",
    "There is no marketplace or central service",
  ]) {
    assert.match(source, new RegExp(phrase, "iu"));
  }
  const readme = readFileSync(new URL("../../../README.md", import.meta.url), "utf8");
  assert.match(readme, /There is no managed Remote Skills service/u);
  assert.match(readme, /For Vercel AI SDK, the \[integration\]/u);
  assert.doesNotMatch(source, /no managed Remote Skills service or framework adapter/iu);
  assert.doesNotMatch(
    source,
    /(?:remote-skills-(?:cli|client)-[^\s`]+\.tgz|remote_skills-[^\s`]+\.whl)/u,
  );
  assert.doesNotMatch(
    source,
    /@remote-skills\/(?:cli|client|ai-sdk)@|(?:pip install|uv add) remote-skills[=<>~!]/u,
  );
});

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, relative, resolve } from "node:path";
import { createPnpmCommand } from "../../../scripts/lib/pnpm-command.ts";
import { runRemoteSkills } from "../../../tests/examples/helpers/public-cli.ts";
import { startStaticOrigin } from "../../../tests/examples/helpers/static-host.ts";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const docsRoot = resolve(repositoryRoot, "apps/docs/content/docs");
const requireFromClient = createRequire(
  resolve(repositoryRoot, "packages/sdk-typescript/package.json"),
);
interface YamlModule {
  parseDocument(
    source: string,
    options: { prettyErrors: boolean; strict: boolean },
  ): { errors: readonly unknown[] };
}

function isYamlModule(value: unknown): value is YamlModule {
  return (
    value !== null &&
    typeof value === "object" &&
    "parseDocument" in value &&
    typeof value.parseDocument === "function"
  );
}

const yamlModule: unknown = requireFromClient("yaml");
if (!isYamlModule(yamlModule)) throw new Error("yaml package does not expose parseDocument");
const { parseDocument } = yamlModule;
const ignoredDirectories = new Set([".git", ".next", ".turbo", ".venv", "dist", "node_modules"]);
const recognizedLanguageNames = ["bash", "json", "md", "python", "text", "ts", "yaml"] as const;
type SnippetLanguage = (typeof recognizedLanguageNames)[number];
const executableLanguages = new Set<SnippetLanguage>([
  "bash",
  "json",
  "md",
  "python",
  "ts",
  "yaml",
]);
function isSnippetLanguage(value: string): value is SnippetLanguage {
  return (
    value === "bash" ||
    value === "json" ||
    value === "md" ||
    value === "python" ||
    value === "text" ||
    value === "ts" ||
    value === "yaml"
  );
}
type BashAction = "build" | "build-configured" | "client-build" | "validate" | "validate-strict";
type BashContractEntry =
  | { command: string; mode: "execute"; action: BashAction }
  | { command: string; mode: "static"; reason: string };
interface Snippet {
  code: string;
  info: string;
  language: SnippetLanguage;
  ordinal?: number;
  path: string;
}
interface CheckedSpawnOptions {
  input?: string;
  cwd?: string;
}
interface HostedCatalogEntry {
  digest: string;
  name: string;
  type: string;
  url: string;
}
interface JsonObject {
  [key: string]: unknown;
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredString(object: JsonObject, key: string, label: string): string {
  const value = object[key];
  if (typeof value !== "string") throw new Error(`${label}.${key} must be a string`);
  return value;
}

function parseHostedCatalog(source: string): HostedCatalogEntry[] {
  const catalog: unknown = JSON.parse(source);
  if (!isJsonObject(catalog) || !Array.isArray(catalog.skills)) {
    throw new Error("hosted catalog must contain a skills array");
  }
  const skills: unknown[] = catalog.skills;
  return skills.map((entry, index) => {
    if (!isJsonObject(entry)) throw new Error(`hosted catalog skill ${index} must be an object`);
    const label = `hosted catalog skill ${index}`;
    return {
      digest: requiredString(entry, "digest", label),
      name: requiredString(entry, "name", label),
      type: requiredString(entry, "type", label),
      url: requiredString(entry, "url", label),
    };
  });
}
const basicChatContract: readonly BashContractEntry[] = [
  { command: "pnpm i", mode: "static", reason: "executed-by-tests/examples/vercel-ai-sdk.test.ts" },
  {
    command: "cp .env.example .env",
    mode: "static",
    reason: "executed-by-tests/examples/vercel-ai-sdk.test.ts",
  },
  {
    command: "pnpm run dev",
    mode: "static",
    reason: "executed-by-tests/examples/vercel-ai-sdk.test.ts",
  },
];

function packageManagerContracts(
  path: string,
  startOrdinal: number,
  entries: readonly BashContractEntry[],
  managers: readonly ("npm" | "pnpm" | "bun")[] = ["npm", "pnpm", "bun"],
): [string, readonly BashContractEntry[]][] {
  const commands = {
    npm: { run: "npm exec -- ", install: "npm install " },
    pnpm: { run: "pnpm exec ", install: "pnpm add " },
    bun: { run: "bun run ", install: "bun add " },
  };
  return managers.map((manager, offset) => [
    `${path}#${startOrdinal + offset}`,
    entries.map((entry) => ({
      ...entry,
      command: entry.command
        .replace("pnpm exec ", commands[manager].run)
        .replace("pnpm add ", commands[manager].install),
    })),
  ]);
}

const bashContracts: ReadonlyMap<string, readonly BashContractEntry[]> = new Map([
  ["examples/vercel-ai-sdk/README.md#0", basicChatContract],
  [
    "README.md#0",
    [
      { command: "remote-skills validate", mode: "execute", action: "validate" },
      { command: "remote-skills dev", mode: "static", reason: "long-running-server" },
    ],
  ],
  ["README.md#1", [{ command: "remote-skills build", mode: "execute", action: "build" }]],
  [
    "README.md#2",
    [
      {
        command: "remote-skills verify https://skills.example.com",
        mode: "static",
        reason: "external-origin",
      },
    ],
  ],
  [
    "README.md#3",
    [
      {
        command:
          "SKILLS_AUTH='Bearer …' remote-skills verify https://skills.example.com --header-env Authorization=SKILLS_AUTH",
        mode: "static",
        reason: "external-origin",
      },
    ],
  ],
  [
    "README.md#4",
    [
      {
        command: "pnpm add @remote-skills/client",
        mode: "static",
        reason: "registry-install",
      },
    ],
  ],
  [
    "README.md#5",
    [
      {
        command: "uv add remote-skills",
        mode: "static",
        reason: "registry-install",
      },
    ],
  ],
  [
    "apps/docs/README.md#0",
    [
      {
        command: "pnpm --filter @remote-skills/docs dev",
        mode: "static",
        reason: "long-running-server",
      },
      {
        command: "pnpm --filter @remote-skills/docs check",
        mode: "static",
        reason: "recursive-docs-gate",
      },
    ],
  ],
  ...packageManagerContracts("apps/docs/content/docs/cli.mdx", 0, [
    { command: "pnpm exec remote-skills validate", mode: "execute", action: "validate" },
    {
      command: "pnpm exec remote-skills validate --strict",
      mode: "execute",
      action: "validate-strict",
    },
  ]),
  ...packageManagerContracts("apps/docs/content/docs/cli.mdx", 3, [
    {
      command: "pnpm exec remote-skills build --format tar.gz --out-dir dist",
      mode: "execute",
      action: "build-configured",
    },
  ]),
  ...packageManagerContracts("apps/docs/content/docs/cli.mdx", 6, [
    {
      command: "pnpm exec remote-skills dev",
      mode: "static",
      reason: "long-running-server",
    },
  ]),
  ...packageManagerContracts("apps/docs/content/docs/cli.mdx", 9, [
    {
      command:
        "pnpm exec remote-skills verify https://skills.example.com --timeout-ms 30000 --retries 2",
      mode: "static",
      reason: "external-origin",
    },
  ]),
  ...packageManagerContracts("apps/docs/content/docs/hosting/archive-to-origin.mdx", 0, [
    { command: "pnpm exec remote-skills build", mode: "execute", action: "build" },
  ]),
  ...packageManagerContracts("apps/docs/content/docs/hosting/archive-to-origin.mdx", 3, [
    {
      command: "pnpm exec remote-skills verify https://skills.example.com",
      mode: "static",
      reason: "external-origin",
    },
  ]),
  ...packageManagerContracts("apps/docs/content/docs/hosting/archive-to-origin.mdx", 6, [
    {
      command:
        "SKILLS_AUTH='Bearer …' pnpm exec remote-skills verify https://skills.example.com --header-env Authorization=SKILLS_AUTH --scope engineering",
      mode: "static",
      reason: "external-origin",
    },
  ]),
  ...packageManagerContracts("apps/docs/content/docs/publisher.mdx", 0, [
    { command: "pnpm exec remote-skills validate", mode: "execute", action: "validate" },
  ]),
  ...packageManagerContracts("apps/docs/content/docs/quickstart.mdx", 0, [
    { command: "pnpm add -D @remote-skills/cli", mode: "static", reason: "registry-install" },
  ]),
  ...packageManagerContracts("apps/docs/content/docs/quickstart.mdx", 3, [
    { command: "pnpm exec remote-skills dev", mode: "static", reason: "long-running-server" },
  ]),
  ...packageManagerContracts("apps/docs/content/docs/quickstart.mdx", 6, [
    { command: "pnpm add @remote-skills/client", mode: "static", reason: "registry-install" },
  ]),
  ...packageManagerContracts("apps/docs/content/docs/vercel-ai-sdk.mdx", 0, [
    {
      command: "pnpm add @remote-skills/ai-sdk @remote-skills/client ai",
      mode: "static",
      reason: "registry-install",
    },
  ]),
  [
    "apps/docs/content/docs/quickstart.mdx#9",
    [
      {
        command: "python -m pip install remote-skills",
        mode: "static",
        reason: "registry-install",
      },
    ],
  ],
  [
    "apps/docs/content/docs/quickstart.mdx#10",
    [
      {
        command: "uv add remote-skills",
        mode: "static",
        reason: "registry-install",
      },
    ],
  ],
  ...packageManagerContracts("apps/docs/content/docs/hosting/git-pages.mdx", 0, [
    { command: "pnpm exec remote-skills build", mode: "execute", action: "build" },
  ]),
  ...packageManagerContracts("apps/docs/content/docs/hosting/git-pages.mdx", 3, [
    {
      command: "pnpm exec remote-skills verify https://skills.example.com",
      mode: "static",
      reason: "external-origin",
    },
  ]),
  ...packageManagerContracts("apps/docs/content/docs/versions.mdx", 0, [
    {
      command: "pnpm exec remote-skills build --out-dir release-1.0.0",
      mode: "static",
      reason: "requires-versioned-source",
    },
  ]),
  ...packageManagerContracts("apps/docs/content/docs/versions.mdx", 3, [
    {
      command: "pnpm exec remote-skills build --out-dir release-1.0.1 --prior-output release-1.0.0",
      mode: "static",
      reason: "requires-source-version-edit-and-prior-output",
    },
  ]),
  [
    "examples/publisher/README.md#0",
    [
      { command: "pnpm validate", mode: "execute", action: "validate" },
      { command: "pnpm build", mode: "execute", action: "build" },
    ],
  ],
  [
    "examples/consumers/python/README.md#0",
    [
      {
        command: "REMOTE_SKILLS_ORIGIN=http://127.0.0.1:8787 pnpm start",
        mode: "static",
        reason: "requires-running-origin",
      },
    ],
  ],
  [
    "examples/consumers/typescript/README.md#0",
    [
      {
        command: "pnpm --filter @remote-skills/client build",
        mode: "execute",
        action: "client-build",
      },
      {
        command: "REMOTE_SKILLS_ORIGIN=http://127.0.0.1:8787 pnpm start",
        mode: "static",
        reason: "requires-running-origin",
      },
    ],
  ],
]);

async function walk(directory: string, select: (path: string) => boolean): Promise<string[]> {
  const selected: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) selected.push(...(await walk(path, select)));
    else if (select(path)) selected.push(path);
  }
  return selected;
}

export async function publicDocumentationFiles() {
  const readmes = await walk(
    repositoryRoot,
    (path) => basename(path) === "README.md" && !path.includes("/openspec/"),
  );
  const pages = await walk(docsRoot, (path) => path.endsWith(".mdx"));
  return [...readmes, ...pages].sort();
}

function extractSnippets(path: string, source: string): Snippet[] {
  const snippets: Snippet[] = [];
  const ordinals = new Map<SnippetLanguage, number>();
  const fence = /^```([^\n]*)\n([\s\S]*?)^```[ \t]*$/gmu;
  for (const match of source.matchAll(fence)) {
    const rawInfo = match[1];
    const code = match[2];
    if (rawInfo === undefined || code === undefined) {
      throw new Error(`${relative(repositoryRoot, path)} has an invalid code fence`);
    }
    const info = rawInfo.trim();
    const language = info.split(/\s+/u)[0];
    if (language === undefined || language === "") {
      throw new Error(`${relative(repositoryRoot, path)} has an unlabelled fence`);
    }
    if (!isSnippetLanguage(language)) {
      throw new Error(
        `${relative(repositoryRoot, path)} has unsupported fence language ${language}`,
      );
    }
    const ordinal = ordinals.get(language) ?? 0;
    ordinals.set(language, ordinal + 1);
    snippets.push({ code, info, language, ordinal, path });
  }
  const delimiters = source.match(/^```/gmu)?.length ?? 0;
  if (delimiters !== snippets.length * 2) {
    throw new Error(`${relative(repositoryRoot, path)} has an unmatched code fence`);
  }
  return snippets;
}

function checkedSpawn(
  command: string,
  arguments_: readonly string[],
  { input, cwd = repositoryRoot }: CheckedSpawnOptions = {},
) {
  const launch = command === "pnpm" ? createPnpmCommand(arguments_) : { command, args: arguments_ };
  const result = spawnSync(launch.command, launch.args, {
    cwd,
    encoding: "utf8",
    shell: false,
    ...(input === undefined ? {} : { input }),
    env: {
      ...process.env,
      NO_COLOR: "1",
      PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`,
    },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${arguments_.join(" ")} failed (${result.signal ?? result.status})\n${result.stdout}${result.stderr}`,
    );
  }
}

function normalizedBashCommands(code: string) {
  return code
    .replace(/\\\n[ \t]*/gu, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

function bashContractKey(snippet: Snippet) {
  const path = relative(repositoryRoot, snippet.path).replaceAll("\\", "/");
  return `${path}#${snippet.ordinal ?? 0}`;
}

export function verifyBashSnippet(snippet: Snippet) {
  checkedSpawn("bash", ["-n"], { input: snippet.code });
  const key = bashContractKey(snippet);
  const contract = bashContracts.get(key);
  if (!contract) throw new Error(`unsupported documented Bash command: ${key}`);
  const commands = normalizedBashCommands(snippet.code);
  const expected = contract.map((entry) => entry.command);
  if (
    commands.length !== expected.length ||
    commands.some((command, index) => command !== expected[index])
  ) {
    throw new Error(`unsupported documented Bash command: ${key}`);
  }
  return { contract, key };
}

async function executeBashContracts(snippets: readonly Snippet[]) {
  const actions: BashAction[] = [];
  let executedCommands = 0;
  let executedSnippets = 0;
  let staticCommands = 0;
  for (const snippet of snippets) {
    const { contract } = verifyBashSnippet(snippet);
    const executable = contract.filter((entry) => entry.mode === "execute");
    const staticOnly = contract.filter((entry) => entry.mode === "static");
    if (executable.length > 0) executedSnippets += 1;
    executedCommands += executable.length;
    staticCommands += staticOnly.length;
    for (const entry of executable) actions.push(entry.action);
    for (const entry of staticOnly) {
      if (!entry.reason) throw new Error("static Bash contract is missing its reason");
    }
  }

  const project = await mkdtemp(resolve(tmpdir(), "remote-skills-doc-bash-"));
  try {
    await cp(resolve(repositoryRoot, "examples/publisher/skills"), resolve(project, "skills"), {
      recursive: true,
    });
    await writeFile(
      resolve(project, "remote-skills.json"),
      await readFile(resolve(repositoryRoot, "examples/publisher/remote-skills.json")),
    );
    for (const action of actions) {
      if (action === "validate") await runRemoteSkills(["validate"], { cwd: project });
      else if (action === "validate-strict") {
        await runRemoteSkills(["validate", "--strict"], { cwd: project });
      } else if (action === "build") await runRemoteSkills(["build"], { cwd: project });
      else if (action === "build-configured") {
        await runRemoteSkills(["build", "--format", "tar.gz", "--out-dir", "dist"], {
          cwd: project,
        });
      } else if (action === "client-build") {
        checkedSpawn("pnpm", ["--filter", "@remote-skills/client", "build"]);
      } else {
        throw new Error(`unsupported Bash execution action: ${action}`);
      }
    }
  } finally {
    await rm(project, { force: true, recursive: true });
  }
  return {
    classifiedSnippets: snippets.length,
    executedCommands,
    executedSnippets,
    staticCommands,
  };
}

async function compileTypeScriptProject(snippets: readonly Snippet[], integration: boolean) {
  const project = await mkdtemp(resolve(tmpdir(), "remote-skills-doc-typescript-"));
  try {
    const packageScope = resolve(project, "node_modules/@remote-skills");
    await mkdir(packageScope, { recursive: true });
    await symlink(
      resolve(repositoryRoot, "packages/sdk-typescript"),
      resolve(packageScope, "client"),
      process.platform === "win32" ? "junction" : "dir",
    );
    if (integration) {
      await symlink(
        resolve(repositoryRoot, "integrations/ai-sdk"),
        resolve(packageScope, "ai-sdk"),
        process.platform === "win32" ? "junction" : "dir",
      );
      await symlink(
        resolve(repositoryRoot, "integrations/ai-sdk/node_modules/ai"),
        resolve(project, "node_modules/ai"),
        process.platform === "win32" ? "junction" : "dir",
      );
    }
    await writeFile(resolve(project, "package.json"), '{"type":"module"}\n');
    await writeFile(
      resolve(project, "tsconfig.json"),
      `${JSON.stringify(
        {
          compilerOptions: {
            module: "NodeNext",
            moduleResolution: "NodeNext",
            noEmit: true,
            strict: true,
            // Match the integration's upstream AI SDK declaration workaround only for
            // integration snippets. Their bodies still receive strict API checking.
            skipLibCheck: integration,
            target: "ES2022",
            typeRoots: [resolve(repositoryRoot, "node_modules/@types")],
            types: ["node"],
          },
          include: ["snippet-*.ts"],
        },
        null,
        2,
      )}\n`,
    );
    for (const [index, snippet] of snippets.entries()) {
      const importsClient = snippet.code.includes('from "@remote-skills/client"');
      const declaresClient = /\b(?:declare\s+)?const\s+client\b/u.test(snippet.code);
      const needsClient = /\bclient\./u.test(snippet.code) && !declaresClient;
      const needsToken =
        /\btoken\b/u.test(snippet.code) && !/\bconst\s+token\b/u.test(snippet.code);
      const prelude = [
        importsClient ? "" : 'import { createRemoteSkills } from "@remote-skills/client";',
        needsToken ? 'const token = "documentation-token";' : "",
        needsClient
          ? 'const client = createRemoteSkills({ origins: { acme: { url: "https://skills.example.com" } } });'
          : "",
      ]
        .filter(Boolean)
        .join("\n");
      await writeFile(resolve(project, `snippet-${index}.ts`), `${prelude}\n${snippet.code}`);
    }
    checkedSpawn(
      process.execPath,
      [resolve(repositoryRoot, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.json"],
      {
        cwd: project,
      },
    );
  } finally {
    await rm(project, { force: true, recursive: true });
  }
}

export async function verifyTypeScriptSnippets(snippets: readonly Snippet[]) {
  checkedSpawn("pnpm", ["--filter", "@remote-skills/client", "build"]);
  const ordinary: Snippet[] = [];
  const integration: Snippet[] = [];
  for (const snippet of snippets) {
    if (/\bfrom\s+["'](?:@remote-skills\/ai-sdk|ai)["']/u.test(snippet.code)) {
      integration.push(snippet);
    } else ordinary.push(snippet);
  }
  if (ordinary.length > 0) await compileTypeScriptProject(ordinary, false);
  if (integration.length > 0) {
    // pnpm filters alone can succeed without a matching workspace. Require the real
    // package manifest first so an unmerged prerequisite cannot silently skip coverage.
    const manifest: unknown = JSON.parse(
      await readFile(resolve(repositoryRoot, "integrations/ai-sdk/package.json"), "utf8"),
    );
    if (!isJsonObject(manifest) || manifest.name !== "@remote-skills/ai-sdk") {
      throw new Error("documentation requires the real @remote-skills/ai-sdk workspace");
    }
    checkedSpawn("pnpm", ["--filter", "@remote-skills/ai-sdk", "build"]);
    await compileTypeScriptProject(integration, true);
  }
}

function compilePython(snippet: Snippet) {
  const body = snippet.code
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
  const wrapped = `async def __remote_skills_docs_snippet__():\n${body}\n`;
  const python =
    process.env.REMOTE_SKILLS_PYTHON ??
    resolve(
      repositoryRoot,
      process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python",
    );
  checkedSpawn(python, ["-c", "import sys; compile(sys.stdin.read(), '<docs>', 'exec')"], {
    input: wrapped,
  });
}

function validateYaml(snippet: Snippet) {
  const document = parseDocument(snippet.code, { prettyErrors: false, strict: true });
  if (document.errors.length > 0) {
    throw new Error(
      `${relative(repositoryRoot, snippet.path)} YAML snippet failed parsing: ${document.errors.join("; ")}`,
    );
  }
}

async function validatePublisherInputs(snippets: readonly Snippet[]) {
  const configurationSnippets = snippets.filter(
    (snippet) => snippet.language === "json" && snippet.info.includes("remote-skills.json"),
  );
  configurationSnippets.push({
    code: await readFile(resolve(repositoryRoot, "examples/publisher/remote-skills.json"), "utf8"),
    info: "json remote-skills.json",
    language: "json",
    path: resolve(repositoryRoot, "examples/publisher/remote-skills.json"),
  });
  const skillSnippets = snippets.filter(
    (snippet) => snippet.language === "md" && snippet.info.includes("SKILL.md"),
  );
  for (const configuration of configurationSnippets) {
    for (const skill of skillSnippets) {
      const project = await mkdtemp(resolve(tmpdir(), "remote-skills-doc-config-"));
      try {
        const skillName = /^name: ([a-z0-9-]+)$/mu.exec(skill.code)?.[1];
        if (!skillName) throw new Error(`documented skill has no valid name: ${skill.path}`);
        const skillDirectory = resolve(project, "skills", skillName);
        await mkdir(skillDirectory, { recursive: true });
        await writeFile(resolve(project, "remote-skills.json"), configuration.code);
        await writeFile(resolve(skillDirectory, "SKILL.md"), skill.code);
        await runRemoteSkills(["validate"], { cwd: project });
      } finally {
        await rm(project, { force: true, recursive: true });
      }
    }
  }
}

export async function verifyDocumentationSnippets() {
  const files = await publicDocumentationFiles();
  const snippets: Snippet[] = [];
  for (const path of files) snippets.push(...extractSnippets(path, await readFile(path, "utf8")));
  if (snippets.length === 0) throw new Error("documentation snippet inventory is empty");

  for (const snippet of snippets) {
    if (snippet.language === "json") JSON.parse(snippet.code);
    else if (snippet.language === "python") compilePython(snippet);
    else if (snippet.language === "yaml") validateYaml(snippet);
  }
  const bash = await executeBashContracts(
    snippets.filter((snippet) => snippet.language === "bash"),
  );
  await verifyTypeScriptSnippets(snippets.filter((snippet) => snippet.language === "ts"));
  await validatePublisherInputs(snippets);

  const source = (await Promise.all(files.map((path) => readFile(path, "utf8")))).join("\n");
  for (const forbidden of [
    "packages/cli/src",
    "packages/sdk-typescript/src",
    "packages/sdk-python/src",
    "PYTHONPATH",
  ]) {
    if (source.includes(forbidden))
      throw new Error(`documentation uses private path: ${forbidden}`);
  }
  if (!source.includes('from "@remote-skills/client"')) {
    throw new Error("TypeScript snippets do not import the public package boundary");
  }
  if (!source.includes("from remote_skills import")) {
    throw new Error("Python snippets do not import the public package boundary");
  }
  await runRemoteSkills(["--version"]);
  const python =
    process.env.REMOTE_SKILLS_PYTHON ??
    resolve(
      repositoryRoot,
      process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python",
    );
  checkedSpawn(python, ["-c", "from remote_skills import Origin, RemoteSkills"]);

  const countLanguage = (language: SnippetLanguage) =>
    snippets.filter((snippet) => snippet.language === language).length;
  const languages = {
    bash: countLanguage("bash"),
    json: countLanguage("json"),
    md: countLanguage("md"),
    python: countLanguage("python"),
    text: countLanguage("text"),
    ts: countLanguage("ts"),
    yaml: countLanguage("yaml"),
  };
  const executable =
    snippets.filter(
      (snippet) => snippet.language !== "bash" && executableLanguages.has(snippet.language),
    ).length + bash.executedSnippets;
  return { bash, executable, files: files.length, languages, snippets: snippets.length };
}

export async function verifyExactHostedBuildBytes() {
  const project = await mkdtemp(resolve(tmpdir(), "remote-skills-doc-host-"));
  try {
    await cp(resolve(repositoryRoot, "examples/publisher/skills"), resolve(project, "skills"), {
      recursive: true,
    });
    await writeFile(
      resolve(project, "remote-skills.json"),
      await readFile(resolve(repositoryRoot, "examples/publisher/remote-skills.json")),
    );
    await runRemoteSkills(["build"], { cwd: project });
    const dist = resolve(project, "dist");
    const origin = await startStaticOrigin({ root: dist });
    try {
      const indexPath = resolve(dist, ".well-known/agent-skills/index.json");
      const indexBytes = await readFile(indexPath);
      const indexResponse = await fetch(`${origin.origin}/.well-known/agent-skills/index.json`);
      const hostedIndexBytes = Buffer.from(await indexResponse.arrayBuffer());
      if (!hostedIndexBytes.equals(indexBytes))
        throw new Error("host transformed built index bytes");
      if (indexResponse.headers.get("content-type") !== "application/json") {
        throw new Error("hosted index has the wrong media type");
      }
      const skills = parseHostedCatalog(indexBytes.toString("utf8"));
      for (const entry of skills) {
        const artifactPath = resolve(dirname(indexPath), entry.url);
        const builtBytes = await readFile(artifactPath);
        const response = await fetch(new URL(entry.url, indexResponse.url));
        const hostedBytes = Buffer.from(await response.arrayBuffer());
        if (!hostedBytes.equals(builtBytes)) {
          throw new Error(`host transformed built artifact bytes for ${entry.name}`);
        }
        const expectedDigest = `sha256:${createHash("sha256").update(hostedBytes).digest("hex")}`;
        if (expectedDigest !== entry.digest) {
          throw new Error(`hosted artifact digest differs for ${entry.name}`);
        }
        const expectedMediaType =
          entry.type === "skill-md"
            ? "text/markdown; charset=utf-8"
            : entry.url.endsWith(".zip")
              ? "application/zip"
              : "application/gzip";
        if (response.headers.get("content-type") !== expectedMediaType) {
          throw new Error(`hosted artifact has the wrong media type for ${entry.name}`);
        }
      }
      return { artifacts: skills.length, indexBytes: indexBytes.length };
    } finally {
      await origin.close();
    }
  } finally {
    await rm(project, { force: true, recursive: true });
  }
}

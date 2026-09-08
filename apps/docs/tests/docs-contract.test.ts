import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  publicDocumentationFiles,
  verifyBashSnippet,
  verifyDocumentationSnippets,
  verifyExactHostedBuildBytes,
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
  "index",
  "concepts",
  "publisher",
  "hosting",
  "cli",
  "typescript",
  "python",
  "cache-and-offline",
  "authentication-and-scopes",
  "versions",
  "trust-and-security",
  "configuration",
  "api-reference",
  "release",
];

const hostingNavigation = ["archive-to-origin", "git-pages", "local-or-remote"];
const navigation = rootNavigation.flatMap((slug) =>
  slug === "hosting" ? hostingNavigation.map((page) => `hosting/${page}`) : [slug],
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
    "Do not unpack, recompress, rename, or wrap archives",
    "digest covers the exact response bytes",
  ]) {
    assert.match(doc, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  }
});

test("Git hosting guidance covers CI, Pages, custom domains, and the project-subpath caveat", () => {
  const doc = readDoc("hosting/git-pages");
  assert.match(doc, /repository source\s*→\s*CI build\s*→\s*generated `dist\/`/i);
  assert.match(doc, /GitHub Pages/i);
  assert.match(doc, /GitLab Pages/i);
  assert.match(doc, /custom domain/i);
  assert.match(doc, /\/repository-name\//i);
  assert.match(doc, /origin-root/i);
});

test("local-or-remote guidance covers image-local decisions and container cache costs", () => {
  const doc = readDoc("hosting/local-or-remote");
  assert.match(doc, /copy or clone/i);
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
    "provider may prune",
    "fail closed",
  ]) {
    assert.match(docs, new RegExp(phrase, "i"));
  }
  assert.doesNotMatch(docs, /hosted Remote Skills service/i);
  assert.doesNotMatch(docs, /Remote Skills cloud/i);
  assert.doesNotMatch(docs, /publish(?:ed|es|ing)? (?:to )?(?:npm|PyPI)/i);
  assert.doesNotMatch(docs, /npm install @remote-skills\//i);
  assert.doesNotMatch(docs, /uv add remote-skills/i);
});

test("CLI, SDK, config, API, and release pages use the shipped public names", () => {
  assert.match(readDoc("cli"), /remote-skills (?:validate|build|dev|verify)/);
  assert.match(readDoc("typescript"), /createRemoteSkills/);
  assert.match(readDoc("typescript"), /session\.activate/);
  assert.match(readDoc("python"), /RemoteSkills/);
  assert.match(readDoc("python"), /Origin/);
  assert.match(readDoc("configuration"), /remote-skills\.json/);
  assert.match(readDoc("api-reference"), /version_unavailable/);
  assert.match(readDoc("release"), /0\.0\.1/);
  assert.match(readDoc("release"), /local artifacts/i);
});

test("every public documentation snippet has an executable contract gate", async () => {
  const report = await verifyDocumentationSnippets();
  assert.ok(report.files >= 20, `unexpected public documentation inventory: ${report.files}`);
  assert.ok(report.snippets >= 30, `unexpected snippet inventory: ${report.snippets}`);
  assert.ok(
    report.executable >= 20,
    `unexpected executable snippet inventory: ${report.executable}`,
  );
  for (const language of ["bash", "json", "md", "python", "ts", "yaml"] as const) {
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
    "default production cache is disk",
    "Memory-only",
    "complete artifact",
    "context-lazy",
    "does not grant access",
    "provider authorizes",
    "selection policy, not a retention guarantee",
    "provider may prune",
    "does not include a marketplace, managed hosting",
    "framework adapter",
  ]) {
    assert.match(source, new RegExp(phrase, "iu"));
  }
  assert.doesNotMatch(source, /npm install @remote-skills\//u);
  assert.doesNotMatch(source, /uv add remote-skills(?:\s|$)/u);
});

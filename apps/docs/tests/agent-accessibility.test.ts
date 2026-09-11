import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const appRoot = new URL("../", import.meta.url);
const docsRoot = new URL("content/docs/", appRoot);
const llmsPagesUrl = new URL("lib/llms-pages.json", appRoot);

const requiredSlugs = [
  "index",
  "quickstart",
  "publisher",
  "hosting/archive-to-origin",
  "hosting/git-pages",
  "cli",
  "consume",
  "integrations",
  "vercel-ai-sdk",
  "authentication-and-scopes",
  "versions",
  "cache-and-offline",
  "trust-and-security",
  "api-reference",
];

interface JsonObject {
  [key: string]: unknown;
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((item: unknown) => typeof item === "string")) {
    throw new Error(`${label} must be an array of strings`);
  }
  return value;
}

function parseJsonObject(source: string, label: string): JsonObject {
  const value: unknown = JSON.parse(source);
  if (!isJsonObject(value)) throw new Error(`${label} must be a JSON object`);
  return value;
}

function canonicalNavigation() {
  const root = parseJsonObject(readFileSync(new URL("meta.json", docsRoot), "utf8"), "navigation");
  const hosting = parseJsonObject(
    readFileSync(new URL("hosting/meta.json", docsRoot), "utf8"),
    "hosting navigation",
  );
  const hostingPages = stringArray(hosting.pages, "hosting navigation pages");
  const integrations = parseJsonObject(
    readFileSync(new URL("integrations/meta.json", docsRoot), "utf8"),
    "integrations navigation",
  );
  const integrationPages = stringArray(integrations.pages, "integrations navigation pages").map(
    (page) => {
      const link = /^\[[^\]]+\]\(\/docs\/([^)]+)\)$/u.exec(page);
      return link?.[1] ?? (page === "index" ? "integrations" : `integrations/${page}`);
    },
  );
  return stringArray(root.pages, "navigation pages")
    .filter((slug) => !slug.startsWith("---"))
    .flatMap((slug) =>
      slug === "hosting"
        ? hostingPages.map((page) => `hosting/${page}`)
        : slug === "integrations"
          ? integrationPages
          : [slug],
    );
}

test("llms index metadata selects every required page from canonical navigation", () => {
  assert.equal(existsSync(llmsPagesUrl), true, "lib/llms-pages.json must define the llms index");

  const rawSections: unknown = JSON.parse(readFileSync(llmsPagesUrl, "utf8"));
  if (!Array.isArray(rawSections)) throw new Error("llms index metadata must be an array");
  const sections: unknown[] = rawSections;
  const selected = sections.flatMap((section, index) => {
    if (!isJsonObject(section)) throw new Error(`llms section ${index} must be an object`);
    return stringArray(section.pages, `llms section ${index} pages`);
  });
  assert.deepEqual([...new Set(selected)], selected, "llms index pages must be unique");
  assert.deepEqual(
    requiredSlugs.filter((slug) => !selected.includes(slug)),
    [],
    "llms index must cover every task 8.4 topic",
  );

  const navigation = canonicalNavigation();
  assert.deepEqual(
    selected.filter((slug) => !navigation.includes(slug)),
    [],
    "llms index pages must come from canonical navigation",
  );
});

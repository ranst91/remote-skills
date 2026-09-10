import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, normalize, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const appRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const docsRoot = join(appRoot, "content/docs");

function markdownFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? markdownFiles(path) : entry.name.endsWith(".mdx") ? [path] : [];
  });
}

function resolveInternalTarget(file: string, target: string): string | undefined {
  const withoutFragment = target.split("#", 1)[0];
  if (!withoutFragment) return undefined;
  if (withoutFragment.startsWith("/docs/")) {
    const slug = withoutFragment.slice("/docs/".length).replace(/\/$/u, "") || "index";
    return join(docsRoot, `${slug}.mdx`);
  }
  if (withoutFragment === "/docs") return join(docsRoot, "index.mdx");
  if (withoutFragment.startsWith("/")) return undefined;
  return normalize(resolve(dirname(file), withoutFragment));
}

test("every internal documentation link resolves inside the docs application", () => {
  const failures: string[] = [];
  for (const file of markdownFiles(docsRoot)) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/\[[^\]]+\]\(([^)]+)\)/gu)) {
      const target = match[1];
      if (target === undefined) throw new Error("Markdown link capture is missing");
      if (/^(?:https?:|mailto:)/u.test(target)) continue;
      const resolved = resolveInternalTarget(file, target);
      if (resolved && !readFileExists(resolved)) {
        failures.push(`${relative(appRoot, file)} -> ${target}`);
      }
    }
  }
  assert.deepEqual(failures, []);
});

function readFileExists(path: string) {
  try {
    readFileSync(path);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

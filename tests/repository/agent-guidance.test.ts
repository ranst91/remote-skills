import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

test("AGENTS.md gives coding agents one concise, tool-neutral path to canonical project guidance", () => {
  const guidance = readFileSync("AGENTS.md", "utf8");
  const words = guidance.match(/\S+/gu) ?? [];

  assert.ok(words.length <= 500, `AGENTS.md contains ${words.length} words; expected at most 500`);
  assert.doesNotMatch(guidance, /\b(?:Claude|Codex|Cursor)\b/u);

  for (const path of [
    "README.md",
    "openspec/changes/build-remote-skills-v0/design.md",
    "openspec/changes/build-remote-skills-v0/tasks.md",
    "tests/protocol/README.md",
    "apps/docs",
  ]) {
    assert.equal(existsSync(path), true, `canonical guidance target is missing: ${path}`);
    assert.ok(guidance.includes(path), `AGENTS.md must point to ${path}`);
  }

  for (const command of [
    "pnpm install --frozen-lockfile",
    "uv sync --locked --all-packages",
    "pnpm test:repository",
    "pnpm test:protocol",
    "pnpm typecheck",
    "pnpm check",
  ]) {
    assert.ok(guidance.includes(command), `AGENTS.md must name the supported command: ${command}`);
  }
});

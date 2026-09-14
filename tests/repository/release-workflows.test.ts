import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { releaseScopes } from "../../scripts/release/release-scopes.ts";

const prepare = readFileSync(".github/workflows/prepare-release.yml", "utf8");
const publish = readFileSync(".github/workflows/publish-release.yml", "utf8");
const ci = readFileSync(".github/workflows/ci.yml", "utf8");

test("every registered release scope is selectable exactly once", () => {
  const choices = prepare.match(/options: \[(core[^\]]*)\]/u)?.[1]?.split(", ");
  assert.ok(choices);
  assert.deepEqual([...choices].sort(), Object.keys(releaseScopes).sort());
});

for (const [name, workflow] of [
  ["release previews", prepare],
  ["artifact-only publication jobs", publish.slice(publish.indexOf("\n  publish:"))],
] as const) {
  test(`${name} do not save a uv dependency cache they never populate`, () => {
    const uvSetup = workflow.match(/- uses: astral-sh\/setup-uv@[^\n]+\n(?: {8,}[^\n]*\n)+/u)?.[0];
    assert.ok(uvSetup, `${name} must configure setup-uv`);
    assert.match(uvSetup, /^ {10}enable-cache: false$/mu);
  });
}

test("release preparation is explicit, scoped and dispatches CI for its generated PR", () => {
  assert.match(prepare, /options: \[initial, patch, minor, major\]/u);
  assert.match(prepare, /options: \[alpha, stable\]/u);
  assert.match(prepare, /default: true/u);
  assert.doesNotMatch(prepare, /\n {2}(?:push|pull_request):/u);
  assert.match(prepare, /core, integration-ai-sdk/u);
  assert.match(prepare, /gh workflow run ci\.yml --ref release\/next/u);
  assert.doesNotMatch(prepare, /id-token:|npm publish|uv publish/u);
  assert.match(ci, /workflow_dispatch:/u);
  assert.match(ci, /workflow_call:/u);
});

test("PR packaging verifies the same retained artifacts that publication downloads", () => {
  assert.match(ci, /pnpm --dir \.\.\/release-tooling publication:readiness/u);
  assert.match(ci, /actions\/upload-artifact@/u);
  assert.doesNotMatch(publish, /\n {2}build:|pack:local|uv build|release:smoke/u);
  assert.match(publish, /needs\.validate\.outputs\.artifact_name/u);
  assert.match(ci, /path: release-tooling/u);
});

test("only intentional main release changes can reach protected publication", () => {
  assert.match(publish, /paths: \[release-state\.json\]/u);
  assert.match(publish, /release\.ts" validate/u);
  assert.match(publish, /git merge-base --is-ancestor/u);
  assert.match(publish, /uses: \.\/\.github\/workflows\/ci\.yml/u);
  assert.doesNotMatch(publish, /macos-latest|windows-latest/u);
  const boundary = publish.indexOf("\n  publish:");
  assert.ok(boundary > 0);
  assert.doesNotMatch(publish.slice(0, boundary), /id-token: write|npm publish|uv publish/u);
  const publication = publish.slice(boundary);
  assert.match(publication, /environment: release/u);
  assert.match(publication, /id-token: write/u);
  assert.match(publication, /inputs\.dry_run != true/u);
  assert.match(publication, /publish-artifacts\.ts npm release-dist/u);
  assert.match(publication, /steps\.plan\.outputs\.has_python/u);
  assert.match(publication, /needs\.validate\.outputs\.artifact_name/u);
  assert.ok(
    publication.indexOf("publish-artifacts.ts verify") <
      publication.indexOf("publish-artifacts.ts release"),
  );
});

test("release workflows pin actions and contain no registry token references", () => {
  for (const workflow of [prepare, publish]) {
    for (const line of workflow
      .split("\n")
      .filter((line) => /uses:/u.test(line) && !line.includes("uses: ./")))
      assert.match(line, /@[0-9a-f]{40}/u);
    assert.doesNotMatch(
      workflow,
      /NPM_TOKEN|NODE_AUTH_TOKEN|PYPI_API_TOKEN|UV_PUBLISH_TOKEN|TWINE_PASSWORD/u,
    );
  }
});

test("candidate packaging installs dependencies beside the current tooling tests", () => {
  const packageJob = ci.slice(ci.indexOf("\n  package:"), ci.indexOf("\n  windows:"));
  const install = packageJob.indexOf("pnpm --dir ../release-tooling install --frozen-lockfile");
  const browser = packageJob.indexOf("pnpm --dir ../release-tooling exec playwright install");
  const verify = packageJob.indexOf("pnpm --dir ../release-tooling publication:readiness");
  assert.ok(install > 0 && browser > install && verify > browser);
  assert.doesNotMatch(packageJob, /id-token: write|secrets\./u);
});

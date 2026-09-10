import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const prepare = readFileSync(".github/workflows/prepare-release.yml", "utf8");
const publish = readFileSync(".github/workflows/publish-release.yml", "utf8");
const ci = readFileSync(".github/workflows/ci.yml", "utf8");

test("release preparation is explicit, version-coordinated and dispatches CI for its generated PR", () => {
  assert.match(prepare, /options: \[initial, patch, minor, major\]/u);
  assert.match(prepare, /options: \[alpha, stable\]/u);
  assert.match(prepare, /default: true/u);
  assert.doesNotMatch(prepare, /\n {2}(?:push|pull_request):/u);
  assert.match(prepare, /integrations\/ai-sdk\/package\.json/u);
  assert.match(prepare, /gh workflow run ci\.yml --ref release\/next/u);
  assert.doesNotMatch(prepare, /id-token:|npm publish|uv publish/u);
  assert.match(ci, /workflow_dispatch:/u);
  assert.match(ci, /workflow_call:/u);
  assert.ok(ci.indexOf("pnpm package:cache") < ci.indexOf("run: pnpm package:check"));
  assert.ok(publish.indexOf("pnpm package:cache") < publish.indexOf("pnpm release:smoke"));
  assert.match(publish, /uv build packages\/sdk-python --no-create-gitignore --out-dir/u);
});

test("only intentional main release changes can reach protected publication", () => {
  assert.match(publish, /paths: \[release-state\.json\]/u);
  assert.match(publish, /release\.ts validate/u);
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
  assert.match(publication, /for name in client cli ai-sdk/u);
  assert.match(publication, /release-dist-\$\{\{ needs\.context\.outputs\.sha \}\}/u);
  assert.ok(publication.indexOf("Verify registries") < publication.indexOf("gh release create"));
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

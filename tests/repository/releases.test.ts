import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type TestContext, test } from "node:test";
import {
  nextReleaseVersion,
  prepareRelease,
  readReleaseState,
  releasePackages,
  validateReleaseCommit,
} from "../../scripts/release/release-lib.ts";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "release-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const entry of releasePackages) {
    mkdirSync(dirname(join(root, entry.manifest)), { recursive: true });
    writeFileSync(
      join(root, entry.manifest),
      JSON.stringify({
        name: entry.name,
        version: "0.0.1",
        ...(entry.id === "ai_sdk"
          ? { peerDependencies: { "@remote-skills/client": "^0.0.1", ai: "^7.0.0" } }
          : {}),
      }),
    );
  }
  mkdirSync(join(root, "packages/sdk-python"), { recursive: true });
  writeFileSync(
    join(root, "packages/sdk-python/pyproject.toml"),
    '[project]\nname = "remote-skills"\nversion = "0.0.1"\n',
  );
  writeFileSync(
    join(root, "CHANGELOG.md"),
    "# Changelog\n\n## [Unreleased]\n\n- Add the integration.\n",
  );
  return root;
}

test("release channels advance stable versions and promote alpha versions", () => {
  assert.equal(nextReleaseVersion("0.0.1", "patch", "alpha"), "0.0.2-alpha.0");
  assert.equal(nextReleaseVersion("1.2.3", "minor", "stable"), "1.3.0");
  assert.equal(nextReleaseVersion("1.2.3", "major", "stable"), "2.0.0");
  assert.equal(nextReleaseVersion("0.0.2-alpha.0", "patch", "alpha"), "0.0.2-alpha.1");
  assert.equal(nextReleaseVersion("0.0.2-alpha.1", "major", "stable"), "0.0.2");
});

test("preparing an alpha aligns all public packages and the integration client peer", (t) => {
  const root = fixture(t);
  const result = prepareRelease(root, "patch", "alpha", false);
  assert.equal(result.npmVersion, "0.0.2-alpha.0");
  const state = readReleaseState(root);
  assert.equal(state.pythonVersion, "0.0.2a0");
  const integration: unknown = JSON.parse(
    readFileSync(join(root, "integrations/ai-sdk/package.json"), "utf8"),
  );
  assert.ok(
    typeof integration === "object" && integration !== null && "peerDependencies" in integration,
  );
  assert.deepEqual(integration.peerDependencies, {
    "@remote-skills/client": "^0.0.2-alpha.0",
    ai: "^7.0.0",
  });
});

test("release previews do not change files and drift fails before writing", (t) => {
  const root = fixture(t);
  const before = readFileSync(join(root, "CHANGELOG.md"), "utf8");
  prepareRelease(root, "patch", "stable", true);
  assert.equal(readFileSync(join(root, "CHANGELOG.md"), "utf8"), before);
  writeFileSync(join(root, "packages/sdk-python/pyproject.toml"), '[project]\nversion = "0.0.2"\n');
  assert.throws(() => prepareRelease(root, "patch", "stable", false), /version drift/);
  assert.equal(readFileSync(join(root, "CHANGELOG.md"), "utf8"), before);
});

test("initial stable preserves 0.0.1 and cannot be prepared twice", (t) => {
  const root = fixture(t);
  assert.equal(prepareRelease(root, "initial", "stable", false).npmVersion, "0.0.1");
  assert.throws(() => prepareRelease(root, "initial", "stable", false), /initial release/);
});

test("initial alpha begins at 0.0.1 and promotes to the first stable version", (t) => {
  const root = fixture(t);
  assert.equal(prepareRelease(root, "initial", "alpha", false).npmVersion, "0.0.1-alpha.0");
  writeFileSync(
    join(root, "CHANGELOG.md"),
    "# Changelog\n\n## [Unreleased]\n\n- Refine the integration.\n",
  );
  assert.equal(prepareRelease(root, "patch", "stable", false).npmVersion, "0.0.1");
});

for (const bump of ["initial", "patch"] as const) {
  test(`publishing a ${bump} release requires explicit intent and rejects repeated commits`, (t) => {
    const root = fixture(t);
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    git("init", "--quiet");
    git("config", "user.name", "Release Test");
    git("config", "user.email", "release@example.invalid");
    git("add", ".");
    git("commit", "--quiet", "-m", "feat: foundation");
    assert.throws(
      () => validateReleaseCommit(root, git("rev-parse", "HEAD")),
      /intentional release/,
    );
    const version = prepareRelease(root, bump, "stable", false).npmVersion;
    git("add", ".");
    git("commit", "--quiet", "-m", `chore: release v${version}`);
    assert.equal(validateReleaseCommit(root, git("rev-parse", "HEAD")).npmVersion, version);
    git("commit", "--quiet", "--allow-empty", "-m", `chore: release v${version}`);
    assert.throws(
      () => validateReleaseCommit(root, git("rev-parse", "HEAD")),
      /version did not change|initial release was already prepared/,
    );
  });
}

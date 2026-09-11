import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type TestContext, test } from "node:test";
import {
  clientPeerCompatible,
  nextReleaseVersion,
  manifestObject,
  prepareRelease,
  readReleaseState,
  releasePackages,
  toPythonVersion,
  validateReleaseCommit,
} from "../../scripts/release/release-lib.ts";

function fixture(t: TestContext, version = "0.0.1-alpha.0", peer = `^${version}`) {
  const root = mkdtempSync(join(tmpdir(), "release-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const entry of releasePackages) {
    mkdirSync(dirname(join(root, entry.manifest)), { recursive: true });
    writeFileSync(
      join(root, entry.manifest),
      JSON.stringify({
        name: entry.name,
        version,
        ...(entry.id === "ai_sdk"
          ? { peerDependencies: { "@remote-skills/client": peer, ai: "^7.0.0" } }
          : {}),
      }),
    );
  }
  mkdirSync(join(root, "packages/sdk-python"), { recursive: true });
  writeFileSync(
    join(root, "packages/sdk-python/pyproject.toml"),
    `[project]\nname = "remote-skills"\nversion = "${toPythonVersion(version)}"\n`,
  );
  writeFileSync(
    join(root, "CHANGELOG.md"),
    "# Changelog\n\n## [Unreleased]\n\n- Improve skills.\n",
  );
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "--quiet");
  git("config", "user.name", "Release Test");
  git("config", "user.email", "release@example.invalid");
  git("add", ".");
  git("commit", "--quiet", "-m", "feat: foundation");
  return { root, git, base: git("rev-parse", "HEAD") };
}

test("release channels advance stable versions and promote alpha to its intended stable", () => {
  assert.equal(nextReleaseVersion("0.0.1", "patch", "alpha"), "0.0.2-alpha.0");
  assert.equal(nextReleaseVersion("1.2.3", "minor", "stable"), "1.3.0");
  assert.equal(nextReleaseVersion("1.2.3", "major", "stable"), "2.0.0");
  assert.equal(nextReleaseVersion("0.0.1-alpha.0", "patch", "alpha"), "0.0.1-alpha.1");
  assert.equal(nextReleaseVersion("0.0.1-alpha.0", "patch", "stable"), "0.0.1");
});

test("core promotion preserves 0.0.1 and leaves integration bytes untouched", (t) => {
  const { root, base } = fixture(t);
  const before = readFileSync(join(root, "integrations/ai-sdk/package.json"), "utf8");
  prepareRelease(root, "patch", "stable", false, "core", base);
  const state = readReleaseState(root);
  assert.equal(state.pythonVersion, "0.0.1");
  assert.deepEqual(
    state.selectedPackages.map((entry) => entry.id),
    ["cli", "client", "python"],
  );
  assert.equal(state.releases[0]?.gitTag, "core/v0.0.1");
  assert.equal(readFileSync(join(root, "integrations/ai-sdk/package.json"), "utf8"), before);
});

test("integration alpha advances independently and repeated requests do not compound", (t) => {
  const { root, base } = fixture(t);
  prepareRelease(root, "patch", "alpha", false, "integration-ai-sdk", base);
  const first = readFileSync(join(root, "release-state.json"), "utf8");
  prepareRelease(root, "patch", "alpha", false, "integration-ai-sdk", base);
  assert.equal(readFileSync(join(root, "release-state.json"), "utf8"), first);
  const state = readReleaseState(root);
  assert.equal(state.npmVersion, "0.0.1-alpha.0");
  assert.equal(state.manifests[2]?.version, "0.0.1-alpha.1");
  assert.deepEqual(
    state.selectedPackages.map((entry) => entry.id),
    ["ai_sdk"],
  );
});

test("accumulating a second scope and replacing intent preserves human notes and manifest edits", (t) => {
  const { root, base } = fixture(t, "1.2.3", "^1.0.0");
  prepareRelease(root, "patch", "stable", false, "core", base);
  const path = join(root, "CHANGELOG.md");
  writeFileSync(
    path,
    readFileSync(path, "utf8")
      .replace("## [core/v1.2.4]", "## [core/v1.2.4]")
      .concat("\nHuman footer.\n"),
  );
  const manifestPath = join(root, "packages/cli/package.json");
  const manifest = manifestObject(readFileSync(manifestPath, "utf8"));
  Reflect.set(manifest, "description", "Human description");
  writeFileSync(manifestPath, JSON.stringify(manifest));
  prepareRelease(root, "minor", "stable", false, "integration-ai-sdk", base);
  prepareRelease(root, "minor", "stable", false, "core", base);
  const state = readReleaseState(root);
  assert.equal(state.npmVersion, "1.3.0");
  assert.equal(state.manifests[2]?.version, "1.3.0");
  assert.equal(state.intent?.scopes.core?.previousVersion, "1.2.3");
  assert.match(readFileSync(path, "utf8"), /Human footer/u);
  assert.match(readFileSync(path, "utf8"), /core\/v1\.3\.0/u);
  assert.doesNotMatch(readFileSync(path, "utf8"), /core\/v1\.2\.4/u);
  assert.match(readFileSync(manifestPath, "utf8"), /Human description/u);
});

test("previews and incompatible core bumps never mutate files", (t) => {
  const { root, base } = fixture(t, "0.0.1");
  const before = readFileSync(join(root, "packages/cli/package.json"), "utf8");
  prepareRelease(root, "patch", "stable", true, "integration-ai-sdk", base);
  assert.equal(readFileSync(join(root, "packages/cli/package.json"), "utf8"), before);
  assert.throws(
    () => prepareRelease(root, "patch", "stable", false, "core", base),
    /incompatible/u,
  );
  assert.equal(readFileSync(join(root, "packages/cli/package.json"), "utf8"), before);
});

test("version drift against main fails before preparing", (t) => {
  const { root, base } = fixture(t);
  for (const entry of releasePackages.filter((entry) => entry.scope === "core")) {
    const path = join(root, entry.manifest);
    writeFileSync(path, readFileSync(path, "utf8").replace("0.0.1-alpha.0", "0.0.1-alpha.5"));
  }
  const path = join(root, "packages/sdk-python/pyproject.toml");
  writeFileSync(path, readFileSync(path, "utf8").replace("0.0.1a0", "0.0.1a5"));
  assert.throws(() => prepareRelease(root, "patch", "stable", false, "core", base), /baseline/u);
});

test("initial release is available only from 0.0.1", (t) => {
  const { root, base } = fixture(t, "0.0.1");
  assert.equal(prepareRelease(root, "initial", "stable", false, "core", base).version, "0.0.1");
  const alpha = fixture(t);
  assert.throws(
    () => prepareRelease(alpha.root, "initial", "stable", false, "core", alpha.base),
    /initial release/u,
  );
});

test("scoped merge validation rejects replay and a new baseline starts a fresh cycle", (t) => {
  const { root, git, base } = fixture(t, "1.2.3", "^1.0.0");
  assert.throws(() => validateReleaseCommit(root, base), /intentional release/u);
  prepareRelease(root, "patch", "stable", false, "integration-ai-sdk", base);
  git("add", ".");
  git("commit", "--quiet", "-m", "chore: release packages");
  const merged = git("rev-parse", "HEAD");
  assert.equal(validateReleaseCommit(root, merged).selectedPackages[0]?.version, "1.2.4");
  git("commit", "--quiet", "--allow-empty", "-m", "chore: release packages");
  assert.throws(() => validateReleaseCommit(root, git("rev-parse", "HEAD")), /already merged/u);
  prepareRelease(root, "patch", "stable", false, "core", git("rev-parse", "HEAD"));
  assert.deepEqual(readReleaseState(root).selectedScopes, ["core"]);
});

test("caret client compatibility respects zero versions and prerelease opt-in", () => {
  assert.equal(clientPeerCompatible("^0.0.1-alpha.0", "0.0.1"), true);
  assert.equal(clientPeerCompatible("^0.0.1-alpha.0", "0.0.2"), false);
  assert.equal(clientPeerCompatible("^1.2.0", "1.3.0"), true);
  assert.equal(clientPeerCompatible("^1.2.0", "1.3.0-alpha.0"), false);
  assert.equal(clientPeerCompatible("^1.2.0", "2.0.0"), false);
});

test("the original coordinated alpha remains retryable and rejects replay or package drift", (t) => {
  const { root, git } = fixture(t, "0.0.1");
  for (const entry of releasePackages) {
    const path = join(root, entry.manifest);
    writeFileSync(path, readFileSync(path, "utf8").replaceAll("0.0.1", "0.0.1-alpha.0"));
  }
  const python = join(root, "packages/sdk-python/pyproject.toml");
  writeFileSync(python, readFileSync(python, "utf8").replace("0.0.1", "0.0.1a0"));
  writeFileSync(
    join(root, "release-state.json"),
    JSON.stringify({ version: "0.0.1-alpha.0", previousVersion: "0.0.1", initial: true }),
  );
  writeFileSync(
    join(root, "CHANGELOG.md"),
    "# Changelog\n\n## [0.0.1-alpha.0]\n\n- First public alpha.\n",
  );
  git("add", ".");
  git("commit", "--quiet", "-m", "chore: release v0.0.1-alpha.0 (#8)");
  const alpha = git("rev-parse", "HEAD");
  const state = validateReleaseCommit(root, alpha);
  assert.equal(state.npmVersion, "0.0.1-alpha.0");
  assert.equal(state.pythonVersion, "0.0.1a0");
  assert.deepEqual(
    state.selectedPackages.map((entry) => entry.id),
    ["cli", "client", "ai_sdk", "python"],
  );
  assert.ok(state.releases.every((entry) => entry.gitTag === "v0.0.1-alpha.0"));
  git("commit", "--quiet", "--allow-empty", "-m", "chore: release v0.0.1-alpha.0");
  assert.throws(
    () => validateReleaseCommit(root, git("rev-parse", "HEAD")),
    /initial release was already prepared/u,
  );
  git("checkout", "--detach", alpha);
  const integration = join(root, "integrations/ai-sdk/package.json");
  writeFileSync(
    integration,
    readFileSync(integration, "utf8").replace(
      '"version":"0.0.1-alpha.0"',
      '"version":"0.0.1-alpha.1"',
    ),
  );
  git("add", ".");
  git("commit", "--amend", "--no-edit", "--quiet");
  assert.throws(
    () => validateReleaseCommit(root, git("rev-parse", "HEAD")),
    /package version drift/u,
  );
});

test("empty Unreleased after the alpha produces factual scoped notes and preserves history", (t) => {
  const { root, base } = fixture(t);
  const path = join(root, "CHANGELOG.md");
  const history = "## [0.0.1-alpha.0] - 2026-09-10\n\n- Existing approved alpha notes.\n";
  writeFileSync(path, `# Changelog\n\n## [Unreleased]\n\n${history}`);
  prepareRelease(root, "patch", "stable", false, "core", base);
  const source = readFileSync(path, "utf8");
  assert.match(source, /## \[core\/v0\.0\.1\]/u);
  assert.match(source, /Release @remote-skills\/cli, @remote-skills\/client, remote-skills/u);
  assert.ok(source.endsWith(history));
  prepareRelease(root, "patch", "stable", false, "integration-ai-sdk", base);
  assert.match(readFileSync(path, "utf8"), /Release @remote-skills\/ai-sdk/u);
  assert.ok(readFileSync(path, "utf8").endsWith(history));
});

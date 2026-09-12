import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type TestContext, test } from "node:test";
import {
  buildPublicationPlan,
  pythonArtifactPaths,
} from "../../scripts/release/publication-plan.ts";
import {
  clientPeerCompatible,
  manifestObject,
  nextReleaseVersion,
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
        ...(entry.scope !== "core" ? { peerDependencies: { "@remote-skills/client": peer } } : {}),
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

test("Mastra preview and preparation select only its package and preserve unrelated bytes", (t) => {
  const { root, base, git } = fixture(t);
  const untouched = [
    ...releasePackages.filter((entry) => entry.id !== "mastra").map((entry) => entry.manifest),
    "packages/sdk-python/pyproject.toml",
  ];
  const before = untouched.map((path) => readFileSync(join(root, path), "utf8"));
  const preview = prepareRelease(root, "patch", "alpha", true, "integration-mastra", base);
  assert.equal(git("status", "--porcelain"), "");
  assert.deepEqual(preview.changedFiles, [
    "integrations/mastra/package.json",
    "CHANGELOG.md",
    "release-state.json",
  ]);
  assert.equal(preview.version, "0.0.1-alpha.1");
  prepareRelease(root, "patch", "alpha", false, "integration-mastra", base);
  const first = git("diff");
  const firstIntent = readFileSync(join(root, "release-state.json"), "utf8");
  prepareRelease(root, "patch", "alpha", false, "integration-mastra", base);
  assert.equal(git("diff"), first);
  assert.equal(readFileSync(join(root, "release-state.json"), "utf8"), firstIntent);
  assert.deepEqual(
    untouched.map((path) => readFileSync(join(root, path), "utf8")),
    before,
  );
  const state = readReleaseState(root);
  assert.deepEqual(state.selectedScopes, ["integration-mastra"]);
  assert.deepEqual(state.selectedPackages, [
    {
      id: "mastra",
      name: "@remote-skills/mastra",
      version: "0.0.1-alpha.1",
      registry: "npm",
      scope: "integration-mastra",
    },
  ]);
  assert.equal(state.releases[0]?.gitTag, "integration-mastra/v0.0.1-alpha.1");
  git("add", ".");
  git("commit", "--quiet", "-m", "chore: release packages");
  assert.deepEqual(
    validateReleaseCommit(root, git("rev-parse", "HEAD")).selectedPackages,
    state.selectedPackages,
  );
});

test("Mastra accumulates with core and AI SDK against one unchanged release baseline", (t) => {
  const { root, base } = fixture(t, "1.2.3", "^1.0.0");
  prepareRelease(root, "minor", "stable", false, "integration-mastra", base);
  prepareRelease(root, "patch", "stable", false, "core", base);
  prepareRelease(root, "patch", "stable", false, "integration-ai-sdk", base);
  prepareRelease(root, "patch", "stable", false, "integration-mastra", base);
  const state = readReleaseState(root);
  assert.equal(state.intent?.baseSha, base);
  assert.deepEqual(
    new Set(state.selectedScopes),
    new Set(["core", "integration-ai-sdk", "integration-mastra"]),
  );
  assert.ok(
    Object.values(state.intent?.scopes ?? {}).every(
      (entry) => entry.previousVersion === "1.2.3" && entry.version === "1.2.4",
    ),
  );
  assert.deepEqual(
    new Set(state.selectedPackages.map((entry) => entry.id)),
    new Set(["cli", "client", "ai_sdk", "mastra", "python"]),
  );
  assert.doesNotMatch(
    readFileSync(join(root, "CHANGELOG.md"), "utf8"),
    /integration-mastra\/v1\.3\.0/u,
  );
});

test("issued legacy alpha remains exact when later integrations were absent from its commit", (t) => {
  const { root, git } = fixture(t, "0.0.1");
  for (const entry of releasePackages.filter(
    (entry) => !["cli", "client", "ai_sdk"].includes(entry.id),
  )) {
    git("rm", entry.manifest);
  }
  git("commit", "--quiet", "--allow-empty", "-m", "chore: historical foundation");
  for (const entry of releasePackages.filter((entry) =>
    ["cli", "client", "ai_sdk"].includes(entry.id),
  )) {
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
    "# Changelog\n\n## [0.0.1-alpha.0]\n\n- Issued alpha.\n",
  );
  git("add", ".");
  git("commit", "--quiet", "-m", "chore: release v0.0.1-alpha.0");
  const state = validateReleaseCommit(root, git("rev-parse", "HEAD"));
  assert.deepEqual(
    state.selectedPackages.map((entry) => entry.id),
    ["cli", "client", "ai_sdk", "python"],
  );
});

function artifactBytes(root: string, path: string, content: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
  return {
    path,
    sha256: createHash("sha256").update(content).digest("hex"),
    integrity: `sha512-${createHash("sha512").update(content).digest("base64")}`,
  };
}

test("Mastra publication hashes only selected artifacts while installed dependencies stay available", (t) => {
  const { root, base } = fixture(t);
  prepareRelease(root, "patch", "alpha", false, "integration-mastra", base);
  const output = join(root, "artifacts");
  const selected = artifactBytes(
    output,
    "npm/remote-skills-mastra-0.0.1-alpha.1.tgz",
    "selected Mastra archive",
  );
  artifactBytes(
    output,
    "npm/remote-skills-client-0.0.1-alpha.0.tgz",
    "SDK used by installed tests",
  );
  artifactBytes(
    output,
    "npm/remote-skills-ai-sdk-0.0.1-alpha.0.tgz",
    "AI SDK regression dependency",
  );
  const state = readReleaseState(root);
  const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
  const plan = buildPublicationPlan(state, output, changelog);
  assert.deepEqual(plan.packages, [
    {
      name: "@remote-skills/mastra",
      version: "0.0.1-alpha.1",
      registry: "npm",
      npmTag: "alpha",
      files: [selected],
    },
  ]);
  assert.deepEqual(plan.releases, [
    {
      scope: "integration-mastra",
      version: "0.0.1-alpha.1",
      gitTag: "integration-mastra/v0.0.1-alpha.1",
      prerelease: true,
      notes: "release-notes-integration-mastra.md",
    },
  ]);
  assert.match(
    readFileSync(join(output, "release-notes-integration-mastra.md"), "utf8"),
    /## \[integration-mastra\/v0\.0\.1-alpha\.1\]/u,
  );
  rmSync(join(output, selected.path));
  assert.throws(() => buildPublicationPlan(state, output, changelog), { code: "ENOENT" });
});

test("multi-scope publication keeps exactly selected packages with the client first", (t) => {
  const { root, base } = fixture(t);
  prepareRelease(root, "patch", "alpha", false, "integration-mastra", base);
  prepareRelease(root, "patch", "alpha", false, "core", base);
  prepareRelease(root, "patch", "alpha", false, "integration-ai-sdk", base);
  const output = join(root, "artifacts");
  for (const name of ["mastra", "cli", "client", "ai-sdk"]) {
    artifactBytes(
      output,
      `npm/remote-skills-${name}-0.0.1-alpha.1.tgz`,
      `${name} selected archive`,
    );
  }
  artifactBytes(output, "python/remote_skills-0.0.1a1-py3-none-any.whl", "selected Python wheel");
  artifactBytes(output, "python/remote_skills-0.0.1a1.tar.gz", "selected Python source");
  artifactBytes(output, "npm/unselected-package-9.0.0.tgz", "unselected archive");
  const plan = buildPublicationPlan(
    readReleaseState(root),
    output,
    readFileSync(join(root, "CHANGELOG.md"), "utf8"),
  );
  assert.deepEqual(
    plan.packages.map((entry) => entry.name),
    [
      "@remote-skills/client",
      "@remote-skills/mastra",
      "@remote-skills/cli",
      "remote-skills",
      "@remote-skills/ai-sdk",
    ],
  );
  assert.deepEqual(
    plan.releases.map((entry) => entry.gitTag),
    [
      "integration-mastra/v0.0.1-alpha.1",
      "core/v0.0.1-alpha.1",
      "integration-ai-sdk/v0.0.1-alpha.1",
    ],
  );
});

test("Python alpha.1 publication requires exact filenames and cannot substitute alpha.10", (t) => {
  const { root, base } = fixture(t);
  prepareRelease(root, "patch", "alpha", false, "core", base);
  const output = join(root, "artifacts");
  for (const name of ["cli", "client"]) {
    artifactBytes(
      output,
      `npm/remote-skills-${name}-0.0.1-alpha.1.tgz`,
      `${name} selected archive`,
    );
  }
  artifactBytes(output, "python/remote_skills-0.0.1a10-py3-none-any.whl", "wrong alpha wheel");
  artifactBytes(output, "python/remote_skills-0.0.1a10.tar.gz", "wrong alpha source");
  assert.deepEqual(pythonArtifactPaths({ name: "remote-skills", version: "0.0.1a1" }), [
    "python/remote_skills-0.0.1a1-py3-none-any.whl",
    "python/remote_skills-0.0.1a1.tar.gz",
  ]);
  const state = readReleaseState(root);
  const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
  assert.throws(() => buildPublicationPlan(state, output, changelog), { code: "ENOENT" });
  const wheel = artifactBytes(
    output,
    "python/remote_skills-0.0.1a1-py3-none-any.whl",
    "correct alpha wheel",
  );
  const source = artifactBytes(
    output,
    "python/remote_skills-0.0.1a1.tar.gz",
    "correct alpha source",
  );
  const plan = buildPublicationPlan(state, output, changelog);
  assert.deepEqual(plan.packages.find((entry) => entry.registry === "pypi")?.files, [
    wheel,
    source,
  ]);
});

for (const id of ["cli", "client", "ai_sdk"]) {
  test(`legacy release state rejects missing required ${id} manifest`, (t) => {
    const { root } = fixture(t);
    writeFileSync(
      join(root, "release-state.json"),
      JSON.stringify({ version: "0.0.1-alpha.0", previousVersion: "0.0.1", initial: true }),
    );
    const entry = releasePackages.find((candidate) => candidate.id === id);
    assert.ok(entry);
    const path = join(root, entry.manifest);
    rmSync(path);
    assert.throws(() => readReleaseState(root), { code: "ENOENT", path });
  });
}

test("scoped release state rejects a missing selected Mastra manifest", (t) => {
  const { root, base } = fixture(t);
  prepareRelease(root, "patch", "alpha", false, "integration-mastra", base);
  const path = join(root, "integrations/mastra/package.json");
  rmSync(path);
  assert.throws(() => readReleaseState(root), { code: "ENOENT", path });
});

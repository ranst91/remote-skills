import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { type TestContext, test } from "node:test";

const gate = resolve("scripts/check-no-publication.ts");

interface FixtureFiles {
  [path: string]: string;
}

interface ReadinessOverrides {
  publication?: boolean;
  reviewerNote?: string;
  statement?: string;
}

interface GateFixture {
  commit: string;
  output: string;
  readiness: string;
  repository: string;
}

function git(repository: string, args: readonly string[]) {
  return spawnSync("git", args, { cwd: repository, encoding: "utf8" });
}

function writeFiles(repository: string, files: FixtureFiles): void {
  for (const [path, contents] of Object.entries(files)) {
    const destination = join(repository, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, contents);
  }
}

function readinessEvidence(commit: string, overrides: ReadinessOverrides = {}) {
  return {
    schemaVersion: 1,
    kind: "remote-skills-local-publication-readiness",
    status: "local-artifacts-verified",
    statement: "No package was published; these are local artifact checks only.",
    source: { commit, trackedTreeClean: true },
    registryAccess: false,
    publication: false,
    artifacts: [
      { ecosystem: "npm", name: "@remote-skills/cli", localArtifact: true },
      { ecosystem: "npm", name: "@remote-skills/client", localArtifact: true },
      { ecosystem: "npm", name: "@remote-skills/ai-sdk", localArtifact: true },
      { ecosystem: "pypi", name: "remote-skills", format: "wheel", localArtifact: true },
      { ecosystem: "pypi", name: "remote-skills", format: "sdist", localArtifact: true },
    ],
    ...overrides,
  };
}

function makeFixture(testContext: TestContext, files: FixtureFiles = {}): GateFixture {
  const root = mkdtempSync(join(tmpdir(), "remote-skills-no-publication-"));
  testContext.after(() => rmSync(root, { recursive: true, force: true }));
  const repository = join(root, "repository");
  mkdirSync(repository);
  writeFiles(repository, {
    "package.json": `${JSON.stringify({
      name: "boundary-fixture",
      private: true,
      scripts: { pack: "pnpm pack --pack-destination artifacts" },
    })}\n`,
    ".github/workflows/ci.yml": "on:\n  pull_request:\npermissions:\n  contents: read\n",
    "scripts/local-artifacts.mjs":
      'import { spawnSync } from "node:child_process";\nspawnSync("pnpm", ["pack"]);\n',
    "tools/offline-python.mjs":
      'const environment = { "UV_OFFLINE": "true", "UV_DEFAULT_INDEX": "http://127.0.0.1:9/simple" };\n',
    "README.md":
      "The publisher builds a static origin. No package was published, reserved, tagged, or uploaded to npm or PyPI.\n",
    ...files,
  });
  for (const args of [
    ["init", "--quiet"],
    ["config", "user.name", "Boundary Test"],
    ["config", "user.email", "boundary@example.invalid"],
    ["add", "."],
    ["commit", "--quiet", "-m", "boundary fixture"],
  ]) {
    const result = git(repository, args);
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }
  const commit = git(repository, ["rev-parse", "HEAD"]).stdout.trim();
  const readiness = join(root, "readiness.json");
  const output = join(root, "no-publication.json");
  writeFileSync(readiness, `${JSON.stringify(readinessEvidence(commit))}\n`);
  return { commit, output, readiness, repository };
}

function runGate(fixture: GateFixture) {
  return spawnSync(
    process.execPath,
    [
      gate,
      "--repository",
      fixture.repository,
      "--readiness-evidence",
      fixture.readiness,
      "--output",
      fixture.output,
    ],
    { encoding: "utf8" },
  );
}

test("no-publication gate records commit-bound classified evidence", (testContext) => {
  const fixture = makeFixture(testContext);

  const result = runGate(fixture);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const evidence: unknown = JSON.parse(readFileSync(fixture.output, "utf8"));
  assert.ok(typeof evidence === "object" && evidence !== null);
  assert.equal(Reflect.get(evidence, "kind"), "remote-skills-no-publication-boundary");
  assert.equal(Reflect.get(evidence, "status"), "no-publication-boundary-verified");
  const source: unknown = Reflect.get(evidence, "source");
  assert.ok(typeof source === "object" && source !== null);
  assert.equal(Reflect.get(source, "commit"), fixture.commit);
  assert.equal(Reflect.get(source, "trackedTreeClean"), true);
  assert.equal(Reflect.get(evidence, "publication"), false);
  assert.equal(Reflect.get(evidence, "registryAccess"), false);
  const inspection: unknown = Reflect.get(evidence, "inspection");
  assert.ok(typeof inspection === "object" && inspection !== null);
  assert.equal(Reflect.get(inspection, "prohibitedFindings"), 0);
  const trackedFiles: unknown = Reflect.get(inspection, "trackedFiles");
  assert.ok(typeof trackedFiles === "number" && trackedFiles >= 4);
  const classifications: unknown = Reflect.get(inspection, "allowedClassifications");
  assert.ok(typeof classifications === "object" && classifications !== null);
  for (const classification of [
    "localPackageOperations",
    "negativeBoundaryStatements",
    "offlineRegistrySentinels",
  ]) {
    const count: unknown = Reflect.get(classifications, classification);
    assert.ok(typeof count === "number" && count >= 1);
  }
});

test("no-publication gate allows standalone removal of a registry override", (testContext) => {
  const fixture = makeFixture(testContext, {
    "scripts/offline-install.ts":
      'delete environment.npm_config_registry;\ndelete environment.NPM_CONFIG_REGISTRY;\nspawnSync("pnpm", ["install", "--offline"]);\n',
  });
  const result = runGate(fixture);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

for (const forbiddenCase of [
  {
    name: "registry deletion mixed with a registry assignment",
    finding: /publication-registry-or-credential/u,
    files: {
      "scripts/registry.ts":
        'delete environment.npm_config_registry; environment.npm_config_registry = "https://registry.npmjs.org";\n',
    },
  },
  {
    name: "registry assignment after a standalone deletion",
    finding: /publication-registry-or-credential/u,
    files: {
      "scripts/registry.ts":
        'delete environment.npm_config_registry;\nenvironment.npm_config_registry = "https://registry.npmjs.org";\n',
    },
  },
  {
    name: "npm publish command",
    finding: /package-publication-command/u,
    files: {
      "package.json": `${JSON.stringify({
        name: "boundary-fixture",
        private: true,
        scripts: { release: "npm publish --access public" },
      })}\n`,
    },
  },
  {
    name: "PyPI upload command",
    finding: /package-publication-command/u,
    files: {
      "scripts/release.mjs": 'spawnSync("uv", ["publish", "dist/package.whl"]);\n',
    },
  },
  {
    name: "publication command in a tool outside the scripts directory",
    finding: /package-publication-command/u,
    files: { "tools/release.mjs": 'spawnSync("npm", ["publish"]);\n' },
  },
  {
    name: "publishing registry and credential configuration",
    finding: /publication-registry-or-credential/u,
    files: {
      ".npmrc":
        "registry=https://registry.npmjs.org\n//registry.npmjs.org/:_authToken=$" + "{NPM_TOKEN}\n",
    },
  },
  {
    name: "Trusted Publishing and tag-triggered workflow",
    finding: /trusted-publishing-or-tag-trigger/u,
    files: {
      ".github/workflows/release.yml": [
        "on:",
        "  push:",
        "    tags: ['v*']",
        "permissions:",
        "  id-token: write",
        "jobs:",
        "  publish:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - uses: pypa/gh-action-pypi-publish@release/v1",
        "",
      ].join("\n"),
    },
  },
  {
    name: "publication credential in a workflow",
    finding: /publication-registry-or-credential/u,
    files: {
      ".github/workflows/release.yml": [
        "on: workflow_dispatch",
        "jobs:",
        "  release:",
        "    runs-on: ubuntu-latest",
        "    env:",
        "      NODE_AUTH_TOKEN: placeholder",
        "",
      ].join("\n"),
    },
  },
  {
    name: "completed npm publication claim",
    finding: /completed-publication-claim/u,
    files: { "docs/release.md": "@remote-skills/client is published on npm.\n" },
  },
  {
    name: "positive claim after a negative statement on the same line",
    finding: /completed-publication-claim/u,
    files: {
      "docs/release.md": "No package was published; @remote-skills/client is published on npm.\n",
    },
  },
  {
    name: "positive claim after a negative clause joined by and",
    finding: /completed-publication-claim/u,
    files: {
      "docs/release.md":
        "No package was published and @remote-skills/client is published on npm.\n",
    },
  },
  {
    name: "positive command after a negative clause and colon",
    finding: /package-publication-command/u,
    files: { "docs/release.md": "No package was published: run npm publish --access public.\n" },
  },
  {
    name: "positive claim after a negative clause and em dash",
    finding: /completed-publication-claim/u,
    files: {
      "docs/release.md": "No package was published — @remote-skills/client is published on npm.\n",
    },
  },
  {
    name: "package publication command in documentation",
    finding: /package-publication-command/u,
    files: { "docs/release.md": "Run npm publish --access public.\n" },
  },
  {
    name: "package-name reservation claim",
    finding: /package-name-claim/u,
    files: { "openspec/config.yaml": "context: The npm organization is already reserved.\n" },
  },
  {
    name: "npm registry mutation command",
    finding: /publication-registry-or-credential/u,
    files: { "scripts/reserve.sh": "npm access set status=public @remote-skills/cli\n" },
  },
  {
    name: "workflow registry URL configuration",
    finding: /publication-registry-or-credential/u,
    files: {
      ".github/workflows/release.yml":
        "on: workflow_dispatch\nsteps:\n  - uses: actions/setup-node@v4\n    with:\n      registry-url: https://registry.npmjs.org\n",
    },
  },
  {
    name: "PyPI credential file",
    finding: /publication-registry-or-credential/u,
    files: {
      ".pypirc": "[pypi]\nrepository = https://upload.pypi.org/legacy/\nusername = token\n",
    },
  },
  {
    name: "positive Trusted Publishing claim",
    finding: /trusted-publishing-or-tag-trigger/u,
    files: { "docs/release.md": "PyPI uses Trusted Publishing for the release.\n" },
  },
]) {
  test(`no-publication gate rejects ${forbiddenCase.name}`, (testContext) => {
    const fixture = makeFixture(testContext, forbiddenCase.files);

    const result = runGate(fixture);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, forbiddenCase.finding);
    assert.equal(existsSync(fixture.output), false);
  });
}

test("no-publication gate rejects a readiness output that claims publication", (testContext) => {
  const fixture = makeFixture(testContext);
  writeFileSync(
    fixture.readiness,
    `${JSON.stringify(
      readinessEvidence(fixture.commit, {
        publication: true,
        statement: "The packages were published to npm and PyPI.",
      }),
    )}\n`,
  );

  const result = runGate(fixture);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /readiness-publication-claim/u);
  assert.equal(existsSync(fixture.output), false);
});

test("no-publication gate rejects an extra positive readiness string", (testContext) => {
  const fixture = makeFixture(testContext);
  writeFileSync(
    fixture.readiness,
    `${JSON.stringify(
      readinessEvidence(fixture.commit, {
        reviewerNote: "The package is published on npm.",
      }),
    )}\n`,
  );

  const result = runGate(fixture);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /readiness-completed-publication-claim/u);
  assert.equal(existsSync(fixture.output), false);
});

test("no-publication gate rejects commit drift and an unclean repository", (testContext) => {
  const fixture = makeFixture(testContext);
  writeFileSync(join(fixture.repository, "untracked.txt"), "not inspected\n");

  const result = runGate(fixture);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /fully clean repository/u);
  assert.equal(existsSync(fixture.output), false);
});

test("CI wires the final boundary gate to the local readiness output", () => {
  const workflow = readFileSync(".github/workflows/ci.yml", "utf8");

  assert.match(workflow, /run: node scripts\/check-no-publication\.ts/u);
  assert.match(workflow, /NO_PUBLICATION_READINESS_INPUT:/u);
  assert.match(workflow, /NO_PUBLICATION_EVIDENCE_OUTPUT:/u);
});

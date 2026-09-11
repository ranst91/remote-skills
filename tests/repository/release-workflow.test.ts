import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";

const workflow = readFileSync(
  new URL("../../.github/workflows/prepare-release.yml", import.meta.url),
  "utf8",
);
function step(name: string) {
  const text = workflow.split(`      - name: ${name}\n`)[1]?.split("      - name:")[0];
  const run = text?.split("        run: |\n")[1];
  assert.ok(run, `Missing workflow step ${name}`);
  return run
    .split("\n")
    .map((line) => (line.startsWith("          ") ? line.slice(10) : line))
    .join("\n");
}
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "release-workflow-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const remote = join(directory, "remote.git");
  const root = join(directory, "runner");
  mkdirSync(root);
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "--bare", remote);
  git("init", "-b", "main");
  git("config", "user.name", "Workflow Test");
  git("config", "user.email", "workflow@example.invalid");
  writeFileSync(join(root, "README.md"), "Fixture\n");
  git("add", ".");
  git("commit", "-m", "feat: baseline");
  const base = git("rev-parse", "HEAD");
  git("remote", "add", "origin", remote);
  git("push", "-u", "origin", "main");
  const bin = join(directory, "bin");
  mkdirSync(bin);
  const gh = join(bin, "gh");
  writeFileSync(
    gh,
    `#!/bin/sh
printf '%s\\n' "$*" >> "$GH_CALLS"
case "$*" in
  'pr list --state open '*) printf '%s\\n' "$MOCK_OPEN_PR" ;;
  'pr list --state merged '*) printf '%s\\n' "$MOCK_MERGED_HEAD" ;;
  'pr view '*) printf '%s\\n' "$MOCK_PR_STATE" ;;
esac
`,
  );
  chmodSync(gh, 0o755);
  const output = join(directory, "output");
  const calls = join(directory, "gh-calls");
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    GITHUB_OUTPUT: output,
    GH_CALLS: calls,
    MOCK_OPEN_PR: "",
    MOCK_MERGED_HEAD: "",
    MOCK_PR_STATE: "OPEN",
  };
  const run = (script: string, extra: Record<string, string> = {}) =>
    execFileSync("bash", ["-e", "-c", script], {
      cwd: root,
      env: { ...env, ...extra },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  const select = (extra: Record<string, string> = {}) =>
    run(step("Select the open release PR or start a new cycle"), extra);
  const branch = () => {
    git("switch", "-c", "release/next");
    writeFileSync(
      join(root, "release-state.json"),
      JSON.stringify({ schemaVersion: 2, baseSha: base, scopes: { core: { version: "0.0.1" } } }),
    );
    writeFileSync(join(root, "CHANGELOG.md"), "Human release notes\n");
    git("add", ".");
    git("commit", "-m", "chore: release packages");
    git("push", "-u", "origin", "release/next");
    const head = git("rev-parse", "HEAD");
    git("switch", "main");
    git("branch", "-D", "release/next");
    return head;
  };
  return { root, remote, directory, git, base, calls, output, run, select, branch };
}

test("workflow accumulates the existing PR branch and preserves human notes and PR body", (t) => {
  const f = fixture(t);
  f.branch();
  f.select({ MOCK_OPEN_PR: "42" });
  assert.equal(readFileSync(join(f.root, "CHANGELOG.md"), "utf8"), "Human release notes\n");
  assert.match(readFileSync(f.output, "utf8"), new RegExp(`base_sha=${f.base}`, "u"));
  // Execute the production push/API portion; preparation/staging is tested separately.
  const push = step("Accumulate versions and explicitly start PR CI").split("          ").join("");
  const portion = push.slice(push.indexOf("gh auth setup-git"));
  f.run(portion, { EXISTING_PR: "42", OLD_SHA: f.git("rev-parse", "HEAD") });
  const calls = readFileSync(f.calls, "utf8");
  assert.match(calls, /workflow run ci.yml --ref release\/next/u);
  assert.doesNotMatch(calls, /pr (edit|create)/u);
});

test("workflow starts a new cycle from current main after a merged stale release branch", (t) => {
  const f = fixture(t);
  const old = f.branch();
  f.git("merge", "--squash", "origin/release/next");
  f.git("commit", "-m", "chore: release packages (#42)");
  f.git("push", "origin", "main");
  const main = f.git("rev-parse", "HEAD");
  f.select({ MOCK_MERGED_HEAD: old });
  assert.equal(f.git("rev-parse", "HEAD"), main);
  assert.match(readFileSync(f.output, "utf8"), new RegExp(`base_sha=${main}`, "u"));
  const script = step("Accumulate versions and explicitly start PR CI");
  f.run(script.slice(script.indexOf("gh auth setup-git")), { EXISTING_PR: "", OLD_SHA: old });
  assert.equal(f.git("rev-parse", "origin/release/next"), main);
  assert.match(readFileSync(f.calls, "utf8"), /pr create/u);
});

test("workflow refuses an unmerged orphan or a stale branch edited since its merge", (t) => {
  const f = fixture(t);
  f.branch();
  assert.throws(() => f.select(), /Unmerged or edited release/u);
  assert.throws(() => f.select({ MOCK_MERGED_HEAD: f.base }), /Unmerged or edited release/u);
});

test("workflow rejects concurrent branch edits with ordinary push and explicit lease", (t) => {
  for (const existing of [true, false]) {
    const f = fixture(t);
    const old = f.branch();
    f.select(existing ? { MOCK_OPEN_PR: "42" } : { MOCK_MERGED_HEAD: old });
    const concurrent = execFileSync(
      "git",
      ["commit-tree", `${old}^{tree}`, "-p", old, "-m", "Human concurrent change"],
      { cwd: f.root, encoding: "utf8" },
    ).trim();
    f.git("push", "origin", `${concurrent}:refs/heads/release/next`);
    const script = step("Accumulate versions and explicitly start PR CI");
    assert.throws(
      () =>
        f.run(script.slice(script.indexOf("gh auth setup-git")), {
          EXISTING_PR: existing ? "42" : "",
          OLD_SHA: old,
        }),
      /rejected/u,
    );
    assert.equal(
      execFileSync("git", ["--git-dir", f.remote, "rev-parse", "release/next"], {
        encoding: "utf8",
      }).trim(),
      concurrent,
    );
  }
});

test("workflow refuses to push when the existing PR closed during preparation", (t) => {
  const f = fixture(t);
  const old = f.branch();
  f.select({ MOCK_OPEN_PR: "42" });
  const script = step("Accumulate versions and explicitly start PR CI");
  assert.throws(
    () =>
      f.run(script.slice(script.indexOf("gh auth setup-git")), {
        EXISTING_PR: "42",
        OLD_SHA: old,
        MOCK_PR_STATE: "MERGED",
      }),
    /closed during preparation/u,
  );
});

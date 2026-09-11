import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createPnpmCommand } from "../lib/pnpm-command.ts";
import { changelogSection, readReleaseState } from "./release-lib.ts";
import { preparePythonArtifactCache } from "./python-artifacts.ts";

const [destination, sourceRoot, ...extra] = process.argv.slice(2);
if (extra.length) throw new Error("usage: verify-artifacts.ts [artifact-directory] [source-root]");
const root = resolve(sourceRoot ?? process.cwd());
const output = resolve(destination ?? join(tmpdir(), `remote-skills-verified-${Date.now()}`));
if (existsSync(output)) throw new Error("Verified artifact output must not already exist");
const work = mkdtempSync(join(tmpdir(), "remote-skills-artifact-gate-"));
const environment = {
  ...process.env,
  REMOTE_SKILLS_SOURCE_ROOT: root,
  UV_CACHE_DIR: join(work, "uv-cache"),
  npm_config_store_dir: join(work, "pnpm-store"),
  npm_config_cache_dir: join(work, "pnpm-cache"),
  XDG_CACHE_HOME: join(work, "cache"),
};
function run(command: string, args: string[], env: NodeJS.ProcessEnv = environment) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Artifact verification command failed: ${command}`);
}
try {
  const build = createPnpmCommand(["ci:build:repository"]);
  run(build.command, build.args);
  console.log("Preparing declared artifact dependencies in empty private caches.");
  run(process.execPath, [resolve(import.meta.dirname, "seed-package-cache.ts")]);
  const constraints = preparePythonArtifactCache(root, work, environment);
  const evidence = join(work, "readiness.json");
  run(process.execPath, [resolve(import.meta.dirname, "../check-publication-readiness.ts")], {
    ...environment,
    REMOTE_SKILLS_PYTHON_CONSTRAINTS: constraints,
    PUBLICATION_READINESS_OUTPUT: evidence,
    PUBLICATION_ARTIFACT_OUTPUT: output,
  });
  run(process.execPath, [
    resolve(import.meta.dirname, "../check-no-publication.ts"),
    "--repository",
    root,
    "--readiness-evidence",
    evidence,
    "--output",
    join(work, "no-publication.json"),
  ]);
  const state = readReleaseState(root);
  mkdirSync(output, { recursive: true });
  copyFileSync(evidence, join(output, "verification.json"));
  const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
  writeFileSync(
    join(output, "release-notes.md"),
    changelog.includes(`## [${state.npmVersion}]`)
      ? changelogSection(changelog, state.npmVersion)
      : "Local artifact verification; nothing published.\n",
  );
  console.log(`Verified all five artifacts: ${output}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}

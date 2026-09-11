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
import { buildPublicationPlan, pythonArtifactPaths } from "./publication-plan.ts";
import { preparePythonArtifactCache } from "./python-artifacts.ts";
import { readReleaseState } from "./release-lib.ts";

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
  const state = readReleaseState(root);
  const build = createPnpmCommand(["ci:build:repository"]);
  run(build.command, build.args);
  console.log("Preparing declared artifact dependencies in empty private caches.");
  run(process.execPath, [resolve(import.meta.dirname, "seed-package-cache.ts")]);
  const constraints = preparePythonArtifactCache(root, work, environment, state.pythonManifests);
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
  mkdirSync(output, { recursive: true });
  copyFileSync(evidence, join(output, "verification.json"));
  const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
  const plan = buildPublicationPlan(state, output, changelog);
  writeFileSync(join(output, "publication.json"), `${JSON.stringify(plan, null, 2)}\n`);
  for (const helper of ["publish-artifacts.ts", "publication-lib.ts"])
    copyFileSync(join(import.meta.dirname, helper), join(output, helper));
  const candidate = join(work, "candidate-packages.json");
  writeFileSync(
    candidate,
    JSON.stringify({
      npm: state.manifests.map((entry) => ({
        name: entry.name,
        version: entry.version,
        spec: join(
          output,
          "npm",
          `${entry.name.replace(/^@/u, "").replaceAll("/", "-")}-${entry.version}.tgz`,
        ),
      })),
      python: state.pythonManifests.map((entry) => ({
        name: entry.name,
        version: entry.version,
        spec: join(output, pythonArtifactPaths(entry)[0] ?? ""),
      })),
    }),
  );
  const candidateEnvironment: NodeJS.ProcessEnv = {
    ...environment,
    REMOTE_SKILLS_E2E_PACKAGES: candidate,
  };
  // Keep Linux Playwright's preinstalled browser visible outside the private package caches.
  if (process.env.XDG_CACHE_HOME === undefined) delete candidateEnvironment.XDG_CACHE_HOME;
  else candidateEnvironment.XDG_CACHE_HOME = process.env.XDG_CACHE_HOME;
  run(
    process.execPath,
    [
      "--test",
      "--test-concurrency=1",
      resolve(import.meta.dirname, "../../tests/examples/end-to-end.test.ts"),
      resolve(import.meta.dirname, "../../tests/examples/vercel-ai-sdk.test.ts"),
      ...(state.manifests.some((entry) => entry.id === "langchain")
        ? [resolve(import.meta.dirname, "../../tests/examples/langchain.test.ts")]
        : []),
    ],
    candidateEnvironment,
  );
  console.log(`Verified candidate artifacts and selected publication plan: ${output}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import {
  consumeStandardV02,
  scopeVersionEvidence,
} from "../helpers/scope-version-parity/evidence.ts";

const requiredEvidence = [
  "scope_request_not_grant",
  "authentication_401",
  "authorization_403",
  "artifact_authorization",
  "scope_and_credential_isolation",
  "non_persistence",
  "semver_parity",
  "immutable_mapping",
  "authoritative_removal",
  "bounded_stale",
  "session_pins",
  "v0_2_extension_ignored",
];

const repositoryRoot = resolve(import.meta.dirname, "../..");
const helperRoot = resolve(repositoryRoot, "tests/helpers/scope-version-parity");
type Runtime = "typescript" | "python";

function expectedResult(runtime: Runtime) {
  return {
    runtime,
    evidence: requiredEvidence,
    scope: {
      authentication: "authentication_failed",
      authorization: "authorization_denied",
      self_grant: false,
      artifact_authorization: "authorization_denied",
      artifact_scope_forwarded: false,
    },
    isolation: {
      engineering: ["engineering-skill"],
      sales: ["sales-skill"],
      engineering_pin: "engineering",
      sales_pin: "sales",
      cross_scope: false,
      credential_occurrences: 0,
    },
    persistence: {
      no_store_files: 0,
      unconfirmed_files: 0,
      unconfirmed_catalog: ["engineering-skill"],
    },
    semver: {
      large: "9007199254740993.0.0",
      prerelease: "1.0.0-9007199254740993",
    },
    removal: {
      code: "version_unavailable",
      artifact_requests: 0,
      pinned_instructions: "# 1.4.7",
    },
    stale: {
      boundary: { stale: true, age: 300_000 },
      expired: "origin_unavailable",
    },
    pins: {
      first: "1.4.7",
      future: "1.4.8",
      repeated: "1.4.7",
      scope: "engineering",
      digest_immutable: true,
    },
    immutable_mapping: "catalog_invalid",
    v0_2: {
      count: 1,
      name: "code-review",
      source_extension: true,
      extension_observed: false,
      type: "skill-md",
      url: "/.well-known/agent-skills/artifacts/3.0.0.md",
      digest_verified: true,
      usable: true,
      requests: 2,
    },
  };
}

async function filesBelow(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await filesBelow(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function runWorker(runtime: Runtime, directory: string, secret: string) {
  const worker = resolve(
    helperRoot,
    runtime === "python" ? "python-runtime-gate.py" : "node-runtime-gate.ts",
  );
  const pythonCandidates = [
    resolve(repositoryRoot, ".venv/bin/python"),
    resolve(repositoryRoot, ".venv/Scripts/python.exe"),
  ];
  const command =
    runtime === "python"
      ? pythonCandidates.find((candidate) => existsSync(candidate))
      : process.execPath;
  assert.ok(command, "no locked-project Python interpreter is available");
  const args = runtime === "python" ? [worker, directory] : ["--no-warnings", worker, directory];
  assert.equal(
    args.some((argument) => argument.includes(secret)),
    false,
    "credential entered argv",
  );
  return spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      PYTHONPATH: resolve(repositoryRoot, "packages/sdk-python/src"),
    },
    input: secret,
    timeout: 30_000,
  });
}

test("scope/version parity gate declares required evidence and rejects malformed v0.2 descriptors", async () => {
  assert.deepEqual(scopeVersionEvidence, requiredEvidence);
  const artifact = Buffer.from("current artifact");
  const current = {
    name: "code-review",
    description: "Standard reader mutation probe.",
    type: "skill-md",
    url: "artifacts/current.md",
    digest: `sha256:${createHash("sha256").update(artifact).digest("hex")}`,
    "x-remote-skills": { version: "1.0.0", releases: [] },
  };
  const document = {
    $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
    skills: [current],
  };
  const fetchBytes = async () => artifact;

  for (const mutation of [
    { type: "future-artifact" },
    { url: 7 },
    { digest: `sha256:${"0".repeat(64)}` },
  ]) {
    await assert.rejects(
      consumeStandardV02(
        { ...document, skills: [{ ...current, ...mutation }] },
        "https://skills.example.test/.well-known/agent-skills/index.json",
        fetchBytes,
      ),
      /invalid standard v0\.2 current descriptor/u,
    );
  }
});

test("Python persistence evidence counts cache content instead of platform coordination", async () => {
  const source = await readFile(resolve(helperRoot, "python-runtime-gate.py"), "utf8");

  assert.match(source, /directory\s*\/\s*["']cache-v1["']/u);
});

for (const runtime of ["typescript", "python"] as const) {
  test(`${runtime} public flow satisfies scope/version parity without credential persistence`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), `remote-skills-scope-version-${runtime}-`));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const secret = ["RMS", runtime.toUpperCase(), "SCOPE", "PARITY", "91C4"].join("_");

    const result = runWorker(runtime, directory, secret);

    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stderr, "", `${runtime} wrote unexpected stderr`);
    assert.doesNotMatch(result.stdout, new RegExp(secret, "u"));
    const observed: unknown = JSON.parse(result.stdout);
    assert.deepEqual(observed, expectedResult(runtime));
    for (const path of await filesBelow(directory)) {
      assert.equal(path.includes(secret), false, `${runtime} persisted its credential in a path`);
      assert.equal(
        (await readFile(path)).includes(secret),
        false,
        `${runtime} persisted its credential`,
      );
    }
  });
}

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const helperRoot = resolve(repositoryRoot, "tests/helpers/network-security");
const nodeWorker = resolve(helperRoot, "node-runtime-gate.ts");
const pythonWorker = resolve(helperRoot, "python-runtime-gate.py");
type Runtime = "cli" | "typescript" | "python";

function expectedResult(runtime: Runtime) {
  return {
    runtime,
    headers: {
      same_host: ["origin", "origin", "origin"],
      cross_host: ["origin", "none"],
      explicit_cross_host: [runtime === "cli" ? "none" : "cdn"],
    },
    redirects: {
      multi_hop: { code: null, requests: 3 },
      overflow: { code: "policy_denied", requests: 6 },
    },
    rebinding: {
      code: "policy_denied",
      connection_requests: 1,
      resolutions: 2,
    },
    loopback: { code: null, requests: 1 },
    sanitization: {
      control: "configuration_invalid",
      query: "configuration_invalid",
      userinfo: "configuration_invalid",
    },
    limits: {
      body: { code: "limit_exceeded", requests: 1 },
      retry_exhaustion: { code: "origin_unavailable", requests: 3 },
      timeout: { code: "request_timeout", requests: 2 },
    },
    observed_sink_payloads:
      runtime === "cli"
        ? ["cache", "diagnostic", "error", "snapshot", "transcript"]
        : runtime === "typescript"
          ? ["cache", "debug", "diagnostic", "error", "event", "snapshot", "temp", "transcript"]
          : ["cache", "debug", "diagnostic", "error", "snapshot", "temp", "transcript"],
    live_temporary_files:
      runtime === "cli"
        ? null
        : {
            observations: 1,
            files: runtime === "typescript" ? 4 : 3,
            secret_occurrences: 0,
          },
    persisted_secret_occurrences: 0,
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

function runWorker(runtime: Runtime, directory: string, secret: string, probeLeak = false) {
  const args =
    runtime === "python"
      ? [pythonWorker, directory, ...(probeLeak ? ["--probe-leak"] : [])]
      : ["--no-warnings", nodeWorker, runtime, directory, ...(probeLeak ? ["--probe-leak"] : [])];
  assert.equal(
    args.some((value) => value.includes(secret)),
    false,
    `${runtime} secret entered argv`,
  );
  const pythonCandidates = [
    resolve(repositoryRoot, ".venv/bin/python"),
    resolve(repositoryRoot, ".venv/Scripts/python.exe"),
  ];
  const command =
    runtime === "python"
      ? pythonCandidates.find((candidate) => candidate && existsSync(candidate))
      : process.execPath;
  assert.ok(command, "no locked-project Python interpreter is available");
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

for (const runtime of ["cli", "typescript", "python"] as const) {
  test(`${runtime} adversarial network process is bounded and credential-safe`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), `remote-skills-network-${runtime}-`));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const secret = ["RMS", runtime.toUpperCase(), "NETWORK", "CANARY", "7D3A9C"].join("_");

    const result = runWorker(runtime, directory, secret);

    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stderr, "", `${runtime} wrote unexpected stderr`);
    assert.doesNotMatch(result.stdout, new RegExp(secret, "u"));
    assert.doesNotMatch(result.stderr, new RegExp(secret, "u"));

    const probe = runWorker(runtime, join(directory, "leak-probe"), secret, true);
    assert.equal(probe.signal, null, probe.stderr);
    assert.equal(probe.status, 1, `${runtime} did not reject the injected leak probe`);
    assert.match(probe.stderr, /network leak probe detected/u);
    assert.doesNotMatch(probe.stdout, new RegExp(secret, "u"));
    assert.doesNotMatch(probe.stderr, new RegExp(secret, "u"));
    const observed: unknown = JSON.parse(result.stdout);
    assert.deepEqual(observed, expectedResult(runtime));
    for (const path of await filesBelow(directory)) {
      assert.equal(path.includes(secret), false, `${runtime} persisted its secret in a file name`);
      const contents = await readFile(path);
      assert.equal(contents.includes(secret), false, `${runtime} persisted its secret in ${path}`);
    }
  });
}

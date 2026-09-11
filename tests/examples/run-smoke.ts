import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import "./static-host.test.ts";
import { createPnpmCommand } from "../../scripts/lib/pnpm-command.ts";

import { startAuthenticatedOrigin } from "./helpers/authenticated-origin.ts";
import { buildVersionedOrigin } from "./helpers/build-history.ts";

import { runRemoteSkills } from "./helpers/public-cli.ts";
import { startStaticOrigin } from "./helpers/static-host.ts";
import { verifyPagesRoot } from "./helpers/verify-origin.ts";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const exampleRoot = resolve(repositoryRoot, "examples");

interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  allowFailure?: boolean;
}

interface ProcessStatus {
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface JsonObject {
  [key: string]: unknown;
}

interface ConsumerResult {
  version: string;
  digest: string;
  confirmedScope: string;
  resources: string[];
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === "string");
}

function parseJsonObject(source: string, label: string): JsonObject {
  const value: unknown = JSON.parse(source);
  if (!isJsonObject(value)) throw new Error(`${label} must be a JSON object`);
  return value;
}

function requiredString(object: JsonObject, key: string, label: string): string {
  const value = object[key];
  if (typeof value !== "string") throw new Error(`${label}.${key} must be a string`);
  return value;
}

function parseCatalog(source: string) {
  const catalog = parseJsonObject(source, "catalog");
  if (!Array.isArray(catalog.skills) || !isJsonObject(catalog.skills[0])) {
    throw new Error("catalog.skills must contain an entry");
  }
  const entry = catalog.skills[0];
  const extension = entry["x-remote-skills"];
  if (!isJsonObject(extension) || !Array.isArray(extension.releases)) {
    throw new Error("catalog release history is missing");
  }
  const releases: unknown[] = extension.releases;
  const versions = releases.map((release) => {
    if (!isJsonObject(release)) throw new Error("catalog release must be an object");
    return requiredString(release, "version", "catalog release");
  });
  return { artifactUrl: requiredString(entry, "url", "catalog entry"), versions };
}

function parseDiagnosticCode(source: string): string {
  return requiredString(parseJsonObject(source, "diagnostic"), "code", "diagnostic");
}

function parseConsumerResult(source: string): ConsumerResult {
  const result = parseJsonObject(source, "consumer result");
  if (!isStringArray(result.resources)) {
    throw new Error("consumer result.resources must be an array of strings");
  }
  return {
    version: requiredString(result, "version", "consumer result"),
    digest: requiredString(result, "digest", "consumer result"),
    confirmedScope: requiredString(result, "confirmedScope", "consumer result"),
    resources: result.resources,
  };
}

async function run(command: string, arguments_: readonly string[], options: RunOptions = {}) {
  const child = spawn(command, arguments_, {
    cwd: options.cwd ?? repositoryRoot,
    env: { ...process.env, ...options.env, NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr += chunk;
  });
  const status = await new Promise<ProcessStatus>((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("close", (code, signal) => resolveExit({ code, signal }));
  });
  if (status.code !== 0 && options.allowFailure !== true) {
    throw new Error(
      `${command} ${arguments_.join(" ")} failed (${status.signal ?? status.code})\n${stdout}${stderr}`,
    );
  }
  return { ...status, stdout, stderr };
}

function environment(origin: string, token: string, cacheRoot: string): NodeJS.ProcessEnv {
  return {
    REMOTE_SKILLS_ORIGIN: origin,
    REMOTE_SKILLS_AUTH_TOKEN: token,
    REMOTE_SKILLS_SCOPE: "engineering",
    REMOTE_SKILLS_VERSION_RANGE: "1.4.x",
    XDG_CACHE_HOME: cacheRoot,
  };
}

async function generatedFiles(root: string) {
  const files: string[] = [];
  async function walk(directory: string, prefix = ""): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const name = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await walk(resolve(directory, entry.name), name);
      else files.push(name);
    }
  }
  await walk(root);
  return files.sort();
}

test("the complete local publishing and consumption example", async (context) => {
  const work = await mkdtemp(resolve(tmpdir(), "remote-skills-examples-"));
  try {
    const source = process.env.REMOTE_SKILLS_E2E_PACKAGES;
    const consumer =
      process.env.REMOTE_SKILLS_E2E_CONSUMER ??
      resolve(exampleRoot, "consumers/typescript/src/index.ts");
    const installedPython = process.env.REMOTE_SKILLS_E2E_PYTHON;
    if (source) {
      assert.ok(
        process.env.REMOTE_SKILLS_E2E_CLI &&
          process.env.REMOTE_SKILLS_E2E_CONSUMER &&
          installedPython,
        "Run installed-package smoke through end-to-end.test.ts to prepare isolated packages.",
      );
    }
    const dist = await buildVersionedOrigin(work);
    const index = parseCatalog(
      await readFile(resolve(dist, ".well-known/agent-skills/index.json"), "utf8"),
    );

    await context.test("build advertises the current and retained releases", async () => {
      const files = await generatedFiles(dist);
      assert.equal(files.length, 3);
      assert.ok(files.includes(".well-known/agent-skills/index.json"));
      assert.equal(
        files.filter((file) =>
          /^\.well-known\/agent-skills\/artifacts\/sha256-[0-9a-f]{64}\.tar\.gz$/u.test(file),
        ).length,
        2,
      );
      assert.deepEqual(index.versions, ["2.0.0", "1.4.7"]);
    });

    await context.test(
      "origin-root hosting and verification reject a project subpath",
      async () => {
        const publicOrigin = await startStaticOrigin({ root: dist });
        try {
          const catalogResponse = await fetch(
            `${publicOrigin.origin}/.well-known/agent-skills/index.json`,
          );
          assert.equal(catalogResponse.status, 200);
          assert.equal(catalogResponse.headers.get("content-type"), "application/json");
          assert.equal(
            (await fetch(`${publicOrigin.origin}/repository/.well-known/agent-skills/index.json`))
              .status,
            404,
          );
        } finally {
          await publicOrigin.close();
        }
        await verifyPagesRoot(dist);
      },
    );

    const token = randomUUID();
    const privateOrigin = await startAuthenticatedOrigin({ root: dist, token });
    try {
      const catalogUrl = `${privateOrigin.origin}/.well-known/agent-skills/index.json`;
      const consumerOrigin = `${privateOrigin.origin}/repository/`;
      const cacheRoot = resolve(work, "cache");
      const pnpm = createPnpmCommand(["--filter", "@remote-skills/client", "build"]);
      if (!source) await run(pnpm.command, pnpm.args);

      await context.test(
        "authentication enforces 401/403 catalog and artifact access without credential disclosure",
        async () => {
          assert.equal((await fetch(catalogUrl)).status, 401);
          assert.equal(
            (
              await fetch(catalogUrl, {
                headers: { Authorization: `Bearer ${token}`, "Remote-Skills-Scope": "sales" },
              })
            ).status,
            403,
          );
          assert.equal(
            (
              await fetch(catalogUrl, {
                headers: {
                  Authorization: `Bearer ${token}`,
                  "Remote-Skills-Scope": "engineering",
                },
              })
            ).status,
            200,
          );
          const artifactUrl = new URL(index.artifactUrl, catalogUrl);
          assert.equal((await fetch(artifactUrl)).status, 401);
          assert.equal(
            (await fetch(artifactUrl, { headers: { Authorization: `Bearer ${token}` } })).status,
            200,
          );
          await runRemoteSkills(
            [
              "verify",
              privateOrigin.origin,
              "--scope",
              "engineering",
              "--header-env",
              "Authorization=SKILLS_AUTH",
            ],
            { env: { SKILLS_AUTH: `Bearer ${token}` } },
          );

          const invalidToken = randomUUID();
          const authenticationFailure = await run(process.execPath, [consumer], {
            env: environment(consumerOrigin, invalidToken, cacheRoot),
            allowFailure: true,
          });
          assert.equal(authenticationFailure.code, 1);
          assert.equal(parseDiagnosticCode(authenticationFailure.stderr), "authentication_failed");
          const authorizationFailure = await run(process.execPath, [consumer], {
            env: {
              ...environment(consumerOrigin, token, cacheRoot),
              REMOTE_SKILLS_SCOPE: "sales",
            },
            allowFailure: true,
          });
          assert.equal(authorizationFailure.code, 1);
          assert.equal(parseDiagnosticCode(authorizationFailure.stderr), "authorization_denied");
          const failureOutput = `${authenticationFailure.stdout}${authenticationFailure.stderr}${authorizationFailure.stdout}${authorizationFailure.stderr}`;
          assert.ok(!failureOutput.includes(token));
          assert.ok(!failureOutput.includes(invalidToken));
        },
      );

      await context.test(
        "TypeScript and Python select the highest-compatible release with matching verified data",
        async () => {
          const sharedEnvironment = environment(consumerOrigin, token, cacheRoot);
          const typescript = await run(process.execPath, [consumer], { env: sharedEnvironment });
          const python = await run(
            installedPython ?? process.execPath,
            installedPython
              ? ["-I", resolve(exampleRoot, "consumers/python/main.py")]
              : [
                  resolve(import.meta.dirname, "helpers/run-python.ts"),
                  resolve(exampleRoot, "consumers/python/main.py"),
                ],
            { env: sharedEnvironment },
          );
          const typescriptResult = parseConsumerResult(typescript.stdout.trim());
          const pythonResult = parseConsumerResult(python.stdout.trim());
          assert.equal(typescriptResult.version, "1.4.7");
          assert.equal(pythonResult.version, "1.4.7");
          assert.equal(typescriptResult.digest, pythonResult.digest);
          assert.equal(typescriptResult.confirmedScope, "engineering");
          assert.equal(pythonResult.confirmedScope, "engineering");
          assert.deepEqual(typescriptResult.resources, pythonResult.resources);
        },
      );
    } finally {
      await privateOrigin.close();
    }
    process.stdout.write("example smoke passed\n");
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

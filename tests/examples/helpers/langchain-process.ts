import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { resolveCompatibleUvCommand } from "../../../scripts/lib/uv-command.ts";
import {
  assertLockedIntegrationResolution,
  writeLockedIntegrationProject,
} from "../../../scripts/release/integration-dependencies.ts";
import { DUMMY_KEY, MODEL, object, type SkillFixture } from "./langchain-model.ts";
import {
  installCommand,
  installNpm,
  installPython,
  type PackageSource,
  packageSource,
  pythonSelections,
} from "./package-source.ts";
import { runRemoteSkills } from "./public-cli.ts";
import { createStaticOriginHandler, staticResourceKind } from "./static-host.ts";
import { reservePort, until } from "./vercel-ai-sdk-process.ts";

const repository = resolve(import.meta.dirname, "../../..");
const example = resolve(repository, "examples/langchain");

export interface OriginRequest {
  pathname: string;
  completed: boolean;
  length: number;
  status: number;
}

type WriteCallback = (error: Error | null | undefined) => void;

class CountedOriginResponse extends ServerResponse {
  bodyBytes = 0;

  override write(
    chunk: unknown,
    encodingOrCallback?: BufferEncoding | WriteCallback,
    callback?: WriteCallback,
  ): boolean {
    assert.ok(typeof chunk === "string" || chunk instanceof Uint8Array);
    this.bodyBytes +=
      typeof chunk === "string"
        ? Buffer.byteLength(
            chunk,
            typeof encodingOrCallback === "string" ? encodingOrCallback : "utf8",
          )
        : chunk.byteLength;
    return typeof encodingOrCallback === "string"
      ? super.write(chunk, encodingOrCallback, callback)
      : super.write(chunk, encodingOrCallback);
  }
}

export function langchainCandidates(source: PackageSource): PackageSource {
  const npmNames = ["@remote-skills/cli", "@remote-skills/client", "@remote-skills/langchain"];
  const pythonNames = ["remote-skills", "remote-skills-langchain"];
  const npm = source.npm.filter((entry) => npmNames.includes(entry.name));
  const python = pythonSelections(source).filter((entry) => pythonNames.includes(entry.name));
  assert.deepEqual(
    npm.map((entry) => entry.name).sort(),
    [...npmNames].sort(),
    "The LangChain consumer requires explicit CLI, SDK, and TypeScript adapter candidates.",
  );
  assert.deepEqual(
    python.map((entry) => entry.name).sort(),
    [...pythonNames].sort(),
    "The LangChain consumer requires distinct Python SDK and adapter candidates.",
  );
  assert.ok(
    [...npm, ...python].every((entry) => isAbsolute(entry.spec)),
    "The LangChain candidate consumer accepts exact local archives only.",
  );
  return { npm, python };
}

async function installCandidates(root: string, app: string, source: PackageSource) {
  const manifest = await readFile(resolve(app, "package.json"), "utf8");
  writeLockedIntegrationProject(repository, app, "examples/langchain");
  await installNpm(app, source, manifest);
  assertLockedIntegrationResolution(
    repository,
    app,
    source.npm.map((entry) => entry.spec),
  );
  const requirements = await installCommand(
    resolveCompatibleUvCommand(),
    [
      "export",
      "--locked",
      "--package",
      "remote-skills-langchain-example",
      "--no-emit-workspace",
      "--no-header",
      "--no-annotate",
      "--no-hashes",
    ],
    repository,
  );
  const requirementsFile = resolve(root, "locked-python-runtime.txt");
  await writeFile(requirementsFile, requirements);
  await installPython(root, source, { requirementsFile });
}

export async function prepareExample() {
  const selected = await packageSource();
  const candidates = selected ? langchainCandidates(selected) : undefined;
  // Local mode shares pnpm's workspace ancestor; candidate mode owns external installs.
  const scratch = candidates ? tmpdir() : resolve(repository, "dist");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(resolve(scratch, "langchain-browser-"));
  const app = resolve(root, "examples/langchain");
  const clean = () => rm(root, { recursive: true, force: true });
  try {
    await mkdir(app, { recursive: true });
    for (const path of [
      "app",
      "server",
      "skills",
      "package.json",
      "next.config.ts",
      "tsconfig.json",
    ]) {
      await cp(resolve(example, path), resolve(app, path), {
        recursive: true,
        filter: (source) => !source.split(/[\\/]/u).includes("dist"),
      });
    }
    await cp(resolve(repository, "tsconfig.base.json"), resolve(root, "tsconfig.base.json"));
    if (candidates) {
      await installCandidates(root, app, candidates);
    } else {
      for (const [source, target] of [
        [resolve(example, "node_modules"), resolve(app, "node_modules")],
        [resolve(repository, "node_modules"), resolve(root, "node_modules")],
        [resolve(repository, ".venv"), resolve(root, ".venv")],
      ]) {
        assert.ok(source && target);
        await symlink(source, target, process.platform === "win32" ? "junction" : "dir");
      }
    }
    const markdown = await readFile(resolve(app, "skills/source/greeting/SKILL.md"), "utf8");
    const resource = await readFile(
      resolve(app, "skills/source/greeting/references/greeting.md"),
      "utf8",
    );
    const description = /^description: (.+)$/mu.exec(markdown)?.[1];
    assert.ok(description);
    assert.ok(
      markdown.includes("references/greeting.md") && resource.includes("Ahoy, curious human!"),
      "The authored instruction and resource fixture retain their independent contract.",
    );
    const skill: SkillFixture = { markdown, resource, description };
    if (candidates) {
      await installCommand(
        process.execPath,
        [resolve(app, "node_modules/@remote-skills/cli/dist/cli.js"), "build"],
        resolve(app, "skills"),
      );
    } else {
      await runRemoteSkills(["build"], { cwd: resolve(app, "skills") });
    }
    const dist = resolve(app, "skills/dist");
    const value: unknown = JSON.parse(
      await readFile(resolve(dist, ".well-known/agent-skills/index.json"), "utf8"),
    );
    const catalog = object(value);
    assert.ok(Array.isArray(catalog.skills) && catalog.skills.length === 1);
    const entry = object(catalog.skills[0]);
    assert.equal(entry.type, "archive");
    assert.equal(typeof entry.url, "string");
    assert.ok(typeof entry.digest === "string");
    const artifactPath = `/.well-known/agent-skills/${String(entry.url)}`;
    assert.equal(staticResourceKind(artifactPath), "artifact");
    const artifact = await readFile(resolve(dist, `.${artifactPath}`));
    assert.ok(
      entry.digest === `sha256:${createHash("sha256").update(artifact).digest("hex")}`,
      "The published catalog identifies the exact whole archive bytes.",
    );
    return { app, dist, skill, artifactPath, artifactLength: artifact.length, clean };
  } catch (error) {
    await clean();
    throw error;
  }
}

export async function startOrigin(root: string) {
  const requests: OriginRequest[] = [];
  const failures: string[] = [];
  const handler = createStaticOriginHandler({ root });
  const server = createServer({ ServerResponse: CountedOriginResponse }, (request, response) => {
    const entry: OriginRequest = {
      pathname: request.url ?? "",
      completed: false,
      length: 0,
      status: 0,
    };
    requests.push(entry);
    response.once("finish", () => {
      entry.completed = true;
      // The real static handler pipes original file bytes through response.write.
      entry.length = response.bodyBytes;
      entry.status = response.statusCode;
    });
    if (request.headers.authorization !== undefined || request.headers.range !== undefined) {
      failures.push("Skill origin received unexpected credentials or a partial-artifact request.");
      response.writeHead(400).end();
      return;
    }
    void handler(request, response).catch(() => {
      failures.push("The local published origin failed to serve its exact bytes.");
      response.destroy();
    });
  });
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      done();
    });
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    artifacts: () =>
      requests.filter((entry) => staticResourceKind(entry.pathname) === "artifact").length,
    assertHealthy: () => assert.equal(failures.length, 0, failures.join("\n")),
    async close() {
      server.closeAllConnections();
      await new Promise<void>((done, reject) =>
        server.close((error) => (error ? reject(error) : done())),
      );
    },
  };
}

export async function startNext(app: string, origin: string, model: string) {
  const reservation = await reservePort();
  const port = reservation.port;
  await reservation.close();
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (
      /^(?:OPENAI_|ANTHROPIC_|LANGCHAIN_|LANGSMITH_|REMOTE_SKILLS_|NEXT_PUBLIC_)/u.test(key) ||
      /^(?:https?|all)_proxy$/iu.test(key) ||
      ["NODE_OPTIONS", "NODE_PATH", "PYTHONPATH", "VIRTUAL_ENV", "UV_PROJECT_ENVIRONMENT"].includes(
        key,
      )
    )
      delete env[key];
  }
  Object.assign(env, {
    OPENAI_API_KEY: DUMMY_KEY,
    OPENAI_MODEL: MODEL,
    OPENAI_BASE_URL: model,
    REMOTE_SKILLS_ORIGIN: origin,
    REMOTE_SKILLS_EXAMPLE_TEST: "1",
    LANGSMITH_TRACING: "false",
    LANGCHAIN_TRACING: "false",
    LANGCHAIN_TRACING_V2: "false",
    NEXT_TELEMETRY_DISABLED: "1",
    NO_PROXY: "127.0.0.1,localhost,::1",
    no_proxy: "127.0.0.1,localhost,::1",
    PYTHONNOUSERSITE: "1",
  });
  const child = spawn(
    process.execPath,
    [
      resolve(app, "node_modules/next/dist/bin/next"),
      "dev",
      "--webpack",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(port),
    ],
    {
      cwd: app,
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8").on("data", (chunk: string) => {
      output = (output + chunk).slice(-64 * 1024);
    });
  }
  const exited = new Promise<void>((done, reject) => {
    child.once("error", reject);
    child.once("close", done);
  });
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    let timer: NodeJS.Timeout | undefined;
    try {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        timer = setTimeout(() => child.kill("SIGKILL"), 8_000);
      }
      await exited;
      assert.ok(
        !output.includes(DUMMY_KEY),
        "The dummy credential never appears in Next process logs.",
      );
    } finally {
      clearTimeout(timer);
    }
  };
  const url = `http://127.0.0.1:${port}`;
  try {
    await until(
      async () => {
        assert.ok(
          child.exitCode === null && child.signalCode === null,
          "The real Next process stays alive during startup.",
        );
        try {
          const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
          await response.body?.cancel();
          return response.ok;
        } catch {
          return false;
        }
      },
      "real LangChain Next page readiness",
      90_000,
    );
    return { url, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

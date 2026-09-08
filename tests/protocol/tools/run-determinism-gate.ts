import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import {
  jsonArray,
  jsonNumber,
  jsonObject,
  jsonString,
  jsonValue,
} from "../helpers/contract-helpers.ts";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "../../..");
const protocolRoot = resolve(repositoryRoot, "tests/protocol");
const publisherRoot = resolve(protocolRoot, "fixtures/publisher");
const expectedPath = resolve(protocolRoot, "expected-results/publisher-activation-results.json");
const cliPath = resolve(repositoryRoot, "packages/cli/dist/cli.js");
const typescriptProbe = resolve(protocolRoot, "tools/consume-built-origin.ts");
const pythonProbe = resolve(protocolRoot, "tools/consume_built_origin.py");
const pythonProject = resolve(repositoryRoot, "packages/sdk-python");

interface PublisherFormat {
  cli: "tar.gz" | "zip";
  fixture: "tar-gzip" | "zip";
}

interface PublisherDescriptorItem {
  bytes: number;
  path: string;
  sha256: string;
}

interface ProbeInput {
  cache: "off" | "on";
  cacheDirectory: string;
  format: PublisherFormat;
  language: "python" | "typescript";
  origin: string;
}

type ByteMap = Map<string, Buffer>;

function decodeDescriptor(value: unknown, label: string): PublisherDescriptorItem {
  const descriptor = jsonObject(value, label);
  return {
    bytes: jsonNumber(jsonValue(descriptor, "bytes", label), `${label}.bytes`),
    path: jsonString(jsonValue(descriptor, "path", label), `${label}.path`),
    sha256: jsonString(jsonValue(descriptor, "sha256", label), `${label}.sha256`),
  };
}

function decodePublisherResults(value: unknown) {
  const results = jsonObject(value, "publisher results");
  const rawFormats = jsonObject(
    jsonValue(results, "formats", "publisher results"),
    "publisher results.formats",
  );
  const formats: {
    [format: string]: { artifacts: PublisherDescriptorItem[]; index: PublisherDescriptorItem };
  } = {};
  for (const [format, value_] of Object.entries(rawFormats)) {
    const label = `publisher results.formats.${format}`;
    const descriptor = jsonObject(value_, label);
    formats[format] = {
      artifacts: jsonArray(jsonValue(descriptor, "artifacts", label), `${label}.artifacts`).map(
        (item, index) => decodeDescriptor(item, `${label}.artifacts[${index}]`),
      ),
      index: decodeDescriptor(jsonValue(descriptor, "index", label), `${label}.index`),
    };
  }
  return { formats };
}

function decodeProbeSummary(value: unknown) {
  const summary = jsonObject(value, "probe summary");
  const cache = jsonString(jsonValue(summary, "cache", "probe summary"), "probe summary.cache");
  const language = jsonString(
    jsonValue(summary, "language", "probe summary"),
    "probe summary.language",
  );
  if (cache !== "off" && cache !== "on")
    throw new TypeError("probe summary.cache must be off or on");
  if (language !== "python" && language !== "typescript")
    throw new TypeError("probe summary.language is unsupported");
  return {
    cache,
    language,
    passes: jsonNumber(jsonValue(summary, "passes", "probe summary"), "probe summary.passes"),
  };
}

const FORMATS: readonly Readonly<PublisherFormat>[] = Object.freeze([
  Object.freeze({ cli: "tar.gz", fixture: "tar-gzip" }),
  Object.freeze({ cli: "zip", fixture: "zip" }),
]);

function sha256(bytes: NodeJS.ArrayBufferView): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function walkBytes(root: string, directory = root): Promise<ByteMap> {
  const files: ByteMap = new Map();
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      for (const [name, bytes] of await walkBytes(root, path)) files.set(name, bytes);
      continue;
    }
    assert.equal(entry.isFile(), true, `publisher output contains non-file entry ${path}`);
    files.set(relative(root, path).split(sep).join("/"), await readFile(path));
  }
  return new Map([...files].sort(([left], [right]) => left.localeCompare(right)));
}

async function buildCanonicalProject(root: string, format: PublisherFormat, run: string) {
  const project = resolve(root, `${format.fixture}-${run}`);
  await mkdir(project, { recursive: true });
  await cp(resolve(publisherRoot, "source/skills"), resolve(project, "skills"), {
    recursive: true,
  });
  const result = await execFileAsync(process.execPath, [cliPath, "build", "--format", format.cli], {
    cwd: project,
    env: process.env,
    maxBuffer: 1024 * 1024,
  });
  assert.equal(result.stderr, "", result.stderr);
  return resolve(project, "dist");
}

async function expectedOutput(format: PublisherFormat): Promise<ByteMap> {
  const results = decodePublisherResults(
    JSON.parse(
      await readFile(resolve(protocolRoot, "expected-results/publisher-results.json"), "utf8"),
    ),
  );
  const manifest = new Map<string, string>(
    (await readFile(resolve(protocolRoot, "manifests/publisher-goldens.sha256"), "utf8"))
      .trim()
      .split(/\r?\n/u)
      .map((line) => {
        const match = /^(?<digest>[0-9a-f]{64}) {2}(?<path>.+)$/u.exec(line);
        assert.ok(match?.groups, `invalid reviewed manifest line: ${line}`);
        const { digest, path } = match.groups;
        if (digest === undefined || path === undefined) {
          throw new Error(`invalid reviewed manifest line: ${line}`);
        }
        return [path, digest];
      }),
  );
  const descriptor = results.formats[format.cli];
  assert.ok(descriptor, `missing reviewed ${format.cli} publisher result`);
  const paths = [descriptor.index, ...descriptor.artifacts];
  const prefix = `fixtures/publisher/goldens/${format.fixture}/`;
  const output: ByteMap = new Map();
  for (const item of paths) {
    assert.equal(item.path.startsWith(prefix), true, `unexpected reviewed path ${item.path}`);
    const relativePath = item.path.slice(prefix.length);
    const bytes = await readFile(resolve(protocolRoot, item.path));
    assert.equal(bytes.byteLength, item.bytes, item.path);
    assert.equal(sha256(bytes), item.sha256, item.path);
    assert.equal(manifest.get(item.path), item.sha256, `${item.path} independent manifest`);
    output.set(relativePath, bytes);
  }
  return new Map([...output].sort(([left], [right]) => left.localeCompare(right)));
}

function assertExactOutput(actual: ByteMap, expected: ByteMap, label: string): void {
  assert.deepEqual([...actual.keys()], [...expected.keys()], `${label} output inventory`);
  for (const [path, expectedBytes] of expected) {
    const actualBytes = actual.get(path);
    assert.ok(actualBytes, `${label} is missing ${path}`);
    assert.equal(sha256(actualBytes), sha256(expectedBytes), `${label} hash for ${path}`);
    assert.deepEqual(actualBytes, expectedBytes, `${label} bytes for ${path}`);
  }
}

function contentType(path: string): string {
  if (path.endsWith("index.json")) return "application/json";
  if (path.endsWith(".md")) return "text/markdown; charset=utf-8";
  if (path.endsWith(".zip")) return "application/zip";
  if (path.endsWith(".tar.gz")) return "application/gzip";
  throw new Error(`no media type for ${path}`);
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((accept, reject) => {
    server.close((error) => (error ? reject(error) : accept()));
  });
}

async function serveOutput(outputDirectory: string) {
  const files = await walkBytes(outputDirectory);
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname.slice(1);
    requests.push(path);
    const bytes = files.get(path);
    if (request.method !== "GET" || bytes === undefined) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      "Cache-Control": "public, max-age=300",
      "Content-Length": bytes.byteLength,
      "Content-Type": contentType(path),
    });
    response.end(bytes);
  });
  await new Promise<void>((accept, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", accept);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string", "loopback server has no port");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requestPaths: () => [...requests],
    close: () => closeServer(server),
  };
}

async function runProbe({ language, origin, format, cache, cacheDirectory }: ProbeInput) {
  const common = [
    "--origin",
    origin,
    "--format",
    format.fixture,
    "--cache",
    cache,
    "--cache-dir",
    cacheDirectory,
    "--expected",
    expectedPath,
  ];
  const command =
    language === "typescript"
      ? { executable: process.execPath, arguments_: [typescriptProbe, ...common], env: process.env }
      : {
          executable: "uv",
          arguments_: [
            "run",
            "--project",
            pythonProject,
            "--locked",
            "--no-sync",
            "python",
            pythonProbe,
            ...common,
          ],
          env: process.env,
        };
  const result = await execFileAsync(command.executable, command.arguments_, {
    cwd: repositoryRoot,
    env: command.env,
    maxBuffer: 1024 * 1024,
  });
  assert.equal(result.stderr, "", result.stderr);
  const summary = decodeProbeSummary(JSON.parse(result.stdout));
  assert.deepEqual(summary, { language, cache, passes: 2 });
}

async function consumeOutput(
  outputDirectory: string,
  format: PublisherFormat,
  temporaryRoot: string,
  expected: ByteMap,
) {
  const catalogPath = ".well-known/agent-skills/index.json";
  const artifactPaths = [...expected.keys()].filter((path) => path !== catalogPath);
  assert.equal(artifactPaths.length, 2, "the reviewed format must have two artifacts");
  const server = await serveOutput(outputDirectory);
  try {
    for (const language of ["typescript", "python"] as const) {
      for (const cache of ["off", "on"] as const) {
        const before = server.requestPaths().length;
        await runProbe({
          language,
          origin: server.origin,
          format,
          cache,
          cacheDirectory: resolve(temporaryRoot, `cache-${format.fixture}-${language}-${cache}`),
        });
        // Each pass creates a new backend. Cache-v1 cannot preserve the response base
        // for relative catalogs, so both passes fetch the catalog even with disk caching.
        // Verified artifacts remain reusable across those backends.
        const expectedRequests = [
          catalogPath,
          catalogPath,
          ...artifactPaths,
          ...(cache === "off" ? artifactPaths : []),
        ];
        assert.deepEqual(
          server.requestPaths().slice(before).sort(),
          expectedRequests.sort(),
          `${format.cli}/${language}/cache-${cache} request paths`,
        );
      }
    }
  } finally {
    await server.close();
  }
}

async function main(): Promise<void> {
  if (process.argv.length === 3 && process.argv[2] === "--help") {
    process.stdout.write("Usage: node tests/protocol/tools/run-determinism-gate.ts\n");
    return;
  }
  if (process.argv.length !== 2) throw new Error("unsupported determinism-gate arguments");
  assert.equal(Number.parseInt(process.versions.node, 10) >= 24, true, "Node.js 24+ is required");

  const temporaryRoot = await mkdtemp(resolve(tmpdir(), "remote-skills-determinism-"));
  try {
    for (const format of FORMATS) {
      const expected = await expectedOutput(format);
      const firstDirectory = await buildCanonicalProject(temporaryRoot, format, "first");
      const secondDirectory = await buildCanonicalProject(temporaryRoot, format, "second");
      const first = await walkBytes(firstDirectory);
      const second = await walkBytes(secondDirectory);
      assertExactOutput(first, expected, `${format.cli} first build`);
      assertExactOutput(second, expected, `${format.cli} second build`);
      assertExactOutput(second, first, `${format.cli} cross-run`);
      await consumeOutput(
        firstDirectory,
        format,
        resolve(temporaryRoot, `${format.fixture}-first`),
        expected,
      );
      await consumeOutput(
        secondDirectory,
        format,
        resolve(temporaryRoot, `${format.fixture}-second`),
        expected,
      );
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
  process.stdout.write(
    `determinism gate passed on ${process.platform}: 2 formats, 2 builds, 16 SDK/cache probes\n`,
  );
}

await main();

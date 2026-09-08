import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import { createServer, request as httpRequest } from "node:http";
import { join, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  requestWithPolicy as cliRequestWithPolicy,
  normalizeVerifyOrigin,
} from "../../../packages/cli/src/network.ts";
import type { CatalogCacheValue } from "../../../packages/cli/src/verify.ts";
import { runVerifyCommand } from "../../../packages/cli/src/verify.ts";
import { DiskCache } from "../../../packages/sdk-typescript/src/cache/disk-cache.ts";
import { requestWithPolicy as typescriptRequestWithPolicy } from "../../../packages/sdk-typescript/src/catalog/http.ts";
import type {
  ResolvedAddress,
  ResolveHost,
} from "../../../packages/sdk-typescript/src/catalog/network-policy.ts";
import type { SanitizedRequest } from "../../../packages/sdk-typescript/src/catalog/redaction.ts";
import { sanitizeRequest } from "../../../packages/sdk-typescript/src/catalog/redaction.ts";
import type {
  HttpTransport,
  TransportRequest,
  TransportResponse,
} from "../../../packages/sdk-typescript/src/catalog/transport.ts";
import {
  defaultResolveHost,
  defaultTransport,
} from "../../../packages/sdk-typescript/src/catalog/transport.ts";
import type { NormalizedOrigin } from "../../../packages/sdk-typescript/src/origin.ts";
import { normalizeOrigins } from "../../../packages/sdk-typescript/src/origin.ts";
import { createRemoteSkills } from "../../../packages/sdk-typescript/src/session/client.ts";
import type { RemoteSkillsSession } from "../../../packages/sdk-typescript/src/session/types.ts";

type RuntimeName = "cli" | "typescript";

interface RequestRecord {
  readonly path: string;
  readonly credential: "cdn" | "none" | "origin";
}

interface LocalServer {
  readonly port: number;
  readonly requests: RequestRecord[];
  close(): Promise<void>;
}

interface RequestInvocationOptions {
  readonly cdnHeaders?: boolean;
  readonly maxBytes?: number;
  readonly onAttempt?: () => void;
  readonly resolve?: ResolveHost;
  readonly retries?: number;
  readonly timeoutMs?: number;
}

interface ErrorSinkPayload {
  readonly rendered: string;
  readonly diagnostic?: unknown;
}

interface TemporaryFileObservation {
  readonly observations: number;
  readonly files: number;
  readonly secret_occurrences: number;
}

const runtimeArgument = process.argv[2];
const outputDirectoryArgument = process.argv[3];
const probeLeak = process.argv[4] === "--probe-leak";
const secret = readFileSync(0, "utf8");
if (
  (runtimeArgument !== "cli" && runtimeArgument !== "typescript") ||
  !outputDirectoryArgument ||
  !secret ||
  process.argv.length > 5 ||
  (process.argv[4] !== undefined && !probeLeak)
) {
  throw new Error("usage: node-runtime-gate.ts <cli|typescript> <output-directory> [--probe-leak]");
}
const runtimeName: RuntimeName = runtimeArgument;
const outputDirectory = outputDirectoryArgument;

const secretEncodings = [
  Buffer.from(secret),
  Buffer.from(Buffer.from(secret).toString("base64")),
  Buffer.from(Buffer.from(secret).toString("hex")),
];
const observedSinkPayloads = new Set<string>();
const sanitizedRequestEvidence: SanitizedRequest[] = [];
let leakProbeDetected = false;
let liveTemporaryFiles: TemporaryFileObservation | null = null;

const skill = Buffer.from(
  "---\nname: fixture-skill\ndescription: Fixture skill.\n---\n# Fixture\n",
);
const digest = `sha256:${createHash("sha256").update(skill).digest("hex")}`;

function catalogBytes(artifactUrl = "/artifact.md"): Buffer {
  return Buffer.from(
    `${JSON.stringify({
      $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
      skills: [
        {
          name: "fixture-skill",
          description: "Fixture skill.",
          type: "skill-md",
          url: artifactUrl,
          digest,
        },
      ],
    })}\n`,
  );
}

function credentialMarker(headers: IncomingHttpHeaders): RequestRecord["credential"] {
  if (headers.authorization === secret) return "origin";
  if (headers["x-cdn-token"] === secret) return "cdn";
  return "none";
}

function listen(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<LocalServer> {
  const requests: RequestRecord[] = [];
  const server = createServer((request, response) => {
    requests.push({
      path: new URL(request.url ?? "/", "http://local.invalid").pathname,
      credential: credentialMarker(request.headers),
    });
    handler(request, response);
  });
  return new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("local adversarial origin did not expose a TCP port"));
        return;
      }
      resolveListen({
        port: address.port,
        requests,
        close: () => new Promise<void>((resolveClose) => server.close(() => resolveClose())),
      });
    });
  });
}

function localTransport(port: number): HttpTransport {
  return (input: TransportRequest) =>
    new Promise<TransportResponse>((resolveRequest, reject) => {
      const target = new URL(input.url);
      const request = httpRequest(
        {
          host: "127.0.0.1",
          port,
          method: "GET",
          path: `${target.pathname}${target.search}`,
          headers: input.headers,
          signal: input.signal,
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("error", reject);
          response.on("end", () => {
            const headers: Record<string, string> = {};
            for (const [name, value] of Object.entries(response.headers)) {
              if (typeof value === "string") headers[name] = value;
              else if (Array.isArray(value)) headers[name] = value.join(", ");
            }
            resolveRequest({
              status: response.statusCode ?? 0,
              headers,
              body: Buffer.concat(chunks),
            });
          });
        },
      );
      request.on("error", reject);
      request.end();
    });
}

function terminalCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const code = Reflect.get(error, "code");
  return typeof code === "string" ? code : null;
}

const errorEvidence: ErrorSinkPayload[] = [];

function encodedSecretOccurrences(value: string | Uint8Array): number {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  let count = 0;
  for (const encoding of secretEncodings) {
    let offset = bytes.indexOf(encoding);
    while (offset >= 0) {
      count += 1;
      offset = bytes.indexOf(encoding, offset + 1);
    }
  }
  return count;
}

function rejectLeakProbe(): never {
  leakProbeDetected = true;
  throw new Error("network leak probe detected");
}

function observeSink<Value>(name: string, payload: Value): Value {
  if (encodedSecretOccurrences(JSON.stringify(payload)) > 0) rejectLeakProbe();
  observedSinkPayloads.add(name);
  return payload;
}

function errorSinkPayload(error: unknown): ErrorSinkPayload {
  let diagnostic: unknown;
  if (error && typeof error === "object") {
    const toDiagnostic = Reflect.get(error, "toDiagnostic");
    if (typeof toDiagnostic === "function") diagnostic = Reflect.apply(toDiagnostic, error, []);
  }
  return {
    rendered: String(error),
    ...(diagnostic === undefined ? {} : { diagnostic }),
  };
}

function recordError(error: unknown): string | null {
  const payload = observeSink("error", errorSinkPayload(error));
  if (payload.diagnostic !== undefined) observeSink("diagnostic", payload.diagnostic);
  errorEvidence.push(payload);
  return terminalCode(error);
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

async function countPersistedSecret(directory: string): Promise<number> {
  let count = 0;
  for (const path of await filesBelow(directory)) {
    count += encodedSecretOccurrences(path);
    count += encodedSecretOccurrences(await readFile(path));
  }
  return count;
}

async function observeLiveTemporaryDirectory(directory: string): Promise<void> {
  const paths = await filesBelow(directory);
  const secretOccurrences = paths.reduce(
    (count, path) =>
      count +
      encodedSecretOccurrences(relative(directory, path)) +
      encodedSecretOccurrences(readFileSync(path)),
    0,
  );
  liveTemporaryFiles = {
    observations: 1,
    files: paths.length,
    secret_occurrences: secretOccurrences,
  };
  if (secretOccurrences > 0) rejectLeakProbe();
  observeSink("temp", liveTemporaryFiles);
}

async function observeStoredDirectory(name: string, directory: string) {
  const paths = await filesBelow(directory);
  let secretOccurrences = 0;
  for (const path of paths) {
    secretOccurrences += encodedSecretOccurrences(relative(directory, path));
    secretOccurrences += encodedSecretOccurrences(await readFile(path));
  }
  if (secretOccurrences > 0) rejectLeakProbe();
  observedSinkPayloads.add(name);
  return {
    files: paths.map((path) => relative(directory, path)).sort(),
    secret_occurrences: secretOccurrences,
  };
}

const proxyOrigin = await listen((request, response) => {
  const path = new URL(request.url ?? "/", "http://local.invalid").pathname;
  if (path === "/same/0") response.writeHead(302, { location: "/same/1" });
  else if (path === "/same/1") response.writeHead(302, { location: "/same/2" });
  else if (path === "/cross/0")
    response.writeHead(302, { location: "https://cdn.example.test/cross/1" });
  else if (path.startsWith("/overflow/")) {
    const hop = Number(path.split("/").at(-1));
    response.writeHead(302, { location: `/overflow/${hop + 1}` });
  } else if (path === "/rebind") {
    request.socket.destroy();
    return;
  } else response.writeHead(200, { "content-type": "application/octet-stream" });
  response.end("ok");
});
const proxyCdn = await listen((_request, response) => {
  response.writeHead(200, { "content-type": "application/octet-stream" });
  response.end("ok");
});

const loopback = await listen((request, response) => {
  const path = new URL(request.url ?? "/", "http://local.invalid").pathname;
  if (path === "/body") {
    response.writeHead(200, { "content-length": "4096" });
    response.end();
    return;
  }
  if (path === "/timeout") {
    setTimeout(() => {
      if (!response.destroyed) {
        response.writeHead(200);
        response.end("late");
      }
    }, 80);
    return;
  }
  if (path === "/retry") {
    response.writeHead(503);
    response.end();
    return;
  }
  if (path === "/.well-known/agent-skills/index.json") {
    response.writeHead(200, {
      "cache-control": "max-age=300",
      "content-type": "application/json",
      "remote-skills-scope": "engineering",
    });
    response.end(catalogBytes());
    return;
  }
  if (path === "/artifact.md") {
    response.writeHead(200, { "content-type": "text/markdown" });
    response.end(skill);
    return;
  }
  response.writeHead(200);
  response.end("ok");
});

const publicAddress: readonly ResolvedAddress[] = [{ address: "93.184.216.34", family: 4 }];
const originTransport = localTransport(proxyOrigin.port);
const cdnTransport = localTransport(proxyCdn.port);
const loopbackTransport = localTransport(loopback.port);
const proxyTransport: HttpTransport = (input) => {
  const target = new URL(input.url);
  if (runtimeName === "typescript") {
    sanitizedRequestEvidence.push(
      sanitizeRequest(
        target,
        input.headers,
        target.hostname === "cdn.example.test" ? ["x-cdn-token"] : [],
      ),
    );
  }
  return target.hostname === "cdn.example.test" ? cdnTransport(input) : originTransport(input);
};

function cliOrigin(options: RequestInvocationOptions = {}) {
  return normalizeVerifyOrigin("https://skills.example.test", {
    headers: { authorization: secret },
    retries: options.retries ?? 0,
    timeoutMs: options.timeoutMs ?? 1_000,
  });
}

function typescriptOrigin(options: RequestInvocationOptions = {}): NormalizedOrigin {
  const origin = normalizeOrigins({
    acme: {
      url: "https://skills.example.test",
      headers: { authorization: secret },
      ...(options.cdnHeaders
        ? { artifactHeaders: { "cdn.example.test": { "x-cdn-token": secret } } }
        : {}),
      retries: options.retries ?? 0,
      timeoutMs: options.timeoutMs ?? 1_000,
    },
  }).get("acme");
  if (!origin) throw new Error("missing normalized TypeScript origin");
  return origin;
}

async function invokeHttps(path: string, options: RequestInvocationOptions = {}) {
  if (runtimeName === "cli") {
    return cliRequestWithPolicy(
      {
        url: new URL(`https://skills.example.test${path}`),
        origin: cliOrigin(options),
        purpose: "artifact",
        accept: "application/octet-stream",
        maxBytes: options.maxBytes ?? 1_024,
      },
      {
        resolve: options.resolve ?? (async () => publicAddress),
        transport: proxyTransport,
        sleep: async () => {},
        random: () => 0,
      },
    );
  }
  const origin = typescriptOrigin(options);
  const requestRuntime = {
    resolve: options.resolve ?? (async () => publicAddress),
    transport: proxyTransport,
    sleep: async () => {},
    random: () => 0,
    now: () => 0,
  };
  return typescriptRequestWithPolicy(
    {
      url: new URL(`https://skills.example.test${path}`),
      origin,
      purpose: "artifact",
      accept: "application/octet-stream",
      maxBytes: options.maxBytes ?? 1_024,
    },
    requestRuntime,
  );
}

function cliLoopbackOrigin(options: RequestInvocationOptions = {}) {
  const url = `http://127.0.0.1:${loopback.port}`;
  return normalizeVerifyOrigin(url, {
    headers: { authorization: secret },
    retries: options.retries ?? 0,
    timeoutMs: options.timeoutMs ?? 1_000,
  });
}

function typescriptLoopbackOrigin(options: RequestInvocationOptions = {}): NormalizedOrigin {
  const url = `http://127.0.0.1:${loopback.port}`;
  const origin = normalizeOrigins({
    local: {
      url,
      headers: { authorization: secret },
      allowLoopbackHttp: true,
      retries: options.retries ?? 0,
      timeoutMs: options.timeoutMs ?? 1_000,
    },
  }).get("local");
  if (!origin) throw new Error("missing normalized loopback origin");
  return origin;
}

async function invokeLoopback(path: string, options: RequestInvocationOptions = {}) {
  const trackedTransport: HttpTransport = async (input) => {
    options.onAttempt?.();
    return loopbackTransport(input);
  };
  if (runtimeName === "cli") {
    const origin = cliLoopbackOrigin(options);
    return cliRequestWithPolicy(
      {
        url: new URL(`${origin.originUrl.origin}${path}`),
        origin,
        purpose: "artifact",
        accept: "application/octet-stream",
        maxBytes: options.maxBytes ?? 1_024,
      },
      options.onAttempt ? { transport: trackedTransport } : {},
    );
  }
  const origin = typescriptLoopbackOrigin(options);
  return typescriptRequestWithPolicy(
    {
      url: new URL(`${origin.originUrl.origin}${path}`),
      origin,
      purpose: "artifact",
      accept: "application/octet-stream",
      maxBytes: options.maxBytes ?? 1_024,
    },
    {
      now: () => 0,
      random: () => 0,
      sleep: async () => {},
      resolve: defaultResolveHost,
      transport: options.onAttempt ? trackedTransport : defaultTransport,
    },
  );
}

async function codeOf(operation: () => Promise<unknown>): Promise<string | null> {
  try {
    await operation();
    return null;
  } catch (error) {
    return recordError(error);
  }
}

async function configurationCode(value: string): Promise<string | null> {
  try {
    if (runtimeName === "cli") normalizeVerifyOrigin(value);
    else normalizeOrigins({ acme: { url: value } });
    return null;
  } catch (error) {
    return recordError(error);
  }
}

await mkdir(outputDirectory, { recursive: true });
try {
  const sameStart = proxyOrigin.requests.length;
  const multiHopCode = await codeOf(() => invokeHttps("/same/0"));
  const sameRecords = proxyOrigin.requests.slice(sameStart);

  const crossOriginStart = proxyOrigin.requests.length;
  const crossCdnStart = proxyCdn.requests.length;
  await invokeHttps("/cross/0");
  const crossRecords = [
    ...proxyOrigin.requests.slice(crossOriginStart),
    ...proxyCdn.requests.slice(crossCdnStart),
  ];

  const explicitStart = proxyCdn.requests.length;
  if (runtimeName === "cli") {
    await cliRequestWithPolicy(
      {
        url: new URL("https://cdn.example.test/explicit"),
        origin: cliOrigin(),
        purpose: "artifact",
        accept: "application/octet-stream",
        maxBytes: 1_024,
      },
      {
        resolve: async () => publicAddress,
        transport: proxyTransport,
        sleep: async () => {},
        random: () => 0,
      },
    );
  } else {
    const origin = typescriptOrigin({ cdnHeaders: true });
    await typescriptRequestWithPolicy(
      {
        url: new URL("https://cdn.example.test/explicit"),
        origin,
        purpose: "artifact",
        accept: "application/octet-stream",
        maxBytes: 1_024,
      },
      {
        now: () => 0,
        random: () => 0,
        sleep: async () => {},
        resolve: async () => publicAddress,
        transport: proxyTransport,
      },
    );
  }
  const explicitRecords = proxyCdn.requests.slice(explicitStart);

  const overflowStart = proxyOrigin.requests.length;
  const overflowCode = await codeOf(() => invokeHttps("/overflow/0"));
  const overflowRequests = proxyOrigin.requests.length - overflowStart;

  let resolutions = 0;
  const rebindingStart = proxyOrigin.requests.length;
  const rebindingCode = await codeOf(() =>
    invokeHttps("/rebind", {
      retries: 2,
      resolve: async () => {
        resolutions += 1;
        return resolutions === 1 ? publicAddress : [{ address: "127.0.0.1", family: 4 }];
      },
    }),
  );

  let loopbackRequests = 0;
  const loopbackCode = await codeOf(() =>
    invokeLoopback("/ok", { onAttempt: () => (loopbackRequests += 1) }),
  );

  const bodyStart = loopback.requests.length;
  const bodyCode = await codeOf(() => invokeLoopback("/body", { maxBytes: 32 }));
  const bodyRequests = loopback.requests.length - bodyStart;

  let timeoutRequests = 0;
  const timeoutCode = await codeOf(() =>
    invokeLoopback("/timeout", {
      retries: 1,
      timeoutMs: 15,
      onAttempt: () => (timeoutRequests += 1),
    }),
  );

  let retryRequests = 0;
  const retryCode = await codeOf(() =>
    invokeLoopback("/retry", {
      retries: 2,
      onAttempt: () => (retryRequests += 1),
    }),
  );

  const sanitization = {
    control: await configurationCode("https://skills.example.test\n"),
    query: await configurationCode(`https://skills.example.test?token=${secret}`),
    userinfo: await configurationCode(`https://user:${secret}@skills.example.test`),
  };

  const cacheDirectory = resolve(outputDirectory, "cache");
  if (runtimeName === "cli") {
    const catalogCache = {
      async get(): Promise<CatalogCacheValue | undefined> {
        return undefined;
      },
      async set(key: string, value: CatalogCacheValue): Promise<void> {
        const cachePayload = {
          key,
          body: Buffer.from(value.body).toString("base64"),
          url: value.url,
          etag: value.etag,
          lastModified: value.lastModified,
          ...(probeLeak ? { leak_probe: secret } : {}),
        };
        observeSink("cache", cachePayload);
        await writeFile(
          resolve(outputDirectory, "cli-catalog-cache.json"),
          JSON.stringify(cachePayload),
        );
      },
    };
    const verification = await runVerifyCommand(
      {
        args: [
          `http://127.0.0.1:${loopback.port}`,
          "--header-env",
          "Authorization=CLI_TEST_SECRET",
          "--scope",
          "engineering",
          "--retries=0",
        ],
        env: { CLI_TEST_SECRET: secret },
      },
      { catalogCache },
    );
    if (leakProbeDetected) rejectLeakProbe();
    observeSink("diagnostic", verification.failures);
    observeSink("snapshot", verification);
    await writeFile(
      resolve(outputDirectory, "diagnostic.json"),
      JSON.stringify(verification.failures),
    );
    await writeFile(resolve(outputDirectory, "snapshot.json"), JSON.stringify(verification));
  } else {
    const backgroundEvents: ErrorSinkPayload[] = [];
    let forceBackgroundError = false;
    const cache = new DiskCache({
      directory: cacheDirectory,
      leaseExpirySeconds: 2,
      renewIntervalSeconds: 1,
      now: () => (forceBackgroundError ? new Date(Number.NaN) : new Date()),
      onBackgroundError(error) {
        backgroundEvents.push(observeSink("event", errorSinkPayload(error)));
      },
      coordinationHooks: {
        async afterObjectStaging() {
          const temporaryRoot = resolve(cacheDirectory, "cache-v1", "tmp");
          const entries = await readdir(temporaryRoot, { withFileTypes: true });
          const writers = entries.filter(
            (entry) => entry.isDirectory() && entry.name.startsWith("writer-typescript-"),
          );
          if (writers.length !== 1) {
            throw new Error("expected one active TypeScript cache writer");
          }
          const writer = writers[0];
          if (!writer) throw new Error("missing active TypeScript cache writer");
          const writerDirectory = resolve(temporaryRoot, writer.name);
          if (probeLeak) await writeFile(resolve(writerDirectory, "leak-probe"), secret);
          await observeLiveTemporaryDirectory(writerDirectory);
        },
      },
    });
    const client = createRemoteSkills({
      origins: {
        local: {
          url: `http://127.0.0.1:${loopback.port}`,
          headers: { authorization: secret },
          scope: "engineering",
          allowLoopbackHttp: true,
          retries: 0,
        },
      },
      cache,
    });
    let session: RemoteSkillsSession;
    try {
      session = await client.session("local");
      await session.activate("fixture-skill");
      forceBackgroundError = true;
      const eventDeadline = Date.now() + 2_000;
      while (backgroundEvents.length === 0 && Date.now() < eventDeadline) await delay(5);
      forceBackgroundError = false;
      if (backgroundEvents.length === 0) {
        throw new Error("TypeScript background error sink was not observed");
      }
      await session.close();
    } catch (error) {
      if (leakProbeDetected) rejectLeakProbe();
      throw error;
    }
    observeSink("snapshot", session.metadata);
    observeSink("debug", sanitizedRequestEvidence);
    observeSink("event", backgroundEvents);
    const cacheObservation = await observeStoredDirectory("cache", cacheDirectory);
    await writeFile(
      resolve(outputDirectory, "cache-observation.json"),
      JSON.stringify(cacheObservation),
    );
    const diagnostics = errorEvidence.flatMap((payload) =>
      payload.diagnostic === undefined ? [] : [payload.diagnostic],
    );
    observeSink("diagnostic", diagnostics);
    await writeFile(resolve(outputDirectory, "diagnostic.json"), JSON.stringify(diagnostics));
    await writeFile(
      resolve(outputDirectory, "debug.json"),
      JSON.stringify(sanitizedRequestEvidence),
    );
    await writeFile(resolve(outputDirectory, "event.json"), JSON.stringify(backgroundEvents));
    await writeFile(resolve(outputDirectory, "snapshot.json"), JSON.stringify(session.metadata));
    await writeFile(
      resolve(outputDirectory, "temp-observation.json"),
      JSON.stringify(liveTemporaryFiles),
    );
  }

  const transcript = {
    origin: proxyOrigin.requests,
    cdn: proxyCdn.requests,
    loopback: loopback.requests,
  };
  observeSink("transcript", transcript);
  await writeFile(resolve(outputDirectory, "transcript.json"), JSON.stringify(transcript));
  await writeFile(resolve(outputDirectory, "error.json"), JSON.stringify(errorEvidence));

  const result = {
    runtime: runtimeName,
    headers: {
      same_host: sameRecords.map(({ credential }) => credential),
      cross_host: crossRecords.map(({ credential }) => credential),
      explicit_cross_host: explicitRecords.map(({ credential }) => credential),
    },
    redirects: {
      multi_hop: { code: multiHopCode, requests: sameRecords.length },
      overflow: { code: overflowCode, requests: overflowRequests },
    },
    rebinding: {
      code: rebindingCode,
      connection_requests: proxyOrigin.requests.length - rebindingStart,
      resolutions,
    },
    loopback: { code: loopbackCode, requests: loopbackRequests },
    sanitization,
    limits: {
      body: { code: bodyCode, requests: bodyRequests },
      retry_exhaustion: { code: retryCode, requests: retryRequests },
      timeout: { code: timeoutCode, requests: timeoutRequests },
    },
    observed_sink_payloads: [...observedSinkPayloads].sort(),
    live_temporary_files: liveTemporaryFiles,
    persisted_secret_occurrences: await countPersistedSecret(outputDirectory),
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  await Promise.all([proxyOrigin.close(), proxyCdn.close(), loopback.close()]);
}

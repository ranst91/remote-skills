import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { IncomingMessage, Server } from "node:http";
import { createServer } from "node:http";
import { resolve } from "node:path";
import {
  jsonArray,
  jsonObject,
  jsonString,
  jsonStringArray,
  jsonValue,
} from "../helpers/contract-helpers.ts";

const root = resolve(import.meta.dirname, "..");
interface RequestSnapshot {
  boundary: string;
  headers: { [name: string]: string | string[] | undefined };
  method: string | undefined;
  path: string;
  sensitive_header_names: string[];
}

function decodeRequestSnapshot(value: unknown, label: string): RequestSnapshot {
  const snapshot = jsonObject(value, label);
  const rawHeaders = jsonObject(jsonValue(snapshot, "headers", label), `${label}.headers`);
  const headers: { [name: string]: string | string[] | undefined } = {};
  for (const [name, header] of Object.entries(rawHeaders)) {
    headers[name] = Array.isArray(header)
      ? jsonStringArray(header, `${label}.headers.${name}`)
      : jsonString(header, `${label}.headers.${name}`);
  }
  return {
    boundary: jsonString(jsonValue(snapshot, "boundary", label), `${label}.boundary`),
    headers,
    method: jsonString(jsonValue(snapshot, "method", label), `${label}.method`),
    path: jsonString(jsonValue(snapshot, "path", label), `${label}.path`),
    sensitive_header_names: jsonStringArray(
      jsonValue(snapshot, "sensitive_header_names", label),
      `${label}.sensitive_header_names`,
    ),
  };
}

const parsedExpected: unknown = JSON.parse(
  readFileSync(resolve(root, "expected-results/network-request-results.json"), "utf8"),
);
const expectedDocument = jsonObject(parsedExpected, "network request results");
const expected = jsonArray(
  jsonValue(expectedDocument, "requests", "network request results"),
  "network request results.requests",
).map((request, index) =>
  decodeRequestSnapshot(request, `network request results.requests[${index}]`),
);
const safeHeaders = new Set(["accept", "if-modified-since", "if-none-match", "x-tenant"]);
const sensitiveHeaders = new Set([
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "x-cdn-token",
]);

function snapshotRequest(request: IncomingMessage, boundary: string): RequestSnapshot {
  const headers: { [name: string]: string | string[] | undefined } = {};
  const sensitive_header_names: string[] = [];
  for (const [name, value] of Object.entries(request.headers)) {
    const normalizedName = name.toLowerCase();
    if (safeHeaders.has(normalizedName)) headers[normalizedName] = value;
    if (sensitiveHeaders.has(normalizedName)) sensitive_header_names.push(normalizedName);
  }
  return {
    boundary,
    method: request.method,
    path: new URL(request.url ?? "/", "http://fixture.invalid").pathname,
    headers,
    sensitive_header_names: sensitive_header_names.sort(),
  };
}

function listen(server: Server): Promise<number> {
  return new Promise<number>((resolveListening, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("fixture server has no TCP port"));
        return;
      }
      resolveListening(address.port);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise<void>((resolveClosed, reject) => {
    server.close((error) => (error ? reject(error) : resolveClosed()));
  });
}

async function selfTest() {
  const snapshots: RequestSnapshot[] = [];
  const origin = createServer((request, response) => {
    snapshots.push(snapshotRequest(request, "origin"));
    if (request.headers["if-none-match"]) {
      response.writeHead(304);
      response.end();
      return;
    }
    response.writeHead(200, {
      "cache-control": "max-age=300",
      etag: '"catalog-v1"',
      "last-modified": "Tue, 25 Aug 2026 10:00:00 GMT",
    });
    response.end("{}\n");
  });
  const cdn = createServer((request, response) => {
    snapshots.push(snapshotRequest(request, "cdn"));
    response.writeHead(200, { "content-type": "text/markdown" });
    response.end("# fixture\n");
  });

  const [originPort, cdnPort] = await Promise.all([listen(origin), listen(cdn)]);
  const runtimeCanary = ["RMS", "SYNTHETIC", "SECRET", "CANARY", "8F0D2A7C"].join("_");
  const queryCanary = ["RMS", "QUERY", "SECRET", "CANARY", "20C91E44"].join("_");
  try {
    await fetch(`http://127.0.0.1:${originPort}/.well-known/agent-skills/index.json`, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${runtimeCanary}`,
        "x-tenant": "fixture-tenant",
      },
    });
    await fetch(`http://127.0.0.1:${originPort}/.well-known/agent-skills/index.json`, {
      headers: {
        accept: "application/json",
        "if-modified-since": "Tue, 25 Aug 2026 10:00:00 GMT",
        "if-none-match": '"catalog-v1"',
      },
    });
    await fetch(`http://127.0.0.1:${cdnPort}/artifacts/fixture-skill.md`, {
      headers: { accept: "text/markdown", "x-cdn-token": runtimeCanary },
    });
    await fetch(
      `http://127.0.0.1:${originPort}/query-secret?access_token=${queryCanary}#fragment-secret`,
      { headers: { accept: "application/json" } },
    );

    assert.deepEqual(snapshots, expected);
    assert.equal(JSON.stringify(snapshots).includes(runtimeCanary), false);
    assert.equal(JSON.stringify(snapshots).includes(queryCanary), false);
  } finally {
    await Promise.all([close(origin), close(cdn)]);
  }
  process.stdout.write(
    `fixture server verified ${snapshots.length} exact requests; secret snapshots 0\n`,
  );
}

if (process.argv[2] !== "--self-test") {
  throw new Error("usage: fixture-server.ts --self-test");
}

await selfTest();

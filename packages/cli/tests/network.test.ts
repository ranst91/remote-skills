import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import http, { IncomingMessage, type RequestOptions } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { Socket } from "node:net";
import path from "node:path";
import { test } from "node:test";

import { normalizeVerifyOrigin, type ResolvedAddress, requestWithPolicy } from "../src/network.ts";
import { parseVerifyArgs, runVerifyCommand } from "../src/verify.ts";
import { parseVerifyCatalog } from "../src/verify-catalog.ts";
import { PublisherVerifyError } from "../src/verify-errors.ts";

const secretCanary = "origin-secret-canary";

type TransportRequest = {
  url: string;
  headers: Record<string, string>;
  address: ResolvedAddress;
  signal: AbortSignal;
  maxBytes: number;
};
type JsonObject = { [key: string]: unknown };

function jsonObject(value: unknown, field: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return Object.fromEntries(Object.entries(value));
}

function hasVerifyCode(error: unknown, code: string): boolean {
  return error instanceof PublisherVerifyError && error.code === code;
}

function makeCatalog(url: string): Buffer {
  return Buffer.from(
    `${JSON.stringify({
      $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
      skills: [
        {
          name: "fixture-skill",
          description: "Fixture.",
          type: "skill-md",
          url,
          digest: `sha256:${"0".repeat(64)}`,
        },
      ],
    })}\n`,
  );
}

for (const status of [401, 403]) {
  for (const complete of [false, true]) {
    test(`terminal ${status} disposes a ${complete ? "complete" : "pending"} response body`, async (t) => {
      const socket = new Socket();
      const response = new IncomingMessage(socket);
      response.statusCode = status;
      response.push(Buffer.from("Access denied."));
      if (complete) response.push(null);
      const resume = t.mock.method(response, "resume");
      const request = t.mock.method(
        http,
        "request",
        (_url: URL, _options: RequestOptions, onResponse: (value: IncomingMessage) => void) =>
          Object.assign(new EventEmitter(), {
            end: () => onResponse(response),
          }),
      );
      syncBuiltinESMExports();
      try {
        const origin = normalizeVerifyOrigin("http://127.0.0.1", { retries: 2 });
        await assert.rejects(
          requestWithPolicy({
            url: origin.catalogUrl,
            origin,
            purpose: "catalog",
            accept: "application/json",
            maxBytes: 1024,
          }),
          (error) => {
            assert.ok(error instanceof PublisherVerifyError);
            assert.equal(
              error.code,
              status === 401 ? "authentication_failed" : "authorization_denied",
            );
            assert.deepEqual(error.context, { status });
            return true;
          },
        );
        assert.equal(request.mock.callCount(), 1);
        assert.equal(response.destroyed, true, "the operation owns response disposal");
        assert.equal(socket.destroyed, true, "the ignored body cannot retain its socket");
        assert.equal(resume.mock.callCount(), 0, "the ignored body is not drained");
      } finally {
        request.mock.restore();
        syncBuiltinESMExports();
        response.destroy();
        socket.destroy();
      }
    });
  }
}

test("cross-host CDN requests do not receive origin headers or scope", async () => {
  const requests: TransportRequest[] = [];
  const result = await runVerifyCommand(
    {
      args: [
        "https://skills.example.test",
        "--header",
        `Authorization=${secretCanary}`,
        "--scope",
        "engineering",
        "--retries=0",
      ],
    },
    {
      resolve: async (): Promise<readonly ResolvedAddress[]> => [
        { address: "93.184.216.34", family: 4 },
      ],
      transport: async (request) => {
        requests.push(request);
        if (request.url.includes("index.json")) {
          return {
            status: 200,
            headers: { "remote-skills-scope": "engineering" },
            body: makeCatalog("https://cdn.example.test/artifacts/fixture.md"),
          };
        }
        return { status: 200, headers: {}, body: Buffer.from("tampered") };
      },
      sleep: async () => {},
      random: () => 0,
    },
  );
  assert.equal(result.failures[0]?.code, "digest_mismatch");
  assert.equal(requests[0]?.headers.authorization, secretCanary);
  assert.equal(requests[0]?.headers["remote-skills-scope"], "engineering");
  assert.equal(requests[1]?.headers.authorization, undefined);
  assert.equal(requests[1]?.headers["remote-skills-scope"], undefined);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secretCanary, "u"));
});

test("a redirect to a private address is denied before a second connection", async () => {
  const requests: TransportRequest[] = [];
  await assert.rejects(
    requestWithPolicy(
      {
        url: new URL("https://skills.example.test/artifacts/start"),
        origin: normalizeVerifyOrigin("https://skills.example.test", {
          headers: { authorization: secretCanary },
        }),
        purpose: "artifact",
        accept: "text/markdown",
        maxBytes: 1024,
      },
      {
        resolve: async (hostname): Promise<readonly ResolvedAddress[]> =>
          hostname === "skills.example.test"
            ? [{ address: "93.184.216.34", family: 4 }]
            : [{ address: "127.0.0.1", family: 4 }],
        transport: async (request) => {
          requests.push(request);
          return {
            status: 302,
            headers: { location: "http://127.0.0.1/private" },
            body: new Uint8Array(),
          };
        },
        sleep: async () => {},
        random: () => 0,
      },
    ),
    (error) =>
      hasVerifyCode(error, "policy_denied") && !JSON.stringify(error).includes(secretCanary),
  );
  assert.equal(requests.length, 1);
});

test("header arguments reject duplicates and missing environment variables without leaking values", async () => {
  assert.throws(
    () =>
      parseVerifyArgs(
        [
          "https://skills.example.test",
          "--header",
          `Authorization=${secretCanary}`,
          "--header-env",
          "authorization=AUTH_TOKEN",
        ],
        { AUTH_TOKEN: "different-secret" },
      ),
    (error) =>
      hasVerifyCode(error, "configuration_invalid") &&
      error instanceof Error &&
      !error.message.includes(secretCanary),
  );
  assert.throws(
    () =>
      parseVerifyArgs(
        ["https://skills.example.test", "--header-env", "Authorization=MISSING_TOKEN"],
        {},
      ),
    (error) =>
      hasVerifyCode(error, "configuration_invalid") &&
      error instanceof Error &&
      /MISSING_TOKEN/u.test(error.message),
  );
});

test("Retry-After delta-seconds and HTTP-date delays are deterministic and capped", async () => {
  const origin = normalizeVerifyOrigin("https://skills.example.test", { retries: 1 });
  const retryCases: Array<readonly [string, number, number]> = [
    ["999", Date.parse("Wed, 21 Oct 2015 07:27:58 GMT"), 5_000],
    ["Wed, 21 Oct 2015 07:28:00 GMT", Date.parse("Wed, 21 Oct 2015 07:27:58 GMT"), 2_000],
  ];
  for (const [retryAfter, now, expectedDelay] of retryCases) {
    const delays: number[] = [];
    let attempts = 0;
    await requestWithPolicy(
      {
        url: new URL("https://skills.example.test/index.json"),
        origin,
        purpose: "catalog",
        accept: "application/json",
        maxBytes: 1024,
      },
      {
        now: () => now,
        resolve: async (): Promise<readonly ResolvedAddress[]> => [
          { address: "93.184.216.34", family: 4 },
        ],
        transport: async () => {
          attempts += 1;
          return attempts === 1
            ? { status: 429, headers: { "retry-after": retryAfter }, body: new Uint8Array() }
            : { status: 200, headers: {}, body: new Uint8Array() };
        },
        sleep: async (milliseconds) => {
          delays.push(milliseconds);
        },
        random: () => 0,
      },
    );
    assert.deepEqual(delays, [expectedDelay]);
  }
});

test("redirects stop at five hops and each connection uses the policy-approved DNS address", async () => {
  const requests: TransportRequest[] = [];
  await assert.rejects(
    requestWithPolicy(
      {
        url: new URL("https://skills.example.test/start"),
        origin: normalizeVerifyOrigin("https://skills.example.test", { retries: 0 }),
        purpose: "artifact",
        accept: "text/markdown",
        maxBytes: 1024,
      },
      {
        resolve: async (): Promise<readonly ResolvedAddress[]> => [
          { address: "93.184.216.34", family: 4 },
          { address: "93.184.216.35", family: 4 },
        ],
        transport: async (request) => {
          requests.push(request);
          return {
            status: 302,
            headers: { location: `https://skills.example.test/hop-${requests.length}` },
            body: new Uint8Array(),
          };
        },
        sleep: async () => {},
        random: () => 0,
      },
    ),
    (error) => hasVerifyCode(error, "policy_denied"),
  );
  assert.equal(requests.length, 6);
  assert.equal(
    requests.every(({ address }) => address.address === "93.184.216.34"),
    true,
  );
});

test("catalog validation executes the shared malformed and 100-release boundaries", async () => {
  const fixtureRoot = path.resolve(import.meta.dirname, "../../../tests/protocol/fixtures/catalog");
  const invalidFixtures = [
    "invalid-version-semver.json",
    "invalid-version-historical-semver.json",
    "invalid-version-numeric-prerelease.json",
    "invalid-version-order.json",
    "invalid-version-duplicate.json",
    "invalid-version-over-limit.json",
  ];
  for (const filename of invalidFixtures) {
    const bytes = await readFile(path.join(fixtureRoot, filename));
    assert.throws(
      () =>
        parseVerifyCatalog(
          bytes,
          new URL("https://skills.example.test/.well-known/agent-skills/index.json"),
        ),
      (error) => hasVerifyCode(error, "catalog_invalid"),
      filename,
    );
  }
  const overLimit = jsonObject(
    JSON.parse(await readFile(path.join(fixtureRoot, "invalid-version-over-limit.json"), "utf8")),
    "catalog",
  );
  if (!Array.isArray(overLimit.skills)) throw new Error("catalog skills must be an array");
  const firstSkill = jsonObject(overLimit.skills[0], "skills[0]");
  const extension = jsonObject(firstSkill["x-remote-skills"], "x-remote-skills");
  if (!Array.isArray(extension.releases)) throw new Error("releases must be an array");
  extension.releases = extension.releases.slice(0, 100);
  firstSkill["x-remote-skills"] = extension;
  overLimit.skills[0] = firstSkill;
  const boundary = parseVerifyCatalog(
    Buffer.from(JSON.stringify(overLimit)),
    new URL("https://skills.example.test/.well-known/agent-skills/index.json"),
  );
  const firstBoundary = boundary[0];
  assert.ok(firstBoundary?.extension);
  assert.equal(firstBoundary.extension.releases.length, 100);
  assert.equal(typeof runVerifyCommand, "function");
});

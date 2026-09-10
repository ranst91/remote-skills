import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingHttpHeaders, Server } from "node:http";
import { createServer } from "node:http";
import path from "node:path";
import { test } from "node:test";

import type { TransportRequest } from "../src/network.ts";
import {
  type CatalogCacheValue,
  parseVerifyArgs,
  runVerifyCommand,
  type VerifyDependencies,
} from "../src/verify.ts";
import { PublisherVerifyError } from "../src/verify-errors.ts";

type CatalogRelease = {
  version: string;
  type: "skill-md" | "archive";
  url: string;
  digest: string;
};
type CatalogEntry = {
  name: string;
  description: string;
  type: "skill-md" | "archive";
  url: string;
  digest: string;
  "x-remote-skills"?: { version: string; releases: CatalogRelease[] };
};

const schema = "https://schemas.agentskills.io/discovery/0.2.0/schema.json";
const secretCanary = "publisher-verify-secret-canary";
const validSkill = Buffer.from(
  `---\nname: fixture-skill\ndescription: Exercise verification.\n---\n\n# Fixture\n`,
);
const digest = (bytes: Uint8Array): string =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

function catalog(skills: CatalogEntry[]): Buffer {
  return Buffer.from(`${JSON.stringify({ $schema: schema, skills })}\n`);
}

function entry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    name: "fixture-skill",
    description: "Exercise verification.",
    type: "skill-md",
    url: "artifacts/fixture.md",
    digest: digest(validSkill),
    ...overrides,
  };
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

const budgetFlags = [
  "--catalog-bytes",
  "--archive-bytes",
  "--extracted-bytes",
  "--files",
  "--file-bytes",
] as const;

test("verification budgets preserve defaults and accept lower and higher positive integers", () => {
  const origin = "https://skills.example.test";
  const defaults = {
    catalogBytes: 1_048_576,
    archiveBytes: 52_428_800,
    extractedBytes: 104_857_600,
    files: 1_000,
    fileBytes: 10_485_760,
  };
  assert.deepEqual(parseVerifyArgs([origin]).limits, defaults);
  for (const multiplier of [0.5, 2]) {
    const values = Object.values(defaults).map((value) => value * multiplier);
    const parsed = parseVerifyArgs([
      origin,
      ...budgetFlags.flatMap((flag, index) => [flag, String(values[index])]),
    ]);
    assert.deepEqual(Object.values(parsed.limits), values);
  }
});

test("verification budgets reject invalid values, omissions, and repeated flags", () => {
  for (const flag of budgetFlags) {
    for (const suffix of [
      "=0",
      "=-1",
      "=1.5",
      "=NaN",
      "=Infinity",
      "=1e3",
      "=9007199254740992",
      "=",
      "",
    ]) {
      assert.throws(
        () => parseVerifyArgs(["https://skills.example.test", `${flag}${suffix}`]),
        (error) =>
          error instanceof PublisherVerifyError &&
          error.code === "configuration_invalid" &&
          error.context.field === flag,
      );
    }
    assert.throws(
      () => parseVerifyArgs(["https://skills.example.test", `${flag}=1`, flag, "2"]),
      (error) => error instanceof PublisherVerifyError && error.code === "configuration_invalid",
    );
  }
});

test("verification budgets govern small valid archive downloads and extracted files", async () => {
  const bytes = await readFile(
    path.resolve(
      import.meta.dirname,
      "../../../tests/protocol/fixtures/archive/tar-gzip/valid.tar.gz",
    ),
  );
  const body = catalog([
    entry({
      description: "Exercise archive safety.",
      type: "archive",
      url: "artifacts/valid.tar.gz",
      digest: digest(bytes),
    }),
  ]);
  const requests: TransportRequest[] = [];
  const dependencies: VerifyDependencies = {
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    transport: async (request) => {
      requests.push(request);
      return { status: 200, headers: {}, body: request.url.endsWith("index.json") ? body : bytes };
    },
  };
  // The shared valid archive has three files of 83, 4, and 53 bytes.
  const budgets = [body.byteLength, bytes.byteLength, 140, 3, 83];
  const success = await runVerifyCommand(
    {
      args: [
        "https://skills.example.test",
        ...budgetFlags.map((flag, index) => `${flag}=${budgets[index]}`),
      ],
    },
    dependencies,
  );
  assert.equal(success.exitCode, 0, JSON.stringify(success.failures));
  assert.equal(requests[0]?.maxBytes, body.byteLength);
  assert.equal(requests[1]?.maxBytes, bytes.byteLength);
  for (const [index, limit] of [
    "catalogBytes",
    "archiveBytes",
    "extractedBytes",
    "files",
    "fileBytes",
  ].entries()) {
    const result = await runVerifyCommand(
      {
        args: ["https://skills.example.test", `${budgetFlags[index]}=${(budgets[index] ?? 0) - 1}`],
      },
      dependencies,
    );
    assert.equal(result.exitCode, 1);
    assert.equal(result.failures[0]?.code, "limit_exceeded");
    assert.equal(result.failures[0]?.context.limit, limit);
  }
});

test("verification budgets apply to skill-md downloads", async () => {
  const requests: TransportRequest[] = [];
  const dependencies: VerifyDependencies = {
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    transport: async (request) => {
      requests.push(request);
      return {
        status: 200,
        headers: {},
        body: request.url.endsWith("index.json") ? catalog([entry()]) : validSkill,
      };
    },
  };
  for (const allowance of [validSkill.byteLength - 1, validSkill.byteLength, 20_971_520]) {
    const result = await runVerifyCommand(
      { args: ["https://skills.example.test", `--file-bytes=${allowance}`] },
      dependencies,
    );
    assert.equal(result.exitCode, allowance < validSkill.byteLength ? 1 : 0);
    assert.equal(requests.at(-1)?.maxBytes, allowance);
    if (result.exitCode !== 0) assert.equal(result.failures[0]?.context.limit, "fileBytes");
  }
});

test("verification extracted-byte budgets apply to direct Markdown", async () => {
  const dependencies: VerifyDependencies = {
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    transport: async (request) => ({
      status: 200,
      headers: {},
      body: request.url.endsWith("index.json") ? catalog([entry()]) : validSkill,
    }),
  };
  for (const allowance of [
    validSkill.byteLength - 1,
    validSkill.byteLength,
    validSkill.byteLength + 1,
  ]) {
    const result = await runVerifyCommand(
      {
        args: [
          "https://skills.example.test",
          `--file-bytes=${validSkill.byteLength + 10}`,
          `--extracted-bytes=${allowance}`,
        ],
      },
      dependencies,
    );
    assert.equal(result.exitCode, allowance < validSkill.byteLength ? 1 : 0);
    if (allowance < validSkill.byteLength) {
      assert.equal(result.failures[0]?.code, "limit_exceeded");
      assert.equal(result.failures[0]?.context.limit, "extractedBytes");
    } else {
      assert.deepEqual(result.failures, []);
    }
  }
});

test("verification budgets admit a modest catalog above default and bound cached 304 reuse", async () => {
  const body = Buffer.from(
    JSON.stringify({ $schema: schema, skills: [entry()], note: "a".repeat(1_048_576) }),
  );
  let cached: CatalogCacheValue | undefined;
  const dependencies: VerifyDependencies = {
    catalogCache: {
      get: async () => cached,
      set: async (_key, value) => {
        cached = value;
      },
    },
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    transport: async (request) =>
      request.url.endsWith("index.json")
        ? {
            status: cached ? 304 : 200,
            headers: { "remote-skills-scope": "engineering", etag: '"v1"' },
            body: cached ? new Uint8Array() : body,
          }
        : { status: 200, headers: {}, body: validSkill },
  };
  const args = ["https://skills.example.test", "--scope=engineering"];
  const defaultResult = await runVerifyCommand({ args }, dependencies);
  assert.equal(defaultResult.failures[0]?.context.limit, "catalogBytes");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await runVerifyCommand(
      { args: [...args, `--catalog-bytes=${body.byteLength}`] },
      dependencies,
    );
    assert.equal(result.exitCode, 0, JSON.stringify(result.failures));
  }
  const lower = await runVerifyCommand({ args }, dependencies);
  assert.equal(lower.failures[0]?.code, "limit_exceeded");
  assert.equal(lower.failures[0]?.context.limit, "catalogBytes");
});

test("private scoped origin verifies with an environment-backed header without exposing it", async () => {
  const requests: Array<{ url: string | undefined; headers: IncomingHttpHeaders }> = [];
  const server = createServer((request, response) => {
    requests.push({ url: request.url, headers: request.headers });
    if (request.headers.authorization !== secretCanary) {
      response.writeHead(401).end("body-must-not-appear");
      return;
    }
    if (request.url === "/.well-known/agent-skills/index.json") {
      assert.equal(request.headers["remote-skills-scope"], "engineering");
      response
        .writeHead(200, {
          "content-type": "application/json",
          "remote-skills-scope": "engineering",
        })
        .end(catalog([entry()]));
      return;
    }
    assert.equal(request.headers["remote-skills-scope"], undefined);
    response.writeHead(200, { "content-type": "text/markdown" }).end(validSkill);
  });
  const origin = await listen(server);
  try {
    const result = await runVerifyCommand({
      args: [origin, "--header-env", "Authorization=SKILLS_AUTH", "--scope", "engineering"],
      env: { SKILLS_AUTH: secretCanary },
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.verified, true);
    assert.deepEqual(result.failures, []);
    assert.equal(requests.length, 2);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(secretCanary, "u"));
  } finally {
    await close(server);
  }
});

test("401 and 403 remain distinct sanitized catalog failures", async () => {
  const authenticationCases: Array<readonly [number, string]> = [
    [401, "authentication_failed"],
    [403, "authorization_denied"],
  ];
  for (const [status, code] of authenticationCases) {
    const server = createServer((_request, response) =>
      response.writeHead(status, { "content-length": "100000000" }).end(secretCanary),
    );
    const origin = await listen(server);
    try {
      const result = await runVerifyCommand({
        args: [
          origin,
          "--header",
          `Authorization=${secretCanary}`,
          "--scope=engineering",
          "--retries=0",
        ],
      });
      assert.equal(result.exitCode, 1);
      assert.equal(result.failures[0]?.code, code);
      assert.deepEqual(result.failures[0]?.context, { scope: "engineering", status });
      assert.doesNotMatch(JSON.stringify(result), new RegExp(secretCanary, "u"));
    } finally {
      await close(server);
    }
  }
});

test("a successful scoped catalog must confirm the requested canonical scope", async () => {
  const server = createServer((_request, response) =>
    response.writeHead(200, { "remote-skills-scope": "sales" }).end(catalog([entry()])),
  );
  const origin = await listen(server);
  try {
    const result = await runVerifyCommand({
      args: [origin, "--scope", "engineering", "--retries", "0"],
    });
    assert.equal(result.exitCode, 1);
    assert.equal(result.failures[0]?.code, "catalog_invalid");
    assert.equal(result.failures[0]?.context.field, "remote-skills-scope");
  } finally {
    await close(server);
  }
});

test("digest tampering is terminal and is not retried", async () => {
  let artifactRequests = 0;
  const server = createServer((request, response) => {
    if (request.url === "/.well-known/agent-skills/index.json") {
      response.writeHead(200).end(catalog([entry()]));
      return;
    }
    artifactRequests += 1;
    response.writeHead(200).end(Buffer.from("tampered bytes"));
  });
  const origin = await listen(server);
  try {
    const result = await runVerifyCommand({ args: [origin, "--retries", "2"] });
    assert.equal(result.exitCode, 1);
    assert.equal(result.verified, false);
    assert.equal(result.failures[0]?.code, "digest_mismatch");
    assert.equal(result.failures[0]?.context.skill_name, "fixture-skill");
    assert.equal(artifactRequests, 1);
  } finally {
    await close(server);
  }
});

test("unsafe archives fail artifact validation after their digest passes", async () => {
  const unsafeArchive = await readFile(
    path.resolve(
      import.meta.dirname,
      "../../../tests/protocol/fixtures/archive/tar-gzip/symlink.tar.gz",
    ),
  );
  const archiveEntry = entry({
    type: "archive",
    url: "artifacts/unsafe.tar.gz",
    digest: digest(unsafeArchive),
  });
  const server = createServer((request, response) => {
    if (request.url === "/.well-known/agent-skills/index.json")
      response.writeHead(200).end(catalog([archiveEntry]));
    else response.writeHead(200, { "content-type": "application/gzip" }).end(unsafeArchive);
  });
  const origin = await listen(server);
  try {
    const result = await runVerifyCommand({ args: [origin] });
    assert.equal(result.exitCode, 1);
    assert.equal(result.failures[0]?.code, "archive_unsafe");
  } finally {
    await close(server);
  }
});

test("valid tar-gzip and ZIP artifacts verify using URL fallback for a generic media type", async () => {
  const fixturePaths: Array<readonly [string, string]> = [
    ["tar-gzip", "valid.tar.gz"],
    ["zip", "valid.zip"],
  ];
  const fixtures = await Promise.all(
    fixturePaths.map(async ([directory, filename]) => ({
      filename,
      bytes: await readFile(
        path.resolve(
          import.meta.dirname,
          `../../../tests/protocol/fixtures/archive/${directory}/${filename}`,
        ),
      ),
    })),
  );
  const archiveEntries = fixtures.map(({ filename, bytes }, index) =>
    entry({
      name: `fixture-skill-${index}`,
      description: "Exercise archive safety.",
      type: "archive",
      url: `artifacts/${filename}`,
      digest: digest(bytes),
    }),
  );
  // The fixture SKILL.md has one canonical name, so serve each archive in its own catalog run.
  for (const { filename, bytes } of fixtures) {
    const server = createServer((request, response) => {
      if (request.url === "/.well-known/agent-skills/index.json") {
        response.writeHead(200).end(
          catalog([
            entry({
              description: "Exercise archive safety.",
              type: "archive",
              url: `artifacts/${filename}`,
              digest: digest(bytes),
            }),
          ]),
        );
      } else response.writeHead(200, { "content-type": "application/octet-stream" }).end(bytes);
    });
    const origin = await listen(server);
    try {
      const result = await runVerifyCommand({ args: [origin] });
      assert.equal(result.exitCode, 0, `${filename}: ${JSON.stringify(result.failures)}`);
    } finally {
      await close(server);
    }
  }
  assert.equal(archiveEntries.length, 2);
});

test("same-origin artifact authorization is enforced with credentials but without scope forwarding", async () => {
  const requests: IncomingHttpHeaders[] = [];
  const server = createServer((request, response) => {
    requests.push(request.headers);
    if (request.url === "/.well-known/agent-skills/index.json") {
      response.writeHead(200, { "remote-skills-scope": "engineering" }).end(catalog([entry()]));
    } else response.writeHead(403).end(secretCanary);
  });
  const origin = await listen(server);
  try {
    const result = await runVerifyCommand({
      args: [
        origin,
        "--scope=engineering",
        "--header",
        `Authorization=${secretCanary}`,
        "--retries=0",
      ],
    });
    assert.equal(result.failures[0]?.code, "authorization_denied");
    assert.equal(requests[1]?.authorization, secretCanary);
    assert.equal(requests[1]?.["remote-skills-scope"], undefined);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(secretCanary, "u"));
  } finally {
    await close(server);
  }
});

test("transient artifact failures retry only within the configured bound", async () => {
  let artifacts = 0;
  const server = createServer((request, response) => {
    if (request.url === "/.well-known/agent-skills/index.json")
      response.writeHead(200).end(catalog([entry()]));
    else {
      artifacts += 1;
      if (artifacts < 3) response.writeHead(503, { "retry-after": "0" }).end();
      else response.writeHead(200).end(validSkill);
    }
  });
  const origin = await listen(server);
  try {
    const result = await runVerifyCommand({ args: [origin, "--retries=2"] });
    assert.equal(result.exitCode, 0);
    assert.equal(artifacts, 3);
  } finally {
    await close(server);
  }
});

test("invalid version extensions fail before any artifact request", async () => {
  let requests = 0;
  const versioned = entry({
    "x-remote-skills": {
      version: "1.0.0",
      releases: [
        {
          version: "1.0.0",
          type: "skill-md",
          url: "artifacts/fixture.md",
          digest: `sha256:${"0".repeat(64)}`,
        },
      ],
    },
  });
  const server = createServer((_request, response) => {
    requests += 1;
    response.writeHead(200).end(catalog([versioned]));
  });
  const origin = await listen(server);
  try {
    const result = await runVerifyCommand({ args: [origin] });
    assert.equal(result.exitCode, 1);
    assert.equal(result.failures[0]?.code, "catalog_invalid");
    assert.equal(requests, 1);
  } finally {
    await close(server);
  }
});

test("verification aggregates failures for every entry and historical release", async () => {
  const first = entry({ name: "first-skill", description: "First.", url: "artifacts/first.md" });
  const currentDigest = `sha256:${"1".repeat(64)}`;
  const priorDigest = `sha256:${"2".repeat(64)}`;
  const second = entry({
    name: "second-skill",
    description: "Second.",
    type: "archive",
    url: "artifacts/current.tar.gz",
    digest: currentDigest,
    "x-remote-skills": {
      version: "2.0.0",
      releases: [
        {
          version: "2.0.0",
          type: "archive",
          url: "artifacts/current.tar.gz",
          digest: currentDigest,
        },
        { version: "1.0.0", type: "archive", url: "artifacts/prior.tar.gz", digest: priorDigest },
      ],
    },
  });
  const requestedArtifacts: Array<string | undefined> = [];
  const server = createServer((request, response) => {
    if (request.url === "/.well-known/agent-skills/index.json") {
      response.writeHead(200).end(catalog([first, second]));
      return;
    }
    requestedArtifacts.push(request.url);
    response.writeHead(200).end("wrong");
  });
  const origin = await listen(server);
  try {
    const result = await runVerifyCommand({ args: [origin, "--retries=0"] });
    assert.equal(result.exitCode, 1);
    assert.equal(result.failures.length, 3);
    assert.deepEqual(
      result.failures.map(({ context }) => [context.skill_name, context.version]),
      [
        ["first-skill", undefined],
        ["second-skill", "2.0.0"],
        ["second-skill", "1.0.0"],
      ],
    );
    assert.deepEqual(requestedArtifacts, [
      "/.well-known/agent-skills/artifacts/first.md",
      "/.well-known/agent-skills/artifacts/current.tar.gz",
      "/.well-known/agent-skills/artifacts/prior.tar.gz",
    ]);
  } finally {
    await close(server);
  }
});

test("request timeout is bounded and reported without a response body", async () => {
  const server = createServer(() => {});
  const origin = await listen(server);
  try {
    const result = await runVerifyCommand({
      args: [origin, "--timeout-ms", "20", "--retries", "0"],
    });
    assert.equal(result.exitCode, 1);
    assert.equal(result.failures[0]?.code, "request_timeout");
  } finally {
    server.closeAllConnections();
    await close(server);
  }
});

test("scoped conditional verification reuses a validated catalog only after exact 304 confirmation", async () => {
  let cached: CatalogCacheValue | undefined;
  const catalogCache: NonNullable<VerifyDependencies["catalogCache"]> = {
    async get() {
      return cached;
    },
    async set(_key, value) {
      cached = value;
    },
  };
  let catalogRequests = 0;
  const seenCatalogHeaders: Record<string, string>[] = [];
  const dependencies: VerifyDependencies = {
    catalogCache,
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    transport: async (request) => {
      if (request.url.endsWith("index.json")) {
        catalogRequests += 1;
        seenCatalogHeaders.push(request.headers);
        if (catalogRequests === 1) {
          return {
            status: 200,
            headers: {
              etag: '"engineering-v1"',
              "remote-skills-scope": "engineering",
            },
            body: catalog([entry()]),
          };
        }
        return {
          status: 304,
          headers: { "remote-skills-scope": "engineering" },
          body: new Uint8Array(),
        };
      }
      return { status: 200, headers: {}, body: validSkill };
    },
    sleep: async () => {},
    random: () => 0,
  };

  const first = await runVerifyCommand(
    { args: ["https://skills.example.test", "--scope=engineering", "--retries=0"] },
    dependencies,
  );
  const second = await runVerifyCommand(
    { args: ["https://skills.example.test", "--scope=engineering", "--retries=0"] },
    dependencies,
  );

  assert.equal(first.exitCode, 0);
  assert.equal(second.exitCode, 0);
  assert.equal(seenCatalogHeaders[1]?.["if-none-match"], '"engineering-v1"');
  assert.equal(second.entries[0]?.digest, digest(validSkill));
});

test("scoped catalog validators follow fresh responses and inherit only on 304", async (t) => {
  const originalValidators = {
    etag: '"engineering-v1"',
    "last-modified": "Mon, 01 Jun 2026 12:00:00 GMT",
  };
  const replacements: Record<string, string>[] = [
    {},
    { etag: '"engineering-v2"' },
    { "last-modified": "Tue, 02 Jun 2026 12:00:00 GMT" },
  ];
  for (const status of [200, 304]) {
    for (const validators of replacements) {
      const name = `${status}, replacement: ${Object.keys(validators).join() || "none"}`;
      await t.test(name, async () => {
        let cached: CatalogCacheValue | undefined;
        const seenCatalogHeaders: Record<string, string>[] = [];
        const originalBody = catalog([entry()]);
        const freshBody = catalog([entry({ url: "artifacts/current.md" })]);
        const dependencies: VerifyDependencies = {
          catalogCache: {
            get: async () => cached,
            set: async (_key, value) => {
              cached = value;
            },
          },
          resolve: async () => [{ address: "93.184.216.34", family: 4 }],
          transport: async (request) => {
            if (!request.url.endsWith("index.json"))
              return { status: 200, headers: {}, body: validSkill };
            seenCatalogHeaders.push(request.headers);
            const first = seenCatalogHeaders.length === 1;
            return {
              status: first ? 200 : status,
              headers: {
                "remote-skills-scope": "engineering",
                ...(first ? originalValidators : validators),
              },
              body: first ? originalBody : status === 304 ? new Uint8Array() : freshBody,
            };
          },
        };
        const options = { args: ["https://skills.example.test", "--scope=engineering"] };
        for (let request = 0; request < 3; request += 1) {
          const result = await runVerifyCommand(options, dependencies);
          assert.equal(result.exitCode, 0);
          assert.equal(result.entries[0]?.digest, digest(validSkill));
        }
        assert.equal(seenCatalogHeaders[0]?.["if-none-match"], undefined);
        assert.equal(seenCatalogHeaders[0]?.["if-modified-since"], undefined);
        assert.equal(seenCatalogHeaders[1]?.["if-none-match"], originalValidators.etag);
        assert.equal(
          seenCatalogHeaders[1]?.["if-modified-since"],
          originalValidators["last-modified"],
        );
        const expected = status === 304 ? { ...originalValidators, ...validators } : validators;
        assert.equal(seenCatalogHeaders[2]?.["if-none-match"], expected.etag);
        assert.equal(seenCatalogHeaders[2]?.["if-modified-since"], expected["last-modified"]);
        assert.equal(cached?.etag, expected.etag);
        assert.equal(cached?.lastModified, expected["last-modified"]);
        assert.deepEqual(cached?.body, status === 304 ? originalBody : freshBody);
      });
    }
  }
});

test("scoped catalog Cache-Control honors repeated no-store fields and optional deletion", async (t) => {
  for (const status of [200, 304]) {
    for (const supportsDelete of [false, true]) {
      await t.test(`${status}, delete supported: ${supportsDelete}`, async () => {
        let cached: CatalogCacheValue | undefined;
        const storedKeys: string[] = [];
        const deletedKeys: string[] = [];
        let catalogRequests = 0;
        const body = catalog([entry()]);
        const dependencies: VerifyDependencies = {
          catalogCache: {
            get: async () => cached,
            set: async (key, value) => {
              storedKeys.push(key);
              cached = value;
            },
            ...(supportsDelete
              ? {
                  delete: async (key: string) => {
                    deletedKeys.push(key);
                    cached = undefined;
                  },
                }
              : {}),
          },
          resolve: async () => [{ address: "93.184.216.34", family: 4 }],
          transport: async (request) => {
            if (!request.url.endsWith("index.json"))
              return { status: 200, headers: {}, body: validSkill };
            catalogRequests += 1;
            const first = catalogRequests === 1;
            return {
              status: first ? 200 : status,
              headers: {
                "remote-skills-scope": "engineering",
                "cache-control": first ? ["private", "max-age=60"] : ["private", " No-Store "],
              },
              body: !first && status === 304 ? new Uint8Array() : body,
            };
          },
        };
        const options = { args: ["https://skills.example.test", "--scope=engineering"] };
        const first = await runVerifyCommand(options, dependencies);
        assert.equal(first.exitCode, 0);
        assert.equal(storedKeys.length, 1, "ordinary repeated cacheable fields persist");
        assert.deepEqual(cached?.body, body);
        const previous = cached;

        const second = await runVerifyCommand(options, dependencies);
        assert.equal(second.exitCode, 0);
        assert.equal(second.entries[0]?.digest, digest(validSkill));
        assert.equal(storedKeys.length, 1, "no-store must not write a cache record");
        assert.deepEqual(deletedKeys, supportsDelete ? storedKeys : []);
        assert.equal(cached, supportsDelete ? undefined : previous);
      });
    }
  }
});

test("scoped catalog Cache-Control handling preserves singleton scope confirmation", async () => {
  let stores = 0;
  const result = await runVerifyCommand(
    { args: ["https://skills.example.test", "--scope=engineering"] },
    {
      catalogCache: {
        get: async () => undefined,
        set: async () => {
          stores += 1;
        },
      },
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      transport: async () => ({
        status: 200,
        headers: {
          "remote-skills-scope": ["engineering", "engineering"],
          "cache-control": ["private", "max-age=60"],
        },
        body: catalog([entry()]),
      }),
    },
  );
  assert.equal(result.failures[0]?.code, "catalog_invalid");
  assert.equal(result.failures[0]?.context.field, "remote-skills-scope");
  assert.equal(stores, 0);
});

test("304 verification fails stably without cached bytes or with a non-canonical scope", async () => {
  const emptyCache: NonNullable<VerifyDependencies["catalogCache"]> = {
    get: async () => undefined,
    set: async () => {},
  };
  const baseDependencies: VerifyDependencies = {
    catalogCache: emptyCache,
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    sleep: async () => {},
    random: () => 0,
  };
  const noCache = await runVerifyCommand(
    { args: ["https://skills.example.test", "--scope=engineering", "--retries=0"] },
    {
      ...baseDependencies,
      transport: async () => ({
        status: 304,
        headers: { "remote-skills-scope": "engineering" },
        body: new Uint8Array(),
      }),
    },
  );
  assert.equal(noCache.failures[0]?.code, "catalog_invalid");
  assert.equal(noCache.failures[0]?.context.field, "catalog.cache");

  let cached: CatalogCacheValue | undefined;
  const cache: NonNullable<VerifyDependencies["catalogCache"]> = {
    async get() {
      return cached;
    },
    async set(_key, value) {
      cached = value;
    },
  };
  let count = 0;
  const dependencies: VerifyDependencies = {
    ...baseDependencies,
    catalogCache: cache,
    transport: async (request) => {
      if (!request.url.endsWith("index.json"))
        return { status: 200, headers: {}, body: validSkill };
      count += 1;
      return count === 1
        ? {
            status: 200,
            headers: { etag: '"v1"', "remote-skills-scope": "engineering" },
            body: catalog([entry()]),
          }
        : {
            status: 304,
            headers: { "remote-skills-scope": "sales" },
            body: new Uint8Array(),
          };
    },
  };
  await runVerifyCommand(
    { args: ["https://skills.example.test", "--scope=engineering", "--retries=0"] },
    dependencies,
  );
  const mismatch = await runVerifyCommand(
    { args: ["https://skills.example.test", "--scope=engineering", "--retries=0"] },
    dependencies,
  );
  assert.equal(mismatch.failures[0]?.code, "catalog_invalid");
  assert.equal(mismatch.failures[0]?.context.field, "remote-skills-scope");
});

test("skill-md downloads use the per-file response cap before allocation", async () => {
  const requests: TransportRequest[] = [];
  const result = await runVerifyCommand(
    { args: ["https://skills.example.test", "--retries=0"] },
    {
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      transport: async (request) => {
        requests.push(request);
        return request.url.endsWith("index.json")
          ? { status: 200, headers: {}, body: catalog([entry()]) }
          : { status: 200, headers: {}, body: Buffer.from("wrong") };
      },
      sleep: async () => {},
      random: () => 0,
    },
  );
  assert.equal(result.failures[0]?.code, "digest_mismatch");
  assert.equal(requests[1]?.maxBytes, 10_485_760);
});

test("oversized skill-md responses name the per-file limit", async () => {
  const server = createServer((request, response) => {
    if (request.url === "/.well-known/agent-skills/index.json") {
      response.writeHead(200).end(catalog([entry()]));
      return;
    }
    response.writeHead(200, { "content-length": "10485761" }).end();
  });
  const origin = await listen(server);
  try {
    const result = await runVerifyCommand({ args: [origin, "--retries=0"] });
    assert.equal(result.exitCode, 1);
    assert.equal(result.failures[0]?.code, "limit_exceeded");
    assert.equal(result.failures[0]?.context.limit, "fileBytes");
  } finally {
    await close(server);
  }
});

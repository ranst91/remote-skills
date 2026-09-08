import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";

import { runProtocolCase as runSdkProtocolCase } from "../src/protocol-adapter.ts";

const packageRoot = resolve(import.meta.dirname, "..");
const repositoryRoot = resolve(import.meta.dirname, "../../..");
const protocolRoot = resolve(repositoryRoot, "tests/protocol");
const adapterPath = resolve(
  repositoryRoot,
  "tests/protocol/adapters/typescript-protocol-adapter.mjs",
);
const implementationPath = resolve(packageRoot, "src/protocol-adapter.ts");

const parsedRedactionContract: unknown = JSON.parse(
  await readFile(resolve(protocolRoot, "contracts/v0/redaction.json"), "utf8"),
);
assert.ok(
  parsedRedactionContract !== null &&
    typeof parsedRedactionContract === "object" &&
    "never_snapshot_fields" in parsedRedactionContract &&
    Array.isArray(parsedRedactionContract.never_snapshot_fields),
);
const redactionFields = parsedRedactionContract.never_snapshot_fields.map((value) => {
  if (typeof value !== "string") throw new TypeError("redaction contract fields must be strings");
  return value;
});

function runProtocolCase(id: string) {
  return spawnSync(
    process.execPath,
    [adapterPath, "--implementation", implementationPath, "--case", id],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
    },
  );
}

for (const [id, behavior] of [
  ["valid-v0.2", "parses the exact shared v0.2 catalog fixture"],
  ["valid-v0.2-extension", "ignores unknown v0.2 extension fields"],
  ["unsupported-v0.1", "rejects the v0.1 schema"],
  ["unsupported-missing-schema", "rejects a missing schema"],
  ["invalid-digest", "rejects a non-canonical digest"],
  ["invalid-entry", "rejects an entry with a missing description"],
] as const) {
  test(behavior, () => {
    const result = runProtocolCase(id);

    assert.equal(result.status, 0, result.stderr || result.stdout);
  });
}

const networkCases = [
  "validator-initial-200",
  "validator-conditional-304",
  "validator-fresh-no-request",
  "redirect-same-host",
  "redirect-cross-host",
  "redirect-private-address",
  "redirect-overflow",
  "ip-public-v4",
  "ip-private-10",
  "ip-private-172",
  "ip-private-192",
  "ip-loopback-v4",
  "ip-link-local-v4",
  "ip-multicast-v4",
  "ip-unspecified-v4",
  "ip-public-v6",
  "ip-loopback-v6",
  "ip-unique-local-v6",
  "ip-link-local-v6",
  "ip-multicast-v6",
  "ip-unspecified-v6",
  "ip-mapped-loopback-v6",
  "ip-mapped-private-v6",
  "ip-mapped-public-v6",
  "ip-dns-rebinding",
  "retry-408",
  "retry-429",
  "retry-500",
  "retry-network-failure",
  "retry-disabled-transient",
  "credentials-same-host",
  "credentials-cross-host-stripped",
  "credentials-explicit-cdn",
];

const redactionCases = [
  "authorization-timeout",
  "configured-secret-header",
  "cdn-token-timeout",
  "credential-bearing-url",
];

const cacheCases = [
  "cache-v1-valid",
  "cache-v1-partial-writer",
  "cache-v1-crashed-lease",
  "cache-v1-cross-process",
  "cache-v2-unknown",
];

for (const id of [
  ...networkCases,
  ...redactionCases,
  ...cacheCases,
  "catalog-initial",
  "catalog-conditional",
]) {
  test(`matches shared protocol case ${id}`, () => {
    const result = runProtocolCase(id);

    assert.equal(result.status, 0, result.stderr || result.stdout);
  });
}

test("the real protocol adapter redacts every never-snapshot contract header", async () => {
  const headers = Object.fromEntries(redactionFields.map((name) => [name, `secret-for-${name}`]));
  const records = await runSdkProtocolCase({
    suite: "request_transcripts",
    protocolRoot,
    fixture: {
      id: "never-snapshot-contract",
      configuration: {
        origin: "https://skills.example.test",
        headers,
      },
      response: { status: 200 },
    },
  });

  assert.deepEqual(records, [
    {
      method: "GET",
      url: "https://skills.example.test/.well-known/agent-skills/index.json",
      headers: { accept: "application/json" },
      sensitive_header_names: [...redactionFields].sort(),
    },
  ]);
});

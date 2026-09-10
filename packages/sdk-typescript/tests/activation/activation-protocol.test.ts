import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";

import { runProtocolCase } from "../../src/protocol-adapter.ts";

const repositoryRoot = resolve(import.meta.dirname, "../../../..");
const protocolRoot = resolve(repositoryRoot, "tests/protocol");

function record(value: unknown, label: string): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), label);
  return Object.fromEntries(Object.entries(value));
}

function records(value: unknown, label: string): Record<string, unknown>[] {
  assert.ok(Array.isArray(value), label);
  return value.map((entry, index) => record(entry, `${label}[${index}]`));
}

function fixtureCases(value: unknown): Record<string, unknown>[] {
  return records(record(value, "fixture document").cases, "fixture cases");
}

function expectedResults(value: unknown): unknown[] {
  return records(record(value, "expected document").cases, "expected cases").map(
    (entry) => entry.result,
  );
}

function stringField(value: Record<string, unknown>, field: string): string {
  const candidate = value[field];
  if (typeof candidate !== "string") throw new TypeError(`${field} must be a string`);
  return candidate;
}

async function readJson(path: string): Promise<unknown> {
  const parsed: unknown = JSON.parse(await readFile(resolve(protocolRoot, path), "utf8"));
  return parsed;
}

const suites = [
  {
    name: "archive",
    fixtures: "fixtures/archive/archive-cases.json",
    expected: "expected-results/archive-results.json",
  },
  {
    name: "publisher_activation",
    fixtures: "fixtures/publisher/consumer-cases.json",
    expected: "expected-results/publisher-activation-results.json",
  },
];

for (const suite of suites) {
  const fixtures = fixtureCases(await readJson(suite.fixtures));
  const expected = expectedResults(await readJson(suite.expected));
  for (let index = 0; index < fixtures.length; index += 1) {
    const fixture = fixtures[index];
    assert.ok(fixture);
    test(`activation adapter matches ${suite.name}/${stringField(fixture, "id")}`, async () => {
      const actual = await runProtocolCase({
        suite: suite.name,
        fixture,
        protocolRoot,
      });
      assert.deepEqual(actual, expected[index]);
    });
  }
}

const supplementalFixtures = fixtureCases(
  await readJson("fixtures/network/scope-version-network-cases.json"),
);
const supplementalExpected = expectedResults(
  await readJson("expected-results/scope-version-network-results.json"),
);
for (const id of [
  "authorized-range-activation",
  "version-removal-existing-session",
  "version-removal-explicit-stale",
]) {
  const index = supplementalFixtures.findIndex((fixture) => fixture.id === id);
  const fixture = supplementalFixtures[index];
  assert.ok(fixture);
  test(`activation adapter matches supplemental network/${id}`, async () => {
    const actual = await runProtocolCase({ suite: "network", fixture, protocolRoot });
    assert.deepEqual(actual, supplementalExpected[index]);
  });
}

const lifecycleFixtures = fixtureCases(await readJson("fixtures/network/network-cases.json"));
const lifecycleExpected = expectedResults(await readJson("expected-results/network-results.json"));
for (const id of [
  "offline-active-session",
  "offline-new-default",
  "offline-stale-allowed",
  "offline-stale-expired",
  "removal-existing-session",
  "removal-future-session",
]) {
  const index = lifecycleFixtures.findIndex((fixture) => fixture.id === id);
  const fixture = lifecycleFixtures[index];
  assert.ok(fixture);
  test(`activation adapter matches lifecycle network/${id}`, async () => {
    const actual = await runProtocolCase({ suite: "network", fixture, protocolRoot });
    assert.deepEqual(actual, lifecycleExpected[index]);
  });
}

test("authorized range evidence comes from an activated historical descriptor", async () => {
  const fixture = supplementalFixtures.find(({ id }) => id === "authorized-range-activation");
  assert.ok(fixture);
  const actual = record(
    await runProtocolCase({
      suite: "network",
      fixture,
      protocolRoot,
      evidence: true,
    }),
    "authorized activation result",
  );
  const evidence = record(actual.activation_evidence, "activation evidence");
  const current = record(evidence.current, "current activation evidence");
  const selected = record(evidence.selected, "selected activation evidence");
  const pin = record(evidence.pin, "pinned activation evidence");
  assert.equal(evidence.activated, true);
  assert.notEqual(current.url, selected.url);
  assert.notEqual(current.digest, selected.digest);
  assert.notEqual(current.bytes, selected.bytes);
  assert.deepEqual(pin, selected);
  assert.equal(evidence.requested_url, selected.url);
  assert.deepEqual(
    {
      version: actual.selected_version,
      artifact_type: actual.artifact_type,
      url: actual.url,
      digest: actual.digest,
      pinned_digest: actual.pinned_digest,
      confirmed_scope: actual.confirmed_scope,
    },
    {
      version: pin.version,
      artifact_type: pin.artifact_type,
      url: pin.url,
      digest: pin.digest,
      pinned_digest: pin.digest,
      confirmed_scope: pin.confirmed_scope,
    },
  );
});

test("removal evidence reads the same pinned activation after authoritative removal", async () => {
  const fixture = supplementalFixtures.find(({ id }) => id === "version-removal-existing-session");
  assert.ok(fixture);
  const actual = record(
    await runProtocolCase({
      suite: "network",
      fixture,
      protocolRoot,
      evidence: true,
    }),
    "removal evidence result",
  );
  assert.deepEqual(actual.activation_evidence, {
    activated: true,
    pinned_version: "1.4.7",
    authoritative_removal_observed: true,
    read_from_same_activation: true,
    requests_after_removal: 0,
  });
});

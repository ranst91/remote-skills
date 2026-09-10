import assert from "node:assert/strict";
import { test } from "node:test";

import {
  compareReleaseDescriptors,
  compareSemVerPrecedence,
  parseStrictSemVer,
} from "../src/build/semver.ts";

function parsed(version: unknown) {
  const value = parseStrictSemVer(version);
  assert.ok(value, typeof version === "string" ? version : "expected a valid SemVer string");
  return value;
}

test("accepts the strict SemVer grammar including arbitrary-size numeric identifiers", () => {
  for (const version of [
    "0.0.0",
    "1.2.3",
    "1.2.3-alpha.1",
    "1.2.3-alpha-beta+build.10",
    "999999999999999999999999999999.0.1",
  ]) {
    assert.equal(parseStrictSemVer(version)?.source, version);
  }
});

test("rejects loose, leading-zero, empty, whitespace, and non-ASCII SemVer forms", () => {
  for (const version of [
    "",
    "v1.2.3",
    "=1.2.3",
    "1.2",
    "1.2.3.4",
    "01.2.3",
    "1.02.3",
    "1.2.03",
    "1.2.3-01",
    "1.2.3-",
    "1.2.3+",
    " 1.2.3",
    "1.2.3 ",
    "1.2.3-β",
  ]) {
    assert.equal(parseStrictSemVer(version), null, version);
  }
});

test("orders precedence descending and resolves build-metadata ties lexically", () => {
  const versions = ["1.4.7+build.2", "1.4.7-rc.2", "2.0.0", "1.4.7+build.10", "1.4.7-rc.10"];
  const releases = versions.map((version) => ({ version, parsedVersion: parsed(version) }));
  releases.sort(compareReleaseDescriptors);
  assert.deepEqual(
    releases.map(({ version }) => version),
    ["2.0.0", "1.4.7+build.10", "1.4.7+build.2", "1.4.7-rc.10", "1.4.7-rc.2"],
  );
  assert.equal(compareSemVerPrecedence(parsed("1.0.0+one"), parsed("1.0.0+two")), 0);
});

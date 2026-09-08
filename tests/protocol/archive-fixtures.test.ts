import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  jsonBoolean,
  jsonCaseDocument,
  jsonNumber,
  jsonObject,
  jsonOptionalString,
  jsonString,
  jsonValue,
  parseSha256Manifest,
  protocolRoot,
  readJson,
  readSha256Manifest,
  sha256,
  spawnTextSync,
} from "./helpers/contract-helpers.ts";

const requiredCategories = [
  "absolute_path",
  "archive_byte_limit",
  "case_collision",
  "count_limit",
  "decompression_limit",
  "device",
  "dot_dot_segment",
  "dot_segment",
  "drive_prefixed_path",
  "duplicate_path",
  "hard_link",
  "invalid_name",
  "invalid_standard_metadata",
  "invalid_utf8_content",
  "invalid_utf8_path",
  "malformed_yaml",
  "missing_frontmatter",
  "missing_required_field",
  "missing_root_skill",
  "mixed_separator_traversal",
  "non_regular_root_skill",
  "nul_path",
  "root_backslash",
  "size_limit",
  "socket",
  "special_file",
  "streamed_size_mismatch",
  "symlink",
  "traversal",
  "unc_path",
  "unicode_normalization_collision",
  "valid",
  "windows_drive_backslash",
];

interface ArchiveFixture {
  artifact_type: string;
  category: string;
  format?: string;
  id: string;
  path: string;
}

interface ArchiveResult {
  cache_object_published?: boolean;
  digest?: string;
  error?: { code: string };
  outcome: string;
  requests?: number;
}

interface ArchiveFixtureDocument {
  cases: ArchiveFixture[];
}

interface ArchiveResultDocument {
  cases: { id: string; result: ArchiveResult }[];
}

function decodeArchiveFixture(value: unknown, label: string): ArchiveFixture {
  const fixture = jsonObject(value, label);
  const format = jsonOptionalString(fixture, "format", label);
  return {
    artifact_type: jsonString(jsonValue(fixture, "artifact_type", label), `${label}.artifact_type`),
    category: jsonString(jsonValue(fixture, "category", label), `${label}.category`),
    id: jsonString(jsonValue(fixture, "id", label), `${label}.id`),
    path: jsonString(jsonValue(fixture, "path", label), `${label}.path`),
    ...(format === undefined ? {} : { format }),
  };
}

function decodeArchiveResult(value: unknown, label: string): ArchiveResult {
  const result = jsonObject(value, label);
  const error = Object.hasOwn(result, "error")
    ? jsonObject(jsonValue(result, "error", label), `${label}.error`)
    : undefined;
  const digest = jsonOptionalString(result, "digest", label);
  const cacheObjectPublished = Object.hasOwn(result, "cache_object_published")
    ? jsonBoolean(
        jsonValue(result, "cache_object_published", label),
        `${label}.cache_object_published`,
      )
    : undefined;
  const requests = Object.hasOwn(result, "requests")
    ? jsonNumber(jsonValue(result, "requests", label), `${label}.requests`)
    : undefined;
  return {
    outcome: jsonString(jsonValue(result, "outcome", label), `${label}.outcome`),
    ...(cacheObjectPublished === undefined ? {} : { cache_object_published: cacheObjectPublished }),
    ...(digest === undefined ? {} : { digest }),
    ...(error === undefined
      ? {}
      : {
          error: {
            code: jsonString(jsonValue(error, "code", `${label}.error`), `${label}.error.code`),
          },
        }),
    ...(requests === undefined ? {} : { requests }),
  };
}

function readArchiveFixtures(): ArchiveFixtureDocument {
  return jsonCaseDocument(
    readJson("fixtures/archive/archive-cases.json"),
    "archive fixtures",
    decodeArchiveFixture,
  );
}

function readArchiveResults(): ArchiveResultDocument {
  return jsonCaseDocument(
    readJson("expected-results/archive-results.json"),
    "archive results",
    (value, label) => {
      const item = jsonObject(value, label);
      return {
        id: jsonString(jsonValue(item, "id", label), `${label}.id`),
        result: decodeArchiveResult(jsonValue(item, "result", label), `${label}.result`),
      };
    },
  );
}

test("archive registry covers every required valid and adversarial category", () => {
  const registry = readArchiveFixtures();
  const expected = readArchiveResults();

  assert.deepEqual(
    [...new Set(registry.cases.map(({ category }) => category))].sort(),
    requiredCategories,
  );
  assert.deepEqual(
    registry.cases.map(({ id }) => id),
    expected.cases.map(({ id }) => id),
  );
  assert.ok(registry.cases.some(({ artifact_type }) => artifact_type === "skill-md"));
  assert.ok(registry.cases.some(({ format }) => format === "tar.gz"));
  assert.ok(registry.cases.some(({ format }) => format === "zip"));
  const requiredDirectSkillCases = [
    "skill-md-malformed-yaml",
    "skill-md-missing-frontmatter",
    "skill-md-missing-name",
    "skill-md-missing-description",
    "skill-md-invalid-name",
    "skill-md-invalid-metadata",
  ];
  assert.deepEqual(
    registry.cases.filter(({ id }) => requiredDirectSkillCases.includes(id)).map(({ id }) => id),
    requiredDirectSkillCases,
  );
  const expectedById = new Map(expected.cases.map(({ id, result }) => [id, result]));
  for (const id of requiredDirectSkillCases) {
    const result = expectedById.get(id);
    assert.equal(result?.outcome, "activation_error", id);
    assert.equal(result.error?.code, "catalog_invalid", id);
    assert.equal(result.cache_object_published, false, id);
    assert.equal(result.requests, 1, id);
  }
  for (const category of [
    "absolute_path",
    "archive_byte_limit",
    "dot_segment",
    "dot_dot_segment",
    "drive_prefixed_path",
    "missing_root_skill",
    "non_regular_root_skill",
    "nul_path",
    "root_backslash",
    "unc_path",
    "unicode_normalization_collision",
    "windows_drive_backslash",
    "mixed_separator_traversal",
  ]) {
    assert.deepEqual(
      registry.cases.filter((fixture) => fixture.category === category).map(({ format }) => format),
      ["tar.gz", "zip"],
      category,
    );
  }
});

test("SHA-256 manifest parser tolerates CRLF without changing exact digests or paths", () => {
  const firstDigest = "a".repeat(64);
  const secondDigest = "b".repeat(64);
  assert.deepEqual(
    parseSha256Manifest(
      `${firstDigest}  fixtures/first.bin\r\n${secondDigest}  fixtures/second.bin\r\n`,
    ),
    [
      { digest: firstDigest, path: "fixtures/first.bin" },
      { digest: secondDigest, path: "fixtures/second.bin" },
    ],
  );
});

test("independently produced archive manifest matches every exact fixture byte", () => {
  const registry = readArchiveFixtures();
  const manifest = readSha256Manifest("manifests/archive-fixtures.sha256");
  const manifestPaths = manifest.map(({ path }) => path);

  assert.deepEqual(
    manifestPaths,
    [...registry.cases.map(({ path }) => `fixtures/archive/${path}`)].sort(),
  );
  for (const entry of manifest) {
    assert.equal(sha256(readFileSync(resolve(protocolRoot, entry.path))), entry.digest, entry.path);
  }
  const expected = readArchiveResults();
  for (let index = 0; index < registry.cases.length; index += 1) {
    const expectedCase = expected.cases[index];
    assert.ok(expectedCase);
    const result = expectedCase.result;
    if (result.outcome !== "activation_success") continue;
    const fixture = registry.cases[index];
    assert.ok(fixture);
    assert.equal(
      result.digest,
      `sha256:${sha256(readFileSync(resolve(protocolRoot, "fixtures/archive", fixture.path)))}`,
      fixture.id,
    );
  }
});

test("independent inspector confirms archive metadata and bounded limit scenarios", () => {
  const result = spawnTextSync(
    "python3",
    [resolve(protocolRoot, "tools/inspect_archive_fixtures.py")],
    {
      cwd: protocolRoot,
      env: { ...process.env, LANG: "C", LC_ALL: "C", PYTHONUTF8: "0" },
    },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /^inspected \d+ archive fixtures\n$/);
});

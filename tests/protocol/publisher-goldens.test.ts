import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { test } from "node:test";
import {
  decodeActivationExpectations,
  decodeActivationResources,
  type ExpectedActivationResource,
} from "./helpers/activation-expectations.ts";
import {
  jsonArray,
  jsonCaseDocument,
  jsonNumber,
  jsonObject,
  jsonOptionalNumber,
  jsonString,
  jsonStringArray,
  jsonValue,
  protocolRoot,
  readJson,
  readSha256Manifest,
  sha256,
  spawnTextSync,
  walkFiles,
} from "./helpers/contract-helpers.ts";

interface CatalogEntry {
  digest: string;
  name: string;
  url: string;
}

interface PublisherCatalog {
  $schema: string;
  skills: CatalogEntry[];
}

interface PublisherContract {
  formats: string[];
  skills: { name: string }[];
  source_files: string[];
}

interface PublisherGoldenArtifact {
  bytes: number;
  path: string;
  sha256: string;
  skill: string;
}

interface PublisherGolden {
  artifacts: PublisherGoldenArtifact[];
  index: { bytes: number; path: string; sha256: string };
  normalized_archive: { directory_entries: string; directory_mode?: number };
}

interface PublisherExpected {
  formats: { [format: string]: PublisherGolden };
}

interface ConsumerFixture {
  id: string;
  index: string;
  origin_alias: string;
  skill_name: string;
}

interface ConsumerResult {
  digest: string;
  files: ExpectedActivationResource[];
  frontmatter: { name: string };
  name: string;
  origin_alias: string;
  requests: number;
}

test("activation expectations retain structured resource metadata", () => {
  const expectations = decodeActivationExpectations(
    readJson("expected-results/publisher-activation-results.json"),
  );
  const first = expectations.cases[0];
  assert.ok(first);
  assert.deepEqual(first.result.files, [
    { path: "SKILL.md", size: 222, media_type: "text/markdown" },
  ]);
});

test("activation resource validation rejects an unsafe size", () => {
  assert.throws(
    () =>
      decodeActivationResources(
        [{ path: "SKILL.md", size: -1, media_type: "text/markdown" }],
        "activation resources",
      ),
    /non-negative safe integer/,
  );
});

function decodeCatalogEntry(value: unknown, label: string): CatalogEntry {
  const entry = jsonObject(value, label);
  return {
    digest: jsonString(jsonValue(entry, "digest", label), `${label}.digest`),
    name: jsonString(jsonValue(entry, "name", label), `${label}.name`),
    url: jsonString(jsonValue(entry, "url", label), `${label}.url`),
  };
}

function decodePublisherCatalog(value: unknown, label: string): PublisherCatalog {
  const catalog = jsonObject(value, label);
  return {
    $schema: jsonString(jsonValue(catalog, "$schema", label), `${label}.$schema`),
    skills: jsonArray(jsonValue(catalog, "skills", label), `${label}.skills`).map((item, index) =>
      decodeCatalogEntry(item, `${label}.skills[${index}]`),
    ),
  };
}

function decodePublisherContract(value: unknown): PublisherContract {
  const contract = jsonObject(value, "publisher contract");
  return {
    formats: jsonStringArray(
      jsonValue(contract, "formats", "publisher contract"),
      "publisher contract.formats",
    ),
    skills: jsonArray(
      jsonValue(contract, "skills", "publisher contract"),
      "publisher contract.skills",
    ).map((item, index) => {
      const skill = jsonObject(item, `publisher contract.skills[${index}]`);
      return {
        name: jsonString(
          jsonValue(skill, "name", `publisher contract.skills[${index}]`),
          `publisher contract.skills[${index}].name`,
        ),
      };
    }),
    source_files: jsonStringArray(
      jsonValue(contract, "source_files", "publisher contract"),
      "publisher contract.source_files",
    ),
  };
}

function decodeDescriptor(value: unknown, label: string): PublisherGoldenArtifact {
  const item = jsonObject(value, label);
  return {
    bytes: jsonNumber(jsonValue(item, "bytes", label), `${label}.bytes`),
    path: jsonString(jsonValue(item, "path", label), `${label}.path`),
    sha256: jsonString(jsonValue(item, "sha256", label), `${label}.sha256`),
    skill: jsonString(jsonValue(item, "skill", label), `${label}.skill`),
  };
}

function decodePublisherGolden(value: unknown, label: string): PublisherGolden {
  const golden = jsonObject(value, label);
  const index = jsonObject(jsonValue(golden, "index", label), `${label}.index`);
  const archive = jsonObject(
    jsonValue(golden, "normalized_archive", label),
    `${label}.normalized_archive`,
  );
  const directoryMode = jsonOptionalNumber(
    archive,
    "directory_mode",
    `${label}.normalized_archive`,
  );
  return {
    artifacts: jsonArray(jsonValue(golden, "artifacts", label), `${label}.artifacts`).map(
      (item, index_) => decodeDescriptor(item, `${label}.artifacts[${index_}]`),
    ),
    index: {
      bytes: jsonNumber(jsonValue(index, "bytes", `${label}.index`), `${label}.index.bytes`),
      path: jsonString(jsonValue(index, "path", `${label}.index`), `${label}.index.path`),
      sha256: jsonString(jsonValue(index, "sha256", `${label}.index`), `${label}.index.sha256`),
    },
    normalized_archive: {
      directory_entries: jsonString(
        jsonValue(archive, "directory_entries", `${label}.normalized_archive`),
        `${label}.normalized_archive.directory_entries`,
      ),
      ...(directoryMode === undefined ? {} : { directory_mode: directoryMode }),
    },
  };
}

function decodePublisherExpected(value: unknown): PublisherExpected {
  const expected = jsonObject(value, "publisher expected results");
  const rawFormats = jsonObject(
    jsonValue(expected, "formats", "publisher expected results"),
    "publisher expected results.formats",
  );
  const formats: { [format: string]: PublisherGolden } = {};
  for (const [format, golden] of Object.entries(rawFormats)) {
    formats[format] = decodePublisherGolden(golden, `publisher expected results.formats.${format}`);
  }
  return { formats };
}

function decodeConsumerFixture(value: unknown, label: string): ConsumerFixture {
  const fixture = jsonObject(value, label);
  return {
    id: jsonString(jsonValue(fixture, "id", label), `${label}.id`),
    index: jsonString(jsonValue(fixture, "index", label), `${label}.index`),
    origin_alias: jsonString(jsonValue(fixture, "origin_alias", label), `${label}.origin_alias`),
    skill_name: jsonString(jsonValue(fixture, "skill_name", label), `${label}.skill_name`),
  };
}

function decodeConsumerResult(value: unknown, label: string): ConsumerResult {
  const result = jsonObject(value, label);
  const frontmatter = jsonObject(jsonValue(result, "frontmatter", label), `${label}.frontmatter`);
  return {
    digest: jsonString(jsonValue(result, "digest", label), `${label}.digest`),
    files: decodeActivationResources(jsonValue(result, "files", label), `${label}.files`),
    frontmatter: {
      name: jsonString(
        jsonValue(frontmatter, "name", `${label}.frontmatter`),
        `${label}.frontmatter.name`,
      ),
    },
    name: jsonString(jsonValue(result, "name", label), `${label}.name`),
    origin_alias: jsonString(jsonValue(result, "origin_alias", label), `${label}.origin_alias`),
    requests: jsonNumber(jsonValue(result, "requests", label), `${label}.requests`),
  };
}

test("canonical publisher source tree has an exact reviewed inventory", () => {
  const contract = decodePublisherContract(readJson("fixtures/publisher/publisher-goldens.json"));

  assert.deepEqual(walkFiles("fixtures/publisher/source"), contract.source_files);
  assert.deepEqual(contract.formats, ["tar.gz", "zip"]);
  assert.deepEqual(
    contract.skills.map(({ name }) => name),
    ["code-review", "release-notes"],
  );
});

test("exact indexes and artifacts match static digest and metadata expectations", () => {
  const contract = decodePublisherContract(readJson("fixtures/publisher/publisher-goldens.json"));
  const expected = decodePublisherExpected(readJson("expected-results/publisher-results.json"));

  for (const format of contract.formats) {
    const golden = expected.formats[format];
    assert.ok(golden, `missing ${format} publisher golden`);
    assert.equal(golden.normalized_archive.directory_entries, "omitted");
    assert.equal(Object.hasOwn(golden.normalized_archive, "directory_mode"), false);
    const indexPath = resolve(protocolRoot, golden.index.path);
    const indexBytes = readFileSync(indexPath);
    const index = decodePublisherCatalog(JSON.parse(indexBytes.toString("utf8")), indexPath);
    assert.equal(sha256(indexBytes), golden.index.sha256);
    assert.equal(indexBytes.length, golden.index.bytes);
    assert.equal(indexBytes.at(-1), 0x0a);
    assert.equal(index.$schema, "https://schemas.agentskills.io/discovery/0.2.0/schema.json");
    assert.deepEqual(
      index.skills.map(({ name }) => name),
      ["code-review", "release-notes"],
    );
    for (const artifact of golden.artifacts) {
      const bytes = readFileSync(resolve(protocolRoot, artifact.path));
      assert.equal(sha256(bytes), artifact.sha256, artifact.path);
      assert.equal(bytes.length, artifact.bytes, artifact.path);
      assert.match(basename(artifact.path), new RegExp(`sha256-${artifact.sha256}\\.`));
      const entry = index.skills.find(({ name }) => name === artifact.skill);
      assert.ok(entry);
      assert.equal(entry.digest, `sha256:${artifact.sha256}`);
      assert.equal(entry.url, `artifacts/${basename(artifact.path)}`);
    }
  }
});

test("publisher consumer cases map to exact normalized activation outcomes", () => {
  const fixtures = jsonCaseDocument(
    readJson("fixtures/publisher/consumer-cases.json"),
    "publisher consumer fixtures",
    decodeConsumerFixture,
  );
  const expected = jsonCaseDocument(
    readJson("expected-results/publisher-activation-results.json"),
    "publisher activation results",
    (item, label) => {
      const entry = jsonObject(item, label);
      return {
        id: jsonString(jsonValue(entry, "id", label), `${label}.id`),
        result: decodeConsumerResult(jsonValue(entry, "result", label), `${label}.result`),
      };
    },
  );
  assert.deepEqual(
    fixtures.cases.map(({ id }) => id),
    expected.cases.map(({ id }) => id),
  );
  for (let index = 0; index < fixtures.cases.length; index += 1) {
    const fixture = fixtures.cases[index];
    const expectedCase = expected.cases[index];
    assert.ok(fixture && expectedCase);
    const result = expectedCase.result;
    const catalog = decodePublisherCatalog(
      readJson(`fixtures/publisher/${fixture.index}`),
      `fixtures/publisher/${fixture.index}`,
    );
    const entry = catalog.skills.find(({ name }) => name === fixture.skill_name);
    assert.ok(entry, fixture.id);
    assert.equal(result.name, fixture.skill_name);
    assert.equal(result.origin_alias, fixture.origin_alias);
    assert.equal(result.digest, entry.digest);
    assert.equal(result.frontmatter.name, result.name);
    assert.equal(result.requests, 2);
  }
});

test("independent SHA-256 manifest covers every canonical source and golden byte", () => {
  const manifest = readSha256Manifest("manifests/publisher-goldens.sha256");
  const expectedPaths = walkFiles("fixtures/publisher")
    .filter(
      (path) => !path.endsWith("publisher-goldens.json") && !path.endsWith("consumer-cases.json"),
    )
    .sort();

  assert.deepEqual(
    manifest.map(({ path }) => path),
    expectedPaths,
  );
  for (const entry of manifest) {
    assert.equal(sha256(readFileSync(resolve(protocolRoot, entry.path))), entry.digest, entry.path);
  }
});

test("independent unpack-and-repack implementation reproduces both archive bytes", () => {
  const result = spawnTextSync(
    "python3",
    [resolve(protocolRoot, "tools/repack_publisher_goldens.py")],
    {
      cwd: protocolRoot,
    },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(
    result.stdout,
    "repacked 2 publisher archives byte-identically; verified 8 canonical source files\n",
  );
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  jsonArray,
  jsonBoolean,
  jsonCaseDocument,
  jsonNumber,
  jsonObject,
  jsonOptionalNumber,
  jsonOptionalString,
  jsonString,
  jsonStringArray,
  jsonValue,
  protocolRoot,
  readJson,
  sha256,
  spawnTextSync,
  walkFiles,
} from "./helpers/contract-helpers.ts";

const indexUrl = "https://skills.example.test/.well-known/agent-skills/index.json";
const engineeringPreimage = `${indexUrl}\nremote-skills-scope:engineering`;
const salesPreimage = `${indexUrl}\nremote-skills-scope:sales`;
const engineeringIdentifier = "9dc5c74ba396dc5b65ff423600466f65b6d0a1bfca3eb6866345481f98de17a9";
const salesIdentifier = "33b69d221d0f33ecd41214ff994db654c893de1745a26652ee3a49d379844d7e";

const requiredCacheCategories = [
  "crashed_lease",
  "cross_process",
  "partial_writer",
  "unknown_layout",
  "versioned_layout",
];

const requiredNetworkCategories = [
  "credential_forwarding",
  "dns_ip_policy",
  "http_validator",
  "offline",
  "redirect",
  "removal",
  "retry",
];

interface CacheFixture {
  after?: string;
  before?: string;
  category: string;
  evaluation_inputs?: string;
  files: string[];
  id: string;
  state: string;
}

interface NetworkFixture {
  category: string;
  id: string;
  scenario: string;
}

interface MetadataSchema {
  optional: string[];
  required: string[];
  schema?: string;
  types: { [field: string]: string };
}

interface CacheLayout {
  coordination_lifecycle: string[];
  metadata_forbidden_fields: string[];
  metadata_schemas: {
    catalog: MetadataSchema;
    eviction: MetadataSchema;
    extraction_file: MetadataSchema;
    lease: MetadataSchema;
    mutation_intent: MetadataSchema;
    mutation_lock: MetadataSchema;
    object: MetadataSchema;
    writer: MetadataSchema;
  };
  namespace: string;
  origin_identifier: {
    example_identifier: string;
    example_url: string;
    forbidden_inputs: string[];
    scoped_example_identifier: string;
    scoped_example_scope: string;
  };
}

interface CacheObjectMetadata {
  artifact_bytes: number;
  digest: string;
  extracted_bytes: number;
  files: { size: number }[];
}

interface EvaluationInputs {
  lease_expiry_seconds: number;
  now: string;
  process_liveness: { [pid: string]: boolean };
}

interface NetworkResult {
  attempts?: number;
  outcome: string;
  requests?: number;
}

function decodeCacheFixture(value: unknown, label: string): CacheFixture {
  const fixture = jsonObject(value, label);
  const after = jsonOptionalString(fixture, "after", label);
  const before = jsonOptionalString(fixture, "before", label);
  const evaluationInputs = jsonOptionalString(fixture, "evaluation_inputs", label);
  return {
    category: jsonString(jsonValue(fixture, "category", label), `${label}.category`),
    files: jsonStringArray(jsonValue(fixture, "files", label), `${label}.files`),
    id: jsonString(jsonValue(fixture, "id", label), `${label}.id`),
    state: jsonString(jsonValue(fixture, "state", label), `${label}.state`),
    ...(after === undefined ? {} : { after }),
    ...(before === undefined ? {} : { before }),
    ...(evaluationInputs === undefined ? {} : { evaluation_inputs: evaluationInputs }),
  };
}

function decodeNetworkFixture(value: unknown, label: string): NetworkFixture {
  const fixture = jsonObject(value, label);
  return {
    category: jsonString(jsonValue(fixture, "category", label), `${label}.category`),
    id: jsonString(jsonValue(fixture, "id", label), `${label}.id`),
    scenario: jsonString(jsonValue(fixture, "scenario", label), `${label}.scenario`),
  };
}

function decodeMetadataSchema(value: unknown, label: string): MetadataSchema {
  const schema = jsonObject(value, label);
  const schemaName = jsonOptionalString(schema, "schema", label);
  const rawTypes = Object.hasOwn(schema, "types")
    ? jsonObject(jsonValue(schema, "types", label), `${label}.types`)
    : undefined;
  const types: { [field: string]: string } = {};
  if (rawTypes) {
    for (const [field, type] of Object.entries(rawTypes)) {
      types[field] = jsonString(type, `${label}.types.${field}`);
    }
  }
  return {
    optional: jsonStringArray(jsonValue(schema, "optional", label), `${label}.optional`),
    required: jsonStringArray(jsonValue(schema, "required", label), `${label}.required`),
    ...(schemaName === undefined ? {} : { schema: schemaName }),
    types,
  };
}

function decodeCacheLayout(value: unknown): CacheLayout {
  const layout = jsonObject(value, "cache layout");
  const schemas = jsonObject(
    jsonValue(layout, "metadata_schemas", "cache layout"),
    "metadata schemas",
  );
  const origin = jsonObject(
    jsonValue(layout, "origin_identifier", "cache layout"),
    "origin identifier",
  );
  return {
    coordination_lifecycle: jsonStringArray(
      jsonValue(layout, "coordination_lifecycle", "cache layout"),
      "cache layout.coordination_lifecycle",
    ),
    metadata_forbidden_fields: jsonStringArray(
      jsonValue(layout, "metadata_forbidden_fields", "cache layout"),
      "cache layout.metadata_forbidden_fields",
    ),
    metadata_schemas: {
      catalog: decodeMetadataSchema(
        jsonValue(schemas, "catalog", "metadata schemas"),
        "metadata schemas.catalog",
      ),
      eviction: decodeMetadataSchema(
        jsonValue(schemas, "eviction", "metadata schemas"),
        "metadata schemas.eviction",
      ),
      extraction_file: decodeMetadataSchema(
        jsonValue(schemas, "extraction_file", "metadata schemas"),
        "metadata schemas.extraction_file",
      ),
      lease: decodeMetadataSchema(
        jsonValue(schemas, "lease", "metadata schemas"),
        "metadata schemas.lease",
      ),
      mutation_intent: decodeMetadataSchema(
        jsonValue(schemas, "mutation_intent", "metadata schemas"),
        "metadata schemas.mutation_intent",
      ),
      mutation_lock: decodeMetadataSchema(
        jsonValue(schemas, "mutation_lock", "metadata schemas"),
        "metadata schemas.mutation_lock",
      ),
      object: decodeMetadataSchema(
        jsonValue(schemas, "object", "metadata schemas"),
        "metadata schemas.object",
      ),
      writer: decodeMetadataSchema(
        jsonValue(schemas, "writer", "metadata schemas"),
        "metadata schemas.writer",
      ),
    },
    namespace: jsonString(jsonValue(layout, "namespace", "cache layout"), "cache layout.namespace"),
    origin_identifier: {
      example_identifier: jsonString(
        jsonValue(origin, "example_identifier", "origin identifier"),
        "origin identifier.example_identifier",
      ),
      example_url: jsonString(
        jsonValue(origin, "example_url", "origin identifier"),
        "origin identifier.example_url",
      ),
      forbidden_inputs: jsonStringArray(
        jsonValue(origin, "forbidden_inputs", "origin identifier"),
        "origin identifier.forbidden_inputs",
      ),
      scoped_example_identifier: jsonString(
        jsonValue(origin, "scoped_example_identifier", "origin identifier"),
        "origin identifier.scoped_example_identifier",
      ),
      scoped_example_scope: jsonString(
        jsonValue(origin, "scoped_example_scope", "origin identifier"),
        "origin identifier.scoped_example_scope",
      ),
    },
  };
}

function decodeId(value: unknown, label: string): { id: string } {
  const item = jsonObject(value, label);
  return { id: jsonString(jsonValue(item, "id", label), `${label}.id`) };
}

function decodeEvaluationInputs(value: unknown): EvaluationInputs {
  const inputs = jsonObject(value, "cache evaluation inputs");
  const rawLiveness = jsonObject(
    jsonValue(inputs, "process_liveness", "cache evaluation inputs"),
    "cache evaluation inputs.process_liveness",
  );
  const process_liveness: { [pid: string]: boolean } = {};
  for (const [pid, live] of Object.entries(rawLiveness)) {
    process_liveness[pid] = jsonBoolean(live, `cache evaluation inputs.process_liveness.${pid}`);
  }
  return {
    lease_expiry_seconds: jsonNumber(
      jsonValue(inputs, "lease_expiry_seconds", "cache evaluation inputs"),
      "cache evaluation inputs.lease_expiry_seconds",
    ),
    now: jsonString(
      jsonValue(inputs, "now", "cache evaluation inputs"),
      "cache evaluation inputs.now",
    ),
    process_liveness,
  };
}

function decodeCacheObjectMetadata(value: unknown, label: string): CacheObjectMetadata {
  const metadata = jsonObject(value, label);
  return {
    artifact_bytes: jsonNumber(
      jsonValue(metadata, "artifact_bytes", label),
      `${label}.artifact_bytes`,
    ),
    digest: jsonString(jsonValue(metadata, "digest", label), `${label}.digest`),
    extracted_bytes: jsonNumber(
      jsonValue(metadata, "extracted_bytes", label),
      `${label}.extracted_bytes`,
    ),
    files: jsonArray(jsonValue(metadata, "files", label), `${label}.files`).map((item, index) => {
      const file = jsonObject(item, `${label}.files[${index}]`);
      return {
        size: jsonNumber(
          jsonValue(file, "size", `${label}.files[${index}]`),
          `${label}.files[${index}].size`,
        ),
      };
    }),
  };
}

function decodeNetworkResults(value: unknown): { cases: { id: string; result: NetworkResult }[] } {
  return jsonCaseDocument(value, "network results", (item, label) => {
    const entry = jsonObject(item, label);
    const resultLabel = `${label}.result`;
    const result = jsonObject(jsonValue(entry, "result", label), resultLabel);
    const attempts = jsonOptionalNumber(result, "attempts", resultLabel);
    const requests = jsonOptionalNumber(result, "requests", resultLabel);
    return {
      id: jsonString(jsonValue(entry, "id", label), `${label}.id`),
      result: {
        outcome: jsonString(jsonValue(result, "outcome", resultLabel), `${resultLabel}.outcome`),
        ...(attempts === undefined ? {} : { attempts }),
        ...(requests === undefined ? {} : { requests }),
      },
    };
  });
}

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

function collectKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, keys);
  } else if (isObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      keys.add(key.toLowerCase());
      collectKeys(item, keys);
    }
  }
  return keys;
}

function assertSchema(value: unknown, schema: MetadataSchema, label: string): void {
  assert.ok(isObject(value), `${label} must be an object`);
  const allowed = new Set([...schema.required, ...schema.optional]);
  assert.deepEqual(
    Object.keys(value).sort(),
    [...allowed].filter((key) => Object.hasOwn(value, key)).sort(),
    label,
  );
  for (const field of schema.required)
    assert.ok(Object.hasOwn(value, field), `${label} omits ${field}`);
  if (schema.schema) assert.equal(Reflect.get(value, "schema"), schema.schema, `${label}.schema`);
  for (const [field, type] of Object.entries(schema.types ?? {})) {
    if (!Object.hasOwn(value, field)) continue;
    const item: unknown = Reflect.get(value, field);
    if (type === "integer") {
      assert.ok(typeof item === "number");
      assert.ok(Number.isSafeInteger(item) && item >= 0, `${label}.${field}`);
    } else if (type === "string") assert.equal(typeof item, "string", `${label}.${field}`);
    else if (type === "nullable_string")
      assert.ok(item === null || typeof item === "string", `${label}.${field}`);
    else if (type === "timestamp") {
      assert.ok(typeof item === "string");
      assert.match(item, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/, `${label}.${field}`);
    } else if (type === "boolean") assert.equal(typeof item, "boolean", `${label}.${field}`);
    else if (type === "digest") {
      assert.ok(typeof item === "string");
      assert.match(item, /^sha256:[0-9a-f]{64}$/, `${label}.${field}`);
    } else if (type === "sanitized_url") {
      assert.ok(typeof item === "string");
      assert.equal(/[?#]/.test(item), false, `${label}.${field}`);
    } else if (type === "normalized_path") {
      assert.ok(typeof item === "string");
      assert.equal(/(?:^\/|\\|\.\.)/.test(item), false, `${label}.${field}`);
    } else if (type === "string_array")
      assert.ok(
        Array.isArray(item) && item.every((entry) => typeof entry === "string"),
        `${label}.${field}`,
      );
    else if (type === "extraction_file_array") assert.ok(Array.isArray(item), `${label}.${field}`);
    else assert.fail(`${label}.${field} has unknown contract type ${type}`);
  }
}

test("cache fixtures define the cache-v1 layout and every recovery state", () => {
  const registry = jsonCaseDocument(
    readJson("fixtures/cache/cache-cases.json"),
    "cache fixtures",
    decodeCacheFixture,
  );
  const layout = decodeCacheLayout(readJson("contracts/v0/cache-layout.json"));
  const expected = jsonCaseDocument(
    readJson("expected-results/cache-results.json"),
    "cache results",
    decodeId,
  );

  assert.equal(layout.namespace, "cache-v1");
  assert.ok(layout.metadata_schemas.lease.required.includes("lease_nonce"));
  assert.ok(layout.metadata_schemas.mutation_lock.optional.includes("operation"));
  assert.ok(layout.metadata_schemas.mutation_lock.optional.includes("contended_with_eviction"));
  assert.ok(layout.metadata_schemas.mutation_intent.optional.includes("contended_with_eviction"));
  assert.ok(
    layout.coordination_lifecycle.includes(
      "reclaim_orphan_process_registrations_without_a_lease_writer_or_object",
    ),
  );
  assert.ok(
    layout.coordination_lifecycle.includes(
      "remove_orphan_lease_generation_records_and_empty_coordination_directories",
    ),
  );
  assert.ok(
    layout.coordination_lifecycle.includes(
      "serialize_each_digest_lease_acquisition_against_final_eviction_pin_check_through_removal",
    ),
  );
  assert.ok(
    layout.coordination_lifecycle.includes(
      "anchor_object_generation_identity_with_retained_no_follow_directory_chain_before_announcing_a_lease_acquisition",
    ),
  );
  assert.ok(
    layout.coordination_lifecycle.includes(
      "reject_before_lease_publication_if_an_observed_object_generation_was_removed",
    ),
  );
  assert.ok(
    layout.coordination_lifecycle.includes(
      "persist_an_observed_predecessor_eviction_handoff_in_the_successor_ticket_generation",
    ),
  );
  assert.deepEqual(
    [...new Set(registry.cases.map(({ category }) => category))].sort(),
    requiredCacheCategories,
  );
  assert.deepEqual(
    registry.cases.map(({ id }) => id),
    expected.cases.map(({ id }) => id),
  );
  for (const fixture of registry.cases.filter(({ state }) => state)) {
    const actualFiles = walkFiles(`fixtures/cache/states/${fixture.state}`).map((path) =>
      path.replace(`fixtures/cache/states/${fixture.state}/`, ""),
    );
    assert.deepEqual(actualFiles, fixture.files, fixture.id);
    for (const path of actualFiles.filter((path) => path.endsWith(".json"))) {
      const keys = collectKeys(readJson(`fixtures/cache/states/${fixture.state}/${path}`));
      for (const forbidden of layout.metadata_forbidden_fields) {
        assert.equal(
          keys.has(forbidden),
          false,
          `${fixture.id} stores forbidden field ${forbidden}`,
        );
      }
    }
  }
});

test("cache race and lease decisions use explicit clocks, liveness, and before/after states", () => {
  const registry = jsonCaseDocument(
    readJson("fixtures/cache/cache-cases.json"),
    "cache fixtures",
    decodeCacheFixture,
  );
  for (const id of ["cache-v1-valid", "cache-v1-crashed-lease", "cache-v1-cross-process"]) {
    const fixture = registry.cases.find((candidate) => candidate.id === id);
    assert.ok(fixture?.evaluation_inputs, `${id} omits evaluation_inputs`);
    const inputs = decodeEvaluationInputs(
      readJson(`fixtures/cache/states/${fixture.state}/${fixture.evaluation_inputs}`),
    );
    assert.match(inputs.now, /^2026-08-25T\d\d:\d\d:\d\d\.000Z$/);
    assert.equal(typeof inputs.lease_expiry_seconds, "number");
    assert.ok(Object.keys(inputs.process_liveness).length > 0);
  }

  const race = registry.cases.find(({ id }) => id === "cache-v1-cross-process");
  assert.ok(race);
  assert.ok(race.before && race.after);
  const before = walkFiles(`fixtures/cache/states/${race.state}/${race.before}`);
  const after = walkFiles(`fixtures/cache/states/${race.state}/${race.after}`);
  assert.ok(before.some((path) => path.includes("/tmp/writer-python-0002/")));
  assert.ok(before.some((path) => path.includes("/tmp/writer-typescript-0001/")));
  assert.ok(after.some((path) => path.endsWith("/object.json")));
  assert.ok(after.some((path) => path.endsWith("/artifact")));
  assert.equal(
    after.some((path) => path.includes("/tmp/")),
    false,
  );
  const objectPath = after.find((path) => path.endsWith("/object.json"));
  const artifactPath = after.find((path) => path.endsWith("/artifact"));
  assert.ok(objectPath && artifactPath);
  const metadata = decodeCacheObjectMetadata(readJson(objectPath), objectPath);
  assert.equal(
    sha256(readFileSync(resolve(protocolRoot, artifactPath))),
    metadata.digest.replace("sha256:", ""),
  );
});

test("cache identifiers and immutable object paths agree with their exact bytes", () => {
  const layout = decodeCacheLayout(readJson("contracts/v0/cache-layout.json"));
  const registry = jsonCaseDocument(
    readJson("fixtures/cache/cache-cases.json"),
    "cache fixtures",
    decodeCacheFixture,
  );

  assert.equal(
    sha256(Buffer.from(layout.origin_identifier.example_url, "utf8")),
    layout.origin_identifier.example_identifier,
  );
  assert.equal(layout.origin_identifier.example_url, indexUrl);
  assert.equal(sha256(Buffer.from(engineeringPreimage, "utf8")), engineeringIdentifier);
  assert.equal(sha256(Buffer.from(salesPreimage, "utf8")), salesIdentifier);
  assert.equal(layout.origin_identifier.scoped_example_scope, "engineering");
  assert.equal(layout.origin_identifier.scoped_example_identifier, engineeringIdentifier);
  assert.notEqual(engineeringIdentifier, salesIdentifier);
  assert.notEqual(engineeringIdentifier, layout.origin_identifier.example_identifier);
  assert.notEqual(salesIdentifier, layout.origin_identifier.example_identifier);
  assert.deepEqual(layout.origin_identifier.forbidden_inputs, [
    "headers",
    "credentials",
    "credential hashes",
    "URL fragment",
  ]);
  assert.ok(layout.metadata_schemas.catalog.optional.includes("confirmed_scope"));
  assert.equal(layout.metadata_schemas.catalog.types.confirmed_scope, "string");
  assert.ok(layout.metadata_forbidden_fields.includes("requested_scope"));
  for (const fixture of registry.cases.filter(({ id }) =>
    ["cache-v1-valid", "cache-v1-crashed-lease"].includes(id),
  )) {
    const stateRoot = `fixtures/cache/states/${fixture.state}/`;
    const artifactPath = fixture.files.find((path) => path.endsWith("/artifact"));
    const metadataPath = fixture.files.find((path) => path.endsWith("/object.json"));
    const rootPath = fixture.files.find((path) => path.endsWith("/root/SKILL.md"));
    assert.ok(artifactPath && metadataPath && rootPath);
    const metadata = decodeCacheObjectMetadata(
      readJson(`${stateRoot}${metadataPath}`),
      `${stateRoot}${metadataPath}`,
    );
    const expectedDigest = metadata.digest.replace("sha256:", "");
    const artifact = readFileSync(resolve(protocolRoot, stateRoot, artifactPath));
    const extractedRoot = readFileSync(resolve(protocolRoot, stateRoot, rootPath));
    assert.equal(sha256(artifact), expectedDigest);
    assert.equal(sha256(extractedRoot), expectedDigest);
    assert.equal(metadata.artifact_bytes, artifact.length);
    assert.equal(metadata.extracted_bytes, extractedRoot.length);
    const extractedFile = metadata.files[0];
    assert.ok(extractedFile);
    assert.equal(extractedFile.size, extractedRoot.length);
    assert.ok(
      artifactPath.includes(`/sha256/${expectedDigest.slice(0, 2)}/${expectedDigest.slice(2)}/`),
    );
  }
});

test("every cache metadata fixture conforms to the interoperable cache-v1 schemas", () => {
  const layout = decodeCacheLayout(readJson("contracts/v0/cache-layout.json"));
  const registry = jsonCaseDocument(
    readJson("fixtures/cache/cache-cases.json"),
    "cache fixtures",
    decodeCacheFixture,
  );
  const schemas = layout.metadata_schemas;
  for (const fixture of registry.cases.filter(({ state }) => state)) {
    for (const path of fixture.files) {
      let schema: MetadataSchema | undefined;
      if (path.endsWith("/metadata.json")) schema = schemas.catalog;
      else if (path.endsWith("/object.json")) schema = schemas.object;
      else if (path.includes("/leases/") && path.endsWith(".json")) schema = schemas.lease;
      else if (path.endsWith("/writer.json")) schema = schemas.writer;
      else if (path.endsWith("/eviction.json")) schema = schemas.eviction;
      if (!schema) continue;
      const value = readJson(`fixtures/cache/states/${fixture.state}/${path}`);
      assertSchema(value, schema, `${fixture.id}:${path}`);
      if (schema === schemas.object) {
        assert.ok(isObject(value));
        const files: unknown = Reflect.get(value, "files");
        assert.ok(Array.isArray(files));
        for (const file of files)
          assertSchema(file, schemas.extraction_file, `${fixture.id}:${path}:file`);
      }
    }
  }
});

test("network fixtures cover validators, redirects, address policy, retries, offline, removal, and headers", () => {
  const registry = jsonCaseDocument(
    readJson("fixtures/network/network-cases.json"),
    "network fixtures",
    decodeNetworkFixture,
  );
  const expected = decodeNetworkResults(readJson("expected-results/network-results.json"));

  assert.deepEqual(
    [...new Set(registry.cases.map(({ category }) => category))].sort(),
    requiredNetworkCategories,
  );
  assert.deepEqual(
    registry.cases.map(({ id }) => id),
    expected.cases.map(({ id }) => id),
  );
  assert.ok(registry.cases.filter(({ category }) => category === "dns_ip_policy").length >= 8);
  assert.ok(registry.cases.filter(({ category }) => category === "redirect").length >= 4);
  for (const fixture of registry.cases) {
    const [path, anchor] = fixture.scenario.split("#");
    assert.ok(
      path &&
        anchor &&
        Object.hasOwn(jsonObject(readJson(`fixtures/network/${path}`), path), anchor),
      fixture.id,
    );
  }

  const referenced = registry.cases.map(({ scenario }) => scenario).sort();
  const declared = [
    "credential-forwarding.json",
    "dns-ip-policy.json",
    "http-validator.json",
    "offline-removal.json",
    "redirects.json",
    "retry-schedule.json",
  ]
    .flatMap((path) =>
      Object.keys(jsonObject(readJson(`fixtures/network/${path}`), path))
        .filter((anchor) => !anchor.startsWith("$"))
        .filter((anchor) => !anchor.startsWith("version-removal-"))
        .map((anchor) => `${path}#${anchor}`),
    )
    .sort();
  assert.deepEqual(referenced, declared, "every declared network anchor must be registered once");
  assert.ok(registry.cases.some(({ id }) => id === "ip-dns-rebinding"));
  for (const id of [
    "ip-unique-local-v6",
    "ip-link-local-v6",
    "ip-multicast-v6",
    "ip-unspecified-v6",
    "ip-mapped-loopback-v6",
    "ip-mapped-private-v6",
    "ip-mapped-public-v6",
  ]) {
    assert.ok(
      registry.cases.some((fixture) => fixture.id === id),
      `${id} is not registered`,
    );
  }

  const retryDisabled = registry.cases.find(({ id }) => id === "retry-disabled-transient");
  assert.ok(retryDisabled, "per-origin retries:0 is not registered");
  const [retryPath, retryAnchor] = retryDisabled.scenario.split("#");
  assert.ok(retryPath && retryAnchor);
  const retryDocument = jsonObject(readJson(`fixtures/network/${retryPath}`), retryPath);
  const retryScenario = jsonObject(
    jsonValue(retryDocument, retryAnchor, retryPath),
    `${retryPath}#${retryAnchor}`,
  );
  const perOrigin = jsonObject(
    jsonValue(retryScenario, "per_origin", retryAnchor),
    `${retryAnchor}.per_origin`,
  );
  assert.equal(
    jsonNumber(
      jsonValue(perOrigin, "retries", `${retryAnchor}.per_origin`),
      `${retryAnchor}.per_origin.retries`,
    ),
    0,
  );
  const retryExpected = expected.cases.find(({ id }) => id === retryDisabled.id);
  assert.ok(retryExpected);
  const retryResult = retryExpected.result;
  assert.equal(retryResult.outcome, "request_error");
  assert.equal(retryResult.requests, 1);
  assert.equal(retryResult.attempts, 1);
});

test("fixture server records the exact sanitized requests and no secret values", () => {
  const result = spawnTextSync(
    "node",
    [resolve(protocolRoot, "tools/fixture-server.ts"), "--self-test"],
    {
      cwd: protocolRoot,
    },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout, "fixture server verified 4 exact requests; secret snapshots 0\n");
});

test("no checked-in cache, network, transcript, or diagnostic contains the runtime secret canary", () => {
  const syntheticCanary = ["RMS", "SYNTHETIC", "SECRET", "CANARY", "8F0D2A7C"].join("_");
  const scopedFiles = walkFiles(".").filter((path) =>
    /(?:cache|network|request|redaction|diagnostic)/.test(path),
  );

  assert.ok(scopedFiles.length > 10);
  for (const path of scopedFiles) {
    assert.equal(
      readFileSync(resolve(protocolRoot, path)).includes(syntheticCanary),
      false,
      `${path} contains the runtime secret canary`,
    );
  }
});

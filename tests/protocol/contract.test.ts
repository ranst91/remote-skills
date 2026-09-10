import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  jsonArray,
  jsonBoolean,
  jsonCaseDocument,
  jsonNumber,
  jsonObject,
  jsonString,
  jsonStringArray,
  jsonValue,
  protocolRoot,
  readJson,
  spawnTextSync,
  walkFiles,
} from "./helpers/contract-helpers.ts";

const requiredErrorCodes = [
  "archive_unsafe",
  "artifact_unsupported",
  "authentication_failed",
  "authorization_denied",
  "cache_corrupt",
  "catalog_invalid",
  "configuration_invalid",
  "digest_mismatch",
  "limit_exceeded",
  "origin_unavailable",
  "path_invalid",
  "policy_denied",
  "request_timeout",
  "resource_not_found",
  "resource_not_text",
  "session_closed",
  "skill_not_found",
  "unsupported_schema",
  "version_unavailable",
];

interface NormalizedResultView {
  [field: string]: unknown;
  error?: object;
  outcome: string;
}

function decodeErrorContract(value: unknown) {
  const contract = jsonObject(value, "error contract");
  return {
    allowed_context_fields: jsonStringArray(
      jsonValue(contract, "allowed_context_fields", "error contract"),
      "error contract.allowed_context_fields",
    ),
    contract_version: jsonNumber(
      jsonValue(contract, "contract_version", "error contract"),
      "error contract.contract_version",
    ),
    errors: jsonArray(jsonValue(contract, "errors", "error contract"), "error contract.errors").map(
      (item, index) => {
        const label = `error contract.errors[${index}]`;
        const error = jsonObject(item, label);
        return {
          code: jsonString(jsonValue(error, "code", label), `${label}.code`),
          context: jsonStringArray(jsonValue(error, "context", label), `${label}.context`),
          retryable: jsonBoolean(jsonValue(error, "retryable", label), `${label}.retryable`),
        };
      },
    ),
  };
}

function decodeNormalizedContract(value: unknown) {
  const contract = jsonObject(value, "normalized contract");
  const rawShapes = jsonObject(
    jsonValue(contract, "shapes", "normalized contract"),
    "normalized contract.shapes",
  );
  const shapes: { [outcome: string]: { outcome: string; required: string[] } } = {};
  for (const [name, value_] of Object.entries(rawShapes)) {
    const label = `normalized contract.shapes.${name}`;
    const shape = jsonObject(value_, label);
    shapes[name] = {
      outcome: jsonString(jsonValue(shape, "outcome", label), `${label}.outcome`),
      required: jsonStringArray(jsonValue(shape, "required", label), `${label}.required`),
    };
  }
  const rawErrorShape = jsonObject(
    jsonValue(contract, "error_shape", "normalized contract"),
    "normalized contract.error_shape",
  );
  const rawConventions = jsonObject(
    jsonValue(contract, "conventions", "normalized contract"),
    "normalized contract.conventions",
  );
  return {
    conventions: {
      absent_optional_fields: jsonString(
        jsonValue(rawConventions, "absent_optional_fields", "normalized contract.conventions"),
        "normalized contract.conventions.absent_optional_fields",
      ),
      digest: jsonString(
        jsonValue(rawConventions, "digest", "normalized contract.conventions"),
        "normalized contract.conventions.digest",
      ),
      error_code: jsonString(
        jsonValue(rawConventions, "error_code", "normalized contract.conventions"),
        "normalized contract.conventions.error_code",
      ),
      json_encoding: jsonString(
        jsonValue(rawConventions, "json_encoding", "normalized contract.conventions"),
        "normalized contract.conventions.json_encoding",
      ),
      path_separator: jsonString(
        jsonValue(rawConventions, "path_separator", "normalized contract.conventions"),
        "normalized contract.conventions.path_separator",
      ),
    },
    error_shape: {
      required: jsonStringArray(
        jsonValue(rawErrorShape, "required", "normalized contract.error_shape"),
        "normalized contract.error_shape.required",
      ),
    },
    shapes,
  };
}

function decodeNormalizedResult(value: unknown, label: string): NormalizedResultView {
  const result = jsonObject(value, label);
  const outcome = jsonString(jsonValue(result, "outcome", label), `${label}.outcome`);
  if (!Object.hasOwn(result, "error")) return { ...result, outcome };
  const error = jsonObject(jsonValue(result, "error", label), `${label}.error`);
  return { ...result, error, outcome };
}

function decodeNormalizedCases(value: unknown, label: string) {
  return jsonCaseDocument(value, label, (item, itemLabel) => {
    const entry = jsonObject(item, itemLabel);
    return {
      id: jsonString(jsonValue(entry, "id", itemLabel), `${itemLabel}.id`),
      result: decodeNormalizedResult(jsonValue(entry, "result", itemLabel), `${itemLabel}.result`),
    };
  });
}

function decodeCatalogFixtures(value: unknown) {
  return jsonCaseDocument(value, "catalog fixtures", (item, label) => {
    const fixture = jsonObject(item, label);
    return {
      id: jsonString(jsonValue(fixture, "id", label), `${label}.id`),
      input: jsonString(jsonValue(fixture, "input", label), `${label}.input`),
    };
  });
}

function decodeRequestCases(value: unknown, label: string) {
  return jsonCaseDocument(value, label, (item, itemLabel) => {
    const entry = jsonObject(item, itemLabel);
    return {
      id: jsonString(jsonValue(entry, "id", itemLabel), `${itemLabel}.id`),
      requests: jsonArray(jsonValue(entry, "requests", itemLabel), `${itemLabel}.requests`).map(
        (request, index) => jsonObject(request, `${itemLabel}.requests[${index}]`),
      ),
    };
  });
}

function decodeRedactionPolicy(value: unknown) {
  const policy = jsonObject(value, "redaction policy");
  return {
    never_snapshot_fields: jsonStringArray(
      jsonValue(policy, "never_snapshot_fields", "redaction policy"),
      "redaction policy.never_snapshot_fields",
    ),
    snapshot_replacement: jsonString(
      jsonValue(policy, "snapshot_replacement", "redaction policy"),
      "redaction policy.snapshot_replacement",
    ),
  };
}

function decodeRedactionFixtures(value: unknown) {
  return jsonCaseDocument(value, "redaction fixtures", (item, label) => {
    const fixture = jsonObject(item, label);
    const request = jsonObject(jsonValue(fixture, "request", label), `${label}.request`);
    const configured = Object.hasOwn(request, "configured_secret_header_names")
      ? jsonStringArray(
          jsonValue(request, "configured_secret_header_names", `${label}.request`),
          `${label}.request.configured_secret_header_names`,
        )
      : undefined;
    return {
      id: jsonString(jsonValue(fixture, "id", label), `${label}.id`),
      request: configured === undefined ? {} : { configured_secret_header_names: configured },
    };
  });
}

function decodeAdapterContract(value: unknown) {
  const contract = jsonObject(value, "adapter contract");
  const decodeStringObject = (key: string) => {
    const raw = jsonObject(jsonValue(contract, key, "adapter contract"), `adapter contract.${key}`);
    return {
      python: jsonString(
        jsonValue(raw, "python", `adapter contract.${key}`),
        `adapter contract.${key}.python`,
      ),
      typescript: jsonString(
        jsonValue(raw, "typescript", `adapter contract.${key}`),
        `adapter contract.${key}.typescript`,
      ),
    };
  };
  const decodeSuites = (key: string) =>
    jsonArray(jsonValue(contract, key, "adapter contract"), `adapter contract.${key}`).map(
      (item, index) => {
        const label = `adapter contract.${key}[${index}]`;
        const suite = jsonObject(item, label);
        return { name: jsonString(jsonValue(suite, "name", label), `${label}.name`) };
      },
    );
  return {
    case_api: decodeStringObject("case_api"),
    contract_version: jsonNumber(
      jsonValue(contract, "contract_version", "adapter contract"),
      "adapter contract.contract_version",
    ),
    entrypoints: decodeStringObject("entrypoints"),
    expected_state: jsonString(
      jsonValue(contract, "expected_state", "adapter contract"),
      "adapter contract.expected_state",
    ),
    suites: decodeSuites("suites"),
    supplemental_suites: decodeSuites("supplemental_suites"),
  };
}

function runValidatorMutation(prefix: string, mutate: (mutationRoot: string) => void) {
  const mutationRoot = mkdtempSync(resolve(tmpdir(), prefix));
  try {
    cpSync(resolve(protocolRoot, "contracts"), resolve(mutationRoot, "contracts"), {
      recursive: true,
    });
    cpSync(resolve(protocolRoot, "expected-results"), resolve(mutationRoot, "expected-results"), {
      recursive: true,
    });
    mutate(mutationRoot);
    return spawnTextSync(
      process.execPath,
      [resolve(protocolRoot, "tools/validate-contract-results.ts"), mutationRoot],
      { cwd: protocolRoot },
    );
  } finally {
    rmSync(mutationRoot, { recursive: true, force: true });
  }
}

test("v0 defines the complete stable error-code vocabulary", () => {
  const contract = decodeErrorContract(readJson("contracts/v0/error-codes.json"));

  assert.equal(contract.contract_version, 1);
  assert.deepEqual(
    contract.errors.map(({ code }) => code),
    requiredErrorCodes,
  );
  for (const error of contract.errors) {
    assert.match(error.code, /^[a-z]+(?:_[a-z]+)*$/);
    assert.equal(
      error.retryable,
      error.code === "origin_unavailable" || error.code === "request_timeout",
    );
    assert.ok(
      error.context.every((field: string) => contract.allowed_context_fields.includes(field)),
    );
  }
  for (const [code, context] of [
    ["authentication_failed", ["origin_alias", "scope", "status"]],
    ["authorization_denied", ["origin_alias", "scope", "status"]],
    ["version_unavailable", ["origin_alias", "skill_name", "requested_range"]],
  ]) {
    const error = contract.errors.find((candidate) => candidate.code === code);
    assert.deepEqual(error, { code, retryable: false, context });
  }
});

test("normalized result shapes are versioned and language-neutral", () => {
  const contract = decodeNormalizedContract(readJson("contracts/v0/normalized-results.json"));

  assert.deepEqual(Object.keys(contract.shapes).sort(), [
    "activation_error",
    "activation_success",
    "aggregate_catalog",
    "authorized_version_activation",
    "cache_reuse",
    "catalog_error",
    "catalog_success",
    "lease_reclaimable",
    "one_immutable_winner",
    "policy_decision",
    "publisher_history_error",
    "publisher_history_success",
    "request_error",
    "request_success",
    "resource_error",
    "resource_success",
    "scope_catalog_success",
    "temporary_ignored",
    "unsupported_namespace_untouched",
    "version_selection_error",
    "version_selection_success",
  ]);
  assert.deepEqual(contract.conventions, {
    absent_optional_fields: "omitted",
    digest: "sha256:<64-lowercase-hex>",
    error_code: "stable_snake_case",
    json_encoding: "utf-8",
    path_separator: "/",
  });
});

test("every static behavioral result conforms to one declared normalized shape", () => {
  const contract = decodeNormalizedContract(readJson("contracts/v0/normalized-results.json"));

  for (const filename of [
    "archive-results.json",
    "cache-results.json",
    "catalog-results.json",
    "network-results.json",
    "publisher-version-history-results.json",
    "scope-version-catalog-results.json",
    "scope-version-network-results.json",
  ]) {
    for (const { id, result } of decodeNormalizedCases(
      readJson(`expected-results/${filename}`),
      `expected-results/${filename}`,
    ).cases) {
      const shape = contract.shapes[result.outcome];
      assert.ok(shape, `${filename}#${id} has undeclared outcome ${result.outcome}`);
      assert.equal(shape.outcome, result.outcome, `${filename}#${id}`);
      for (const field of shape.required) {
        assert.ok(Object.hasOwn(result, field), `${filename}#${id} omits required ${field}`);
      }
      if (result.error) {
        for (const field of contract.error_shape.required) {
          assert.ok(Object.hasOwn(result.error, field), `${filename}#${id} error omits ${field}`);
        }
      }
    }
  }
});

test("catalog inputs map one-to-one to static expected outcomes", () => {
  const fixtures = decodeCatalogFixtures(readJson("fixtures/catalog/catalog-cases.json"));
  const expected = decodeNormalizedCases(
    readJson("expected-results/catalog-results.json"),
    "catalog results",
  );

  assert.deepEqual(
    fixtures.cases.map(({ id }) => id),
    expected.cases.map(({ id }) => id),
  );
  assert.deepEqual(
    fixtures.cases.map(({ id }) => id),
    [
      "valid-v0.2",
      "valid-v0.2-extension",
      "unsupported-v0.1",
      "unsupported-missing-schema",
      "invalid-digest",
      "invalid-entry",
    ],
  );
  for (const fixture of fixtures.cases) {
    const bytes = readFileSync(resolve(protocolRoot, "fixtures/catalog", fixture.input));
    assert.equal(bytes.at(-1), 0x0a, `${fixture.input} must end with one newline`);
    JSON.parse(bytes.toString("utf8"));
  }
});

test("request transcripts are exact and redact every sensitive value", () => {
  const policy = decodeRedactionPolicy(readJson("contracts/v0/redaction.json"));
  const transcripts = jsonCaseDocument(
    readJson("fixtures/requests/catalog-transcripts.json"),
    "request transcript fixtures",
    (item, label) => {
      const fixture = jsonObject(item, label);
      return { id: jsonString(jsonValue(fixture, "id", label), `${label}.id`) };
    },
  );
  const expected = decodeRequestCases(
    readJson("expected-results/request-transcripts.json"),
    "request transcript results",
  );

  assert.deepEqual(
    transcripts.cases.map(({ id }) => id),
    expected.cases.map(({ id }) => id),
  );
  const initialTranscript = expected.cases[0];
  assert.ok(initialTranscript);
  assert.deepEqual(initialTranscript.requests, [
    {
      method: "GET",
      url: "https://skills.example.test/.well-known/agent-skills/index.json",
      headers: { accept: "application/json", "x-tenant": "fixture-tenant" },
      sensitive_header_names: ["authorization"],
    },
  ]);
  assert.deepEqual(policy.snapshot_replacement, "<redacted>");
  assert.ok(policy.never_snapshot_fields.includes("authorization"));
  assert.ok(policy.never_snapshot_fields.includes("proxy-authorization"));

  const syntheticCanary = ["RMS", "SYNTHETIC", "SECRET", "CANARY", "8F0D2A7C"].join("_");
  for (const path of walkFiles(".")) {
    const bytes = readFileSync(resolve(protocolRoot, path));
    assert.equal(bytes.includes(syntheticCanary), false, `${path} contains the secret canary`);
  }
});

test("redaction inputs map one-to-one to static sanitized diagnostics", () => {
  const fixtures = decodeRedactionFixtures(readJson("fixtures/requests/redaction-cases.json"));
  const expected = jsonCaseDocument(
    readJson("expected-results/redaction-results.json"),
    "redaction results",
    (item, label) => {
      const result = jsonObject(item, label);
      return { id: jsonString(jsonValue(result, "id", label), `${label}.id`) };
    },
  );
  assert.deepEqual(
    fixtures.cases.map(({ id }) => id),
    expected.cases.map(({ id }) => id),
  );
  assert.ok(
    fixtures.cases.some(({ request }) =>
      request.configured_secret_header_names?.includes("x-cdn-token"),
    ),
  );
  assert.ok(
    fixtures.cases.some(({ request }) =>
      request.configured_secret_header_names?.includes("x-origin-secret"),
    ),
  );
});

test("independent schema validator checks every expected-results record", () => {
  const result = spawnTextSync(
    "node",
    [resolve(protocolRoot, "tools/validate-contract-results.ts")],
    { cwd: protocolRoot },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /^validated \d+ records across 13 expected-result files\n$/);
});

for (const [family, filename] of [
  ["normalized", "catalog-results.json"],
  ["diagnostic", "redaction-results.json"],
  ["transcript", "request-transcripts.json"],
  ["network-request", "network-request-results.json"],
  ["publisher", "publisher-results.json"],
] as const) {
  for (const [variant, version] of [
    ["supported numeric", 1],
    ["absent", undefined],
    ["unsupported numeric", 2],
    ["string", "1"],
    ["null", null],
  ] as const) {
    test(`schema validator checks ${family} envelope ${variant} contract version`, () => {
      const result = runValidatorMutation("remote-skills-contract-version-", (mutationRoot) => {
        const document = jsonObject(readJson(`expected-results/${filename}`), filename);
        writeFileSync(
          resolve(mutationRoot, "expected-results", filename),
          JSON.stringify({ ...document, contract_version: version }),
        );
      });
      if (version === 1) {
        assert.equal(result.status, 0, result.stderr || result.stdout);
        assert.match(result.stdout, /^validated \d+ records across 13 expected-result files\n$/);
      } else {
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /expected-result contract_version must be numeric 1/);
        assert.equal(result.stdout, "");
      }
    });
  }
}

for (const locationField of ["url", "path"] as const) {
  const policy = decodeRedactionPolicy(readJson("contracts/v0/redaction.json"));
  const headerCases: {
    name: string;
    headers: unknown;
    sensitiveNames: unknown;
    diagnostic?: RegExp;
  }[] = [
    ...policy.never_snapshot_fields.flatMap((name) =>
      [name, name.toUpperCase()].map((headerName) => ({
        name: `fixed ${headerName}`,
        headers: { [headerName]: "", "x-fixture-note": "ordinary-header-marker" },
        sensitiveNames: [],
        diagnostic: /request snapshot contains a sensitive header name/,
      })),
    ),
    ...["x-private-fixture", "X-Private-Fixture"].map((headerName) => ({
      name: `configured ${headerName}`,
      headers: { [headerName]: "", "x-fixture-note": "ordinary-header-marker" },
      sensitiveNames: ["x-PRIVATE-fixture"],
      diagnostic: /request snapshot contains a sensitive header name/,
    })),
    ...[42, false, null, ["ordinary-header-marker"], { note: "ordinary-header-marker" }].map(
      (value, index) => ({
        name: `non-string header ${index}`,
        headers: { "x-fixture-note": value },
        sensitiveNames: [],
        diagnostic: /request snapshot header value must be a string/,
      }),
    ),
    ...[null, [], "ordinary-header-marker"].map((headers, index) => ({
      name: `invalid header map ${index}`,
      headers,
      sensitiveNames: [],
      diagnostic: /request snapshot headers must be an object/,
    })),
    ...["ordinary-header-marker", [42], [null]].map((sensitiveNames, index) => ({
      name: `invalid sensitive names ${index}`,
      headers: {},
      sensitiveNames,
      diagnostic: /request snapshot sensitive header names.*must be (?:an array|a string)/,
    })),
    {
      name: "ordinary scope headers",
      headers: { "Remote-Skills-Scope": "engineering", accept: "application/json" },
      sensitiveNames: ["authorization", "x-private-fixture"],
    },
  ];
  for (const { name, headers, sensitiveNames, diagnostic } of headerCases) {
    test(`schema validator checks ${locationField} snapshot headers: ${name}`, () => {
      const result = runValidatorMutation("remote-skills-request-headers-", (mutationRoot) => {
        const request = {
          method: "GET",
          [locationField]:
            locationField === "url"
              ? "https://skills.example.test/.well-known/agent-skills/index.json"
              : "/.well-known/agent-skills/index.json",
          headers,
          sensitive_header_names: sensitiveNames,
        };
        const document =
          locationField === "url"
            ? { contract_version: 1, cases: [{ id: "ordinary-request", requests: [request] }] }
            : { contract_version: 1, requests: [request] };
        const filename =
          locationField === "url" ? "request-transcripts.json" : "network-request-results.json";
        writeFileSync(
          resolve(mutationRoot, "expected-results", filename),
          `${JSON.stringify(document)}\n`,
        );
      });
      assert.equal(result.stderr.includes("ordinary-header-marker"), false);
      assert.equal(result.stdout.includes("ordinary-header-marker"), false);
      if (diagnostic) {
        assert.notEqual(result.status, 0, "invalid snapshot headers unexpectedly validated");
        assert.match(result.stderr, diagnostic);
      } else {
        assert.equal(result.status, 0, result.stderr || result.stdout);
      }
    });
  }
}

const projectedRecordCases: {
  name: string;
  filename: string;
  path: (string | number)[];
}[] = [
  { name: "diagnostic", filename: "redaction-results.json", path: ["cases", 0, "diagnostic"] },
  { name: "normalized document", filename: "archive-results.json", path: [] },
  { name: "normalized case", filename: "archive-results.json", path: ["cases", 0] },
  {
    name: "normalized file",
    filename: "archive-results.json",
    path: ["cases", 0, "result", "files", 0],
  },
  {
    name: "frontmatter",
    filename: "archive-results.json",
    path: ["cases", 0, "result", "frontmatter"],
  },
  {
    name: "catalog entry",
    filename: "catalog-results.json",
    path: ["cases", 0, "result", "entries", 0],
  },
  { name: "publisher document", filename: "publisher-results.json", path: [] },
  { name: "publisher format", filename: "publisher-results.json", path: ["formats", "tar.gz"] },
  {
    name: "publisher index",
    filename: "publisher-results.json",
    path: ["formats", "tar.gz", "index"],
  },
  {
    name: "publisher artifact",
    filename: "publisher-results.json",
    path: ["formats", "tar.gz", "artifacts", 0],
  },
  ...["tar.gz", "zip"].map((format) => ({
    name: `${format} publisher file`,
    filename: "publisher-results.json",
    path: ["formats", format, "normalized_archive", "files", 0],
  })),
];

for (const { name, filename, path } of projectedRecordCases) {
  test(`schema validator rejects undeclared fields on the raw ${name}`, () => {
    const result = runValidatorMutation("remote-skills-record-mutation-", (mutationRoot) => {
      const resultsPath = resolve(mutationRoot, "expected-results", filename);
      const document: unknown = JSON.parse(readFileSync(resultsPath, "utf8"));
      let target: unknown = document;
      for (const field of path) {
        target =
          typeof field === "number"
            ? jsonArray(target, name)[field]
            : jsonValue(jsonObject(target, name), field, name);
      }
      Reflect.set(jsonObject(target, name), "unexpected_note", "ordinary fixture note");
      writeFileSync(resultsPath, `${JSON.stringify(document)}\n`);
    });
    assert.notEqual(result.status, 0, `${name} unexpectedly validated`);
    assert.match(result.stderr, /has undeclared unexpected_note/);
  });
}

test("schema validator accepts declared releases and rejects undeclared release fields", () => {
  for (const unexpectedField of [false, true]) {
    const result = runValidatorMutation("remote-skills-release-mutation-", (mutationRoot) => {
      const resultsPath = resolve(mutationRoot, "expected-results/catalog-results.json");
      const document: unknown = JSON.parse(readFileSync(resultsPath, "utf8"));
      const cases = jsonArray(
        jsonValue(jsonObject(document, "document"), "cases", "document"),
        "cases",
      );
      const firstCase = jsonObject(cases[0], "case");
      const result = jsonObject(jsonValue(firstCase, "result", "case"), "result");
      const entries = jsonArray(jsonValue(result, "entries", "result"), "entries");
      const entry = jsonObject(entries[0], "entry");
      Reflect.set(entry, "releases", [
        {
          version: "1.0.0",
          artifact_type: jsonValue(entry, "artifact_type", "entry"),
          digest: jsonValue(entry, "digest", "entry"),
          url: jsonValue(entry, "url", "entry"),
          ...(unexpectedField ? { unexpected_note: "ordinary fixture note" } : {}),
        },
      ]);
      writeFileSync(resultsPath, `${JSON.stringify(document)}\n`);
    });
    if (unexpectedField) {
      assert.notEqual(result.status, 0, "undeclared release field unexpectedly validated");
      assert.match(result.stderr, /has undeclared unexpected_note/);
    } else {
      assert.equal(result.status, 0, result.stderr || result.stdout);
    }
  }
});

for (const target of ["entry", "release"] as const) {
  for (const variant of ["clean", "query", "fragment", "invalid"] as const) {
    test(`schema validator checks normalized ${target} URL ${variant} without exposing values`, () => {
      const marker = "ordinary-url-marker";
      const result = runValidatorMutation("remote-skills-normalized-url-", (mutationRoot) => {
        const resultsPath = resolve(mutationRoot, "expected-results/catalog-results.json");
        const document: unknown = JSON.parse(readFileSync(resultsPath, "utf8"));
        const cases = jsonArray(
          jsonValue(jsonObject(document, "document"), "cases", "document"),
          "cases",
        );
        const firstCase = jsonObject(cases[0], "case");
        const result = jsonObject(jsonValue(firstCase, "result", "case"), "result");
        const entries = jsonArray(jsonValue(result, "entries", "result"), "entries");
        const entry = jsonObject(entries[0], "entry");
        const cleanUrl = jsonString(jsonValue(entry, "url", "entry"), "entry.url");
        const url =
          variant === "query"
            ? `${cleanUrl}?note=${marker}`
            : variant === "fragment"
              ? `${cleanUrl}#${marker}`
              : variant === "invalid"
                ? `http://[${marker}]`
                : cleanUrl;
        if (target === "entry") {
          Reflect.set(entry, "url", url);
        } else {
          Reflect.set(entry, "releases", [
            {
              version: "1.0.0",
              artifact_type: jsonValue(entry, "artifact_type", "entry"),
              digest: jsonValue(entry, "digest", "entry"),
              url,
            },
          ]);
        }
        writeFileSync(resultsPath, `${JSON.stringify(document)}\n`);
      });
      assert.equal(result.stderr.includes(marker), false);
      assert.equal(result.stdout.includes(marker), false);
      if (variant === "clean") {
        assert.equal(result.status, 0, "clean normalized URL failed validation");
      } else {
        assert.notEqual(result.status, 0, "disallowed normalized URL unexpectedly validated");
        assert.match(
          result.stderr,
          variant === "invalid"
            ? /normalized (?:entry|release) URL is invalid/
            : /normalized (?:entry|release) URL contains disallowed components/,
        );
      }
    });
  }
}

test("schema validator rejects a transcript URL containing query and fragment canaries", () => {
  const result = runValidatorMutation("remote-skills-contract-mutation-", (mutationRoot) => {
    const transcriptPath = resolve(mutationRoot, "expected-results/request-transcripts.json");
    const parsedTranscript: unknown = JSON.parse(readFileSync(transcriptPath, "utf8"));
    const transcript = jsonObject(parsedTranscript, transcriptPath);
    const cases = jsonArray(
      jsonValue(transcript, "cases", transcriptPath),
      `${transcriptPath}.cases`,
    );
    const firstCase = jsonObject(cases[0], `${transcriptPath}.cases[0]`);
    const requests = jsonArray(
      jsonValue(firstCase, "requests", `${transcriptPath}.cases[0]`),
      `${transcriptPath}.cases[0].requests`,
    );
    const firstRequest = jsonObject(requests[0], `${transcriptPath}.cases[0].requests[0]`);
    Reflect.set(
      firstRequest,
      "url",
      "https://skills.example.test/index.json?token=QUERY_CANARY#FRAGMENT_CANARY",
    );
    writeFileSync(transcriptPath, `${JSON.stringify(transcript)}\n`);
  });
  assert.notEqual(result.status, 0, "mutated credential-bearing URL unexpectedly validated");
  assert.match(result.stderr, /persists query or fragment data/);
});

for (const component of ["username", "password"] as const) {
  test(`schema validator rejects transcript URL ${component} without exposing its value`, () => {
    const syntheticValue = "ordinary-component";
    const result = runValidatorMutation("remote-skills-userinfo-mutation-", (mutationRoot) => {
      const transcriptPath = resolve(mutationRoot, "expected-results/request-transcripts.json");
      const document: unknown = JSON.parse(readFileSync(transcriptPath, "utf8"));
      const transcript = jsonObject(document, "transcript");
      const cases = jsonArray(jsonValue(transcript, "cases", "transcript"), "cases");
      const firstCase = jsonObject(cases[0], "case");
      const requests = jsonArray(jsonValue(firstCase, "requests", "case"), "requests");
      const request = jsonObject(requests[0], "request");
      const url = new URL(jsonString(jsonValue(request, "url", "request"), "request.url"));
      url[component] = syntheticValue;
      Reflect.set(request, "url", url.href);
      writeFileSync(transcriptPath, `${JSON.stringify(transcript)}\n`);
    });
    assert.notEqual(result.status, 0, "disallowed transcript URL component unexpectedly validated");
    assert.match(result.stderr, /persists userinfo data/);
    assert.equal(result.stderr.includes(syntheticValue), false);
    assert.equal(result.stdout.includes(syntheticValue), false);
  });
}

test("schema validator rejects numeric prerelease identifiers with leading zeroes", () => {
  const result = runValidatorMutation("remote-skills-semver-mutation-", (mutationRoot) => {
    const resultsPath = resolve(
      mutationRoot,
      "expected-results/scope-version-catalog-results.json",
    );
    const parsedResults: unknown = JSON.parse(readFileSync(resultsPath, "utf8"));
    const results = jsonObject(parsedResults, resultsPath);
    const cases = jsonArray(jsonValue(results, "cases", resultsPath), `${resultsPath}.cases`);
    const firstCase = jsonObject(cases[0], `${resultsPath}.cases[0]`);
    const result = jsonObject(
      jsonValue(firstCase, "result", `${resultsPath}.cases[0]`),
      `${resultsPath}.cases[0].result`,
    );
    Reflect.set(result, "selected_version", "1.0.0-01");
    writeFileSync(resultsPath, `${JSON.stringify(results)}\n`);
  });
  assert.notEqual(result.status, 0, "invalid numeric prerelease unexpectedly validated");
  assert.match(result.stderr, /numeric prerelease identifier has a leading zero/);
});

test("schema validator rejects undeclared credential context", () => {
  const result = runValidatorMutation("remote-skills-context-mutation-", (mutationRoot) => {
    const resultsPath = resolve(
      mutationRoot,
      "expected-results/scope-version-network-results.json",
    );
    const parsedResults: unknown = JSON.parse(readFileSync(resultsPath, "utf8"));
    const results = jsonObject(parsedResults, resultsPath);
    const cases = jsonArray(jsonValue(results, "cases", resultsPath), `${resultsPath}.cases`).map(
      (item, index) => jsonObject(item, `${resultsPath}.cases[${index}]`),
    );
    const unauthenticated = cases.find(
      (item) =>
        jsonString(jsonValue(item, "id", resultsPath), `${resultsPath}.case.id`) ===
        "scope-unauthenticated-401",
    );
    assert.ok(unauthenticated);
    const result = jsonObject(
      jsonValue(unauthenticated, "result", resultsPath),
      `${resultsPath}.result`,
    );
    const error = jsonObject(
      jsonValue(result, "error", resultsPath),
      `${resultsPath}.result.error`,
    );
    const context = jsonObject(
      jsonValue(error, "context", resultsPath),
      `${resultsPath}.result.error.context`,
    );
    Reflect.set(context, "authorization", "Bearer credential-canary");
    writeFileSync(resultsPath, `${JSON.stringify(results)}\n`);
  });
  assert.notEqual(result.status, 0, "undeclared credential context unexpectedly validated");
  assert.match(result.stderr, /context has undeclared authorization/);
});

test("schema validator rejects retryability that contradicts the error contract", () => {
  const result = runValidatorMutation("remote-skills-retryable-mutation-", (mutationRoot) => {
    const resultsPath = resolve(
      mutationRoot,
      "expected-results/scope-version-catalog-results.json",
    );
    const parsedResults: unknown = JSON.parse(readFileSync(resultsPath, "utf8"));
    const results = jsonObject(parsedResults, resultsPath);
    const cases = jsonArray(jsonValue(results, "cases", resultsPath), `${resultsPath}.cases`).map(
      (item, index) => jsonObject(item, `${resultsPath}.cases[${index}]`),
    );
    const invalidSemver = cases.find(
      (item) =>
        jsonString(jsonValue(item, "id", resultsPath), `${resultsPath}.case.id`) ===
        "version-invalid-semver",
    );
    assert.ok(invalidSemver);
    const result = jsonObject(
      jsonValue(invalidSemver, "result", resultsPath),
      `${resultsPath}.result`,
    );
    const error = jsonObject(
      jsonValue(result, "error", resultsPath),
      `${resultsPath}.result.error`,
    );
    Reflect.set(error, "retryable", true);
    writeFileSync(resultsPath, `${JSON.stringify(results)}\n`);
  });
  assert.notEqual(result.status, 0, "incorrect retryability unexpectedly validated");
  assert.match(result.stderr, /retryable contradicts catalog_invalid/);
});

test("both future SDK adapters target the shared fixture root", () => {
  const adapters = decodeAdapterContract(readJson("contracts/v0/sdk-adapters.json"));

  assert.equal(adapters.contract_version, 1);
  assert.equal(adapters.expected_state, "red_until_sdk_implementation");
  assert.deepEqual(adapters.entrypoints, {
    python: "adapters/python_protocol_adapter.py",
    typescript: "adapters/typescript-protocol-adapter.mjs",
  });
  assert.deepEqual(adapters.case_api, {
    python: "run_protocol_case",
    typescript: "runProtocolCase",
  });
  assert.deepEqual(
    adapters.suites.map(({ name }) => name),
    [
      "archive",
      "cache",
      "catalog",
      "network",
      "publisher_activation",
      "redaction",
      "request_transcripts",
    ],
  );
  assert.deepEqual(
    adapters.supplemental_suites.map(({ name }) => name),
    ["catalog", "network", "request_transcripts"],
  );
});

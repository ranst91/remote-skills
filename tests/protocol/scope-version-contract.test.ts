import assert from "node:assert/strict";
import { test } from "node:test";
import {
  jsonArray,
  jsonBoolean,
  jsonCaseDocument,
  jsonObject,
  jsonOptionalNumber,
  jsonOptionalString,
  jsonString,
  jsonStringArray,
  jsonValue,
  readJson,
  sha256,
} from "./helpers/contract-helpers.ts";

const requiredVersionCaseIds = [
  "version-select-no-constraint",
  "version-select-star",
  "version-select-major-x",
  "version-select-minor-x",
  "version-select-caret",
  "version-select-tilde",
  "version-select-exact",
  "version-unversioned-star",
  "version-unversioned-restrictive",
  "version-no-compatible",
  "version-prerelease-excluded",
  "version-prerelease-explicit",
  "version-build-metadata-tie",
  "version-select-large-core-numeric",
  "version-select-large-prerelease-numeric",
  "version-invalid-semver",
  "version-invalid-historical-semver",
  "version-invalid-numeric-prerelease",
  "version-current-mismatch",
  "version-invalid-order",
  "version-duplicate",
  "version-over-limit",
];
const requiredScopeTransportIds = [
  "authorized-range-activation",
  "scope-304-duplicate-confirmation",
  "scope-304-mismatch-confirmation",
  "scope-304-missing-confirmation",
  "scope-artifact-denied",
  "scope-authenticated-unscoped-memory-only",
  "scope-authorization-403",
  "scope-confirmed-200",
  "scope-confirmed-304",
  "scope-engineering-cache",
  "scope-invalid-comma",
  "scope-invalid-empty",
  "scope-invalid-multiple-request-headers",
  "scope-invalid-multiple-response-headers",
  "scope-invalid-non-visible-ascii",
  "scope-invalid-over-128-bytes",
  "scope-invalid-whitespace",
  "scope-mismatch-confirmation",
  "scope-missing-confirmation",
  "scope-no-store",
  "scope-sales-cache",
  "scope-unauthenticated-401",
];
const requiredPublisherHistoryIds = [
  "history-clean-current",
  "history-prior-retained",
  "history-explicit-prune",
  "history-version-remapped",
  "history-over-limit",
];
const requiredVersionRemovalIds = [
  "version-removal-existing-session",
  "version-removal-future-online",
  "version-removal-explicit-stale",
];

const strictSemver =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

interface Release {
  digest: string;
  type: string;
  url: string;
  version: string;
}

interface VersionedExtension {
  releases: Release[];
  version: string;
}

interface VersionedCatalog {
  skills: {
    digest: string;
    type: string;
    url: string;
    "x-remote-skills": VersionedExtension;
  }[];
}

interface ScopeFixture {
  category: string;
  id: string;
  scenario: string;
}

interface ScopeResult {
  artifacts_retained?: number;
  artifact_requests?: number;
  body_transfers?: number;
  catalog_identifier?: string;
  catalog_requests?: number;
  digest?: string;
  error?: { code: string; context: { [field: string]: string | number } };
  forbidden_header_names?: string[];
  output_replaced?: boolean;
  persistent?: boolean;
  pinned_digest?: string;
  requests?: number;
  releases?: string[];
  selected_version?: string;
  sensitive_header_names?: string[];
  stale?: boolean;
}

interface ScopeScenario {
  artifact_request?: {
    forbidden_header_names: string[];
    sensitive_header_names: string[];
  };
  catalog_response?: { headers: { [name: string]: string } };
  configuration: {
    artifact_url?: string;
    origin?: string;
    requested_range?: string;
    scope?: string;
  };
  pin?: { digest: string };
  request?: { headers: { [name: string]: string } | { name: string; value: string }[] };
  response?: { headers: { [name: string]: string } | { name: string; value: string }[] };
  selection?: { digest: string; selected_version: string };
}

interface PublisherHistoryFixture {
  current: Release;
  id: string;
  prior_release_count?: number;
  prior_releases?: Release[];
  skill_name: string;
}

function decodeId(value: unknown, label: string): { id: string } {
  const item = jsonObject(value, label);
  return { id: jsonString(jsonValue(item, "id", label), `${label}.id`) };
}

function decodeScopeFixture(value: unknown, label: string): ScopeFixture {
  const fixture = jsonObject(value, label);
  return {
    category: jsonString(jsonValue(fixture, "category", label), `${label}.category`),
    id: jsonString(jsonValue(fixture, "id", label), `${label}.id`),
    scenario: jsonString(jsonValue(fixture, "scenario", label), `${label}.scenario`),
  };
}

function decodeStringMap(value: unknown, label: string): { [name: string]: string } {
  const raw = jsonObject(value, label);
  const decoded: { [name: string]: string } = {};
  for (const [name, item] of Object.entries(raw))
    decoded[name] = jsonString(item, `${label}.${name}`);
  return decoded;
}

function decodeHeaderOccurrences(value: unknown, label: string): { name: string; value: string }[] {
  return jsonArray(value, label).map((item, index) => {
    const itemLabel = `${label}[${index}]`;
    const header = jsonObject(item, itemLabel);
    return {
      name: jsonString(jsonValue(header, "name", itemLabel), `${itemLabel}.name`),
      value: jsonString(jsonValue(header, "value", itemLabel), `${itemLabel}.value`),
    };
  });
}

function decodeScopeScenario(value: unknown, label: string): ScopeScenario {
  const scenario = jsonObject(value, label);
  const configuration = jsonObject(
    jsonValue(scenario, "configuration", label),
    `${label}.configuration`,
  );
  const artifactUrl = jsonOptionalString(configuration, "artifact_url", `${label}.configuration`);
  const origin = jsonOptionalString(configuration, "origin", `${label}.configuration`);
  const requestedRange = jsonOptionalString(
    configuration,
    "requested_range",
    `${label}.configuration`,
  );
  const scope = jsonOptionalString(configuration, "scope", `${label}.configuration`);
  const decoded: ScopeScenario = {
    configuration: {
      ...(artifactUrl === undefined ? {} : { artifact_url: artifactUrl }),
      ...(origin === undefined ? {} : { origin }),
      ...(requestedRange === undefined ? {} : { requested_range: requestedRange }),
      ...(scope === undefined ? {} : { scope }),
    },
  };
  if (Object.hasOwn(scenario, "artifact_request")) {
    const request = jsonObject(
      jsonValue(scenario, "artifact_request", label),
      `${label}.artifact_request`,
    );
    decoded.artifact_request = {
      forbidden_header_names: jsonStringArray(
        jsonValue(request, "forbidden_header_names", `${label}.artifact_request`),
        `${label}.artifact_request.forbidden_header_names`,
      ),
      sensitive_header_names: jsonStringArray(
        jsonValue(request, "sensitive_header_names", `${label}.artifact_request`),
        `${label}.artifact_request.sensitive_header_names`,
      ),
    };
  }
  if (Object.hasOwn(scenario, "catalog_response")) {
    const response = jsonObject(
      jsonValue(scenario, "catalog_response", label),
      `${label}.catalog_response`,
    );
    decoded.catalog_response = {
      headers: decodeStringMap(
        jsonValue(response, "headers", `${label}.catalog_response`),
        `${label}.catalog_response.headers`,
      ),
    };
  }
  if (Object.hasOwn(scenario, "pin")) {
    const pin = jsonObject(jsonValue(scenario, "pin", label), `${label}.pin`);
    decoded.pin = {
      digest: jsonString(jsonValue(pin, "digest", `${label}.pin`), `${label}.pin.digest`),
    };
  }
  for (const field of ["request", "response"] as const) {
    if (!Object.hasOwn(scenario, field)) continue;
    const message = jsonObject(jsonValue(scenario, field, label), `${label}.${field}`);
    const headers = jsonValue(message, "headers", `${label}.${field}`);
    decoded[field] = {
      headers: Array.isArray(headers)
        ? decodeHeaderOccurrences(headers, `${label}.${field}.headers`)
        : decodeStringMap(headers, `${label}.${field}.headers`),
    };
  }
  if (Object.hasOwn(scenario, "selection")) {
    const selection = jsonObject(jsonValue(scenario, "selection", label), `${label}.selection`);
    decoded.selection = {
      digest: jsonString(
        jsonValue(selection, "digest", `${label}.selection`),
        `${label}.selection.digest`,
      ),
      selected_version: jsonString(
        jsonValue(selection, "selected_version", `${label}.selection`),
        `${label}.selection.selected_version`,
      ),
    };
  }
  return decoded;
}

function decodeScenarioMap(value: unknown): { [id: string]: ScopeScenario } {
  const raw = jsonObject(value, "scope scenarios");
  const scenarios: { [id: string]: ScopeScenario } = {};
  for (const [id, scenario] of Object.entries(raw)) {
    scenarios[id] = decodeScopeScenario(scenario, `scope scenarios.${id}`);
  }
  return scenarios;
}

function decodeScopeError(value: unknown, label: string): NonNullable<ScopeResult["error"]> {
  const error = jsonObject(value, label);
  const rawContext = jsonObject(jsonValue(error, "context", label), `${label}.context`);
  const context: { [field: string]: string | number } = {};
  for (const [field, item] of Object.entries(rawContext)) {
    if (typeof item !== "string" && typeof item !== "number")
      throw new TypeError(`${label}.context.${field} must be a string or number`);
    context[field] = item;
  }
  return {
    code: jsonString(jsonValue(error, "code", label), `${label}.code`),
    context,
  };
}

function decodeScopeResult(value: unknown, label: string): ScopeResult {
  const result = jsonObject(value, label);
  const decoded: ScopeResult = {};
  for (const field of [
    "artifact_requests",
    "artifacts_retained",
    "body_transfers",
    "catalog_requests",
    "requests",
  ] as const) {
    const number = jsonOptionalNumber(result, field, label);
    if (number !== undefined) decoded[field] = number;
  }
  for (const field of [
    "catalog_identifier",
    "digest",
    "pinned_digest",
    "selected_version",
  ] as const) {
    const string = jsonOptionalString(result, field, label);
    if (string !== undefined) decoded[field] = string;
  }
  for (const field of ["persistent", "stale", "output_replaced"] as const) {
    if (Object.hasOwn(result, field))
      decoded[field] = jsonBoolean(jsonValue(result, field, label), `${label}.${field}`);
  }
  for (const field of ["forbidden_header_names", "sensitive_header_names", "releases"] as const) {
    if (Object.hasOwn(result, field))
      decoded[field] = jsonStringArray(jsonValue(result, field, label), `${label}.${field}`);
  }
  if (Object.hasOwn(result, "error"))
    decoded.error = decodeScopeError(jsonValue(result, "error", label), `${label}.error`);
  return decoded;
}

function decodeScopeResults(value: unknown, label: string) {
  return jsonCaseDocument(value, label, (item, itemLabel) => {
    const entry = jsonObject(item, itemLabel);
    return {
      id: jsonString(jsonValue(entry, "id", itemLabel), `${itemLabel}.id`),
      result: decodeScopeResult(jsonValue(entry, "result", itemLabel), `${itemLabel}.result`),
    };
  });
}

function decodeRelease(value: unknown, label: string): Release {
  const release = jsonObject(value, label);
  assert.deepEqual(
    Object.keys(release).sort(),
    ["digest", "type", "url", "version"],
    `${label} must contain exactly version, type, url, and digest`,
  );
  return {
    version: jsonString(jsonValue(release, "version", label), `${label}.version`),
    type: jsonString(jsonValue(release, "type", label), `${label}.type`),
    url: jsonString(jsonValue(release, "url", label), `${label}.url`),
    digest: jsonString(jsonValue(release, "digest", label), `${label}.digest`),
  };
}

function decodeVersionedCatalog(value: unknown, label: string): VersionedCatalog {
  const catalog = jsonObject(value, label);
  return {
    skills: jsonArray(jsonValue(catalog, "skills", label), `${label}.skills`).map((item, index) => {
      const entryLabel = `${label}.skills[${index}]`;
      const entry = jsonObject(item, entryLabel);
      const extension = jsonObject(
        jsonValue(entry, "x-remote-skills", entryLabel),
        `${entryLabel}.x-remote-skills`,
      );
      return {
        digest: jsonString(jsonValue(entry, "digest", entryLabel), `${entryLabel}.digest`),
        type: jsonString(jsonValue(entry, "type", entryLabel), `${entryLabel}.type`),
        url: jsonString(jsonValue(entry, "url", entryLabel), `${entryLabel}.url`),
        "x-remote-skills": {
          releases: jsonArray(
            jsonValue(extension, "releases", `${entryLabel}.x-remote-skills`),
            `${entryLabel}.x-remote-skills.releases`,
          ).map((release, releaseIndex) =>
            decodeRelease(release, `${entryLabel}.x-remote-skills.releases[${releaseIndex}]`),
          ),
          version: jsonString(
            jsonValue(extension, "version", `${entryLabel}.x-remote-skills`),
            `${entryLabel}.x-remote-skills.version`,
          ),
        },
      };
    }),
  };
}

function decodePublisherHistoryFixture(value: unknown, label: string): PublisherHistoryFixture {
  const fixture = jsonObject(value, label);
  const priorReleases = Object.hasOwn(fixture, "prior_releases")
    ? jsonArray(jsonValue(fixture, "prior_releases", label), `${label}.prior_releases`).map(
        (release, index) => decodeRelease(release, `${label}.prior_releases[${index}]`),
      )
    : undefined;
  const priorReleaseCount = jsonOptionalNumber(fixture, "prior_release_count", label);
  return {
    current: decodeRelease(jsonValue(fixture, "current", label), `${label}.current`),
    id: jsonString(jsonValue(fixture, "id", label), `${label}.id`),
    skill_name: jsonString(jsonValue(fixture, "skill_name", label), `${label}.skill_name`),
    ...(priorReleaseCount === undefined ? {} : { prior_release_count: priorReleaseCount }),
    ...(priorReleases === undefined ? {} : { prior_releases: priorReleases }),
  };
}

function requiredError(result: ScopeResult, label: string): NonNullable<ScopeResult["error"]> {
  if (result.error === undefined) throw new Error(`${label} must contain an error`);
  return result.error;
}

function requiredString(value: string | undefined, label: string): string {
  if (value === undefined) throw new Error(`${label} must be present`);
  return value;
}

function requiredNumber(value: number | undefined, label: string): number {
  if (value === undefined) throw new Error(`${label} must be present`);
  return value;
}

interface OfflineRemovalCase {
  cached_catalog_age_seconds?: number;
  cached_versions?: string[];
  maximum_age_seconds?: number;
  pinned_version?: string;
}

function decodeOfflineRemoval(value: unknown): { [id: string]: OfflineRemovalCase } {
  const raw = jsonObject(value, "offline removal fixtures");
  const decoded: { [id: string]: OfflineRemovalCase } = {};
  for (const [id, item] of Object.entries(raw)) {
    const fixture = jsonObject(item, `offline removal fixtures.${id}`);
    const cachedAge = jsonOptionalNumber(fixture, "cached_catalog_age_seconds", id);
    const maximumAge = jsonOptionalNumber(fixture, "maximum_age_seconds", id);
    const pinnedVersion = jsonOptionalString(fixture, "pinned_version", id);
    const cachedVersions = Object.hasOwn(fixture, "cached_versions")
      ? jsonStringArray(jsonValue(fixture, "cached_versions", id), `${id}.cached_versions`)
      : undefined;
    decoded[id] = {
      ...(cachedAge === undefined ? {} : { cached_catalog_age_seconds: cachedAge }),
      ...(cachedVersions === undefined ? {} : { cached_versions: cachedVersions }),
      ...(maximumAge === undefined ? {} : { maximum_age_seconds: maximumAge }),
      ...(pinnedVersion === undefined ? {} : { pinned_version: pinnedVersion }),
    };
  }
  return decoded;
}

function requiredScenarioPart<Key extends keyof ScopeScenario>(
  scenario: ScopeScenario,
  key: Key,
  label: string,
): NonNullable<ScopeScenario[Key]> {
  const value = scenario[key];
  if (value === undefined) throw new Error(`${label}.${key} must be present`);
  return value;
}

function requiredMapValue<Key, Value>(map: ReadonlyMap<Key, Value>, key: Key): Value {
  const value = map.get(key);
  if (value === undefined) throw new Error(`missing reviewed map value for ${String(key)}`);
  return value;
}

function requiredArrayValue<Value>(values: readonly Value[], index: number): Value {
  const value = values[index];
  if (value === undefined) throw new Error(`missing reviewed array value at index ${index}`);
  return value;
}

function requiredScenario(scenarios: { [id: string]: ScopeScenario }, id: string): ScopeScenario {
  const scenario = scenarios[id];
  if (scenario === undefined) throw new Error(`missing reviewed scope scenario: ${id}`);
  return scenario;
}

function parseStrictSemver(version: string) {
  const match = strictSemver.exec(version);
  assert.ok(match, `${version} is not strict SemVer`);
  const major = match[1];
  const minor = match[2];
  const patch = match[3];
  if (major === undefined || minor === undefined || patch === undefined) {
    throw new Error(`${version} is missing a SemVer core identifier`);
  }
  for (const identifier of match[4]?.split(".") ?? []) {
    assert.equal(
      /^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith("0"),
      false,
      `${version} has a numeric prerelease identifier with a leading zero`,
    );
  }
  return {
    major,
    minor,
    patch,
    prerelease: match[4]?.split(".") ?? [],
  };
}

function compareAscii(left: string, right: string): number {
  // Strict SemVer identifiers contain only ASCII, so code-unit order is lexical ASCII order.
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function compareNumericIdentifier(left: string, right: string): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  return compareAscii(left, right);
}

function comparePrerelease(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0)
    return Number(left.length === 0) - Number(right.length === 0);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const leftIdentifier = left[index];
    const rightIdentifier = right[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    if (leftIdentifier === rightIdentifier) continue;
    const leftNumeric = /^\d+$/.test(leftIdentifier);
    const rightNumeric = /^\d+$/.test(rightIdentifier);
    if (leftNumeric && rightNumeric)
      return compareNumericIdentifier(leftIdentifier, rightIdentifier);
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return compareAscii(leftIdentifier, rightIdentifier);
  }
  return 0;
}

function compareSemver(left: string, right: string): number {
  const leftVersion = parseStrictSemver(left);
  const rightVersion = parseStrictSemver(right);
  for (const field of ["major", "minor", "patch"] as const) {
    const comparison = compareNumericIdentifier(leftVersion[field], rightVersion[field]);
    if (comparison !== 0) return comparison;
  }
  return comparePrerelease(leftVersion.prerelease, rightVersion.prerelease);
}

function assertRelease(release: Release, label: string): void {
  assert.deepEqual(Object.keys(release), ["version", "type", "url", "digest"], label);
  parseStrictSemver(release.version);
  assert.match(release.digest, /^sha256:[0-9a-f]{64}$/, `${label}.digest`);
  const url = new URL(release.url, "https://skills.example.test/.well-known/agent-skills/");
  assert.equal(url.username || url.password || url.search || url.hash, "", `${label}.url`);
}

test("release decoding checks raw keys before projecting the descriptor", () => {
  const release = {
    digest: `sha256:${"a".repeat(64)}`,
    url: "artifacts/release.md",
    type: "skill-md",
    version: "1.0.0",
  };

  const decoded = decodeRelease(release, "release");
  assert.deepEqual(decoded, release);
  assertRelease(decoded, "release");
  assert.throws(() => decodeRelease({ ...release, description: "Ordinary release" }, "release"), {
    name: "AssertionError",
    message: /^release must contain exactly version, type, url, and digest\n/,
    actual: ["description", "digest", "type", "url", "version"],
    expected: ["digest", "type", "url", "version"],
  });
});

test("catalog registries contain the complete ordered version contract", () => {
  const fixtures = jsonCaseDocument(
    readJson("fixtures/catalog/scope-version-cases.json"),
    "scope version fixtures",
    decodeId,
  );
  const expected = jsonCaseDocument(
    readJson("expected-results/scope-version-catalog-results.json"),
    "scope version results",
    decodeId,
  );
  const fixtureIds = fixtures.cases.map(({ id }) => id);
  const expectedIds = expected.cases.map(({ id }) => id);

  assert.deepEqual(fixtureIds, expectedIds);
  assert.deepEqual(fixtureIds.slice(-requiredVersionCaseIds.length), requiredVersionCaseIds);
});

test("scope transport registry contains every authorized and adversarial interaction", () => {
  const fixtures = jsonCaseDocument(
    readJson("fixtures/network/scope-version-network-cases.json"),
    "scope network fixtures",
    decodeScopeFixture,
  );
  const expected = jsonCaseDocument(
    readJson("expected-results/scope-version-network-results.json"),
    "scope network results",
    decodeId,
  );
  const fixtureIds = fixtures.cases
    .filter(({ category }) => category === "scope_authorization")
    .map(({ id }) => id)
    .sort();
  const expectedIds = expected.cases
    .map(({ id }) => id)
    .filter((id) => requiredScopeTransportIds.includes(id))
    .sort();

  assert.deepEqual(fixtureIds, requiredScopeTransportIds);
  assert.deepEqual(expectedIds, requiredScopeTransportIds);

  const scenarios = decodeScenarioMap(readJson("fixtures/network/scope-authorization.json"));
  const scopedReferences = fixtures.cases
    .filter(({ category }) => category === "scope_authorization")
    .map(({ scenario }) => {
      const reference = scenario.split("#")[1];
      if (reference === undefined) throw new Error(`scope scenario omits anchor: ${scenario}`);
      return reference;
    })
    .sort();
  assert.deepEqual(scopedReferences, Object.keys(scenarios).sort());
});

test("scoped requests, authorization failures, and persistence remain exact and sanitized", () => {
  const transcripts = jsonCaseDocument(
    readJson("expected-results/scope-version-request-transcripts.json"),
    "scope request transcripts",
    (item, label) => {
      const entry = jsonObject(item, label);
      return {
        id: jsonString(jsonValue(entry, "id", label), `${label}.id`),
        requests: jsonArray(jsonValue(entry, "requests", label), `${label}.requests`).map(
          (request, index) => jsonObject(request, `${label}.requests[${index}]`),
        ),
      };
    },
  );
  const network = decodeScopeResults(
    readJson("expected-results/scope-version-network-results.json"),
    "scope network results",
  );
  const requests = new Map(transcripts.cases.map(({ id, requests: value }) => [id, value]));
  const results = new Map(network.cases.map(({ id, result }) => [id, result]));

  assert.deepEqual(requests.get("catalog-scoped-initial"), [
    {
      method: "GET",
      url: "https://skills.example.test/.well-known/agent-skills/index.json",
      headers: { accept: "application/json", "remote-skills-scope": "engineering" },
      sensitive_header_names: ["authorization"],
    },
  ]);
  assert.deepEqual(requests.get("catalog-scoped-conditional"), [
    {
      method: "GET",
      url: "https://skills.example.test/.well-known/agent-skills/index.json",
      headers: {
        accept: "application/json",
        "if-none-match": '"engineering-v1"',
        "remote-skills-scope": "engineering",
      },
      sensitive_header_names: ["authorization"],
    },
  ]);
  assert.equal(requiredMapValue(results, "scope-confirmed-200").persistent, true);
  assert.equal(requiredMapValue(results, "scope-confirmed-304").body_transfers, 0);
  for (const id of [
    "scope-304-missing-confirmation",
    "scope-304-mismatch-confirmation",
    "scope-304-duplicate-confirmation",
  ]) {
    assert.equal(requiredError(requiredMapValue(results, id), id).code, "catalog_invalid", id);
    assert.deepEqual(requiredError(requiredMapValue(results, id), id).context, {
      origin_alias: "acme",
      field: "remote-skills-scope",
    });
  }
  assert.equal(requiredMapValue(results, "scope-no-store").persistent, false);
  assert.equal(
    requiredMapValue(results, "scope-authenticated-unscoped-memory-only").persistent,
    false,
  );
  assert.equal(
    Object.hasOwn(requiredMapValue(results, "scope-no-store"), "catalog_identifier"),
    false,
  );
  assert.equal(
    Object.hasOwn(
      requiredMapValue(results, "scope-authenticated-unscoped-memory-only"),
      "catalog_identifier",
    ),
    false,
  );
  assert.equal(
    requiredError(
      requiredMapValue(results, "scope-unauthenticated-401"),
      "scope-unauthenticated-401",
    ).code,
    "authentication_failed",
  );
  assert.equal(
    requiredError(requiredMapValue(results, "scope-authorization-403"), "scope-authorization-403")
      .code,
    "authorization_denied",
  );
  assert.equal(
    requiredError(requiredMapValue(results, "scope-artifact-denied"), "scope-artifact-denied").code,
    "authorization_denied",
  );
  const artifactDenied = requiredScenario(
    decodeScenarioMap(readJson("fixtures/network/scope-authorization.json")),
    "scope-artifact-denied",
  );
  assert.equal(
    new URL(
      requiredString(
        artifactDenied.configuration.origin,
        "scope-artifact-denied.configuration.origin",
      ),
    ).origin,
    new URL(
      requiredString(
        artifactDenied.configuration.artifact_url,
        "scope-artifact-denied.configuration.artifact_url",
      ),
    ).origin,
  );
  const artifactRequest = requiredScenarioPart(
    artifactDenied,
    "artifact_request",
    "scope-artifact-denied",
  );
  assert.deepEqual(artifactRequest.sensitive_header_names, ["authorization"]);
  assert.deepEqual(artifactRequest.forbidden_header_names, ["remote-skills-scope"]);
  const layout = jsonObject(readJson("contracts/v0/cache-layout.json"), "cache layout");
  const originIdentifier = jsonObject(
    jsonValue(layout, "origin_identifier", "cache layout"),
    "cache layout.origin_identifier",
  );
  const indexUrl = jsonString(
    jsonValue(originIdentifier, "example_url", "cache layout.origin_identifier"),
    "cache layout.origin_identifier.example_url",
  );
  const identifiers = new Map([
    ["engineering", sha256(Buffer.from(`${indexUrl}\nremote-skills-scope:engineering`, "utf8"))],
    ["sales", sha256(Buffer.from(`${indexUrl}\nremote-skills-scope:sales`, "utf8"))],
  ]);
  assert.equal(
    requiredMapValue(results, "scope-engineering-cache").catalog_identifier,
    identifiers.get("engineering"),
  );
  assert.equal(
    requiredMapValue(results, "scope-sales-cache").catalog_identifier,
    identifiers.get("sales"),
  );
  assert.equal(
    requiredMapValue(results, "scope-confirmed-200").catalog_identifier,
    identifiers.get("engineering"),
  );
  assert.equal(
    requiredMapValue(results, "scope-confirmed-304").catalog_identifier,
    identifiers.get("engineering"),
  );
  assert.equal(
    jsonString(
      jsonValue(originIdentifier, "scoped_example_identifier", "cache layout.origin_identifier"),
      "cache layout.origin_identifier.scoped_example_identifier",
    ),
    identifiers.get("engineering"),
  );
  assert.deepEqual(requiredMapValue(results, "scope-artifact-denied").sensitive_header_names, [
    "authorization",
  ]);
  assert.deepEqual(requiredMapValue(results, "scope-artifact-denied").forbidden_header_names, [
    "remote-skills-scope",
  ]);
});

test("authorized range activation confirms scope, selects 1.4.7, and pins its authorized digest", () => {
  const scenarios = decodeScenarioMap(readJson("fixtures/network/scope-authorization.json"));
  const expected = decodeScopeResults(
    readJson("expected-results/scope-version-network-results.json"),
    "scope network results",
  );
  const scenario = requiredScenario(scenarios, "authorized-range-activation");
  const expectedCase = expected.cases.find(({ id }) => id === "authorized-range-activation");
  assert.ok(expectedCase);
  const result = expectedCase.result;

  assert.equal(scenario.configuration.scope, "engineering");
  assert.equal(scenario.configuration.requested_range, "1.4.x");
  const catalogResponse = requiredScenarioPart(
    scenario,
    "catalog_response",
    "authorized-range-activation",
  );
  const selection = requiredScenarioPart(scenario, "selection", "authorized-range-activation");
  const activationRequest = requiredScenarioPart(
    scenario,
    "artifact_request",
    "authorized-range-activation",
  );
  const pin = requiredScenarioPart(scenario, "pin", "authorized-range-activation");
  assert.equal(catalogResponse.headers["remote-skills-scope"], "engineering");
  assert.equal(selection.selected_version, "1.4.7");
  assert.deepEqual(activationRequest.sensitive_header_names, ["authorization"]);
  assert.deepEqual(activationRequest.forbidden_header_names, ["remote-skills-scope"]);
  assert.equal(result.selected_version, "1.4.7");
  assert.equal(result.digest, selection.digest);
  assert.equal(result.pinned_digest, pin.digest);
  assert.equal(result.catalog_requests, 1);
  assert.equal(result.artifact_requests, 1);
});

test("scope transport rejects every malformed byte and duplicate header boundary", () => {
  const scenarios = decodeScenarioMap(readJson("fixtures/network/scope-authorization.json"));
  assert.equal(
    requiredString(
      requiredScenario(scenarios, "scope-invalid-empty").configuration.scope,
      "scope-invalid-empty.configuration.scope",
    ).length,
    0,
  );
  assert.equal(
    Buffer.byteLength(
      requiredString(
        requiredScenario(scenarios, "scope-invalid-over-128-bytes").configuration.scope,
        "scope-invalid-over-128-bytes.configuration.scope",
      ),
      "ascii",
    ),
    129,
  );
  assert.match(
    requiredString(
      requiredScenario(scenarios, "scope-invalid-non-visible-ascii").configuration.scope,
      "scope-invalid-non-visible-ascii.configuration.scope",
    ),
    /\x7f/,
  );
  assert.notEqual(
    requiredString(
      requiredScenario(scenarios, "scope-invalid-whitespace").configuration.scope,
      "scope-invalid-whitespace.configuration.scope",
    ).trim(),
    requiredString(
      requiredScenario(scenarios, "scope-invalid-whitespace").configuration.scope,
      "scope-invalid-whitespace.configuration.scope",
    ),
  );
  assert.ok(
    requiredString(
      requiredScenario(scenarios, "scope-invalid-comma").configuration.scope,
      "scope-invalid-comma.configuration.scope",
    ).includes(","),
  );
  const duplicateOccurrences = [
    { name: "remote-skills-scope", value: "engineering" },
    { name: "remote-skills-scope", value: "engineering" },
  ];
  assert.deepEqual(
    requiredScenarioPart(
      requiredScenario(scenarios, "scope-invalid-multiple-request-headers"),
      "request",
      "scope-invalid-multiple-request-headers",
    ).headers,
    duplicateOccurrences,
  );
  assert.deepEqual(
    requiredScenarioPart(
      requiredScenario(scenarios, "scope-invalid-multiple-response-headers"),
      "response",
      "scope-invalid-multiple-response-headers",
    ).headers,
    duplicateOccurrences,
  );
});

test("canonical version history is strict, bounded, ordered, and current-compatible", () => {
  const catalog = decodeVersionedCatalog(
    readJson("fixtures/catalog/valid-versioned-history.json"),
    "valid versioned history",
  );
  const entry = requiredArrayValue(catalog.skills, 0);
  const extension = entry["x-remote-skills"];

  assert.equal(extension.releases.length, 4);
  assert.ok(extension.releases.length <= 100);
  for (const [index, release] of extension.releases.entries()) {
    assertRelease(release, `releases[${index}]`);
  }
  assert.equal(new Set(extension.releases.map(({ version }) => version)).size, 4);
  const current = extension.releases.find(({ version }) => version === extension.version);
  assert.deepEqual(current, {
    version: extension.version,
    type: entry.type,
    url: entry.url,
    digest: entry.digest,
  });
  const expectedOrder = [...extension.releases].sort(
    (left, right) =>
      compareSemver(right.version, left.version) || compareAscii(left.version, right.version),
  );
  assert.deepEqual(extension.releases, expectedOrder);
});

test("prerelease history and the 101-release rejection boundary are explicit", () => {
  const prereleaseCatalog = decodeVersionedCatalog(
    readJson("fixtures/catalog/valid-versioned-prerelease.json"),
    "valid versioned prerelease",
  );
  assert.deepEqual(
    requiredArrayValue(prereleaseCatalog.skills, 0)["x-remote-skills"].releases.map(
      ({ version }) => version,
    ),
    ["1.5.0", "1.5.0-beta.2", "1.5.0-beta.1", "1.4.7"],
  );
  const overLimitCatalog = decodeVersionedCatalog(
    readJson("fixtures/catalog/invalid-version-over-limit.json"),
    "invalid version over limit",
  );
  const versions = requiredArrayValue(overLimitCatalog.skills, 0)["x-remote-skills"].releases.map(
    ({ version }) => version,
  );
  assert.equal(versions.length, 101);
  assert.equal(new Set(versions).size, 101);
  assert.equal(versions[0], "1.0.100");
  assert.equal(versions.at(-1), "1.0.0");
  assert.throws(() => parseStrictSemver("1.0.0-01"), /numeric prerelease/);
});

test("historical versions use strict SemVer and lexical full-version precedence ties", () => {
  const malformedHistorical = decodeVersionedCatalog(
    readJson("fixtures/catalog/invalid-version-historical-semver.json"),
    "invalid historical semver",
  );
  const numericPrerelease = decodeVersionedCatalog(
    readJson("fixtures/catalog/invalid-version-numeric-prerelease.json"),
    "invalid numeric prerelease",
  );
  const buildTie = decodeVersionedCatalog(
    readJson("fixtures/catalog/valid-versioned-build-metadata-tie.json"),
    "build metadata tie",
  );

  const malformed = requiredArrayValue(malformedHistorical.skills, 0)["x-remote-skills"];
  const invalidNumeric = requiredArrayValue(numericPrerelease.skills, 0)["x-remote-skills"];
  parseStrictSemver(malformed.version);
  assert.throws(
    () => parseStrictSemver(requiredArrayValue(malformed.releases, 1).version),
    /strict SemVer/,
  );
  assert.throws(
    () => parseStrictSemver(requiredArrayValue(invalidNumeric.releases, 1).version),
    /numeric prerelease/,
  );

  const tiedReleases = requiredArrayValue(buildTie.skills, 0)["x-remote-skills"].releases.slice(1);
  const firstTie = requiredArrayValue(tiedReleases, 0);
  const secondTie = requiredArrayValue(tiedReleases, 1);
  assert.equal(compareSemver(firstTie.version, secondTie.version), 0);
  assert.ok(compareAscii(firstTie.version, secondTie.version) < 0);
  assert.deepEqual(
    tiedReleases,
    [...tiedReleases].sort(
      (left, right) =>
        compareSemver(right.version, left.version) || compareAscii(left.version, right.version),
    ),
  );
});

test("SemVer prerelease identifiers follow ASCII order across letter case", () => {
  assert.equal(compareSemver("1.0.0-Beta", "1.0.0-alpha"), -1);
  assert.equal(compareSemver("1.0.0-alpha", "1.0.0-Beta"), 1);
  assert.equal(compareSemver("1.0.0-Alpha", "1.0.0-alpha"), -1);
  assert.equal(compareSemver("1.0.0-Alpha", "1.0.0-Alpha"), 0);
  assert.deepEqual(
    ["1.0.0-Alpha", "1.0.0-alpha", "1.0.0-Beta"].sort((left, right) => compareSemver(right, left)),
    ["1.0.0-alpha", "1.0.0-Beta", "1.0.0-Alpha"],
  );
});

test("SemVer build metadata ties follow ASCII full-version order across letter case", () => {
  for (const base of ["1.0.0", "1.0.0-rc.1"]) {
    const alpha = `${base}+Alpha`;
    const beta = `${base}+Beta`;
    const lowerAlpha = `${base}+alpha`;
    assert.equal(compareSemver(alpha, beta), 0);
    assert.equal(compareSemver(beta, lowerAlpha), 0);
    assert.equal(compareAscii(alpha, alpha), 0);
    assert.equal(compareAscii(alpha, lowerAlpha), -1);
    assert.equal(compareAscii(lowerAlpha, alpha), 1);
    assert.deepEqual(
      [lowerAlpha, alpha, beta].sort(
        (left, right) => compareSemver(right, left) || compareAscii(left, right),
      ),
      [alpha, beta, lowerAlpha],
    );
  }
});

test("SemVer ordering preserves core and prerelease integers above MAX_SAFE_INTEGER", () => {
  const catalog = decodeVersionedCatalog(
    readJson("fixtures/catalog/valid-versioned-large-numeric.json"),
    "large numeric versions",
  );
  const releases = requiredArrayValue(catalog.skills, 0)["x-remote-skills"].releases;

  assert.ok(
    compareSemver(
      requiredArrayValue(releases, 0).version,
      requiredArrayValue(releases, 1).version,
    ) > 0,
  );
  assert.ok(
    compareSemver(
      requiredArrayValue(releases, 2).version,
      requiredArrayValue(releases, 3).version,
    ) > 0,
  );
  assert.deepEqual(
    releases,
    [...releases].sort(
      (left, right) =>
        compareSemver(right.version, left.version) || compareAscii(left.version, right.version),
    ),
  );
});

test("range expectations select independently reviewed versions", () => {
  const expected = decodeScopeResults(
    readJson("expected-results/scope-version-catalog-results.json"),
    "scope version results",
  );
  const selectedVersions = new Map(
    expected.cases
      .filter(({ id }) => id.startsWith("version-select-") || id === "version-build-metadata-tie")
      .map(({ id, result }) => [
        id,
        requiredString(result.selected_version, `${id}.selected_version`),
      ]),
  );
  assert.deepEqual(
    selectedVersions,
    new Map([
      ["version-select-no-constraint", "2.0.0"],
      ["version-select-star", "2.0.0"],
      ["version-select-major-x", "1.5.1"],
      ["version-select-minor-x", "1.4.7"],
      ["version-select-caret", "1.5.1"],
      ["version-select-tilde", "1.4.7"],
      ["version-select-exact", "1.4.2"],
      ["version-build-metadata-tie", "1.4.7+build.10"],
      ["version-select-large-core-numeric", "9007199254740993.0.0"],
      ["version-select-large-prerelease-numeric", "1.0.0-9007199254740993"],
    ]),
  );
});

test("publisher history and version-removal inventories are complete", () => {
  const publisherFixtures = jsonCaseDocument(
    readJson("fixtures/publisher/version-history-cases.json"),
    "publisher history fixtures",
    decodeId,
  );
  const publisherExpected = jsonCaseDocument(
    readJson("expected-results/publisher-version-history-results.json"),
    "publisher history results",
    decodeId,
  );
  assert.deepEqual(
    publisherFixtures.cases.map(({ id }) => id),
    requiredPublisherHistoryIds,
  );
  assert.deepEqual(
    publisherExpected.cases.map(({ id }) => id),
    requiredPublisherHistoryIds,
  );

  const networkFixtures = jsonCaseDocument(
    readJson("fixtures/network/scope-version-network-cases.json"),
    "scope network fixtures",
    decodeId,
  );
  const networkExpected = jsonCaseDocument(
    readJson("expected-results/scope-version-network-results.json"),
    "scope network results",
    decodeId,
  );
  const fixtureIds = networkFixtures.cases
    .map(({ id }) => id)
    .filter((id) => id.startsWith("version-removal-"));
  const expectedIds = networkExpected.cases
    .map(({ id }) => id)
    .filter((id) => id.startsWith("version-removal-"));
  assert.deepEqual(fixtureIds, requiredVersionRemovalIds);
  assert.deepEqual(expectedIds, requiredVersionRemovalIds);
});

test("publisher history expectations preserve, prune, reject remaps, and enforce the bound", () => {
  const fixtures = jsonCaseDocument(
    readJson("fixtures/publisher/version-history-cases.json"),
    "publisher history fixtures",
    decodePublisherHistoryFixture,
  );
  const expected = decodeScopeResults(
    readJson("expected-results/publisher-version-history-results.json"),
    "publisher history results",
  );
  const byId = new Map(expected.cases.map(({ id, result }) => [id, result]));

  for (const fixture of fixtures.cases) {
    assert.equal(fixture.skill_name, "code-review");
    assertRelease(fixture.current, `${fixture.id}.current`);
    for (const [index, release] of (fixture.prior_releases ?? []).entries()) {
      assertRelease(release, `${fixture.id}.prior_releases[${index}]`);
    }
  }
  assert.deepEqual(requiredMapValue(byId, "history-prior-retained").releases, ["2.0.0", "1.4.7"]);
  assert.equal(requiredMapValue(byId, "history-prior-retained").artifacts_retained, 1);
  assert.deepEqual(requiredMapValue(byId, "history-explicit-prune").releases, ["2.0.0"]);
  assert.equal(requiredMapValue(byId, "history-version-remapped").output_replaced, false);
  assert.equal(
    requiredError(requiredMapValue(byId, "history-version-remapped"), "history-version-remapped")
      .code,
    "configuration_invalid",
  );
  const overLimit = fixtures.cases.find(({ id }) => id === "history-over-limit");
  assert.ok(overLimit);
  assert.equal(overLimit.prior_release_count, 100);
  assert.equal(
    requiredError(requiredMapValue(byId, "history-over-limit"), "history-over-limit").code,
    "limit_exceeded",
  );
  assert.equal(
    requiredError(requiredMapValue(byId, "history-over-limit"), "history-over-limit").context.limit,
    100,
  );
});

test("online release removal cannot resurrect cache while bounded stale use remains explicit", () => {
  const fixtures = decodeOfflineRemoval(readJson("fixtures/network/offline-removal.json"));
  const expected = decodeScopeResults(
    readJson("expected-results/scope-version-network-results.json"),
    "scope network results",
  );
  const results = new Map(expected.cases.map(({ id, result }) => [id, result]));

  const existing = fixtures["version-removal-existing"];
  const future = fixtures["version-removal-future-online"];
  const stale = fixtures["version-removal-explicit-stale"];
  assert.ok(existing && future && stale);
  assert.equal(existing.pinned_version, "1.4.7");
  assert.deepEqual(future.cached_versions, ["1.4.7"]);
  assert.equal(
    requiredError(
      requiredMapValue(results, "version-removal-future-online"),
      "version-removal-future-online",
    ).code,
    "version_unavailable",
  );
  assert.equal(requiredMapValue(results, "version-removal-future-online").requests, 1);
  assert.ok(
    requiredNumber(
      stale.cached_catalog_age_seconds,
      "version-removal-explicit-stale.cached_catalog_age_seconds",
    ) <=
      requiredNumber(
        stale.maximum_age_seconds,
        "version-removal-explicit-stale.maximum_age_seconds",
      ),
  );
  assert.equal(
    requiredMapValue(results, "version-removal-explicit-stale").selected_version,
    "1.4.7",
  );
  assert.equal(requiredMapValue(results, "version-removal-explicit-stale").stale, true);
  assert.equal(requiredMapValue(results, "version-removal-explicit-stale").requests, 0);
});

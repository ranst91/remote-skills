import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  jsonArray,
  jsonBoolean,
  jsonNumber,
  jsonObject,
  jsonString,
  jsonStringArray,
  jsonValue,
} from "../helpers/contract-helpers.ts";

const root = process.argv[2] ? resolve(process.argv[2]) : resolve(import.meta.dirname, "..");
interface ErrorDefinition {
  code: string;
  context: string[];
  retryable: boolean;
}

interface ProtocolError {
  code: string;
  context: { [field: string]: unknown };
  retryable: boolean;
}

interface NormalizedShape {
  optional: string[];
  required: string[];
}

interface NormalizedContract {
  error_shape: { forbidden: string[]; optional: string[]; required: string[] };
  expected_result_files: { [filename: string]: string };
  field_types: { [field: string]: string };
  shapes: { [outcome: string]: NormalizedShape };
}

interface NormalizedFile {
  media_type: string;
  path: string;
  size: number;
}

interface NormalizedRelease {
  artifact_type: string;
  digest: string;
  url: string;
  version: string;
}

interface NormalizedEntry {
  artifact_type: string;
  description: string;
  digest: string;
  name: string;
  origin_alias: string;
  releases?: NormalizedRelease[];
  url: string;
  version?: string;
}

interface NormalizedResult {
  entries?: NormalizedEntry[];
  files?: NormalizedFile[];
  frontmatter?: { description: string; name: string };
  name?: string;
  outcome: string;
  releases?: string[];
  selected_version?: string;
  [field: string]: unknown;
}

interface RequestSnapshot {
  headers: { [name: string]: string };
  method: string;
  sensitive_header_names: string[];
  [field: string]: unknown;
}

interface PublisherArtifact {
  bytes: number;
  format?: string;
  path: string;
  sha256: string;
  skill: string;
  type: string;
}

interface PublisherFile {
  compressed_size?: number;
  path: string;
  sha256: string;
  size: number;
}

interface PublisherGolden {
  artifacts: PublisherArtifact[];
  index: { bytes: number; path: string; sha256: string };
  normalized_archive: {
    directory_entries: string;
    files: PublisherFile[];
    [field: string]: unknown;
  };
}

interface NormalizedCaseDocument {
  cases: { id: string; result: NormalizedResult }[];
  contract_version: number;
}

interface PublisherDocument {
  contract_version: number;
  formats: { [format: string]: PublisherGolden };
}

function readJson(path: string): unknown {
  const parsed: unknown = JSON.parse(readFileSync(resolve(root, path), "utf8"));
  return parsed;
}

function decodeStringMap(value: unknown, label: string): { [field: string]: string } {
  const raw = jsonObject(value, label);
  const decoded: { [field: string]: string } = {};
  for (const [field, item] of Object.entries(raw))
    decoded[field] = jsonString(item, `${label}.${field}`);
  return decoded;
}

function decodeNormalizedContract(value: unknown): NormalizedContract {
  const raw = jsonObject(value, "normalized contract");
  const errorShape = jsonObject(
    jsonValue(raw, "error_shape", "normalized contract"),
    "normalized contract.error_shape",
  );
  const rawShapes = jsonObject(
    jsonValue(raw, "shapes", "normalized contract"),
    "normalized contract.shapes",
  );
  const shapes: { [outcome: string]: NormalizedShape } = {};
  for (const [outcome, item] of Object.entries(rawShapes)) {
    const label = `normalized contract.shapes.${outcome}`;
    const shape = jsonObject(item, label);
    shapes[outcome] = {
      optional: jsonStringArray(jsonValue(shape, "optional", label), `${label}.optional`),
      required: jsonStringArray(jsonValue(shape, "required", label), `${label}.required`),
    };
  }
  return {
    error_shape: {
      forbidden: jsonStringArray(
        jsonValue(errorShape, "forbidden", "normalized contract.error_shape"),
        "normalized contract.error_shape.forbidden",
      ),
      optional: jsonStringArray(
        jsonValue(errorShape, "optional", "normalized contract.error_shape"),
        "normalized contract.error_shape.optional",
      ),
      required: jsonStringArray(
        jsonValue(errorShape, "required", "normalized contract.error_shape"),
        "normalized contract.error_shape.required",
      ),
    },
    expected_result_files: decodeStringMap(
      jsonValue(raw, "expected_result_files", "normalized contract"),
      "normalized contract.expected_result_files",
    ),
    field_types: decodeStringMap(
      jsonValue(raw, "field_types", "normalized contract"),
      "normalized contract.field_types",
    ),
    shapes,
  };
}

function decodeErrorContract(value: unknown): { errors: ErrorDefinition[] } {
  const raw = jsonObject(value, "error contract");
  return {
    errors: jsonArray(jsonValue(raw, "errors", "error contract"), "error contract.errors").map(
      (item, index) => {
        const label = `error contract.errors[${index}]`;
        const definition = jsonObject(item, label);
        return {
          code: jsonString(jsonValue(definition, "code", label), `${label}.code`),
          context: jsonStringArray(jsonValue(definition, "context", label), `${label}.context`),
          retryable: jsonBoolean(jsonValue(definition, "retryable", label), `${label}.retryable`),
        };
      },
    ),
  };
}

const contract = decodeNormalizedContract(readJson("contracts/v0/normalized-results.json"));
const errorContract = decodeErrorContract(readJson("contracts/v0/error-codes.json"));
const redactionPolicy = jsonObject(readJson("contracts/v0/redaction.json"), "redaction policy");
const neverSnapshotHeaderNames = new Set(
  jsonStringArray(
    jsonValue(redactionPolicy, "never_snapshot_fields", "redaction policy"),
    "redaction policy.never_snapshot_fields",
  ).map((name) => name.toLowerCase()),
);
const errorDefinitions = new Map(
  errorContract.errors.map((definition) => [definition.code, definition]),
);
let records = 0;
const strictSemver =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

function assertProtocolErrorValue(value: unknown): asserts value is ProtocolError {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  assert.ok("code" in value && typeof value.code === "string");
  assert.ok("retryable" in value && typeof value.retryable === "boolean");
  assert.ok(
    "context" in value &&
      value.context !== null &&
      typeof value.context === "object" &&
      !Array.isArray(value.context),
  );
}

function decodeProtocolError(value: unknown, label: string): ProtocolError {
  const error = jsonObject(value, label);
  assertFields(error, contract.error_shape.required, contract.error_shape.optional, label);
  const context = jsonObject(jsonValue(error, "context", label), `${label}.context`);
  return {
    code: jsonString(jsonValue(error, "code", label), `${label}.code`),
    context: { ...context },
    retryable: jsonBoolean(jsonValue(error, "retryable", label), `${label}.retryable`),
  };
}

function decodeRelease(value: unknown, label: string): NormalizedRelease {
  const release = jsonObject(value, label);
  assertFields(release, ["version", "artifact_type", "url", "digest"], [], label);
  return {
    artifact_type: jsonString(jsonValue(release, "artifact_type", label), `${label}.artifact_type`),
    digest: jsonString(jsonValue(release, "digest", label), `${label}.digest`),
    url: jsonString(jsonValue(release, "url", label), `${label}.url`),
    version: jsonString(jsonValue(release, "version", label), `${label}.version`),
  };
}

function decodeEntry(value: unknown, label: string): NormalizedEntry {
  const entry = jsonObject(value, label);
  assertFields(
    entry,
    ["origin_alias", "name", "description", "artifact_type", "url", "digest"],
    ["version", "releases"],
    label,
  );
  const releases = Object.hasOwn(entry, "releases")
    ? jsonArray(jsonValue(entry, "releases", label), `${label}.releases`).map((release, index) =>
        decodeRelease(release, `${label}.releases[${index}]`),
      )
    : undefined;
  const version = Object.hasOwn(entry, "version")
    ? jsonString(jsonValue(entry, "version", label), `${label}.version`)
    : undefined;
  return {
    artifact_type: jsonString(jsonValue(entry, "artifact_type", label), `${label}.artifact_type`),
    description: jsonString(jsonValue(entry, "description", label), `${label}.description`),
    digest: jsonString(jsonValue(entry, "digest", label), `${label}.digest`),
    name: jsonString(jsonValue(entry, "name", label), `${label}.name`),
    origin_alias: jsonString(jsonValue(entry, "origin_alias", label), `${label}.origin_alias`),
    url: jsonString(jsonValue(entry, "url", label), `${label}.url`),
    ...(releases === undefined ? {} : { releases }),
    ...(version === undefined ? {} : { version }),
  };
}

function decodeNormalizedFile(value: unknown, label: string): NormalizedFile {
  const file = jsonObject(value, label);
  assertFields(file, ["path", "size", "media_type"], [], label);
  return {
    media_type: jsonString(jsonValue(file, "media_type", label), `${label}.media_type`),
    path: jsonString(jsonValue(file, "path", label), `${label}.path`),
    size: jsonNumber(jsonValue(file, "size", label), `${label}.size`),
  };
}

function decodeNormalizedResult(value: unknown, label: string): NormalizedResult {
  const result = jsonObject(value, label);
  const entries = Object.hasOwn(result, "entries")
    ? jsonArray(jsonValue(result, "entries", label), `${label}.entries`).map((entry, index) =>
        decodeEntry(entry, `${label}.entries[${index}]`),
      )
    : undefined;
  const files = Object.hasOwn(result, "files")
    ? jsonArray(jsonValue(result, "files", label), `${label}.files`).map((file, index) =>
        decodeNormalizedFile(file, `${label}.files[${index}]`),
      )
    : undefined;
  const releases = Object.hasOwn(result, "releases")
    ? jsonStringArray(jsonValue(result, "releases", label), `${label}.releases`)
    : undefined;
  const selectedVersion = Object.hasOwn(result, "selected_version")
    ? jsonString(jsonValue(result, "selected_version", label), `${label}.selected_version`)
    : undefined;
  const name = Object.hasOwn(result, "name")
    ? jsonString(jsonValue(result, "name", label), `${label}.name`)
    : undefined;
  let frontmatter: NormalizedResult["frontmatter"];
  if (Object.hasOwn(result, "frontmatter")) {
    const rawFrontmatter = jsonObject(
      jsonValue(result, "frontmatter", label),
      `${label}.frontmatter`,
    );
    assertFields(
      rawFrontmatter,
      ["name", "description"],
      ["license", "compatibility", "allowed-tools", "metadata"],
      `${label}.frontmatter`,
    );
    frontmatter = {
      description: jsonString(
        jsonValue(rawFrontmatter, "description", `${label}.frontmatter`),
        `${label}.frontmatter.description`,
      ),
      name: jsonString(
        jsonValue(rawFrontmatter, "name", `${label}.frontmatter`),
        `${label}.frontmatter.name`,
      ),
    };
  }
  return {
    ...result,
    outcome: jsonString(jsonValue(result, "outcome", label), `${label}.outcome`),
    ...(entries === undefined ? {} : { entries }),
    ...(files === undefined ? {} : { files }),
    ...(frontmatter === undefined ? {} : { frontmatter }),
    ...(name === undefined ? {} : { name }),
    ...(releases === undefined ? {} : { releases }),
    ...(selectedVersion === undefined ? {} : { selected_version: selectedVersion }),
  };
}

function decodeRequest(value: unknown, label: string): RequestSnapshot {
  const request = jsonObject(value, label);
  const headers = jsonObject(
    jsonValue(request, "headers", "request snapshot"),
    "request snapshot headers",
  );
  return {
    ...request,
    headers: Object.fromEntries(
      Object.entries(headers).map(([name, value]) => [
        name,
        jsonString(value, "request snapshot header value"),
      ]),
    ),
    method: jsonString(jsonValue(request, "method", label), `${label}.method`),
    sensitive_header_names: jsonStringArray(
      jsonValue(request, "sensitive_header_names", "request snapshot"),
      "request snapshot sensitive header names",
    ),
  };
}

function decodeNormalizedDocument(value: unknown, label: string): NormalizedCaseDocument {
  const document = jsonObject(value, label);
  assertFields(document, ["contract_version", "cases"], [], label);
  return {
    cases: jsonArray(jsonValue(document, "cases", label), `${label}.cases`).map((item, index) => {
      const itemLabel = `${label}.cases[${index}]`;
      const entry = jsonObject(item, itemLabel);
      assertFields(entry, ["id", "result"], [], itemLabel);
      return {
        id: jsonString(jsonValue(entry, "id", itemLabel), `${itemLabel}.id`),
        result: decodeNormalizedResult(
          jsonValue(entry, "result", itemLabel),
          `${itemLabel}.result`,
        ),
      };
    }),
    contract_version: jsonNumber(
      jsonValue(document, "contract_version", label),
      `${label}.contract_version`,
    ),
  };
}

function decodeArtifact(value: unknown, label: string): PublisherArtifact {
  const artifact = jsonObject(value, label);
  assertFields(
    artifact,
    ["skill", "type", "path", "sha256", "bytes"],
    jsonValue(artifact, "type", label) === "archive" ? ["format"] : [],
    label,
  );
  const format = Object.hasOwn(artifact, "format")
    ? jsonString(jsonValue(artifact, "format", label), `${label}.format`)
    : undefined;
  return {
    bytes: jsonNumber(jsonValue(artifact, "bytes", label), `${label}.bytes`),
    path: jsonString(jsonValue(artifact, "path", label), `${label}.path`),
    sha256: jsonString(jsonValue(artifact, "sha256", label), `${label}.sha256`),
    skill: jsonString(jsonValue(artifact, "skill", label), `${label}.skill`),
    type: jsonString(jsonValue(artifact, "type", label), `${label}.type`),
    ...(format === undefined ? {} : { format }),
  };
}

function decodePublisherFile(value: unknown, label: string, format: string): PublisherFile {
  const file = jsonObject(value, label);
  assertFields(
    file,
    ["path", "size", "sha256"],
    format === "zip" ? ["compressed_size"] : [],
    label,
  );
  const compressedSize = Object.hasOwn(file, "compressed_size")
    ? jsonNumber(jsonValue(file, "compressed_size", label), `${label}.compressed_size`)
    : undefined;
  return {
    path: jsonString(jsonValue(file, "path", label), `${label}.path`),
    sha256: jsonString(jsonValue(file, "sha256", label), `${label}.sha256`),
    size: jsonNumber(jsonValue(file, "size", label), `${label}.size`),
    ...(compressedSize === undefined ? {} : { compressed_size: compressedSize }),
  };
}

function decodePublisherDocument(value: unknown, label: string): PublisherDocument {
  const document = jsonObject(value, label);
  assertFields(document, ["contract_version", "formats"], [], label);
  const rawFormats = jsonObject(jsonValue(document, "formats", label), `${label}.formats`);
  const formats: { [format: string]: PublisherGolden } = {};
  for (const [format, item] of Object.entries(rawFormats)) {
    const formatLabel = `${label}.formats.${format}`;
    const golden = jsonObject(item, formatLabel);
    assertFields(golden, ["index", "artifacts", "normalized_archive"], [], formatLabel);
    const index = jsonObject(jsonValue(golden, "index", formatLabel), `${formatLabel}.index`);
    assertFields(index, ["path", "sha256", "bytes"], [], `${formatLabel}.index`);
    const archive = jsonObject(
      jsonValue(golden, "normalized_archive", formatLabel),
      `${formatLabel}.normalized_archive`,
    );
    formats[format] = {
      artifacts: jsonArray(
        jsonValue(golden, "artifacts", formatLabel),
        `${formatLabel}.artifacts`,
      ).map((artifact, artifactIndex) =>
        decodeArtifact(artifact, `${formatLabel}.artifacts[${artifactIndex}]`),
      ),
      index: {
        bytes: jsonNumber(
          jsonValue(index, "bytes", `${formatLabel}.index`),
          `${formatLabel}.index.bytes`,
        ),
        path: jsonString(
          jsonValue(index, "path", `${formatLabel}.index`),
          `${formatLabel}.index.path`,
        ),
        sha256: jsonString(
          jsonValue(index, "sha256", `${formatLabel}.index`),
          `${formatLabel}.index.sha256`,
        ),
      },
      normalized_archive: {
        ...archive,
        directory_entries: jsonString(
          jsonValue(archive, "directory_entries", `${formatLabel}.normalized_archive`),
          `${formatLabel}.normalized_archive.directory_entries`,
        ),
        files: jsonArray(
          jsonValue(archive, "files", `${formatLabel}.normalized_archive`),
          `${formatLabel}.normalized_archive.files`,
        ).map((file, fileIndex) =>
          decodePublisherFile(
            file,
            `${formatLabel}.normalized_archive.files[${fileIndex}]`,
            format,
          ),
        ),
      },
    };
  }
  return {
    contract_version: jsonNumber(
      jsonValue(document, "contract_version", label),
      `${label}.contract_version`,
    ),
    formats,
  };
}

function assertStrictSemver(value: unknown, label: string): void {
  if (typeof value !== "string") throw new TypeError(label);
  const match = strictSemver.exec(value);
  assert.ok(match, `${label} is not strict SemVer`);
  for (const identifier of match[4]?.split(".") ?? []) {
    assert.equal(
      /^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith("0"),
      false,
      `${label} numeric prerelease identifier has a leading zero`,
    );
  }
}

function assertFields(
  value: object,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  assert.ok(
    value && !Array.isArray(value) && typeof value === "object",
    `${label} is not an object`,
  );
  for (const field of required) assert.ok(Object.hasOwn(value, field), `${label} omits ${field}`);
  const allowed = new Set([...required, ...optional]);
  for (const field of Object.keys(value))
    assert.ok(allowed.has(field), `${label} has undeclared ${field}`);
}

function assertType(value: unknown, type: string | undefined, label: string): void {
  if (type === "integer") {
    assert.ok(typeof value === "number");
    assert.ok(Number.isSafeInteger(value) && value >= 0, label);
  } else if (type === "boolean") assert.equal(typeof value, "boolean", label);
  else if (type === "string") assert.equal(typeof value, "string", label);
  else if (type === "array") assert.ok(Array.isArray(value), label);
  else if (type === "object")
    assert.ok(value && !Array.isArray(value) && typeof value === "object", label);
  else if (type === "digest") {
    assert.ok(typeof value === "string");
    assert.match(value, /^sha256:[0-9a-f]{64}$/, label);
  } else if (type === "error") {
    assertProtocolErrorValue(value);
    assertError(value, label);
  } else assert.fail(`${label} uses unknown type ${type}`);
}

function assertContextValue(value: unknown, field: string, label: string): void {
  if (field === "expected_digest") assertType(value, "digest", label);
  else if (field === "status") {
    assert.ok(typeof value === "number");
    assert.ok(Number.isSafeInteger(value) && value >= 100 && value <= 599, label);
  } else if (field === "limit")
    assert.ok(
      (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) ||
        (typeof value === "string" && value.length > 0),
      label,
    );
  else if (field === "version") assertStrictSemver(value, label);
  else assert.ok(typeof value === "string" && value.length > 0, label);
}

function assertError(error: ProtocolError, label: string): void {
  assertFields(error, contract.error_shape.required, contract.error_shape.optional, label);
  const definition = errorDefinitions.get(error.code);
  assert.ok(definition, `${label} has unknown code ${error.code}`);
  assert.equal(
    error.retryable,
    definition.retryable,
    `${label}.retryable contradicts ${error.code}`,
  );
  assertType(error.context, "object", `${label}.context`);
  assertFields(error.context, [], definition.context, `${label}.context`);
  for (const [field, value] of Object.entries(error.context)) {
    assertContextValue(value, field, `${label}.context.${field}`);
  }
  if (error.code === "authentication_failed") {
    assert.equal(error.context.status, 401, `${label}.context.status`);
  } else if (error.code === "authorization_denied") {
    assert.equal(error.context.status, 403, `${label}.context.status`);
  }
  const serialized = JSON.stringify(error);
  for (const field of contract.error_shape.forbidden) {
    assert.equal(Object.hasOwn(error, field), false, `${label} exposes ${field}`);
    assert.equal(Object.hasOwn(error.context, field), false, `${label}.context exposes ${field}`);
  }
  assert.equal(
    serialized.includes("$RUNTIME_"),
    false,
    `${label} contains a runtime secret placeholder`,
  );
}

function assertNormalized(result: NormalizedResult, label: string): void {
  const shape = contract.shapes[result.outcome];
  assert.ok(shape, `${label} has undeclared outcome ${result.outcome}`);
  assertFields(result, shape.required, shape.optional, label);
  for (const [field, value] of Object.entries(result)) {
    assertType(value, contract.field_types[field], `${label}.${field}`);
  }
  if (Object.hasOwn(result, "selected_version")) {
    assertStrictSemver(result.selected_version, `${label}.selected_version`);
  }
  if (result.outcome === "publisher_history_success") {
    assert.ok(result.releases);
    for (const [index, release] of result.releases.entries()) {
      assertStrictSemver(release, `${label}.releases[${index}]`);
    }
  }
  for (const file of result.files ?? []) {
    assertFields(file, ["path", "size", "media_type"], [], `${label}.files[]`);
    assert.equal(typeof file.path, "string");
    assert.ok(Number.isSafeInteger(file.size) && file.size >= 0);
    assert.equal(typeof file.media_type, "string");
    records += 1;
  }
  for (const entry of result.entries ?? []) {
    assertFields(
      entry,
      ["origin_alias", "name", "description", "artifact_type", "url", "digest"],
      ["version", "releases"],
      `${label}.entries[]`,
    );
    assert.match(entry.digest, /^sha256:[0-9a-f]{64}$/);
    const parsed = URL.parse(entry.url, "https://fixture.invalid");
    assert.ok(parsed !== null, "normalized entry URL is invalid");
    assert.equal(
      parsed.username === "" &&
        parsed.password === "" &&
        parsed.search === "" &&
        parsed.hash === "",
      true,
      "normalized entry URL contains disallowed components",
    );
    if (Object.hasOwn(entry, "version"))
      assertStrictSemver(entry.version, `${label}.entries[].version`);
    if (Object.hasOwn(entry, "releases"))
      assertType(entry.releases, "array", `${label}.entries[].releases`);
    for (const release of entry.releases ?? []) {
      assertFields(
        release,
        ["version", "artifact_type", "url", "digest"],
        [],
        `${label}.entries[].releases[]`,
      );
      assertStrictSemver(release.version, `${label}.entries[].releases[].version`);
      assertType(release.artifact_type, "string", `${label}.entries[].releases[].artifact_type`);
      assertType(release.digest, "digest", `${label}.entries[].releases[].digest`);
      const releaseUrl = URL.parse(release.url, "https://fixture.invalid");
      assert.ok(releaseUrl !== null, "normalized release URL is invalid");
      assert.equal(
        releaseUrl.username === "" &&
          releaseUrl.password === "" &&
          releaseUrl.search === "" &&
          releaseUrl.hash === "",
        true,
        "normalized release URL contains disallowed components",
      );
      records += 1;
    }
    records += 1;
  }
  if (result.outcome === "activation_success") {
    assert.ok(result.frontmatter);
    assertFields(
      result.frontmatter,
      ["name", "description"],
      ["license", "compatibility", "allowed-tools", "metadata"],
      `${label}.frontmatter`,
    );
    assert.equal(result.frontmatter.name, result.name, `${label}.frontmatter.name`);
  }
  records += 1;
}

function assertRequest(
  request: RequestSnapshot,
  label: string,
  locationField: "path" | "url",
): void {
  const required = ["method", locationField, "headers", "sensitive_header_names"];
  const optional = locationField === "path" ? ["boundary"] : [];
  assertFields(request, required, optional, label);
  assert.equal(request.method, "GET", `${label}.method`);
  assert.equal(typeof request[locationField], "string", `${label}.${locationField}`);
  assertType(request.headers, "object", `${label}.headers`);
  assert.ok(Array.isArray(request.sensitive_header_names), `${label}.sensitive_header_names`);
  const sensitiveHeaderNames = new Set([
    ...neverSnapshotHeaderNames,
    ...request.sensitive_header_names.map((name) => name.toLowerCase()),
  ]);
  assert.equal(
    Object.keys(request.headers).some((name) => sensitiveHeaderNames.has(name.toLowerCase())),
    false,
    "request snapshot contains a sensitive header name",
  );
  const location = request[locationField];
  assert.ok(typeof location === "string");
  assert.equal(/[?#]/.test(location), false, `${label} persists query or fragment data`);
  if (locationField === "url") {
    const parsed = new URL(location);
    assert.ok(parsed.username === "" && parsed.password === "", `${label} persists userinfo data`);
    assert.equal(parsed.search, "", `${label} persists query data`);
    assert.equal(parsed.hash, "", `${label} persists fragment data`);
  }
  records += 1;
}

function validateNormalizedCases(document: NormalizedCaseDocument, filename: string): void {
  assertFields(document, ["contract_version", "cases"], [], filename);
  assert.equal(document.contract_version, 1, filename);
  for (const item of document.cases) {
    assertFields(item, ["id", "result"], [], `${filename}#case`);
    assert.equal(typeof item.id, "string");
    assertNormalized(item.result, `${filename}#${item.id}`);
    records += 1;
  }
}

function validatePublisher(document: PublisherDocument, filename: string): void {
  assertFields(document, ["contract_version", "formats"], [], filename);
  assert.deepEqual(Object.keys(document.formats), ["tar.gz", "zip"]);
  for (const [format, golden] of Object.entries(document.formats)) {
    assertFields(golden, ["index", "artifacts", "normalized_archive"], [], `${filename}#${format}`);
    assertFields(golden.index, ["path", "sha256", "bytes"], [], `${filename}#${format}.index`);
    assert.match(golden.index.sha256, /^[0-9a-f]{64}$/);
    assert.ok(Number.isSafeInteger(golden.index.bytes));
    records += 2;
    for (const artifact of golden.artifacts) {
      const optional = artifact.type === "archive" ? ["format"] : [];
      assertFields(
        artifact,
        ["skill", "type", "path", "sha256", "bytes"],
        optional,
        `${filename}#${format}.artifact`,
      );
      assert.match(artifact.sha256, /^[0-9a-f]{64}$/);
      assert.ok(Number.isSafeInteger(artifact.bytes));
      records += 1;
    }
    const archive = golden.normalized_archive;
    const formatFields =
      format === "tar.gz"
        ? ["uid", "gid", "owner", "group", "mtime", "gzip_mtime", "gzip_os"]
        : ["timestamp", "utf8_flag_for_ascii_paths", "comments", "extras"];
    assertFields(
      archive,
      [
        "entry_order",
        "file_mode",
        "directory_entries",
        "compression_level",
        "files",
        ...formatFields,
      ],
      [],
      `${filename}#${format}.normalized_archive`,
    );
    assert.equal(archive.directory_entries, "omitted");
    for (const file of archive.files) {
      const optional = format === "zip" ? ["compressed_size"] : [];
      assertFields(file, ["path", "size", "sha256"], optional, `${filename}#${format}.file`);
      assert.match(file.sha256, /^[0-9a-f]{64}$/);
      assert.ok(Number.isSafeInteger(file.size));
      records += 1;
    }
  }
}

const files = readdirSync(resolve(root, "expected-results"))
  .filter((path) => path.endsWith(".json"))
  .sort();
assert.deepEqual(files, Object.keys(contract.expected_result_files).sort());
for (const filename of files) {
  const kind = contract.expected_result_files[filename];
  const rawDocument = jsonObject(readJson(`expected-results/${filename}`), filename);
  assert.equal(
    Object.hasOwn(rawDocument, "contract_version") &&
      jsonValue(rawDocument, "contract_version", "expected-result") === 1,
    true,
    "expected-result contract_version must be numeric 1",
  );
  if (kind === "normalized_case_list") {
    validateNormalizedCases(decodeNormalizedDocument(rawDocument, filename), filename);
  } else if (kind === "diagnostic_case_list") {
    const document = jsonObject(rawDocument, filename);
    assertFields(document, ["contract_version", "cases"], [], filename);
    const cases = jsonArray(jsonValue(document, "cases", filename), `${filename}.cases`);
    for (const [index, rawItem] of cases.entries()) {
      const item = jsonObject(rawItem, `${filename}.cases[${index}]`);
      assertFields(item, ["id", "diagnostic"], [], `${filename}#case`);
      const id = jsonString(jsonValue(item, "id", filename), `${filename}.case.id`);
      const diagnostic = decodeProtocolError(
        jsonValue(item, "diagnostic", filename),
        `${filename}#${id}`,
      );
      assertError(diagnostic, `${filename}#${id}`);
      records += 2;
    }
  } else if (kind === "transcript_case_list") {
    const document = jsonObject(rawDocument, filename);
    assertFields(document, ["contract_version", "cases"], [], filename);
    const cases = jsonArray(jsonValue(document, "cases", filename), `${filename}.cases`);
    for (const [index, rawItem] of cases.entries()) {
      const item = jsonObject(rawItem, `${filename}.cases[${index}]`);
      assertFields(item, ["id", "requests"], [], `${filename}#case`);
      const id = jsonString(jsonValue(item, "id", filename), `${filename}.case.id`);
      const requests = jsonArray(
        jsonValue(item, "requests", filename),
        `${filename}#${id}.requests`,
      ).map((request, requestIndex) =>
        decodeRequest(request, `${filename}#${id}.requests[${requestIndex}]`),
      );
      for (const request of requests) assertRequest(request, `${filename}#${id}`, "url");
      records += 1;
    }
  } else if (kind === "network_request_list") {
    const document = jsonObject(rawDocument, filename);
    assertFields(document, ["contract_version", "requests"], [], filename);
    const requests = jsonArray(
      jsonValue(document, "requests", filename),
      `${filename}.requests`,
    ).map((request, index) => decodeRequest(request, `${filename}.requests[${index}]`));
    for (const request of requests) assertRequest(request, filename, "path");
  } else if (kind === "publisher_formats")
    validatePublisher(decodePublisherDocument(rawDocument, filename), filename);
  else assert.fail(`${filename} uses unknown validation kind ${kind}`);
}

process.stdout.write(`validated ${records} records across ${files.length} expected-result files\n`);

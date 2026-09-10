import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readdir, readFile, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import {
  type ActivatedSkill,
  activateSkill,
  createActivationCoordinator,
  verifyCachedExtraction,
} from "./activation/index.ts";
import { DiskCache, MemoryCache } from "./cache/index.ts";
import { requestWithPolicy } from "./catalog/http.ts";
import {
  type CatalogEntry,
  type CatalogRelease,
  createCatalogDiscovery,
  isPublicAddress,
  type NormalizedOrigin,
  normalizeOrigins,
  type OriginCatalog,
  type OriginMap,
  parseCatalog,
  RemoteSkillsError,
  resolveNetworkTarget,
  sanitizeRequest,
  selectCatalogRelease,
  type TransportRequest,
} from "./catalog/index.ts";
import { createRemoteSkills } from "./index.ts";

const execFileAsync = promisify(execFile);

const FIXTURE_INDEX_URL = new URL(
  "https://skills.example.test/.well-known/agent-skills/index.json",
);
const EMPTY_CATALOG = Buffer.from(
  '{"$schema":"https://schemas.agentskills.io/discovery/0.2.0/schema.json","skills":[]}\n',
);
const PUBLIC_ANSWER = [{ address: "93.184.216.34", family: 4 as const }];

type ResponseHeaders =
  | Readonly<{ [name: string]: string }>
  | readonly { name: string; value: string }[];

interface ProtocolFixture {
  after: string;
  artifact_type: "archive" | "skill-md";
  before: string;
  boundary: string;
  category: string;
  configuration: {
    headers: Readonly<{ [name: string]: string }>;
    origin: string;
    scope?: string;
    validators?: { etag?: string; last_modified?: string };
  };
  evaluation_inputs: string;
  files: string[];
  format?: "tar.gz" | "zip";
  id: string;
  index: string;
  input: string;
  limits?: {
    archive_bytes?: number;
    extracted_bytes?: number;
    file_bytes?: number;
    files?: number;
  };
  origin_alias: string;
  path: string;
  request: { headers: Readonly<{ [name: string]: string }>; url: string };
  requested_range?: string;
  response: {
    fixture?: string;
    headers?: ResponseHeaders;
    status: number;
  };
  scenario: string;
  skill_name: string;
  state: string;
}

export type ProtocolFixtureInput = Partial<ProtocolFixture> & Pick<ProtocolFixture, "id">;

interface ProtocolCaseInput {
  contractVersion?: number;
  evidence?: boolean;
  fixture: ProtocolFixture;
  id: string;
  protocolRoot: string;
  suite: string;
}

function required<T>(value: T | undefined, field: string): T {
  if (value === undefined) throw new Error(`protocol fixture is missing ${field}`);
  return value;
}

function jsonObject(value: unknown, label: string): { [key: string]: unknown } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return Object.fromEntries(Object.entries(value));
}

function jsonString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
}

function jsonNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
  return value;
}

function jsonBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

function jsonArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function jsonStringArray(value: unknown, label: string): string[] {
  return jsonArray(value, label).map((item, index) => jsonString(item, `${label}[${index}]`));
}

function jsonNumberArray(value: unknown, label: string): number[] {
  return jsonArray(value, label).map((item, index) => jsonNumber(item, `${label}[${index}]`));
}

function parseProtocolFixtureInput(value: unknown): ProtocolFixtureInput {
  const raw = jsonObject(value, "protocol fixture");
  const configuration =
    raw.configuration === undefined
      ? undefined
      : jsonObject(raw.configuration, "protocol fixture configuration");
  const validators =
    configuration?.validators === undefined
      ? undefined
      : jsonObject(configuration.validators, "protocol fixture validators");
  const limits =
    raw.limits === undefined ? undefined : jsonObject(raw.limits, "protocol fixture limits");
  const request =
    raw.request === undefined ? undefined : jsonObject(raw.request, "protocol fixture request");
  const responseValue =
    raw.response === undefined ? undefined : jsonObject(raw.response, "protocol fixture response");
  const responseHeaders =
    responseValue?.headers === undefined
      ? undefined
      : parseResponseHeaders(responseValue.headers, "protocol fixture response headers");
  const artifactType =
    raw.artifact_type === undefined
      ? undefined
      : jsonString(raw.artifact_type, "protocol fixture artifact_type");
  if (artifactType !== undefined && artifactType !== "archive" && artifactType !== "skill-md") {
    throw new Error("protocol fixture artifact_type is unsupported");
  }
  const format =
    raw.format === undefined ? undefined : jsonString(raw.format, "protocol fixture format");
  if (format !== undefined && format !== "tar.gz" && format !== "zip") {
    throw new Error("protocol fixture format is unsupported");
  }
  return {
    id: jsonString(raw.id, "protocol fixture id"),
    ...(raw.after === undefined ? {} : { after: jsonString(raw.after, "protocol fixture after") }),
    ...(artifactType === undefined ? {} : { artifact_type: artifactType }),
    ...(raw.before === undefined
      ? {}
      : { before: jsonString(raw.before, "protocol fixture before") }),
    ...(raw.boundary === undefined
      ? {}
      : { boundary: jsonString(raw.boundary, "protocol fixture boundary") }),
    ...(raw.category === undefined
      ? {}
      : { category: jsonString(raw.category, "protocol fixture category") }),
    ...(configuration === undefined
      ? {}
      : {
          configuration: {
            headers:
              configuration.headers === undefined
                ? {}
                : jsonStringRecord(configuration.headers, "protocol fixture configuration headers"),
            origin:
              configuration.origin === undefined
                ? ""
                : jsonString(configuration.origin, "protocol fixture configuration origin"),
            ...(configuration.scope === undefined
              ? {}
              : {
                  scope: jsonString(configuration.scope, "protocol fixture configuration scope"),
                }),
            ...(validators === undefined
              ? {}
              : {
                  validators: {
                    ...(validators.etag === undefined
                      ? {}
                      : {
                          etag: jsonString(validators.etag, "protocol fixture validator etag"),
                        }),
                    ...(validators.last_modified === undefined
                      ? {}
                      : {
                          last_modified: jsonString(
                            validators.last_modified,
                            "protocol fixture validator last_modified",
                          ),
                        }),
                  },
                }),
          },
        }),
    ...(raw.evaluation_inputs === undefined
      ? {}
      : {
          evaluation_inputs: jsonString(
            raw.evaluation_inputs,
            "protocol fixture evaluation_inputs",
          ),
        }),
    ...(raw.files === undefined
      ? {}
      : { files: jsonStringArray(raw.files, "protocol fixture files") }),
    ...(format === undefined ? {} : { format }),
    ...(raw.index === undefined ? {} : { index: jsonString(raw.index, "protocol fixture index") }),
    ...(raw.input === undefined ? {} : { input: jsonString(raw.input, "protocol fixture input") }),
    ...(limits === undefined
      ? {}
      : {
          limits: {
            ...(limits.archive_bytes === undefined
              ? {}
              : {
                  archive_bytes: jsonNumber(
                    limits.archive_bytes,
                    "protocol fixture archive byte limit",
                  ),
                }),
            ...(limits.extracted_bytes === undefined
              ? {}
              : {
                  extracted_bytes: jsonNumber(
                    limits.extracted_bytes,
                    "protocol fixture extracted byte limit",
                  ),
                }),
            ...(limits.file_bytes === undefined
              ? {}
              : {
                  file_bytes: jsonNumber(limits.file_bytes, "protocol fixture file byte limit"),
                }),
            ...(limits.files === undefined
              ? {}
              : { files: jsonNumber(limits.files, "protocol fixture file limit") }),
          },
        }),
    ...(raw.origin_alias === undefined
      ? {}
      : { origin_alias: jsonString(raw.origin_alias, "protocol fixture origin_alias") }),
    ...(raw.path === undefined ? {} : { path: jsonString(raw.path, "protocol fixture path") }),
    ...(request === undefined
      ? {}
      : {
          request: {
            headers:
              request.headers === undefined
                ? {}
                : jsonStringRecord(request.headers, "protocol fixture request headers"),
            url: request.url === undefined ? "" : jsonString(request.url, "protocol fixture URL"),
          },
        }),
    ...(raw.requested_range === undefined
      ? {}
      : {
          requested_range: jsonString(raw.requested_range, "protocol fixture requested_range"),
        }),
    ...(responseValue === undefined
      ? {}
      : {
          response: {
            status: jsonNumber(responseValue.status, "protocol fixture response status"),
            ...(responseValue.fixture === undefined
              ? {}
              : {
                  fixture: jsonString(responseValue.fixture, "protocol fixture response fixture"),
                }),
            ...(responseHeaders === undefined ? {} : { headers: responseHeaders }),
          },
        }),
    ...(raw.scenario === undefined
      ? {}
      : { scenario: jsonString(raw.scenario, "protocol fixture scenario") }),
    ...(raw.skill_name === undefined
      ? {}
      : { skill_name: jsonString(raw.skill_name, "protocol fixture skill_name") }),
    ...(raw.state === undefined ? {} : { state: jsonString(raw.state, "protocol fixture state") }),
  };
}

function normalizeProtocolFixture(fixture: ProtocolFixtureInput): ProtocolFixture {
  return {
    after: fixture.after ?? "",
    artifact_type: fixture.artifact_type ?? "skill-md",
    before: fixture.before ?? "",
    boundary: fixture.boundary ?? "",
    category: fixture.category ?? "",
    configuration: fixture.configuration ?? { headers: {}, origin: "" },
    evaluation_inputs: fixture.evaluation_inputs ?? "",
    files: fixture.files ?? [],
    ...(fixture.format === undefined ? {} : { format: fixture.format }),
    id: fixture.id,
    index: fixture.index ?? "",
    input: fixture.input ?? "",
    ...(fixture.limits === undefined ? {} : { limits: fixture.limits }),
    origin_alias: fixture.origin_alias ?? "",
    path: fixture.path ?? "",
    request: fixture.request ?? { headers: {}, url: "" },
    ...(fixture.requested_range === undefined ? {} : { requested_range: fixture.requested_range }),
    response: fixture.response ?? { headers: [], status: 0 },
    scenario: fixture.scenario ?? "",
    skill_name: fixture.skill_name ?? "code-review",
    state: fixture.state ?? "",
  };
}

async function readJson(path: string): Promise<unknown> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  return parsed;
}

async function digestFromFixture(fixture: ProtocolFixture, stateRoot: string) {
  const relative = fixture.files.find((path: string) => path.endsWith("/object.json"));
  if (!relative) throw new Error("cache fixture object metadata is missing");
  const metadata = jsonObject(await readJson(resolve(stateRoot, relative)), "cache metadata");
  return jsonString(metadata.digest, "cache metadata digest");
}

async function runMixedCacheProtocolCase(caseInput: ProtocolCaseInput) {
  const repositoryRoot = resolve(caseInput.protocolRoot, "../..");
  const pythonPackage = resolve(repositoryRoot, "packages/sdk-python");
  const python = process.env.REMOTE_SKILLS_PYTHON ?? "python3";
  const { stdout } = await execFileAsync(
    python,
    [
      "-m",
      "remote_skills.cache.protocol",
      "--case-json",
      JSON.stringify({
        contract_version: caseInput.contractVersion,
        suite: caseInput.suite,
        id: caseInput.id,
        fixture: caseInput.fixture,
        protocol_root: caseInput.protocolRoot,
      }),
    ],
    {
      cwd: repositoryRoot,
      env: { ...process.env, PYTHONPATH: resolve(pythonPackage, "src") },
      maxBuffer: 1024 * 1024,
    },
  );
  const result = jsonObject(JSON.parse(stdout), "mixed cache result");
  return {
    outcome: jsonString(result.outcome, "mixed cache outcome"),
    activations: jsonNumber(result.activations, "mixed cache activations"),
    published_objects: jsonNumber(result.published_objects, "mixed cache published objects"),
    partial_observations: jsonNumber(
      result.partial_observations,
      "mixed cache partial observations",
    ),
    winner: jsonString(result.winner, "mixed cache winner"),
    losing_temp_cleaned: jsonBoolean(result.losing_temp_cleaned, "mixed cache cleanup result"),
  };
}

async function runCacheCase(caseInput: ProtocolCaseInput) {
  const { fixture, id, protocolRoot } = caseInput;
  const stateRoot = resolve(protocolRoot, "fixtures/cache/states", fixture.state);
  if (id === "cache-v1-cross-process") return runMixedCacheProtocolCase(caseInput);

  if (id === "cache-v1-valid") {
    const inputs = jsonObject(
      await readJson(resolve(stateRoot, fixture.evaluation_inputs)),
      "cache evaluation inputs",
    );
    const processLiveness = jsonObject(inputs.process_liveness, "process liveness");
    const digest = await digestFromFixture(fixture, stateRoot);
    const working = await mkdtemp(resolve(tmpdir(), "remote-skills-cache-protocol-valid-"));
    try {
      await cp(resolve(stateRoot, "cache-v1"), resolve(working, "cache-v1"), { recursive: true });
      const cache = new DiskCache({
        directory: working,
        now: () => new Date(jsonString(inputs.now, "evaluation time")),
        isProcessAlive: (pid) => processLiveness[String(pid)] === true,
        maxBytes: 0,
        maxAgeSeconds: 0,
      });
      const cached = await cache.getObject(digest);
      const eviction = await cache.evict();
      if (cached === null || !eviction.retainedPinned.includes(digest)) {
        throw new Error("valid cache fixture is not reusable and pinned");
      }
      return { outcome: "cache_reuse", layout: "cache-v1", artifact_requests: 0, digest };
    } finally {
      await rm(working, { recursive: true, force: true });
    }
  }

  const working = await mkdtemp(resolve(tmpdir(), "remote-skills-cache-protocol-"));
  try {
    if (id === "cache-v2-unknown") {
      await cp(resolve(stateRoot, "cache-v2"), resolve(working, "cache-v2"), { recursive: true });
      const before = await readFile(resolve(working, "cache-v2/DO-NOT-TOUCH.txt"));
      const cache = new DiskCache({ directory: working, maxBytes: 0, maxAgeSeconds: 0 });
      await cache.cleanup();
      await cache.evict();
      const after = await readFile(resolve(working, "cache-v2/DO-NOT-TOUCH.txt"));
      if (!before.equals(after)) throw new Error("cache-v1 operation changed opaque namespace");
      return {
        outcome: "unsupported_namespace_untouched",
        client_namespace: "cache-v1",
        opaque_namespace: "cache-v2",
      };
    }

    await cp(resolve(stateRoot, "cache-v1"), resolve(working, "cache-v1"), { recursive: true });
    if (id === "cache-v1-partial-writer") {
      const now = new Date("2030-01-01T00:00:00.000Z");
      const temporaryRoot = resolve(working, "cache-v1/tmp");
      for (const entry of await readdir(temporaryRoot)) {
        await utimes(resolve(temporaryRoot, entry), new Date(0), new Date(0));
      }
      const result = await new DiskCache({
        directory: working,
        now: () => now,
        temporaryExpirySeconds: 120,
        isProcessAlive: () => false,
      }).cleanup();
      return {
        outcome: "temporary_ignored",
        published_object: false,
        cleanup_eligible: result.removedTemporaryPaths === 1,
      };
    }

    if (id === "cache-v1-crashed-lease") {
      const inputs = jsonObject(
        await readJson(resolve(stateRoot, fixture.evaluation_inputs)),
        "cache evaluation inputs",
      );
      const processLiveness = jsonObject(inputs.process_liveness, "process liveness");
      const digest = await digestFromFixture(fixture, stateRoot);
      const cache = new DiskCache({
        directory: working,
        now: () => new Date(jsonString(inputs.now, "evaluation time")),
        isProcessAlive: (pid) => processLiveness[String(pid)] === true,
        leaseExpirySeconds: jsonNumber(inputs.lease_expiry_seconds, "lease expiry seconds"),
      });
      const result = await cache.cleanup();
      return {
        outcome: "lease_reclaimable",
        object_retained: (await cache.getObject(digest)) !== null,
        requires_process_liveness_check: result.reclaimedLeases === 1,
      };
    }
    throw new Error(`unknown cache protocol case: ${id}`);
  } finally {
    await rm(working, { recursive: true, force: true });
  }
}

function response(
  status: number,
  headers: Readonly<{ [name: string]: string }> = {},
  body: Uint8Array = new Uint8Array(),
) {
  return { status, headers, body };
}

function normalizedError(error: unknown) {
  if (!(error instanceof RemoteSkillsError)) throw error;
  return error.toDiagnostic();
}

function activationCache() {
  return new MemoryCache({ verifyExtractedContents: verifyCachedExtraction });
}

function sha256(bytes: Uint8Array) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

const PINNED_CODE_REVIEW = Buffer.from(
  "---\nname: code-review\ndescription: Review safely.\n---\n# Review\n\nPinned content....\n",
);
const CURRENT_CODE_REVIEW = Buffer.from(
  "---\nname: code-review\ndescription: Review current changes.\n---\n# Review\n\nCurrent content.\n",
);

function activationHistory(entry: CatalogEntry, selectedUrl: string) {
  const current = Object.freeze({
    version: "1.5.0",
    artifactType: "skill-md",
    url: "https://skills.example.test/.well-known/agent-skills/artifacts/current-code-review.md",
    digest: sha256(CURRENT_CODE_REVIEW),
  });
  const selected = Object.freeze({
    version: "1.4.7",
    artifactType: "skill-md",
    url: selectedUrl,
    digest: sha256(PINNED_CODE_REVIEW),
  });
  return {
    current,
    selected,
    entry: Object.freeze({
      ...entry,
      version: current.version,
      artifactType: current.artifactType,
      url: current.url,
      digest: current.digest,
      releases: Object.freeze([current, selected]),
    }),
  };
}

async function runArchiveCase(fixture: ProtocolFixture, protocolRoot: string) {
  const bytes = await readFile(resolve(protocolRoot, "fixtures/archive", fixture.path));
  const digest = sha256(bytes);
  const cache = activationCache();
  const requests: TransportRequest[] = [];
  const origin = configuredOrigin({
    fixture: { url: "https://skills.example.test", retries: 0 },
  });
  const extension = fixture.artifact_type === "skill-md" ? "md" : fixture.format;
  const descriptor = {
    originAlias: "fixture",
    name: "fixture-skill",
    description: "Exercise archive safety.",
    artifactType: fixture.artifact_type,
    url: `https://skills.example.test/artifact.${extension}`,
    digest,
  };
  try {
    const result = await activateSkill(
      {
        origin,
        originAlias: "fixture",
        entry: descriptor,
        cache,
        sessionNonce: "protocol-archive",
        limits: {
          ...(fixture.limits?.archive_bytes === undefined
            ? {}
            : { archiveBytes: fixture.limits.archive_bytes }),
          ...(fixture.limits?.extracted_bytes === undefined
            ? {}
            : { extractedBytes: fixture.limits.extracted_bytes }),
          ...(fixture.limits?.files === undefined ? {} : { files: fixture.limits.files }),
          ...(fixture.limits?.file_bytes === undefined
            ? {}
            : { fileBytes: fixture.limits.file_bytes }),
        },
      },
      {
        now: Date.now,
        random: () => 0,
        sleep: async () => {},
        resolve: async () => PUBLIC_ANSWER,
        transport: async (request: TransportRequest) => {
          requests.push(request);
          return response(
            200,
            {
              "content-type":
                fixture.artifact_type === "skill-md"
                  ? "text/markdown"
                  : fixture.format === "zip"
                    ? "application/zip"
                    : "application/gzip",
            },
            bytes,
          );
        },
      },
    );
    try {
      return {
        outcome: "activation_success",
        origin_alias: "fixture",
        name: result.skill.name,
        digest: result.skill.digest,
        instructions: result.skill.instructions,
        frontmatter: result.skill.frontmatter,
        requests: requests.length,
        files: await result.skill.list(),
      };
    } finally {
      await result.lease.release();
    }
  } catch (error) {
    return {
      outcome: "activation_error",
      error: normalizedError(error),
      cache_object_published: (await cache.getObject(digest)) !== null,
      requests: requests.length,
    };
  }
}

async function runPublisherActivationCase(fixture: ProtocolFixture, protocolRoot: string) {
  const indexPath = resolve(protocolRoot, "fixtures/publisher", fixture.index);
  const indexBytes = await readFile(indexPath);
  const catalogUrl = new URL("https://publisher.example.test/.well-known/agent-skills/index.json");
  const catalog = parseCatalog(indexBytes, fixture.origin_alias, catalogUrl);
  const entry = catalog.entries.find(({ name }) => name === fixture.skill_name);
  if (!entry) throw new Error(`publisher activation fixture omitted ${fixture.skill_name}`);
  const document = jsonObject(JSON.parse(indexBytes.toString("utf8")), "publisher catalog");
  const rawEntry = jsonArray(document.skills, "publisher catalog skills")
    .map((value) => jsonObject(value, "publisher catalog entry"))
    .find((value) => value.name === fixture.skill_name);
  if (rawEntry === undefined) throw new Error("publisher catalog omitted the activated entry");
  const artifact = await readFile(
    resolve(dirname(indexPath), jsonString(rawEntry.url, "publisher artifact URL")),
  );
  const origin = configuredOrigin({
    [fixture.origin_alias]: { url: "https://publisher.example.test", retries: 0 },
  });
  const result = await activateSkill(
    {
      origin,
      originAlias: fixture.origin_alias,
      entry,
      cache: activationCache(),
      sessionNonce: "publisher-activation",
    },
    {
      now: Date.now,
      random: () => 0,
      sleep: async () => {},
      resolve: async () => PUBLIC_ANSWER,
      transport: async () =>
        response(
          200,
          {
            "content-type":
              entry.artifactType === "skill-md"
                ? "text/markdown"
                : fixture.format === "zip"
                  ? "application/zip"
                  : "application/gzip",
          },
          artifact,
        ),
    },
  );
  try {
    return {
      outcome: "activation_success",
      origin_alias: fixture.origin_alias,
      name: result.skill.name,
      digest: result.skill.digest,
      instructions: result.skill.instructions,
      frontmatter: result.skill.frontmatter,
      files: await result.skill.list(),
      requests: 2,
    };
  } finally {
    await result.lease.release();
  }
}

function configuredOrigin(config: OriginMap): NormalizedOrigin {
  const origin = normalizeOrigins(config).values().next().value;
  if (!origin) throw new Error("protocol adapter origin configuration is empty");
  return origin;
}

function normalizeCatalog(catalog: OriginCatalog) {
  return {
    outcome: "catalog_success",
    origin_alias: catalog.originAlias,
    stale: catalog.stale,
    entries: catalog.entries.map((entry) => ({
      origin_alias: entry.originAlias,
      name: entry.name,
      description: entry.description,
      artifact_type: entry.artifactType,
      url: entry.url,
      digest: entry.digest,
    })),
    requests: 1,
  };
}

function normalizeVersionSelection(
  catalog: OriginCatalog,
  fixture: ProtocolFixture,
  requests: number,
) {
  const skillName = fixture.skill_name ?? "code-review";
  const entry = catalog.entries.find(({ name }) => name === skillName);
  if (!entry) {
    throw new RemoteSkillsError("skill_not_found", {
      origin_alias: catalog.originAlias,
      skill_name: skillName,
    });
  }
  const release = selectCatalogRelease(entry, fixture.requested_range);
  return {
    outcome: "version_selection_success",
    origin_alias: catalog.originAlias,
    skill_name: skillName,
    ...(fixture.requested_range === undefined ? {} : { requested_range: fixture.requested_range }),
    ...(release.version === undefined ? {} : { selected_version: release.version }),
    artifact_type: release.artifactType,
    url: release.url,
    digest: release.digest,
    stale: catalog.stale,
    requests,
  };
}

async function runVersionCatalogCase(fixture: ProtocolFixture, protocolRoot: string) {
  const bytes = await readFile(resolve(protocolRoot, "fixtures/catalog", fixture.input));
  const records: TransportRequest[] = [];
  try {
    const catalog = await createCatalogDiscovery(
      { origins: { acme: { url: "https://skills.example.test", retries: 0 } } },
      {
        now: Date.now,
        random: () => 0,
        sleep: async () => {},
        resolve: async () => PUBLIC_ANSWER,
        transport: async (request: TransportRequest) => {
          records.push(request);
          return response(200, {}, bytes);
        },
      },
    ).origin("acme");
    return normalizeVersionSelection(catalog, fixture, records.length);
  } catch (error) {
    if (error instanceof RemoteSkillsError && error.code === "version_unavailable") {
      return {
        outcome: "version_selection_error",
        requested_range: fixture.requested_range,
        error: normalizedError(error),
        requests: records.length,
      };
    }
    return { outcome: "catalog_error", error: normalizedError(error) };
  }
}

interface NetworkConfiguration {
  artifact_url?: string;
  headers?: Readonly<{ [name: string]: string }>;
  origin?: string;
  requested_range?: string;
  scope?: string;
  validators?: { etag?: string; last_modified?: string };
}

interface NetworkScenario {
  address?: string;
  advertised_versions?: string[];
  answers?: string[];
  artifact_request?: { headers: { accept: string }; url?: string };
  artifact_response?: { status: number };
  cached_catalog_age_seconds?: number;
  cached_versions?: string[];
  catalog_response?: {
    fixture: string;
    headers: Readonly<{ [name: string]: string }>;
    status: number;
  };
  chain?: string[];
  configuration?: NetworkConfiguration;
  delays_ms?: number[];
  failures?: string[];
  forbidden_header_names?: string[];
  jitter_slots?: number[];
  maximum_age_seconds?: number;
  now?: string;
  per_origin?: { retries?: number };
  request?: { headers: { name: string; value: string }[] };
  requested_range?: string;
  response?: { headers?: ResponseHeaders; status: number };
  retry_after?: string;
  selection?: { skill_name: string };
  statuses?: number[];
}

function jsonStringRecord(value: unknown, label: string): Readonly<{ [name: string]: string }> {
  const raw = jsonObject(value, label);
  return Object.fromEntries(
    Object.entries(raw).map(([name, entry]) => [name, jsonString(entry, `${label}.${name}`)]),
  );
}

function parseResponseHeaders(value: unknown, label: string): ResponseHeaders {
  if (!Array.isArray(value)) return jsonStringRecord(value, label);
  return value.map((entry, index) => {
    const raw = jsonObject(entry, `${label}[${index}]`);
    return {
      name: jsonString(raw.name, `${label}[${index}].name`),
      value: jsonString(raw.value, `${label}[${index}].value`),
    };
  });
}

function parseNetworkConfiguration(value: unknown, label: string): NetworkConfiguration {
  const raw = jsonObject(value, label);
  const validators =
    raw.validators === undefined ? undefined : jsonObject(raw.validators, `${label}.validators`);
  return {
    ...(raw.artifact_url === undefined
      ? {}
      : { artifact_url: jsonString(raw.artifact_url, `${label}.artifact_url`) }),
    ...(raw.headers === undefined
      ? {}
      : { headers: jsonStringRecord(raw.headers, `${label}.headers`) }),
    ...(raw.origin === undefined ? {} : { origin: jsonString(raw.origin, `${label}.origin`) }),
    ...(raw.requested_range === undefined
      ? {}
      : { requested_range: jsonString(raw.requested_range, `${label}.requested_range`) }),
    ...(raw.scope === undefined ? {} : { scope: jsonString(raw.scope, `${label}.scope`) }),
    ...(validators === undefined
      ? {}
      : {
          validators: {
            ...(validators.etag === undefined
              ? {}
              : { etag: jsonString(validators.etag, `${label}.validators.etag`) }),
            ...(validators.last_modified === undefined
              ? {}
              : {
                  last_modified: jsonString(
                    validators.last_modified,
                    `${label}.validators.last_modified`,
                  ),
                }),
          },
        }),
  };
}

function parseNetworkScenario(value: unknown, label: string): NetworkScenario {
  const raw = jsonObject(value, label);
  const objectField = (field: string) => jsonObject(raw[field], `${label}.${field}`);
  const artifactRequest =
    raw.artifact_request === undefined ? undefined : objectField("artifact_request");
  const artifactResponse =
    raw.artifact_response === undefined ? undefined : objectField("artifact_response");
  const catalogResponse =
    raw.catalog_response === undefined ? undefined : objectField("catalog_response");
  const perOrigin = raw.per_origin === undefined ? undefined : objectField("per_origin");
  const request = raw.request === undefined ? undefined : objectField("request");
  const response = raw.response === undefined ? undefined : objectField("response");
  const selection = raw.selection === undefined ? undefined : objectField("selection");
  return {
    ...(raw.address === undefined ? {} : { address: jsonString(raw.address, `${label}.address`) }),
    ...(raw.advertised_versions === undefined
      ? {}
      : {
          advertised_versions: jsonStringArray(
            raw.advertised_versions,
            `${label}.advertised_versions`,
          ),
        }),
    ...(raw.answers === undefined
      ? {}
      : { answers: jsonStringArray(raw.answers, `${label}.answers`) }),
    ...(artifactRequest === undefined
      ? {}
      : {
          artifact_request: {
            headers: {
              accept: jsonString(
                jsonObject(artifactRequest.headers, `${label}.artifact_request.headers`).accept,
                `${label}.artifact_request.headers.accept`,
              ),
            },
            ...(artifactRequest.url === undefined
              ? {}
              : { url: jsonString(artifactRequest.url, `${label}.artifact_request.url`) }),
          },
        }),
    ...(artifactResponse === undefined
      ? {}
      : {
          artifact_response: {
            status: jsonNumber(artifactResponse.status, `${label}.artifact_response.status`),
          },
        }),
    ...(raw.cached_catalog_age_seconds === undefined
      ? {}
      : {
          cached_catalog_age_seconds: jsonNumber(
            raw.cached_catalog_age_seconds,
            `${label}.cached_catalog_age_seconds`,
          ),
        }),
    ...(raw.cached_versions === undefined
      ? {}
      : { cached_versions: jsonStringArray(raw.cached_versions, `${label}.cached_versions`) }),
    ...(catalogResponse === undefined
      ? {}
      : {
          catalog_response: {
            fixture: jsonString(catalogResponse.fixture, `${label}.catalog_response.fixture`),
            headers: jsonStringRecord(catalogResponse.headers, `${label}.catalog_response.headers`),
            status: jsonNumber(catalogResponse.status, `${label}.catalog_response.status`),
          },
        }),
    ...(raw.chain === undefined ? {} : { chain: jsonStringArray(raw.chain, `${label}.chain`) }),
    ...(raw.configuration === undefined
      ? {}
      : { configuration: parseNetworkConfiguration(raw.configuration, `${label}.configuration`) }),
    ...(raw.delays_ms === undefined
      ? {}
      : { delays_ms: jsonNumberArray(raw.delays_ms, `${label}.delays_ms`) }),
    ...(raw.failures === undefined
      ? {}
      : { failures: jsonStringArray(raw.failures, `${label}.failures`) }),
    ...(raw.forbidden_header_names === undefined
      ? {}
      : {
          forbidden_header_names: jsonStringArray(
            raw.forbidden_header_names,
            `${label}.forbidden_header_names`,
          ),
        }),
    ...(raw.jitter_slots === undefined
      ? {}
      : { jitter_slots: jsonNumberArray(raw.jitter_slots, `${label}.jitter_slots`) }),
    ...(raw.maximum_age_seconds === undefined
      ? {}
      : {
          maximum_age_seconds: jsonNumber(raw.maximum_age_seconds, `${label}.maximum_age_seconds`),
        }),
    ...(raw.now === undefined ? {} : { now: jsonString(raw.now, `${label}.now`) }),
    ...(perOrigin === undefined
      ? {}
      : {
          per_origin: {
            ...(perOrigin.retries === undefined
              ? {}
              : { retries: jsonNumber(perOrigin.retries, `${label}.per_origin.retries`) }),
          },
        }),
    ...(request === undefined
      ? {}
      : {
          request: {
            headers: jsonArray(request.headers, `${label}.request.headers`).map((entry, index) => {
              const header = jsonObject(entry, `${label}.request.headers[${index}]`);
              return {
                name: jsonString(header.name, `${label}.request.headers[${index}].name`),
                value: jsonString(header.value, `${label}.request.headers[${index}].value`),
              };
            }),
          },
        }),
    ...(raw.requested_range === undefined
      ? {}
      : { requested_range: jsonString(raw.requested_range, `${label}.requested_range`) }),
    ...(response === undefined
      ? {}
      : {
          response: {
            status: jsonNumber(response.status, `${label}.response.status`),
            ...(response.headers === undefined
              ? {}
              : {
                  headers: parseResponseHeaders(response.headers, `${label}.response.headers`),
                }),
          },
        }),
    ...(raw.retry_after === undefined
      ? {}
      : { retry_after: jsonString(raw.retry_after, `${label}.retry_after`) }),
    ...(selection === undefined
      ? {}
      : {
          selection: {
            skill_name: jsonString(selection.skill_name, `${label}.selection.skill_name`),
          },
        }),
    ...(raw.statuses === undefined
      ? {}
      : { statuses: jsonNumberArray(raw.statuses, `${label}.statuses`) }),
  };
}

function isResponseHeaderList(
  headers: ResponseHeaders,
): headers is readonly { name: string; value: string }[] {
  return Array.isArray(headers);
}

function responseHeaderRecord(headers: ResponseHeaders | undefined): Readonly<{
  [name: string]: string;
}> {
  if (headers === undefined) return {};
  if (!isResponseHeaderList(headers)) return headers;
  const normalized: { [name: string]: string } = {};
  for (const { name, value } of headers) {
    const key = Object.keys(normalized).some(
      (present) => present.toLowerCase() === name.toLowerCase(),
    )
      ? name.toUpperCase()
      : name;
    normalized[key] = value;
  }
  return normalized;
}

async function loadScenario(fixture: ProtocolFixture, protocolRoot: string) {
  const [filename, anchor] = fixture.scenario.split("#");
  const scenarioPath = resolve(
    protocolRoot,
    "fixtures/network",
    required(filename, "scenario filename"),
  );
  const document = jsonObject(await readJson(scenarioPath), `network fixture ${filename}`);
  const scenarioAnchor = required(anchor, "scenario anchor");
  const scenario = parseNetworkScenario(
    document[scenarioAnchor],
    `network fixture ${filename}#${scenarioAnchor}`,
  );
  const initial =
    document.initial === undefined
      ? undefined
      : jsonObject(document.initial, `network fixture ${filename}.initial`);
  const initialResponse =
    initial?.response === undefined
      ? undefined
      : jsonObject(initial.response, `network fixture ${filename}.initial.response`);
  const initialResponseHeaders =
    initialResponse?.headers === undefined
      ? undefined
      : parseResponseHeaders(
          initialResponse.headers,
          `network fixture ${filename}.initial.response.headers`,
        );
  return { initialResponseHeaders, scenario };
}

async function runValidatorCase(fixture: ProtocolFixture, protocolRoot: string) {
  const { initialResponseHeaders, scenario } = await loadScenario(fixture, protocolRoot);
  let now = Date.parse("2026-08-25T10:00:00.000Z");
  let phase = "seed";
  const recorded = [];
  let bodyTransfers = 0;
  const dependencies = {
    now: () => now,
    random: () => 0,
    sleep: async () => {},
    resolve: async () => PUBLIC_ANSWER,
    transport: async (request: TransportRequest) => {
      if (phase !== "seed") recorded.push(request);
      if (phase === "seed" || fixture.id === "validator-initial-200") {
        if (phase !== "seed") bodyTransfers += 1;
        return response(
          200,
          responseHeaderRecord(required(initialResponseHeaders, "initial response headers")),
          EMPTY_CATALOG,
        );
      }
      return response(
        scenario.response?.status ?? 304,
        responseHeaderRecord(scenario.response?.headers),
      );
    },
  };
  const discovery = createCatalogDiscovery(
    { origins: { acme: { url: "https://skills.example.test" } } },
    dependencies,
  );

  if (fixture.id === "validator-initial-200") {
    phase = "initial";
    const catalog = await discovery.origin("acme");
    return {
      ...normalizeCatalog(catalog),
      requests: recorded.length,
      body_transfers: bodyTransfers,
    };
  }

  await discovery.origin("acme");
  phase = "verify";
  if (fixture.id === "validator-fresh-no-request") {
    now = Date.parse(required(scenario.now, "scenario now"));
    const catalog = await discovery.origin("acme");
    return {
      ...normalizeCatalog(catalog),
      requests: recorded.length,
      body_transfers: bodyTransfers,
    };
  }
  const catalog = await discovery.origin("acme", { forceRevalidate: true });
  return { ...normalizeCatalog(catalog), requests: recorded.length, body_transfers: bodyTransfers };
}

async function runRedirectCase(fixture: ProtocolFixture, protocolRoot: string) {
  const { scenario } = await loadScenario(fixture, protocolRoot);
  const chain = scenario.chain ?? [];
  const origin = configuredOrigin({
    acme: {
      url: "https://skills.example.test",
      headers: { authorization: "runtime-secret" },
    },
  });
  const requests: TransportRequest[] = [];
  const runtime = {
    now: Date.now,
    random: () => 0,
    sleep: async () => {},
    resolve: async () => PUBLIC_ANSWER,
    transport: async (request: TransportRequest) => {
      requests.push(request);
      if (fixture.id === "redirect-overflow") {
        return response(302, { location: `/redirect/${requests.length}` });
      }
      const next = chain[requests.length];
      return next ? response(302, { location: next }) : response(200);
    },
  };

  try {
    await requestWithPolicy(
      {
        origin,
        url: new URL(chain[0] ?? "https://skills.example.test/redirect/0"),
        purpose: "artifact",
        accept: "text/markdown",
        maxBytes: 1024,
      },
      runtime,
    );
    return {
      outcome: "request_success",
      requests: requests.length,
      origin_header_hops: requests.flatMap((request, index) =>
        request.headers.authorization ? [index] : [],
      ),
    };
  } catch (error) {
    return { outcome: "request_error", error: normalizedError(error), requests: requests.length };
  }
}

async function runAddressCase(fixture: ProtocolFixture, protocolRoot: string) {
  const { scenario } = await loadScenario(fixture, protocolRoot);
  if (fixture.id !== "ip-dns-rebinding") {
    const allowed = isPublicAddress(required(scenario.address, "IP policy address"));
    return allowed
      ? { outcome: "policy_decision", decision: "allow" }
      : {
          outcome: "policy_decision",
          decision: "deny",
          error: new RemoteSkillsError("policy_denied", {
            origin_alias: "acme",
          }).toDiagnostic(),
        };
  }

  const origin = configuredOrigin({ acme: { url: "https://skills.example.test" } });
  const resolutions: string[] = [];
  const answers = required(scenario.answers, "DNS fixture answers");
  let connectionAttempts = 0;
  let index = 0;
  const resolveHost = async () => {
    const address = answers[index++];
    if (typeof address !== "string") throw new Error("DNS fixture answer is missing");
    resolutions.push(address);
    return [{ address, family: address.includes(":") ? (6 as const) : (4 as const) }];
  };
  try {
    await resolveNetworkTarget(origin, origin.catalogUrl, resolveHost);
    connectionAttempts += 1;
    await resolveNetworkTarget(origin, origin.catalogUrl, resolveHost);
    throw new Error("rebinding fixture unexpectedly allowed both resolutions");
  } catch (error) {
    return {
      outcome: "policy_decision",
      decision: "deny",
      error: normalizedError(error),
      resolutions,
      connection_attempts: connectionAttempts,
    };
  }
}

async function runRetryCase(fixture: ProtocolFixture, protocolRoot: string) {
  if (fixture.id === "retry-digest-mismatch") {
    const bytes = await readFile(resolve(protocolRoot, "fixtures/archive/skill-md/valid.md"));
    const digest = `sha256:${"a".repeat(64)}`;
    const cache = activationCache();
    const requests: TransportRequest[] = [];
    const origin = configuredOrigin({ acme: { url: "https://skills.example.test" } });
    try {
      const result = await activateSkill(
        {
          origin,
          originAlias: "acme",
          entry: {
            originAlias: "acme",
            name: "fixture-skill",
            description: "Exercise archive safety.",
            artifactType: "skill-md",
            url: "https://skills.example.test/artifacts/fixture-skill.md",
            digest,
          },
          cache,
          sessionNonce: "digest-mismatch",
        },
        {
          now: Date.now,
          random: () => 0,
          sleep: async () => {},
          resolve: async () => PUBLIC_ANSWER,
          transport: async (request: TransportRequest) => {
            requests.push(request);
            return response(200, { "content-type": "text/markdown" }, bytes);
          },
        },
      );
      await result.lease.release();
      throw new Error("digest mismatch fixture unexpectedly activated");
    } catch (error) {
      return {
        outcome: "activation_error",
        error: normalizedError(error),
        cache_object_published: (await cache.getObject(digest)) !== null,
        requests: requests.length,
        attempts: requests.length,
      };
    }
  }

  const { scenario } = await loadScenario(fixture, protocolRoot);
  const retries = scenario.per_origin?.retries;
  const origin = configuredOrigin({
    acme: {
      url: "https://skills.example.test",
      ...(retries === undefined ? {} : { retries }),
    },
  });
  const requests: TransportRequest[] = [];
  const delays: number[] = [];
  const jitterSlots: number[] = [];
  const statuses = scenario.statuses ?? [];
  let randomIndex = 0;
  const runtime = {
    now: () => Date.parse("2026-08-25T10:00:00.000Z"),
    random: () => {
      const slot = scenario.jitter_slots?.[randomIndex++] ?? 0;
      jitterSlots.push(slot);
      return slot === 0 ? 0 : 0.5;
    },
    sleep: async (milliseconds: number) => {
      delays.push(milliseconds);
    },
    resolve: async () => PUBLIC_ANSWER,
    transport: async (request: TransportRequest) => {
      requests.push(request);
      if (scenario.failures) {
        throw new Error(required(scenario.failures[requests.length - 1], "retry failure message"));
      }
      const status = required(statuses[requests.length - 1], "retry response status");
      return response(
        status,
        requests.length === 1 && scenario.retry_after
          ? { "retry-after": scenario.retry_after }
          : {},
      );
    },
  };
  try {
    await requestWithPolicy(
      {
        origin,
        url: new URL("https://skills.example.test/artifact"),
        purpose: "artifact",
        accept: "application/octet-stream",
        maxBytes: 1024,
      },
      runtime,
    );
    return {
      outcome: "request_success",
      requests: requests.length,
      attempts: requests.length,
      ...(scenario.delays_ms ? { delays_ms: delays } : {}),
      ...(scenario.jitter_slots ? { jitter_slots: jitterSlots } : {}),
    };
  } catch (error) {
    return {
      outcome: "request_error",
      error: normalizedError(error),
      requests: requests.length,
      attempts: requests.length,
    };
  }
}

async function runCredentialCase(fixture: ProtocolFixture, protocolRoot: string) {
  const { scenario } = await loadScenario(fixture, protocolRoot);
  const directCdn = fixture.id === "credentials-explicit-cdn";
  const origin = configuredOrigin({
    acme: {
      url: "https://skills.example.test",
      headers: { authorization: "origin-secret" },
      ...(directCdn
        ? { artifactHeaders: { "cdn.example.test": { "x-cdn-token": "cdn-secret" } } }
        : {}),
    },
  });
  const requests: TransportRequest[] = [];
  const crossHost = fixture.id === "credentials-cross-host-stripped";
  const startUrl = directCdn
    ? new URL("https://cdn.example.test/artifacts/fixture-skill.md")
    : new URL("https://skills.example.test/artifacts/fixture-skill.md");
  await requestWithPolicy(
    {
      origin,
      url: startUrl,
      purpose: "artifact",
      accept: "text/markdown",
      maxBytes: 1024,
    },
    {
      now: Date.now,
      random: () => 0,
      sleep: async () => {},
      resolve: async () => PUBLIC_ANSWER,
      transport: async (request: TransportRequest) => {
        requests.push(request);
        if (crossHost && requests.length === 1) {
          return response(302, {
            location: "https://cdn.example.test/artifacts/fixture-skill.md",
          });
        }
        return response(200);
      },
    },
  );
  const last = requests.at(-1);
  if (last === undefined) throw new Error("credential fixture made no request");
  const diagnostic = sanitizeRequest(new URL(last.url), last.headers, ["x-cdn-token"]);
  return {
    outcome: "request_success",
    requests: requests.length,
    sensitive_header_names: diagnostic.sensitive_header_names,
    ...(scenario.forbidden_header_names
      ? { forbidden_header_names: scenario.forbidden_header_names }
      : {}),
  };
}

function scopeConfiguration(scenario: NetworkScenario) {
  const configuration = required(scenario.configuration, "network configuration");
  return {
    url: configuration.origin ?? "https://skills.example.test",
    ...(configuration.scope === undefined ? {} : { scope: configuration.scope }),
    ...(configuration.headers === undefined
      ? {}
      : {
          headers: Object.fromEntries(
            Object.keys(configuration.headers).map((name) => [name, "runtime-secret"]),
          ),
        }),
    retries: 0,
  };
}

async function runScopedCatalogCase(fixture: ProtocolFixture, protocolRoot: string) {
  const { scenario } = await loadScenario(fixture, protocolRoot);
  const configuration = required(scenario.configuration, "scope configuration");
  const records: TransportRequest[] = [];
  const persistentCache = new MemoryCache();
  let bodyTransfers = 0;
  let phase = scenario.response?.status === 304 ? "seed" : "verify";
  try {
    const originConfig = scopeConfiguration(scenario);
    if (fixture.id === "scope-invalid-multiple-request-headers") {
      const request = required(scenario.request, "scope request");
      const firstHeader = required(request.headers[0], "scope request header");
      originConfig.headers = {
        ...originConfig.headers,
        "remote-skills-scope": firstHeader.value,
      };
    }
    const discovery = createCatalogDiscovery(
      { origins: { acme: originConfig } },
      {
        persistentCache,
        now: () => Date.parse("2026-08-25T10:10:00.000Z"),
        random: () => 0,
        sleep: async () => {},
        resolve: async () => PUBLIC_ANSWER,
        transport: async (request: TransportRequest) => {
          if (phase === "seed") {
            return response(
              200,
              {
                "cache-control": "max-age=0",
                etag: required(configuration.validators?.etag, "scope ETag validator"),
                "remote-skills-scope": required(configuration.scope, "confirmed scope"),
              },
              EMPTY_CATALOG,
            );
          }
          const scenarioResponse = required(scenario.response, "scope response");
          records.push(request);
          if (scenarioResponse.status === 200) bodyTransfers += 1;
          return response(
            scenarioResponse.status,
            responseHeaderRecord(scenarioResponse.headers),
            scenarioResponse.status === 200 ? EMPTY_CATALOG : new Uint8Array(),
          );
        },
      },
    );
    if (phase === "seed") {
      await discovery.origin("acme");
      phase = "verify";
    }
    const catalog = await discovery.origin("acme", {
      forceRevalidate: scenario.response?.status === 304,
    });
    const canonicalUrl = new URL(
      "/.well-known/agent-skills/index.json",
      configuration.origin ?? "https://skills.example.test",
    ).href;
    const persisted = await persistentCache.getCatalog(canonicalUrl, catalog.confirmedScope);
    const persistenceObserved =
      persisted !== null &&
      Buffer.from(persisted.body).equals(EMPTY_CATALOG) &&
      persisted.metadata.confirmedScope === catalog.confirmedScope;
    return {
      outcome: "scope_catalog_success",
      origin_alias: catalog.originAlias,
      ...(catalog.requestedScope === undefined ? {} : { requested_scope: catalog.requestedScope }),
      ...(catalog.confirmedScope === undefined ? {} : { confirmed_scope: catalog.confirmedScope }),
      ...(!persistenceObserved || catalog.catalogIdentifier === undefined
        ? {}
        : { catalog_identifier: catalog.catalogIdentifier }),
      persistent: persistenceObserved,
      stale: catalog.stale,
      requests: records.length,
      body_transfers: bodyTransfers,
    };
  } catch (error) {
    const outcome =
      error instanceof RemoteSkillsError && error.code === "configuration_invalid"
        ? "request_error"
        : "catalog_error";
    return {
      outcome,
      error: normalizedError(error),
      ...(outcome === "request_error" ? { requests: records.length } : {}),
    };
  }
}

async function runScopedArtifactDeniedCase(fixture: ProtocolFixture, protocolRoot: string) {
  const { scenario } = await loadScenario(fixture, protocolRoot);
  const configuration = required(scenario.configuration, "artifact scope configuration");
  const artifactRequest = required(scenario.artifact_request, "artifact request");
  const scenarioResponse = required(scenario.response, "artifact response");
  const origin = configuredOrigin({ acme: scopeConfiguration(scenario) });
  const requests: TransportRequest[] = [];
  try {
    await requestWithPolicy(
      {
        origin,
        url: new URL(required(configuration.artifact_url, "artifact URL")),
        purpose: "artifact",
        accept: artifactRequest.headers.accept,
        maxBytes: 1024,
      },
      {
        now: Date.now,
        random: () => 0,
        sleep: async () => {},
        resolve: async () => PUBLIC_ANSWER,
        transport: async (request: TransportRequest) => {
          requests.push(request);
          return response(scenarioResponse.status);
        },
      },
    );
    throw new Error("artifact denial fixture unexpectedly succeeded");
  } catch (error) {
    const observed = requests[0];
    if (!observed) throw new Error("artifact denial did not make a production request");
    const diagnostic = sanitizeRequest(new URL(observed.url), observed.headers);
    const observedHeaderNames = new Set(
      Object.keys(observed.headers).map((name) => name.toLowerCase()),
    );
    return {
      outcome: "request_error",
      error: normalizedError(error),
      requests: requests.length,
      sensitive_header_names: diagnostic.sensitive_header_names,
      forbidden_header_names: ["remote-skills-scope"].filter(
        (name) => !observedHeaderNames.has(name),
      ),
    };
  }
}

async function runAuthorizedRangeActivationCase(
  fixture: ProtocolFixture,
  protocolRoot: string,
  includeEvidence: boolean,
) {
  const { scenario } = await loadScenario(fixture, protocolRoot);
  const catalogResponse = required(scenario.catalog_response, "activation catalog response");
  const selection = required(scenario.selection, "activation selection");
  const configuration = required(scenario.configuration, "activation configuration");
  const requestedRange = required(configuration.requested_range, "activation requested range");
  const artifactRequest = required(scenario.artifact_request, "activation artifact request");
  const artifactResponse = required(scenario.artifact_response, "activation artifact response");
  const catalogBytes = await readFile(resolve(protocolRoot, "fixtures", catalogResponse.fixture));
  const records: TransportRequest[] = [];
  const cache = new MemoryCache();
  const discovery = createCatalogDiscovery(
    { origins: { acme: scopeConfiguration(scenario) } },
    {
      persistentCache: cache,
      now: Date.now,
      random: () => 0,
      sleep: async () => {},
      resolve: async () => PUBLIC_ANSWER,
      transport: async (request: TransportRequest) => {
        records.push(request);
        return response(catalogResponse.status, catalogResponse.headers, catalogBytes);
      },
    },
  );
  const catalog = await discovery.origin("acme");
  const entry = catalog.entries.find(({ name }) => name === selection.skill_name);
  if (!entry) throw new Error("authorized activation catalog omitted selected skill");
  const catalogRelease = selectCatalogRelease(entry, requestedRange);
  const history = activationHistory(
    entry,
    required(artifactRequest.url, "activation artifact request URL"),
  );
  if (catalogRelease.version !== history.selected.version)
    throw new Error("authorized activation fixture selected an unexpected catalog release");
  const origin = configuredOrigin({ acme: scopeConfiguration(scenario) });
  const coordinator = createActivationCoordinator(
    {
      origin,
      catalog: Object.freeze({ ...catalog, entries: Object.freeze([history.entry]) }),
      cache: activationCache(),
      sessionNonce: "authorized-range-activation",
    },
    {
      now: Date.now,
      random: () => 0,
      sleep: async () => {},
      resolve: async () => PUBLIC_ANSWER,
      transport: async (request: TransportRequest) => {
        records.push(request);
        if (request.url !== history.selected.url)
          throw new Error("authorized activation requested the current descriptor");
        return response(
          artifactResponse.status,
          { "content-type": "text/markdown; charset=utf-8" },
          PINNED_CODE_REVIEW,
        );
      },
    },
  );
  try {
    const activated = await coordinator.activate(entry.name, requestedRange);
    if (
      activated.version !== history.selected.version ||
      activated.digest !== history.selected.digest ||
      activated.descriptor.url !== history.selected.url
    )
      throw new Error("authorized activation did not pin its selected historical descriptor");
    const artifactRequest = records.at(-1);
    if (artifactRequest === undefined) throw new Error("authorized activation made no request");
    const diagnostic = sanitizeRequest(new URL(artifactRequest.url), artifactRequest.headers);
    const artifactHeaderNames = new Set(
      Object.keys(artifactRequest.headers).map((name) => name.toLowerCase()),
    );
    const descriptorEvidence = (descriptor: CatalogRelease, bytes: Uint8Array) => ({
      version: descriptor.version,
      artifact_type: descriptor.artifactType,
      url: descriptor.url,
      digest: descriptor.digest,
      bytes: bytes.byteLength,
      confirmed_scope: activated.confirmedScope,
    });
    return {
      outcome: "authorized_version_activation",
      origin_alias: catalog.originAlias,
      requested_scope: catalog.requestedScope,
      confirmed_scope: activated.confirmedScope,
      catalog_identifier: catalog.catalogIdentifier,
      persistent: catalog.persistent,
      skill_name: entry.name,
      requested_range: requestedRange,
      selected_version: activated.version,
      artifact_type: activated.descriptor.artifactType,
      url: activated.descriptor.url,
      digest: activated.digest,
      pinned_digest: activated.digest,
      stale: catalog.stale,
      requests: records.length,
      catalog_requests: 1,
      artifact_requests: 1,
      artifact_sensitive_header_names: diagnostic.sensitive_header_names,
      artifact_forbidden_header_names: ["remote-skills-scope"].filter(
        (name) => !artifactHeaderNames.has(name),
      ),
      ...(includeEvidence
        ? {
            activation_evidence: {
              activated: true,
              current: descriptorEvidence(history.current, CURRENT_CODE_REVIEW),
              selected: descriptorEvidence(history.selected, PINNED_CODE_REVIEW),
              pin: descriptorEvidence(activated.descriptor, PINNED_CODE_REVIEW),
              requested_url: artifactRequest.url,
            },
          }
        : {}),
    };
  } finally {
    await coordinator.release();
  }
}

async function runExistingPinnedResourceCase(protocolRoot: string, includeEvidence: boolean) {
  const origin = configuredOrigin({ acme: { url: "https://skills.example.test", retries: 0 } });
  const history = activationHistory(
    {
      originAlias: "acme",
      name: "code-review",
      description: "Review safely.",
      artifactType: "skill-md",
      url: "https://skills.example.test/current-code-review.md",
      digest: sha256(CURRENT_CODE_REVIEW),
    },
    "https://skills.example.test/pinned-code-review.md",
  );
  let artifactRequests = 0;
  const coordinator = createActivationCoordinator(
    {
      origin,
      catalog: Object.freeze({
        originAlias: "acme",
        stale: false,
        entries: Object.freeze([history.entry]),
      }),
      cache: activationCache(),
      sessionNonce: "existing-pinned-resource",
    },
    {
      now: Date.now,
      random: () => 0,
      sleep: async () => {},
      resolve: async () => PUBLIC_ANSWER,
      transport: async (request: TransportRequest) => {
        artifactRequests += 1;
        if (request.url !== history.selected.url)
          throw new Error("existing session requested the wrong historical descriptor");
        return response(
          200,
          { "content-type": "text/markdown; charset=utf-8" },
          PINNED_CODE_REVIEW,
        );
      },
    },
  );
  try {
    const activated = await coordinator.activate("code-review", "1.4.x");
    if (activated.version !== "1.4.7" || activated.digest !== history.selected.digest)
      throw new Error("existing session did not pin the historical release");
    const requestsBeforeRemoval = artifactRequests;
    const registry = await readJson(
      resolve(protocolRoot, "fixtures/network/scope-version-network-cases.json"),
    );
    const registryDocument = jsonObject(registry, "scope-version fixture registry");
    const futureFixture = jsonArray(registryDocument.cases, "scope-version fixture cases")
      .map((value, index) => jsonObject(value, `scope-version fixture cases[${index}]`))
      .find((value) => value.id === "version-removal-future-online");
    if (futureFixture === undefined) {
      throw new Error("version removal fixture registry is incomplete");
    }
    const removal = await runRemovalCase(
      normalizeProtocolFixture({
        id: jsonString(futureFixture.id, "version removal fixture id"),
        scenario: jsonString(futureFixture.scenario, "version removal fixture scenario"),
      }),
      protocolRoot,
    );
    if (
      removal.outcome !== "version_selection_error" ||
      removal.error.code !== "version_unavailable"
    )
      throw new Error("authoritative catalog did not remove the pinned historical release");
    const resource = (await activated.list()).find(({ path }) => path === "SKILL.md");
    if (!resource) throw new Error("pinned resource omitted SKILL.md");
    await activated.read("SKILL.md");
    const requestsAfterRemoval = artifactRequests - requestsBeforeRemoval;
    return {
      outcome: "resource_success",
      path: resource.path,
      size: resource.size,
      media_type: resource.media_type,
      encoding: "utf-8",
      requests: requestsAfterRemoval,
      ...(includeEvidence
        ? {
            activation_evidence: {
              activated: true,
              pinned_version: activated.version,
              authoritative_removal_observed: true,
              read_from_same_activation: true,
              requests_after_removal: requestsAfterRemoval,
            },
          }
        : {}),
    };
  } finally {
    await coordinator.release();
  }
}

async function versionCatalogBytes(protocolRoot: string, versions: readonly string[]) {
  const sourceDocument = jsonObject(
    JSON.parse(
      await readFile(
        resolve(protocolRoot, "fixtures/catalog/valid-versioned-history.json"),
        "utf8",
      ),
    ),
    "version catalog",
  );
  const skills = jsonArray(sourceDocument.skills, "version catalog skills");
  const entry = jsonObject(required(skills[0], "version catalog skill"), "version catalog skill");
  const extension = jsonObject(entry["x-remote-skills"], "version catalog extension");
  const releases = jsonArray(extension.releases, "version catalog releases")
    .map((value, index) => jsonObject(value, `version catalog releases[${index}]`))
    .filter((release) =>
      versions.includes(jsonString(release.version, "version catalog release version")),
    );
  extension.releases = releases;
  const current = required(releases[0], "version catalog current release");
  extension.version = jsonString(current.version, "version catalog current version");
  entry.type = jsonString(current.type, "version catalog current artifact type");
  entry.url = jsonString(current.url, "version catalog current URL");
  entry.digest = jsonString(current.digest, "version catalog current digest");
  entry["x-remote-skills"] = extension;
  skills[0] = entry;
  sourceDocument.skills = skills;
  return Buffer.from(`${JSON.stringify(sourceDocument)}\n`);
}

async function runRemovalCase(fixture: ProtocolFixture, protocolRoot: string) {
  const { scenario } = await loadScenario(fixture, protocolRoot);
  const cachedBytes = await versionCatalogBytes(
    protocolRoot,
    required(scenario.cached_versions, "cached versions"),
  );
  const onlineBytes = await versionCatalogBytes(
    protocolRoot,
    required(scenario.advertised_versions, "advertised versions"),
  );
  const requestedRange = required(scenario.requested_range, "version removal requested range");
  const records: TransportRequest[] = [];
  let responseCount = 0;
  const discovery = createCatalogDiscovery(
    {
      origins: { acme: { url: "https://skills.example.test", retries: 0 } },
    },
    {
      persistentCache: new MemoryCache(),
      now: Date.now,
      random: () => 0,
      sleep: async () => {},
      resolve: async () => PUBLIC_ANSWER,
      transport: async (request: TransportRequest) => {
        records.push(request);
        responseCount += 1;
        return response(
          200,
          { "cache-control": responseCount === 1 ? "max-age=0" : "max-age=300" },
          responseCount === 1 ? cachedBytes : onlineBytes,
        );
      },
    },
  );
  const cachedCatalog = await discovery.origin("acme");
  const cachedEntry = cachedCatalog.entries[0];
  if (!cachedEntry) throw new Error("version removal cached catalog omitted its skill");
  selectCatalogRelease(cachedEntry, requestedRange);
  records.length = 0;
  const onlineCatalog = await discovery.origin("acme", { forceRevalidate: true });
  const original = onlineCatalog.entries[0];
  if (!original) throw new Error("version removal catalog omitted its skill");
  if (fixture.id === "version-removal-future-online") {
    try {
      selectCatalogRelease(original, requestedRange);
      throw new Error("removed version unexpectedly selected");
    } catch (error) {
      return {
        outcome: "version_selection_error",
        requested_range: requestedRange,
        error: normalizedError(error),
        requests: records.length,
      };
    }
  }
  throw new Error(`unexpected task-5.6 removal case: ${fixture.id}`);
}

async function runExplicitStaleRemovalCase(fixture: ProtocolFixture, protocolRoot: string) {
  const { scenario } = await loadScenario(fixture, protocolRoot);
  const cachedCatalogAgeSeconds = required(
    scenario.cached_catalog_age_seconds,
    "cached catalog age",
  );
  const maximumAgeSeconds = required(scenario.maximum_age_seconds, "maximum stale age");
  const requestedRange = required(scenario.requested_range, "stale removal requested range");
  const now = Date.parse("2026-08-28T12:00:00.000Z");
  const cache = new MemoryCache({ now: () => new Date(now) });
  const cachedBytes = await versionCatalogBytes(
    protocolRoot,
    required(scenario.advertised_versions, "advertised versions"),
  );
  // Establish the relative catalog's resolution evidence through an accepted response.
  await createCatalogDiscovery(
    { origins: { acme: { url: "https://skills.example.test" } } },
    {
      persistentCache: cache,
      now: () => now - cachedCatalogAgeSeconds * 1_000,
      resolve: async () => PUBLIC_ANSWER,
      transport: async () => ({
        status: 200,
        headers: { "cache-control": "max-age=0" },
        body: cachedBytes,
      }),
    },
  ).origin("acme");
  let requests = 0;
  const client = createRemoteSkills(
    {
      origins: {
        acme: {
          url: "https://skills.example.test",
          retries: 0,
          stale: { maxAgeMs: maximumAgeSeconds * 1_000 },
        },
      },
      cache,
    },
    {
      now: () => now,
      random: () => 0,
      sleep: async () => {},
      resolve: async () => {
        throw new Error("fixture origin is offline");
      },
      transport: async () => {
        requests += 1;
        throw new Error("offline fixture reached transport");
      },
    },
  );
  const session = await client.session("acme");
  try {
    const entry = (await session.catalog()).find(({ name }) => name === "code-review");
    if (!entry) throw new Error("stale removal catalog omitted code-review");
    const release = selectCatalogRelease(entry, requestedRange);
    if (!session.stale || session.staleAgeMs !== cachedCatalogAgeSeconds * 1_000) {
      throw new Error("stale removal session did not surface its bounded age");
    }
    return {
      outcome: "version_selection_success",
      origin_alias: session.metadata.originAlias,
      skill_name: entry.name,
      requested_range: requestedRange,
      selected_version: release.version,
      artifact_type: release.artifactType,
      url: release.url,
      digest: release.digest,
      stale: session.stale,
      requests,
    };
  } finally {
    await session.close();
  }
}

function lifecycleCatalog(artifact: Uint8Array) {
  return Buffer.from(
    `${JSON.stringify({
      $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
      skills: [
        {
          name: "fixture-skill",
          description: "Exercise archive safety.",
          type: "skill-md",
          url: "artifacts/fixture-skill.md",
          digest: sha256(artifact),
        },
      ],
    })}\n`,
  );
}

async function lifecycleResourceResult(skill: ActivatedSkill, requests: number) {
  const resource = (await skill.list()).find(({ path }) => path === "SKILL.md");
  if (!resource) throw new Error("lifecycle activation omitted SKILL.md");
  await skill.read("SKILL.md");
  return {
    outcome: "resource_success",
    path: resource.path,
    size: resource.size,
    media_type: resource.media_type,
    encoding: "utf-8",
    requests,
  };
}

async function runLifecycleCase(fixture: ProtocolFixture, protocolRoot: string) {
  const { scenario } = await loadScenario(fixture, protocolRoot);
  const now = Date.parse("2026-08-28T12:00:00.000Z");
  const artifact = await readFile(resolve(protocolRoot, "fixtures/archive/skill-md/valid.md"));
  const cache = new MemoryCache({
    now: () => new Date(now),
    verifyExtractedContents: verifyCachedExtraction,
  });
  const catalogUrl = FIXTURE_INDEX_URL.href;

  if (fixture.id === "offline-stale-allowed" || fixture.id === "offline-stale-expired") {
    const cachedCatalogAgeSeconds = required(
      scenario.cached_catalog_age_seconds,
      "cached catalog age",
    );
    const validatedAt = new Date(now - cachedCatalogAgeSeconds * 1_000).toISOString();
    await cache.putCatalog(catalogUrl, EMPTY_CATALOG, {
      retrievedAt: validatedAt,
      validatedAt,
      cacheControl: "max-age=0",
    });
  }

  let online = true;
  let removed = false;
  const records: TransportRequest[] = [];
  const dependencies = {
    now: () => now,
    random: () => 0,
    sleep: async () => {},
    resolve: async () => {
      if (!online) throw new Error("fixture origin is offline");
      return PUBLIC_ANSWER;
    },
    transport: async (request: TransportRequest) => {
      records.push(request);
      const url = new URL(request.url);
      if (url.href === catalogUrl) {
        return response(
          200,
          { "cache-control": removed ? "max-age=300" : "max-age=0" },
          removed ? EMPTY_CATALOG : lifecycleCatalog(artifact),
        );
      }
      return response(200, { "content-type": "text/markdown; charset=utf-8" }, artifact);
    },
  };
  const client = (stale: number | undefined) =>
    createRemoteSkills(
      {
        origins: {
          acme: {
            url: "https://skills.example.test",
            retries: 0,
            ...(stale === undefined ? {} : { stale: { maxAgeMs: stale } }),
          },
        },
        cache,
      },
      dependencies,
    );

  if (fixture.id === "offline-stale-allowed" || fixture.id === "offline-stale-expired") {
    online = false;
    try {
      const session = await client(
        required(scenario.maximum_age_seconds, "maximum stale age") * 1_000,
      ).session("acme");
      try {
        return {
          outcome: "catalog_success",
          origin_alias: session.metadata.originAlias,
          stale: session.stale,
          entries: (await session.catalog()).map(({ name }) => name),
          requests: records.length,
        };
      } finally {
        await session.close();
      }
    } catch (error) {
      return { outcome: "catalog_error", error: normalizedError(error) };
    }
  }

  const initialClient = client(undefined);
  const initialSession = await initialClient.session("acme");
  if (fixture.id === "offline-new-default") {
    await initialSession.close();
    records.length = 0;
    online = false;
    try {
      await client(undefined).session("acme");
      throw new Error("default offline session unexpectedly succeeded");
    } catch (error) {
      return { outcome: "catalog_error", error: normalizedError(error) };
    }
  }

  if (fixture.id === "offline-active-session" || fixture.id === "removal-existing-session") {
    const activated = await initialSession.activate("fixture-skill");
    if (fixture.id === "offline-active-session") {
      online = false;
    } else {
      removed = true;
      await initialClient.refresh("acme");
    }
    records.length = 0;
    try {
      return await lifecycleResourceResult(activated, records.length);
    } finally {
      await initialSession.close();
    }
  }

  if (fixture.id === "removal-future-session") {
    await initialSession.close();
    records.length = 0;
    removed = true;
    await initialClient.refresh("acme");
    const future = await initialClient.session("acme");
    try {
      await future.activate("fixture-skill");
      throw new Error("removed skill unexpectedly activated");
    } catch (error) {
      return {
        outcome: "activation_error",
        error: normalizedError(error),
        cache_object_published: (await cache.getObject(sha256(artifact))) !== null,
        requests: records.length,
      };
    } finally {
      await future.close();
    }
  }
  throw new Error(`unexpected lifecycle fixture: ${fixture.id}`);
}

async function runSupplementalNetworkCase(
  fixture: ProtocolFixture,
  protocolRoot: string,
  includeEvidence: boolean = false,
) {
  if (fixture.id === "authorized-range-activation") {
    return runAuthorizedRangeActivationCase(fixture, protocolRoot, includeEvidence);
  }
  if (fixture.id === "version-removal-existing-session") {
    return runExistingPinnedResourceCase(protocolRoot, includeEvidence);
  }
  if (fixture.id === "version-removal-explicit-stale") {
    return runExplicitStaleRemovalCase(fixture, protocolRoot);
  }
  if (fixture.id === "scope-artifact-denied") {
    return runScopedArtifactDeniedCase(fixture, protocolRoot);
  }
  if (fixture.category === "removal") return runRemovalCase(fixture, protocolRoot);
  return runScopedCatalogCase(fixture, protocolRoot);
}

async function runNetworkCase(
  fixture: ProtocolFixture,
  protocolRoot: string,
  includeEvidence: boolean = false,
) {
  if (fixture.category === "offline") return runLifecycleCase(fixture, protocolRoot);
  if (fixture.category === "removal" && !fixture.id.startsWith("version-removal-")) {
    return runLifecycleCase(fixture, protocolRoot);
  }
  if (fixture.category === "scope_authorization" || fixture.category === "removal") {
    return runSupplementalNetworkCase(fixture, protocolRoot, includeEvidence);
  }
  switch (fixture.category) {
    case "http_validator":
      return runValidatorCase(fixture, protocolRoot);
    case "redirect":
      return runRedirectCase(fixture, protocolRoot);
    case "dns_ip_policy":
      return runAddressCase(fixture, protocolRoot);
    case "retry":
      return runRetryCase(fixture, protocolRoot);
    case "credential_forwarding":
      return runCredentialCase(fixture, protocolRoot);
    default:
      return undefined;
  }
}

async function runRedactionCase(fixture: ProtocolFixture) {
  const requestUrl = new URL(fixture.request.url);
  const alias = fixture.boundary === "cdn" ? "cdn" : "acme";
  const origin = configuredOrigin({
    [alias]: {
      url: `${requestUrl.protocol}//${requestUrl.host}`,
      headers: fixture.request.headers,
      retries: 0,
    },
  });
  try {
    await requestWithPolicy(
      {
        origin,
        url: requestUrl,
        purpose: fixture.boundary === "cdn" ? "artifact" : "catalog",
        accept: "application/json",
        maxBytes: 1024,
      },
      {
        now: Date.now,
        random: () => 0,
        sleep: async () => {},
        resolve: async () => PUBLIC_ANSWER,
        transport: async () => {
          const error = new Error("runtime timeout");
          error.name = "AbortError";
          throw error;
        },
      },
    );
    throw new Error("redaction fixture unexpectedly succeeded");
  } catch (error) {
    return normalizedError(error);
  }
}

async function runTranscriptCase(fixture: ProtocolFixture, protocolRoot: string) {
  const validBody = await readFile(
    resolve(protocolRoot, "fixtures", fixture.response.fixture ?? "catalog/valid-v0.2.json"),
  );
  const records: TransportRequest[] = [];
  let phase = fixture.configuration.validators === undefined ? "verify" : "seed";
  const originConfig = {
    url: fixture.configuration.origin,
    headers: fixture.configuration.headers,
    ...(fixture.configuration.scope === undefined ? {} : { scope: fixture.configuration.scope }),
  };
  const discovery = createCatalogDiscovery(
    { origins: { acme: originConfig } },
    {
      now: () => Date.parse("2026-08-25T10:10:00.000Z"),
      random: () => 0,
      sleep: async () => {},
      resolve: async () => PUBLIC_ANSWER,
      transport: async (request: TransportRequest) => {
        if (phase === "verify") records.push(request);
        if (phase === "seed") {
          const validators = required(fixture.configuration.validators, "configuration.validators");
          return response(
            200,
            {
              ...(validators.etag === undefined ? {} : { etag: validators.etag }),
              ...(validators.last_modified === undefined
                ? {}
                : { "last-modified": validators.last_modified }),
              "cache-control": "max-age=0",
              ...(fixture.configuration.scope === undefined
                ? {}
                : { "remote-skills-scope": fixture.configuration.scope }),
            },
            validBody,
          );
        }
        return response(
          fixture.response.status,
          responseHeaderRecord(fixture.response.headers ?? []),
          validBody,
        );
      },
    },
  );
  if (phase === "seed") {
    await discovery.origin("acme");
    phase = "verify";
    await discovery.origin("acme", { forceRevalidate: true });
  } else {
    await discovery.origin("acme");
  }
  return records.map((record) => sanitizeRequest(new URL(record.url), record.headers));
}

export async function runProtocolCase({
  suite,
  fixture,
  protocolRoot,
  evidence = false,
}: {
  suite: string;
  fixture: unknown;
  protocolRoot: string;
  evidence?: boolean;
}): Promise<unknown> {
  const normalizedFixture = normalizeProtocolFixture(parseProtocolFixtureInput(fixture));
  if (suite === "archive") return runArchiveCase(normalizedFixture, protocolRoot);
  if (suite === "publisher_activation") {
    return runPublisherActivationCase(normalizedFixture, protocolRoot);
  }
  if (suite === "catalog") {
    if (normalizedFixture.id.startsWith("version-")) {
      return runVersionCatalogCase(normalizedFixture, protocolRoot);
    }
    const bytes = await readFile(
      resolve(protocolRoot, "fixtures/catalog", normalizedFixture.input),
    );
    try {
      const catalog = parseCatalog(bytes, "acme", FIXTURE_INDEX_URL);
      return normalizeCatalog(catalog);
    } catch (error) {
      return { outcome: "catalog_error", error: normalizedError(error) };
    }
  }
  if (suite === "network") return runNetworkCase(normalizedFixture, protocolRoot, evidence);
  if (suite === "redaction") return runRedactionCase(normalizedFixture);
  if (suite === "request_transcripts") {
    return runTranscriptCase(normalizedFixture, protocolRoot);
  }
  if (suite === "cache") {
    return runCacheCase({
      suite,
      fixture: normalizedFixture,
      protocolRoot,
      id: normalizedFixture.id,
      contractVersion: 1,
    });
  }
  return undefined;
}

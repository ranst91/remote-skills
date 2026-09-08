import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  jsonArray,
  jsonObject,
  jsonString,
  jsonValue,
  protocolRoot,
  readJson,
  spawnTextSync,
} from "./helpers/contract-helpers.ts";

const repositoryRoot = resolve(protocolRoot, "../..");
const noOpTypescript = resolve(protocolRoot, "fixtures/adapters/typescript-noop.mjs");
const noOpPython = resolve(protocolRoot, "fixtures/adapters/python_noop.py");
const invalidDirectSkillIds = [
  "skill-md-malformed-yaml",
  "skill-md-missing-frontmatter",
  "skill-md-missing-name",
  "skill-md-missing-description",
  "skill-md-invalid-name",
  "skill-md-invalid-metadata",
];
interface AdapterSuite {
  fixtures: string;
  name: string;
}

function decodeAdapterSuites(value: unknown, label: string): AdapterSuite[] {
  return jsonArray(value, label).map((item, index) => {
    const suiteLabel = `${label}[${index}]`;
    const suite = jsonObject(item, suiteLabel);
    return {
      fixtures: jsonString(jsonValue(suite, "fixtures", suiteLabel), `${suiteLabel}.fixtures`),
      name: jsonString(jsonValue(suite, "name", suiteLabel), `${suiteLabel}.name`),
    };
  });
}

function decodeAdapterContract(value: unknown): {
  suites: AdapterSuite[];
  supplemental_suites: AdapterSuite[];
} {
  const contract = jsonObject(value, "adapter contract");
  return {
    suites: decodeAdapterSuites(
      jsonValue(contract, "suites", "adapter contract"),
      "adapter contract.suites",
    ),
    supplemental_suites: decodeAdapterSuites(
      jsonValue(contract, "supplemental_suites", "adapter contract"),
      "adapter contract.supplemental_suites",
    ),
  };
}

function decodeCaseCount(value: unknown, label: string): number {
  const document = jsonObject(value, label);
  return jsonArray(jsonValue(document, "cases", label), `${label}.cases`).length;
}

const adapterContract = decodeAdapterContract(readJson("contracts/v0/sdk-adapters.json"));
const registeredCaseCount = [
  ...adapterContract.suites,
  ...adapterContract.supplemental_suites,
].reduce((total, suite) => total + decodeCaseCount(readJson(suite.fixtures), suite.fixtures), 0);
const reviewedCaseCount = 168;

interface AdapterCaseOptions {
  id?: string;
  implementation?: string;
}

interface MigrationTarget {
  baseline: string;
  owner: string;
  successor: string;
}

type RunAdapterCase = (options?: AdapterCaseOptions) => ReturnType<typeof spawnTextSync>;

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

function parseProtocolTargets(value: unknown): MigrationTarget[] {
  assert.ok(isObject(value) && "stableMigrationPairs" in value);
  const pairs: unknown = Reflect.get(value, "stableMigrationPairs");
  assert.ok(Array.isArray(pairs));
  return pairs.flatMap((pair: unknown) => {
    assert.ok(isObject(pair));
    const baseline: unknown = Reflect.get(pair, "baseline");
    const owner: unknown = Reflect.get(pair, "owner");
    const successor: unknown = Reflect.get(pair, "successor");
    assert.ok(typeof baseline === "string");
    assert.ok(typeof owner === "string");
    assert.ok(typeof successor === "string");
    return owner === "protocol" ? [{ baseline, owner, successor }] : [];
  });
}

test("the protocol migration inventory has converged to native TypeScript sources", () => {
  const inventory: unknown = JSON.parse(
    readFileSync(
      resolve(repositoryRoot, "tests/repository/typescript-migration-inventory.json"),
      "utf8",
    ),
  );
  const protocolTargets = parseProtocolTargets(inventory);

  assert.equal(protocolTargets.length, 20);
  for (const { baseline, successor } of protocolTargets) {
    assert.equal(existsSync(resolve(repositoryRoot, baseline)), false, baseline);
    assert.equal(existsSync(resolve(repositoryRoot, successor)), true, successor);
  }
});

test("the protocol test command discovers only native TypeScript tests", () => {
  const parsedManifest: unknown = JSON.parse(
    readFileSync(resolve(repositoryRoot, "package.json"), "utf8"),
  );
  const packageManifest = jsonObject(parsedManifest, "package manifest");
  const scripts = jsonObject(
    jsonValue(packageManifest, "scripts", "package manifest"),
    "package scripts",
  );
  assert.equal(
    jsonString(
      jsonValue(scripts, "test:protocol", "package scripts"),
      "package scripts.test:protocol",
    ),
    "node --test tests/protocol/*.test.ts",
  );
});

test("the stable TypeScript adapter is an exact import-only launch shim", () => {
  const source = readFileSync(
    resolve(protocolRoot, "adapters/typescript-protocol-adapter.mjs"),
    "utf8",
  );
  assert.equal(source, 'import "./typescript-protocol-adapter.ts";\n');
});

test("the immutable TypeScript noop fixture retains its reviewed bytes", () => {
  const digest = createHash("sha256").update(readFileSync(noOpTypescript)).digest("hex");
  assert.equal(digest, "b11138e8ec88e8eb5bdb95da916b46f9ef505b5e06858649fe880e3c1610159f");
});

test("protocol subprocess text uses platform-neutral newlines", () => {
  const result = spawnTextSync(
    process.execPath,
    ["-e", "process.stdout.write('out\\r\\n');process.stderr.write('err\\r\\n')"],
    { cwd: protocolRoot },
  );

  assert.equal(result.status, 0);
  assert.equal(result.stdout, "out\n");
  assert.equal(result.stderr, "err\n");
});

function runTypescriptCase({ id, implementation }: AdapterCaseOptions = {}) {
  const args = [resolve(protocolRoot, "adapters/typescript-protocol-adapter.mjs")];
  if (implementation) args.push("--implementation", implementation);
  if (id) args.push("--case", id);
  return spawnTextSync(process.execPath, args, { cwd: protocolRoot });
}

function runPythonCase({ id, implementation }: AdapterCaseOptions = {}) {
  const projectRoot = resolve(protocolRoot, "../../packages/sdk-python");
  const args = [resolve(protocolRoot, "adapters/python_protocol_adapter.py")];
  if (implementation) args.push("--implementation", implementation);
  if (id) args.push("--case", id);
  return spawnTextSync(process.env.REMOTE_SKILLS_PYTHON ?? "python3", args, {
    cwd: protocolRoot,
    env: { ...process.env, PYTHONPATH: resolve(projectRoot, "src") },
  });
}

function assertCaseGreen(runCase: RunAdapterCase, id: string): void {
  const result = runCase({ id });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /verified 1 shared cases/);
}

function assertAllRegisteredCasesGreen(runCase: RunAdapterCase, language: string): void {
  const result = runCase();
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(
    result.stdout,
    `${language} protocol adapter verified ${reviewedCaseCount} shared cases\n`,
  );
}

test("TypeScript adapter rejects a present no-op SDK implementation", () => {
  const result = runTypescriptCase({ implementation: noOpTypescript });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /archive\/skill-md-valid returned no result/);
});

test("Python adapter rejects a present no-op SDK implementation", () => {
  const result = runPythonCase({ implementation: noOpPython });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /archive\/skill-md-valid returned no result/);
});

test("TypeScript adapter independently enforces every direct skill-md validation case", () => {
  for (const id of invalidDirectSkillIds) {
    const result = runTypescriptCase({ id, implementation: noOpTypescript });
    assert.notEqual(result.status, 0, id);
    assert.match(result.stderr, new RegExp(`archive/${id} returned no result`));
  }
});

test("Python adapter independently enforces every direct skill-md validation case", () => {
  for (const id of invalidDirectSkillIds) {
    const result = runPythonCase({ id, implementation: noOpPython });
    assert.notEqual(result.status, 0, id);
    assert.match(result.stderr, new RegExp(`archive/${id} returned no result`));
  }
});

test("adapter registry retains the exact reviewed shared inventory", () => {
  assert.equal(registeredCaseCount, reviewedCaseCount);
});

test("TypeScript SDK adapter implements every registered shared case", () => {
  assertAllRegisteredCasesGreen(runTypescriptCase, "TypeScript");
});

test("Python SDK adapter implements every registered shared case", () => {
  assertAllRegisteredCasesGreen(runPythonCase, "Python");
});

test("TypeScript SDK adapter implements scoped catalogs", () => {
  const result = runTypescriptCase({ id: "scope-confirmed-200" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("Python SDK adapter implements scoped catalogs", () => {
  assertCaseGreen(runPythonCase, "scope-confirmed-200");
});

test("TypeScript SDK adapter implements SemVer selection", () => {
  const result = runTypescriptCase({ id: "version-select-minor-x" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("Python SDK adapter implements SemVer selection", () => {
  assertCaseGreen(runPythonCase, "version-select-minor-x");
});

test("TypeScript SDK adapter retains exact large-numeric SemVer expectations", () => {
  const result = runTypescriptCase({ id: "version-select-large-core-numeric" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("Python SDK adapter implements exact large-numeric SemVer expectations", () => {
  assertCaseGreen(runPythonCase, "version-select-large-core-numeric");
});

test("TypeScript SDK adapter retains exact large-numeric prerelease expectations", () => {
  const result = runTypescriptCase({ id: "version-select-large-prerelease-numeric" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("Python SDK adapter implements exact large-numeric prerelease expectations", () => {
  assertCaseGreen(runPythonCase, "version-select-large-prerelease-numeric");
});

test("TypeScript SDK adapter activates the authorized range", () => {
  assertCaseGreen(runTypescriptCase, "authorized-range-activation");
});

test("TypeScript SDK adapter preserves existing-session version pins", () => {
  assertCaseGreen(runTypescriptCase, "version-removal-existing-session");
});

test("TypeScript SDK adapter implements explicit bounded stale sessions", () => {
  assertCaseGreen(runTypescriptCase, "version-removal-explicit-stale");
});

test("Python SDK adapter implements authorized range activation pins", () => {
  assertCaseGreen(runPythonCase, "authorized-range-activation");
});

test("Python SDK adapter preserves existing-session version pins", () => {
  assertCaseGreen(runPythonCase, "version-removal-existing-session");
});

test("Python SDK adapter implements explicit bounded stale sessions", () => {
  assertCaseGreen(runPythonCase, "version-removal-explicit-stale");
});

test("TypeScript SDK adapter fails closed on an unconfirmed cached scoped catalog", () => {
  const result = runTypescriptCase({ id: "scope-304-missing-confirmation" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("Python SDK adapter fails closed on an unconfirmed cached scoped catalog", () => {
  assertCaseGreen(runPythonCase, "scope-304-missing-confirmation");
});

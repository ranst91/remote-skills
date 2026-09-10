import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

type FixtureCase = object & { id: string };

type ExpectedCase = object & { id: string };

interface AdapterSuite {
  expected: string;
  expectedField: string;
  fixtures: string;
  name: string;
}

interface ProtocolInvocation {
  contractVersion: number;
  fixture: FixtureCase;
  id: string;
  protocolRoot: string;
  suite: string;
}

type RunProtocolCase = (input: ProtocolInvocation) => unknown | Promise<unknown>;

const protocolRoot = resolve(import.meta.dirname, "..");

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

function requiredProperty(value: object, property: string): unknown {
  assert.ok(property in value, `JSON value is missing ${property}`);
  return Reflect.get(value, property);
}

function requiredString(value: object, property: string): string {
  const propertyValue = requiredProperty(value, property);
  if (typeof propertyValue !== "string") throw new TypeError(`${property} must be a string`);
  return propertyValue;
}

function requiredNumber(value: object, property: string): number {
  const propertyValue = requiredProperty(value, property);
  if (typeof propertyValue !== "number") throw new TypeError(`${property} must be a number`);
  return propertyValue;
}

function requiredArray(value: object, property: string): unknown[] {
  const propertyValue = requiredProperty(value, property);
  assert.ok(Array.isArray(propertyValue), `${property} must be an array`);
  return propertyValue;
}

function parseSuite(value: unknown): AdapterSuite {
  assert.ok(isObject(value), "adapter suite must be an object");
  return {
    expected: requiredString(value, "expected"),
    expectedField: requiredString(value, "expected_field"),
    fixtures: requiredString(value, "fixtures"),
    name: requiredString(value, "name"),
  };
}

function parseFixtureCase(value: unknown): FixtureCase {
  assert.ok(isObject(value), "fixture case must be an object");
  return Object.assign(value, { id: requiredString(value, "id") });
}

function parseExpectedCase(value: unknown): ExpectedCase {
  assert.ok(isObject(value), "expected case must be an object");
  return Object.assign(value, { id: requiredString(value, "id") });
}

async function readJson(path: string): Promise<unknown> {
  const parsed: unknown = JSON.parse(await readFile(resolve(protocolRoot, path), "utf8"));
  return parsed;
}

function parseArguments(args: readonly string[]) {
  const implementationFlag = args.indexOf("--implementation");
  const caseFlag = args.indexOf("--case");
  const targetCase = caseFlag === -1 ? undefined : args[caseFlag + 1];
  const configuredImplementation =
    implementationFlag === -1 ? undefined : args[implementationFlag + 1];
  if (implementationFlag !== -1 && configuredImplementation === undefined) {
    throw new Error("--implementation requires a path");
  }
  if (caseFlag !== -1 && targetCase === undefined) throw new Error("--case requires an ID");
  return {
    implementationPath:
      configuredImplementation === undefined
        ? resolve(import.meta.dirname, "../../../packages/sdk-typescript/src/protocol-adapter.ts")
        : resolve(configuredImplementation),
    targetCase,
    usesDefaultImplementation: configuredImplementation === undefined,
  };
}

function isErrorWithCode(value: unknown): value is Error & { code: string } {
  return (
    value instanceof Error && "code" in value && typeof Reflect.get(value, "code") === "string"
  );
}

function requireRunProtocolCase(value: unknown): RunProtocolCase {
  assert.ok(isObject(value), "TypeScript implementation module must be an object");
  const candidate = Reflect.get(value, "runProtocolCase");
  if (typeof candidate !== "function") {
    throw new TypeError("TypeScript implementation must export runProtocolCase");
  }
  return candidate;
}

async function loadImplementation(path: string, usesDefaultImplementation: boolean) {
  try {
    const implementation: unknown = await import(pathToFileURL(path).href);
    return requireRunProtocolCase(implementation);
  } catch (error: unknown) {
    if (
      isErrorWithCode(error) &&
      error.code === "ERR_MODULE_NOT_FOUND" &&
      usesDefaultImplementation
    ) {
      throw new Error("RED: TypeScript SDK protocol adapter is not implemented", { cause: error });
    }
    throw error;
  }
}

async function main(): Promise<void> {
  const { implementationPath, targetCase, usesDefaultImplementation } = parseArguments(
    process.argv.slice(2),
  );
  const runProtocolCase = await loadImplementation(implementationPath, usesDefaultImplementation);
  const contract = await readJson("contracts/v0/sdk-adapters.json");
  assert.ok(isObject(contract), "adapter contract must be an object");
  const suites = [
    ...requiredArray(contract, "suites"),
    ...requiredArray(contract, "supplemental_suites"),
  ].map(parseSuite);
  let checked = 0;

  for (const suite of suites) {
    const fixturesDocument = await readJson(suite.fixtures);
    const expectedDocument = await readJson(suite.expected);
    assert.ok(isObject(fixturesDocument), `${suite.name} fixtures must be an object`);
    assert.ok(isObject(expectedDocument), `${suite.name} expected results must be an object`);
    const contractVersion = requiredNumber(fixturesDocument, "contract_version");
    assert.equal(requiredNumber(expectedDocument, "contract_version"), contractVersion, suite.name);
    const fixtures = requiredArray(fixturesDocument, "cases").map(parseFixtureCase);
    const expectedCases = requiredArray(expectedDocument, "cases").map(parseExpectedCase);
    assert.deepEqual(
      fixtures.map(({ id }) => id),
      expectedCases.map(({ id }) => id),
      `${suite.name} fixture and expected case IDs differ`,
    );

    for (const [index, fixture] of fixtures.entries()) {
      if (targetCase !== undefined && fixture.id !== targetCase) continue;
      const expectedCase = expectedCases[index];
      assert.ok(expectedCase, `${suite.name}/${fixture.id} has no expected case`);
      const expectedValue = requiredProperty(expectedCase, suite.expectedField);
      const actual = await runProtocolCase({
        contractVersion,
        suite: suite.name,
        id: fixture.id,
        fixture,
        protocolRoot,
      });
      if (actual === undefined || actual === null) {
        throw new assert.AssertionError({
          message: `${suite.name}/${fixture.id} returned no result`,
        });
      }
      assert.deepEqual(
        actual,
        expectedValue,
        `${suite.name}/${fixture.id} normalized result differs`,
      );
      checked += 1;
    }
  }

  if (targetCase !== undefined && checked === 0) {
    throw new Error(`unknown protocol case: ${targetCase}`);
  }
  process.stdout.write(`TypeScript protocol adapter verified ${checked} shared cases\n`);
}

await main();

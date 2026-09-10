import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createRemoteSkills } from "../../../packages/sdk-typescript/src/index.ts";
import type { ActivatedSessionSkill } from "../../../packages/sdk-typescript/src/session/index.ts";
import {
  decodeActivationExpectations,
  type ExpectedActivation,
} from "../helpers/activation-expectations.ts";

interface ConsumerOptions {
  cache: "off" | "on";
  cacheDirectory: string;
  expected: string;
  format: string;
  origin: string;
}

function requiredOption(options: ReadonlyMap<string, string>, name: string): string {
  const value = options.get(name);
  if (value === undefined) throw new Error(`missing --${name}`);
  return value;
}

function options(arguments_: readonly string[]): Readonly<ConsumerOptions> {
  const parsed = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (!name?.startsWith("--") || value === undefined) {
      throw new Error("consumer arguments must be --name value pairs");
    }
    parsed.set(name.slice(2), value);
  }
  const cache = requiredOption(parsed, "cache");
  if (cache !== "off" && cache !== "on") {
    throw new Error("--cache must be off or on");
  }
  return Object.freeze({
    cache,
    cacheDirectory: requiredOption(parsed, "cache-dir"),
    expected: requiredOption(parsed, "expected"),
    format: requiredOption(parsed, "format"),
    origin: requiredOption(parsed, "origin"),
  });
}

function expectedActivation(value: ExpectedActivation) {
  const { outcome, requests, ...activation } = value;
  assert.equal(outcome, "activation_success");
  assert.equal(requests, 2);
  return activation;
}

async function normalizedActivation(skill: ActivatedSessionSkill) {
  return {
    origin_alias: skill.originAlias,
    name: skill.name,
    digest: skill.digest,
    instructions: skill.instructions,
    frontmatter: skill.frontmatter,
    files: await skill.list(),
  };
}

const selected = options(process.argv.slice(2));
const parsedExpected: unknown = JSON.parse(await readFile(resolve(selected.expected), "utf8"));
const expectedDocument = decodeActivationExpectations(parsedExpected);
const expected = expectedDocument.cases
  .filter(({ id }) => id.startsWith(`${selected.format}-`))
  .map(({ result }) => expectedActivation(result));
assert.equal(expected.length, 2, "the reviewed format must have two activation expectations");

for (let pass = 0; pass < 2; pass += 1) {
  const client = createRemoteSkills({
    origins: {
      "fixture-publisher": {
        url: selected.origin,
        allowLoopbackHttp: true,
        retries: 0,
      },
    },
    ...(selected.cache === "on"
      ? { cache: "disk", cacheOptions: { directory: resolve(selected.cacheDirectory) } }
      : { cache: "memory" }),
  });
  const session = await client.session("fixture-publisher");
  try {
    assert.equal((await session.catalog()).length, expected.length);
    const actual: Awaited<ReturnType<typeof normalizedActivation>>[] = [];
    for (const activation of expected) {
      actual.push(await normalizedActivation(await session.activate(activation.name)));
    }
    assert.deepEqual(actual, expected);
  } finally {
    await session.close();
  }
}

process.stdout.write(
  `${JSON.stringify({ language: "typescript", cache: selected.cache, passes: 2 })}\n`,
);

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const pythonManifestPath = "packages/sdk-python/package.json";
const pythonTurboPath = "packages/sdk-python/turbo.json";

function jsonObject(value: unknown, label: string): object {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function parseJsonObject(path: string): object {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  return jsonObject(value, path);
}

function property(value: object, field: string): unknown {
  return Reflect.get(value, field);
}

function objectProperty(value: object, field: string): object {
  return jsonObject(property(value, field), field);
}

function stringProperty(value: object, field: string): string {
  const member = property(value, field);
  if (typeof member !== "string") throw new TypeError(`${field} must be a string`);
  return member;
}

test("Python uv operations are explicit Turbo tasks with declared inputs", () => {
  assert.ok(
    existsSync(pythonTurboPath),
    `${pythonTurboPath} must declare Python-specific Turbo tasks`,
  );

  const manifest = parseJsonObject(pythonManifestPath);
  const scripts = objectProperty(manifest, "scripts");
  const turbo = parseJsonObject(pythonTurboPath);
  const tasks = objectProperty(turbo, "tasks");
  const requiredInputs = [
    "$TURBO_DEFAULT$",
    "$TURBO_ROOT$/uv.lock",
    "$TURBO_ROOT$/pyproject.toml",
    "pyproject.toml",
  ];

  for (const taskName of ["uv:sync", "uv:typecheck", "uv:test"]) {
    assert.equal(typeof property(scripts, taskName), "string");
    const task = objectProperty(tasks, taskName);
    assert.deepEqual(property(task, "inputs"), requiredInputs);
    assert.deepEqual(property(task, "outputs"), []);
  }

  for (const taskName of ["uv:typecheck", "uv:test", "typecheck", "test"]) {
    const task = objectProperty(tasks, taskName);
    const dependsOn = property(task, "dependsOn");
    assert.ok(Array.isArray(dependsOn), `${taskName}.dependsOn must be an array`);
    assert.ok(dependsOn.includes("uv:sync"));
  }
  assert.match(stringProperty(scripts, "typecheck"), /compileall -q src tests/u);
  assert.match(stringProperty(scripts, "test"), /unittest discover -s tests/u);
  assert.match(stringProperty(scripts, "check"), /typecheck/u);
  assert.match(stringProperty(scripts, "check"), /test/u);
  assert.doesNotMatch(JSON.stringify(scripts), /run-package-gate/u);
});

import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  assertLockedIntegrationResolution,
  writeLockedIntegrationProject,
} from "../../scripts/release/integration-dependencies.ts";
import { manifestObject } from "../../scripts/release/release-lib.ts";

test("artifact consumers retain the source dependency versions, peer snapshots and integrity hashes", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "integration-lock-test-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  writeLockedIntegrationProject(process.cwd(), directory);
  const source = readFileSync("pnpm-lock.yaml", "utf8");
  const projected = readFileSync(join(directory, "pnpm-lock.yaml"), "utf8");
  assert.equal(
    projected.slice(projected.indexOf("\npackages:\n")),
    source.slice(source.indexOf("\npackages:\n")),
  );
  assert.doesNotMatch(
    projected.slice(0, projected.indexOf("\npackages:\n")),
    /catalogs:|workspace:|link:/u,
  );
  const manifest: unknown = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  assert.ok(typeof manifest === "object" && manifest !== null);
  const original = manifestObject(readFileSync("integrations/ai-sdk/package.json", "utf8"));
  const runtime = manifestObject(JSON.stringify(Reflect.get(original, "dependencies")));
  const development = manifestObject(JSON.stringify(Reflect.get(original, "devDependencies")));
  const expectedDevelopment = Object.fromEntries(
    Object.entries(development).filter(
      ([, value]) =>
        typeof value === "string" &&
        !value.startsWith("workspace:") &&
        !value.startsWith("catalog:"),
    ),
  );
  assert.deepEqual(Reflect.get(manifest, "dependencies"), { ...runtime, ...expectedDevelopment });
  assert.doesNotThrow(() => assertLockedIntegrationResolution(process.cwd(), directory, []));
  const emptySnapshot = /(\n {2}[^ \n][^\n]*): \{\}/u;
  assert.match(projected, emptySnapshot);
  writeFileSync(
    join(directory, "pnpm-lock.yaml"),
    projected.replace(emptySnapshot, "$1:\n    optional: true"),
  );
  assert.doesNotThrow(() => assertLockedIntegrationResolution(process.cwd(), directory, []));
  writeFileSync(
    join(directory, "pnpm-lock.yaml"),
    projected.replace(emptySnapshot, "$1:\n    dependencies:\n      unexpected-package: 1.0.0"),
  );
  assert.throws(
    () => assertLockedIntegrationResolution(process.cwd(), directory, []),
    /Installed snapshots entry differs from source lock/u,
  );
  writeFileSync(
    join(directory, "pnpm-lock.yaml"),
    projected.replace("integrity: sha512-", "integrity: sha512-altered"),
  );
  assert.throws(
    () => assertLockedIntegrationResolution(process.cwd(), directory, []),
    /Installed packages entry differs from source lock/u,
  );
});

test("artifact dependency preparation rejects a missing lock entry instead of resolving a replacement", (context) => {
  const root = mkdtempSync(join(tmpdir(), "integration-lock-missing-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "integrations/ai-sdk"), { recursive: true });
  copyFileSync("integrations/ai-sdk/package.json", join(root, "integrations/ai-sdk/package.json"));
  const lock = readFileSync("pnpm-lock.yaml", "utf8");
  const start = lock.indexOf("\n  integrations/ai-sdk:\n");
  writeFileSync(
    join(root, "pnpm-lock.yaml"),
    lock.slice(0, start) +
      lock.slice(start).replace("      bash-tool:", "      missing-bash-tool:"),
  );
  assert.throws(
    () => writeLockedIntegrationProject(root, root),
    /Missing locked integration dependency: bash-tool/u,
  );
});

test("explicit YAML snapshot keys retain exact dependency comparison", (context) => {
  const root = mkdtempSync(join(tmpdir(), "integration-long-key-"));
  const consumer = join(root, "consumer");
  mkdirSync(consumer);
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const key = `framework@1.0.0(peer@${"a".repeat(1100)})`;
  const header = "\npackages:\n  dependency@1.0.0: {}\n\nsnapshots:\n";
  writeFileSync(
    join(root, "pnpm-lock.yaml"),
    `${header}  '${key}':\n    dependencies:\n      dependency: 1.0.0\n`,
  );
  const explicit = `${header}  ? '${key}'\n  :\n    dependencies:\n      dependency: 1.0.0\n`;
  writeFileSync(join(consumer, "pnpm-lock.yaml"), explicit);
  assert.doesNotThrow(() => assertLockedIntegrationResolution(root, consumer, []));
  writeFileSync(
    join(consumer, "pnpm-lock.yaml"),
    explicit.replace("dependency: 1.0.0", "dependency: 2.0.0"),
  );
  assert.throws(
    () => assertLockedIntegrationResolution(root, consumer, []),
    /Installed snapshots entry differs/u,
  );
});

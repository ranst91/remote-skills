import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { readReleaseState } from "../../scripts/release/release-lib.ts";
import { runCommand } from "../helpers/run-command.ts";

const publicPackages = [
  {
    ecosystem: "npm",
    manifest: "packages/cli/package.json",
    name: "@remote-skills/cli",
  },
  {
    ecosystem: "npm",
    manifest: "packages/sdk-typescript/package.json",
    name: "@remote-skills/client",
  },
  {
    ecosystem: "pypi",
    manifest: "packages/sdk-python/pyproject.toml",
    name: "remote-skills",
  },
  { ecosystem: "npm", manifest: "integrations/ai-sdk/package.json", name: "@remote-skills/ai-sdk" },
] as const;

interface PackageMaterial {
  bytes: number;
  path: string;
  sha256: string;
}

interface PackageSummary {
  ecosystem: string;
  manifest: string;
  name: string;
  version: string;
}

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

function parseJsonObject(path: string): object {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  assert.ok(isObject(value), `${path} must contain an object`);
  return value;
}

function objectProperty(value: object, property: string): object {
  const propertyValue: unknown = Reflect.get(value, property);
  assert.ok(isObject(propertyValue), `${property} must be an object`);
  return propertyValue;
}

function stringProperty(value: object, property: string): string {
  const propertyValue: unknown = Reflect.get(value, property);
  assert.ok(typeof propertyValue === "string", `${property} must be a string`);
  return propertyValue;
}

function readInventory(serialized: string): {
  kind: string;
  materials: PackageMaterial[];
  packages: PackageSummary[];
  schemaVersion: number;
} {
  const value: unknown = JSON.parse(serialized);
  assert.ok(isObject(value));
  const schemaVersion: unknown = Reflect.get(value, "schemaVersion");
  const packages: unknown = Reflect.get(value, "packages");
  const materials: unknown = Reflect.get(value, "materials");
  assert.ok(typeof schemaVersion === "number");
  assert.ok(Array.isArray(packages));
  assert.ok(Array.isArray(materials));
  return {
    kind: stringProperty(value, "kind"),
    schemaVersion,
    packages: packages.map((entry: unknown) => {
      assert.ok(isObject(entry));
      return {
        ecosystem: stringProperty(entry, "ecosystem"),
        manifest: stringProperty(entry, "manifest"),
        name: stringProperty(entry, "name"),
        version: stringProperty(entry, "version"),
      };
    }),
    materials: materials.map((entry: unknown) => {
      assert.ok(isObject(entry));
      const bytes: unknown = Reflect.get(entry, "bytes");
      assert.ok(typeof bytes === "number");
      return {
        bytes,
        path: stringProperty(entry, "path"),
        sha256: stringProperty(entry, "sha256"),
      };
    }),
  };
}

test("public package checks are coordinated without coupling package versions", () => {
  const [cliPackage, clientPackage, pythonPackage] = publicPackages;
  assert.ok(cliPackage !== undefined && clientPackage !== undefined && pythonPackage !== undefined);
  const rootManifest = parseJsonObject("package.json");
  const cliManifest = parseJsonObject(cliPackage.manifest);
  const clientManifest = parseJsonObject(clientPackage.manifest);
  const pythonWorkspace = parseJsonObject("packages/sdk-python/package.json");
  const pythonProject = readFileSync(pythonPackage.manifest, "utf8");
  const rootScripts = objectProperty(rootManifest, "scripts");
  const cliScripts = objectProperty(cliManifest, "scripts");
  const clientScripts = objectProperty(clientManifest, "scripts");
  const pythonScripts = objectProperty(pythonWorkspace, "scripts");
  const cliBin = objectProperty(cliManifest, "bin");
  const clientExports = objectProperty(objectProperty(clientManifest, "exports"), ".");

  assert.equal(
    stringProperty(rootScripts, "package:check"),
    "node scripts/check-package-artifacts.ts",
  );
  assert.equal(
    stringProperty(rootScripts, "package:inputs"),
    "node scripts/package-artifact-inputs.ts",
  );
  assert.equal(stringProperty(cliScripts, "package:check"), "node --test tests/package.test.ts");
  assert.equal(
    stringProperty(clientScripts, "package:check"),
    "node --test tests/package-gate.test.ts",
  );
  assert.equal(stringProperty(cliBin, "remote-skills"), "dist/cli.js");
  assert.equal(stringProperty(clientManifest, "types"), "./dist/index.d.ts");
  assert.equal(stringProperty(clientExports, "types"), "./dist/index.d.ts");
  assert.equal(stringProperty(clientExports, "import"), "./dist/index.js");
  assert.equal(stringProperty(clientExports, "browser"), "./dist/browser-rejection.js");
  assert.equal(stringProperty(clientExports, "require"), "./dist/require-rejection.cjs");
  assert.equal(
    stringProperty(pythonScripts, "package:check"),
    "node ../../scripts/run-uv.ts run --no-project --python 3.11 --no-python-downloads python -m unittest discover -s tests -p test_package.py",
  );
  const state = readReleaseState();
  assert.equal(stringProperty(cliManifest, "version"), state.npmVersion);
  assert.equal(stringProperty(clientManifest, "version"), state.npmVersion);
  assert.ok(pythonProject.includes(`version = "${state.pythonVersion}"`));
  assert.equal(stringProperty(cliManifest, "license"), "Apache-2.0");
  assert.equal(stringProperty(clientManifest, "license"), "Apache-2.0");
  assert.match(pythonProject, /^license = "Apache-2\.0"$/mu);
});

test("package input inventory is deterministic local metadata with verified materials", () => {
  const first = runCommand(process.execPath, ["scripts/package-artifact-inputs.ts"]);
  const second = runCommand(process.execPath, ["scripts/package-artifact-inputs.ts"]);

  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(first.stdout, second.stdout);

  const inventory = readInventory(first.stdout);
  assert.equal(inventory.schemaVersion, 1);
  assert.equal(inventory.kind, "remote-skills-package-inputs");
  assert.deepEqual(
    inventory.packages.map(({ ecosystem, manifest, name, version }) => ({
      ecosystem,
      manifest,
      name,
      version,
    })),
    publicPackages.map((entry) => ({
      ...entry,
      version:
        entry.ecosystem === "pypi"
          ? readReleaseState().pythonVersion
          : readReleaseState().manifests.find((manifest) => manifest.name === entry.name)?.version,
    })),
  );
  assert.equal(inventory.materials.length > 0, true);
  assert.deepEqual(
    inventory.materials.map(({ path }) => path),
    inventory.materials.map(({ path }) => path).toSorted(),
  );

  const requiredMaterials = new Set([
    "LICENSE",
    "README.md",
    "package.json",
    "packages/cli/package.json",
    "packages/cli/scripts/build.ts",
    "packages/cli/scripts/pack-local.ts",
    "packages/cli/tsconfig.build.json",
    "packages/core/scripts/build.ts",
    "packages/core/tsconfig.build.json",
    "packages/sdk-python/LICENSE",
    "packages/sdk-python/README.md",
    "packages/sdk-python/pyproject.toml",
    "packages/sdk-typescript/package.json",
    "packages/sdk-typescript/scripts/pack-local.ts",
    "packages/sdk-typescript/tsconfig.build.json",
    "packages/sdk-typescript/tsconfig.json",
    "pnpm-lock.yaml",
    "pyproject.toml",
    "tsconfig.base.json",
    "uv.lock",
  ]);
  for (const material of inventory.materials) {
    assert.equal(material.path.split("/").includes("__pycache__"), false, material.path);
    assert.notEqual(material.path.endsWith(".pyc"), true, material.path);
    requiredMaterials.delete(material.path);
    const bytes = readFileSync(material.path);
    assert.equal(material.bytes, bytes.byteLength);
    assert.equal(material.sha256, createHash("sha256").update(bytes).digest("hex"));
  }
  assert.deepEqual([...requiredMaterials], []);
  for (const workspaceOnly of [
    "packages/sdk-python/src/remote_skills/cache/protocol.py",
    "packages/sdk-python/src/remote_skills/protocol_adapter.py",
    "packages/sdk-typescript/src/protocol-adapter.ts",
    "packages/sdk-typescript/src/cache/protocol-worker.mjs",
    "packages/sdk-typescript/src/cache/protocol-worker.ts",
  ]) {
    assert.equal(
      inventory.materials.some(({ path }) => path === workspaceOnly),
      false,
      `workspace-only source in package material inventory: ${workspaceOnly}`,
    );
  }
  const serializedKeys = JSON.stringify(inventory);
  for (const forbiddenField of ["oidc", "registry", "signature", "token", "upload"]) {
    assert.doesNotMatch(serializedKeys, new RegExp(`"${forbiddenField}"`, "iu"));
  }
});

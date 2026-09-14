import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readPublishedSdks } from "../../scripts/release/published-sdks.ts";
import { selectSdkVersion } from "../../scripts/release/release-lib.ts";
import { downloadSdkArchive } from "../../scripts/release/sdk-dependencies.ts";

function metadata() {
  const bytes = Buffer.from("verified SDK archive");
  const npm = {
    name: "@remote-skills/client",
    versions: {
      "0.0.1": {
        name: "@remote-skills/client",
        version: "0.0.1",
        dist: {
          tarball: "https://registry.npmjs.org/@remote-skills/client/-/client-0.0.1.tgz",
          integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
        },
      },
    },
  };
  const file = {
    yanked: false,
    url: "https://files.pythonhosted.org/remote_skills-0.0.1.whl",
    digests: { sha256: createHash("sha256").update(bytes).digest("hex") },
  };
  const python = {
    info: { name: "remote-skills" },
    releases: {
      "0.0.1": [
        { ...file, packagetype: "bdist_wheel" },
        { ...file, packagetype: "sdist" },
      ],
      "0.0.2": [
        { ...file, yanked: true, packagetype: "bdist_wheel" },
        { ...file, yanked: true, packagetype: "sdist" },
      ],
      "0.0.3": [],
    },
  };
  const lookup: typeof fetch = async (url) =>
    Response.json(String(url).includes("npmjs") ? npm : python);
  return { bytes, npm, python, lookup };
}

test("integration dependency selection uses compatible candidates or genuinely published older SDKs", () => {
  assert.equal(selectSdkVersion("npm", "^0.0.1-alpha.0", "0.0.2", ["0.0.1"]), "0.0.1");
  assert.equal(selectSdkVersion("npm", "^0.0.2", "0.0.2", []), "0.0.2");
  assert.equal(selectSdkVersion("pypi", "0.0.1", "0.0.2", ["0.0.1"]), "0.0.1");
  assert.equal(selectSdkVersion("pypi", "0.0.2", "0.0.2", []), "0.0.2");
  for (const registry of ["npm", "pypi"] as const)
    assert.throws(
      () => selectSdkVersion(registry, "0.0.2", undefined, ["0.0.1"]),
      /No compatible available/u,
    );
  assert.throws(() => selectSdkVersion("npm", "^0.0.1", "0.0.2", []), /No compatible available/u);
});

test("published SDK inventory excludes yanked and empty releases and retains artifact digests", async () => {
  const fixture = metadata();
  const inventory = await readPublishedSdks(fixture.lookup);
  assert.deepEqual(inventory.versions, { npm: ["0.0.1"], pypi: ["0.0.1"] });
  assert.equal(
    inventory.npm.get("0.0.1")?.digest,
    fixture.npm.versions["0.0.1"].dist.integrity.slice(7),
  );
});

test("unavailable, malformed and wrong-identity registries cannot prove compatibility", async () => {
  await assert.rejects(
    readPublishedSdks(async () => new Response("", { status: 503 })),
    /Cannot verify published/u,
  );
  await assert.rejects(
    readPublishedSdks(async () => new Response("not JSON")),
    /Cannot verify published/u,
  );
  const fixture = metadata();
  fixture.npm.name = "wrong-package";
  await assert.rejects(readPublishedSdks(fixture.lookup), /Unexpected published SDK identity/u);
});

test("an absent registry package supplies no published versions for a first release", async () => {
  const result = await readPublishedSdks(async () => new Response("", { status: 404 }));
  assert.deepEqual(result.versions, { npm: [], pypi: [] });
  assert.equal(
    selectSdkVersion("npm", "^0.0.1-alpha.0", "0.0.1-alpha.0", result.versions.npm),
    "0.0.1-alpha.0",
  );
  assert.throws(
    () => selectSdkVersion("npm", "^0.0.1-alpha.0", undefined, result.versions.npm),
    /No compatible available/u,
  );
});

test("published SDK archives must have a trusted origin and matching metadata", async () => {
  const fixture = metadata();
  fixture.npm.versions["0.0.1"].dist.tarball = "https://example.test/archive.tgz";
  await assert.rejects(
    readPublishedSdks(fixture.lookup),
    /Unexpected published SDK archive origin/u,
  );
  fixture.npm.versions["0.0.1"].version = "0.0.2";
  await assert.rejects(readPublishedSdks(fixture.lookup), /version metadata disagrees/u);
});

test("downloaded SDK bytes are verified before being written or installed", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "sdk-dependency-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const fixture = metadata();
  const archive = (await readPublishedSdks(fixture.lookup)).npm.get("0.0.1");
  assert.ok(archive);
  const path = join(directory, "sdk.tgz");
  await assert.rejects(
    downloadSdkArchive(archive, path, async () => new Response("wrong bytes")),
    /digest mismatch/u,
  );
  assert.equal(existsSync(path), false);
  await assert.rejects(
    downloadSdkArchive(archive, path, async () => new Response("", { status: 404 })),
    /unavailable/u,
  );
  await assert.rejects(
    downloadSdkArchive(archive, path, async () => new Response(Buffer.alloc(16 * 1024 * 1024 + 1))),
    /size limit/u,
  );
  assert.equal(existsSync(path), false);
  await downloadSdkArchive(archive, path, async () => new Response(fixture.bytes));
  assert.deepEqual(readFileSync(path), fixture.bytes);
});

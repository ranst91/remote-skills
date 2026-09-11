import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  artifactFile,
  missingFiles,
  type PublicationPackage,
  verifyPublicationFiles,
} from "../../scripts/release/publication-lib.ts";

const file = { path: "npm/client-0.0.1.tgz", sha256: "sha256", integrity: "sha512-exact" };
const npm: PublicationPackage = {
  name: "@remote-skills/client",
  version: "0.0.1",
  registry: "npm",
  npmTag: "latest",
  files: [file],
};
const response = (status: number, value: unknown) => async () => ({
  status,
  json: async () => value,
});
test("publication retries skip only the exact npm version and artifact digest", async () => {
  assert.deepEqual(await missingFiles(npm, response(404, {})), [file]);
  assert.deepEqual(
    await missingFiles(npm, async (url) => {
      assert.equal(url, "https://registry.npmjs.org/%40remote-skills%2Fclient/0.0.1");
      return {
        status: 200,
        json: async () => ({ version: "0.0.1", dist: { integrity: file.integrity } }),
      };
    }),
    [],
  );
  await assert.rejects(
    missingFiles(npm, response(200, { version: "0.0.1", dist: { integrity: "other" } })),
    /different artifact bytes/u,
  );
  await assert.rejects(
    missingFiles(npm, response(200, { version: "0.0.2", dist: {} })),
    /version mismatch/u,
  );
  await assert.rejects(missingFiles(npm, response(503, {})), /Registry lookup failed/u);
});
test("partial Python publication retries only missing distributions", async () => {
  const wheel = { ...file, path: "python/remote_skills-0.0.1-py3-none-any.whl" };
  const sdist = { ...file, path: "python/remote_skills-0.0.1.tar.gz" };
  const python: PublicationPackage = {
    ...npm,
    name: "remote-skills",
    registry: "pypi",
    files: [wheel, sdist],
  };
  const metadata = {
    info: { version: "0.0.1" },
    urls: [{ filename: wheel.path.split("/")[1], digests: { sha256: wheel.sha256 } }],
  };
  assert.deepEqual(await missingFiles(python, response(200, metadata)), [sdist]);
  const publishedWheel = metadata.urls[0];
  assert.ok(publishedWheel);
  publishedWheel.digests.sha256 = "different";
  await assert.rejects(missingFiles(python, response(200, metadata)), /different artifact bytes/u);
});
test("the publication plan verifies selected bytes and rejects tampering or path traversal", () => {
  const root = mkdtempSync(join(tmpdir(), "remote-skills-publication-test-"));
  try {
    mkdirSync(join(root, "npm"));
    writeFileSync(join(root, file.path), "verified candidate");
    const artifact = artifactFile(root, file.path);
    const plan = {
      packages: [{ ...npm, files: [artifact] }],
      releases: [
        {
          scope: "core",
          version: "0.0.1",
          gitTag: "core/v0.0.1",
          prerelease: false,
          notes: "release-notes-core.md",
        },
      ],
    };
    verifyPublicationFiles(root, plan);
    writeFileSync(join(root, file.path), "changed after verification");
    assert.throws(() => verifyPublicationFiles(root, plan), /digest mismatch/u);
    assert.throws(() => artifactFile(root, "../secrets"), /Invalid publication artifact path/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

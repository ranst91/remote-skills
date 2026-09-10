import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { protocolRoot, readSha256Manifest, sha256 } from "../helpers/contract-helpers.ts";

const manifests = ["manifests/archive-fixtures.sha256", "manifests/publisher-goldens.sha256"];
let verified = 0;

for (const manifestPath of manifests) {
  for (const entry of readSha256Manifest(manifestPath)) {
    assert.equal(sha256(readFileSync(resolve(protocolRoot, entry.path))), entry.digest, entry.path);
    verified += 1;
  }
}

process.stdout.write(`verified ${verified} fixture bytes across ${manifests.length} manifests\n`);

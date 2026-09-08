import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const coreTestFiles = [
  "packages/core/tests/authoring-validation.test.ts",
  "packages/core/tests/build.test.ts",
];

interface MutationProbe {
  file: string;
  name: string;
  reason: string;
}

const expectedProbes = [
  {
    file: "packages/core/tests/authoring-validation.test.ts",
    name: "rejects replacement of an intermediate source-root ancestor",
    reason: "requires POSIX ancestor renames while retained directory handles remain open",
  },
  {
    file: "packages/core/tests/authoring-validation.test.ts",
    name: "rejects a project-root ABA swap restored before snapshot completion",
    reason: "requires POSIX ancestor renames while retained directory handles remain open",
  },
  {
    file: "packages/core/tests/authoring-validation.test.ts",
    name: "rejects a parent-ancestor pivot that serves replacement skill bytes",
    reason: "requires POSIX ancestor renames while retained directory handles remain open",
  },
  {
    file: "packages/core/tests/build.test.ts",
    name: "prior output parent ABA during initial artifact verification fails closed",
    reason: "requires POSIX ancestor ABA error classification during initial artifact verification",
  },
];

test("Windows excludes only the four POSIX filesystem mutation probes", () => {
  const actualProbes: MutationProbe[] = [];
  const declaration =
    /test\(\s*"([^"]+)",\s*async \(context\) => \{\s*if \(\s*posixMutationProbe\(\s*context,\s*"([^"]+)"\s*,?\s*\)\s*\)\s*return;/gu;

  for (const file of coreTestFiles) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(declaration)) {
      const name = match[1];
      const reason = match[2];
      assert.ok(name !== undefined && reason !== undefined);
      actualProbes.push({ file, name, reason });
    }

    const helperUses = source.match(/\bposixMutationProbe\(/gu) ?? [];
    const directTestUses = actualProbes.filter((probe) => probe.file === file);
    assert.equal(
      helperUses.length,
      directTestUses.length,
      `${file} must apply every POSIX mutation exclusion directly to one test`,
    );
    assert.doesNotMatch(source, /(?:describe|suite)\.skip\s*\(/u);
  }

  assert.deepEqual(actualProbes, expectedProbes);
});

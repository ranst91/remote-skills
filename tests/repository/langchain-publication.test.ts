import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { verifyPublicationFiles } from "../../scripts/release/publication-lib.ts";
import {
  buildPublicationPlan,
  pythonArtifactPaths,
} from "../../scripts/release/publication-plan.ts";

test("LangChain publication hashes only selected adapters while dependency and nearby-version files remain candidates", (t) => {
  const output = mkdtempSync(join(tmpdir(), "langchain-plan-"));
  t.after(() => rmSync(output, { recursive: true, force: true }));
  mkdirSync(join(output, "npm"));
  mkdirSync(join(output, "python"));
  const selected = [
    "npm/remote-skills-langchain-0.0.1-alpha.1.tgz",
    ...pythonArtifactPaths({ name: "remote-skills-langchain", version: "0.0.1a1" }),
  ];
  const dependencies = [
    "npm/remote-skills-client-0.0.1-alpha.0.tgz",
    "npm/remote-skills-cli-0.0.1-alpha.0.tgz",
    "npm/remote-skills-ai-sdk-0.0.1-alpha.0.tgz",
    ...pythonArtifactPaths({ name: "remote-skills", version: "0.0.1a0" }),
    ...pythonArtifactPaths({ name: "remote-skills-langchain", version: "0.0.1a10" }),
  ];
  for (const file of [...selected, ...dependencies])
    writeFileSync(join(output, file), `fixture:${file}`);
  const plan = buildPublicationPlan(
    {
      releases: [
        {
          scope: "integration-langchain",
          version: "0.0.1-alpha.1",
          gitTag: "integration-langchain/v0.0.1-alpha.1",
          npmTag: "alpha",
          prerelease: true,
          packages: [
            {
              id: "langchain",
              scope: "integration-langchain",
              name: "@remote-skills/langchain",
              registry: "npm",
              version: "0.0.1-alpha.1",
            },
            {
              id: "langchain_python",
              scope: "integration-langchain",
              name: "remote-skills-langchain",
              registry: "pypi",
              version: "0.0.1a1",
            },
          ],
        },
      ],
    },
    output,
    "## [integration-langchain/v0.0.1-alpha.1]\n\n- Integration only.\n",
  );
  assert.deepEqual(
    plan.packages.flatMap((p) => p.files.map((f) => f.path)),
    selected,
  );
  assert.deepEqual(
    plan.packages.map((p) => p.name),
    ["@remote-skills/langchain", "remote-skills-langchain"],
  );
  assert.equal(plan.releases.length, 1);
  verifyPublicationFiles(output, plan);
  assert.match(
    readFileSync(join(output, "release-notes-integration-langchain.md"), "utf8"),
    /Integration only/u,
  );
  writeFileSync(join(output, selected[1] ?? ""), "changed");
  assert.throws(() => verifyPublicationFiles(output, plan), /digest mismatch/u);
});

test("exact selected Python artifacts must exist even when alpha ten is present", (t) => {
  const output = mkdtempSync(join(tmpdir(), "langchain-exact-"));
  t.after(() => rmSync(output, { recursive: true, force: true }));
  mkdirSync(join(output, "python"));
  for (const file of pythonArtifactPaths({ name: "remote-skills-langchain", version: "0.0.1a10" }))
    writeFileSync(join(output, file), "neighbor");
  assert.throws(
    () =>
      buildPublicationPlan(
        {
          releases: [
            {
              scope: "integration-langchain",
              version: "0.0.1-alpha.1",
              gitTag: "integration-langchain/v0.0.1-alpha.1",
              npmTag: "alpha",
              prerelease: true,
              packages: [
                {
                  id: "langchain_python",
                  scope: "integration-langchain",
                  name: "remote-skills-langchain",
                  registry: "pypi",
                  version: "0.0.1a1",
                },
              ],
            },
          ],
        },
        output,
        "",
      ),
    /ENOENT/u,
  );
});

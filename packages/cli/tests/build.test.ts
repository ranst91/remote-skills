import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { gunzipSync, inflateRawSync } from "node:zlib";

import { ConfigValidationError } from "@remote-skills/core/config-schema";

import { parseBuildArgs, runBuildCommand } from "../src/build.ts";
import { validateVerifiedArtifact } from "../src/verify-artifact.ts";

const temporaryProjects: string[] = [];

afterEach(() => {
  for (const projectDir of temporaryProjects.splice(0)) {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

function createProject(): string {
  const projectDir = mkdtempSync(path.join(tmpdir(), "remote-skills-cli-build-"));
  temporaryProjects.push(projectDir);
  mkdirSync(path.join(projectDir, "skills", "cli-build"), { recursive: true });
  writeFileSync(
    path.join(projectDir, "skills", "cli-build", "SKILL.md"),
    "---\nname: cli-build\ndescription: Exercise CLI build options.\n---\n# Build\n",
  );
  return projectDir;
}

function archiveIndexEntry(value: unknown): object {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("catalog index must be an object");
  }
  const skills: unknown = Reflect.get(value, "skills");
  if (!Array.isArray(skills) || skills.length === 0) {
    throw new TypeError("catalog index skills must be a non-empty array");
  }
  const first: unknown = skills[0];
  if (first === null || typeof first !== "object" || Array.isArray(first)) {
    throw new TypeError("catalog index skill must be an object");
  }
  return first;
}

test("parses deterministic build overrides, prior output, and repeatable pruning", () => {
  assert.deepEqual(
    parseBuildArgs([
      "--archive",
      "--format",
      "zip",
      "--out-dir=public",
      "--prior-output",
      "previous",
      "--prune",
      "cli-build@1.0.0",
      "--prune=cli-build@1.1.0",
    ]),
    {
      forceArchive: true,
      overrides: { format: "zip", outDir: "public" },
      priorOutputDir: "previous",
      prune: { "cli-build": ["1.0.0", "1.1.0"] },
    },
  );
});

test("accumulates pruning versions under own skill-name properties", () => {
  const parsed = parseBuildArgs([
    "--prune=constructor@1.0.0",
    "--prune",
    "cli-build@1.1.0",
    "--prune",
    "constructor@1.2.0",
    "--prune=cli-build@1.1.0",
  ]);

  assert.deepEqual(parsed, {
    overrides: {},
    prune: {
      constructor: ["1.0.0", "1.2.0"],
      "cli-build": ["1.1.0", "1.1.0"],
    },
  });
  assert.ok(parsed.prune && Object.hasOwn(parsed.prune, "constructor"));
});

for (const format of ["zip", "tar.gz"] as const) {
  test(`build command preserves empty resources in a verified ${format} archive`, async () => {
    const projectDir = createProject();
    const resources = path.join(projectDir, "skills", "cli-build", "resources");
    mkdirSync(path.join(resources, "empty-directory"), { recursive: true });
    writeFileSync(path.join(resources, "empty.txt"), "");

    const result = await runBuildCommand({
      projectDir,
      args: ["--archive", "--format", format, "--out-dir", "public"],
    });

    assert.equal(result.exitCode, 0);
    const rawIndex: unknown = JSON.parse(
      readFileSync(
        path.join(projectDir, "public", ".well-known", "agent-skills", "index.json"),
        "utf8",
      ),
    );
    const entry = archiveIndexEntry(rawIndex);
    const artifactType: unknown = Reflect.get(entry, "type");
    const artifactUrl: unknown = Reflect.get(entry, "url");
    assert.equal(artifactType, "archive");
    if (typeof artifactUrl !== "string") throw new TypeError("catalog index URL must be a string");
    assert.ok(artifactUrl.endsWith(`.${format}`));
    const bytes = readFileSync(
      path.join(projectDir, "public", ".well-known", "agent-skills", artifactUrl),
    );
    await validateVerifiedArtifact(bytes, {
      type: "archive",
      url: new URL(artifactUrl, "https://skills.example.test/"),
      skillName: "cli-build",
      limits: { files: 2, fileBytes: 1024, extractedBytes: 1024 },
    });
    const archive = format === "zip" ? bytes : gunzipSync(bytes);
    const name = Buffer.from("resources/empty.txt");
    const nameOffset = archive.indexOf(name);
    assert.ok(nameOffset >= 0, "the archive must contain the empty resource");
    if (format === "zip") {
      const header = nameOffset - 30;
      assert.equal(archive.readUInt32LE(header), 0x0403_4b50);
      assert.equal(archive.readUInt32LE(header + 22), 0);
      const dataStart = nameOffset + name.length;
      const dataEnd = dataStart + archive.readUInt32LE(header + 18);
      assert.deepEqual(inflateRawSync(archive.subarray(dataStart, dataEnd)), Buffer.alloc(0));
    } else {
      assert.equal(nameOffset % 512, 0);
      assert.equal(
        Number.parseInt(archive.toString("ascii", nameOffset + 124, nameOffset + 136), 8),
        0,
      );
    }
  });
}

test("rejects unknown, missing, unsafe, and malformed build options", () => {
  for (const args of [
    ["--unknown"],
    ["--format"],
    ["--format", "rar"],
    ["--format=zip=unexpected"],
    ["--out-dir", "../outside"],
    ["--prior-output", "../outside"],
    ["--prune", "missing-version"],
  ]) {
    assert.throws(
      () => parseBuildArgs(args),
      (error) => error instanceof ConfigValidationError,
      JSON.stringify(args),
    );
  }
});

test("unknown build options never echo their raw argument bytes", () => {
  const canary = "CLI_UNKNOWN_OPTION_SECRET_CANARY";
  assert.throws(
    () => parseBuildArgs([`--unknown=https://user:${canary}@example.test/?token=${canary}`]),
    (error) =>
      error instanceof ConfigValidationError &&
      !error.message.includes(canary) &&
      !JSON.stringify(error).includes(canary),
  );
});

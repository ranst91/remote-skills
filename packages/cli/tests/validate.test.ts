import assert from "node:assert/strict";
import fs, {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { ConfigValidationError } from "@remote-skills/core/config-schema";

import { loadPublisherConfig } from "../src/config.ts";
import { parseValidateArgs, runValidateCommand } from "../src/validate.ts";

type FilesystemOverrides = {
  lstat?: (target: fs.PathLike, options?: fs.StatOptions) => Promise<fs.Stats | fs.BigIntStats>;
  open?: (target: fs.PathLike, flags: string | number, mode?: fs.Mode) => Promise<FileHandle>;
  readFile?: (target: fs.PathLike | FileHandle) => Promise<Buffer>;
  realpath?: (target: fs.PathLike) => Promise<string>;
};

const temporaryProjects: string[] = [];

afterEach(() => {
  for (const projectDir of temporaryProjects.splice(0)) {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

function createProject(files: Record<string, string>): string {
  const projectDir = mkdtempSync(path.join(tmpdir(), "remote-skills-cli-"));
  temporaryProjects.push(projectDir);
  for (const [relativePath, contents] of Object.entries(files)) {
    const absolutePath = path.join(projectDir, relativePath);
    mkdirSync(path.dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, contents);
  }
  return projectDir;
}

function verboseSkill(lineEnding = "\n"): string {
  const body = Array.from({ length: 501 }, (_, index) => `Line ${index + 1}`).join(lineEnding);
  return `---
name: verbose-skill
description: Exercise strict validation behavior from the CLI.
---
${body}
`;
}

function assertValueRedacted(value: unknown, canary: string, seen = new Set<object>()): void {
  if (typeof value === "string") {
    assert.equal(value.includes(canary), false);
    return;
  }
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === "string") assert.equal(key.includes(canary), false);
    assertValueRedacted(Object.getOwnPropertyDescriptor(value, key)?.value, canary, seen);
  }
}

async function withFilesystemOverrides<T>(
  overrides: FilesystemOverrides,
  operation: () => Promise<T>,
): Promise<T> {
  const originalLstat = fs.promises.lstat;
  const originalOpen = fs.promises.open;
  const originalReadFile = fs.promises.readFile;
  const originalRealpath = fs.promises.realpath;
  if (overrides.lstat) Object.defineProperty(fs.promises, "lstat", { value: overrides.lstat });
  if (overrides.open) Object.defineProperty(fs.promises, "open", { value: overrides.open });
  if (overrides.readFile)
    Object.defineProperty(fs.promises, "readFile", { value: overrides.readFile });
  if (overrides.realpath)
    Object.defineProperty(fs.promises, "realpath", { value: overrides.realpath });
  syncBuiltinESMExports();
  try {
    return await operation();
  } finally {
    Object.defineProperty(fs.promises, "lstat", { value: originalLstat });
    Object.defineProperty(fs.promises, "open", { value: originalOpen });
    Object.defineProperty(fs.promises, "readFile", { value: originalReadFile });
    Object.defineProperty(fs.promises, "realpath", { value: originalRealpath });
    syncBuiltinESMExports();
  }
}

test("--strict promotes writing warnings without rewriting declarative configuration", async () => {
  const configText = '{"strict":false,"sourceRoots":["skills"]}\n';
  const projectDir = createProject({
    "remote-skills.json": configText,
    "skills/verbose-skill/SKILL.md": verboseSkill("\r"),
  });

  const normal = await runValidateCommand({ projectDir, args: [] });
  const strict = await runValidateCommand({ projectDir, args: ["--strict"] });

  assert.equal(normal.exitCode, 0);
  assert.equal(normal.warnings.length, 1);
  assert.equal(strict.exitCode, 1);
  assert.equal(strict.errors[0]?.severity, "error");
  assert.equal(readFileSync(path.join(projectDir, "remote-skills.json"), "utf8"), configText);
});

test("rejects unknown configuration before traversing skill inputs", async () => {
  const projectDir = createProject({
    "remote-skills.json": '{"outputDIr":"public"}\n',
    "skills/unsafe/SKILL.md": "not valid frontmatter",
  });

  await assert.rejects(runValidateCommand({ projectDir, args: [] }), (error) => {
    assert.ok(error instanceof ConfigValidationError);
    assert.deepEqual(error.issues, ["/outputDIr must NOT have additional properties"]);
    return true;
  });
});

test("loads defaults from JSON only and applies explicit overrides", async () => {
  const projectDir = createProject({
    "remote-skills.json": '{"format":"tar.gz","limits":{"files":12}}\n',
    "remote-skills.config.mjs": 'throw new Error("must not execute");\n',
  });

  const config = await loadPublisherConfig({
    projectDir,
    overrides: { format: "zip", strict: true },
  });

  assert.equal(config.format, "zip");
  assert.equal(config.strict, true);
  assert.equal(config.limits.files, 12);
  assert.equal(config.limits.fileBytes, 10_485_760);
});

test("loads defaults when an existing project has no configuration file", async () => {
  const projectDir = createProject({});

  const config = await loadPublisherConfig({ projectDir });

  assert.deepEqual(config.sourceRoots, ["skills"]);
  assert.equal(config.outDir, "dist");
});

test("rejects a missing project with a sanitized configuration error", async () => {
  const projectDir = createProject({});
  rmSync(projectDir, { recursive: true });

  await assert.rejects(loadPublisherConfig({ projectDir }), (error) => {
    assert.ok(error instanceof ConfigValidationError);
    assert.equal(error.code, "configuration_invalid");
    assert.equal(error.message.includes(projectDir), false);
    assert.deepEqual(error.issues, ["/project must be an accessible directory"]);
    return true;
  });
});

test("redacts project-directory resolution failures while loading configuration", async () => {
  const projectDir = createProject({});
  const originalRealpath = fs.promises.realpath;
  const canary = "CONFIG_PROJECT_REALPATH_CANARY";

  await withFilesystemOverrides(
    {
      realpath: async (target) => {
        if (target === projectDir) {
          throw Object.assign(new Error(`${canary}: ${projectDir}`), { code: "EACCES" });
        }
        return originalRealpath(target);
      },
    },
    async () => {
      await assert.rejects(loadPublisherConfig({ projectDir }), (error) => {
        assert.ok(error instanceof ConfigValidationError);
        assert.equal(error.message.includes(canary), false);
        assert.equal(error.message.includes(projectDir), false);
        assert.deepEqual(error.issues, ["/project must be an accessible directory"]);
        return true;
      });
    },
  );
});

test("redacts configuration read failures", async () => {
  const projectDir = createProject({
    "remote-skills.json": '{"sourceRoots":["skills"]}\n',
  });
  const configPath = path.join(realpathSync(projectDir), "remote-skills.json");
  const originalOpen = fs.promises.open;
  const canary = "CONFIG_READ_ABSOLUTE_PATH_CANARY";

  await withFilesystemOverrides(
    {
      open: async (target, flags, mode) => {
        const handle = await originalOpen(target, flags, mode);
        if (target === configPath) {
          Object.defineProperty(handle, "read", {
            value: async () => {
              throw Object.assign(new Error(`${canary}: ${configPath}`), { code: "EIO" });
            },
          });
        }
        return handle;
      },
    },
    async () => {
      await assert.rejects(loadPublisherConfig({ projectDir }), (error) => {
        assert.ok(error instanceof ConfigValidationError);
        assert.equal(error.code, "configuration_invalid");
        assert.equal(error.message.includes(canary), false);
        assert.equal(error.message.includes(configPath), false);
        assert.deepEqual(error.issues, ["/config could not be read safely"]);
        return true;
      });
    },
  );
});

test("rejects symlinked, hard-linked, and non-regular configuration files", async () => {
  const hardlinkProject = createProject({ "config-source.json": '{"strict":true}\n' });
  linkSync(
    path.join(hardlinkProject, "config-source.json"),
    path.join(hardlinkProject, "remote-skills.json"),
  );
  const specialProject = createProject({});
  mkdirSync(path.join(specialProject, "remote-skills.json"));
  const projects = [hardlinkProject, specialProject];
  if (process.platform !== "win32") {
    const symlinkProject = createProject({ "outside.json": '{"strict":true}\n' });
    symlinkSync("outside.json", path.join(symlinkProject, "remote-skills.json"), "file");
    projects.push(symlinkProject);
  }

  for (const projectDir of projects) {
    await assert.rejects(loadPublisherConfig({ projectDir }), (error) => {
      assert.ok(error instanceof ConfigValidationError);
      assert.deepEqual(error.issues, ["/config could not be read safely"]);
      return true;
    });
  }
});

test("rejects configuration input before allocating or parsing oversized bytes", async () => {
  const projectDir = createProject({
    "remote-skills.json": `${" ".repeat(65_536)}{}\n`,
  });

  await assert.rejects(loadPublisherConfig({ projectDir }), (error) => {
    assert.ok(error instanceof ConfigValidationError);
    assert.deepEqual(error.issues, ["/config exceeds the 65536-byte limit"]);
    return true;
  });
});

test("rejects an in-place configuration mutation during its descriptor read", async () => {
  const projectDir = createProject({
    "remote-skills.json": '{"sourceRoots":["skills"]}\n',
  });
  const configPath = path.join(realpathSync(projectDir), "remote-skills.json");
  const originalOpen = fs.promises.open;
  const originalReadFile = fs.promises.readFile;
  let mutated = false;

  await withFilesystemOverrides(
    {
      readFile: async (target) => {
        const bytes = await originalReadFile(target);
        if (target === configPath && !mutated) {
          writeFileSync(configPath, '{"sourceRoots":["other"]}\n');
          mutated = true;
        }
        return bytes;
      },
      open: async (target, flags, mode) => {
        const handle = await originalOpen(target, flags, mode);
        if (target !== configPath) return handle;
        const originalRead = handle.read.bind(handle);
        Object.defineProperty(handle, "read", {
          value: async (
            buffer: Uint8Array,
            offset = 0,
            length = buffer.byteLength,
            position: number | null = null,
          ) => {
            const result = await originalRead(buffer, offset, length, position);
            if (!mutated && result.bytesRead > 0) {
              writeFileSync(configPath, '{"sourceRoots":["other"]}\n');
              mutated = true;
            }
            return result;
          },
        });
        return handle;
      },
    },
    async () => {
      await assert.rejects(loadPublisherConfig({ projectDir }), (error) => {
        assert.ok(error instanceof ConfigValidationError);
        assert.deepEqual(error.issues, ["/config could not be read safely"]);
        return true;
      });
    },
  );
  assert.equal(mutated, true);
});

test("binds configuration loading and validation to one project generation", async () => {
  const projectDir = realpathSync(
    createProject({
      "remote-skills.json": '{"sourceRoots":["skills"]}\n',
      "skills/original-skill/SKILL.md": `---
name: original-skill
description: Original project generation.
---
# Original
`,
    }),
  );
  const replacementProject = realpathSync(
    createProject({
      "remote-skills.json": '{"sourceRoots":["skills"]}\n',
      "skills/replacement-skill/SKILL.md": `---
name: replacement-skill
description: Replacement project generation.
---
# Replacement
`,
    }),
  );
  const parkedProject = `${projectDir}-parked`;
  temporaryProjects.push(parkedProject);
  const configPath = path.join(projectDir, "remote-skills.json");
  const originalLstat = fs.promises.lstat;
  const originalReadFile = fs.promises.readFile;
  let configLstatCalls = 0;
  let swapped = false;
  const swapProject = () => {
    if (swapped) return;
    renameSync(projectDir, parkedProject);
    renameSync(replacementProject, projectDir);
    swapped = true;
  };

  let outcome: unknown;
  try {
    try {
      outcome = await withFilesystemOverrides(
        {
          readFile: async (target) => {
            const bytes = await originalReadFile(target);
            if (target === configPath) swapProject();
            return bytes;
          },
          lstat: async (target) => {
            const stats = await originalLstat(target, { bigint: true });
            if (target === configPath) {
              configLstatCalls += 1;
              if (configLstatCalls === 2) queueMicrotask(swapProject);
            }
            return stats;
          },
        },
        () => runValidateCommand({ projectDir, args: [] }),
      );
    } catch (error) {
      outcome = error;
    }
  } finally {
    if (swapped) {
      renameSync(projectDir, replacementProject);
      renameSync(parkedProject, projectDir);
    }
  }

  assert.equal(swapped, true);
  assert.ok(outcome instanceof ConfigValidationError);
  assert.equal(outcome.code, "configuration_invalid");
  assert.equal(Object.hasOwn(outcome, "skills"), false);
  assert.deepEqual(outcome.issues, ["/config could not be read safely"]);
});

test("rejects absolute and escaping project paths in configuration", async () => {
  const absoluteProject = createProject({
    "remote-skills.json": '{"sourceRoots":["/tmp/skills"]}\n',
  });
  const escapingProject = createProject({
    "remote-skills.json": '{"outDir":"../published"}\n',
  });

  await assert.rejects(loadPublisherConfig({ projectDir: absoluteProject }), {
    code: "configuration_invalid",
  });
  await assert.rejects(loadPublisherConfig({ projectDir: escapingProject }), {
    code: "configuration_invalid",
  });
});

test("redacts credential-bearing paths from overrides and file configuration", async () => {
  const canary = "CLI_CONFIG_PATH_SECRET_CANARY";
  const credentialPath = `https://user:${canary}@example.test/skills?token=${canary}#${canary}`;
  const overrideProject = createProject({});
  const fileProject = createProject({
    "remote-skills.json": `${JSON.stringify({ outDir: credentialPath })}\n`,
  });

  const operations: Array<() => Promise<unknown>> = [
    () =>
      loadPublisherConfig({
        projectDir: overrideProject,
        overrides: { sourceRoots: [credentialPath] },
      }),
    () => loadPublisherConfig({ projectDir: fileProject }),
  ];
  for (const operation of operations) {
    await assert.rejects(operation(), (error) => {
      assert.ok(error instanceof ConfigValidationError);
      assertValueRedacted(error, canary);
      assert.equal(error.code, "configuration_invalid");
      assert.ok(error.issues.every((issue) => issue.includes("[invalid-path]")));
      return true;
    });
  }
});

test("rejects Windows drive-relative source and output paths", async () => {
  const sourceProject = createProject({
    "remote-skills.json": '{"sourceRoots":["C:skills"]}\n',
  });
  const outputProject = createProject({
    "remote-skills.json": '{"outDir":"D:published"}\n',
  });

  await assert.rejects(loadPublisherConfig({ projectDir: sourceProject }), {
    code: "configuration_invalid",
  });
  await assert.rejects(loadPublisherConfig({ projectDir: outputProject }), {
    code: "configuration_invalid",
  });
});

test("rejects non-canonical source and output path spellings consistently", async () => {
  const pathCases: Array<readonly ["sourceRoots" | "outDir", string]> = [
    ["sourceRoots", "skills\\nested"],
    ["sourceRoots", "skills/."],
    ["sourceRoots", "skills//nested"],
    ["sourceRoots", "skills/"],
    ["outDir", "dist\\nested"],
    ["outDir", "dist/."],
    ["outDir", "dist//nested"],
    ["outDir", "dist/"],
  ];
  for (const [field, candidate] of pathCases) {
    const value = field === "sourceRoots" ? [candidate] : candidate;
    const projectDir = createProject({
      "remote-skills.json": `${JSON.stringify({ [field]: value })}\n`,
    });

    await assert.rejects(loadPublisherConfig({ projectDir }), {
      code: "configuration_invalid",
    });
  }
});

test("rejects output directories that overlap source roots", async () => {
  for (const config of [
    { sourceRoots: ["skills"], outDir: "skills/published" },
    { sourceRoots: ["published/skills"], outDir: "published" },
    { sourceRoots: ["skills"], outDir: "Skills/published" },
  ]) {
    const projectDir = createProject({
      "remote-skills.json": `${JSON.stringify(config)}\n`,
      "skills/published/index.json": '{"prior":"output"}\n',
    });

    await assert.rejects(loadPublisherConfig({ projectDir }), (error) => {
      assert.ok(error instanceof ConfigValidationError);
      assert.deepEqual(error.issues, ["/outDir must not overlap sourceRoots"]);
      return true;
    });
  }
});

test("accepts a disjoint output directory", async () => {
  const projectDir = createProject({
    "remote-skills.json": '{"sourceRoots":["skills"],"outDir":"published"}\n',
  });

  const config = await loadPublisherConfig({ projectDir });

  assert.deepEqual(config.sourceRoots, ["skills"]);
  assert.equal(config.outDir, "published");
});

test("rejects non-scalar configured paths before project inspection", async () => {
  const missingProject = createProject({});
  rmSync(missingProject, { recursive: true });

  for (const overrides of [{ sourceRoots: ["skills/\ud800"] }, { outDir: "dist/\udfff" }]) {
    await assert.rejects(
      loadPublisherConfig({ projectDir: missingProject, overrides }),
      (error) => {
        assert.ok(error instanceof ConfigValidationError);
        assert.deepEqual(error.issues, ["/path must remain inside the project: [invalid-path]"]);
        return true;
      },
    );
  }

  const projectDir = createProject({});
  const config = await loadPublisherConfig({
    projectDir,
    overrides: { sourceRoots: ["skills/�"], outDir: "dist/�" },
  });
  assert.deepEqual(config.sourceRoots, ["skills/�"]);
  assert.equal(config.outDir, "dist/�");
});

test("validate argument parsing accepts only the owned --strict option", () => {
  assert.deepEqual(parseValidateArgs([]), {});
  assert.deepEqual(parseValidateArgs(["--strict"]), { strict: true });
  assert.throws(() => parseValidateArgs(["--archive"]), {
    code: "configuration_invalid",
  });
});

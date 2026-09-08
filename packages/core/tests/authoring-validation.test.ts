import assert from "node:assert/strict";
import fs, {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import * as authoringPaths from "../src/authoring/paths.ts";
import {
  closeAuthoringProjectSnapshot,
  createAuthoringProjectSnapshot,
  DEFAULT_EXCLUSIONS,
  readAuthoringProjectFile,
  validateAuthoringProject,
} from "../src/authoring/validate-project.ts";
import { posixMutationProbe } from "./platform.ts";

const publisherFixtureRoot = fileURLToPath(
  new URL("../../../tests/protocol/fixtures/publisher/source", import.meta.url),
);
const temporaryProjects: string[] = [];

afterEach(() => {
  for (const projectDir of temporaryProjects.splice(0)) {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

function createProject(files: Readonly<Record<string, string | Uint8Array>>) {
  const projectDir = realpathSync.native(
    mkdtempSync(path.join(tmpdir(), "remote-skills-authoring-")),
  );
  temporaryProjects.push(projectDir);
  for (const [relativePath, contents] of Object.entries(files)) {
    const absolutePath = path.join(projectDir, relativePath);
    mkdirSync(path.dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, contents);
  }
  return projectDir;
}

test("temporary project paths use the production canonical spelling", async () => {
  const projectDir = createProject({});

  assert.equal(projectDir, await fs.promises.realpath(projectDir));
});

function skillMarkdown(name: string, body = "# Instructions\n") {
  return `---
name: ${name}
description: Validate ${name} behavior for authoring tests.
---
${body}`;
}

const direntTypeMethods = new Set([
  "isBlockDevice",
  "isCharacterDevice",
  "isDirectory",
  "isFIFO",
  "isFile",
  "isSocket",
  "isSymbolicLink",
]);

function withUnknownDirentType(entry: fs.Dirent) {
  return new Proxy(entry, {
    get(dirent, property) {
      if (typeof property === "string" && direntTypeMethods.has(property)) return () => false;
      const value = Reflect.get(dirent, property, dirent);
      return typeof value === "function" ? value.bind(dirent) : value;
    },
  });
}

function withUnknownDirectoryEntries(
  directory: fs.Dir,
  names: Set<string>,
  onUnknown: (name: string) => void = () => {},
) {
  return new Proxy(directory, {
    get(dir, property) {
      if (property === "read") {
        return async () => {
          const entry = await dir.read();
          if (entry === null || !names.has(entry.name)) return entry;
          onUnknown(entry.name);
          return withUnknownDirentType(entry);
        };
      }
      const value = Reflect.get(dir, property, dir);
      return typeof value === "function" ? value.bind(dir) : value;
    },
  });
}

function withFilesystemType<Stats extends fs.Stats | fs.BigIntStats>(
  stats: Stats,
  type: string,
): Stats {
  return new Proxy(stats, {
    get(value, property) {
      if (typeof property === "string" && direntTypeMethods.has(property))
        return () => property === type;
      const member = Reflect.get(value, property, value);
      return typeof member === "function" ? member.bind(value) : member;
    },
  });
}

function createProjectWithLexicallyEarlierResource() {
  const markdown = skillMarkdown("ordered-limits");
  const readme = "README sorts before SKILL.md\n";
  return {
    markdown,
    readme,
    projectDir: createProject({
      "skills/ordered-limits/README.md": readme,
      "skills/ordered-limits/SKILL.md": markdown,
    }),
  };
}

type AuthoringSnapshot = Exclude<
  Awaited<ReturnType<typeof createAuthoringProjectSnapshot>>,
  null | undefined
>;

async function captureValidation(projectDir: string, snapshot?: AuthoringSnapshot) {
  try {
    const options = snapshot === undefined ? { projectDir } : { projectDir, snapshot };
    return { result: await validateAuthoringProject(options) };
  } catch (error) {
    return { error };
  }
}

type AuthoringResult = Awaited<ReturnType<typeof validateAuthoringProject>>;

function firstSkill(result: AuthoringResult) {
  const skill = result.skills[0];
  assert.ok(skill, "expected validation to retain one skill");
  return skill;
}

function spyOnSnapshotClose(snapshot: AuthoringSnapshot) {
  let closeCalls = 0;
  for (const handle of [...snapshot.directoryHandles, ...snapshot.fileHandles]) {
    const originalClose = handle.close.bind(handle);
    handle.close = async () => {
      closeCalls += 1;
      return originalClose();
    };
  }
  return {
    expectedCalls: snapshot.directoryHandles.length + snapshot.fileHandles.length,
    closeCalls: () => closeCalls,
  };
}

function assertValueRedacted(value: unknown, canary: string) {
  if (typeof value === "string") {
    assert.equal(value.includes(canary), false);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertValueRedacted(item, canary);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      assertValueRedacted(key, canary);
      assertValueRedacted(item, canary);
    }
  }
}

type FilesystemOverrides = {
  lstat?: (target: fs.PathLike, options?: fs.StatOptions) => Promise<fs.Stats | fs.BigIntStats>;
  open?: (
    target: fs.PathLike,
    flags: string | number,
    mode?: fs.Mode,
  ) => Promise<fs.promises.FileHandle>;
  opendir?: (target: fs.PathLike, options?: fs.OpenDirOptions) => Promise<fs.Dir>;
  realpath?: (target: fs.PathLike, options?: fs.EncodingOption) => Promise<string | Buffer>;
};

async function withFilesystemOverrides<Result>(
  overrides: FilesystemOverrides,
  operation: () => Result | Promise<Result>,
): Promise<Result> {
  const originalLstat = fs.promises.lstat;
  const originalOpen = fs.promises.open;
  const originalOpendir = fs.promises.opendir;
  const originalRealpath = fs.promises.realpath;
  if (overrides.lstat) Reflect.set(fs.promises, "lstat", overrides.lstat);
  if (overrides.open) Reflect.set(fs.promises, "open", overrides.open);
  if (overrides.opendir) Reflect.set(fs.promises, "opendir", overrides.opendir);
  if (overrides.realpath) Reflect.set(fs.promises, "realpath", overrides.realpath);
  syncBuiltinESMExports();
  try {
    return await operation();
  } finally {
    Reflect.set(fs.promises, "lstat", originalLstat);
    Reflect.set(fs.promises, "open", originalOpen);
    Reflect.set(fs.promises, "opendir", originalOpendir);
    Reflect.set(fs.promises, "realpath", originalRealpath);
    syncBuiltinESMExports();
  }
}

interface HandleState {
  closed: number;
  opened: number;
}

async function withTrackedFilesystemHandles<Result>(
  operation: (state: HandleState) => Result | Promise<Result>,
): Promise<Result> {
  const originalOpen = fs.promises.open;
  const originalOpendir = fs.promises.opendir;
  const state = { opened: 0, closed: 0 };
  const track = <Handle extends fs.Dir | fs.promises.FileHandle>(handle: Handle): Handle => {
    state.opened += 1;
    const originalClose = handle.close.bind(handle);
    handle.close = async () => {
      state.closed += 1;
      await originalClose();
    };
    return handle;
  };
  return withFilesystemOverrides(
    {
      open: async (target, flags, mode) => track(await originalOpen(target, flags, mode)),
      opendir: async (target, options) => track(await originalOpendir(target, options)),
    },
    () => operation(state),
  );
}

interface ResourceIoProbeOptions {
  config?: Parameters<typeof validateAuthoringProject>[0]["config"];
  projectDir: string;
  relativePath: string;
  size: number;
}

async function validateWithResourceIoProbe({
  projectDir,
  relativePath,
  size,
  config,
}: ResourceIoProbeOptions) {
  const resourcePath = path.join(projectDir, relativePath);
  const originalOpen = fs.promises.open;
  const originalAllocUnsafe = Buffer.allocUnsafe;
  const resourceIo = { allocations: 0, opens: 0, reads: 0 };

  const result = await withFilesystemOverrides(
    {
      open: async (target, flags, mode) => {
        if (target === resourcePath) resourceIo.opens += 1;
        const handle = await originalOpen(target, flags, mode);
        if (target !== resourcePath) return handle;
        const originalRead = handle.read.bind(handle);
        handle.read = async (...readArgs: Parameters<typeof originalRead>) => {
          resourceIo.reads += 1;
          return originalRead(...readArgs);
        };
        return handle;
      },
    },
    async () => {
      Buffer.allocUnsafe = (allocationSize: number) => {
        if (allocationSize === size) resourceIo.allocations += 1;
        return originalAllocUnsafe(allocationSize);
      };
      try {
        return await validateAuthoringProject(
          config === undefined ? { projectDir } : { projectDir, config },
        );
      } finally {
        Buffer.allocUnsafe = originalAllocUnsafe;
      }
    },
  );

  return { resourceIo, result };
}

test("discovers and validates the checked-in canonical publisher source tree", async () => {
  const result = await validateAuthoringProject({ projectDir: publisherFixtureRoot });

  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(
    result.skills.map(({ name, description, rootPath, files }) => ({
      name,
      description,
      rootPath,
      files: files.map(({ path: filePath }) => filePath),
    })),
    [
      {
        name: "code-review",
        description: "Review changes with a concise security checklist.",
        rootPath: "skills/code-review",
        files: ["SKILL.md"],
      },
      {
        name: "release-notes",
        description: "Draft release notes from verified project inputs.",
        rootPath: "skills/release-notes",
        files: ["SKILL.md", "assets/template.md", "references/security.md"],
      },
    ],
  );
});

test("applies non-overridable safety exclusions before additive .skillignore patterns", async () => {
  const excludedCanary = "EXCLUDED_SECRET_CANARY";
  const exclusionExamples = new Map([
    [".git", ".git/config"],
    [".hg", ".hg/store"],
    [".svn", ".svn/entries"],
    ["node_modules/", "node_modules/package/index.js"],
    ["bower_components/", "bower_components/package/index.js"],
    [".pnpm-store/", ".pnpm-store/v3/files/data"],
    [".yarn/", ".yarn/cache/package.zip"],
    [".cache/", ".cache/data"],
    [".turbo/", ".turbo/cache/data"],
    ["dist/", "dist/output.js"],
    ["build/", "build/output.js"],
    ["coverage/", "coverage/index.html"],
    [".DS_Store", ".DS_Store"],
    ["Thumbs.db", "Thumbs.db"],
    [".env", ".env"],
    [".env*", ".env.local"],
    [".git-credentials", ".git-credentials"],
    [".npmrc", ".npmrc"],
    [".pypirc", ".pypirc"],
    [".netrc", ".netrc"],
    ["_netrc", "_netrc"],
    [".secrets", ".secrets"],
    [".secrets.*", ".secrets.prod"],
    ["credentials", "credentials"],
    ["credentials.json", "credentials.json"],
    ["secrets.json", "secrets.json"],
    ["service-account*.json", "service-account-prod.json"],
    ["*.pem", "secret.pem"],
    ["*.key", "secret.key"],
    ["*.p12", "secret.p12"],
    ["*.pfx", "secret.pfx"],
    ["id_rsa", "id_rsa"],
    ["id_dsa", "id_dsa"],
    ["id_ecdsa", "id_ecdsa"],
    ["id_ed25519", "id_ed25519"],
    [".venv/", ".venv/lib/credential.py"],
    ["venv/", "venv/lib/credential.py"],
    ["__pycache__/", "__pycache__/credential.pyc"],
    [".pytest_cache/", ".pytest_cache/credential"],
    [".mypy_cache/", ".mypy_cache/credential"],
    [".ruff_cache/", ".ruff_cache/credential"],
    [".tox/", ".tox/state"],
    [".nox/", ".nox/state"],
    [".skillignore", ".skillignore"],
  ]);
  assert.ok(
    Array.isArray(DEFAULT_EXCLUSIONS),
    "the production exclusion policy must be inspectable",
  );
  assert.deepEqual(
    [...exclusionExamples.keys()].sort(),
    [...DEFAULT_EXCLUSIONS].sort(),
    "every production exclusion must have a seeded I/O example",
  );
  const excludedRelativeFiles = [
    ...new Set([
      ...[...exclusionExamples.values()].filter((relativePath) => relativePath !== ".skillignore"),
      "ignored.txt",
      "ignored-dir/nested.txt",
    ]),
  ];
  const projectDir = createProject({
    "skills/safe-skill/SKILL.md": skillMarkdown("safe-skill"),
    "skills/safe-skill/.skillignore":
      "SKILL.md\nignored.txt\nignored-dir/\n!secret.pem\n!.git-credentials\n!_netrc\n!.venv/**\n!venv/**\n!__pycache__/**\n!.pytest_cache/**\n",
    "skills/safe-skill/keep.txt": "keep",
    ...Object.fromEntries(
      excludedRelativeFiles.map((relativePath) => [
        `skills/safe-skill/${relativePath}`,
        excludedCanary,
      ]),
    ),
  });
  const originalLstat = fs.promises.lstat;
  const originalOpen = fs.promises.open;
  const originalOpendir = fs.promises.opendir;
  const originalRealpath = fs.promises.realpath;
  const skillRoot = path.join(projectDir, "skills/safe-skill");
  const policyPath = path.join(skillRoot, ".skillignore");
  const excludedFiles = new Set(
    excludedRelativeFiles.map((relativePath) => path.join(skillRoot, relativePath)),
  );
  const excludedDirectories = new Set<string>();
  for (const relativePath of excludedRelativeFiles) {
    let directory = path.posix.dirname(relativePath);
    while (directory !== ".") {
      excludedDirectories.add(path.join(skillRoot, directory));
      directory = path.posix.dirname(directory);
    }
  }
  const forbiddenIo: Array<{ operation: string; target: string }> = [];
  const observedIo = { directoryReads: 0, fileReads: 0, policyOpens: 0, policyReads: 0 };

  const result = await withFilesystemOverrides(
    {
      lstat: async (target, options) => {
        if (
          typeof target === "string" &&
          (excludedFiles.has(target) || excludedDirectories.has(target))
        )
          forbiddenIo.push({ operation: "lstat", target });
        return originalLstat(target, options);
      },
      open: async (target, flags, mode) => {
        if (target === policyPath) observedIo.policyOpens += 1;
        if (typeof target === "string" && excludedFiles.has(target))
          forbiddenIo.push({ operation: "open", target });
        const handle = await originalOpen(target, flags, mode);
        const originalRead = handle.read.bind(handle);
        Reflect.set(handle, "read", async (...readArgs: unknown[]) => {
          if (target === policyPath) observedIo.policyReads += 1;
          if (typeof target === "string" && excludedFiles.has(target))
            forbiddenIo.push({ operation: "read", target });
          else observedIo.fileReads += 1;
          return Reflect.apply(originalRead, handle, readArgs);
        });
        return handle;
      },
      opendir: async (target, options) => {
        if (typeof target === "string" && excludedDirectories.has(target))
          forbiddenIo.push({ operation: "opendir", target });
        const directory = await originalOpendir(target, options);
        return new Proxy(directory, {
          get(dir, property) {
            if (property === "read") {
              return async () => {
                if (typeof target === "string" && excludedDirectories.has(target))
                  forbiddenIo.push({ operation: "dir.read", target });
                else observedIo.directoryReads += 1;
                return dir.read();
              };
            }
            const value = Reflect.get(dir, property, dir);
            return typeof value === "function" ? value.bind(dir) : value;
          },
        });
      },
      realpath: async (target, options) => {
        if (
          typeof target === "string" &&
          (excludedFiles.has(target) || excludedDirectories.has(target))
        )
          forbiddenIo.push({ operation: "realpath", target });
        return originalRealpath(target, options);
      },
    },
    () => validateAuthoringProject({ projectDir }),
  );

  assert.ok(observedIo.fileReads > 0, "file-read instrumentation must observe validation reads");
  assert.ok(
    observedIo.directoryReads > 0,
    "directory-read instrumentation must observe validation enumeration",
  );
  assert.equal(observedIo.policyOpens, 1);
  assert.ok(observedIo.policyReads > 0, "the .skillignore policy input must be read exactly here");
  assert.equal(excludedFiles.size, excludedRelativeFiles.length);
  assert.ok(excludedDirectories.size > 0);
  assert.deepEqual(forbiddenIo, []);
  assert.equal(result.valid, true);
  assert.deepEqual(
    firstSkill(result).files.map(({ path: filePath }) => filePath),
    ["SKILL.md", "keep.txt"],
  );
  assert.equal(JSON.stringify(result).includes(excludedCanary), false);
});

test("recovers a DT_UNKNOWN skill candidate at the immediate source root", async () => {
  const projectDir = createProject({
    "skills/unknown-skill/SKILL.md": skillMarkdown("unknown-skill"),
  });
  const sourceRoot = path.join(projectDir, "skills");
  const originalOpendir = fs.promises.opendir;
  let injected = false;

  const result = await withFilesystemOverrides(
    {
      opendir: async (target: fs.PathLike, ...args) => {
        const directory = await originalOpendir(target, ...args);
        return target === sourceRoot
          ? withUnknownDirectoryEntries(directory, new Set(["unknown-skill"]), () => {
              injected = true;
            })
          : directory;
      },
    },
    () => validateAuthoringProject({ projectDir }),
  );

  assert.equal(injected, true);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.deepEqual(
    result.skills.map(({ name }) => name),
    ["unknown-skill"],
  );
});

test("classifies DT_UNKNOWN exclusions and included entries before descendant I/O", async () => {
  const excludedCanary = "DT_UNKNOWN_EXCLUDED_CANARY";
  const projectDir = createProject({
    "skills/unknown-entries/SKILL.md": skillMarkdown("unknown-entries"),
    "skills/unknown-entries/node_modules/package/secret.js": excludedCanary,
    "skills/unknown-entries/references/guide.md": "# Guide\n",
    "skills/unknown-entries/resource.txt": "resource",
  });
  const skillRoot = path.join(projectDir, "skills/unknown-entries");
  const excludedRoot = path.join(skillRoot, "node_modules");
  const referencesRoot = path.join(skillRoot, "references");
  const resourcePath = path.join(skillRoot, "resource.txt");
  const guidePath = path.join(referencesRoot, "guide.md");
  const unknownEntries = new Map([
    [skillRoot, new Set(["node_modules", "references", "resource.txt"])],
    [referencesRoot, new Set(["guide.md"])],
  ]);
  const unknownPaths = new Set([excludedRoot, referencesRoot, resourcePath, guidePath]);
  const classifiedPaths = new Set<string>();
  const injectedPaths = new Set<string>();
  const includedFileOpens = new Set<string>();
  const includedFileReads = new Set<string>();
  const forbiddenIo: Array<{ operation: string; target: string }> = [];
  const originalLstat = fs.promises.lstat;
  const originalOpen = fs.promises.open;
  const originalOpendir = fs.promises.opendir;
  const originalRealpath = fs.promises.realpath;
  const insideExcludedRoot = (target: fs.PathLike) =>
    typeof target === "string" &&
    (target === excludedRoot || target.startsWith(`${excludedRoot}${path.sep}`));

  const result = await withFilesystemOverrides(
    {
      lstat: async (target, options) => {
        if (typeof target === "string" && unknownPaths.has(target)) classifiedPaths.add(target);
        if (typeof target === "string" && insideExcludedRoot(target) && target !== excludedRoot)
          forbiddenIo.push({ operation: "lstat", target });
        return originalLstat(target, options);
      },
      open: async (target, flags, mode) => {
        if (typeof target === "string" && insideExcludedRoot(target))
          forbiddenIo.push({ operation: "open", target });
        if (typeof target === "string" && (target === resourcePath || target === guidePath))
          includedFileOpens.add(target);
        const handle = await originalOpen(target, flags, mode);
        const originalRead = handle.read.bind(handle);
        Reflect.set(handle, "read", async (...readArgs: unknown[]) => {
          if (typeof target === "string" && insideExcludedRoot(target))
            forbiddenIo.push({ operation: "read", target });
          if (typeof target === "string" && (target === resourcePath || target === guidePath))
            includedFileReads.add(target);
          return Reflect.apply(originalRead, handle, readArgs);
        });
        return handle;
      },
      opendir: async (target, options) => {
        if (typeof target === "string" && insideExcludedRoot(target))
          forbiddenIo.push({ operation: "opendir", target });
        const directory = await originalOpendir(target, options);
        const names = typeof target === "string" ? unknownEntries.get(target) : undefined;
        return names
          ? withUnknownDirectoryEntries(directory, names, (name: string) => {
              if (typeof target === "string") injectedPaths.add(path.join(target, name));
            })
          : directory;
      },
      realpath: async (target, options) => {
        if (typeof target === "string" && insideExcludedRoot(target))
          forbiddenIo.push({ operation: "realpath", target });
        return originalRealpath(target, options);
      },
    },
    () => validateAuthoringProject({ projectDir }),
  );

  assert.deepEqual(injectedPaths, unknownPaths);
  assert.deepEqual(classifiedPaths, unknownPaths);
  assert.deepEqual(includedFileOpens, new Set([guidePath, resourcePath]));
  assert.deepEqual(includedFileReads, new Set([guidePath, resourcePath]));
  assert.deepEqual(forbiddenIo, []);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.deepEqual(
    firstSkill(result).files.map(({ path: filePath }) => filePath),
    ["SKILL.md", "references/guide.md", "resource.txt"],
  );
  assert.equal(JSON.stringify(result).includes(excludedCanary), false);
});

test("DT_UNKNOWN symlinks and special files remain fail-closed", async () => {
  const projectDir = createProject({
    "skills/unknown-unsafe/SKILL.md": skillMarkdown("unknown-unsafe"),
    "skills/unknown-unsafe/linked-entry": "placeholder",
    "skills/unknown-unsafe/special-entry": "placeholder",
  });
  const skillRoot = path.join(projectDir, "skills/unknown-unsafe");
  const linkedPath = path.join(skillRoot, "linked-entry");
  const specialPath = path.join(skillRoot, "special-entry");
  const originalLstat = fs.promises.lstat;
  const originalOpendir = fs.promises.opendir;

  const result = await withFilesystemOverrides(
    {
      lstat: async (target: fs.PathLike, ...args) => {
        const stats = await originalLstat(target, ...args);
        if (target === linkedPath) return withFilesystemType(stats, "isSymbolicLink");
        if (target === specialPath) return withFilesystemType(stats, "special");
        return stats;
      },
      opendir: async (target: fs.PathLike, ...args) => {
        const directory = await originalOpendir(target, ...args);
        return target === skillRoot
          ? withUnknownDirectoryEntries(directory, new Set(["linked-entry", "special-entry"]))
          : directory;
      },
    },
    () => validateAuthoringProject({ projectDir }),
  );

  assert.equal(result.valid, false);
  assert.deepEqual(result.skills, []);
  assert.deepEqual(
    result.errors.map(({ code, context }) => ({ code, path: context.path })),
    [
      { code: "archive_unsafe", path: "skills/unknown-unsafe/linked-entry" },
      { code: "archive_unsafe", path: "skills/unknown-unsafe/special-entry" },
    ],
  );
});

test("excludes repository metadata represented by a regular .git pointer file", async () => {
  const projectDir = createProject({
    "skills/worktree-skill/SKILL.md": skillMarkdown("worktree-skill"),
    "skills/worktree-skill/.git": "gitdir: ../../.git/worktrees/worktree-skill\n",
  });

  const result = await validateAuthoringProject({ projectDir });

  assert.equal(result.valid, true);
  assert.deepEqual(
    firstSkill(result).files.map(({ path: filePath }) => filePath),
    ["SKILL.md"],
  );
});

test("rejects an unreadable .skillignore instead of treating it as absent", async () => {
  const projectDir = createProject({
    "skills/unsafe-ignore/SKILL.md": skillMarkdown("unsafe-ignore"),
    "skills/unsafe-ignore/.skillignore": "ignored.txt\n",
    "skills/unsafe-ignore/ignored.txt": "ignored",
  });
  const ignorePath = path.join(projectDir, "skills/unsafe-ignore/.skillignore");
  const originalOpen = fs.promises.open;

  const outcome = await withFilesystemOverrides(
    {
      open: async (target: fs.PathLike, ...args) => {
        if (target === ignorePath)
          throw Object.assign(new Error("injected unreadable ignore"), { code: "EACCES" });
        return originalOpen(target, ...args);
      },
    },
    () => captureValidation(projectDir),
  );

  assert.equal("error" in outcome, false);
  if (!("result" in outcome)) return;
  assert.equal(outcome.result.valid, false);
  assert.deepEqual(outcome.result.skills, []);
  assert.deepEqual(
    outcome.result.errors.map(({ code, context }) => ({ code, context })),
    [
      {
        code: "archive_unsafe",
        context: {
          path: "skills/unsafe-ignore/.skillignore",
          skill_name: "unsafe-ignore",
        },
      },
    ],
  );
});

test("invalid UTF-8 in .skillignore invalidates and discards the complete skill snapshot", async () => {
  const capturedCanary = "INVALID_IGNORE_CAPTURED_FILE_CANARY";
  const projectDir = createProject({
    "skills/invalid-ignore/SKILL.md": skillMarkdown("invalid-ignore"),
    "skills/invalid-ignore/.skillignore": Buffer.from([0xff, 0xfe]),
    "skills/invalid-ignore/captured.txt": capturedCanary,
  });
  const capturedPath = path.join(projectDir, "skills/invalid-ignore/captured.txt");
  const originalOpen = fs.promises.open;
  let capturedFileOpened = false;

  const result = await withFilesystemOverrides(
    {
      open: async (target: fs.PathLike, ...args) => {
        if (target === capturedPath) capturedFileOpened = true;
        return originalOpen(target, ...args);
      },
    },
    () => validateAuthoringProject({ projectDir }),
  );

  assert.equal(capturedFileOpened, false);
  assert.equal(result.valid, false);
  assert.deepEqual(result.skills, []);
  assert.deepEqual(
    result.errors.map(({ code, context }) => ({ code, context })),
    [
      {
        code: "catalog_invalid",
        context: {
          field: ".skillignore",
          path: "skills/invalid-ignore/.skillignore",
          skill_name: "invalid-ignore",
        },
      },
    ],
  );
  assert.equal(JSON.stringify(result).includes(capturedCanary), false);
});

test("oversized .skillignore invalidates and discards the complete skill snapshot", async () => {
  const capturedCanary = "OVERSIZED_IGNORE_CAPTURED_FILE_CANARY";
  const markdown = skillMarkdown("oversized-ignore");
  const projectDir = createProject({
    "skills/oversized-ignore/SKILL.md": markdown,
    "skills/oversized-ignore/.skillignore": "x".repeat(Buffer.byteLength(markdown) + 1),
    "skills/oversized-ignore/captured.txt": capturedCanary,
  });
  const capturedPath = path.join(projectDir, "skills/oversized-ignore/captured.txt");
  const originalOpen = fs.promises.open;
  let capturedFileOpened = false;

  const result = await withFilesystemOverrides(
    {
      open: async (target: fs.PathLike, ...args) => {
        if (target === capturedPath) capturedFileOpened = true;
        return originalOpen(target, ...args);
      },
    },
    () =>
      validateAuthoringProject({
        projectDir,
        config: { limits: { fileBytes: Buffer.byteLength(markdown) } },
      }),
  );

  assert.equal(capturedFileOpened, false);
  assert.equal(result.valid, false);
  assert.deepEqual(result.skills, []);
  assert.deepEqual(
    result.errors.map(({ code, context }) => ({ code, context })),
    [
      {
        code: "limit_exceeded",
        context: {
          limit: "fileBytes",
          path: "skills/oversized-ignore/.skillignore",
          skill_name: "oversized-ignore",
        },
      },
    ],
  );
  assert.equal(JSON.stringify(result).includes(capturedCanary), false);
});

test("applies .skillignore to normalized portable path identities", async () => {
  for (const [patternName, fileName] of [
    ["é.md", "e\u0301.md"],
    ["e\u0301.md", "é.md"],
  ]) {
    const relativeResource = `references/${fileName}`;
    const projectDir = createProject({
      "skills/normalized-ignore/SKILL.md": skillMarkdown("normalized-ignore"),
      "skills/normalized-ignore/.skillignore": `references/${patternName}\n`,
      [`skills/normalized-ignore/${relativeResource}`]: "IGNORED_SECRET_CANARY",
    });
    const resourcePath = path.join(projectDir, "skills/normalized-ignore", relativeResource);
    const originalOpen = fs.promises.open;
    let ignoredResourceOpened = false;

    const result = await withFilesystemOverrides(
      {
        open: async (target: fs.PathLike, ...args) => {
          if (target === resourcePath) ignoredResourceOpened = true;
          return originalOpen(target, ...args);
        },
      },
      () => validateAuthoringProject({ projectDir }),
    );

    assert.equal(ignoredResourceOpened, false);
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(
      result.skills[0]?.files.map(({ path: filePath }) => filePath),
      ["SKILL.md"],
    );
  }
});

test("detects portable path collisions before applying .skillignore", async () => {
  const firstName = "STRASSE.md";
  const secondName = "Straße.md";
  const projectDir = createProject({
    "skills/ignored-collision/SKILL.md": skillMarkdown("ignored-collision"),
    "skills/ignored-collision/.skillignore": `${firstName}\n${secondName}\n`,
    "skills/ignored-collision/first.placeholder": "FIRST_SECRET_CANARY",
    "skills/ignored-collision/second.placeholder": "SECOND_SECRET_CANARY",
  });
  const originalOpen = fs.promises.open;
  const originalOpendir = fs.promises.opendir;
  const skillRoot = path.join(projectDir, "skills/ignored-collision");
  const ignoredResourcePaths = new Set([
    path.join(projectDir, "skills/ignored-collision", firstName),
    path.join(projectDir, "skills/ignored-collision", secondName),
  ]);
  let ignoredResourceOpened = false;

  const result = await withFilesystemOverrides(
    {
      open: async (target: fs.PathLike, ...args) => {
        if (typeof target === "string" && ignoredResourcePaths.has(target))
          ignoredResourceOpened = true;
        return originalOpen(target, ...args);
      },
      opendir: async (target: fs.PathLike, ...args) => {
        const directory = await originalOpendir(target, ...args);
        if (target !== skillRoot) return directory;
        return new Proxy(directory, {
          get(dir, property) {
            if (property === "read") {
              return async () => {
                const entry = await dir.read();
                if (entry === null) return null;
                const syntheticName =
                  entry.name === "first.placeholder"
                    ? firstName
                    : entry.name === "second.placeholder"
                      ? secondName
                      : undefined;
                if (syntheticName === undefined) return entry;
                return new Proxy(entry, {
                  get(dirent, direntProperty) {
                    if (direntProperty === "name") return syntheticName;
                    const value = Reflect.get(dirent, direntProperty, dirent);
                    return typeof value === "function" ? value.bind(dirent) : value;
                  },
                });
              };
            }
            const value = Reflect.get(dir, property, dir);
            return typeof value === "function" ? value.bind(dir) : value;
          },
        });
      },
    },
    () => validateAuthoringProject({ projectDir }),
  );

  assert.equal(ignoredResourceOpened, false);
  assert.equal(result.valid, false);
  assert.deepEqual(result.skills, []);
  assert.deepEqual(
    result.errors.map(({ code, context }) => ({ code, context })),
    [
      {
        code: "archive_unsafe",
        context: { path: secondName, skill_name: "ignored-collision" },
      },
    ],
  );
  assert.equal(JSON.stringify(result).includes("SECRET_CANARY"), false);
});

test("sanitizes directory enumeration failures and discards the skill snapshot", async () => {
  const projectDir = createProject({
    "skills/unreadable-directory/SKILL.md": skillMarkdown("unreadable-directory"),
    "skills/unreadable-directory/references/guide.md": "# Guide\n",
  });
  const unreadableDirectory = path.join(projectDir, "skills/unreadable-directory/references");
  const originalOpendir = fs.promises.opendir;

  const outcome = await withFilesystemOverrides(
    {
      opendir: async (target: fs.PathLike, ...args) => {
        if (target === unreadableDirectory)
          throw Object.assign(new Error("injected enumeration failure"), { code: "EACCES" });
        return originalOpendir(target, ...args);
      },
    },
    () => captureValidation(projectDir),
  );

  assert.equal("error" in outcome, false);
  if (!("result" in outcome)) return;
  assert.equal(outcome.result.valid, false);
  assert.deepEqual(outcome.result.skills, []);
  assert.deepEqual(
    outcome.result.errors.map(({ code, context }) => ({ code, context })),
    [
      {
        code: "archive_unsafe",
        context: {
          path: "skills/unreadable-directory/references",
          skill_name: "unreadable-directory",
        },
      },
    ],
  );
});

test("sanitizes SKILL.md probe failures and discards the skill snapshot", async () => {
  const projectDir = createProject({
    "skills/unreadable-skill/SKILL.md": skillMarkdown("unreadable-skill"),
  });
  const skillPath = path.join(projectDir, "skills/unreadable-skill/SKILL.md");
  const originalLstat = fs.promises.lstat;
  const canary = "SKILL_PROBE_ABSOLUTE_PATH_CANARY";
  const outcome = await withFilesystemOverrides(
    {
      lstat: async (target: fs.PathLike, ...args) => {
        if (target === skillPath) {
          throw Object.assign(new Error(`${canary}: ${skillPath}`), { code: "EACCES" });
        }
        return originalLstat(target, ...args);
      },
    },
    () => captureValidation(projectDir),
  );

  assert.equal("error" in outcome, false);
  if (!("result" in outcome)) return;
  assert.equal(outcome.result.valid, false);
  assert.deepEqual(outcome.result.skills, []);
  assert.equal(JSON.stringify(outcome.result.errors).includes(canary), false);
  assert.deepEqual(
    outcome.result.errors.map(({ code, context }) => ({ code, context })),
    [
      {
        code: "archive_unsafe",
        context: {
          path: "skills/unreadable-skill/SKILL.md",
          skill_name: "unreadable-skill",
        },
      },
    ],
  );
});

test("ignores non-skill directories before name validation or full traversal", async () => {
  const projectDir = createProject({
    "skills/valid-skill/SKILL.md": skillMarkdown("valid-skill"),
    "skills/CON/README.md": "# Not a skill\n",
    "skills/large-unrelated/README.md": "# Not a skill\n",
  });
  const unrelatedRoot = path.join(projectDir, "skills/large-unrelated");
  for (let index = 0; index < 1_100; index += 1) {
    writeFileSync(path.join(unrelatedRoot, `resource-${index}.txt`), "unrelated");
  }

  const result = await validateAuthoringProject({
    projectDir,
    config: { limits: { files: 1 } },
  });

  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.deepEqual(result.errors, []);
  assert.deepEqual(
    result.skills.map(({ name }) => name),
    ["valid-skill"],
  );
});

test("sanitizes failures during the verified SKILL.md read and discards the snapshot", async () => {
  const projectDir = createProject({
    "skills/read-failure-skill/SKILL.md": skillMarkdown("read-failure-skill"),
  });
  const skillPath = path.join(projectDir, "skills/read-failure-skill/SKILL.md");
  const originalLstat = fs.promises.lstat;
  const canary = "SKILL_READ_ABSOLUTE_PATH_CANARY";
  let skillLstatCalls = 0;
  const outcome = await withFilesystemOverrides(
    {
      lstat: async (target: fs.PathLike, ...args) => {
        if (target === skillPath) {
          skillLstatCalls += 1;
          if (skillLstatCalls === 2) {
            throw Object.assign(new Error(`${canary}: ${skillPath}`), { code: "EIO" });
          }
        }
        return originalLstat(target, ...args);
      },
    },
    () => captureValidation(projectDir),
  );

  assert.equal("error" in outcome, false);
  if (!("result" in outcome)) return;
  assert.equal(outcome.result.valid, false);
  assert.deepEqual(outcome.result.skills, []);
  assert.equal(JSON.stringify(outcome.result.errors).includes(canary), false);
  assert.deepEqual(
    outcome.result.errors.map(({ code, context }) => ({ code, context })),
    [
      {
        code: "archive_unsafe",
        context: {
          path: "skills/read-failure-skill/SKILL.md",
          skill_name: "read-failure-skill",
        },
      },
    ],
  );
});

test("sanitizes source-root realpath races after textual inspection", async () => {
  const projectDir = createProject({
    "skills/realpath-skill/SKILL.md": skillMarkdown("realpath-skill"),
  });
  const sourceRoot = path.join(projectDir, "skills");
  const originalRealpath = fs.promises.realpath;
  const canary = "SOURCE_REALPATH_ABSOLUTE_PATH_CANARY";
  const outcome = await withFilesystemOverrides(
    {
      realpath: async (target: fs.PathLike, ...args) => {
        if (target === sourceRoot) {
          throw Object.assign(new Error(`${canary}: ${sourceRoot}`), { code: "EACCES" });
        }
        return originalRealpath(target, ...args);
      },
    },
    () => captureValidation(projectDir),
  );

  assert.equal("error" in outcome, false);
  if (!("result" in outcome)) return;
  assert.equal(outcome.result.valid, false);
  assert.deepEqual(outcome.result.skills, []);
  assert.equal(JSON.stringify(outcome.result.errors).includes(canary), false);
  assert.deepEqual(
    outcome.result.errors.map(({ code, context }) => ({ code, context })),
    [{ code: "archive_unsafe", context: { path: "skills" } }],
  );
});

test("returns a sanitized diagnostic when the project directory is missing", async () => {
  const projectDir = createProject({});
  rmSync(projectDir, { recursive: true });

  const outcome = await captureValidation(projectDir);

  assert.equal("error" in outcome, false);
  if (!("result" in outcome)) return;
  assert.equal(outcome.result.valid, false);
  assert.deepEqual(outcome.result.skills, []);
  assert.deepEqual(
    outcome.result.errors.map(({ code, context }) => ({ code, context })),
    [{ code: "archive_unsafe", context: { path: "." } }],
  );
});

test("redacts project-directory realpath failures", async () => {
  const projectDir = createProject({});
  const originalRealpath = fs.promises.realpath;
  const canary = "PROJECT_REALPATH_ABSOLUTE_PATH_CANARY";
  const outcome = await withFilesystemOverrides(
    {
      realpath: async (target: fs.PathLike, ...args) => {
        if (target === projectDir) {
          throw Object.assign(new Error(`${canary}: ${projectDir}`), { code: "EACCES" });
        }
        return originalRealpath(target, ...args);
      },
    },
    () => captureValidation(projectDir),
  );

  assert.equal("error" in outcome, false);
  if (!("result" in outcome)) return;
  assert.equal(outcome.result.valid, false);
  assert.deepEqual(outcome.result.skills, []);
  assert.equal(JSON.stringify(outcome.result.errors).includes(canary), false);
  assert.equal(JSON.stringify(outcome.result.errors).includes(projectDir), false);
  assert.deepEqual(
    outcome.result.errors.map(({ code, context }) => ({ code, context })),
    [{ code: "archive_unsafe", context: { path: "." } }],
  );
});

test("bounds streamed directory discovery even when entries are ignored", async () => {
  const projectDir = createProject({
    "skills/wide-skill/SKILL.md": skillMarkdown("wide-skill"),
  });
  const skillRoot = path.join(projectDir, "skills/wide-skill");
  for (let index = 0; index < 1_025; index += 1) {
    writeFileSync(path.join(skillRoot, `.env-${index}`), "ignored");
  }
  const originalOpen = fs.promises.open;
  const originalOpendir = fs.promises.opendir;
  let ignoredFileOpens = 0;
  let skillDirectoryEntriesRead = 0;
  let skillDirectoryReadCalls = 0;

  const result = await withFilesystemOverrides(
    {
      open: async (target: fs.PathLike, ...args) => {
        if (typeof target === "string" && path.basename(target).startsWith(".env-"))
          ignoredFileOpens += 1;
        return originalOpen(target, ...args);
      },
      opendir: async (target: fs.PathLike, ...args) => {
        const directory = await originalOpendir(target, ...args);
        if (target !== skillRoot) return directory;
        return new Proxy(directory, {
          get(dir, property) {
            if (property === "read") {
              return async () => {
                skillDirectoryReadCalls += 1;
                const entry = await dir.read();
                if (entry !== null) skillDirectoryEntriesRead += 1;
                return entry;
              };
            }
            const value = Reflect.get(dir, property, dir);
            return typeof value === "function" ? value.bind(dir) : value;
          },
        });
      },
    },
    () =>
      validateAuthoringProject({
        projectDir,
        config: { limits: { files: 1 } },
      }),
  );

  assert.equal(result.valid, false);
  assert.deepEqual(result.skills, []);
  const acceptedEntryCeiling = 1_024;
  // A streaming iterator needs one sentinel read beyond the ceiling to distinguish exactly-full
  // input from overflow; it must stop immediately after that detecting entry.
  assert.equal(skillDirectoryReadCalls, acceptedEntryCeiling + 1);
  assert.equal(skillDirectoryEntriesRead, acceptedEntryCeiling + 1);
  assert.equal(ignoredFileOpens, 0);
  assert.deepEqual(
    result.errors.map(({ context }) => context.limit),
    ["traversalEntries"],
  );
});

test("rejects an included filesystem symlink even when it resolves inside the skill", async () => {
  const projectDir = createProject({
    "skills/linked-skill/SKILL.md": skillMarkdown("linked-skill"),
    "skills/linked-skill/resource.txt": "content",
  });
  symlinkSync(
    "resource.txt",
    path.join(projectDir, "skills/linked-skill/resource-link.txt"),
    "file",
  );

  const result = await validateAuthoringProject({ projectDir });

  assert.equal(result.valid, false);
  assert.deepEqual(
    result.errors.map(({ severity, code, context }) => ({
      severity,
      code,
      path: context.path,
    })),
    [
      {
        severity: "error",
        code: "archive_unsafe",
        path: "skills/linked-skill/resource-link.txt",
      },
    ],
  );
  assert.deepEqual(result.skills, []);
});

test("rejects included hard-linked files", async () => {
  const projectDir = createProject({
    "skills/linked-skill/SKILL.md": skillMarkdown("linked-skill"),
    "skills/linked-skill/resource.txt": "content",
  });
  linkSync(
    path.join(projectDir, "skills/linked-skill/resource.txt"),
    path.join(projectDir, "skills/linked-skill/resource-copy.txt"),
  );

  const result = await validateAuthoringProject({ projectDir });

  assert.equal(result.valid, false);
  assert.ok(result.errors.every(({ code }) => code === "archive_unsafe"));
  assert.deepEqual(
    result.errors.map(({ context }) => context.path),
    ["skills/linked-skill/resource-copy.txt", "skills/linked-skill/resource.txt"],
  );
});

test("validates local Markdown references without treating remote links as files", async () => {
  const projectDir = createProject({
    "skills/reference-skill/SKILL.md": skillMarkdown(
      "reference-skill",
      [
        "[Existing reference](references/existing.md#details)",
        "![Missing image](assets/missing.png)",
        "[Remote documentation](https://example.com/reference.md)",
        "[Section](#local-section)",
        "",
      ].join("\n"),
    ),
    "skills/reference-skill/references/existing.md": "# Details\n",
  });

  const result = await validateAuthoringProject({ projectDir });

  assert.equal(result.valid, false);
  assert.deepEqual(
    result.errors.map(({ code, context }) => ({ code, path: context.path })),
    [{ code: "resource_not_found", path: "assets/missing.png" }],
  );
});

test("rejects Windows drive references before classifying URI schemes", async () => {
  const driveReferences = [
    "[Drive absolute](C:/outside.txt)",
    String.raw`[Drive backslash](<C:\outside.txt>)`,
    "[Drive relative](C:outside.txt)",
  ];
  for (const driveReference of driveReferences) {
    const projectDir = createProject({
      "skills/reference-skill/SKILL.md": skillMarkdown(
        "reference-skill",
        [
          driveReference,
          "[HTTPS](https://example.test/guide)",
          "[Mail](mailto:author@example.test)",
          "[Custom](custom:guide)",
        ].join("\n"),
      ),
    });

    const result = await validateAuthoringProject({ projectDir });

    assert.equal(result.valid, false);
    assert.deepEqual(
      result.errors.map(({ code, context }) => ({ code, path: context.path })),
      [{ code: "path_invalid", path: "[invalid-local-reference]" }],
    );
  }
});

test("resolves dot-relative and same-document CommonMark URI references", async () => {
  const projectDir = createProject({
    "skills/reference-skill/SKILL.md": skillMarkdown(
      "reference-skill",
      [
        "[Dot-relative guide](./references/existing.md?view=full#details)",
        "[Normalized guide](sub/../references/existing.md)",
        "[Query-only view](?view=compact)",
        "[Fragment-only section](#details)",
        "![Dot-relative image](./assets/icon.png)",
        "[Reference-style guide][guide]",
        "",
        "[guide]: ./references/existing.md#reference-style",
        "",
      ].join("\n"),
    ),
    "skills/reference-skill/references/existing.md": "# Details\n",
    "skills/reference-skill/assets/icon.png": "image bytes",
  });

  const result = await validateAuthoringProject({ projectDir });

  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test("validates CommonMark reference-style links against included resources", async () => {
  const projectDir = createProject({
    "skills/reference-skill/SKILL.md": skillMarkdown(
      "reference-skill",
      `[Existing guide][guide]
[Missing guide][missing]

[guide]: references/existing.md
[missing]: references/missing.md
`,
    ),
    "skills/reference-skill/references/existing.md": "# Existing\n",
  });

  const result = await validateAuthoringProject({ projectDir });

  assert.equal(result.valid, false);
  assert.deepEqual(
    result.errors.map(({ code, context }) => ({ code, path: context.path })),
    [{ code: "resource_not_found", path: "references/missing.md" }],
  );
});

test("bounds deeply nested CommonMark traversal and closes its supplied snapshot", async () => {
  const nestedBody = `${"> ".repeat(20_000)}[guide](references/guide.md)\n`;
  const projectDir = createProject({
    "skills/deep-markdown/SKILL.md": skillMarkdown("deep-markdown", nestedBody),
    "skills/deep-markdown/references/guide.md": "# Guide\n",
  });
  const { outcome, observed } = await withTrackedFilesystemHandles(async (state) => {
    const snapshot = await createAuthoringProjectSnapshot(projectDir);
    assert.ok(snapshot);
    const outcome = await captureValidation(projectDir, snapshot);
    const observed = { ...state, snapshotClosed: snapshot.closed };
    await closeAuthoringProjectSnapshot(snapshot);
    return { outcome, observed };
  });

  assert.equal("error" in outcome, false);
  if (!("result" in outcome)) return;
  assert.equal(outcome.result.valid, false);
  assert.deepEqual(
    outcome.result.errors.map(({ code, context }) => ({ code, context })),
    [
      {
        code: "limit_exceeded",
        context: {
          limit: "markdownNodes",
          path: "skills/deep-markdown/SKILL.md",
          skill_name: "deep-markdown",
        },
      },
    ],
  );
  assert.equal(observed.snapshotClosed, true);
  assert.equal(observed.closed, observed.opened);
});

test("validates normal-depth CommonMark and closes its supplied snapshot", async () => {
  const normalBody = `${"> ".repeat(32)}[guide](references/guide.md)\n`;
  const projectDir = createProject({
    "skills/normal-markdown/SKILL.md": skillMarkdown("normal-markdown", normalBody),
    "skills/normal-markdown/references/guide.md": "# Guide\n",
  });
  const { result, observed } = await withTrackedFilesystemHandles(async (state) => {
    const snapshot = await createAuthoringProjectSnapshot(projectDir);
    assert.ok(snapshot);
    const result = await validateAuthoringProject({ projectDir, snapshot });
    const observed = { ...state, snapshotClosed: snapshot.closed };
    await closeAuthoringProjectSnapshot(snapshot);
    return { result, observed };
  });

  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
  assert.equal(observed.snapshotClosed, true);
  assert.equal(observed.closed, observed.opened);
});

test("closes every retained handle when wide frontmatter reaches its node budget", async () => {
  const sequence = Array.from({ length: 150_000 }, () => "  - value").join("\n");
  const projectDir = createProject({
    "skills/bounded-frontmatter/SKILL.md": `---
name: bounded-frontmatter
description: Validate bounded frontmatter traversal.
allowed-tools:
${sequence}
---
# Body
`,
  });

  const { result, state } = await withTrackedFilesystemHandles(async (handleState) => ({
    result: await validateAuthoringProject({ projectDir }),
    state: handleState,
  }));

  assert.equal(result.valid, false);
  assert.deepEqual(result.skills, []);
  assert.ok(
    result.errors.some(
      ({ code, context }) => code === "limit_exceeded" && context.limit === "frontmatterNodes",
    ),
  );
  assert.equal(state.opened, state.closed);
});

for (const fileName of [".skillignore", "notes.txt"]) {
  test(`closes the ${fileName} handle when the post-read project stability check fails`, async () => {
    const projectDir = createProject({
      "skills/ignore-cleanup/SKILL.md": skillMarkdown("ignore-cleanup"),
      [`skills/ignore-cleanup/${fileName}`]: "Ordinary project data\n",
    });
    const inputPath = path.join(projectDir, "skills/ignore-cleanup", fileName);
    const originalLstat = fs.promises.lstat;
    let inputStats = 0;
    let stabilityFailures = 0;
    await withTrackedFilesystemHandles(async (state) => {
      const originalOpen = fs.promises.open;
      let inputHandle: fs.promises.FileHandle | undefined;
      let inputOpens = 0;
      let inputCloses = 0;
      try {
        const result = await withFilesystemOverrides(
          {
            open: async (target, flags, mode) => {
              const handle = await originalOpen(target, flags, mode);
              if (target === inputPath) {
                inputHandle = handle;
                inputOpens += 1;
                const originalClose = handle.close.bind(handle);
                handle.close = async () => {
                  inputCloses += 1;
                  await originalClose();
                };
              }
              return handle;
            },
            lstat: async (target, options) => {
              if (target === projectDir && inputStats === 2) {
                stabilityFailures += 1;
                throw Object.assign(new Error("project status unavailable"), { code: "EIO" });
              }
              const stats = await originalLstat(target, options);
              if (target === inputPath) inputStats += 1;
              return stats;
            },
          },
          () => validateAuthoringProject({ projectDir }),
        );
        assert.equal(inputStats, 2);
        assert.ok(stabilityFailures > 0);
        assert.equal(result.valid, false);
        assert.deepEqual(result.skills, []);
        assert.ok(
          result.errors.some(
            ({ code, context }) => code === "archive_unsafe" && context.path === ".",
          ),
        );
        assert.equal(inputOpens, 1);
        assert.equal(inputCloses, 1);
        assert.equal(state.opened, state.closed);
      } finally {
        if (inputHandle && inputHandle.fd !== -1) await inputHandle.close();
      }
    });
  });
}

test("uses the first CommonMark definition when labels are duplicated", async () => {
  const projectDir = createProject({
    "skills/reference-skill/SKILL.md": skillMarkdown(
      "reference-skill",
      `[Guide][guide]

[guide]: references/existing.md
[guide]: references/missing.md
`,
    ),
    "skills/reference-skill/references/existing.md": "# Existing\n",
  });

  const result = await validateAuthoringProject({ projectDir });

  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test("keeps four-space-indented Markdown links inert", async () => {
  const projectDir = createProject({
    "skills/reference-skill/SKILL.md": skillMarkdown(
      "reference-skill",
      "    [Example only](references/missing.md)\n",
    ),
  });

  const result = await validateAuthoringProject({ projectDir });

  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test("decodes percent-encoded filename delimiters after splitting raw URL suffixes", async () => {
  const projectDir = createProject({
    "skills/reference-skill/SKILL.md": skillMarkdown(
      "reference-skill",
      "[Encoded](references/encoded%23name.md?view=1#top)\n",
    ),
    "skills/reference-skill/references/encoded#name.md": "# Encoded\n",
  });

  const result = await validateAuthoringProject({ projectDir });

  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test("rejects local Markdown references that escape the skill root", async () => {
  const projectDir = createProject({
    "skills/reference-skill/SKILL.md": skillMarkdown(
      "reference-skill",
      String.raw`[Outside](../outside.md)
[UNC](<\\server\share>)
[File URL](file:///etc/passwd)
`,
    ),
  });

  const result = await validateAuthoringProject({ projectDir });

  assert.equal(result.valid, false);
  assert.deepEqual(
    result.errors.map(({ code, context }) => ({ code, path: context.path })),
    [{ code: "path_invalid", path: "[invalid-local-reference]" }],
  );
});

test("redacts URL canaries from rejected local-reference diagnostics", async () => {
  const canary = "LOCAL_REFERENCE_SECRET_CANARY";
  const projectDir = createProject({
    "skills/redaction-skill/SKILL.md": skillMarkdown(
      "redaction-skill",
      `[File](<file://user:${canary}@example.test/path?token=${canary}#${canary}>)
[Decode](references/%ZZ?token=${canary}#${canary})
[Suffix](?token=${canary}#${canary})
[Traversal](../user:${canary}@example.test/secret.md?token=${canary}#${canary})
`,
    ),
  });

  const result = await validateAuthoringProject({ projectDir });

  assert.equal(result.valid, false);
  assert.equal(JSON.stringify(result.errors).includes(canary), false);
  assert.ok(result.errors.every(({ context }) => context.path === "[invalid-local-reference]"));
});

test("rejects configuration paths that escape the project boundary", async () => {
  const projectDir = createProject({});

  const result = await validateAuthoringProject({
    projectDir,
    config: { sourceRoots: ["../outside", "C:\\outside", "C:outside"] },
  });

  assert.equal(result.valid, false);
  assert.deepEqual(
    result.errors.map(({ code, context }) => ({ code, path: context.path })),
    [
      { code: "path_invalid", path: "[invalid-path]" },
      { code: "path_invalid", path: "[invalid-path]" },
      { code: "path_invalid", path: "[invalid-path]" },
    ],
  );
});

test("redacts credential-bearing configured paths from direct core diagnostics", async () => {
  const canary = "CORE_CONFIG_PATH_SECRET_CANARY";
  const credentialPath = `https://user:${canary}@example.test/skills?token=${canary}#${canary}`;
  const projectDir = createProject({});

  const result = await validateAuthoringProject({
    projectDir,
    config: { sourceRoots: [credentialPath] },
  });

  assert.equal(result.valid, false);
  assert.deepEqual(result.skills, []);
  assertValueRedacted(result, canary);
  assert.deepEqual(
    result.errors.map(({ code, context }) => ({ code, context })),
    [
      {
        code: "path_invalid",
        context: { field: "sourceRoots", path: "[invalid-path]" },
      },
    ],
  );
});

test("closes caller-supplied snapshots when project preflight rejects inputs", async () => {
  const projectDir = createProject({
    "skills/preflight-skill/SKILL.md": skillMarkdown("preflight-skill"),
  });
  const cases = [
    { projectDir, config: { sourceRoots: ["../outside"] } },
    { projectDir: `${projectDir}\uD800`, config: undefined },
  ];

  for (const validationCase of cases) {
    const snapshot = await createAuthoringProjectSnapshot(projectDir);
    assert.ok(snapshot);
    const closeSpy = spyOnSnapshotClose(snapshot);

    try {
      const result = await validateAuthoringProject({
        projectDir: validationCase.projectDir,
        ...(validationCase.config === undefined ? {} : { config: validationCase.config }),
        snapshot,
      });

      assert.equal(result.valid, false);
      assert.deepEqual(result.skills, []);
      assert.equal(snapshot.closed, true);
      assert.equal(closeSpy.closeCalls(), closeSpy.expectedCalls);
    } finally {
      await closeAuthoringProjectSnapshot(snapshot);
    }
  }
});

test("closes every supplied snapshot handle when validation throws", async () => {
  const projectDir = createProject({
    "skills/throwing-skill/SKILL.md": skillMarkdown("throwing-skill"),
  });
  const snapshot = await createAuthoringProjectSnapshot(projectDir);
  assert.ok(snapshot);
  const retained = await readAuthoringProjectFile(
    snapshot,
    "skills/throwing-skill/SKILL.md",
    1_000_000,
  );
  assert.equal(retained.kind, "file");
  const closeSpy = spyOnSnapshotClose(snapshot);
  const config = {};
  Object.defineProperty(config, "sourceRoots", {
    get() {
      throw new Error("injected validation failure");
    },
  });

  await assert.rejects(
    validateAuthoringProject({ projectDir, config, snapshot }),
    /injected validation failure/u,
  );

  assert.equal(snapshot.closed, true);
  assert.equal(closeSpy.closeCalls(), closeSpy.expectedCalls);
});

test("rejects non-canonical project-relative path spellings", () => {
  for (const candidate of ["skills\\nested", "skills/.", "skills//nested", "skills/"]) {
    assert.equal(authoringPaths.isProjectRelativePath(candidate), false, candidate);
  }
  assert.equal(authoringPaths.isProjectRelativePath("skills/nested"), true);
});

test("deduplicates canonical source roots before traversal", async () => {
  const projectDir = createProject({
    "skills/deduplicated-skill/SKILL.md": skillMarkdown("deduplicated-skill"),
  });

  const result = await validateAuthoringProject({
    projectDir,
    config: { sourceRoots: ["skills", "skills"] },
  });

  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(
    result.skills.map(({ name }) => name),
    ["deduplicated-skill"],
  );
});

test("rejects distinct source roots with the same portable collision key", async () => {
  const projectDir = createProject({
    "skills/collision-skill/SKILL.md": skillMarkdown("collision-skill"),
  });

  const result = await validateAuthoringProject({
    projectDir,
    config: { sourceRoots: ["skills", "Skills"] },
  });

  assert.equal(result.valid, false);
  assert.deepEqual(
    result.errors.map(({ code, context }) => ({ code, context })),
    [
      {
        code: "path_invalid",
        context: { field: "sourceRoots", path: "Skills" },
      },
    ],
  );
});

test("rejects configured source roots beneath a symlinked ancestor", async () => {
  const projectDir = createProject({
    "linked/skills/ancestor-skill/SKILL.md": skillMarkdown("ancestor-skill"),
  });
  const linkedAncestor = path.join(projectDir, "linked");
  const originalLstat = fs.promises.lstat;

  const result = await withFilesystemOverrides(
    {
      lstat: async (target: fs.PathLike, ...args) => {
        const stats = await originalLstat(target, ...args);
        return target === linkedAncestor ? withFilesystemType(stats, "isSymbolicLink") : stats;
      },
    },
    () =>
      validateAuthoringProject({
        projectDir,
        config: { sourceRoots: ["linked/skills"] },
      }),
  );

  assert.equal(result.valid, false);
  assert.deepEqual(result.skills, []);
  assert.deepEqual(
    result.errors.map(({ code, context }) => ({ code, context })),
    [
      {
        code: "archive_unsafe",
        context: { path: "linked/skills" },
      },
    ],
  );
});

test("normalizes portable paths and detects unsafe separators and case collisions", () => {
  assert.deepEqual(authoringPaths.normalizePortableRelativePath?.("references/Guide.md"), {
    path: "references/Guide.md",
    collisionKey: "references/guide.md",
  });
  assert.equal(authoringPaths.normalizePortableRelativePath?.("references\\guide.md"), null);
  assert.equal(
    authoringPaths.normalizePortableRelativePath?.("references/e\u0301.md")?.collisionKey,
    authoringPaths.normalizePortableRelativePath?.("references/é.md")?.collisionKey,
  );
  assert.equal(
    authoringPaths.normalizePortableRelativePath?.("references/Straße.md")?.collisionKey,
    authoringPaths.normalizePortableRelativePath?.("references/STRASSE.md")?.collisionKey,
  );
  assert.equal(
    authoringPaths.normalizePortableRelativePath?.("references/ς.md")?.collisionKey,
    authoringPaths.normalizePortableRelativePath?.("references/σ.md")?.collisionKey,
  );
  assert.equal(
    authoringPaths.normalizePortableRelativePath?.("references/\u{1c89}.md")?.collisionKey,
    "references/\u{1c89}.md",
    "case folding is pinned to Unicode 15 instead of the host ICU version",
  );
  assert.equal(authoringPaths.normalizePortableRelativePath?.("skills/\ud800"), null);
  assert.equal(authoringPaths.normalizePortableRelativePath?.("skills/\udfff"), null);
  assert.deepEqual(authoringPaths.normalizePortableRelativePath?.("skills/�"), {
    path: "skills/�",
    collisionKey: "skills/�",
  });
});

test("portable path policy rejects C0 and DEL code points", () => {
  for (const point of [...Array.from({ length: 0x20 }, (_, index) => index), 0x7f]) {
    const candidate = `references/guide${String.fromCodePoint(point)}.md`;
    assert.equal(authoringPaths.normalizePortableRelativePath(candidate), null);
    assert.equal(authoringPaths.isProjectRelativePath(candidate), false);
  }
  for (const candidate of ["SKILL.md", "references/guide ~.md", "references/café.md"]) {
    assert.equal(authoringPaths.normalizePortableRelativePath(candidate)?.path, candidate);
    assert.equal(authoringPaths.isProjectRelativePath(candidate), true);
  }
});

test("rejects Windows-unsafe portable path segments without rejecting near-controls", () => {
  for (const candidate of [
    "references/CON",
    "references/con.txt",
    "references/PRN.md",
    "references/AUX",
    "references/NUL.json",
    "references/COM1.log",
    "references/LPT9",
    "references/COM¹",
    "references/com².txt",
    "references/Com³.log",
    "references/LPT¹",
    "references/lpt².txt",
    "references/Lpt³.log",
    "references/CONIN$",
    "references/conin$.txt",
    "references/CONOUT$",
    "references/conout$.log",
    "references/stream:ads.txt",
    "references/question?.txt",
    'references/quote".txt',
    "references/less<than.txt",
    "references/control\u001f.txt",
    "references/trailing.",
    "references/trailing ",
  ]) {
    assert.equal(authoringPaths.normalizePortableRelativePath?.(candidate), null, candidate);
  }

  for (const candidate of [
    "references/console.txt",
    "references/conduit",
    "references/COM10.log",
    "references/LPT0",
    "references/COM⁴",
    "references/LPT⁰.txt",
    "references/CONIN",
    "references/CONOUT.txt",
    "references/CONIN$value",
    "references/file..txt",
    "references/space .txt",
  ]) {
    assert.equal(authoringPaths.normalizePortableRelativePath?.(candidate)?.path, candidate);
  }
});

test("rejects non-scalar source roots before touching the filesystem", async () => {
  const projectDir = createProject({});
  const originalLstat = fs.promises.lstat;

  for (const sourceRoot of ["skills/\ud800", "skills/\udfff"]) {
    let filesystemCalls = 0;
    const result = await withFilesystemOverrides(
      {
        lstat: async (...args) => {
          filesystemCalls += 1;
          return originalLstat(...args);
        },
      },
      () => validateAuthoringProject({ projectDir, config: { sourceRoots: [sourceRoot] } }),
    );

    assert.equal(filesystemCalls, 0);
    assert.equal(result.valid, false);
    assert.deepEqual(
      result.errors.map(({ code, context }) => ({ code, context })),
      [{ code: "path_invalid", context: { field: "sourceRoots", path: "[invalid-path]" } }],
    );
  }
});

test("accepts the replacement character as a valid Unicode scalar in source roots", async () => {
  const projectDir = createProject({
    "skills/�/replacement-control/SKILL.md": skillMarkdown("replacement-control"),
  });

  const result = await validateAuthoringProject({
    projectDir,
    config: { sourceRoots: ["skills/�"] },
  });

  assert.equal(result.valid, true);
  assert.deepEqual(
    result.skills.map(({ name }) => name),
    ["replacement-control"],
  );
});

test("rejects duplicate skill names across distinct source roots", async () => {
  const projectDir = createProject({
    "first/duplicate-skill/SKILL.md": skillMarkdown("duplicate-skill"),
    "second/duplicate-skill/SKILL.md": skillMarkdown("duplicate-skill"),
  });

  const result = await validateAuthoringProject({
    projectDir,
    config: { sourceRoots: ["first", "second"] },
  });

  assert.equal(result.valid, false);
  assert.equal(result.skills.length, 1);
  assert.deepEqual(
    result.errors.map(({ code, context }) => ({ code, context })),
    [
      {
        code: "catalog_invalid",
        context: {
          field: "name",
          path: "second/duplicate-skill/SKILL.md",
          skill_name: "duplicate-skill",
        },
      },
    ],
  );
});

test("stops before allocating a file that crosses the per-file byte limit", async () => {
  const markdown = skillMarkdown("bounded-skill");
  const resource = "x".repeat(Buffer.byteLength(markdown) + 1);
  const projectDir = createProject({
    "skills/bounded-skill/SKILL.md": markdown,
    "skills/bounded-skill/resource.txt": resource,
  });

  const { resourceIo, result } = await validateWithResourceIoProbe({
    projectDir,
    relativePath: "skills/bounded-skill/resource.txt",
    size: Buffer.byteLength(resource),
    config: { limits: { fileBytes: Buffer.byteLength(markdown) } },
  });

  assert.deepEqual(resourceIo, { allocations: 0, opens: 0, reads: 0 });
  assert.equal(result.valid, false);
  assert.deepEqual(
    firstSkill(result).files.map(({ path: filePath }) => filePath),
    ["SKILL.md"],
  );
  assert.deepEqual(
    result.errors.map(({ context }) => context.limit),
    ["fileBytes"],
  );
});

test("stops accumulating files as soon as the file-count limit is crossed", async () => {
  const resource = "must not accumulate";
  const projectDir = createProject({
    "skills/bounded-skill/SKILL.md": skillMarkdown("bounded-skill"),
    "skills/bounded-skill/resource.txt": resource,
  });

  const { resourceIo, result } = await validateWithResourceIoProbe({
    projectDir,
    relativePath: "skills/bounded-skill/resource.txt",
    size: Buffer.byteLength(resource),
    config: { limits: { files: 1 } },
  });

  assert.deepEqual(resourceIo, { allocations: 0, opens: 0, reads: 0 });
  assert.deepEqual(
    firstSkill(result).files.map(({ path: filePath }) => filePath),
    ["SKILL.md"],
  );
  assert.deepEqual(
    result.errors.map(({ context }) => context.limit),
    ["files"],
  );
});

test("reserves the retained SKILL.md in file limits before lexically earlier resources", async () => {
  const { projectDir } = createProjectWithLexicallyEarlierResource();

  const result = await validateAuthoringProject({
    projectDir,
    config: { limits: { files: 1 } },
  });

  assert.equal(result.valid, false);
  assert.deepEqual(
    firstSkill(result).files.map(({ path: filePath }) => filePath),
    ["SKILL.md"],
  );
  assert.deepEqual(
    result.errors.map(({ context }) => context.limit),
    ["files"],
  );
});

test("stops before allocating a file that crosses the total-byte limit", async () => {
  const markdown = skillMarkdown("bounded-skill");
  const resource = "must not allocate";
  const projectDir = createProject({
    "skills/bounded-skill/SKILL.md": markdown,
    "skills/bounded-skill/resource.txt": resource,
  });

  const { resourceIo, result } = await validateWithResourceIoProbe({
    projectDir,
    relativePath: "skills/bounded-skill/resource.txt",
    size: Buffer.byteLength(resource),
    config: { limits: { extractedBytes: Buffer.byteLength(markdown) } },
  });

  assert.deepEqual(resourceIo, { allocations: 0, opens: 0, reads: 0 });
  assert.deepEqual(
    firstSkill(result).files.map(({ path: filePath }) => filePath),
    ["SKILL.md"],
  );
  assert.deepEqual(
    result.errors.map(({ context }) => context.limit),
    ["extractedBytes"],
  );
});

test("counts the retained SKILL.md exactly once in cumulative byte limits", async () => {
  const { markdown, readme, projectDir } = createProjectWithLexicallyEarlierResource();

  const failing = await validateAuthoringProject({
    projectDir,
    config: { limits: { extractedBytes: Buffer.byteLength(markdown) } },
  });
  const exact = await validateAuthoringProject({
    projectDir,
    config: {
      limits: { extractedBytes: Buffer.byteLength(markdown) + Buffer.byteLength(readme) },
    },
  });

  assert.equal(failing.valid, false);
  assert.deepEqual(
    firstSkill(failing).files.map(({ path: filePath }) => filePath),
    ["SKILL.md"],
  );
  assert.deepEqual(
    failing.errors.map(({ context }) => context.limit),
    ["extractedBytes"],
  );
  assert.equal(exact.valid, true, JSON.stringify(exact.errors));
  assert.deepEqual(
    firstSkill(exact).files.map(({ path: filePath }) => filePath),
    ["SKILL.md", "README.md"],
  );
});

test("returns verified bytes after source-root ancestor and skill-directory swaps", async () => {
  const projectDir = createProject({
    "skills/snapshot-skill/SKILL.md": skillMarkdown("snapshot-skill"),
    "skills/snapshot-skill/resource.txt": "verified bytes",
  });

  const result = await validateAuthoringProject({ projectDir });
  const resource = firstSkill(result).files.find(
    ({ path: filePath }) => filePath === "resource.txt",
  );
  renameSync(path.join(projectDir, "skills"), path.join(projectDir, "verified-skills"));
  renameSync(
    path.join(projectDir, "verified-skills/snapshot-skill"),
    path.join(projectDir, "verified-skills/moved-skill"),
  );
  mkdirSync(path.join(projectDir, "skills/snapshot-skill"), { recursive: true });
  writeFileSync(path.join(projectDir, "skills/snapshot-skill/resource.txt"), "replacement bytes");

  assert.ok(resource);
  assert.ok(resource.bytes instanceof Uint8Array);
  assert.equal(Buffer.from(resource.bytes).toString("utf8"), "verified bytes");
  assert.equal(Object.hasOwn(resource, "absolutePath"), false);
});

test("rejects a skill directory swapped and restored during traversal", async () => {
  const projectDir = createProject({
    "skills/swap-skill/SKILL.md": skillMarkdown("swap-skill"),
    "skills/swap-skill/resource.txt": "verified bytes",
    "replacement-skill/SKILL.md": skillMarkdown("swap-skill"),
    "replacement-skill/resource.txt": "replacement bytes",
  });
  const skillRoot = path.join(projectDir, "skills/swap-skill");
  const parkedRoot = path.join(projectDir, "parked-skill");
  const replacementRoot = path.join(projectDir, "replacement-skill");
  const originalLstat = fs.promises.lstat;
  const originalOpendir = fs.promises.opendir;
  let swapped = false;
  let restored = false;

  const result = await withFilesystemOverrides(
    {
      opendir: async (target: fs.PathLike, ...args) => {
        if (target === skillRoot && !swapped) {
          renameSync(skillRoot, parkedRoot);
          renameSync(replacementRoot, skillRoot);
          utimesSync(parkedRoot, new Date(1_000), new Date(1_000));
          swapped = true;
        }
        return originalOpendir(target, ...args);
      },
      lstat: async (target: fs.PathLike, ...args) => {
        if (target === skillRoot && swapped && !restored) {
          renameSync(skillRoot, replacementRoot);
          renameSync(parkedRoot, skillRoot);
          restored = true;
        }
        return originalLstat(target, ...args);
      },
    },
    () => validateAuthoringProject({ projectDir }),
  );

  assert.equal(result.valid, false);
  assert.deepEqual(result.skills, []);
  assert.ok(result.errors.some(({ code }) => code === "archive_unsafe"));
});

test("rejects an in-place traversed-directory mutation restored before revalidation", async () => {
  const projectDir = createProject({
    "skills/mutated-skill/SKILL.md": skillMarkdown("mutated-skill"),
  });
  const skillRoot = path.join(projectDir, "skills/mutated-skill");
  const ignoredRacePath = path.join(skillRoot, ".env-race");
  const originalLstat = fs.promises.lstat;
  const originalOpendir = fs.promises.opendir;
  let mutated = false;
  let restored = false;

  const result = await withFilesystemOverrides(
    {
      opendir: async (target: fs.PathLike, ...args) => {
        if (target === skillRoot && !mutated) {
          writeFileSync(ignoredRacePath, "ignored race bytes");
          mutated = true;
        }
        return originalOpendir(target, ...args);
      },
      lstat: async (target: fs.PathLike, ...args) => {
        if (target === skillRoot && mutated && !restored) {
          rmSync(ignoredRacePath);
          utimesSync(skillRoot, new Date(2_000), new Date(2_000));
          restored = true;
        }
        return originalLstat(target, ...args);
      },
    },
    () => validateAuthoringProject({ projectDir }),
  );

  assert.equal(result.valid, false);
  assert.deepEqual(result.skills, []);
  assert.ok(result.errors.some(({ code }) => code === "archive_unsafe"));
});

test("allows unrelated sibling churn under an intermediate source-root ancestor", async () => {
  const projectDir = createProject({
    "workspace/skills/ancestor-skill/SKILL.md": skillMarkdown("ancestor-skill"),
  });
  const ancestor = path.join(projectDir, "workspace");
  const unrelatedPath = path.join(ancestor, "unrelated");
  const originalOpendir = fs.promises.opendir;
  let changed = false;

  const result = await withFilesystemOverrides(
    {
      opendir: async (target: fs.PathLike, ...args) => {
        if (target === ancestor && !changed) {
          mkdirSync(unrelatedPath);
          rmSync(unrelatedPath, { recursive: true });
          utimesSync(ancestor, new Date(3_000), new Date(3_000));
          changed = true;
        }
        return originalOpendir(target, ...args);
      },
    },
    () =>
      validateAuthoringProject({
        projectDir,
        config: { sourceRoots: ["workspace/skills"] },
      }),
  );

  assert.equal(changed, true);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.deepEqual(result.errors, []);
  assert.deepEqual(
    result.skills.map(({ name }) => name),
    ["ancestor-skill"],
  );
});

test("rejects replacement of an intermediate source-root ancestor", async (context) => {
  if (
    posixMutationProbe(
      context,
      "requires POSIX ancestor renames while retained directory handles remain open",
    )
  )
    return;
  const projectDir = createProject({
    "workspace/skills/intermediate-pivot/SKILL.md": skillMarkdown(
      "intermediate-pivot",
      "# Original instructions\n",
    ),
    "replacement-workspace/skills/intermediate-pivot/SKILL.md": skillMarkdown(
      "intermediate-pivot",
      "# Replacement instructions\n",
    ),
  });
  const workspace = path.join(projectDir, "workspace");
  const replacementWorkspace = path.join(projectDir, "replacement-workspace");
  const parkedWorkspace = path.join(projectDir, "parked-workspace");
  const sourceRoot = path.join(workspace, "skills");
  const skillPath = path.join(sourceRoot, "intermediate-pivot/SKILL.md");
  const originalLstat = fs.promises.lstat;
  const originalOpen = fs.promises.open;
  let swapped = false;
  let replacementBytesRead = false;
  let restored = false;

  const result = await withFilesystemOverrides(
    {
      lstat: async (target: fs.PathLike, ...args) => {
        if (target === sourceRoot && !swapped) {
          renameSync(workspace, parkedWorkspace);
          renameSync(replacementWorkspace, workspace);
          swapped = true;
        }
        if (target === workspace && replacementBytesRead && !restored) {
          renameSync(workspace, replacementWorkspace);
          renameSync(parkedWorkspace, workspace);
          restored = true;
        }
        return originalLstat(target, ...args);
      },
      open: async (target: fs.PathLike, ...args) => {
        const handle = await originalOpen(target, ...args);
        if (target === skillPath && swapped && !restored) {
          replacementBytesRead = (await handle.readFile("utf8")).includes(
            "# Replacement instructions",
          );
        }
        return handle;
      },
    },
    () =>
      validateAuthoringProject({
        projectDir,
        config: { sourceRoots: ["workspace/skills"] },
      }),
  );

  assert.equal(replacementBytesRead, true);
  assert.equal(restored, true);
  assert.equal(result.valid, false);
  assert.deepEqual(result.skills, []);
  assert.ok(
    result.errors.some(
      ({ code, context }) => code === "archive_unsafe" && context.path === "workspace/skills",
    ),
    JSON.stringify(result.errors),
  );
});

test("allows sibling churn under an existing ancestor of a missing source root", async () => {
  const projectDir = createProject({
    "workspace/.keep": "retained ancestor",
    "other/other-skill/SKILL.md": skillMarkdown("other-skill"),
  });
  const ancestor = path.join(projectDir, "workspace");
  const otherRoot = path.join(projectDir, "other");
  const ignoredRacePath = path.join(ancestor, ".env-race");
  const originalLstat = fs.promises.lstat;
  const originalOpendir = fs.promises.opendir;
  let mutated = false;
  let restored = false;

  const result = await withFilesystemOverrides(
    {
      opendir: async (target: fs.PathLike, ...args) => {
        if (target === otherRoot && !mutated) {
          writeFileSync(ignoredRacePath, "missing-root ancestor race bytes");
          mutated = true;
        }
        return originalOpendir(target, ...args);
      },
      lstat: async (target: fs.PathLike, ...args) => {
        if (target === ancestor && mutated && !restored) {
          if (existsSync(ignoredRacePath)) rmSync(ignoredRacePath);
          utimesSync(ancestor, new Date(4_000), new Date(4_000));
          restored = true;
        }
        return originalLstat(target, ...args);
      },
    },
    () =>
      validateAuthoringProject({
        projectDir,
        config: { sourceRoots: ["workspace/missing", "other"] },
      }),
  );

  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.deepEqual(result.errors, []);
  assert.deepEqual(
    result.skills.map(({ name }) => name),
    ["other-skill"],
  );
});

test("rejects a missing top-level source root that appears during another traversal", async () => {
  const projectDir = createProject({
    "other/other-skill/SKILL.md": skillMarkdown("other-skill"),
  });
  const otherRoot = path.join(projectDir, "other");
  const appearingRoot = path.join(projectDir, "missing");
  const originalOpendir = fs.promises.opendir;
  let appeared = false;

  const result = await withFilesystemOverrides(
    {
      opendir: async (target: fs.PathLike, ...args) => {
        if (target === otherRoot && !appeared) {
          mkdirSync(appearingRoot);
          appeared = true;
        }
        return originalOpendir(target, ...args);
      },
    },
    () =>
      validateAuthoringProject({
        projectDir,
        config: { sourceRoots: ["missing", "other"] },
      }),
  );

  assert.equal(result.valid, false);
  assert.deepEqual(result.skills, []);
  assert.ok(
    result.errors.some(
      ({ code, context }) => code === "archive_unsafe" && context.path === "missing",
    ),
  );
});

test("rejects a project-root ABA swap restored before snapshot completion", async (context) => {
  if (
    posixMutationProbe(
      context,
      "requires POSIX ancestor renames while retained directory handles remain open",
    )
  )
    return;
  const projectDir = createProject({
    "skills/project-pivot/SKILL.md": skillMarkdown(
      "project-pivot",
      "# Original project instructions\n",
    ),
  });
  const replacementProject = createProject({
    "skills/project-pivot/SKILL.md": skillMarkdown(
      "project-pivot",
      "# Replacement project instructions\n",
    ),
  });
  const parkedProject = `${projectDir}-parked`;
  temporaryProjects.push(parkedProject);
  const skillPath = path.join(projectDir, "skills/project-pivot/SKILL.md");
  const originalLstat = fs.promises.lstat;
  const originalOpen = fs.promises.open;
  let swapped = false;
  let replacementBytesRead = false;
  let restored = false;

  const result = await withFilesystemOverrides(
    {
      lstat: async (target: fs.PathLike, ...args) => {
        if (target === skillPath && !swapped) {
          renameSync(projectDir, parkedProject);
          renameSync(replacementProject, projectDir);
          swapped = true;
        }
        if (target === projectDir && replacementBytesRead && !restored) {
          renameSync(projectDir, replacementProject);
          renameSync(parkedProject, projectDir);
          restored = true;
        }
        return originalLstat(target, ...args);
      },
      open: async (target: fs.PathLike, ...args) => {
        const handle = await originalOpen(target, ...args);
        if (target === skillPath && swapped && !restored) {
          replacementBytesRead = (await handle.readFile("utf8")).includes(
            "# Replacement project instructions",
          );
        }
        return handle;
      },
    },
    () => validateAuthoringProject({ projectDir }),
  );

  assert.equal(replacementBytesRead, true);
  assert.equal(restored, true);
  assert.equal(result.valid, false);
  assert.deepEqual(result.skills, []);
  assert.deepEqual(
    result.errors.map(({ code, context }) => ({ code, context })),
    [
      {
        code: "archive_unsafe",
        context: { path: "skills/project-pivot/SKILL.md", skill_name: "project-pivot" },
      },
    ],
  );
});

test("rejects a parent-ancestor pivot that serves replacement skill bytes", async (context) => {
  if (
    posixMutationProbe(
      context,
      "requires POSIX ancestor renames while retained directory handles remain open",
    )
  )
    return;
  const sandbox = realpathSync(createProject({}));
  const projectAncestor = path.join(sandbox, "workspace");
  const replacementAncestor = path.join(sandbox, "replacement-workspace");
  const parkedAncestor = path.join(sandbox, "parked-workspace");
  const projectDir = path.join(projectAncestor, "project");
  const sourceRoot = path.join(projectDir, "skills");
  const skillRoot = path.join(sourceRoot, "pivot-skill");
  const skillPath = path.join(skillRoot, "SKILL.md");
  mkdirSync(skillRoot, { recursive: true });
  writeFileSync(skillPath, skillMarkdown("pivot-skill", "# Original instructions\n"));
  const replacementSkillRoot = path.join(replacementAncestor, "project/skills/pivot-skill");
  mkdirSync(replacementSkillRoot, { recursive: true });
  writeFileSync(
    path.join(replacementSkillRoot, "SKILL.md"),
    skillMarkdown("pivot-skill", "# Replacement instructions\n"),
  );
  const originalLstat = fs.promises.lstat;
  const originalOpen = fs.promises.open;
  let swapped = false;
  let replacementBytesRead = false;
  let restored = false;
  let skillLstatCalls = 0;

  const result = await withFilesystemOverrides(
    {
      lstat: async (target: fs.PathLike, ...args) => {
        if (target === skillPath) {
          skillLstatCalls += 1;
        }
        if (target === skillPath && skillLstatCalls === 1 && !swapped) {
          renameSync(projectAncestor, parkedAncestor);
          renameSync(replacementAncestor, projectAncestor);
          swapped = true;
        }
        if (target === projectAncestor && replacementBytesRead && !restored) {
          renameSync(projectAncestor, replacementAncestor);
          renameSync(parkedAncestor, projectAncestor);
          restored = true;
        }
        return originalLstat(target, ...args);
      },
      open: async (target: fs.PathLike, ...args) => {
        const handle = await originalOpen(target, ...args);
        if (target === skillPath && swapped && !restored) {
          replacementBytesRead = (await handle.readFile("utf8")).includes(
            "# Replacement instructions",
          );
        }
        return handle;
      },
    },
    () => validateAuthoringProject({ projectDir }),
  );

  assert.equal(replacementBytesRead, true);
  assert.equal(restored, true);
  assert.equal(result.valid, false);
  assert.deepEqual(result.skills, []);
  assert.deepEqual(
    result.errors.map(({ code, context }) => ({ code, context })),
    [
      {
        code: "archive_unsafe",
        context: { path: "skills/pivot-skill/SKILL.md", skill_name: "pivot-skill" },
      },
    ],
  );
});

test("allows unrelated sibling changes in a shared project ancestor", async () => {
  const sandbox = realpathSync(createProject({}));
  const projectDir = path.join(sandbox, "workspace/project");
  const skillRoot = path.join(projectDir, "skills/stable-skill");
  mkdirSync(skillRoot, { recursive: true });
  writeFileSync(path.join(skillRoot, "SKILL.md"), skillMarkdown("stable-skill"));
  const unrelatedSibling = path.join(sandbox, "unrelated-sibling");
  const originalOpendir = fs.promises.opendir;
  let changed = false;

  const result = await withFilesystemOverrides(
    {
      opendir: async (target: fs.PathLike, ...args) => {
        if (target === skillRoot && !changed) {
          mkdirSync(unrelatedSibling);
          rmSync(unrelatedSibling, { recursive: true });
          utimesSync(sandbox, new Date(7_000), new Date(7_000));
          changed = true;
        }
        return originalOpendir(target, ...args);
      },
    },
    () => validateAuthoringProject({ projectDir }),
  );

  assert.equal(changed, true);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.deepEqual(result.errors, []);
  assert.deepEqual(
    result.skills.map(({ name }) => name),
    ["stable-skill"],
  );
});

test("allows unrelated sibling changes directly inside the project root", async () => {
  const projectDir = createProject({
    "skills/stable-skill/SKILL.md": skillMarkdown("stable-skill"),
  });
  const skillRoot = path.join(projectDir, "skills/stable-skill");
  const unrelatedSibling = path.join(projectDir, "unrelated-sibling");
  const originalOpendir = fs.promises.opendir;
  let changed = false;

  const result = await withFilesystemOverrides(
    {
      opendir: async (target: fs.PathLike, ...args) => {
        if (target === skillRoot && !changed) {
          mkdirSync(unrelatedSibling);
          rmSync(unrelatedSibling, { recursive: true });
          utimesSync(projectDir, new Date(8_000), new Date(8_000));
          changed = true;
        }
        return originalOpendir(target, ...args);
      },
    },
    () => validateAuthoringProject({ projectDir }),
  );

  assert.equal(changed, true);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.deepEqual(result.errors, []);
  assert.deepEqual(
    result.skills.map(({ name }) => name),
    ["stable-skill"],
  );
});

test("keeps writing guidance separate unless strict validation promotes it", async () => {
  const longBody = `${Array.from({ length: 501 }, (_, index) => `Line ${index + 1}`).join("\n")}\n`;
  const projectDir = createProject({
    "skills/verbose-skill/SKILL.md": skillMarkdown("verbose-skill", longBody),
  });

  const normal = await validateAuthoringProject({ projectDir });
  const strict = await validateAuthoringProject({ projectDir, strict: true });

  assert.equal(normal.valid, true);
  assert.equal(normal.errors.length, 0);
  assert.deepEqual(
    normal.warnings.map(({ severity, context }) => ({
      severity,
      field: context.field,
    })),
    [{ severity: "warning", field: "SKILL.md.lines" }],
  );
  assert.equal(strict.valid, false);
  assert.deepEqual(
    strict.errors.map(({ severity, context }) => ({
      severity,
      field: context.field,
    })),
    [{ severity: "error", field: "SKILL.md.lines" }],
  );
  assert.deepEqual(strict.warnings, []);
});

test("counts bare CR, LF, and CRLF deterministically at the writing limit", async () => {
  const lineEndings = ["\r", "\n", "\r\n"];
  const bodyWithLines = (count: number) =>
    Array.from(
      { length: count },
      (_, index) =>
        `Line ${index + 1}${index + 1 < count ? lineEndings[index % lineEndings.length] : ""}`,
    ).join("");
  const exactlyAtLimit = createProject({
    "skills/exact-lines/SKILL.md": skillMarkdown("exact-lines", bodyWithLines(496)),
  });
  const overLimit = createProject({
    "skills/over-lines/SKILL.md": skillMarkdown("over-lines", bodyWithLines(497)),
  });

  const exact = await validateAuthoringProject({ projectDir: exactlyAtLimit });
  const over = await validateAuthoringProject({ projectDir: overLimit });

  assert.equal(exact.valid, true);
  assert.deepEqual(exact.warnings, []);
  assert.equal(over.valid, true);
  assert.deepEqual(
    over.warnings.map(({ context }) => context.field),
    ["SKILL.md.lines"],
  );
});

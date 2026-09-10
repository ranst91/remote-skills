import type { Hash } from "node:crypto";
import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";

import {
  closeAuthoringProjectSnapshot,
  createAuthoringProjectSnapshot,
  createSkillIgnorePolicy,
  ignoredByDefaults,
  normalizePortableRelativePath,
  readAuthoringProjectFile,
  verifyAuthoringProjectSnapshot,
} from "@remote-skills/core/authoring";
import { ConfigValidationError } from "@remote-skills/core/config-schema";

import { runBuildCommand } from "./build.ts";
import { loadPublisherConfig } from "./config.ts";
import { loadCompletedGeneration, startDevelopmentOrigin } from "./dev-server.ts";
import { createSingleFlightRebuilder } from "./rebuild-queue.ts";

export type ParsedDevArgs = {
  overrides: { dev?: { host?: string; port?: number } };
  unsafeHost: boolean;
};
export type PublisherDevErrorEvent = {
  error: Error;
  context: { phase: "rebuild" | "scan" | "shutdown" };
  timestamp: string;
};
export type DevelopmentOrigin = {
  host: string;
  port: number;
  origin: string;
  closed: Promise<void>;
  close: () => Promise<void>;
};

/** @param {string} message */
function argumentError(message: string): ConfigValidationError {
  return new ConfigValidationError([`/arguments ${message}`]);
}

/** @param {string[]} args @returns {ParsedDevArgs} */
export function parseDevArgs(args: string[]): ParsedDevArgs {
  const dev: { host?: string; port?: number } = {};
  let unsafeHost = false;
  const seen = new Set<string>();
  function nextValue(index: number, option: string): string {
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw argumentError(`${option} requires a value`);
    }
    return value;
  }
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? "";
    if (argument === "--unsafe-host") {
      if (unsafeHost) throw argumentError("duplicate --unsafe-host option");
      unsafeHost = true;
      continue;
    }
    const equals = argument.indexOf("=");
    const option = equals < 0 ? argument : argument.slice(0, equals);
    const inline = equals < 0 ? undefined : argument.slice(equals + 1);
    if (option !== "--host" && option !== "--port") {
      throw argumentError("unknown dev option");
    }
    if (seen.has(option)) throw argumentError(`duplicate ${option} option`);
    seen.add(option);
    const value = inline ?? nextValue(index, option);
    if (inline === undefined) index += 1;
    if (value.length === 0) throw argumentError(`${option} requires a value`);
    if (option === "--host") {
      dev.host = value;
      continue;
    }
    if (!/^[0-9]+$/u.test(value)) throw argumentError("--port must be an integer");
    const port = Number(value);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
      throw argumentError("--port must be between 1 and 65535");
    }
    dev.port = port;
  }
  return {
    overrides: Object.keys(dev).length === 0 ? {} : { dev },
    unsafeHost,
  };
}

/** @param {string} host */
function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase();
  if (normalized === "localhost" || normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") {
    return true;
  }
  const octets = normalized.split(".");
  return (
    octets.length === 4 &&
    octets[0] === "127" &&
    octets.every((octet) => /^[0-9]{1,3}$/u.test(octet) && Number(octet) <= 255)
  );
}

/** @param {unknown} error */
function normalizedError(error: unknown): Error {
  return error instanceof Error ? error : new Error("development rebuild failed safely");
}

/** @param {unknown} result */
function rebuildValidationError(result: unknown): Error {
  const error = new Error("development rebuild did not pass validation");
  error.name = "PublisherDevRebuildError";
  if (result !== null && typeof result === "object" && "errors" in result) {
    Object.defineProperty(error, "diagnostics", { value: result.errors, enumerable: false });
  }
  return error;
}

/**
 * @param {Awaited<ReturnType<typeof runBuildCommand>>} result
 * @returns {result is Awaited<ReturnType<typeof runBuildCommand>> & {indexPath: string, outputDir: string}}
 */
function isCompletedBuild(result: Awaited<ReturnType<typeof runBuildCommand>>): result is Awaited<
  ReturnType<typeof runBuildCommand>
> & {
  indexPath: string;
  outputDir: string;
} {
  return (
    result.exitCode === 0 &&
    "indexPath" in result &&
    typeof result.indexPath === "string" &&
    "outputDir" in result &&
    typeof result.outputDir === "string"
  );
}

/** @param {PublisherDevErrorEvent} event */
function defaultRebuildReporter(event: PublisherDevErrorEvent): void {
  const code =
    "code" in event.error && typeof event.error.code === "string"
      ? event.error.code
      : event.error.name;
  console.error(`remote-skills dev ${event.context.phase} failed (${code})`);
}

type ScanScope =
  | { kind: "source" | "candidate" | "file" }
  | { kind: "skill"; root: string; ignore: ReturnType<typeof createSkillIgnorePolicy> };
type ScanInputs = {
  snapshot: NonNullable<Awaited<ReturnType<typeof createAuthoringProjectSnapshot>>>;
  fileBytes: number;
};

async function fingerprintTree(
  hash: Hash,
  root: string,
  relative: string,
  scope: ScanScope,
  inputs: ScanInputs,
): Promise<BigIntStats | undefined> {
  const absolute = path.join(root, relative);
  let stats: BigIntStats;
  try {
    stats = await lstat(absolute, { bigint: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      // A missing source root is observable source state, not a failed scan.
      hash.update(`${relative}\0missing\0`);
      return;
    }
    throw error;
  }
  // Directory membership is represented by included children, not ignored-child timestamps.
  hash.update(`${relative}\0${stats.dev}\0${stats.ino}\0${stats.mode}\0`);
  if (!stats.isDirectory()) {
    hash.update(`${stats.nlink}\0${stats.size}\0${stats.mtimeNs}\0${stats.ctimeNs}\0`);
    return stats;
  }
  if (scope.kind === "file" || stats.isSymbolicLink()) return stats;
  let childScope = scope;
  if (scope.kind === "candidate") {
    const markdown = await fingerprintTree(
      hash,
      root,
      path.join(relative, "SKILL.md"),
      { kind: "file" },
      inputs,
    );
    // A directory without a regular SKILL.md is not a publisher skill candidate.
    if (!markdown?.isFile() || markdown.isSymbolicLink()) return stats;
    const ignorePath = path.join(relative, ".skillignore").split(path.sep).join("/");
    const ignore = await readAuthoringProjectFile(inputs.snapshot, ignorePath, inputs.fileBytes);
    if (
      (ignore.kind !== "file" && ignore.kind !== "missing") ||
      (ignore.kind === "file" && !ignore.bytes)
    ) {
      throw new Error("development ignore policy could not be read safely");
    }
    hash.update(`${ignorePath}\0${ignore.kind}\0`);
    if (ignore.bytes) hash.update(ignore.bytes);
    childScope = {
      kind: "skill",
      root: relative,
      ignore: createSkillIgnorePolicy(ignore.kind === "file" ? ignore.bytes : undefined),
    };
  }
  const entries = await readdir(absolute, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const child = path.join(relative, entry.name);
    // Some filesystems do not populate dirent types; classify those without following links.
    const directory =
      entry.isDirectory() ||
      (!entry.isFile() &&
        !entry.isSymbolicLink() &&
        !entry.isBlockDevice() &&
        !entry.isCharacterDevice() &&
        !entry.isFIFO() &&
        !entry.isSocket() &&
        (await lstat(path.join(root, child))).isDirectory());
    const policyPath =
      childScope.kind === "skill"
        ? path.relative(childScope.root, child).split(path.sep).join("/")
        : entry.name;
    if (ignoredByDefaults(policyPath, directory)) continue;
    if (childScope.kind === "source" && !directory) continue;
    if (childScope.kind === "skill") {
      const portable = normalizePortableRelativePath(policyPath);
      if (portable && childScope.ignore(portable.path, directory)) continue;
    }
    await fingerprintTree(
      hash,
      root,
      child,
      childScope.kind === "source" ? { kind: "candidate" } : childScope,
      inputs,
    );
  }
  return stats;
}

async function sourceFingerprint(
  projectDir: string,
  overrides: ParsedDevArgs["overrides"],
): Promise<string> {
  const hash = createHash("sha256");
  const snapshot = await createAuthoringProjectSnapshot(projectDir);
  if (!snapshot) throw new Error("development project could not be scanned safely");
  return (async () => {
    const config = await loadPublisherConfig({ projectDir, overrides, snapshot });
    hash.update(JSON.stringify(config));
    for (const sourceRoot of [...config.sourceRoots].sort()) {
      await fingerprintTree(
        hash,
        projectDir,
        sourceRoot,
        { kind: "source" },
        {
          snapshot,
          fileBytes: config.limits.fileBytes,
        },
      );
    }
    if (!(await verifyAuthoringProjectSnapshot(snapshot))) {
      throw new Error("development inputs changed during the scan");
    }
    return hash.digest("hex");
  })().finally(async () => {
    if (!(await closeAuthoringProjectSnapshot(snapshot))) {
      throw new Error("development scan handles could not be closed");
    }
  });
}

/**
 * @param {{
 *   projectDir: string;
 *   args: string[];
 *   signal?: AbortSignal;
 *   onRebuildError?: (event: PublisherDevErrorEvent) => void;
 * }} options
 */
export async function runDevCommand(options: {
  projectDir: string;
  args: string[];
  signal?: AbortSignal;
  onRebuildError?: (event: PublisherDevErrorEvent) => void;
}): Promise<DevelopmentOrigin> {
  const parsed = parseDevArgs(options.args);
  let abortRequested = false;
  let listenerAttempted = false;
  let origin: Awaited<ReturnType<typeof startDevelopmentOrigin>> | undefined;
  let originClosePromise: Promise<void> | undefined;
  let originCloseError: Error | undefined;
  let closeRuntime: (() => Promise<void>) | undefined;
  const reportRebuildError = options.onRebuildError ?? defaultRebuildReporter;

  /** @param {Error} error @param {PublisherDevErrorEvent["context"]["phase"]} phase */
  function emitDevError(error: Error, phase: PublisherDevErrorEvent["context"]["phase"]): void {
    reportRebuildError({
      error,
      context: { phase },
      timestamp: new Date().toISOString(),
    });
  }

  function abortedError() {
    return new ConfigValidationError(["/signal development server start was aborted"]);
  }

  function throwIfAborted() {
    if (abortRequested) throw abortedError();
  }

  function beginOriginClose() {
    if (!origin || originClosePromise) return originClosePromise;
    originClosePromise = origin.close().catch((error) => {
      originCloseError = normalizedError(error);
    });
    return originClosePromise;
  }

  function onAbort() {
    abortRequested = true;
    if (closeRuntime) {
      closeRuntime().catch(() => {
        // Runtime shutdown reports a structured error before rejecting.
      });
    } else {
      beginOriginClose();
    }
  }

  function detachAbortListener() {
    if (listenerAttempted) options.signal?.removeEventListener("abort", onAbort);
  }

  try {
    listenerAttempted = true;
    options.signal?.addEventListener("abort", onAbort, { once: true });
    abortRequested = options.signal?.aborted ?? false;
    throwIfAborted();

    const config = await loadPublisherConfig({
      projectDir: options.projectDir,
      overrides: parsed.overrides,
    });
    throwIfAborted();
    if (!isLoopbackHost(config.dev.host) && !parsed.unsafeHost) {
      throw new ConfigValidationError([
        "/dev/host binding a non-loopback host requires --unsafe-host",
      ]);
    }

    // Keep the pre-build observation so the first runtime scan also detects startup edits.
    let fingerprint = await sourceFingerprint(options.projectDir, parsed.overrides);
    throwIfAborted();
    const initialBuild = await runBuildCommand({ projectDir: options.projectDir, args: [] });
    throwIfAborted();
    if (!isCompletedBuild(initialBuild)) throw rebuildValidationError(initialBuild);
    const initialGeneration = await loadCompletedGeneration(initialBuild);
    throwIfAborted();
    origin = await startDevelopmentOrigin({
      host: config.dev.host,
      port: config.dev.port,
      generation: initialGeneration,
    });
    throwIfAborted();

    let closing = false;
    let debounceTimer: NodeJS.Timeout | undefined;
    let scanPromise: Promise<void> | undefined;

    async function rebuild() {
      if (closing) return;
      try {
        const build = await runBuildCommand({ projectDir: options.projectDir, args: [] });
        if (!isCompletedBuild(build)) {
          emitDevError(rebuildValidationError(build), "rebuild");
          return;
        }
        const generation = await loadCompletedGeneration(build);
        if (closing) return;
        origin?.switchGeneration(generation);
      } catch (error) {
        emitDevError(normalizedError(error), "rebuild");
      }
    }

    const rebuilder = createSingleFlightRebuilder(rebuild);

    function scheduleRebuild() {
      if (closing) return;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = undefined;
        rebuilder.request();
      }, 40);
    }

    const scanTimer = setInterval(() => {
      if (closing || scanPromise) return;
      scanPromise = (async () => {
        try {
          const nextFingerprint = await sourceFingerprint(options.projectDir, parsed.overrides);
          if (nextFingerprint !== fingerprint) {
            fingerprint = nextFingerprint;
            scheduleRebuild();
          }
        } catch (error) {
          emitDevError(normalizedError(error), "scan");
        }
      })().finally(() => {
        scanPromise = undefined;
      });
    }, 100);

    let resolveClosed = (_result: Promise<void>) => {};
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    // close-only callers may never observe closed; retain its failure without leaking a rejection.
    closed.catch(() => {});
    let closePromise: Promise<void> | undefined;
    async function close(): Promise<void> {
      closePromise ??= (async () => {
        closing = true;
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = undefined;
        clearInterval(scanTimer);
        if (scanPromise) await scanPromise;
        await rebuilder.close();
        beginOriginClose();
        if (originClosePromise) await originClosePromise;
        if (originCloseError) throw originCloseError;
      })()
        .catch((error) => {
          emitDevError(normalizedError(error), "shutdown");
          throw error;
        })
        .finally(() => {
          detachAbortListener();
        });
      resolveClosed(closePromise);
      return closePromise;
    }
    closeRuntime = close;
    throwIfAborted();

    return {
      host: origin.host,
      port: origin.port,
      origin: origin.origin,
      closed,
      close,
    };
  } catch (error) {
    beginOriginClose();
    if (originClosePromise) await originClosePromise;
    try {
      detachAbortListener();
    } catch (detachError) {
      if (!originCloseError) originCloseError = normalizedError(detachError);
    }
    if (originCloseError) {
      emitDevError(originCloseError, "shutdown");
      if (!abortRequested) {
        throw new AggregateError(
          [normalizedError(error), originCloseError],
          "development server startup and cleanup failed",
        );
      }
    }
    if (abortRequested) throw abortedError();
    throw error;
  }
}

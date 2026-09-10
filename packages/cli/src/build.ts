import path from "node:path";

import {
  closeAuthoringProjectSnapshot,
  createAuthoringProjectSnapshot,
  isProjectRelativePath,
  validateAuthoringProject,
} from "@remote-skills/core/authoring";
import { buildPublisherOutput } from "@remote-skills/core/build";
import { ConfigValidationError } from "@remote-skills/core/config-schema";

import { loadPublisherConfig } from "./config.ts";

export type CommandDiagnostic = Awaited<
  ReturnType<typeof validateAuthoringProject>
>["errors"][number];
export type BuildCommandResult = {
  exitCode: number;
  valid: boolean;
  skills: unknown[];
  errors: CommandDiagnostic[];
  warnings: CommandDiagnostic[];
  outputDir?: string;
  indexPath?: string;
};

export type ParsedBuildArgs = {
  overrides: { format?: "tar.gz" | "zip"; outDir?: string };
  forceArchive?: boolean;
  priorOutputDir?: string;
  prune?: Record<string, string[]>;
};

/** @param {string} message */
function argumentError(message: string): ConfigValidationError {
  return new ConfigValidationError([`/arguments ${message}`]);
}

/** @param {string[]} args @returns {ParsedBuildArgs} */
export function parseBuildArgs(args: string[]): ParsedBuildArgs {
  const result: {
    forceArchive: boolean;
    overrides: { format?: "tar.gz" | "zip"; outDir?: string };
    prune: Record<string, string[]>;
    priorOutputDir?: string;
  } = {
    forceArchive: false,
    overrides: {},
    prune: {},
  };
  const seen = new Set<string>();
  function nextValue(index: number, option: string): string {
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--"))
      throw argumentError(`${option} requires a value`);
    return value;
  }
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? "";
    if (argument === "--archive") {
      if (seen.has("archive")) throw argumentError("duplicate --archive option");
      seen.add("archive");
      result.forceArchive = true;
      continue;
    }
    const equals = argument.indexOf("=");
    const option = equals < 0 ? argument : argument.slice(0, equals);
    const inline = equals < 0 ? undefined : argument.slice(equals + 1);
    if (["--format", "--out-dir", "--prior-output", "--prune"].includes(option)) {
      const value = inline ?? nextValue(index, option);
      if (inline === undefined) index += 1;
      if (option !== "--prune" && seen.has(option))
        throw argumentError(`duplicate ${option} option`);
      if (option !== "--prune") seen.add(option);
      if (option === "--format") {
        if (value !== "tar.gz" && value !== "zip")
          throw argumentError("--format must be tar.gz or zip");
        result.overrides.format = value;
      } else if (option === "--out-dir") {
        if (!isProjectRelativePath(value))
          throw argumentError("--out-dir must remain inside the project");
        result.overrides.outDir = value;
      } else if (option === "--prior-output") {
        if (!isProjectRelativePath(value))
          throw argumentError("--prior-output must remain inside the project");
        result.priorOutputDir = value;
      } else {
        const separator = value.indexOf("@");
        if (separator < 1 || separator === value.length - 1) {
          throw argumentError("--prune must be SKILL@VERSION");
        }
        const skillName = value.slice(0, separator);
        const version = value.slice(separator + 1);
        const versions = Object.hasOwn(result.prune, skillName)
          ? (result.prune[skillName] ?? [])
          : [];
        versions.push(version);
        result.prune[skillName] = versions;
      }
      continue;
    }
    throw argumentError("unknown build option");
  }
  const parsed: ParsedBuildArgs = { overrides: result.overrides };
  if (result.forceArchive) parsed.forceArchive = true;
  if (result.priorOutputDir !== undefined) parsed.priorOutputDir = result.priorOutputDir;
  if (Object.keys(result.prune).length > 0) parsed.prune = result.prune;
  return parsed;
}

/** @param {{projectDir: string, args: string[]}} options */
export async function runBuildCommand(options: {
  projectDir: string;
  args: string[];
}): Promise<BuildCommandResult> {
  const parsed = parseBuildArgs(options.args);
  const snapshot = await createAuthoringProjectSnapshot(options.projectDir);
  if (!snapshot) throw new ConfigValidationError(["/project must be an accessible directory"]);
  const prepared = await (async () => {
    const config = await loadPublisherConfig({
      projectDir: options.projectDir,
      overrides: parsed.overrides,
      snapshot,
    });
    const validation = await validateAuthoringProject({
      projectDir: options.projectDir,
      config,
      snapshot,
    });
    return { config, validation };
  })().then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  if (!snapshot.closed && !(await closeAuthoringProjectSnapshot(snapshot))) {
    throw new ConfigValidationError(["/config could not be read safely"]);
  }
  if ("error" in prepared) throw prepared.error;
  const { config, validation } = prepared.value;
  if (!validation.valid) return { ...validation, exitCode: 1 };
  const buildOptions = {
    projectDir: options.projectDir,
    config,
    validation,
    ...(parsed.forceArchive === undefined ? {} : { forceArchive: parsed.forceArchive }),
    ...(parsed.priorOutputDir === undefined
      ? {}
      : { priorOutputDir: path.resolve(options.projectDir, parsed.priorOutputDir) }),
    ...(parsed.prune === undefined ? {} : { prune: parsed.prune }),
  };
  const build = await buildPublisherOutput(buildOptions);
  return { ...validation, ...build, exitCode: 0 };
}

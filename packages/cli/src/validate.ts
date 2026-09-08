import {
  closeAuthoringProjectSnapshot,
  createAuthoringProjectSnapshot,
  validateAuthoringProject,
} from "@remote-skills/core/authoring";
import { ConfigValidationError } from "@remote-skills/core/config-schema";
import type { BuildCommandResult } from "./build.ts";
import { loadPublisherConfig } from "./config.ts";

/** @param {string[]} args */
export function parseValidateArgs(args: string[]): { strict?: boolean } {
  const parsed: { strict?: boolean } = {};
  for (const argument of args) {
    if (argument === "--strict") {
      parsed.strict = true;
      continue;
    }
    throw new ConfigValidationError([`/arguments unknown validate option: ${argument}`]);
  }
  return parsed;
}

/** @param {{projectDir: string, args: string[]}} options */
export async function runValidateCommand(options: {
  projectDir: string;
  args: string[];
}): Promise<Omit<BuildCommandResult, "outputDir" | "indexPath">> {
  const overrides = parseValidateArgs(options.args);
  const snapshot = await createAuthoringProjectSnapshot(options.projectDir);
  if (!snapshot) throw new ConfigValidationError(["/project must be an accessible directory"]);
  const outcome = await (async () => {
    const config = await loadPublisherConfig({
      projectDir: options.projectDir,
      overrides,
      snapshot,
    });
    const result = await validateAuthoringProject({
      projectDir: options.projectDir,
      config,
      snapshot,
    });
    return { ...result, exitCode: result.valid ? 0 : 1 };
  })().then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  if (!(await closeAuthoringProjectSnapshot(snapshot))) {
    throw new ConfigValidationError(["/config could not be read safely"]);
  }
  if ("error" in outcome) throw outcome.error;
  return outcome.value;
}

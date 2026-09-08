import type { validateAuthoringProject } from "@remote-skills/core/authoring";

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


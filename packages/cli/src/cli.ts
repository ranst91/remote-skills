#!/usr/bin/env node

import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isProjectRelativePath } from "@remote-skills/core/authoring";
import { PublisherBuildError } from "@remote-skills/core/build";
import { ConfigValidationError } from "@remote-skills/core/config-schema";

import { runBuildCommand } from "./build.ts";
import { runDevCommand } from "./dev.ts";
import { runValidateCommand } from "./validate.ts";
import { runVerifyCommand } from "./verify.ts";
import { PublisherVerifyError } from "./verify-errors.ts";

export const CLI_EXIT_CODES = Object.freeze({ success: 0, failure: 1, usage: 2 });

const packageMetadata: unknown = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
if (
  typeof packageMetadata !== "object" ||
  packageMetadata === null ||
  !("version" in packageMetadata) ||
  typeof packageMetadata.version !== "string"
)
  throw new Error("CLI package version is missing");
const VERSION = packageMetadata.version;
const HELP_TEXT = `Remote Skills

Usage:
  remote-skills <command> [options]

Commands:
  validate            Validate the current publisher project
  build               Build deploy-ready static origin files
  dev                 Build and serve a loopback development origin
  verify <origin>     Verify every artifact at a deployed origin

Options:
  -h, --help          Show this help
  -V, --version       Show the CLI version

Verify budgets (positive integers):
  --catalog-bytes N   Maximum catalog bytes (default: 1048576)
  --archive-bytes N   Maximum compressed artifact bytes (default: 52428800)
  --extracted-bytes N Maximum extracted bytes per archive (default: 104857600)
  --files N           Maximum files per archive (default: 1000)
  --file-bytes N      Maximum bytes per file (default: 10485760)
`;

type CliOptions = {
  args: string[];
  projectDir: string;
  env: Readonly<Record<string, string | undefined>>;
  signal?: AbortSignal;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
};
type CliCommands = {
  validate?: typeof runValidateCommand;
  build?: typeof runBuildCommand;
  dev?: (options: {
    projectDir: string;
    args: string[];
    signal?: AbortSignal;
  }) => Promise<{ origin: string; closed: Promise<void> }>;
  verify?: typeof runVerifyCommand;
};

const DIAGNOSTIC_CODES = new Set([
  "archive_unsafe",
  "artifact_unsupported",
  "authentication_failed",
  "authorization_denied",
  "catalog_invalid",
  "configuration_invalid",
  "digest_mismatch",
  "limit_exceeded",
  "origin_unavailable",
  "path_invalid",
  "policy_denied",
  "request_timeout",
  "resource_not_found",
  "unsupported_schema",
]);

function renderDiagnostic(
  severity: "error" | "warning",
  diagnostic: { code: string; context: object },
): string {
  const code = DIAGNOSTIC_CODES.has(diagnostic.code) ? diagnostic.code : "internal_error";
  const fields: string[] = [];
  // Do not serialize the diagnostic itself: messages, causes, headers and URLs are untrusted.
  for (const key of ["skill_name", "path", "field", "limit", "status"] as const) {
    const value: unknown = Object.getOwnPropertyDescriptor(diagnostic.context, key)?.value;
    if (key === "status") {
      if (typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599)
        fields.push(`${key}=${value}`);
      continue;
    }
    if (typeof value !== "string" || value.length > 1024) continue;
    let safe: string | undefined;
    if (key === "skill_name" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value) && value.length <= 64)
      safe = value;
    if (key === "path" && isProjectRelativePath(value)) safe = value;
    if (key === "field" || key === "limit") {
      if (/^(?:headers[.[]|--header(?:-env)?$)/u.test(value)) safe = "headers";
      else if (/^(?:\/|--)?[A-Za-z][A-Za-z0-9_./[\]-]*$/u.test(value)) safe = value;
    }
    if (safe !== undefined) fields.push(`${key}=${JSON.stringify(safe)}`);
  }
  return `remote-skills: ${severity} ${code}${fields.length === 0 ? "" : ` ${fields.join(" ")}`}\n`;
}

export async function dispatchCli(
  options: CliOptions,
  commands: CliCommands = {},
): Promise<number> {
  if (
    options.args.length === 0 ||
    options.args[0] === "help" ||
    options.args[0] === "--help" ||
    options.args[0] === "-h"
  ) {
    options.stdout(HELP_TEXT);
    return CLI_EXIT_CODES.success;
  }
  if (options.args[0] === "--version" || options.args[0] === "-V") {
    options.stdout(`${VERSION}\n`);
    return CLI_EXIT_CODES.success;
  }

  const [command, ...args] = options.args;
  try {
    if (command === "validate" && commands.validate) {
      const result = await commands.validate({ projectDir: options.projectDir, args });
      for (const diagnostic of [...result.errors, ...result.warnings])
        options.stderr(renderDiagnostic(diagnostic.severity, diagnostic));
      return result.exitCode === CLI_EXIT_CODES.success
        ? CLI_EXIT_CODES.success
        : CLI_EXIT_CODES.failure;
    }
    if (command === "build" && commands.build) {
      const result = await commands.build({ projectDir: options.projectDir, args });
      for (const diagnostic of [...result.errors, ...result.warnings])
        options.stderr(renderDiagnostic(diagnostic.severity, diagnostic));
      return result.exitCode === CLI_EXIT_CODES.success
        ? CLI_EXIT_CODES.success
        : CLI_EXIT_CODES.failure;
    }
    if (command === "dev" && commands.dev) {
      const devOptions = {
        projectDir: options.projectDir,
        args,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      };
      const result = await commands.dev(devOptions);
      options.stdout(`${result.origin}\n`);
      await result.closed;
      return CLI_EXIT_CODES.success;
    }
    if (command === "verify" && commands.verify) {
      const result = await commands.verify({ args, env: options.env });
      for (const diagnostic of result.failures)
        options.stderr(renderDiagnostic("error", diagnostic));
      return result.exitCode === CLI_EXIT_CODES.success
        ? CLI_EXIT_CODES.success
        : CLI_EXIT_CODES.failure;
    }
  } catch (error) {
    if (
      error instanceof ConfigValidationError ||
      error instanceof PublisherBuildError ||
      error instanceof PublisherVerifyError
    ) {
      options.stderr(renderDiagnostic("error", error));
      return error.code === "configuration_invalid" ? CLI_EXIT_CODES.usage : CLI_EXIT_CODES.failure;
    }
    if (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "configuration_invalid"
    ) {
      options.stderr("remote-skills: configuration_invalid\n");
      return CLI_EXIT_CODES.usage;
    }
    options.stderr("remote-skills: internal_error\n");
    return CLI_EXIT_CODES.failure;
  }

  options.stderr(`remote-skills: unknown command: ${command}\n`);
  return CLI_EXIT_CODES.usage;
}

const DEFAULT_COMMANDS = Object.freeze({
  validate: runValidateCommand,
  build: runBuildCommand,
  dev: runDevCommand,
  verify: runVerifyCommand,
});

async function runEntrypoint() {
  const controller = new AbortController();
  const handleSignal = () => controller.abort();
  const handlesSignals = process.argv[2] === "dev";
  if (handlesSignals) {
    process.once("SIGINT", handleSignal);
    process.once("SIGTERM", handleSignal);
  }
  try {
    return await dispatchCli(
      {
        args: process.argv.slice(2),
        projectDir: process.cwd(),
        env: process.env,
        signal: controller.signal,
        stdout: (text) => {
          process.stdout.write(text);
        },
        stderr: (text) => {
          process.stderr.write(text);
        },
      },
      DEFAULT_COMMANDS,
    );
  } finally {
    if (handlesSignals) {
      process.removeListener("SIGINT", handleSignal);
      process.removeListener("SIGTERM", handleSignal);
    }
  }
}

const entrypoint = process.argv[1]
  ? realpathSync(path.resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))
  : false;
if (entrypoint) process.exitCode = await runEntrypoint();

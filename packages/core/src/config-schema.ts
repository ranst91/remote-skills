// @ts-check

import { Ajv2020 } from "ajv/dist/2020.js";

export const CONFIG_SCHEMA_ID = "https://remote-skills.dev/schemas/config/0.0.1.json";

export type PublisherConfig = {
  $schema: string;
  sourceRoots: string[];
  outDir: string;
  format: "tar.gz" | "zip";
  strict: boolean;
  limits: {
    catalogBytes: number;
    archiveBytes: number;
    extractedBytes: number;
    files: number;
    fileBytes: number;
  };
  dev: { host: string; port: number };
};

export const DEFAULT_CONFIG = Object.freeze({
  $schema: CONFIG_SCHEMA_ID,
  sourceRoots: Object.freeze(["skills"]),
  outDir: "dist",
  format: "tar.gz",
  strict: false,
  limits: Object.freeze({
    catalogBytes: 1_048_576,
    archiveBytes: 52_428_800,
    extractedBytes: 104_857_600,
    files: 1_000,
    fileBytes: 10_485_760,
  }),
  dev: Object.freeze({ host: "127.0.0.1", port: 8_787 }),
});

export const REMOTE_SKILLS_CONFIG_SCHEMA = Object.freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: CONFIG_SCHEMA_ID,
  title: "Remote Skills publisher configuration",
  description: "Strict declarative configuration for remote-skills.json.",
  type: "object",
  additionalProperties: false,
  properties: {
    $schema: {
      type: "string",
      const: CONFIG_SCHEMA_ID,
      default: CONFIG_SCHEMA_ID,
    },
    sourceRoots: {
      type: "array",
      items: { type: "string", minLength: 1 },
      minItems: 1,
      uniqueItems: true,
      default: ["skills"],
    },
    outDir: { type: "string", minLength: 1, default: "dist" },
    format: { type: "string", enum: ["tar.gz", "zip"], default: "tar.gz" },
    strict: { type: "boolean", default: false },
    limits: {
      type: "object",
      additionalProperties: false,
      default: {},
      properties: {
        catalogBytes: { type: "integer", minimum: 1, default: 1_048_576 },
        archiveBytes: { type: "integer", minimum: 1, default: 52_428_800 },
        extractedBytes: { type: "integer", minimum: 1, default: 104_857_600 },
        files: { type: "integer", minimum: 1, default: 1_000 },
        fileBytes: { type: "integer", minimum: 1, default: 10_485_760 },
      },
    },
    dev: {
      type: "object",
      additionalProperties: false,
      default: {},
      properties: {
        host: { type: "string", minLength: 1, default: "127.0.0.1" },
        port: { type: "integer", minimum: 1, maximum: 65_535, default: 8_787 },
      },
    },
  },
});

const ajv = new Ajv2020({ allErrors: true, strict: true, useDefaults: true });
/** @type {import("ajv").ValidateFunction<PublisherConfig>} */
const validate: import("ajv").ValidateFunction<PublisherConfig> = ajv.compile(
  REMOTE_SKILLS_CONFIG_SCHEMA,
);
const schemaAjv = new Ajv2020({ allErrors: true, strict: true });
const validateSchema = schemaAjv.compile(REMOTE_SKILLS_CONFIG_SCHEMA);

export class ConfigValidationError extends Error {
  readonly code: "configuration_invalid";
  readonly context: { field: string };
  readonly issues: string[];
  readonly retryable: false;

  /** @param {string[]} issues */
  constructor(issues: string[]) {
    super(`remote-skills.json is invalid: ${issues.join("; ")}`);
    this.name = "ConfigValidationError";
    this.code = "configuration_invalid";
    this.retryable = false;
    this.context = { field: issues[0]?.split(/\s/u, 1)[0] ?? "/" };
    this.issues = issues;
  }
}

/** @param {import("ajv").ErrorObject[] | null | undefined} errors */
function issuesFrom(errors: import("ajv").ErrorObject[] | null | undefined) {
  return (errors ?? []).map((error) => {
    const property =
      error.keyword === "additionalProperties" &&
      typeof error.params.additionalProperty === "string"
        ? `${error.instancePath}/${error.params.additionalProperty
            .replaceAll("~", "~0")
            .replaceAll("/", "~1")}`
        : error.instancePath || "/";
    return `${property} ${error.message ?? "is invalid"}`;
  });
}

/** @param {unknown} input @returns {PublisherConfig} */
export function validateConfig(input: unknown): PublisherConfig {
  const candidate = structuredClone(input);
  if (validate(candidate)) return candidate;

  throw new ConfigValidationError(issuesFrom(validate.errors));
}

/** @param {unknown} input */
export function validateAgainstConfigSchema(input: unknown) {
  if (validateSchema(input)) return;

  throw new ConfigValidationError(issuesFrom(validateSchema.errors));
}

export function serializedConfigSchema() {
  return `${JSON.stringify(REMOTE_SKILLS_CONFIG_SCHEMA, null, 2)}\n`;
}

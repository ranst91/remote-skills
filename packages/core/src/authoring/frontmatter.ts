// @ts-check

import { isMap, isScalar, isSeq, parseDocument } from "yaml";

import { authoringDiagnostic } from "./diagnostics.ts";

const ALLOWED_FRONTMATTER_FIELDS = new Set([
  "name",
  "description",
  "license",
  "compatibility",
  "metadata",
  "allowed-tools",
]);
const CANONICAL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const UNKNOWN_FRONTMATTER_FIELD = "[unknown-field]";
const FRONTMATTER_NODE_LIMIT = 100_000;

/** @param {unknown} value @returns {value is {[key: string]: unknown}} */
function isMapping(value: unknown): value is { [key: string]: unknown } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * @param {string} sourcePath
 * @param {string} field
 * @param {string} message
 * @param {string | undefined} skillName
 * @returns {import("./diagnostics.ts").AuthoringDiagnostic}
 */
function errorDiagnostic(
  sourcePath: string,
  field: string,
  message: string,
  skillName: string | undefined,
): import("./diagnostics.ts").AuthoringDiagnostic {
  return authoringDiagnostic("error", "catalog_invalid", message, {
    field,
    path: sourcePath,
    ...(skillName ? { skill_name: skillName } : {}),
  });
}

/** @param {string} value */
function codePointLength(value: string) {
  return Array.from(value).length;
}

/** @param {unknown} value @returns {value is string} */
function isUnicodeScalarString(value: unknown): value is string {
  return typeof value === "string" && value.isWellFormed();
}

/** @param {unknown} value @param {{count: number}} budget */
function inspectScalarValues(value: unknown, budget: { count: number }) {
  /** @type {({kind: "value", value: unknown} | {kind: "array", value: unknown[], index: number} | {kind: "mapping", value: {[key: string]: unknown}, keys: string[], index: number})[]} */
  const pending: (
    | { kind: "value"; value: unknown }
    | { kind: "array"; value: unknown[]; index: number }
    | { kind: "mapping"; value: { [key: string]: unknown }; keys: string[]; index: number }
  )[] = [{ kind: "value", value }];
  while (pending.length > 0) {
    const frame = pending.pop();
    if (!frame) continue;
    if (frame.kind === "array") {
      if (frame.index >= frame.value.length) continue;
      pending.push({ ...frame, index: frame.index + 1 });
      pending.push({ kind: "value", value: frame.value[frame.index] });
      continue;
    }
    if (frame.kind === "mapping") {
      if (frame.index >= frame.keys.length) continue;
      const key = frame.keys[frame.index];
      if (!key || !isUnicodeScalarString(key)) return "invalid";
      pending.push({ ...frame, index: frame.index + 1 });
      pending.push({ kind: "value", value: frame.value[key] });
      continue;
    }
    budget.count += 1;
    if (budget.count > FRONTMATTER_NODE_LIMIT) return "limit";
    const candidate = frame.value;
    if (typeof candidate === "string") {
      if (!isUnicodeScalarString(candidate)) return "invalid";
      continue;
    }
    if (Array.isArray(candidate)) {
      pending.push({ kind: "array", value: candidate, index: 0 });
      continue;
    }
    if (isMapping(candidate)) {
      pending.push({ kind: "mapping", value: candidate, keys: Object.keys(candidate), index: 0 });
    }
  }
  return "valid";
}

/** @param {unknown} root */
function frontmatterTreeExceedsNodeLimit(root: unknown) {
  /** @type {({kind: "node", value: unknown} | {kind: "sequence", items: unknown[], index: number} | {kind: "map", items: {key?: unknown, value?: unknown}[], index: number})[]} */
  const pending: (
    | { kind: "node"; value: unknown }
    | { kind: "sequence"; items: unknown[]; index: number }
    | { kind: "map"; items: { key?: unknown; value?: unknown }[]; index: number }
  )[] = [{ kind: "node", value: root }];
  let count = 0;
  while (pending.length > 0) {
    const frame = pending.pop();
    if (!frame) continue;
    if (frame.kind === "sequence") {
      if (frame.index >= frame.items.length) continue;
      pending.push({ ...frame, index: frame.index + 1 });
      pending.push({ kind: "node", value: frame.items[frame.index] });
      continue;
    }
    if (frame.kind === "map") {
      if (frame.index >= frame.items.length) continue;
      const pair = frame.items[frame.index];
      pending.push({ ...frame, index: frame.index + 1 });
      if (pair) {
        pending.push({ kind: "node", value: pair.value });
        pending.push({ kind: "node", value: pair.key });
      }
      continue;
    }
    if (frame.value === null || frame.value === undefined) continue;
    count += 1;
    if (count > FRONTMATTER_NODE_LIMIT) return true;
    if (isSeq(frame.value)) {
      pending.push({ kind: "sequence", items: frame.value.items, index: 0 });
    } else if (isMap(frame.value)) {
      pending.push({ kind: "map", items: frame.value.items, index: 0 });
    }
  }
  return false;
}

/**
 * @param {string | Uint8Array} source
 * @param {{directoryName: string, sourcePath: string}} options
 */
export function validateSkillMarkdown(
  source: string | Uint8Array,
  options: { directoryName: string; sourcePath: string },
) {
  let text: string;
  try {
    text =
      typeof source === "string"
        ? source
        : new TextDecoder("utf-8", { fatal: true }).decode(source);
  } catch {
    return {
      skill: null,
      diagnostics: [
        errorDiagnostic(
          options.sourcePath,
          "SKILL.md",
          "SKILL.md must contain valid UTF-8",
          options.directoryName,
        ),
      ],
    };
  }
  const match = /^---\r?\n(?<frontmatter>[\s\S]*?)\r?\n---(?:\r?\n|$)(?<body>[\s\S]*)$/u.exec(text);
  if (!match?.groups) {
    return {
      skill: null,
      diagnostics: [
        errorDiagnostic(
          options.sourcePath,
          "SKILL.md.frontmatter",
          "SKILL.md must begin with YAML frontmatter",
          options.directoryName,
        ),
      ],
    };
  }
  const frontmatterSource = match.groups.frontmatter ?? "";
  const body = match.groups.body ?? "";

  let parsed: unknown;
  let metadataKeysAreStrings = true;
  try {
    const document = parseDocument(frontmatterSource, {
      prettyErrors: false,
      schema: "core",
      uniqueKeys: true,
    });
    if (document.errors.length > 0 || document.warnings.length > 0) {
      throw new Error("invalid YAML frontmatter");
    }
    if (frontmatterTreeExceedsNodeLimit(document.contents)) {
      return {
        skill: null,
        diagnostics: [
          authoringDiagnostic(
            "error",
            "limit_exceeded",
            "SKILL.md frontmatter exceeds the validation node limit",
            {
              limit: "frontmatterNodes",
              path: options.sourcePath,
              skill_name: options.directoryName,
            },
          ),
        ],
      };
    }
    if (isMap(document.contents)) {
      if (
        document.contents.items.some(
          ({ key }) =>
            !isScalar(key) ||
            typeof key.value !== "string" ||
            !ALLOWED_FRONTMATTER_FIELDS.has(key.value),
        )
      ) {
        return {
          skill: null,
          diagnostics: [
            errorDiagnostic(
              options.sourcePath,
              UNKNOWN_FRONTMATTER_FIELD,
              "SKILL.md frontmatter contains a field outside the Agent Skills specification",
              options.directoryName,
            ),
          ],
        };
      }
      const metadataPair = document.contents.items.find(
        ({ key }) => isScalar(key) && key.value === "metadata",
      );
      if (metadataPair && isMap(metadataPair.value)) {
        metadataKeysAreStrings = metadataPair.value.items.every(
          ({ key }) => isScalar(key) && isUnicodeScalarString(key.value),
        );
      }
    }
    if (!metadataKeysAreStrings) {
      return {
        skill: null,
        diagnostics: [
          errorDiagnostic(
            options.sourcePath,
            "metadata",
            "metadata must map non-empty string keys to string values",
            options.directoryName,
          ),
        ],
      };
    }
    parsed = document.toJS({ maxAliasCount: 0 });
  } catch {
    return {
      skill: null,
      diagnostics: [
        errorDiagnostic(
          options.sourcePath,
          "SKILL.md.frontmatter",
          "SKILL.md frontmatter must be valid YAML",
          options.directoryName,
        ),
      ],
    };
  }

  if (!isMapping(parsed)) {
    return {
      skill: null,
      diagnostics: [
        errorDiagnostic(
          options.sourcePath,
          "SKILL.md.frontmatter",
          "SKILL.md frontmatter must be a mapping",
          options.directoryName,
        ),
      ],
    };
  }

  /** @type {import("./diagnostics.ts").AuthoringDiagnostic[]} */
  const diagnostics: import("./diagnostics.ts").AuthoringDiagnostic[] = [];
  const scalarBudget = { count: 0 };

  for (const [field, value] of Object.entries(parsed)) {
    const scalarInspection = inspectScalarValues(value, scalarBudget);
    if (scalarInspection === "limit") {
      diagnostics.push(
        authoringDiagnostic(
          "error",
          "limit_exceeded",
          "SKILL.md frontmatter exceeds the validation node limit",
          {
            limit: "frontmatterNodes",
            path: options.sourcePath,
            skill_name: options.directoryName,
          },
        ),
      );
      break;
    }
    if (scalarInspection === "invalid") {
      diagnostics.push(
        errorDiagnostic(
          options.sourcePath,
          field,
          "frontmatter strings must contain only Unicode scalar values",
          options.directoryName,
        ),
      );
    }
  }
  if (diagnostics.length > 0) return { skill: null, diagnostics };

  const { name, description, license, compatibility, metadata } = parsed;
  const allowedTools = parsed["allowed-tools"];

  if (
    !isUnicodeScalarString(name) ||
    codePointLength(name) < 1 ||
    codePointLength(name) > 64 ||
    !CANONICAL_NAME.test(name) ||
    name !== options.directoryName
  ) {
    diagnostics.push(
      errorDiagnostic(
        options.sourcePath,
        "name",
        "name must be 1-64 lowercase alphanumeric or hyphen characters and match its directory",
        options.directoryName,
      ),
    );
  }

  if (
    !isUnicodeScalarString(description) ||
    codePointLength(description.trim()) < 1 ||
    codePointLength(description) > 1_024
  ) {
    diagnostics.push(
      errorDiagnostic(
        options.sourcePath,
        "description",
        "description must be a non-empty string no longer than 1024 characters",
        options.directoryName,
      ),
    );
  }

  if (license !== undefined && !isUnicodeScalarString(license)) {
    diagnostics.push(
      errorDiagnostic(
        options.sourcePath,
        "license",
        "license must be a string",
        options.directoryName,
      ),
    );
  }

  if (
    compatibility !== undefined &&
    (!isUnicodeScalarString(compatibility) ||
      codePointLength(compatibility.trim()) < 1 ||
      codePointLength(compatibility) > 500)
  ) {
    diagnostics.push(
      errorDiagnostic(
        options.sourcePath,
        "compatibility",
        "compatibility must be a non-empty string no longer than 500 characters",
        options.directoryName,
      ),
    );
  }

  if (
    metadata !== undefined &&
    (!isMapping(metadata) ||
      Object.entries(metadata).some(
        ([key, value]) =>
          key.length === 0 || !isUnicodeScalarString(key) || !isUnicodeScalarString(value),
      ))
  ) {
    diagnostics.push(
      errorDiagnostic(
        options.sourcePath,
        "metadata",
        "metadata must map non-empty string keys to string values",
        options.directoryName,
      ),
    );
  }

  if (allowedTools !== undefined && !isUnicodeScalarString(allowedTools)) {
    diagnostics.push(
      errorDiagnostic(
        options.sourcePath,
        "allowed-tools",
        "allowed-tools must be a space-separated string",
        options.directoryName,
      ),
    );
  }

  if (
    diagnostics.length > 0 ||
    !isUnicodeScalarString(name) ||
    !isUnicodeScalarString(description)
  ) {
    return { skill: null, diagnostics };
  }

  return {
    skill: {
      name,
      description,
      frontmatter: parsed,
      body,
      sourcePath: options.sourcePath,
    },
    diagnostics,
  };
}

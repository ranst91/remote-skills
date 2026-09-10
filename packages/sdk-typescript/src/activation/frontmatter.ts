import { isMap, isScalar, isSeq, parseDocument } from "yaml";
import { RemoteSkillsError } from "../catalog/errors.ts";

const ALLOWED_FIELDS = new Set([
  "name",
  "description",
  "license",
  "compatibility",
  "metadata",
  "allowed-tools",
]);
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const FRONTMATTER_NODE_LIMIT = 100_000;
function invalid(field: string): never {
  throw new RemoteSkillsError("catalog_invalid", { field });
}
function frontmatterLimit(): never {
  throw new RemoteSkillsError("limit_exceeded", { limit: "frontmatterNodes" });
}
function plainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function unicodeString(value: unknown): value is string {
  return typeof value === "string" && value.isWellFormed();
}
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function frontmatterTreeExceedsNodeLimit(root: unknown): boolean {
  type Frame =
    | { kind: "node"; value: unknown }
    | { kind: "sequence"; items: unknown[]; index: number }
    | { kind: "map"; items: { key?: unknown; value?: unknown }[]; index: number };
  const pending: Frame[] = [{ kind: "node", value: root }];
  let count = 0;
  while (pending.length > 0) {
    const frame = pending.pop();
    if (frame === undefined) continue;
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
      if (pair !== undefined) {
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

export interface ParsedSkillMarkdown {
  readonly name: string;
  readonly description: string;
  readonly frontmatter: Readonly<Record<string, unknown>>;
  readonly instructions: string;
}

export function parseSkillMarkdown(bytes: Uint8Array, expectedName: string): ParsedSkillMarkdown {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    invalid("SKILL.md");
  }
  const match = /^---\r?\n(?<yaml>[\s\S]*?)\r?\n---(?:\r?\n|$)(?<body>[\s\S]*)$/u.exec(text);
  if (!match?.groups) invalid("SKILL.md.frontmatter");
  let value: unknown;
  try {
    const document = parseDocument(match.groups.yaml ?? "", {
      prettyErrors: false,
      schema: "core",
      uniqueKeys: true,
    });
    if (document.errors.length > 0 || document.warnings.length > 0 || !isMap(document.contents))
      invalid("SKILL.md.frontmatter");
    if (frontmatterTreeExceedsNodeLimit(document.contents)) frontmatterLimit();
    for (const pair of document.contents.items) {
      if (!isScalar(pair.key) || typeof pair.key.value !== "string")
        invalid("SKILL.md.frontmatter");
      if (!ALLOWED_FIELDS.has(pair.key.value)) invalid("[unknown-field]");
    }
    value = document.toJS({ maxAliasCount: 0 });
  } catch (error) {
    if (error instanceof RemoteSkillsError) throw error;
    invalid("SKILL.md.frontmatter");
  }
  if (!plainObject(value)) invalid("SKILL.md.frontmatter");
  const { name, description, license, compatibility, metadata } = value;
  const allowedTools = value["allowed-tools"];
  if (
    !unicodeString(name) ||
    [...name].length < 1 ||
    [...name].length > 64 ||
    !NAME.test(name) ||
    name !== expectedName
  )
    invalid("name");
  if (
    !unicodeString(description) ||
    description.trim().length === 0 ||
    [...description].length > 1_024
  )
    invalid("description");
  if (license !== undefined && !unicodeString(license)) invalid("license");
  if (
    compatibility !== undefined &&
    (!unicodeString(compatibility) ||
      compatibility.trim().length === 0 ||
      [...compatibility].length > 500)
  )
    invalid("compatibility");
  if (
    metadata !== undefined &&
    (!plainObject(metadata) ||
      Object.entries(metadata).some(
        ([key, item]) => key.length === 0 || !unicodeString(key) || !unicodeString(item),
      ))
  )
    invalid("metadata");
  if (allowedTools !== undefined && !unicodeString(allowedTools)) invalid("allowed-tools");
  let instructions = match.groups.body ?? "";
  if (instructions.startsWith("\r\n")) instructions = instructions.slice(2);
  else if (instructions.startsWith("\n")) instructions = instructions.slice(1);
  return { name, description, frontmatter: deepFreeze(value), instructions };
}

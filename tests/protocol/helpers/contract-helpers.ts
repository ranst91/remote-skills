import type { SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const protocolRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

export function readJson(relativePath: string): unknown {
  return JSON.parse(readFileSync(resolve(protocolRoot, relativePath), "utf8"));
}

export function jsonObject(value: unknown, label: string): object {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

export function jsonValue(value: object, key: string, label: string): unknown {
  if (!Object.hasOwn(value, key)) throw new TypeError(`${label} must contain ${key}`);
  return Reflect.get(value, key);
}

export function jsonArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return value;
}

export function jsonString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  return value;
}

export function jsonNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite number`);
  }
  return value;
}

export function jsonBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${label} must be a boolean`);
  return value;
}

export function jsonStringArray(value: unknown, label: string): string[] {
  return jsonArray(value, label).map((item, index) => jsonString(item, `${label}[${index}]`));
}

export function jsonOptionalString(value: object, key: string, label: string): string | undefined {
  if (!Object.hasOwn(value, key)) return undefined;
  return jsonString(Reflect.get(value, key), `${label}.${key}`);
}

export function jsonOptionalNumber(value: object, key: string, label: string): number | undefined {
  if (!Object.hasOwn(value, key)) return undefined;
  return jsonNumber(Reflect.get(value, key), `${label}.${key}`);
}

export function jsonCaseDocument<Item>(
  value: unknown,
  label: string,
  decodeItem: (value: unknown, label: string) => Item,
): { cases: Item[] } {
  const document = jsonObject(value, label);
  return {
    cases: jsonArray(jsonValue(document, "cases", label), `${label}.cases`).map((item, index) =>
      decodeItem(item, `${label}.cases[${index}]`),
    ),
  };
}

export function sha256(bytes: NodeJS.ArrayBufferView): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function spawnTextSync(
  command: string,
  args: string[],
  options: Omit<SpawnSyncOptionsWithStringEncoding, "encoding" | "shell"> = {},
) {
  const result = spawnSync(command, args, { ...options, encoding: "utf8", shell: false });
  const stdout = result.stdout?.replace(/\r\n?/gu, "\n") ?? "";
  const stderr = result.stderr?.replace(/\r\n?/gu, "\n") ?? "";
  return { ...result, stdout, stderr };
}

export function parseSha256Manifest(contents: string): { digest: string; path: string }[] {
  return contents
    .trim()
    .split(/\r?\n/)
    .map((line) => {
      const match = /^(?<digest>[0-9a-f]{64}) {2}(?<path>.+)$/.exec(line);
      if (!match?.groups) throw new Error(`invalid manifest line: ${line}`);
      const { digest, path } = match.groups;
      if (digest === undefined || path === undefined) {
        throw new Error(`invalid manifest line: ${line}`);
      }
      return { digest, path };
    });
}

export function readSha256Manifest(relativePath: string) {
  return parseSha256Manifest(readFileSync(resolve(protocolRoot, relativePath), "utf8"));
}

export function walkFiles(relativeDirectory = "."): string[] {
  const root = resolve(protocolRoot, relativeDirectory);
  const files: string[] = [];

  function visit(directory: string): void {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) visit(path);
      else files.push(relative(protocolRoot, path).split(sep).join("/"));
    }
  }

  visit(root);
  return files;
}

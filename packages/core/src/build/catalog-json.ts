// @ts-check

import { buildLimit } from "./errors.ts";

export const DISCOVERY_SCHEMA = "https://schemas.agentskills.io/discovery/0.2.0/schema.json";

/**
 * Encode canonical publisher JSON while rejecting the first chunk that exceeds the byte bound.
 * @param {Iterable<unknown>} entries
 * @param {number} maximum
 * @param {{collect?: boolean}} [options]
 */
export function encodeCatalogBounded(
  entries: Iterable<unknown>,
  maximum: number,
  options: { collect: false },
): number;
export function encodeCatalogBounded(
  entries: Iterable<unknown>,
  maximum: number,
  options?: { collect?: true },
): Buffer;
export function encodeCatalogBounded(
  entries: Iterable<unknown>,
  maximum: number,
  { collect = true }: { collect?: boolean } = {},
): Buffer | number {
  if (!Number.isSafeInteger(maximum) || maximum < 0) {
    throw buildLimit("catalog limit is not a safe integer", { limit: "catalogBytes" });
  }
  /** @type {Buffer[]} */
  const chunks: Buffer[] = [];
  let total = 0;
  /** @param {string} text */
  const append = (text: string) => {
    const bytes = Buffer.from(text, "utf8");
    total += bytes.byteLength;
    if (!Number.isSafeInteger(total) || total > maximum) {
      throw buildLimit("catalog exceeds the configured catalog limit", {
        limit: "catalogBytes",
      });
    }
    if (collect) chunks.push(bytes);
  };

  append(`{\n  "$schema": ${JSON.stringify(DISCOVERY_SCHEMA)},\n  "skills": `);
  let index = 0;
  for (const entry of entries) {
    const json = JSON.stringify(entry, null, 2)
      .split("\n")
      .map((line) => `    ${line}`)
      .join("\n");
    append(`${index === 0 ? "[\n" : ",\n"}${json}`);
    index += 1;
  }
  append(index === 0 ? "[]\n}\n" : "\n  ]\n}\n");
  return collect ? Buffer.concat(chunks, total) : total;
}

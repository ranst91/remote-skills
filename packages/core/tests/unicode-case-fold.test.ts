import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import * as unicodeCaseFold from "../src/authoring/unicode-case-fold-v15.mjs";

const EXPECTED_VERSION = "15.0.0";
const EXPECTED_MAPPING_COUNT = 1_530;
const EXPECTED_MAPPING_SHA256 = "74b7ffce890c2db7c68e524b4345fd383a77bed2f2b7edd73844f54e0ac392d4";

test("pins the complete Unicode 15 default case-fold mapping", () => {
  const rows: string[] = [];
  for (let point = 0; point <= 0x10ffff; point += 1) {
    const value = String.fromCodePoint(point);
    const folded = unicodeCaseFold.unicodeCaseFoldV15(value);
    if (folded === value) continue;
    const targets = Array.from(folded, (character) => {
      const codePoint = character.codePointAt(0);
      if (codePoint === undefined) throw new Error("expected a Unicode scalar");
      return codePoint.toString(16).padStart(6, "0");
    });
    rows.push(`${point.toString(16).padStart(6, "0")};${targets.join(" ")}\n`);
  }
  const digest = createHash("sha256").update(rows.join(""), "utf8").digest("hex");

  assert.equal(unicodeCaseFold.UNICODE_CASE_FOLD_VERSION, EXPECTED_VERSION);
  assert.equal(rows.length, EXPECTED_MAPPING_COUNT);
  assert.equal(digest, EXPECTED_MAPPING_SHA256);
  assert.equal(unicodeCaseFold.UNICODE_CASE_FOLD_SHA256, EXPECTED_MAPPING_SHA256);
});

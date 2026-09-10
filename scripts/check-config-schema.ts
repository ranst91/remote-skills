import { readFileSync } from "node:fs";

import { serializedConfigSchema } from "../packages/core/src/config-schema.ts";

const targets = ["remote-skills.schema.json", "apps/docs/public/schemas/config/0.0.1.json"];
const expected = serializedConfigSchema();
const drifted = targets.filter((target) => readFileSync(target, "utf8") !== expected);

if (drifted.length > 0) {
  throw new Error(`config schema drift detected: ${drifted.join(", ")}; run pnpm schema:generate`);
}

console.log(`verified ${targets.length} generated config schemas`);

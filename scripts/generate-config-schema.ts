import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { serializedConfigSchema } from "../packages/core/src/config-schema.ts";

const targets = ["remote-skills.schema.json", "apps/docs/public/schemas/config/0.0.1.json"];
const schema = serializedConfigSchema();

for (const target of targets) {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, schema);
  console.log(`generated ${target}`);
}

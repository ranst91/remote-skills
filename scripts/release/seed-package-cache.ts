import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnPnpmSync } from "../lib/pnpm-command.ts";
import { manifestObject, stringField } from "./release-lib.ts";

// Normal dependency setup may use the registry; the subsequent artifact gate may not.
const manifest = manifestObject(readFileSync("integrations/ai-sdk/package.json", "utf8"));
const runtime: unknown = Reflect.get(manifest, "dependencies");
const development: unknown = Reflect.get(manifest, "devDependencies");
if (
  typeof runtime !== "object" ||
  runtime === null ||
  typeof development !== "object" ||
  development === null
)
  throw new Error("Integration dependency metadata is missing");
const dependencies = { ...runtime, ai: stringField(development, "ai") };
const directory = mkdtempSync(join(tmpdir(), "integration-dependency-cache-"));
try {
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({
      name: "integration-dependency-cache",
      private: true,
      packageManager: "pnpm@10.33.4",
      dependencies,
    }),
  );
  const result = spawnPnpmSync(["install", "--ignore-scripts", "--lockfile=false"], {
    cwd: directory,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `Integration dependency cache setup failed:\n${result.stdout}\n${result.stderr}`,
    );
  console.log("Integration runtime dependency cache is ready for offline artifact checks.");
} finally {
  rmSync(directory, { recursive: true, force: true });
}

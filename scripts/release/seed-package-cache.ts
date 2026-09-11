import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnPnpmSync } from "../lib/pnpm-command.ts";
import { writeLockedIntegrationProject } from "./integration-dependencies.ts";

// Normal dependency setup may use the registry; the subsequent artifact gate may not.
const directory = mkdtempSync(join(tmpdir(), "integration-dependency-cache-"));
try {
  writeLockedIntegrationProject(process.cwd(), directory);
  const result = spawnPnpmSync(["install", "--ignore-scripts", "--frozen-lockfile"], {
    cwd: directory,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `Integration dependency cache setup failed:\n${result.stdout}\n${result.stderr}`,
    );
  // Historical package tests resolve named dependencies. Fetch their metadata
  // separately; this disposable resolution is never used by the final consumer.
  const metadataDirectory = join(directory, "metadata");
  mkdirSync(metadataDirectory);
  copyFileSync(join(directory, "package.json"), join(metadataDirectory, "package.json"));
  const metadata = spawnPnpmSync(
    ["install", "--resolution-only", "--no-frozen-lockfile", "--ignore-scripts"],
    { cwd: metadataDirectory, encoding: "utf8" },
  );
  if (metadata.error) throw metadata.error;
  if (metadata.status !== 0)
    throw new Error(
      `Integration metadata preparation failed:\n${metadata.stdout}\n${metadata.stderr}`,
    );
  console.log("Integration runtime dependency cache is ready for offline artifact checks.");
} finally {
  rmSync(directory, { recursive: true, force: true });
}

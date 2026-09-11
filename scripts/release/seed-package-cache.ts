import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnPnpmSync } from "../lib/pnpm-command.ts";
import { writeLockedIntegrationProject } from "./integration-dependencies.ts";
import { readReleaseState } from "./release-lib.ts";

// Normal dependency setup may use the registry; the subsequent artifact gate may not.
const directory = mkdtempSync(join(tmpdir(), "integration-dependency-cache-"));
try {
  for (const integration of readReleaseState().manifests.filter((entry) => entry.scope !== "core")) {
    const consumer = join(directory, integration.id);
    mkdirSync(consumer);
    writeLockedIntegrationProject(process.cwd(), consumer, dirname(integration.manifestPath));
    const result = spawnPnpmSync(["install", "--ignore-scripts", "--frozen-lockfile"], {
      cwd: consumer,
      encoding: "utf8",
    });
    if (result.error) throw result.error;
    if (result.status !== 0)
      throw new Error(
        `Integration dependency cache setup failed:\n${result.stdout}\n${result.stderr}`,
      );
    // Historical package tests resolve named dependencies. Fetch their metadata
    // separately; this disposable resolution is never used by the final consumer.
    const metadataDirectory = join(consumer, "metadata");
    mkdirSync(metadataDirectory);
    copyFileSync(join(consumer, "package.json"), join(metadataDirectory, "package.json"));
    const metadata = spawnPnpmSync(
      ["install", "--resolution-only", "--no-frozen-lockfile", "--ignore-scripts"],
      { cwd: metadataDirectory, encoding: "utf8" },
    );
    if (metadata.error) throw metadata.error;
    if (metadata.status !== 0)
      throw new Error(
        `Integration metadata preparation failed:\n${metadata.stdout}\n${metadata.stderr}`,
      );
  }
  console.log("Integration runtime dependency cache is ready for offline artifact checks.");
} finally {
  rmSync(directory, { recursive: true, force: true });
}

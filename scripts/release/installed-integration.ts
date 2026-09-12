import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnPnpmSync } from "../lib/pnpm-command.ts";
import {
  assertLockedIntegrationResolution,
  writeLockedIntegrationProject,
} from "./integration-dependencies.ts";
import { manifestObject, stringField } from "./release-lib.ts";

export function checkInstalledIntegration(
  archives: readonly string[],
  root = process.cwd(),
  integrationPath = "integrations/ai-sdk",
) {
  const consumer = mkdtempSync(join(tmpdir(), "installed-integration-"));
  try {
    const manifest = manifestObject(
      readFileSync(join(root, integrationPath, "package.json"), "utf8"),
    );
    writeLockedIntegrationProject(root, consumer, integrationPath);
    // Dependency setup seeds both package contents and metadata before this offline test.
    // Registry overrides change pnpm's metadata cache key, even with networking disabled.
    const offlineEnvironment = { ...process.env };
    delete offlineEnvironment.npm_config_registry;
    delete offlineEnvironment.NPM_CONFIG_REGISTRY;
    const install = spawnPnpmSync(
      [
        "add",
        "--offline",
        "--ignore-scripts",
        "--strict-peer-dependencies",
        ...archives.map((file) => resolve(file)),
      ],
      {
        cwd: consumer,
        encoding: "utf8",
        env: offlineEnvironment,
      },
    );
    if (install.error) throw install.error;
    if (install.status !== 0)
      throw new Error(
        `Installed integration dependency resolution failed:\n${install.stdout}\n${install.stderr}`,
      );
    assertLockedIntegrationResolution(
      root,
      consumer,
      archives.map((file) => resolve(file)),
    );
    const source = join(root, integrationPath, "tests/installed-consumer.ts");
    copyFileSync(source, join(consumer, "check.ts"));
    const result = spawnSync(process.execPath, ["check.ts", stringField(manifest, "version")], {
      cwd: consumer,
      encoding: "utf8",
      timeout: 30_000,
    });
    if (result.error) throw result.error;
    if (result.status !== 0)
      throw new Error(`Installed integration failed:\n${result.stdout}\n${result.stderr}`);
    const cli = join(consumer, "node_modules/@remote-skills/cli/dist/cli.js");
    if (existsSync(cli)) {
      const version = spawnSync(process.execPath, [cli, "--version"], {
        cwd: consumer,
        encoding: "utf8",
      });
      if (
        version.status !== 0 ||
        version.stdout.trim() !==
          stringField(
            manifestObject(readFileSync(join(root, "packages/cli/package.json"), "utf8")),
            "version",
          )
      )
        throw new Error("Installed CLI version differs from release version");
    }
    return result.stdout.trim();
  } finally {
    rmSync(consumer, { recursive: true, force: true });
  }
}

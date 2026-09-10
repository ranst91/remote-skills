import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnPnpmSync } from "../lib/pnpm-command.ts";
import { manifestObject, stringField } from "./release-lib.ts";

export function checkInstalledIntegration(archives: readonly string[], root = process.cwd()) {
  const consumer = mkdtempSync(join(tmpdir(), "installed-ai-sdk-"));
  try {
    const manifest = manifestObject(
      readFileSync(join(root, "integrations/ai-sdk/package.json"), "utf8"),
    );
    const dependencies: unknown = Reflect.get(manifest, "devDependencies");
    if (typeof dependencies !== "object" || dependencies === null)
      throw new Error("Missing integration development dependencies");
    const aiVersion = stringField(dependencies, "ai");
    writeFileSync(
      join(consumer, "package.json"),
      JSON.stringify({
        name: "installed-integration-check",
        private: true,
        type: "module",
        packageManager: "pnpm@10.33.4",
      }),
    );
    // Dependency setup seeds both package contents and metadata before this offline test.
    const install = spawnPnpmSync(
      [
        "add",
        "--offline",
        "--ignore-scripts",
        "--strict-peer-dependencies",
        ...archives.map((file) => resolve(file)),
        `ai@${aiVersion}`,
      ],
      {
        cwd: consumer,
        encoding: "utf8",
        env: { ...process.env, npm_config_registry: "https://registry.npmjs.org" },
      },
    );
    if (install.error) throw install.error;
    if (install.status !== 0)
      throw new Error(
        `Installed integration dependency resolution failed:\n${install.stdout}\n${install.stderr}`,
      );
    const source = join(root, "integrations/ai-sdk/tests/installed-consumer.ts");
    copyFileSync(source, join(consumer, "check.ts"));
    const result = spawnSync(process.execPath, ["check.ts"], {
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
      if (version.status !== 0 || version.stdout.trim() !== stringField(manifest, "version"))
        throw new Error("Installed CLI version differs from release version");
    }
    return result.stdout.trim();
  } finally {
    rmSync(consumer, { recursive: true, force: true });
  }
}

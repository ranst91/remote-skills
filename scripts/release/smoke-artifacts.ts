import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveCompatibleUvCommand } from "../lib/uv-command.ts";
import { checkInstalledIntegration } from "./installed-integration.ts";
import { readReleaseState } from "./release-lib.ts";

const [directory, ...extra] = process.argv.slice(2);
if (!directory || extra.length) throw new Error("usage: smoke-artifacts.ts <artifact-directory>");
const state = readReleaseState();
const root = resolve(directory);
const npm = readdirSync(join(root, "npm")).sort();
const expected = state.manifests
  .map((entry) => `${entry.name.replace("@", "").replace("/", "-")}-${state.npmVersion}.tgz`)
  .sort();
if (JSON.stringify(npm) !== JSON.stringify(expected))
  throw new Error("Unexpected npm release artifact inventory");
console.log(checkInstalledIntegration(npm.map((file) => join(root, "npm", file))));
const python = readdirSync(join(root, "python")).sort();
const expectedPython = [
  `remote_skills-${state.pythonVersion}-py3-none-any.whl`,
  `remote_skills-${state.pythonVersion}.tar.gz`,
].sort();
if (JSON.stringify(python) !== JSON.stringify(expectedPython))
  throw new Error("Unexpected Python release artifact inventory");
for (const file of python) {
  const result = spawnSync(
    resolveCompatibleUvCommand(),
    [
      "run",
      "--isolated",
      "--no-project",
      "--offline",
      "--with",
      join(root, "python", file),
      "python",
      "-c",
      'from importlib.metadata import version; import remote_skills, sys; assert version("remote-skills") == sys.argv[1]',
      state.pythonVersion,
    ],
    { encoding: "utf8", timeout: 120_000 },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Python artifact smoke failed: ${result.stderr}`);
}
console.log("All five release artifacts installed and exercised; nothing published.");

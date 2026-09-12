import { spawnSync } from "node:child_process";
import { copyFileSync } from "node:fs";
import { join } from "node:path";

export function checkInstalledPythonIntegration(
  root: string,
  environmentDirectory: string,
  python: string,
  expected: { sdkVersion: string; integrationVersion: string },
  environment: NodeJS.ProcessEnv,
): string {
  const check = join(environmentDirectory, "installed-python-integration.py");
  copyFileSync(join(root, "scripts/release/installed-python-integration.py"), check);
  const isolated = { ...environment };
  for (const name of ["PYTHONPATH", "PYTHONHOME", "VIRTUAL_ENV", "UV_PROJECT_ENVIRONMENT"])
    delete isolated[name];
  const result = spawnSync(
    python,
    ["-I", check, expected.sdkVersion, expected.integrationVersion],
    {
      cwd: environmentDirectory,
      encoding: "utf8",
      env: isolated,
      timeout: 30_000,
      shell: false,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`Installed Python integration failed:\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

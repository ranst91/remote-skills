import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import process from "node:process";

const requiredUvVersion = ">=0.11.33,<0.12.0";

interface ResolveUvOptions {
  environment?: NodeJS.ProcessEnv;
}

function compatibleVersion(output: string): boolean {
  const match = /^uv (\d+)\.(\d+)\.(\d+)(?:\s|$)/u.exec(output.trim());
  if (!match) return false;
  const [, majorText, minorText, patchText] = match;
  if (majorText === undefined || minorText === undefined || patchText === undefined) return false;
  const major = Number.parseInt(majorText, 10);
  const minor = Number.parseInt(minorText, 10);
  const patch = Number.parseInt(patchText, 10);
  return major === 0 && minor === 11 && patch >= 33;
}

function executablePath(environment: NodeJS.ProcessEnv): string {
  if (environment.PATH !== undefined) return environment.PATH;
  for (const [key, value] of Object.entries(environment)) {
    if (key.toUpperCase() === "PATH" && value !== undefined) return value;
  }
  return "";
}

function uvCandidates(environment: NodeJS.ProcessEnv): string[] {
  const configured = environment.REMOTE_SKILLS_UV;
  if (configured !== undefined) {
    if (!isAbsolute(configured)) {
      throw new Error("REMOTE_SKILLS_UV must be one absolute executable path");
    }
    return [configured];
  }
  const executableNames = process.platform === "win32" ? ["uv.exe", "uv"] : ["uv"];
  const candidates: string[] = [];
  const seen = new Set<string>();
  for (const directory of executablePath(environment).split(delimiter)) {
    if (directory === "") continue;
    for (const executableName of executableNames) {
      const candidate = resolve(join(directory, executableName));
      if (!existsSync(candidate)) continue;
      const canonical = realpathSync(candidate);
      const key = process.platform === "win32" ? canonical.toLowerCase() : canonical;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push(canonical);
    }
  }
  return candidates;
}

export function resolveCompatibleUvCommand({
  environment = process.env,
}: ResolveUvOptions = {}): string {
  const rejected: string[] = [];
  for (const command of uvCandidates(environment)) {
    const result = spawnSync(command, ["--version"], {
      encoding: "utf8",
      env: environment,
      shell: false,
    });
    const output = result.stdout?.trim() ?? "";
    if (result.status === 0 && compatibleVersion(output)) return command;
    rejected.push(`${command} (${output || result.error?.message || `status ${result.status}`})`);
  }
  const checked = rejected.length > 0 ? rejected.join(", ") : "no uv executables on PATH";
  throw new Error(
    `remote-skills offline builds require uv ${requiredUvVersion}; checked: ${checked}. ` +
      "Set REMOTE_SKILLS_UV to one compatible absolute executable path.",
  );
}

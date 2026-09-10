import { readPythonVersion } from "../../../scripts/release/release-lib.ts";

export function selectPythonWheel(built: readonly string[], manifest: string) {
  const wheelName = `remote_skills-${readPythonVersion(manifest)}-py3-none-any.whl`;
  if (built.length !== 1 || built[0] !== wheelName) {
    throw new Error("local Python build did not produce the expected single wheel");
  }
  return wheelName;
}

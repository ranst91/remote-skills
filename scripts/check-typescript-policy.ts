import { resolve } from "node:path";

import {
  checkEffectiveCompilerOptions,
  findNoAnyDiagnostics,
  formatTypeScriptPolicyDiagnostic,
  TYPESCRIPT_PROJECT_CONFIG_PATHS,
  VENDORED_PAKO_PATH,
} from "./typescript-policy.ts";

const compilerOptionDiagnostics = checkEffectiveCompilerOptions(TYPESCRIPT_PROJECT_CONFIG_PATHS);
const noAnyDiagnostics = findNoAnyDiagnostics({
  allowedTsNoCheckPath: resolve(VENDORED_PAKO_PATH),
  projectConfigPaths: TYPESCRIPT_PROJECT_CONFIG_PATHS,
});
const diagnostics = [...compilerOptionDiagnostics, ...noAnyDiagnostics];

if (diagnostics.length > 0) {
  for (const diagnostic of diagnostics) {
    process.stderr.write(`${formatTypeScriptPolicyDiagnostic(diagnostic)}\n`);
  }
  process.exitCode = 1;
}

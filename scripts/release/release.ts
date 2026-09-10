import { appendFileSync, readFileSync } from "node:fs";
import {
  changelogSection,
  prepareRelease,
  readReleaseState,
  validateReleaseCommit,
} from "./release-lib.ts";

const [command, ...args] = process.argv.slice(2);
try {
  if (command === "prepare") {
    const [bump, channel, mode] = args;
    if (
      (bump !== "initial" && bump !== "patch" && bump !== "minor" && bump !== "major") ||
      (channel !== "alpha" && channel !== "stable") ||
      (mode !== "--dry-run" && mode !== "--write")
    )
      throw new Error(
        "usage: release.ts prepare <initial|patch|minor|major> <alpha|stable> <--dry-run|--write>",
      );
    const result = prepareRelease(process.cwd(), bump, channel, mode === "--dry-run");
    if (process.env.GITHUB_OUTPUT)
      appendFileSync(process.env.GITHUB_OUTPUT, `npm_version=${result.npmVersion}\n`);
    console.log(JSON.stringify(result, null, 2));
  } else if (command === "validate" && args.length === 1 && args[0]) {
    console.log(JSON.stringify(validateReleaseCommit(process.cwd(), args[0])));
  } else if (command === "metadata" && args.length === 0) {
    const state = readReleaseState();
    if (process.env.GITHUB_OUTPUT)
      appendFileSync(
        process.env.GITHUB_OUTPUT,
        `npm_version=${state.npmVersion}\npython_version=${state.pythonVersion}\nnpm_tag=${state.npmTag}\ngit_tag=${state.gitTag}\nprerelease=${state.prerelease}\n`,
      );
    console.log(
      JSON.stringify(
        {
          npmVersion: state.npmVersion,
          pythonVersion: state.pythonVersion,
          npmTag: state.npmTag,
          packages: state.manifests.map((entry) => entry.name),
        },
        null,
        2,
      ),
    );
  } else if (command === "notes" && args.length === 0) {
    console.log(
      changelogSection(readFileSync("CHANGELOG.md", "utf8"), readReleaseState().npmVersion),
    );
  } else throw new Error("usage: release.ts <prepare|validate|metadata|notes>");
} catch (error) {
  console.error(error instanceof Error ? error.message : "Release command failed");
  process.exitCode = 1;
}

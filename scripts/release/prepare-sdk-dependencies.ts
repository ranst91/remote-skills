import { resolve } from "node:path";
import { readReleaseState } from "./release-lib.ts";
import { prepareSdkDependencies } from "./sdk-dependencies.ts";

const [root, directory, ...extra] = process.argv.slice(2);
if (!root || !directory || extra.length)
  throw new Error("usage: prepare-sdk-dependencies.ts <source-root> <dependency-directory>");
console.log(
  JSON.stringify(await prepareSdkDependencies(readReleaseState(resolve(root)), resolve(directory))),
);

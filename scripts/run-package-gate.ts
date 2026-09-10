import { readFileSync } from "node:fs";

const packageName = process.env.npm_package_name;
const gate = process.argv[2] ?? "check";

if (!packageName) throw new Error("package gate requires npm_package_name");

const manifest: unknown = JSON.parse(readFileSync("package.json", "utf8"));
if (typeof manifest !== "object" || manifest === null || !("name" in manifest)) {
  throw new Error("package gate requires an object manifest with a name");
}
if (manifest.name !== packageName) throw new Error(`package name mismatch for ${packageName}`);

console.log(`project-gate ${packageName} ${gate}`);

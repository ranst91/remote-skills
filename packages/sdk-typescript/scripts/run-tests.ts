import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

async function discoverTests(directory: string): Promise<string[]> {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await discoverTests(path)));
    else if (entry.isFile() && entry.name.endsWith(".test.ts")) files.push(path);
  }
  return files.sort();
}

const arguments_ = process.argv.slice(2);
const listOnly = arguments_[0] === "--list";
const testRoot = resolve(listOnly ? (arguments_[1] ?? "tests") : (arguments_[0] ?? "tests"));
const testFiles = await discoverTests(testRoot);

if (listOnly) {
  process.stdout.write(`${JSON.stringify(testFiles)}\n`);
} else if (testFiles.length === 0) {
  process.stderr.write(`No test files found under ${testRoot}\n`);
  process.exitCode = 1;
} else {
  const result = spawnSync(process.execPath, ["--test", ...testFiles], { encoding: "utf8" });
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  process.exitCode = result.status ?? 1;
}

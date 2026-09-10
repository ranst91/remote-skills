import { spawnSync } from "node:child_process";
import { chmod, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const outputDirectory = path.join(packageDirectory, "dist");
const typescriptDirectory = path.dirname(fileURLToPath(import.meta.resolve("typescript")));
const compilerEntrypoint = path.join(typescriptDirectory, "tsc.js");

await rm(outputDirectory, { recursive: true, force: true });

const compiler = spawnSync(
  process.execPath,
  [compilerEntrypoint, "-p", path.join(packageDirectory, "tsconfig.build.json")],
  {
    cwd: packageDirectory,
    encoding: "utf8",
    shell: false,
    stdio: "inherit",
  },
);
if (compiler.error !== undefined) throw compiler.error;
if (compiler.status !== 0) {
  throw new Error(`TypeScript compilation failed with exit code ${compiler.status ?? "unknown"}`);
}

async function rewriteDeclarationSpecifiers(directory: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await rewriteDeclarationSpecifiers(target);
        return;
      }
      if (!entry.name.endsWith(".d.ts")) return;
      const declaration = await readFile(target, "utf8");
      const rewritten = declaration.replace(/(["']\.\.?\/[^"']+)\.ts(["'])/gu, "$1.js$2");
      if (rewritten !== declaration) await writeFile(target, rewritten, "utf8");
    }),
  );
}

await rewriteDeclarationSpecifiers(outputDirectory);
await chmod(path.join(outputDirectory, "cli.js"), 0o755);

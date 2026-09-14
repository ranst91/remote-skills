import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { manifestObject } from "./release-lib.ts";

export function writeLockedIntegrationProject(
  root: string,
  directory: string,
  integrationPath = "integrations/ai-sdk",
  includeCatalog = false,
) {
  const manifest = manifestObject(
    readFileSync(join(root, integrationPath, "package.json"), "utf8"),
  );
  const runtime = Object.fromEntries(
    Object.entries(
      manifestObject(JSON.stringify(Reflect.get(manifest, "dependencies") ?? {})),
    ).filter(([, value]) => typeof value === "string" && !value.startsWith("workspace:")),
  );
  const development = manifestObject(
    JSON.stringify(Reflect.get(manifest, "devDependencies") ?? {}),
  );
  const consumerDependencies = Object.fromEntries(
    Object.entries(development).filter(
      ([, value]) =>
        typeof value === "string" &&
        !value.startsWith("workspace:") &&
        (includeCatalog || !value.startsWith("catalog:")),
    ),
  );
  const dependencies = { ...runtime, ...consumerDependencies };
  const lock = readFileSync(join(root, "pnpm-lock.yaml"), "utf8");
  if (!lock.startsWith("lockfileVersion: '9.0'\n"))
    throw new Error("Unsupported pnpm lockfile format");
  const importerStart = lock.indexOf(`\n  ${integrationPath}:\n`);
  const contentStart = importerStart + `\n  ${integrationPath}:\n`.length;
  const nextImporter = lock.slice(contentStart).search(/\n {2}\S/u);
  const importerEnd = nextImporter < 0 ? -1 : contentStart + nextImporter;
  const packageStart = lock.indexOf("\npackages:\n");
  const headerEnd =
    lock.indexOf("\ncatalogs:\n") >= 0
      ? lock.indexOf("\ncatalogs:\n")
      : lock.indexOf("\nimporters:\n");
  if (importerStart < 0 || packageStart < 0)
    throw new Error("Integration lock snapshot is missing");
  const lines = lock.slice(importerStart, importerEnd < 0 ? packageStart : importerEnd).split("\n");
  const entries = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const line of lines) {
    const entry = /^ {6}([^ ].*):$/u.exec(line);
    if (entry?.[1]) {
      const name = entry[1].replace(/^'|'$/gu, "");
      current = [];
      entries.set(name, current);
    } else if (line !== "" && !line.startsWith("        ")) current = undefined;
    if (current && line !== "") current.push(line);
  }
  const projected = Object.keys(dependencies).map((name) => {
    const entry = entries.get(name);
    if (!entry?.some((line) => /^ {8}version: /u.test(line)))
      throw new Error(`Missing locked integration dependency: ${name}`);
    if (String(dependencies[name]).startsWith("catalog:")) {
      const pinned = entry
        .find((line) => /^ {8}version: /u.test(line))
        ?.trim()
        .slice("version: ".length);
      if (!pinned || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?$/u.test(pinned))
        throw new Error(`Unsupported catalog dependency: ${name}`);
      dependencies[name] = pinned;
      return entry
        .map((line) => (/^ {8}specifier: /u.test(line) ? `        specifier: ${pinned}` : line))
        .join("\n");
    }
    return entry.join("\n");
  });
  writeFileSync(
    join(directory, "package.json"),
    `${JSON.stringify({ name: "installed-integration-check", private: true, type: "module", packageManager: "pnpm@10.33.4", dependencies })}\n`,
  );
  // Keep the source resolutions and integrity hashes intact. Only the importer
  // changes: workspace packages will be supplied as the actual local archives.
  writeFileSync(
    join(directory, "pnpm-lock.yaml"),
    `${lock.slice(0, headerEnd)}\nimporters:\n\n  .:\n    dependencies:\n${projected.join("\n")}\n${lock.slice(packageStart)}`,
  );
}

function entries(lock: string, section: string) {
  const start = lock.indexOf(`\n${section}:\n`);
  if (start < 0) throw new Error(`Missing lockfile ${section}`);
  const body = lock.slice(start + section.length + 3);
  const end = body.search(/\n\S/u);
  const result = new Map<string, string>();
  for (const block of (end < 0 ? body : body.slice(0, end)).split(/\n(?= {2}\S)/u)) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    const newline = trimmed.indexOf("\n");
    const heading = newline < 0 ? trimmed : trimmed.slice(0, newline);
    const match = /^(.*):(?: \{\})?$/u.exec(heading);
    if (!match?.[1]) throw new Error(`Invalid lockfile ${section} entry`);
    const key = match[1].replace(/^'|'$/gu, "");
    // Optional reachability changes when unrelated workspace importers are removed;
    // it does not change this package's resolution or dependency edges.
    const value = newline < 0 ? "" : trimmed.slice(newline + 1);
    result.set(
      key,
      section === "snapshots" ? value.replace(/^ {4}optional: true\n?/mu, "").trimEnd() : value,
    );
  }
  return result;
}

export function assertLockedIntegrationResolution(
  root: string,
  directory: string,
  archives: readonly string[],
) {
  const source = readFileSync(join(root, "pnpm-lock.yaml"), "utf8");
  const installed = readFileSync(join(directory, "pnpm-lock.yaml"), "utf8");
  const local = new Set(archives.map((archive) => resolve(archive)));
  for (const section of ["packages", "snapshots"]) {
    const expected = entries(source, section);
    for (const [key, value] of entries(installed, section)) {
      const localArchive = /@file:(.*?\.tgz)(?:\(|$)/u.exec(key)?.[1];
      if (localArchive && local.has(resolve(directory, localArchive))) continue;
      if (!expected.has(key) || expected.get(key) !== value)
        throw new Error(
          `Installed ${section} entry differs from source lock: ${key}\nExpected: ${expected.get(key)}\nActual: ${value}`,
        );
    }
  }
}

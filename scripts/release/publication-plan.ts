import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { artifactFile, type PublicationPlan } from "./publication-lib.ts";
import { changelogSection, type readReleaseState } from "./release-lib.ts";

/** Exact uv_build filenames: an alpha.1 selection must never pick alpha.10 bytes. */
export function pythonArtifactPaths(entry: { name: string; version: string }): string[] {
  const stem = `${entry.name.replaceAll("-", "_")}-${entry.version}`;
  return [`python/${stem}-py3-none-any.whl`, `python/${stem}.tar.gz`];
}

/** Hash only selected packages; dependency artifacts remain available for installed tests. */
export function buildPublicationPlan(
  state: Pick<ReturnType<typeof readReleaseState>, "releases">,
  output: string,
  changelog: string,
): PublicationPlan {
  const plan: PublicationPlan = { packages: [], releases: [] };
  for (const release of state.releases) {
    const notes = `release-notes-${release.scope}.md`;
    const marker = release.gitTag;
    writeFileSync(
      join(output, notes),
      changelog.includes(`## [${marker}]`)
        ? changelogSection(changelog, marker)
        : changelog.includes(`## [${release.version}]`)
          ? changelogSection(changelog, release.version)
          : "Local artifact verification; nothing published.\n",
    );
    // Issued coordinated releases share one tag across the original two scopes.
    if (!plan.releases.some((entry) => entry.gitTag === release.gitTag))
      plan.releases.push({
        scope: release.scope,
        version: release.version,
        gitTag: release.gitTag,
        prerelease: release.prerelease,
        notes,
      });
    for (const entry of release.packages) {
      const paths =
        entry.registry === "npm"
          ? [`npm/${entry.name.replace(/^@/u, "").replaceAll("/", "-")}-${entry.version}.tgz`]
          : pythonArtifactPaths(entry);
      plan.packages.push({
        name: entry.name,
        version: entry.version,
        registry: entry.registry,
        npmTag: release.npmTag,
        files: paths.map((path) => artifactFile(output, path)),
      });
    }
  }
  plan.packages.sort(
    (a, b) =>
      Number(b.name === "@remote-skills/client") - Number(a.name === "@remote-skills/client"),
  );
  return plan;
}

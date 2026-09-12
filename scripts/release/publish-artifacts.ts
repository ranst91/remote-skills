import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import {
  missingFiles,
  object,
  parsePublicationPlan,
  textField,
  verifyPublicationFiles,
} from "./publication-lib.ts";

const [operation, directory] = process.argv.slice(2);
if (!directory || !["metadata", "npm", "python", "verify", "release"].includes(operation ?? ""))
  throw new Error(
    "usage: publish-artifacts.ts metadata|npm|python|verify|release artifact-directory",
  );
const root = resolve(directory);
// This manifest and helper travel with the verified artifact, without a source rebuild.
const planData: unknown = JSON.parse(readFileSync(join(root, "publication.json"), "utf8"));
const plan = parsePublicationPlan(planData);
verifyPublicationFiles(root, plan);
function command(program: string, args: string[]) {
  const result = spawnSync(program, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.error || result.status !== 0)
    throw new Error(`Publication command failed: ${program}`);
  return result.stdout;
}
const lookup = (url: string) => fetch(url, { signal: AbortSignal.timeout(30_000) });
if (operation === "metadata") {
  if (!process.env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required");
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `has_python=${plan.packages.some((p) => p.registry === "pypi")}\n`,
  );
}
if (operation === "npm" || operation === "python") {
  for (const entry of plan.packages) {
    if (entry.registry !== (operation === "npm" ? "npm" : "pypi")) continue;
    const missing = await missingFiles(entry, lookup);
    for (const file of missing) {
      if (entry.registry === "npm")
        command("npm", [
          "publish",
          join(root, file.path),
          "--access",
          "public",
          "--tag",
          entry.npmTag,
        ]);
      else
        command("uv", [
          "publish",
          "--check-url",
          "https://pypi.org/simple/",
          join(root, file.path),
        ]);
    }
  }
}
if (operation === "verify") {
  for (const entry of plan.packages) {
    for (let attempt = 0; ; attempt++) {
      if ((await missingFiles(entry, lookup)).length === 0) break;
      if (attempt === 11) throw new Error("Published version is missing verified artifacts");
      await setTimeout(5_000);
    }
  }
}
if (operation === "release") {
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: uncached protected publication entry point.
  const sha = process.env.RELEASE_SHA;
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: uncached protected publication entry point.
  const repository = process.env.GH_REPO;
  if (
    !sha ||
    !/^[0-9a-f]{40}$/u.test(sha) ||
    !repository ||
    !/^[\w.-]+\/[\w.-]+$/u.test(repository)
  )
    throw new Error("A release commit SHA and repository are required");
  // Listing avoids interpreting unrelated command/network failures as a missing tag/release.
  const tagData: unknown = JSON.parse(
    command("gh", ["api", `repos/${repository}/git/matching-refs/tags/`]),
  );
  if (!Array.isArray(tagData)) throw new Error("Invalid GitHub tag response");
  const tags = tagData.map((item: unknown) => {
    const tag = object(item);
    const target = object(tag.object);
    return {
      ref: textField(tag, "ref"),
      object: { type: textField(target, "type"), sha: textField(target, "sha") },
    };
  });
  const releaseData: unknown = JSON.parse(
    command("gh", ["api", "--paginate", "--slurp", `repos/${repository}/releases?per_page=100`]),
  );
  if (!Array.isArray(releaseData) || releaseData.some((page: unknown) => !Array.isArray(page)))
    throw new Error("Invalid GitHub releases response");
  const releases = releaseData.flat().map((item: unknown) => {
    const release = object(item);
    if (typeof release.prerelease !== "boolean")
      throw new Error("Invalid GitHub prerelease response");
    return {
      tag_name: textField(release, "tag_name"),
      target_commitish: textField(release, "target_commitish"),
      prerelease: release.prerelease,
    };
  });
  for (const release of plan.releases) {
    const tag = tags.find((item) => item.ref === `refs/tags/${release.gitTag}`);
    if (tag && (tag.object.type !== "commit" || tag.object.sha !== sha))
      throw new Error("Existing release tag points at a different commit");
    const existing = releases.find((item) => item.tag_name === release.gitTag);
    if (existing) {
      if (!tag || existing.target_commitish !== sha || existing.prerelease !== release.prerelease)
        throw new Error("Existing GitHub release does not match verified release");
      continue;
    }
    const args = [
      "release",
      "create",
      release.gitTag,
      "--target",
      sha,
      "--title",
      release.gitTag,
      "--notes-file",
      join(root, release.notes),
    ];
    if (release.prerelease) args.push("--prerelease");
    command("gh", args);
  }
}

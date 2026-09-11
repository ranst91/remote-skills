// Add each releasable package here and expose its scope in prepare-release.yml.
export const releasePackages = [
  { id: "cli", name: "@remote-skills/cli", manifest: "packages/cli/package.json", scope: "core" },
  {
    id: "client",
    name: "@remote-skills/client",
    manifest: "packages/sdk-typescript/package.json",
    scope: "core",
  },
  {
    id: "ai_sdk",
    name: "@remote-skills/ai-sdk",
    manifest: "integrations/ai-sdk/package.json",
    scope: "integration-ai-sdk",
  },
] as const;
export const pythonManifest = "packages/sdk-python/pyproject.toml";
export const releaseScopes = {
  core: { python: true },
  "integration-ai-sdk": { python: false },
} as const;
export type Scope = keyof typeof releaseScopes;
export function isScope(value: string): value is Scope {
  return Object.hasOwn(releaseScopes, value);
}

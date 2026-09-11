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
    example: "examples/vercel-ai-sdk",
    scope: "integration-ai-sdk",
  },
  {
    id: "langchain",
    name: "@remote-skills/langchain",
    manifest: "integrations/langchain/package.json",
    example: "examples/langchain",
    scope: "integration-langchain",
  },
] as const;
export const pythonPackages = [
  {
    id: "python",
    name: "remote-skills",
    manifest: "packages/sdk-python/pyproject.toml",
    scope: "core",
    importName: "remote_skills",
  },
  {
    id: "langchain_python",
    name: "remote-skills-langchain",
    manifest: "integrations/langchain-python/pyproject.toml",
    example: "remote-skills-langchain-example",
    scope: "integration-langchain",
    importName: "remote_skills_langchain",
  },
] as const;
export const pythonManifest = "packages/sdk-python/pyproject.toml";
export const releaseScopes = {
  core: {},
  "integration-ai-sdk": {},
  "integration-langchain": {},
} as const;
export type Scope = keyof typeof releaseScopes;
export function isScope(value: string): value is Scope {
  return Object.hasOwn(releaseScopes, value);
}

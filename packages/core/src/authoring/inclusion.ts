import createIgnore from "ignore";

/** @internal Shared publisher exclusion policy. */
export const DEFAULT_EXCLUSIONS = Object.freeze([
  ".git",
  ".hg",
  ".svn",
  "node_modules/",
  "bower_components/",
  ".pnpm-store/",
  ".yarn/",
  ".cache/",
  ".turbo/",
  "dist/",
  "build/",
  "coverage/",
  ".DS_Store",
  "Thumbs.db",
  ".env",
  ".env*",
  ".git-credentials",
  ".npmrc",
  ".pypirc",
  ".netrc",
  "_netrc",
  ".secrets",
  ".secrets.*",
  "credentials",
  "credentials.json",
  "secrets.json",
  "service-account*.json",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  ".venv/",
  "venv/",
  "__pycache__/",
  ".pytest_cache/",
  ".mypy_cache/",
  ".ruff_cache/",
  ".tox/",
  ".nox/",
  ".skillignore",
]);

const defaultIgnore = createIgnore().add(DEFAULT_EXCLUSIONS);

export function ignoredByDefaults(relativePath: string, directory: boolean): boolean {
  return defaultIgnore.ignores(directory ? `${relativePath}/` : relativePath);
}

/** Paths passed here use the normalized portable identity, after default exclusions. */
export function createSkillIgnorePolicy(bytes: Uint8Array = new Uint8Array()) {
  const rules = createIgnore().add(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes).normalize("NFC"),
  );
  return (relativePath: string, directory: boolean): boolean =>
    relativePath !== "SKILL.md" && rules.ignores(directory ? `${relativePath}/` : relativePath);
}

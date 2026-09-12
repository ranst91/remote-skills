# Mastra native remote skills

Baseline: `44e088199d1488972a815a7a8df0db4c14021b36`, branch `codex/integration-mastra`.
Upstream archive: https://registry.npmjs.org/@mastra/core/-/core-1.65.0.tgz

Upstream inspected: the released `@mastra/core@1.65.0` npm archive (SHA-512 integrity
`FHis85lEo19XkpSfFcyVsTnm7HROzSEIr1zpwhs3ApaCpJNZJaBAyxZ5IEPUyZMd2QT1N+qFTC6yMGijHMLt0w==`).

## Discovery and activation

Mastra's public `WorkspaceConfig.skillSource` accepts `exists`, `stat`, `readFile`,
`readdir`, and optional `realpath`. However, its native `WorkspaceSkillsImpl`
reads and parses every SKILL.md during discovery, caches the instruction body,
and returns that body from `get()`. It also reads reference contents while
building indexable content even without a search engine. Metadata stubs alone
therefore cannot implement activation correctly.

Use a source containing catalog projections (frontmatter, no instructions or
resources) until activation. Attach the public Agent `hooks.beforeToolCall`
extension point. For `skill` and `skill_read`, activate the selected SDK skill,
expose the original verified artifact through the source, and call public
`workspace.skills.addSkill(path)` to update Mastra's native cache. The original
native tool then performs selection, loading, formatting, and ranged reads.
There is no prototype mutation, replacement tool, disk installation, rezip, or
remote script execution. Native discovery remains responsible for parsing and
advertising the catalog projections.

## Search

Require a nonempty `skillNames` list for native `skill_search`. Activate only the
explicit names before delegating to Mastra's unchanged simple text search.
This is on-demand content search, not global catalog search. Do not expose
BM25, vector indexing, or autoIndexPaths configuration in this integration.
Resources are read locally after whole-artifact verification; only native tool
results enter model context.

## Lifecycle and scope

One integration owns one workspace and one SDK session for a single configured
origin. Borrowed sessions remain caller-owned. Credentials, scope, version
selection, archive validation, caching, and pins remain entirely in the SDK.
Concurrent activation shares work. Close blocks new operations and waits for
in-flight tool calls before closing owned sessions. Errors crossing native
tool and diagnostic boundaries are sanitized.

The source and the activation hook are a single configuration unit. Calling
the discovery cache's `get()` directly, overriding the hook, sharing the
integration across tenants, and automatic explicit-user activation paths that
bypass tool hooks are unsupported. The public consumer API returns the complete
Agent configuration pair and documents this boundary.

## Implementation plan

- [x] Add a pinned integration package and contract tests using the real Mastra
  Agent and native tools. Verify metadata-only discovery and full activation.
- [x] Implement the source projection and public-hook activation plumbing.
- [x] Cover auth/scope isolation, version pins, cache reuse, path containment,
  errors, cancellation, borrowed ownership, close races, and scoped search.
- [x] Add a Next.js chat demo preserving stream order and a live-model check.
- [x] Validate the packed artifact in an isolated consumer, run package checks
  and required root gates, record exact commands/platform and limitations.
- [x] Verify the complete live native skill, reference read, and answer sequence with GPT-4.1.
- [x] Commit focused deliverables for manager review; no external publication.

## Source references

- https://mastra.ai/docs/sandbox/skills
- Released package source maps: `workspace/skills/workspace-skills.ts`,
  `workspace/skills/tools.ts`, `workspace/workspace.ts`, `agent/agent.ts`,
  `tools/hooks.ts`, and their exported declaration files.

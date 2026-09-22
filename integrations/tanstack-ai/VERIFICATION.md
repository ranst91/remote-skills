# Integration alignment verification — 2026-09-21

This supersedes the September 17 terminal-demo verification. Tested implementation: `b46487328040c6dd1249c2002083d8d99bd56a2a`. The subsequent evidence commit changes only this document.

Compared with the Vercel AI SDK, LangChain/DeepAgents and Mastra integrations in this checkout. Fetched `origin/main` again on September 21: `582d6e5cee69d06c0a78bf298fea8b93279ebe97`; no newer integration conventions appeared. No merge or unrelated package version change was made.

## Comparison and resolved gaps

| Shared convention | TanStack implementation | Verification |
| --- | --- | --- |
| Native framework selection and tools | Native `SkillSource`, `withSkills`, `load_skill` and `read_skill_resource`; TanStack owns the model/tool loop | Ten adapter behavior tests, published conformance suite, actual model-loop tests |
| Lazy verified loading, immutable pins and lifecycle | Metadata-only discovery, read-first and concurrent activation, UTF-8/binary resources, guarded paths, refresh/offline pins, owned/borrowed sessions, draining close | Adapter tests include credential isolation with a shared disk cache and invalid version setup |
| Complete user-facing docs | npm/pnpm/bun installation, executable streaming agent, expected behavior, conversation/private-origin guidance, API reference, package and example READMEs | Snippet compilation, docs contracts, site build, canonical Markdown routes and agent discovery |
| Browser chat demo | Next.js app, familiar chat UI, expandable native tool results, Stop/Reset, server-side request validation and response-owned source | Six demo tests plus production build; real Chromium E2E |
| Real end-to-end skill journey | Public CLI builds the origin; real SDK and TanStack tools run through the Next.js route; only the provider is mocked | Browser verifies exact instruction/reference output and event order, unused-skill laziness, direct answer, invalid startup, Stop/Reset, safe provider failure and corrupted bytes |
| Shared development lifecycle | Shared process runner, configurable distinct ports, preflight validation, coordinated app/publisher cleanup | Startup failures and real service cleanup in browser tests |
| Package boundaries and repeatability | Public ESM/declarations/license, sanitized archive, repeated isolated packing | Identical repeated tarballs; strict offline install and installed native load |
| CI registration | Adapter build/check/package check in TypeScript lane; demo check and explicit `test:tanstack-ai` in examples lane | Repository CI contract test and all 17 project gate registrations |
| Independent releases | `integration-tanstack-ai` scope, release preparation choice, artifact inputs, exact candidate selection | Release tests preserve unrelated manifests; complete artifact/candidate workflow |
| Candidate-artifact E2E | The same browser suite runs in a disposable application using selected CLI, client and TanStack tarballs | Complete cold-cache workflow passed with no workspace build-output fallback |

The audit found and closed real gaps: the terminal-only demo, missing explicit browser E2E CI command, abbreviated documentation setup, and missing common behavioral/packaging cases. The terminal entry remains available as `pnpm --filter @remote-skills/example-tanstack-ai terminal`.

TanStack's default provider-error logger is disabled in the demo; the route reports a generic diagnostic and UI error rather than logging provider response bodies. Browser history replays plain conversation text, never browser-supplied tool results.

## Fresh passing checks

Platform: macOS arm64, Node.js v24.21.0, pnpm 10.33.4, uv 0.11.33. Root tests use the locked CPython 3.14.4 environment; artifact clean installs use CPython 3.11.11.

```bash
pnpm --filter @remote-skills/tanstack-ai check
pnpm --filter @remote-skills/example-tanstack-ai check
pnpm test:tanstack-ai
pnpm --filter @remote-skills/docs check
pnpm --filter @remote-skills/example-tanstack-ai build
pnpm --filter @remote-skills/tanstack-ai package:check
pnpm typecheck
uv run --no-sync pnpm check
pnpm ci:verify-projects
git diff --check
```

Final root gates ran on the tested implementation commit: 25 typecheck tasks, 198 repository tests, 184 protocol tests and 17 successful project checks (zero cached project checks). Root `check` executes the repository and protocol gates directly. Adapter checks passed ten behavior tests plus seven published conformance cases. The demo passed six request/stream/native-agent tests. Its browser suite passed six tests including the parent journey and five subtests.

The published conformance runner includes optional script/revision cases that return when those methods are absent. Those cases do not establish support for either capability.

## Cold-cache release verification

This command completed successfully on the clean tested commit:

```bash
REMOTE_SKILLS_PYTHON=/Users/ran/.codex/worktrees/0682/remote-skills/.venv/bin/python \
  uv run --no-sync pnpm publication:readiness /tmp/tanstack-alignment-readiness-v2
```

It prepared empty private caches, inspected and installed all registered artifacts with registry access disabled, enforced strict peers and exact lockfile snapshots, and ran the core, Vercel AI SDK, LangChain, Mastra and TanStack candidate journeys. TanStack's candidate journey is now the browser suite, including its failure checks.

A first cold-cache attempt exposed upstream dependency drift: disposable metadata resolution selected `@tanstack/openai-base@0.10.14`, requiring a newer TanStack core than the tested graph. Explicitly declaring the existing locked `@tanstack/openai-base@0.10.12` in demo development dependencies fixed that resolution without weakening peer checks or upgrading runtime APIs.

Tested versions: `@tanstack/ai-skills@0.1.4`, `@tanstack/ai@0.55.0`, `@tanstack/ai-openai@0.22.8` and `@tanstack/openai-base@0.10.12`.

Retained local evidence:

- `/tmp/tanstack-alignment-readiness-v2/verification.json`: clean source identity, platform and artifact inspection/hashes.
- `/tmp/tanstack-alignment-readiness-v2.log`: full successful workflow, including every candidate journey.
- `/tmp/tanstack-alignment-final-typecheck.log`, `/tmp/tanstack-alignment-final-check.log`, `/tmp/tanstack-alignment-final-projects.log`: final root gates.
- `/tmp/tanstack-align-production.log`: successful production build of the browser app.

TanStack archive: `remote-skills-tanstack-ai-0.0.1-alpha.0.tgz`, 6,983 bytes, SHA-256 `25f7d894d4d0c18b88766a35b6cfe978c650c4bd326975cb26ef4758d7c6ce82`. It contains five entries: runtime code, declarations, package manifest, README and license.

## Scope and remaining unverified environments

Shared integration conventions and local gates are aligned. Framework-specific test cases remain different: TanStack does not expose Mastra's Workspace search/hooks or the LangChain filesystem adapter. It intentionally provides neither script execution nor revision keys. Matching integration behavior does not require inventing those APIs.

Remote CI, Linux/Windows execution and paid/live model behavior remain unverified here. CI wiring follows the existing lanes; a successful macOS run is not evidence that another platform passed. No package publication, push, pull request, merge or tag occurred. Local tarballs and publication plans are verification outputs only.

# Local verification — 2026-09-17

Tested implementation commit: `7ab2b86512c1e9ecdd56082733ac1e551dba2814`. This evidence update is documentation only.

Platform: macOS arm64; Node.js v24.21.0, pnpm 10.33.4, uv 0.11.33. Root checks use the locked CPython 3.14.4 environment; artifact clean-install checks use CPython 3.11.11.

## Published contracts

Inspected npm metadata and published TanStack tarballs. Final verified versions are `@tanstack/ai-skills@0.1.4`, `@tanstack/ai@0.55.0`, and `@tanstack/ai-openai@0.22.8`. The published skills package supplies `SkillSource`, `withSkills`, `createLoadSkillTool`, `createResourceTool`, and `/testing`.

Official references: [Portable Agent Skills](https://tanstack.com/ai/latest/docs/skills/agent-skills), [Skill Sources](https://tanstack.com/ai/latest/docs/skills/skill-sources), [Write a Skill Source](https://tanstack.com/ai/latest/docs/skills/writing-adapters).

Fetched and compared `origin/main` at `582d6e5cee69d06c0a78bf298fea8b93279ebe97`. Its newer changes concern release versions and state; no newer integration architecture needed adoption. No merge or unrelated package version bump was made.

## Final passing gates

```bash
pnpm install --frozen-lockfile
uv sync --locked --all-packages
pnpm typecheck
uv run --no-sync pnpm check
pnpm ci:verify-projects
git diff --check
```

- Typecheck: 25 successful tasks.
- Root check: 198 repository tests, 184 protocol tests, and all 17 project checks passed with no cached project checks. Includes formatting, lint, schema checks, documentation snippet compilation, site build and production routes. `pnpm check` executes the repository and protocol gates directly.
- Adapter: seven behavior tests plus seven published TanStack conformance cases. Covers metadata-only discovery, native loading, text/base64 reads, digest rejection, path rejection, immutable pins, separate sessions, sanitized errors, borrowed ownership, and draining in-flight work on close. Optional revision and script methods are absent; their conformance branches return without exercising those capabilities.
- Demo: two ai-mock tests use an actual CLI-built tar.gz origin over loopback HTTP, the public SDK, and the native TanStack chat loop. One selects a skill and reads its reference; the unrelated-question path downloads no artifact.
- Existing integrations: included in the root checks and complete candidate workflow below. Mastra's 21 adapter tests pass after sharing its origin fixture.
- Documentation: installation and usage guide, API reference, example/package/root README links, navigation and agent-readable discovery are checked.
- CI and release: independent `integration-tanstack-ai` scope, native behavior and installed-package checks, deterministic demo, artifact inventory and candidate runner. Release tests verify unrelated manifests remain byte-identical and select only exact candidate filenames.

The protocol harness launches `python3`; `uv run --no-sync` supplies the locked environment to subprocesses.

## Complete cold-cache artifact and candidate workflow

This command exited successfully against the clean implementation commit:

```bash
REMOTE_SKILLS_PYTHON=/Users/ran/.codex/worktrees/0682/remote-skills/.venv/bin/python \
  uv run --no-sync pnpm publication:readiness /tmp/tanstack-parity-readiness-v6
```

The workflow prepares empty private dependency caches, checks all registered artifacts with registry access disabled, verifies strict peer resolution and exact lockfile snapshots, installs npm and Python artifacts in clean consumers, and runs every registered candidate demo. Core, Vercel AI SDK, LangChain, Mastra and TanStack candidate suites all passed. The TanStack runner installs only the selected CLI, client and adapter tarballs plus locked third-party dependencies, then runs both demo cases without source-package fallback.

Cold-cache runs exposed optional-peer differences hidden by workspace installs. Explicit test dependencies now preserve the TanStack conformance/demo graph and LangChain's WebSocket peer in isolated consumers; exact snapshot comparison remains enforced. The TanStack package checker uses the shared offline installer.

Retained local evidence:

- `/tmp/tanstack-parity-readiness-v6/verification.json`: clean source commit, environment, artifact inventory and hashes; status `local-artifacts-verified`.
- `/tmp/tanstack-parity-readiness-v6.log`: entire successful workflow, including candidate demos after artifact verification.
- `/tmp/tanstack-parity-final-typecheck.log` and `/tmp/tanstack-parity-final-check.log`: final root gates.
- `/tmp/tanstack-parity-final-projects.log`: all 17 project gates registered.

TanStack archive: `remote-skills-tanstack-ai-0.0.1-alpha.0.tgz`, 6,653 bytes. SHA-256: `2b880eb76b982ee7715423f4f2d94ffeb37623e5699a2377c03ed2ccf820ac4b`. Its five entries include runtime code, declarations, manifest, README and license; development scripts and dependencies are excluded.

## Limits

No remaining local parity blocker. Remote CI, Linux, Windows and paid/live model calls were not run. Mock responses establish integration behavior, not live model reliability. Resource bytes are UTF-8 text when decoding succeeds and base64 otherwise; script access is intentionally absent.

No package publication, push, pull request, merge or tag occurred. Local artifacts and a publication-plan file are validation outputs only.

Run the demo with the commands in [its README](../../examples/tanstack-ai/README.md). Keep one source per conversation, keep it open through response completion, and close it afterward.

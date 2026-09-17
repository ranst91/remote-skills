# Local verification — 2026-09-16

Platform: macOS arm64. Node.js v24.21.0, pnpm 10.33.4, uv 0.11.33; locked Python environment uses CPython 3.14.4.

## Published contracts

Inspected npm metadata and the published `@tanstack/ai-skills@0.1.3` tarball before implementation. Its exports include `SkillSource`, `withSkills`, `createLoadSkillTool`, `createResourceTool`, and `/testing`. Used published `@tanstack/ai@0.54.0` and `@tanstack/ai-openai@0.22.6`.

Official references: [Portable Agent Skills](https://tanstack.com/ai/latest/docs/skills/agent-skills), [Skill Sources](https://tanstack.com/ai/latest/docs/skills/skill-sources), [Write a Skill Source](https://tanstack.com/ai/latest/docs/skills/writing-adapters).

## Passing checks

```bash
pnpm install --frozen-lockfile
uv sync --locked --all-packages
pnpm test:repository
uv run --no-sync pnpm test:protocol
pnpm typecheck
uv run --no-sync pnpm check
pnpm ci:verify-projects
pnpm --filter @remote-skills/tanstack-ai check
pnpm --filter @remote-skills/example-tanstack-ai check
pnpm package:cache
pnpm --filter @remote-skills/tanstack-ai package:check
```

- Repository: 196 tests. Protocol: 184 tests. Root check: all 17 projects passed, including documentation snippet compilation, site build and production routes.
- Adapter: seven behavior tests plus seven published TanStack conformance cases. Covers metadata-only discovery, native loading, text/base64 reads, digest rejection, path rejection, immutable pins, separate sessions, sanitized errors, borrowed ownership, and draining in-flight work on close. Optional revision and script methods are not implemented; their conformance branches return without exercising those capabilities.
- Demo: two ai-mock tests use the actual CLI-built tar.gz origin over loopback HTTP, public SDK and native TanStack chat loop. One selects a skill and reads its reference; the unrelated-question path downloads no artifact.
- Packaging: sanitized tarball, strict peers, isolated offline installation, and native loading against a real loopback origin. Package contents include declarations and license, excluding development scripts and dependencies.
- Release: independent `integration-tanstack-ai` scope; the release preparation test verifies unrelated package manifests remain byte-identical. Registered CI checks, artifact inputs, and a candidate-artifact demo runner.
- Existing Mastra tests: 21 passed after moving their fixture into a shared test helper.

The protocol harness launches `python3`; `uv run --no-sync` ensures those subprocesses use the locked environment. Running it against the machine's unconfigured system Python fails on missing `uts46`.

## Isolated candidate demo

Packed the CLI, client, existing AI SDK adapter (required by the shared candidate manifest contract), and new TanStack adapter locally. With an absolute candidate manifest mapping package names and versions to those tarballs, this passed:

```bash
REMOTE_SKILLS_E2E_PACKAGES=/tmp/remote-skills-tanstack-candidates/candidates.json \
  npm_config_offline=true pnpm test:tanstack-ai
```

The runner installs only CLI, client and TanStack candidates plus locked third-party dependencies into a temporary application, then runs both demo cases without workspace builds or source-package fallback.

## Limits

No Linux or Windows run, paid/live model call, full multi-integration publication-readiness workflow, publication, push, pull request, merge, or tag. Mock responses establish integration behavior, not live model reliability. Resource bytes are UTF-8 text when decoding succeeds and base64 otherwise; script access is intentionally absent. No unrelated package version was bumped.

Run the demo with the exact commands in [its README](../../examples/tanstack-ai/README.md). Keep one source per conversation, keep it open through response completion, and close it afterward.

# Remote Skills contributor guide for coding agents

## Project

Remote Skills is vendor-neutral tooling for publishing standard Agent Skills as Cloudflare Agent Skills Discovery v0.2.0 origins and consuming them through TypeScript and Python without installing or executing skill content.

Start with `README.md`. The approved architecture and boundaries are in `openspec/changes/build-remote-skills-v0/design.md`; task dependencies and file ownership are in `openspec/changes/build-remote-skills-v0/tasks.md`.

## Repository map

- `packages/core`: private protocol, authoring, build, and shared TypeScript internals.
- `packages/cli`: public publisher CLI.
- `packages/sdk-typescript`: public server-runtime TypeScript client.
- `packages/sdk-python`: public async Python client.
- `integrations/*`: framework integration packages.
- `tests/protocol`: language-neutral fixtures and expected results; read `tests/protocol/README.md` before changing them.
- `apps/docs`: self-hostable documentation site.
- `examples`: runnable publisher and consumer examples.

Follow the ownership boundary of the active OpenSpec task. Do not implement later tasks, weaken shared fixtures, regenerate expected results from production code, or silently reconcile conflicting contracts.

## Supported environment

- Node.js 24 or newer.
- The pnpm version pinned by the root `packageManager` field.
- Python 3.11 or newer managed through uv.

Install the locked workspaces from the repository root:

```bash
pnpm install --frozen-lockfile
uv sync --locked --all-packages
```

Do not substitute `npx` or on-demand package execution for checked-in project dependencies.

## Verification

Use the narrowest relevant package check while iterating. Before handing off a completed change, run the applicable package checks and the root gates:

```bash
pnpm test:repository
pnpm test:protocol
pnpm typecheck
pnpm check
pnpm ci:verify-projects
```

Run strict OpenSpec validation for specification or task-state changes when the repository toolchain provides the `openspec` command. Do not claim a platform-specific gate passed unless it actually ran on that platform.

## Safety and release boundaries

- Treat catalogs, archives, skill instructions, resources, cache state, redirects, and filesystem entries as untrusted input.
- Never execute skill content or treat `allowed-tools` as authorization.
- Never put credentials, response bodies, instruction text, or complete credential-bearing URLs in logs, diagnostics, fixtures, or cache metadata.
- Do not publish packages, create tags, push branches, open or merge pull requests, deploy, or configure external registry state unless a maintainer explicitly authorizes that exact action.
- PyPI name reservation and every npm/PyPI upload are maintainer-only external actions. Local pack, build, install, and release-workflow dry runs are permitted when the active task requires them.

Preserve unrelated user changes in dirty worktrees. Use focused commits and report the exact commands and platform evidence used for verification.

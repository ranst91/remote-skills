## Why

Agent Skills are standardized as local folders, and Cloudflare's discovery RFC standardizes how a domain advertises downloadable skill artifacts, but agent developers still lack one vendor-neutral tool that owns both ends of the runtime workflow. Remote Skills fills that gap: publishers produce a standards-compatible static origin, while agents discover, verify, cache, pin, and read skills on demand without installing copies into every agent.

## What Changes

- Establish a pnpm/Turborepo and uv monorepo for a Node.js publisher CLI, TypeScript consumer SDK, async Python consumer SDK, shared protocol fixtures, runnable examples, and a Fumadocs site.
- Add `remote-skills validate`, `build`, `dev`, and `verify` for canonical Agent Skills source trees and Cloudflare discovery v0.2.0 origins.
- Produce deterministic, deploy-ready `skill-md` or content-addressed archive artifacts and a relative-URL `/.well-known/agent-skills/index.json` for any static HTTPS host.
- Add model-agnostic consumer APIs for compact catalog discovery, origin-bound sessions, digest-pinned activation, safe text/byte resource access, explicit refresh, bounded content-addressed caching, and offline policy.
- Add provider-authorized catalog scopes through a standard Remote Skills request/confirmation header, artifact-side authorization, and credential-free scope-partitioned catalog caching; merely naming a scope never grants access.
- Add optional provider SemVer metadata and an ignorable inline release-history extension so consumers can select the highest advertised release matching an explicit SemVer range while ordinary Cloudflare v0.2.0 consumers continue to use the standard current entry.
- Provide exact behavioral parity between the TypeScript and Python SDKs through shared protocol fixtures, stable error codes, and a shared on-disk cache contract.
- Enforce fail-closed digest, schema, archive, path, network, redirect, credential-forwarding, size, timeout, and cache-publication boundaries. Downloaded scripts remain untrusted data and are never executed by the toolkit.
- Produce self-contained local package artifacts named `@remote-skills/cli`, `@remote-skills/client`, and `remote-skills`, initially coordinated at `0.0.1` and governed by SemVer's major-zero rules. Run the complete local pack, build, and clean-install gates on Linux and clean-install each public artifact on Windows; v0 includes no npm/PyPI publishing, registry configuration, or upload workflow.
- Replace the current conceptual README with an approved minimal outcome-focused README, and publish the complete guides and API reference through Fumadocs.
- Document the exact archive-to-origin workflow, Git-backed static hosting, origin-root well-known-path caveats, when local Docker/Git bundling is preferable, and the disk/cache costs of lazy remote activation; Git-backed hosting guidance is release-blocking for v0.
- Make the repository and published documentation straightforward for coding agents to navigate through a concise root `AGENTS.md`, a standards-shaped docs-site `llms.txt`, and clean Markdown documentation entry points without introducing a vendor-specific agent integration.

## Capabilities

### New Capabilities

- `skill-origin-publishing`: Validate standard skill directories and deterministically build, serve, and remotely verify a Cloudflare discovery v0.2.0 skill origin.
- `remote-skill-consumption`: Discover configured origins, request provider-authorized catalog scopes, resolve optional versioned skills with explicit SemVer ranges, and safely activate, pin, cache, list, and read verified artifacts in TypeScript and Python.
- `protocol-compatibility`: Keep publisher output and both consumer implementations behaviorally identical across standards versions, errors, cache layout, security limits, and supported operating systems.
- `agent-accessibility`: Provide conventional, concise entry points for coding agents contributing to the repository and for agents consulting the published documentation.

### Modified Capabilities

None. The repository currently contains only a conceptual README and has no existing OpenSpec capabilities.

## Impact

- Adds the complete initial repository structure under `packages/`, `apps/docs/`, `tests/protocol/`, and `examples/`.
- Introduces locally buildable npm and Python distribution artifacts, CLI commands, TypeScript and Python APIs, a declarative `remote-skills.json` schema, a shared cache layout, and deploy-ready static files.
- Adds Node.js 24+, pnpm, Turborepo, Python 3.11+, uv, Fumadocs, Linux-primary CI, focused Windows installed-product checks, and publication-readiness checks that perform no registry action.
- Depends normatively on the Agent Skills specification and Cloudflare Agent Skills Discovery RFC draft v0.2.0; it does not redefine either format.
- Requires explicit user approval of the replacement README after these planning artifacts and before implementation.

## Non-goals

- No skill marketplace, ranking service, hosted Remote Skills service, deploy command, or proprietary registry.
- No local installer, direct arbitrary artifact URLs, digest-less Cloudflare v0.1 compatibility, or custom signing protocol.
- No browser SDK, OAuth/credential manager, framework adapters, MCP bridge, or vendor-specific agent integration in v0.
- No relevance model, automatic skill selection, client-side permission enforcement, or execution of bundled scripts. Providers enforce authentication, scope authorization, and artifact access at their origin.
- No built-in blacklist, whitelist, authorization rules language, or catalog-derived TypeScript/Python type generator in v0.
- No live-model evaluation suite, agent benchmark, tool-specific instruction-file matrix, or guarantee that every model completes every task.
- No guarantee of API stability beyond SemVer's major-zero rules.

## Release boundary

The v0 implementation is complete when the CLI and both SDKs satisfy the normative specs and shared fixtures in the primary Linux CI lanes; the CLI, TypeScript client, and Python distribution each clean-install and run through their public entry points on Windows; deploy-ready output and Fumadocs documentation are reproducible; and the npm tarballs plus Python wheel/source distribution pass local build, inspection, and clean-install dry runs. Completion SHALL NOT require or perform package publication, registry name reservation, registry/OIDC configuration, credentials, tags, or uploads.

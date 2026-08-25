## Why

Agent Skills are standardized as local folders, and Cloudflare's discovery RFC standardizes how a domain advertises downloadable skill artifacts, but agent developers still lack one vendor-neutral tool that owns both ends of the runtime workflow. Remote Skills fills that gap: publishers produce a standards-compatible static origin, while agents discover, verify, cache, pin, and read skills on demand without installing copies into every agent.

## What Changes

- Establish a pnpm/Turborepo and uv monorepo for a Node.js publisher CLI, TypeScript consumer SDK, async Python consumer SDK, shared protocol fixtures, runnable examples, and a Fumadocs site.
- Add `remote-skills validate`, `build`, `dev`, and `verify` for canonical Agent Skills source trees and Cloudflare discovery v0.2.0 origins.
- Produce deterministic, deploy-ready `skill-md` or content-addressed archive artifacts and a relative-URL `/.well-known/agent-skills/index.json` for any static HTTPS host.
- Add model-agnostic consumer APIs for compact catalog discovery, origin-bound sessions, digest-pinned activation, safe text/byte resource access, explicit refresh, bounded content-addressed caching, and offline policy.
- Provide exact behavioral parity between the TypeScript and Python SDKs through shared protocol fixtures, stable error codes, and a shared on-disk cache contract.
- Enforce fail-closed digest, schema, archive, path, network, redirect, credential-forwarding, size, timeout, and cache-publication boundaries. Downloaded scripts remain untrusted data and are never executed by the toolkit.
- Publish packages as `@remote-skills/cli`, `@remote-skills/client`, and `remote-skills`, initially coordinated at `0.0.1` and governed by SemVer's major-zero rules. Use tag-driven npm/PyPI Trusted Publishing and cross-platform package dry runs.
- Replace the current conceptual README with an approved minimal outcome-focused README, and publish the complete guides and API reference through Fumadocs.

## Capabilities

### New Capabilities

- `skill-origin-publishing`: Validate standard skill directories and deterministically build, serve, and remotely verify a Cloudflare discovery v0.2.0 skill origin.
- `remote-skill-consumption`: Discover configured origins and safely activate, pin, cache, list, and read verified remote skill artifacts in TypeScript and Python.
- `protocol-compatibility`: Keep publisher output and both consumer implementations behaviorally identical across standards versions, errors, cache layout, security limits, and supported operating systems.

### Modified Capabilities

None. The repository currently contains only a conceptual README and has no existing OpenSpec capabilities.

## Impact

- Adds the complete initial repository structure under `packages/`, `apps/docs/`, `tests/protocol/`, and `examples/`.
- Introduces public npm and PyPI packages, CLI commands, TypeScript and Python APIs, a declarative `remote-skills.json` schema, a shared cache layout, and deploy-ready static files.
- Adds Node.js 24+, pnpm, Turborepo, Python 3.11+, uv, Fumadocs, cross-platform CI, and trusted-release workflows.
- Depends normatively on the Agent Skills specification and Cloudflare Agent Skills Discovery RFC draft v0.2.0; it does not redefine either format.
- Requires explicit user approval of the replacement README after these planning artifacts and before implementation.

## Non-goals

- No skill marketplace, ranking service, hosted Remote Skills service, deploy command, or proprietary registry.
- No local installer, direct arbitrary artifact URLs, digest-less Cloudflare v0.1 compatibility, or custom signing protocol.
- No browser SDK, OAuth/credential manager, framework adapters, MCP bridge, or vendor-specific agent integration in v0.
- No relevance model, automatic skill selection, permission enforcement, or execution of bundled scripts.
- No guarantee of API stability beyond SemVer's major-zero rules.

## Release boundary

The v0 implementation is complete when the CLI and both SDKs satisfy the normative specs and shared fixtures on Linux, macOS, and Windows; deploy-ready output and Fumadocs documentation are reproducible; packages pass publication dry runs; and a legitimate `0.0.1.dev0` Python development release can claim the currently unclaimed PyPI name through Trusted Publishing. The first intended non-development release is `0.0.1`.

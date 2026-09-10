# Shared protocol contract

This directory is the language-neutral v0 contract for the publisher and both consumer SDKs.
Checked-in inputs and expected results are reviewed artifacts; production implementations must
consume them directly and must not regenerate their expectations.

## Contract states

- Run `pnpm test:protocol` from the repository root to validate checked-in contracts, fixture
  integrity, and both complete SDK adapters. All currently registered suites are expected GREEN.
- `node tests/protocol/adapters/typescript-protocol-adapter.mjs` is the stable TypeScript launch shim
  and is expected GREEN for every registered case.
  Tasks 5.1 and 5.2 execute the owned catalog, cache, network, redaction, and transcript slice; its
  cache race uses the same actual Python and Node publishers as the Python entrypoint.
- `python tests/protocol/adapters/python_protocol_adapter.py`, with the Python SDK available in the
  active environment, is expected GREEN for every registered case. Tasks 6.1, 6.2, 6.6, and 6.3 supply
  `remote_skills.protocol_adapter` for catalog, cache, archive, publisher-activation, owned network,
  redaction, and request-transcript cases. The Python package gate enumerates that owned slice
  dynamically and runs every case through this adapter; the cache race launches actual Python and
  Node publishers.
  The shared cache contract also requires either runtime to reclaim dead pre-publication process,
  lock, and lease-generation orphans with one bounded scan while preserving live or replaced state.
  Offline, removal, and lifecycle cases are included in the current green gate. Run one case with
  `--case cache-v1-cross-process`.

Task 3.1 deliberately captured RED adapters before SDK implementation. That historical acceptance
step does not describe the current gate: `adapter-contract.test.ts` requires both whole adapters to
exit successfully and verify every registered case. This expectation does not mark remaining
OpenSpec acceptance tasks complete. Each SDK entrypoint implements one case at a time; the shared
adapter, not SDK code, enumerates every registered case and compares the returned value to the
static expected result.

Task 3.5 adds scoped catalog and optional SemVer contracts to the existing catalog, network,
request-transcript, cache-layout, and publisher-history fixtures. Repository fixture validation is
green, and tasks 5.6 and 6.6 implement the catalog, cache, transport, and resolver primitives for
both SDK adapters. Publisher-history cases are structural task-4.2 inputs and are not registered as
SDK adapter cases. Expected results are reviewed static artifacts and are never generated from a
publisher or consumer implementation.

Supplemental scope/version registries are listed separately in `sdk-adapters.json`. Both shared
adapter entrypoints enumerate them, while the pre-3.5 `suites` registries retain the stable package-
owned inventory used by tasks 5.1/5.2 and 6.1/6.2. Both scope/version adapters pass all 49
task-owned cases after their session lifecycle tasks. Supplemental activation, existing-session
version pinning, and explicit bounded-stale behavior are production-backed in both languages.

`Remote-Skills-Scope` is non-secret and remains visible in sanitized request transcripts.
Authorization credentials are runtime-only. No fixture, expected result, diagnostic, or cache
metadata stores a token, credential hash, or authorization value.

Publisher archives intentionally contain regular-file entries only. Parent directories are implied
by POSIX member paths and ZIP names, so `directory_entries` is `omitted`; `directory_mode` is not an
observable archive field. Every file entry is normalized to mode `0644` and is checked byte-for-byte
against its canonical source.

## Versioning and secrets

The contract version and cache-layout version are independent. A breaking cache change creates a
new layout namespace. Stable error codes remain lower snake case.

Secret values are supplied only at runtime. Fixtures may name a sensitive header or a runtime
placeholder, but snapshots, diagnostics, cache states, and expected results must never contain the
runtime value. The tests construct an unmistakable synthetic canary in memory and scan every
checked-in protocol file for its absence.

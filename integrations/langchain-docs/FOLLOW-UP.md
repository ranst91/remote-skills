# LangChain integration follow-up — September 11, 2026

Branch: `codex/feat-langchain-integrations`.
Freshly fetched base: `5ac641417fe23287be275527169923d0a528b49a` (`origin/main`).
The original integration commits were rebased as `e912521` and `7864c10`.
The shared Integrations navigation scaffold was cherry-picked from Mastra's
`f5759d72c208736dbdc54b71aa9e50b9123125fa` as `dd37185`.

## Scope

- Preserve native DeepAgents, plain LangChain and native-agent LangGraph subgraphs
  in TypeScript and Python. Arbitrary raw graph nodes remain unsupported.
- Reconcile the released SDK alpha versions and locally built integration artifacts.
- Connect the actual browser, Next route, both native runtimes and a CLI-built
  origin in one deterministic six-path test. Preserve existing focused tests.
- Publishable-site documentation, six checked consumer examples, submenu and
  agent-readable routes. Preserve `/docs/vercel-ai-sdk`.
- Fresh live browser validation is manager-owned because approval review rejects
  parent-task provider authorization in this implementation task. No indirect
  provider execution is performed here.

## Local alpha packaging

The TypeScript adapter is `0.0.1-alpha.0` with client peer `^0.0.1-alpha.0`.
The Python adapter is `0.0.1a0` with SDK requirement `remote-skills==0.0.1a0`.
The native framework pins remain unchanged.

TypeScript `pack:local` stages emitted code, license and README with a runtime-only
manifest. Its check compares repeated pack bytes, inspects archive contents,
installs SDK/adapter archives offline with strict peers into a fresh consumer,
compares dependency resolutions against the source lock and rejects workspace
import fallback. Offline resolution retains the normal registry metadata cache
key, following main's existing behavior; `--offline` prevents registry requests.
Python checks inspect both wheel and sdist metadata/content, install each pair
with the SDK in separate external environments, verify dependencies and isolated
import provenance, and invoke the native agent against the installed adapter.
Both packages are registered in the local package-input and package-check gates.

## Publication enrollment remains out of scope

These new integration packages are **not publication-ready**. Local artifact
verification is not enrollment in the coordinated release pipeline. No issued
release intent, artifact manifest, tag or registry state was changed.

A future shared release-owner change must cover:

1. `scripts/release/release-lib.ts`: enroll the TypeScript integration descriptor
   and generalize Python metadata/version handling beyond the single SDK;
   explicitly decide how first publication of new integration packages joins the
   coordinated version policy.
2. `scripts/check-publication-readiness.ts`: include both new package artifacts,
   dependency installation checks and resulting hash/provenance entries in a
   newly generated future release manifest.
3. `scripts/release/integration-dependencies.ts` and installed-consumer helpers:
   extend the currently AI-SDK-specific release checks to the new native packages
   without changing the source lock graph or relying on workspace resolution.
4. `.github/workflows/prepare-release.yml` and `publish-release.yml`: include the
   new package manifests in future release updates and select the verified new
   archives for future uploads. The existing npm loop names only client, CLI and
   AI SDK; Python publication handles only the SDK. Update release-workflow tests
   together and preserve all already-issued records.

That shared policy/enrollment work and any actual publication need separate
maintainer handling. This delivery covers integration, example, docs and local
verification readiness.

## Verification and fresh browser evidence

Verified locally on Darwin 24.1.0 arm64 with Node 24.21.0, pnpm 10.33.4,
uv 0.11.33 and workspace Python 3.14.4. No Linux or Windows execution is claimed.
Python checks used `UV_CACHE_DIR=/tmp/remote-skills-langchain-uv-cache`;
combined gates also used `REMOTE_SKILLS_PYTHON` pointing at this checkout's
`.venv/bin/python`.

Passed commands:

- `pnpm test:repository`: 118 tests.
- `pnpm test:protocol`: 184 tests.
- `pnpm typecheck`: 19 workspace tasks plus repository/policy checks.
- `pnpm check`: all 13 workspace checks plus formatting, lint, schema,
  repository TypeScript/policy, repository tests and protocol tests.
- `pnpm ci:verify-projects`: 13 projects registered.
- `pnpm package:check`: all six locally registered package gates, including
  external installed TypeScript and Python consumers.
- `pnpm --filter @remote-skills/langchain package:check`: repeated after independent
  review added manifest fidelity assertions and the inherited tsconfig input.
- `pnpm test:langchain`: real Chromium/Next/native-runtime E2E, six paths plus
  parent test (7 passed). Only the external model is replaced with a deterministic
  loopback model; origin archives come from the actual CLI.
- `pnpm --filter @remote-skills/example-langchain build`: production build passed.

The website's six snippets are checked in separate compiler contexts. Core stays
strict; only the LangChain context skips upstream declaration checking because
pinned DeepAgents declarations refer to missing Zod types. Consumer snippet bodies
remain strict. Python examples are compiled/import-checked without executing their
networked bodies. The docs build and production Markdown routes are exercised by
`pnpm ci:test:examples`, which passed: docs production routes, existing Vercel
browser suite (8 tests) and LangChain browser suite (7 tests), alongside the
registered example/package tests. The final CI-group LangChain run took 24.6 seconds.

The final demo is running at `http://127.0.0.1:5182`, with its local origin on
port 8792 and server-configured model `gpt-4.1`.

### Fresh manager-owned live browser result

On September 11, the manager independently ran
`node /tmp/langchain-main-live-v2.mjs` against verified source commit
`b8feef962f72d165e626bcdffab2429aa7205a93`; it exited zero. All six picker options
passed with real Chromium, the real Next API, native runtimes and live `gpt-4.1`.
Each submitted “Welcome a new teammate using our prescribed greeting style.”
once in that run. Every option showed catalog discovery, native `read_file`
instruction load, native reference load, those reads in order, and the prescribed
“Ahoy, curious human!” opening after the tools. Every scoped application-error
count was zero. This report-only update does not change the verified sources.

The original run is also preserved. Its native read/order/greeting checks passed,
but the harness falsely counted Next.js's empty accessibility route announcer as
an application error. A separate fresh-page inspection with no submission
confirmed an empty alert with id `__next-route-announcer__` inside
`NEXT-ROUTE-ANNOUNCER`, while `.alert[role="alert"]` counted zero. The corrected
harness scopes the check to that application error selector. This was a harness
correction, not six model failures or an unrecorded retry-until-success loop.
Each option was submitted once per recorded run.

The harness checks actual rendered native inputs/outputs and chronological final
replies. Completion is inferred from the enabled composer and absent app error;
it does not reread the intentionally canceled NDJSON body. Raw stream ordering
remains covered by the route tests. Summary screenshots collapse activity and
scroll the chat to its final answer; separate reference screenshots and videos
preserve the visible native read evidence. One successful live run does not
promise deterministic model selection for every prompt; the historical bare
“Hello!” behavior remains discretionary.

Permanent manager-owned local evidence:

- [Evidence index and all six screenshots/videos](/Users/ran/.codex/visualizations/2026/09/09/01a0865c-95e9-79b0-9d6e-1b1af289c939/remote-skills-proof/2026-09-11/README.md).
- [Corrected results, source/fixture hashes and artifact paths](/Users/ran/.codex/visualizations/2026/09/09/01a0865c-95e9-79b0-9d6e-1b1af289c939/remote-skills-proof/2026-09-11/langchain-verified/results.json).
- [Preserved original-run results](/Users/ran/.codex/visualizations/2026/09/09/01a0865c-95e9-79b0-9d6e-1b1af289c939/remote-skills-proof/2026-09-11/langchain-original/results.json).

The earlier matrices in `live-validation.json` describe the pre-rebase delivery
and are historical evidence, not verification of this follow-up.

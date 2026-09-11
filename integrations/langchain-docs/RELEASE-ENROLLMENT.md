# LangChain scoped release enrollment

This follow-up enrolls the two LangChain adapters in the scoped release pipeline
merged at `16af9989895d90dea5345cbd8b9438256459e04f`. It supersedes the outstanding
enrollment limitation in `FOLLOW-UP.md`; it does not publish either package.

## Selection and compatibility

Select `integration-langchain` in the release preparation workflow. The scope
coordinates `@remote-skills/langchain` and `remote-skills-langchain` at equivalent
SemVer/PEP 440 versions and creates one `integration-langchain/v…` release. Core,
AI SDK and other framework scopes retain their own versions. Repeating a selection
replaces its request from the same baseline; accumulating another scope preserves
both selections and maintainer notes.

A local preview is `node scripts/release/release.ts prepare integration-langchain patch alpha --dry-run`.
Starting at the checked-in adapter versions, this plans
TypeScript `0.0.1-alpha.1` and Python `0.0.1a1`. It changes only their manifests,
`CHANGELOG.md` and `release-state.json`; lockfiles are refreshed by the existing
preparation workflow when a maintainer prepares the actual release.

The Python adapter's SDK requirement remains exact. An incompatible core bump
fails before writing files; it requires explicit dependency review and selection
of the integration scope. The preparer does not silently relax SDK requirements.
The package and installation checks independently validate those requirements.

## Artifact verification

The registry contains named npm and Python descriptors. Candidate verification
builds dependency artifacts for testing independently of the selected publication
set. The retained publication plan hashes only selected packages. Python wheel
and sdist filenames are matched exactly by package name and version, including
prerelease numbers. Published-version retry checks use the existing exact registry
version and artifact digest policy.

Installed journeys run the candidate CLI and both candidate adapters outside the
workspace, verify installed versions and archive provenance, and retain locked
native framework dependencies. The six browser paths call the real Next API and
native runtimes against CLI-built skills with only the external model replaced by
a deterministic loopback server. No live-provider validation is needed for this
release-tooling-only change.

Historical coordinated releases retain their original package selection. A newly
enrolled package may be absent only when it is also absent from the historical
Git tree; a missing tracked package still fails. Existing issued release records
are not rewritten.

## Verification record

The cold-cache release simulation passed on implementation commit
`dad56230bb67029e5c30bffc64bba2a8a9e5adb7`, with disposable release commit
`c9c08546b0111820e9bf4640678a4e6f26d4bc9f`. The simulation selected only LangChain
TypeScript `0.0.1-alpha.1` and Python `0.0.1a1`; the retained plan contains exactly
two packages and three archives. All eight constructed dependency and integration
artifacts passed inspection and isolated installation. The no-publication gate
reported zero findings. The installed candidate suite passed all 16 tests,
including all six LangChain browser/runtime paths and the core and Vercel journeys.

The explicit cache-seeding stage uses declared locked dependencies. Subsequent
candidate installations are offline. The dependency comparator also covers pnpm's
explicit YAML mapping syntax for long peer snapshot keys and rejects changed
versions, integrity hashes, or dependency edges.

Evidence is retained under
`/Users/ran/.codex/visualizations/2026/09/10/01a08b16-ecd1-7261-9ebb-b112aa5812ac/langchain-release-enrollment/`:
`receipt.json`, `artifacts/publication.json`, `artifacts/verification.json`, the
exact archives, release preview, and complete cold-run log. Selected archive SHA-256
hashes were recomputed from the retained bytes and matched the publication plan.

Platform: macOS arm64, Node 24.21.0, pnpm 10.33.4, workspace Python 3.14.4;
artifact checks also installed against the supported minimum Python 3.11.
Final root gates passed on that implementation commit:

- `pnpm test:repository`: 163 tests passed.
- `pnpm test:protocol`: 184 tests passed.
- `pnpm typecheck`: 19 workspace tasks passed.
- `pnpm check --concurrency=1`: all 13 workspace tasks passed, including all
  417 Python SDK tests and the unchanged deadline regression.
- `pnpm ci:verify-projects`: 13 workspace projects verified.

The protocol, typecheck and full-check commands used
`REMOTE_SKILLS_PYTHON=/Users/ran/.codex/worktrees/6a58/remote-skills/.venv/bin/python`.
The full-check argument limits workspace concurrency without changing test
thresholds or coverage. An earlier system-Python invocation lacked project
requirements; an earlier concurrent SDK test hit its deadline. Both reruns above
passed with the configured environment and sequential checks. No Linux or Windows
run is claimed. No specification or task-state files changed, and no installed
`openspec` command was available.

No registry upload, tag, external workflow, branch push or PR creation was performed
by this implementation task. The manager opened draft PR #13 separately.

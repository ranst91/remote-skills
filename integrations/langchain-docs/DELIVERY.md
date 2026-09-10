# LangChain family delivery

Branch: `codex/integration-langchain`.
Starting shared commit: `44e088199d1488972a815a7a8df0db4c14021b36`.
The fetched shared branch had not advanced beyond the assigned baseline.

## Native compatibility

| Host surface | TypeScript | Python |
| --- | --- | --- |
| DeepAgents | Supported through coordinated native backend/skills/filesystem middleware options; default general-purpose and explicitly configured custom subagents tested | Supported through coordinated native options; default general-purpose delegation tested; async only |
| Plain `createAgent` / `create_agent` | Native DeepAgents middleware composed directly | Native DeepAgents middleware composed directly; async only |
| Manual LangGraph nodes and edges | Native agent's public compiled `.graph` is a subgraph node | Native compiled agent is a subgraph node; async only |

Arbitrary raw model/tool nodes have no exported native skills middleware runtime
in the tested releases. Direct raw-node support is incompatible. The supported
graph route retains the complete native agent as a subgraph, without rebuilding
its middleware behavior.

Tested TypeScript releases: DeepAgents1.13.4, LangChain1.5.11,
LangGraph1.4.14, LangChain Core1.2.10, LangSmith0.9.0, Zod4.3.6.
Tested Python releases: DeepAgents0.7.13, LangChain1.4.0,
LangGraph1.2.11. Demo model bindings are LangChain OpenAI1.5.12(TS)
and1.6.2(Python). Lockfiles retain the complete dependency graphs.

Each adapter binds one caller-owned SDK session/origin. Separate explicit
metadata and content views implement the released native backend protocols.
Native discovery lists names and reads catalog-derived frontmatter projections;
it downloads no artifact. Native `read_file`, or explicit listing inside a
selected skill, activates the original whole artifact through the SDK. Digest
verification, auth/scope, cache, version policy and session pins remain SDK
responsibilities. Resources enter context from that pin when requested.

DeepAgents helpers pass backend, skills and native middleware together: upstream
same-name replacement routes both root and default general-purpose discovery to
the metadata view before hooks run. Passing automatic skills against the content
backend alone would eagerly activate during discovery. Native delegation tests
prove the complete helper configuration. The exposed filesystem tools are native
`ls` and `read_file`; no command execution, writes, search, mirror, rebuilt
archive, replacement skill tool or monkeypatch is supplied.

## Consumer entry points

TypeScript: create an SDK session, call `remoteSkills({session})`, and supply
`remote.middleware` to `createAgent`, or `remote.deepAgentOptions` to
`createDeepAgent`. Close the adapter and then its caller-owned session.

Python: keep an SDK session async context open, call
`await create_remote_skills_backend(session)`, and supply `source.middleware()`
to `create_agent`, or `**source.deep_agent_options()` to `create_deep_agent`.
Use async execution on the originating event loop. Sync content calls fail before
network effects; no background event-loop bridge is introduced.

See the package READMEs for complete checked snippets, source links, version
selection and checkpoint/lifetime constraints.

## Demo and evidence

`examples/langchain` is a Next.js chat with all six selectors. It uses the
TypeScript SDK on the Next.js server and the Python SDK in a one-request child
process for Python choices. The process boundary needs no additional Python
web framework or listening port. Each response owns an in-memory SDK session.
Completion follows session cleanup; Python completion also follows verified zero
exit and child reaping. The UTF-8 transport preserves split characters and bounds
line/response size. Stop/reset aborts work without restoring a stale reply.

The actual `POST(Request)` route-handler test uses a freshly CLI-built greeting
origin and a loopback-only scripted OpenAI SSE provider with a dummy credential.
All six cells prove catalog metadata before zero artifact requests, the native
instruction read, the exact reference read, one original artifact request,
streamed answer text, and terminal ordering. It invokes the actual handler
without a Next.js router network hop. Separate real Next.js/Chromium tests verify
the page, request shape, ordered rendering, escaping, direct answers, bounded
errors and cancellation with mocked route responses.

**Live model: not run.** Automatic approval review rejected external OpenAI
requests, including a retry documenting the public greeting-only payload. Direct
user approval remains pending in the manager task. No browser workaround or
live-provider request was made. Scripted responses are not live-model evidence.

The managed read-only demo remains at <http://127.0.0.1:5182> with publisher
<http://127.0.0.1:8792> for manager review. Live submissions remain on hold.

## Verification

Platform: Darwin24.1.0 arm64, Node24.21.0, pnpm10.33.4,
Python3.14.4, repository-pinned uv0.11.33. No Linux, Windows or Python3.11
execution is claimed.

Commands ran from the repository root. Python-dependent root gates used
`UV_CACHE_DIR=/tmp/remote-skills-langchain-uv-cache` and
`REMOTE_SKILLS_PYTHON=/Users/ran/.codex/worktrees/6a58/remote-skills/.venv/bin/python`,
matching CI's use of the synced interpreter.

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile --offline` | Passed |
| `node scripts/run-uv.ts sync --locked --all-packages --offline` | Passed |
| `pnpm --filter @remote-skills/langchain check` | Passed;23 tests and strict types |
| `pnpm --filter @remote-skills/langchain build` | Passed |
| `pnpm --filter @remote-skills/langchain package:check` | Passed;local tarball, offline clean consumer install, exported types and actual installed native invocation |
| `pnpm --filter @remote-skills/langchain-python-workspace check` | Passed;20 tests and syntax compilation |
| `pnpm --filter @remote-skills/langchain-python-workspace package:check` | Passed;wheel/sdist builds, offline fresh environment install and actual installed native consumer |
| `pnpm --filter @remote-skills/example-langchain check` | Passed;15 tests comprising six actual route paths, five browser UI cases and four process transport cases;types and skill validation |
| `pnpm --filter @remote-skills/example-langchain build` | Passed;optimized Next.js production build, static page and dynamic chat route |
| `pnpm --filter @remote-skills/docs test:content` | Passed;11 documentation tests including strict native consumer snippets |
| `pnpm test:repository` | Passed;100 tests |
| `pnpm test:protocol` | Passed;184 tests |
| `pnpm typecheck` | Passed;19 tasks and authored-code policy |
| `pnpm ci:verify-projects` | Passed;13 workspace project gates |
| `pnpm check` | Passed;13 package check tasks, plus repository/protocol/format/lint/schema/type policy gates |
| `git diff --check` | Passed |

Earlier failures were resolved: strict LangSmith peer range, duplicate Zod peer
copies, generated Next.js output registration, new workspace/snippet contracts,
and choosing CI's synced Python interpreter for cross-language protocol tests.
The first Python offline consumer setup needed the pinned uv cache format primed
with normal dependency installation; the subsequent fresh install was offline.
No existing protocol fixture or expected result was weakened or regenerated.
No old OpenSpec task status was changed. No push, PR, merge, publish, tag or
external deployment occurred.

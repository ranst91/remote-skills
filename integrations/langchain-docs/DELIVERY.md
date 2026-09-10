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

The manager task ran an authorized live baseline on September10,2026 using
`gpt-4.1-mini` and the user input `Hello!` across all six paths. Five paths read
the original instructions and reference and produced the required opening.
Plain LangChain TypeScript answered directly without tools. The original checker
reported four passes because a later instruction reread incorrectly erased the
successful DeepAgents TypeScript sequence; its preserved event order shows the
initial instruction-read, reference-read and correct final answer. An earlier
independent Python LangGraph submission skipped the reference. These runs show
variable model adherence and do not establish a reliable success rate.

The demo now supplies the same general skill-completion guidance in both
languages, including required references and the existing trust boundary.
It names no particular skill, resource, answer or forced tool choice.
One follow-up six-path `gpt-4.1-mini` run with that guidance passed DeepAgents
TypeScript, plain LangChain TypeScript and plain LangChain Python. The other
three paths read the original instructions but skipped the reference. Guidance
alone did not resolve the observed variability. A bounded six-path comparison
using `gpt-4.1` answered `Hello!` directly in every path, without using tools.
This does not establish that a model change makes bare greetings use skills.

A separate local audit of all six actual handler/native compositions with
`gpt-4.1` configuration and a dummy loopback provider verified the outgoing
catalog description/path, host completion guidance, native progressive guidance,
native `read_file` schema and automatic tool choice. No original instructions or
reference contents appeared initially; discovery fetched zero artifacts. This
checks composed requests locally, not previously sent live requests. The native
skill prompt leaves selection discretionary and contains no explicit prohibition
on tools for simple requests.

The manager then ran the separate task `Welcome a new teammate using our
prescribed greeting style.` once across all six paths with `gpt-4.1`. Every path
read the original instructions and exact reference, then streamed the required
opening and completed without an error. Unlike a bare greeting, this task asks
for prescribed context unavailable to the model initially. The fixture,
adapter, native tools and acceptance assertions were unchanged. It requests no
particular tool/file and supplies no expected answer. A separate manager browser
submission of the same task through plain LangChain TypeScript also succeeded.
After the final starter update, the manager selected DeepAgents Python and
clicked **Try team greeting** in the browser. That independent submission also
read the instructions and reference before the correct welcoming answer, with
no visible error. The manager captured actual screenshots of these browser
submissions; screenshots from mocked page tests are not counted as live proof.

The demo starter now uses that exact task, and both model defaults and
`.env.example` use the tested `gpt-4.1` configuration while preserving
`OPENAI_MODEL` overrides. Generic guidance remains the same. These changes do
not turn the successful scenario into a successful `Hello!` run or establish a
future reliability guarantee. The updated browser test clicks the actual starter
for each selector and checks the outgoing task; deterministic native tests use
the same task while retaining their explicit scripted-provider label.

[Sanitized live validation](live-validation.json) preserves all four matrices,
the original baseline checker outcome and correction, artifact/source hashes,
event order and flags. It also records the separate local request audit. No raw
model response, skill instruction body or credential is included.
Local deterministic checks remain separate from live-model evidence.
The manager owns live-provider execution and browser
evidence; automatic approval review does not accept parent-task authorization
for live execution in this implementation task, so none was attempted through
an alternate route here.

The managed demo remains at <http://127.0.0.1:5182> with publisher
<http://127.0.0.1:8792> for manager review.

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

The focused demo follow-up passed its checks, production build and every root
gate above. Its final root check completed all13 project checks in1m32s;
the separate repository/protocol runs passed100/184 tests, typecheck completed
all19 tasks, and project registration verified all13 gates. The live matrix
predates only the starter/default promotion; the
effective tested model and generic guidance are unchanged.

Earlier failures were resolved: strict LangSmith peer range, duplicate Zod peer
copies, generated Next.js output registration, new workspace/snippet contracts,
and choosing CI's synced Python interpreter for cross-language protocol tests.
The first Python offline consumer setup needed the pinned uv cache format primed
with normal dependency installation; the subsequent fresh install was offline.
No existing protocol fixture or expected result was weakened or regenerated.
No old OpenSpec task status was changed. No push, PR, merge, publish, tag or
external deployment occurred.

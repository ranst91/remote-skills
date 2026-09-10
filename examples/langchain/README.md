# LangChain family skill chat

A Next.js chat demo for six native agent compositions. Select an agent and send
`Hello!`. The model receives the native skills catalog and can choose the greeting
skill, read its original instructions, read the referenced guide, then answer.
The page shows catalog, native tool calls/results, and text in stream order.
Selection remains the model's decision; a direct answer is valid.

## Run

From the repository root, with Node.js24+, pinned pnpm10.33.4, Python3.11+ and uv:

```bash
pnpm install --frozen-lockfile
uv sync --locked --all-packages
cp examples/langchain/.env.example examples/langchain/.env
# Set OPENAI_API_KEY in the ignored .env file.
pnpm --filter @remote-skills/example-langchain dev
```

Open <http://127.0.0.1:5182>. The managed launcher builds the workspace and starts
the publisher at <http://127.0.0.1:8792>. `APP_PORT` and `SKILLS_PORT` are
configurable. Ctrl-C shuts down both managed services. `OPENAI_MODEL` defaults to
`gpt-4.1-mini`.

The frontend only talks to its Next.js route. TypeScript runs there directly.
Python selections start one Python process using the synced `.venv`; that process
runs the **Python SDK** and native async agent, then streams newline-delimited
JSON back through Next.js. This is a small process boundary, with no second web
framework, Python HTTP server, or additional listening port. Stop/reset/timeout
terminates and reaps the child. Browser completion is emitted only after a
successful child exit and session cleanup.

## Six-cell compatibility matrix

| Host | TypeScript | Python |
| --- | --- | --- |
| DeepAgents | Supported native backend/middleware configuration, including default general-purpose delegation | Supported native backend/middleware configuration, async only, including default general-purpose delegation |
| Plain LangChain `createAgent` / `create_agent` | Supported native DeepAgents middleware composition | Supported native DeepAgents middleware composition, async only |
| Manually assembled LangGraph nodes and edges | Supported **native agent subgraph** through the agent's public `.graph` | Supported **native agent subgraph**, async only |

Arbitrary raw model/tool nodes do not expose a native skills middleware runtime
in these releases. Attaching skill behavior directly to those nodes is
incompatible. The graph selections retain the original native agent runtime
inside the user-defined graph; they do not recreate its behavior.

TypeScript pins: DeepAgents1.13.4, LangChain1.5.11, LangGraph1.4.14,
LangChain Core1.2.10, LangSmith0.9.0, Zod4.3.6, LangChain OpenAI1.5.12.
Python pins: DeepAgents0.7.13, LangChain1.4.0, LangGraph1.2.11,
LangChain OpenAI1.6.2. All transitive dependencies are locked.

See the [TypeScript adapter](../../integrations/langchain/README.md) and
[Python adapter](../../integrations/langchain-python/README.md) for minimal
consumer snippets, upstream source evidence and full lifecycle contracts.
DeepAgents consumers should pass the complete `deepAgentOptions` /
`deep_agent_options()` helper so native discovery and default subagent
propagation use the correct backend views together.

## Acquisition and lifetime

Each question creates a fresh SDK session and native agent. The demo uses a
response-scoped memory cache, retains the session through the complete response,
and closes it afterward. This keeps the one-question demo easy to inspect.
For conversation-wide pins and checkpoint reuse, keep one source, native agent
and SDK session alive for that conversation and close them together. Configure
the SDK's bounded disk cache for reuse across application sessions.

Setup and native metadata discovery fetch no artifact. The first native content
read or listing inside a named skill activates only that skill: the SDK downloads
and verifies the whole original artifact once and pins it. The instruction and
resource tool reads remain context-lazy from that pinned artifact. Source-root
listing is metadata-only. No artifact is rebuilt or installed into a skill folder.

Each adapter binds one origin/session. The demo offers the native `ls` and
`read_file` tools. It exposes no execution, writes, grep or glob. Python uses
`ainvoke`/`astream_events`; sync adapter calls fail before network work.
Origin credentials stay on the server. Model errors produce a generic browser
message. Skill contents are untrusted guidance; digest verification establishes
byte integrity, not safety or authorization.

## Verification

```bash
pnpm --filter @remote-skills/example-langchain check
```

Browser tests use the real Next.js page with mocked transport to verify all six
selectors, event order, escaping, size bounds, direct answers, Stop/Reset and
errors. Process tests cover split Unicode, cleanup before completion, nonzero
exits and child reaping. Native runtime tests exercise the real TypeScript and
Python model/tool loops against a loopback-only deterministic provider. These
are not live-model evidence.

To inspect live selection with an authorized real provider, use just `Hello!`.
Look for native `read_file` calls to `/skills/greeting/SKILL.md` and
`/skills/greeting/references/greeting.md`, then an answer beginning
`Ahoy, curious human!`. Model selection is probabilistic; inspect the actual trace.

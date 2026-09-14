# LangChain demo development

For setup and an observable skill-loading walkthrough, use the [demo README](README.md).
This page covers implementation boundaries and verification for contributors.

## Runtime and process boundaries

The development launcher binds to loopback. The chat route accepts only development
requests with a loopback URL, matching Host and Origin, and JSON content type. It
rejects production and unspecified runtime modes before reading the body or
dispatching a model or Python process. These browser-origin checks are not user
authentication: local programs can supply headers. Keep the demo on loopback;
a public application needs its own authentication and usage controls.

The browser talks to the Next.js chat route. TypeScript agents run in that server
process. Python selections start one process using the workspace's synced
`.venv`; it runs the Python SDK and native async agent, then sends
newline-delimited JSON through Next.js. No separate Python web server is needed.
Stop, Reset, and request timeout terminate and reap that child. The browser sees
completion only after a successful child exit and session cleanup.

Both runtimes tell the model to use relevant skills and finish required reference
reads before answering. Selection and tool calls remain the model's decision.
The demo exposes native `ls` and `read_file`, with no execution or write tools.
Credentials stay on the server; model errors produce a generic browser message.

Each question owns a fresh SDK session and native agent with a response-scoped
memory cache. Setup and metadata discovery fetch no artifact. The first native
content read or listing inside a named skill downloads and verifies that skill's
complete artifact and pins it for the session. Later resource reads use that
copy. The session remains open for the response and closes afterward.

DeepAgents receives the complete `deepAgentOptions` / `deep_agent_options()`
helper so the main agent and default subagent share discovery and content views.
LangChain uses the native middleware directly. LangGraph wraps a native agent
subgraph; it does not attach middleware to raw model nodes. Dependency contracts
live in the package manifests and workspace lockfiles.

## Run checks

From the repository root, check the example:

```bash
pnpm --filter @remote-skills/example-langchain check
```

Page tests use mocked transport to cover all six selectors, event order,
escaping, size bounds, direct answers, Stop/Reset, and errors. Process tests cover
split Unicode, cleanup before completion, nonzero exits, and child reaping.
Native runtime tests exercise the real TypeScript and Python model/tool loops
against a deterministic provider on loopback. These checks need no live model
credentials.

Run the complete browser journey separately:

```bash
pnpm test:langchain
```

This connects Chromium to the real Next.js API, all six native runtime choices,
and a freshly CLI-built skill origin. Only the model provider is scripted;
`/api/chat` is not mocked. Controlled provider steps verify catalog rendering
before activation, original instruction and reference reads, a complete archive
response, and chronological UI. The examples CI group runs this command.

The browser consumes the terminal event and cancels its reader. Browser tests
therefore inspect rendered events rather than rereading a cancelled response
body. Native route tests retain detailed stream and terminal-order assertions.

## Live-model evidence

A scripted provider verifies wiring and content integrity; it does not establish
whether a live model will choose a skill. The prescribed-greeting task in the
README passed all six live paths with `gpt-4.1` on September 10, 2026, including
the required reference read. Bare `Hello!` runs produced variable loading or
direct answers. These are different scenarios, and a successful run does not
guarantee future selection.

The [delivery record](../../integrations/langchain-docs/DELIVERY.md) retains the
historical test sequence and its limits. Inspect the current trace when checking
live behavior.

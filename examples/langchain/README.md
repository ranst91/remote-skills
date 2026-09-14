# LangChain family skill chat

Watch an agent discover and use a remote skill in a Next.js chat. Choose
DeepAgents, LangChain, or LangGraph in either TypeScript or Python, then see the
catalog, native tool calls, and answer as they arrive.

## Run the demo

From the repository root, install the locked dependencies with pnpm and uv:

```bash
pnpm install --frozen-lockfile
uv sync --locked --all-packages
```

Create the demo's environment file:

```bash
cp examples/langchain/.env.example examples/langchain/.env
```

Set `OPENAI_API_KEY` in that file. The demo uses `gpt-4.1` by default; set
`OPENAI_MODEL` to use another model.

Start the app and its local skill publisher:

```bash
pnpm --filter @remote-skills/example-langchain dev
```

Open <http://127.0.0.1:5182>. The launcher builds the workspace and serves the
bundled skills at <http://127.0.0.1:8792>. Set `APP_PORT` or `SKILLS_PORT` in the
environment file to change those ports. Ctrl-C stops both services.

The development launcher keeps the demo on loopback; the chat route is disabled
in production builds.

## See a skill in use

Select a language and agent, then click **Try team greeting** or send:

> Welcome a new teammate using our prescribed greeting style.

Look for the greeting skill in the catalog, then native `read_file` calls to
`/skills/greeting/SKILL.md` and `/skills/greeting/references/greeting.md`. The
reference provides the opening **Ahoy, curious human!** for the final answer.
Those reads show how the agent gets the instructions it needs beyond the
catalog's short description.

The model chooses whether to use a skill. A simple `Hello!` may receive a direct
answer; inspect the tool trace to see what the agent actually loaded.

## Adapt it to your application

Edit the [greeting skill](skills/source/greeting/SKILL.md) and its
[reference](skills/source/greeting/references/greeting.md) to try your own
instructions. The local publisher serves these ordinary Agent Skills over HTTP.

For your own agent, follow the
[integration guide](../../apps/docs/content/docs/integrations/langchain.mdx).
It covers all six choices shown in the demo. The LangGraph examples place a
native agent inside your graph so it retains its skills middleware.

Each demo question opens a fresh SDK session and agent. To keep selected skill
versions stable across conversation turns, retain the session, adapter, and
agent until that conversation ends. The first skill read downloads and verifies
the full artifact; later supporting-file reads use that session's pinned copy.
Loading skill content does not authorize script execution or other tools.

The runtime code is in [typescript-agent.ts](server/typescript-agent.ts) and
[python_agent.py](server/python_agent.py). For process architecture, local tests,
and past live-model evidence, see [Development notes](DEVELOPMENT.md).

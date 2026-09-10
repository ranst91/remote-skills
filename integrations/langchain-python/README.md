# remote-skills-langchain

Native DeepAgents and LangChain skills backed by verified Remote Skills sessions.
The agent discovers compact catalog metadata, chooses a skill through the native
skills prompt, and uses the upstream `read_file` tool to load it.

The first content read or listing inside a skill downloads and verifies its
**complete original artifact** through the SDK. Later resource reads use that
session's pinned artifact without another download. Resources enter the model
context only when it requests them.

## Use an existing async session

Install the locally built `remote-skills` and `remote-skills-langchain` wheels
with your application's locked dependencies. The application supplies its model
integration; for example, the runnable [six-path demo](../../examples/langchain)
uses `langchain-openai`.

```python
from langchain.agents import create_agent
from remote_skills import Origin, RemoteSkills
from remote_skills_langchain import create_remote_skills_backend

client = RemoteSkills(
    origins={"acme": Origin(url="https://skills.example.com")}
)

async def run(model):
    async with client.session("acme") as session:
        source = await create_remote_skills_backend(session)
        agent = create_agent(model=model, middleware=source.middleware())
        return await agent.ainvoke({
            "messages": [{"role": "user", "content": "Review this change."}]
        })
```

`create_remote_skills_backend` fetches no artifact. The caller owns the SDK
session and keeps its async context open until the invocation or stream has
finished. The adapter has no independent close operation.

## Native DeepAgents

Use the same source inside the session context:

```python
from deepagents import create_deep_agent

agent = create_deep_agent(
    model=model,
    **source.deep_agent_options(),
)
result = await agent.ainvoke({"messages": [{"role": "user", "content": prompt}]})
```

The helper supplies upstream `SkillsMiddleware` with the discovery view and
upstream `FilesystemMiddleware` with the content view. DeepAgents' public
same-name middleware override replaces its default filesystem and skills
middleware before execution. The helper passes `backend`, `skills`, and
`middleware` together so the default general-purpose subagent inherits both
views. Each agent discovers metadata through the native middleware and sees one
skills prompt; activation shares the SDK session pin. Passing `skills` with the
content backend alone would eagerly activate artifacts during discovery, so
keep all three helper options together. For independently configured custom
subagents, attach `source.middleware()` to their agent construction as well.

## Native LangChain middleware

`source.middleware()` is just this public upstream composition:

```python
from deepagents.middleware.skills import SkillsMiddleware
from deepagents.middleware.filesystem import FilesystemMiddleware
from langchain.agents import create_agent

agent = create_agent(model=model, middleware=[
    SkillsMiddleware(backend=source.discovery, sources=source.sources),
    FilesystemMiddleware(
        backend=source.content,
        tools=["ls", "read_file"],
        tool_token_limit_before_evict=None,
        human_message_token_limit_before_evict=None,
    ),
])
```

There are no replacement skill tools, selection prompts, middleware patches, or
flattened instruction bundles. Native middleware parses catalog-derived YAML
frontmatter and retains native relevance selection, loading instructions, tool
dispatch, line numbering, and pagination.

## Manually assembled LangGraph

Build your nodes and edges around the native agent subgraph:

```python
from langchain.agents import create_agent
from langgraph.graph import END, START, MessagesState, StateGraph

native_agent = create_agent(model=model, middleware=source.middleware())
graph = StateGraph(MessagesState)
graph.add_node("skills_agent", native_agent)
graph.add_edge(START, "skills_agent")
graph.add_edge("skills_agent", END)
agent = graph.compile()
result = await agent.ainvoke({"messages": [{"role": "user", "content": prompt}]})
```

This is a compositional LangGraph integration: the native agent remains a
subgraph. These releases do not export a standalone middleware runtime for raw
custom model/tool nodes. The integration does not rebuild that runtime.

## Backend views and options

```python
source = await create_remote_skills_backend(
    session,
    root="/skills/acme/",
    versions={"code-review": "^1.0.0"},
)
```

| Property | Meaning |
| --- | --- |
| `source.catalog` | Immutable tuple of `name`, `description`, `digest`, and `version` metadata; no origin URLs or credentials |
| `source.sources` | Tuple containing the virtual discovery directory |
| `source.discovery` | Metadata-only native backend view; its `SKILL.md` files are catalog projections |
| `source.content` | Native backend view over verified original files; downloads return exact original bytes |
| `source.middleware()` | Fresh upstream skill and read-only filesystem middleware |
| `source.deep_agent_options()` | Coordinated constructor options for native DeepAgents and its default general-purpose subagent |

Discovery and root directory listings do not activate skills. An explicit
content read or directory listing under a named skill activates only that skill.
The content view supports native async listing, paginated text reads, binary
reads, and file downloads. The helper exposes only native `ls` and `read_file`.
Writes, edits, uploads, search, and execution are not supported. Filesystem
offloading is disabled because the remote content view is read-only.

`versions` maps catalog names to SDK SemVer ranges, resolved at activation time.
Discovery descriptions describe the currently advertised release; a requested
older release can have different instructions. As in the SDK, the first
activation pins the chosen release for the session. Keep one version policy per
session; later options cannot replace an existing pin.

The caller configures authentication, scopes, cache, network policy, limits,
refresh, and explicit stale use on the existing SDK client/session. Unknown
errors become a generic error; SDK errors retain their stable codes without
private context. `path_invalid` maps to native `invalid_path`.

## Async and lifecycle boundaries

Use `ainvoke`, `astream`, or `astream_events` on the same event loop that created
the source. Synchronous reads raise an explicit async-required error. The
integration does not start background loops or transfer SDK sessions between
threads. Concurrent readers share the SDK's activation task and digest pin;
cancelling one reader does not cancel another reader's activation.

Keep a source, agent, and checkpoint thread bound to one session and authorization
scope. A checkpoint can contain native skill metadata from that session. For a
new session or refreshed catalog, create a new source and use a fresh checkpoint
thread; do not resume old skill metadata under new credentials or a new snapshot.
Closing the SDK session invalidates both backend views.

No files are installed or mirrored into an agent workspace. The SDK's disposable
cache retains verified bytes while its normal session pin is active. The backend
never executes scripts and `allowed-tools` never grants permissions. Integrity
verification does not establish that a publisher's instructions are trustworthy.

## Tested release matrix

| Surface | Exact released dependencies | Route |
| --- | --- | --- |
| DeepAgents | `deepagents==0.7.13`, `langchain==1.4.0`, `langgraph==1.2.11` | Native middleware/backend injection |
| LangChain | Same pins | `create_agent` with native middleware |
| LangGraph | Same pins | Native agent subgraph in explicit nodes and edges |

Source inspection used the released wheels and the tagged upstream
[skill middleware](https://github.com/langchain-ai/deepagents/blob/deepagents%3D%3D0.7.13/libs/deepagents/deepagents/middleware/skills.py),
[backend protocol](https://github.com/langchain-ai/deepagents/blob/deepagents%3D%3D0.7.13/libs/deepagents/deepagents/backends/protocol.py),
[filesystem middleware](https://github.com/langchain-ai/deepagents/blob/deepagents%3D%3D0.7.13/libs/deepagents/deepagents/middleware/filesystem.py),
and [native graph factory](https://github.com/langchain-ai/deepagents/blob/deepagents%3D%3D0.7.13/libs/deepagents/deepagents/graph.py).
See the official [skills](https://docs.langchain.com/oss/python/deepagents/skills)
and [backends](https://docs.langchain.com/oss/python/deepagents/backends) guides.
Release pins deliberately bound this integration; later upstream versions need
the native matrix tests before widening compatibility.

From the repository root:

```bash
pnpm --filter @remote-skills/langchain-python-workspace check
pnpm --filter @remote-skills/langchain-python-workspace package:check
node scripts/run-uv.ts build --package remote-skills-langchain --out-dir /tmp/remote-skills-langchain-artifacts
```

The tests run deterministic tool-calling models through all three actual native
paths and verify request counts, full artifact integrity, exact resources,
pagination, cache reuse, versions, scope, stale use, cancellation, and closure.
They do not call a live model or require provider credentials. `package:check`
builds both Python distributions, installs their wheels offline into a fresh
environment outside the workspace, and runs an installed native consumer.

Licensed under Apache-2.0.

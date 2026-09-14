# Remote Skills for LangChain and DeepAgents

Connect your Python agent to remotely served Agent Skills. Native skills
middleware shows the agent a catalog; the agent chooses relevant skills and uses
`read_file` to load their instructions and supporting files.

## Install

Add the adapter and SDK to your existing LangChain application with uv:

```bash
uv add remote-skills remote-skills-langchain
```

Or install them in your application's environment with pip:

```bash
pip install remote-skills remote-skills-langchain
```

## Connect your agent

Pass your configured LangChain chat model and a message to this async function.
The skills URL points to your published skills.

```python
from langchain.agents import create_agent
from langchain_core.language_models.chat_models import BaseChatModel
from remote_skills import Origin, RemoteSkills
from remote_skills_langchain import create_remote_skills_backend

async def run_agent(model: BaseChatModel, message: str):
    client = RemoteSkills(origins={
        "team": Origin(url="https://skills.example.com"),
    })
    async with client.session("team") as session:
        source = await create_remote_skills_backend(session)
        agent = create_agent(model=model, middleware=source.middleware())
        return await agent.ainvoke({
            "messages": [{"role": "user", "content": message}],
        })
```

Keep the session open until invocation or streaming finishes. For a conversation
that must keep the same skill versions across turns, retain its session, source,
and agent until the conversation ends. The source has no independent close
operation: closing the SDK session invalidates its backend views.

Use async invocation and streaming on the event loop that created the source.
Synchronous backend reads are unsupported.

The [integration guide](../../apps/docs/content/docs/integrations/langchain.mdx)
also shows DeepAgents and a LangGraph agent subgraph, with equivalent TypeScript
examples. DeepAgents uses the complete `source.deep_agent_options()` helper so
its main agent and default subagent share the skill catalog and session.

## What the agent loads

Discovery reads names and descriptions without downloading skill archives. When
the agent reads a selected skill, the SDK downloads and verifies its complete
artifact, then pins that release for the session. Supporting files enter the
model's context when requested and need no additional download.

The adapter exposes native `ls` and `read_file`. Reading a skill does not execute
its scripts or grant tool permissions; verified bytes still require a publisher
you trust.

See the [API reference](../../apps/docs/content/docs/api-reference.mdx#langchain-integration)
for options, backend views, and session ownership. To see catalog discovery,
native tool calls, and a skill-guided answer together, run the
[chat demo](../../examples/langchain/README.md).

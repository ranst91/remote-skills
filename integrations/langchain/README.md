# Remote Skills for LangChain and DeepAgents

Connect your TypeScript agent to remotely served Agent Skills. Native skills
middleware shows the agent a catalog; the agent chooses relevant skills and uses
`read_file` to load their instructions and supporting files.

## Install

Add the adapter and SDK to your existing LangChain application with your package
manager:

```bash
npm install @remote-skills/client @remote-skills/langchain
```

```bash
pnpm add @remote-skills/client @remote-skills/langchain
```

```bash
bun add @remote-skills/client @remote-skills/langchain
```

## Connect your agent

Pass your configured LangChain chat model and a message to this function. The
skills URL points to your published skills; the agent runs in your server
application.

```ts
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { createRemoteSkills } from "@remote-skills/client";
import { remoteSkills } from "@remote-skills/langchain";
import { createAgent } from "langchain";

export async function runAgent(model: BaseChatModel, message: string) {
  const client = createRemoteSkills({
    origins: { team: { url: "https://skills.example.com" } },
  });
  await using session = await client.session("team");
  await using remote = await remoteSkills({ session });

  const agent = createAgent({ model, middleware: remote.middleware });
  return await agent.invoke({
    messages: [{ role: "user", content: message }],
  });
}
```

The session stays open until the invocation finishes. For a conversation that
must keep the same skill versions across turns, keep its session, adapter, and
agent together until the conversation ends. Closing the adapter does not close
its caller-owned SDK session; the two `await using` declarations above dispose
of both.

The [integration guide](../../apps/docs/content/docs/integrations/langchain.mdx)
also shows DeepAgents and a LangGraph agent subgraph, with equivalent Python
examples. DeepAgents uses the complete `remote.deepAgentOptions` helper so its
main agent and default subagent share the skill catalog and session.

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

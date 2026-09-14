# Remote Skills for Mastra

`@remote-skills/mastra` lets your Mastra agent discover published skills and load their instructions and supporting files through its native Workspace tools. Serve your skills once and connect agents to their URL.

## Install

Install the integration in your agent's application with your package manager:

```bash
npm install @remote-skills/mastra @remote-skills/client @mastra/core
```

```bash
pnpm add @remote-skills/mastra @remote-skills/client @mastra/core
```

```bash
bun add @remote-skills/mastra @remote-skills/client @mastra/core
```

## Connect your agent

Run this in your Node.js server environment with `OPENAI_API_KEY` configured, or use your existing Mastra model:

```ts
import { Agent } from "@mastra/core/agent";
import { createRemoteSkills } from "@remote-skills/client";
import { remoteSkills } from "@remote-skills/mastra";

const client = createRemoteSkills({
  origins: { team: { url: "https://skills.example.com" } },
});

const skills = await remoteSkills({
  client,
  origin: "team",
  instructions: "Help the user using our team's skills.",
});
try {
  const agent = new Agent({
    id: "assistant",
    name: "Assistant",
    model: "openai/gpt-4.1",
    ...skills.agentOptions,
  });
  const response = await agent.stream(
    "Welcome a new teammate using our prescribed greeting style.",
    { maxSteps: 6 },
  );
  for await (const text of response.textStream) process.stdout.write(text);
} finally {
  await skills.close();
}
```

Setup loads the catalog's names and descriptions. When the agent selects a skill, `skill` loads its verified instructions and `skill_read` reads supporting text files. A request matching a published greeting skill gives the agent a reason to use it; the model chooses whether a skill is relevant.

Keep `skills.agentOptions` together: its Workspace and hooks cooperate to load selected instructions. Pass existing instructions and hooks through `remoteSkills({ instructions, hooks, ... })` so they are composed with the integration. Keep it open until streaming finishes, or across turns when a conversation should retain its selected skill versions.

The supplied client controls authentication, scope, caching, and request limits. Each integration connects to one publisher and credential context. The integration provides no command-execution or file-write tools; skill instructions do not grant permissions.

For the complete walkthrough, see the [Mastra guide](../../apps/docs/content/docs/integrations/mastra.mdx). The [API reference](../../apps/docs/content/docs/api-reference.mdx#mastra-integration) covers options, session ownership, native search, and tool composition. To try a chat UI with a local skill publisher, run the [Next.js example](../../examples/mastra/README.md).

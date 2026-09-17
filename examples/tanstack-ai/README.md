# TanStack AI terminal demo

One request, TanStack's native skill middleware, and a locally served greeting skill. The agent loads instructions only if it selects the skill, then reads its greeting reference. `agent/index.ts` contains the chat configuration; `app.ts` creates and closes the remote session.

From the repository root (Node.js 24+ and pinned pnpm):

```bash
pnpm install --frozen-lockfile
pnpm ci:build:repository
pnpm --filter @remote-skills/example-tanstack-ai skills:dev
```

Leave the origin running at `http://127.0.0.1:8787`. In another terminal at the repository root, set `OPENAI_API_KEY` in your environment, then:

```bash
pnpm --filter @remote-skills/example-tanstack-ai start "Hello!"
```

This command makes a paid OpenAI request using `gpt-4.1-mini`. Each invocation creates a fresh session. Adapt the agent configuration to your provider or retain the source across turns for a longer conversation.

For deterministic local validation without a model key or paid calls:

```bash
pnpm --filter @remote-skills/example-tanstack-ai check
```

The test uses ai-mock over loopback HTTP with the real TanStack chat loop, native tools and Remote Skills SDK. Scripted model output validates integration plumbing, not live model reliability.

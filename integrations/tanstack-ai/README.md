# Remote Skills for TanStack AI

A server-side `SkillSource` for TanStack's native `withSkills` middleware. Discovery exposes only names and descriptions; `load_skill` downloads and verifies the selected artifact. Resources are read from that session's immutable pin.

## Install

```bash
npm install @remote-skills/tanstack-ai @remote-skills/client @tanstack/ai@0.55.0 @tanstack/ai-skills@0.1.4 @tanstack/ai-openai@0.22.8 zod
```

```bash
pnpm add @remote-skills/tanstack-ai @remote-skills/client @tanstack/ai@0.55.0 @tanstack/ai-skills@0.1.4 @tanstack/ai-openai@0.22.8 zod
```

```bash
bun add @remote-skills/tanstack-ai @remote-skills/client @tanstack/ai@0.55.0 @tanstack/ai-skills@0.1.4 @tanstack/ai-openai@0.22.8 zod
```

## Connect your agent

Set `OPENAI_API_KEY` in your server environment, or keep your existing model adapter.

```ts
import { createRemoteSkills } from "@remote-skills/client";
import { remoteSkills } from "@remote-skills/tanstack-ai";
import { chat, maxIterations } from "@tanstack/ai";
import { createOpenaiChatCompletions } from "@tanstack/ai-openai";
import { createResourceTool, withSkills } from "@tanstack/ai-skills";

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) throw new Error("OPENAI_API_KEY is required");
const client = createRemoteSkills({
  origins: { team: { url: "https://skills.example.com" } },
});
await using source = await remoteSkills({ client, origin: "team" });
const response = chat({
  adapter: createOpenaiChatCompletions("gpt-4.1-mini", apiKey),
  messages: [{ role: "user", content: "Welcome a new teammate using our prescribed greeting style." }],
  systemPrompts: ["Help the user. Follow relevant skills and read their required references."],
  middleware: [withSkills(source)],
  tools: [createResourceTool(source)],
  agentLoopStrategy: maxIterations(5),
});
for await (const chunk of response) {
  if (chunk.type === "TEXT_MESSAGE_CONTENT") process.stdout.write(chunk.delta);
}
```

Create one source per conversation. Reuse it across turns to preserve pins; close it when the conversation ends. `withSkills` tracks loaded skills per `chat()` call. Never share a source across users or wrap it in a global cache. `client.refresh()` affects future sessions, not existing pins.

You may pass `{ session }` instead of `{ client, origin }`; the caller retains ownership of that session. `source.close()` is idempotent, drains outstanding source work and rejects subsequent calls. Closing during a read rejects its result. A closed borrowed session also invalidates the source.

Optional `versions: { greeting: "^1.0.0" }` selects versions through the SDK. Resources under `references/` and `assets/` are supported. UTF-8 content is returned as text; other bytes are returned as `Uint8Array`, which TanStack's resource tool encodes as base64. Direct resource requests also activate and verify the selected skill. Scripts are neither exposed nor executed. SDK error codes are preserved with diagnostic context removed.

Requires Node.js 24+. Tested against the published `@tanstack/ai-skills@0.1.4` and `@tanstack/ai@0.55.0`; the source conformance suite runs in package tests. Verification proves byte integrity, not instruction safety. Skill content and `allowed-tools` never grant permissions.

See the [Next.js chat demo](../../examples/tanstack-ai/README.md).

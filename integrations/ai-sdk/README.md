# Remote Skills for Vercel AI SDK

`@remote-skills/ai-sdk` connects a configured Remote Skills client to AI SDK 7 agents.
Node.js 24+ is required. This package is server-only.

```ts
import { ToolLoopAgent } from "ai";
import { remoteSkills } from "@remote-skills/ai-sdk";
import { createRemoteSkills } from "@remote-skills/client";

const client = createRemoteSkills({
  origins: {
    team: {
      url: "https://skills.example.com",
      headers: { Authorization: `Bearer ${process.env.SKILLS_TOKEN}` },
      scope: "engineering",
    },
  },
});

const skills = await remoteSkills({
  client,
  origin: "team",
  versions: { "code-review": "^1.0.0" },
});

try {
  const agent = new ToolLoopAgent({
    model: "openai/gpt-5.2",
    ...skills.agentOptions,
    instructions: `${skills.agentOptions.instructions} Keep answers concise.`,
  });
  const result = await agent.generate({ prompt: "Review this change." });
  console.log(result.text);
} finally {
  await skills.close();
}
```

Use your usual AI SDK model/provider configuration. The model string above uses AI Gateway;
provider credentials and Remote Skills origin credentials are configured independently.
Keep the integration open until generation or streaming has finished. Keep it across turns
when a conversation must retain its selected versions. Close it when that conversation ends.
It also supports `await using`.

## Loading behavior

Creation opens SDK sessions and fetches catalog metadata only. The model sees skill names and
descriptions in the skill loader's description. Full instructions and resource contents are
absent until selected. A direct model answer needs no skill activation.

The package uses Vercel's existing [`bash-tool` skill loader](https://github.com/vercel-labs/bash-tool)
(`experimental_createSkillTool`) and its existing `readFile` tool. These are upstream tools,
with upstream schemas, discovery, parsing and results. AI SDK core itself has no filesystem
skill-source option; this integration targets Vercel's `bash-tool` implementation specifically.

The native loader requires a real directory and eagerly reads it during discovery. The adapter
creates a private temporary directory containing metadata-only `SKILL.md` projections. When
the model selects a skill, the adapter calls `session.activate()`, lets the SDK download and
verify the artifact, and materializes the selected original `SKILL.md` before invoking the
upstream loader. It checks the returned instructions against the pinned SDK content. Temporary
files are removed on close. This requires a writable temporary filesystem and Node.js; it is
not compatible with an Edge runtime.

Supporting resources remain in the SDK cache. Vercel's `readFile` reads them through a
read-only remote-backed sandbox at `/workspace/skills/`. The entire archive is fetched at
activation; subsequent resource reads do not fetch individual files over the network.
No command-execution or write tools are registered. Skills requiring scripts cannot fully run
in this integration. Native `readFile` supports text; binary bytes remain accessible through
the original SDK sessions, rather than a custom model-facing binary tool.

## SDK feature mapping

| SDK feature | Integration behavior |
| --- | --- |
| Auth headers and artifact-host credentials | Configured on the supplied client; never sent to the model. The SDK controls forwarding. |
| Requested/confirmed scope | Supplied client and original session metadata; SDK enforces scope acceptance. |
| Version constraints | `versions` selects ranges through SDK activation. Constraints belong to the application, not model arguments. |
| Digest pins and retained releases | SDK first-activation pin semantics. Later conflicting ranges do not change an existing pin. |
| Refresh and publisher updates | Call `client.refresh()` and create a new integration for a new catalog snapshot; existing sessions stay pinned. |
| Disk, memory and custom cache | The supplied client's cache is reused unchanged. Closing owned sessions releases their leases. |
| Offline and bounded stale catalogs | Controlled by the client's existing stale policy; inspect `skills.sessions[].metadata` for staleness and scope. |
| HTTPS, loopback, DNS, redirects and host policy | Delegated to the SDK; no separate HTTP fetching in the integration. |
| Timeouts, retries and catalog/activation/cache limits | Configured on the client and preserved. |
| Archives and standalone SKILL.md | SDK activation; native loader parses the selected instructions. |
| Text, binary, frontmatter and prefix listing | Native `readFile` exposes text. Original SDK sessions provide binary bytes, frontmatter, prefix listing and pin metadata programmatically. |
| Stable errors | Model-visible errors retain SDK error codes but omit context; unexpected errors become a fixed safe message. Setup errors remain available to the caller. |
| Async disposal and caller-owned sessions | `close()`/`Symbol.asyncDispose`; borrowed sessions are never closed by the integration. |
| Generate/stream and model choice | Ordinary AI SDK tools, usable with `ToolLoopAgent`, `generateText` and `streamText`. |

The integration checks AI SDK abort signals before and after resource operations. The SDK's
public activation API has no per-call abort signal, so an already-started download remains
subject to the client's timeout and session-close behavior. No additional cancellation or
execution capabilities are claimed.

## Multiple origins and existing sessions

```ts
import { remoteSkills } from "@remote-skills/ai-sdk";
import { createRemoteSkills } from "@remote-skills/client";

const client = createRemoteSkills({
  origins: {
    team: { url: "https://team.example.com" },
    public: { url: "https://public.example.com" },
  },
});
const skills = await remoteSkills({
  client,
  origins: ["team", "public"],
  versions: { "team/code-review": "^1.0.0" },
});
```

Multiple origins use `origin/name` identifiers to avoid name collisions. An empty or duplicate
origin list is rejected. All requested origins must open successfully; partial setup closes
sessions opened so far. Version keys must identify catalog entries.

To reuse a caller-managed session:

```ts
import { remoteSkills } from "@remote-skills/ai-sdk";
import { createRemoteSkills } from "@remote-skills/client";

const client = createRemoteSkills({
  origins: { team: { url: "https://team.example.com" } },
});
const session = await client.session("team");
const skills = await remoteSkills({ session });
```

Closing this integration disables its tools but leaves `session` open. The caller must close
that session. Existing pins on a borrowed session remain authoritative.

To combine application tools, spread `skills.agentOptions` first and then set
`tools: { ...skills.tools, ...yourTools }`. Reserve the names `skill` and `readFile`.
`agentOptions.instructions` supplies generic skill-selection guidance; append your application
instructions explicitly. Model settings, hooks and stop conditions remain application-owned.

## Verification

`pnpm --filter @remote-skills/ai-sdk check` exercises a real client with controlled transport,
disk and memory caches, authentication/scope, version resolution, refresh, offline pins,
integrity/size/path rejection, binary rejection, session ownership, native-loader concurrency,
and a real AI SDK agent loop. Browser regression tests use the real CLI origin, client and
integration with a scripted model. For live-model selection, follow the manual check in the
[Next.js demo](../../examples/vercel-ai-sdk/README.md). Scripted tests alone do not establish
live-model selection quality.

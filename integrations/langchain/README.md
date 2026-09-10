# Remote Skills for LangChain and DeepAgents

Use a remote Agent Skills origin through the existing DeepAgents skills middleware and native `read_file` tool. The adapter supplies backend data; upstream middleware owns discovery, prompt formatting, relevance selection, loading, and tool results.

This server-runtime integration uses the public `@remote-skills/client` SDK. It does not install skills, execute scripts, replace native skill tools, or modify upstream objects.

## Tested compatibility

| Runtime | Supported composition |
| --- | --- |
| DeepAgents TypeScript | `createDeepAgent` with the verified content backend and explicit native skills/filesystem middleware |
| LangChain TypeScript | Plain `createAgent` with the same native middleware tuple |
| LangGraph TypeScript | A manually assembled `StateGraph` containing the native agent's public compiled `.graph` as a subgraph node |

The pinned test set is `deepagents@1.13.4`, `langchain@1.5.11`, `@langchain/langgraph@1.4.14`, `@langchain/core@1.2.10`, `langsmith@0.9.0`, and `zod@4.3.6`. Keep the LangChain peer dependencies on one shared copy. In particular, DeepAgents 1.13.4 requires LangSmith below 0.10; an unconstrained latest installation can be incompatible.

Bare LangGraph nodes do not automatically run LangChain middleware. The graph example below retains a real native agent subgraph. It does not claim direct middleware support on an arbitrary model node.

## Create the adapter

Use the locally built `@remote-skills/langchain` and `@remote-skills/client` tarballs, with the pinned upstream dependencies above. Package publication is a separate maintainer action.

```ts
import { createRemoteSkills } from "@remote-skills/client";
import { remoteSkills } from "@remote-skills/langchain";

const client = createRemoteSkills({
  origins: {
    team: { url: "https://skills.example.com" },
  },
});

await using session = await client.session("team");
await using remote = await remoteSkills({ session });
```

`remoteSkills({ session, root?, versions? })` returns:

- `discoveryBackend`: catalog-derived frontmatter projections for the native metadata scan. These bytes are explicitly metadata projections, never the original skill file.
- `contentBackend`: the original, SDK-verified skill files and resources, activated lazily when requested.
- `sources`: the virtual source directories; default `['/skills/']`.
- `catalog`: names, descriptions, and virtual `SKILL.md` paths only.
- `middleware`: the unchanged native skills middleware and native filesystem middleware, configured to expose `ls` and `read_file`.
- `deepAgentOptions`: native constructor options that preserve discovery in both the main DeepAgent and its default general-purpose subagent.
- `close()` / async disposal: disable the adapter and drain pending work. The supplied SDK session remains caller-owned and must be closed separately.

Create one adapter and native agent per SDK session and origin. Do not concatenate middleware tuples from multiple adapters: native middleware names would collide. Multiple origins require separate adapters and agents. Do not reuse a checkpoint with skill metadata from a different origin, authorization context, or session.

An optional `root`, such as `/remote/team/`, must be an absolute virtual directory with a trailing slash. It does not refer to the host filesystem. Version ranges are host configuration:

```ts
const remote = await remoteSkills({
  session,
  root: "/remote/team/",
  versions: { "code-review": "^1.0.0" },
});
```

SDK authentication, requested/confirmed scope, cache configuration, stale policy, version selection, and digest/session pins remain SDK responsibilities. A requested scope never grants authority, and a version range selects only among releases the provider still advertises.

## DeepAgents

Pass a configured LangChain chat model as `model`:

```ts
import { createDeepAgent } from "deepagents";

const agent = createDeepAgent({
  model,
  ...remote.deepAgentOptions,
});
const result = await agent.invoke({
  messages: [{ role: "user", content: "Review this change." }],
});
```

The explicit native skills middleware uses `discoveryBackend`; the native filesystem middleware uses `contentBackend`. `deepAgentOptions` supplies `backend`, `skills: remote.sources`, and the native `middleware` tuple together. In the tested DeepAgents release, its public middleware override mechanism replaces the automatically constructed SkillsMiddleware by name before any scan runs, both in the main agent and in the default general-purpose subagent. This preserves metadata-only discovery and one shared SDK pin across delegation.

Keep those options together. Using only the content backend with automatic `skills` loading would fetch artifacts during discovery. Using only the middleware tuple without `skills` configures the main agent, but the default general-purpose subagent would lack discovery metadata. Custom named subagents do not automatically inherit skills; supply the same native middleware tuple explicitly through their public `middleware` option when they should share this session's skills.

## Plain LangChain

```ts
import { createAgent } from "langchain";

const agent = createAgent({ model, middleware: remote.middleware });
const result = await agent.invoke({
  messages: [{ role: "user", content: "Review this change." }],
});
```

## Manually assembled LangGraph

```ts
import { END, MessagesAnnotation, START, StateGraph } from "@langchain/langgraph";
import { createAgent } from "langchain";

const nativeAgent = createAgent({ model, middleware: remote.middleware });
const graph = new StateGraph(MessagesAnnotation)
  .addNode("prepare", () => ({}))
  .addNode("skills", nativeAgent.graph)
  .addNode("complete", () => ({}))
  .addEdge(START, "prepare")
  .addEdge("prepare", "skills")
  .addEdge("skills", "complete")
  .addEdge("complete", END)
  .compile();

const result = await graph.invoke({
  messages: [{ role: "user", content: "Review this change." }],
});
```

## Loading and trust boundaries

Adapter creation and the native metadata scan request zero artifact bytes. DeepAgents 1.13.4 calls backend `ls`, then `downloadFiles` (or `read`) to parse metadata in `beforeAgent`; `wrapModelCall` formats the native skills prompt. The discovery view serves only the catalog's name and description in valid frontmatter.

When the model selects a skill, the native `read_file` tool calls the content backend. The SDK downloads and verifies the complete original artifact once, then pins its exact digest. Listing a particular skill directory through native `ls` also activates that skill to enumerate its verified resource names; listing the source root remains metadata-only. The original `SKILL.md` enters context through the native tool's pagination and formatting. References and binary assets are read from that pinned local artifact only when requested: full-download activation is distinct from context-lazy resource access. Reading resources makes no additional origin request.

The content backend's `downloadFiles` always returns original verified bytes. The discovery view has no phase switch and can never turn into the content view. Read-only filesystem operations do not execute bundled scripts or treat `allowed-tools` as authorization. Digest verification establishes byte integrity, not trust in instructions. The host remains responsible for tool permissions and content trust.

The adapter intentionally exposes only native `ls` and `read_file`; writes, grep, glob, and command execution are unavailable. Errors propagate as sanitized SDK error codes without origin credentials, response bodies, or remote instruction text.

## Source and verification evidence

The design was checked against the [released DeepAgents 1.13.4 package](https://www.npmjs.com/package/deepagents/v/1.13.4), [native skills source](https://github.com/langchain-ai/deepagentsjs/blob/main/libs/deepagents/src/middleware/skills.ts), [LangChain middleware documentation](https://docs.langchain.com/oss/javascript/langchain/middleware), and [LangGraph subgraph documentation](https://docs.langchain.com/oss/javascript/langgraph/use-subgraphs). Released package source, rather than the moving `main` branch, determines the tested behavior.

Run `pnpm --filter @remote-skills/langchain check` for deterministic native model invocations in all three modes, unrelated requests that fetch no artifacts, version/auth/cache/digest/session tests, binary resources, pagination, path rejection, and lifecycle behavior. These tests use real native middleware and tools without a live model provider. `pnpm --filter @remote-skills/langchain package:check` builds and packs the local npm artifact, installs it offline with the local SDK tarball in a clean consumer directory, checks the exported types, and executes a native LangChain agent against an in-process fixture origin.

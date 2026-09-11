# LangChain family implementation plan

> Agentic workers implement independent language packages in parallel and preserve all unrelated changes.

**Goal:** Let existing native skill discovery and read tools consume remote SDK sessions, without fetching artifacts during discovery.

**Architecture:** One protocol adapter per language exposes two explicit views sharing an SDK session. The discovery view provides catalog-derived SKILL.md frontmatter. The content view activates the original artifact through the SDK and reads its verified pinned files. Native DeepAgents middleware performs discovery, prompt injection, selection and filesystem-tool execution. Python is async-only. Bare LangGraph nodes are incompatible; native compiled agents can be composed as subgraphs using public LangGraph nodes and edges.

**Pins:** TypeScript deepagents 1.13.4, langchain 1.5.11, @langchain/langgraph 1.4.14, @langchain/core 1.2.10. Python deepagents 0.7.13, langchain 1.4.0, langgraph 1.2.11.

- [x] TypeScript owner: integrations/langchain source, package, README and contract tests. Export `remoteSkills({session})` with explicit backend views and native middleware. Prove real upstream loader/tool invocation and whole original activation, resource access, pins, cache, auth isolation, sanitized failures, paths and lifecycle/concurrent readers.
- [x] Python owner: integrations/langchain-python source, package, README and contract tests. Export async `create_remote_skills_backend(session)` with explicit views and native middleware. Test the native async tool path and make sync calls fail clearly without loop/thread bridges.
- [x] Frontend owner: examples/langchain/app and skills. Render ordered NDJSON catalog, native tool start/end, text and terminal events. Six explicit path choices, abort/reset and safe errors.
- [x] Parent: examples/langchain server handlers and Next.js route; thin subprocess boundary to run actual Python SDK/native runtime; shared workspace, lock and CI registration only where needed. Each request owns one SDK session; demo states its response-scoped pins.
- [x] Verify exact package checks plus `pnpm test:repository`, `pnpm test:protocol`, `pnpm typecheck`, `pnpm check`, `pnpm ci:verify-projects` on macOS. Run local artifact build/install/consumer smoke checks. Report platform limitations and exact commands.
- [x] Run actual browser chat with deterministic provider contract assertions. Attempt live model only using locally configured credentials; never claim deterministic provider evidence is live. Preserve chronological native tool and final-answer stream order.
- [x] Review requirement coverage, compatibility matrix and limitations; prepare verified changes for a focused local commit. No push, PR, merge, tag, package upload or deployment.
- [ ] Manager acceptance and directly authorized live-provider validation.

## Compatibility decisions

| Path | TypeScript | Python |
| --- | --- | --- |
| DeepAgents | Public native skills + filesystem middleware and explicit backend views | Same, async only |
| Plain createAgent/create_agent | Native DeepAgents middleware composed directly | Same, async only |
| Manual LangGraph nodes and edges | Native compiled agent subgraph | Native compiled agent subgraph, async only |

Arbitrary raw graph nodes have no exported native skill middleware runtime. Directly rebuilding middleware hook dispatch, model injection or replacement tools is outside the supported route.

## Source evidence

- Released package source and public declarations downloaded from npm/PyPI at the pins above.
- Discovery calls backend listing then batched SKILL.md download; native read_file calls backend read.
- DeepAgents accepts public middleware overrides; standard LangChain createAgent/create_agent composes those same middleware objects.
- https://docs.langchain.com/oss/javascript/langgraph/use-subgraphs
- https://docs.langchain.com/oss/python/langgraph/use-subgraphs

No old OpenSpec task status is changed; this integration scope was explicitly authorized by the maintainer assignment.

Live-provider validation remains blocked by automatic approval review pending direct user authorization; deterministic route and browser evidence is complete.

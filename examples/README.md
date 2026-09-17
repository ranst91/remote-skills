# Examples

These are quickstart references for the two sides of Remote Skills:

- [Publisher](publisher/): validate, build, and serve a skill locally.
- [LangChain family](langchain/): Next.js chat with native TypeScript/Python DeepAgents, LangChain and LangGraph agent subgraphs.
- Consumers: [TypeScript](consumers/typescript/) and [Python](consumers/python/) load and
  read that skill through the public clients.
- Framework chat demos: [Vercel AI SDK](vercel-ai-sdk/) and [Mastra](mastra/) use
  their native skill loaders in TypeScript-only Next.js applications.

- [TanStack AI](tanstack-ai/README.md): terminal agent using native on-demand skill loading.

Start the publisher, then run either consumer in another terminal. The existing tests under
`tests/examples/` exercise these references. Hosting helpers, authentication, version history,
and package-install scenarios live there too; they are test infrastructure, not separate examples.

From a fresh clone, prepare the examples from the repository root:

1. `pnpm install --frozen-lockfile`
2. `uv sync --locked --all-packages`
3. `pnpm ci:build:repository`
4. `pnpm install --frozen-lockfile`

The final install links the CLI executable after compilation. On a fresh clone, its generated
entrypoint does not exist during the first install, so pnpm cannot create the example commands yet.

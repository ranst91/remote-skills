# Examples

These are quickstart references for the two sides of Remote Skills:

- [Publisher](publisher/): validate, build, and serve a skill locally.
- Consumers: [TypeScript](consumers/typescript/) and [Python](consumers/python/) load and
  read that skill through the public clients.

Start the publisher, then run either consumer in another terminal. The existing tests under
`tests/examples/` exercise these references. Hosting helpers, authentication, version history,
and package-install scenarios live there too; they are test infrastructure, not separate examples.

From a fresh clone, prepare the examples once with `pnpm install --frozen-lockfile`,
`uv sync --locked --all-packages`, and `pnpm ci:build:repository` from the repository root.

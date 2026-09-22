# TanStack AI chat demo

A Next.js browser chat using TanStack AI's native skill middleware and a locally published greeting skill. Expand the native `load_skill` and `read_skill_resource` events to inspect the verified instructions and exact reference used in the answer. `withSkills` automatically supplies `load_skill`; this demo also adds the optional resource tool because the greeting skill requires `references/greeting.md`.

From the repository root (Node.js 24+ and pinned pnpm):

```bash
pnpm install --frozen-lockfile
pnpm --filter @remote-skills/example-tanstack-ai dev
```

Set `OPENAI_API_KEY` in your environment or in `examples/tanstack-ai/.env` before starting. Open `http://127.0.0.1:5183` and select **Welcome a teammate**. The agent uses `gpt-4.1-mini`, which makes paid requests. `APP_PORT` and `SKILLS_PORT` override the defaults 5183 and 8793; they must be distinct. Ctrl-C stops the publisher and app together. Never expose this unauthenticated development app publicly.

The browser sends conversation text to a server route. TanStack owns the model and tool loop; the UI transport only translates its events. Each response owns a fresh source until streaming completes or is aborted. Later responses rediscover skills; browser tool output is never accepted as trusted history. A direct answer need not fetch any artifact.

For deterministic checks without a model key or paid calls:

```bash
pnpm --filter @remote-skills/example-tanstack-ai check
pnpm test:tanstack-ai
```

The first command covers native agent behavior, stream translation and request boundaries. The second runs Chromium against the real Next.js route, native TanStack tools and CLI-built origin, checking exact reference output, event order, unused skills, failures and cleanup. Only the model is replaced by ai-mock. The shared release verifier runs this same browser suite against isolated candidate tarballs with no workspace output fallback.

The terminal entry remains available. After building the repository and starting the local origin in another terminal:

```bash
pnpm ci:build:repository
pnpm --filter @remote-skills/example-tanstack-ai skills:dev
```

```bash
pnpm --filter @remote-skills/example-tanstack-ai terminal "Hello!"
```

The terminal defaults to the origin at `http://127.0.0.1:8787`. Both demos preserve lazy discovery and verified resource access. Mock responses validate integration behavior, not live model reliability.

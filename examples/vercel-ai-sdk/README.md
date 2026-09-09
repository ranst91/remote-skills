# Vercel AI SDK skill chat

Prerequisites: Node.js 24+, pnpm 10.33.4, and an OpenAI API key.

```bash
pnpm i
cp .env.example .env
# Add your OpenAI API key to .env
pnpm run dev
```

Open <http://127.0.0.1:5173>.

The Next.js page lives in `app/page.tsx`, the streaming route in `app/api/chat/route.ts`, and
the greeting skill in `skills/source/greeting/`. Keeping source under `skills/source/`
separates the CLI's source and generated output directories.

The route consumes `@remote-skills/ai-sdk`: `remoteSkills({ client, origin })` provides
`agentOptions` for `streamText`. Each chat request owns one integration session and closes
it after streaming finishes. Metadata is discovered before generation; only selected skills are
downloaded. Direct answers are valid. Keep one integration open across requests if your
application needs version pins for the entire conversation.

See [the integration package](../../integrations/ai-sdk/README.md) for authentication, version
constraints, multiple origins, cache policies, streaming and session ownership.

To check live skill selection, send just `Hello!` with a real model configured. Expand the
skill-loading and file-read entries: the native loader should select `greeting`, then read
`./skills/greeting/references/greeting.md`. The supplied guide asks for an opening of
“Ahoy, curious human!”. No routing code or skill-specific system instruction selects it.
Model selection is probabilistic; the trace shows what actually happened.

This demo requires Node.js and a writable temporary directory. It supplies read-only skill
files and does not execute skill scripts. Next.js may warn about an optional `zstd.node`
module imported by Vercel's `bash-tool` dependency; the read-only loading flow does not use it.

# Mastra chat with remote skills

A Next.js chat that lets a Mastra agent discover a greeting skill, load its instructions, and read its supporting reference through native Workspace tools. The chat shows tool activity alongside the streamed answer.

## Run the example

From this repository's root, install the locked dependencies:

```bash
pnpm install --frozen-lockfile
```

Set `OPENAI_API_KEY` in your process environment or the ignored `examples/mastra/.env`, then start the example:

```bash
pnpm --filter @remote-skills/example-mastra dev
```

Open [the chat](http://127.0.0.1:5181). The runner starts the app and a local skill publisher, prepares their dependencies, and stops both services when you exit.

Click **Welcome a teammate**. The request asks the agent to use your prescribed greeting style. Expand the `skill` and `skill_read` events to see the selected instructions and supporting reference, then compare them with the answer. The model chooses its tools; an ordinary greeting can receive a direct answer without a skill.

Edit the [greeting skill](skills/source/greeting/SKILL.md) to try a different workflow, then send another message. The local publisher serves your skills over HTTP, using the same discovery and loading flow as a hosted publisher.

## Configuration

| Setting | Default | Purpose |
| --- | --- | --- |
| `OPENAI_API_KEY` | Required | Model provider credential used by the server route. |
| `OPENAI_MODEL` | `gpt-4.1` | Model used for the conversation. |
| `APP_PORT` | `5181` | Chat application port. |
| `SKILLS_PORT` | `8791` | Local skill publisher port. |

The provider credential stays in the application server and is removed from the publisher's environment.

## Use the pattern in your application

The [chat route](app/api/chat/route.ts) creates the SDK client and Mastra agent on the server, then forwards native stream events to the UI. Each response owns its integration and closes it after streaming finishes. Later turns replay conversation text and can select skills again; keep a conversation-scoped integration if selected skill versions must remain fixed across responses.

This is an unauthenticated local demo. In a multi-user application, use the authenticated request identity to choose the client's credentials and catalog scope, keeping each user's access separate. The [Mastra guide](../../apps/docs/content/docs/integrations/mastra.mdx) walks through connecting your own application, and the [API reference](../../apps/docs/content/docs/api-reference.mdx#mastra-integration) covers session ownership and tool composition.

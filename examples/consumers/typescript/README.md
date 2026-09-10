# TypeScript consumer example

This server-runtime example uses only `@remote-skills/client`. Build that local workspace package,
start a local origin, then run:

```bash
pnpm --filter @remote-skills/client build
REMOTE_SKILLS_ORIGIN=http://127.0.0.1:8787 pnpm start
```

For an authenticated origin, also set `REMOTE_SKILLS_AUTH_TOKEN` and
`REMOTE_SKILLS_SCOPE=engineering`. Set `REMOTE_SKILLS_VERSION_RANGE=1.4.x` to select the highest
compatible advertised release. The client downloads and verifies the complete artifact at
activation; `read()` reads from those pinned local bytes and never executes skill content.

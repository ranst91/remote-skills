# Publisher example

This ordinary Agent Skills tree builds a complete static origin. From this directory, after the
repository's locked workspace setup:

```bash
pnpm validate
pnpm build
```

Map the contents of `dist/` to an origin root without changing any bytes. The catalog must resolve
at `/.well-known/agent-skills/index.json`; keep the generated archive compressed and at its
content-addressed relative path. For local use, run `pnpm exec remote-skills dev` from this directory;
it serves the skill at `http://127.0.0.1:8787` and rebuilds when source files change. Verification
proves byte integrity and structure, not that the instructions are safe to execute.

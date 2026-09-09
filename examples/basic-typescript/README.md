# Basic TypeScript skill chat

Prerequisites: Node.js 24+, pnpm 10.33.4, and an OpenAI API key.

```sh
pnpm i
cp .env.example .env
# Add your OpenAI API key to .env
pnpm run dev
```

Open <http://127.0.0.1:5173>.

The browser app lives in `app/`, the OpenAI and Remote Skills backend lives in `agent/`, and
the greeting skill lives in `skills/source/greeting/`. Keeping source under `skills/source/`
separates the CLI's source and generated output directories.

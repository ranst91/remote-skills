import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { assertPortsAvailable, runServices, validateEnvironment } from "./dev.ts";

const example = resolve(import.meta.dirname, "../../examples/langchain");
if (existsSync(resolve(example, ".env"))) process.loadEnvFile(resolve(example, ".env"));
const ports = validateEnvironment({
  ...process.env,
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: This dev-only launcher is not a cached Turbo task.
  APP_PORT: process.env.APP_PORT || "5182",
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: This dev-only launcher is not a cached Turbo task.
  SKILLS_PORT: process.env.SKILLS_PORT || "8792",
});
await assertPortsAvailable([ports.appPort, ports.skillsPort]);
const controller = new AbortController();
const stop = () => controller.abort();
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
const publisherEnv = { ...process.env };
for (const key of ["OPENAI_API_KEY", "OPENAI_BASE_URL", "ANTHROPIC_API_KEY"])
  delete publisherEnv[key];
const origin = `http://127.0.0.1:${ports.skillsPort}`;
try {
  await runServices(
    [
      {
        name: "publisher",
        command: process.execPath,
        args: [
          resolve(example, "node_modules/@remote-skills/cli/dist/cli.js"),
          "dev",
          "--host",
          "127.0.0.1",
          "--port",
          String(ports.skillsPort),
        ],
        cwd: resolve(example, "skills"),
        env: publisherEnv,
        readyUrl: `${origin}/.well-known/agent-skills/index.json`,
      },
      {
        name: "browser",
        command: process.execPath,
        args: [
          resolve(example, "node_modules/next/dist/bin/next"),
          "dev",
          "--webpack",
          "--hostname",
          "127.0.0.1",
          "--port",
          String(ports.appPort),
        ],
        cwd: example,
        env: { ...process.env, REMOTE_SKILLS_ORIGIN: origin },
        readyUrl: `http://127.0.0.1:${ports.appPort}`,
      },
    ],
    {
      signal: controller.signal,
      onReady(name) {
        if (name === "browser")
          process.stdout.write(`Chat ready at http://127.0.0.1:${ports.appPort}\n`);
      },
    },
  );
} catch {
  process.stderr.write("LangChain demo startup failed. Check configuration and dependencies.\n");
  process.exitCode = 1;
} finally {
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
}

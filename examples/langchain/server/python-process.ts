import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { ChatEvent } from "./typescript-agent.ts";

interface ProcessOptions {
  readonly executable?: string;
  readonly script?: string;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export async function* pythonAgent(
  message: string,
  path: string,
  signal: AbortSignal,
  options: ProcessOptions = {},
): AsyncGenerator<ChatEvent> {
  const cwd = options.cwd ?? process.cwd();
  const repository = resolve(cwd, "../..");
  const executable =
    options.executable ??
    resolve(
      repository,
      process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python",
    );
  const child = spawn(executable, [options.script ?? resolve(cwd, "server/python_agent.py")], {
    cwd,
    env: { ...(options.env ?? process.env), PYTHONUNBUFFERED: "1" },
    stdio: ["pipe", "pipe", "ignore"],
    shell: false,
  });
  let forceKill: NodeJS.Timeout | undefined;
  const stop = () => {
    child.kill("SIGTERM");
    forceKill ??= setTimeout(() => child.kill("SIGKILL"), 1500);
  };
  const exited = new Promise<number | null>((resolveExit, rejectExit) => {
    child.once("error", () => rejectExit(new Error("Python agent could not start")));
    child.once("close", resolveExit);
  });
  void exited.catch(() => undefined);
  signal.addEventListener("abort", stop, { once: true });
  child.stdin.on("error", () => undefined);
  child.stdin.end(`${JSON.stringify({ message, path })}\n`);
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let total = 0;
  let done = false;
  try {
    signal.throwIfAborted();
    for await (const chunk of child.stdout) {
      signal.throwIfAborted();
      total += Buffer.byteLength(chunk);
      if (total > 2 * 1024 * 1024) throw new Error("Agent output exceeds limit");
      pending += decoder.write(chunk);
      let boundary = pending.indexOf("\n");
      while (boundary >= 0) {
        const line = pending.slice(0, boundary);
        pending = pending.slice(boundary + 1);
        if (Buffer.byteLength(line) > 256 * 1024) throw new Error("Agent event exceeds limit");
        const event: unknown = JSON.parse(line);
        if (
          !event ||
          typeof event !== "object" ||
          !("type" in event) ||
          typeof event.type !== "string"
        )
          throw new Error("Invalid agent event");
        if (done) throw new Error("Unexpected event after completion");
        if (event.type === "done") done = true;
        else yield event as ChatEvent;
        boundary = pending.indexOf("\n");
      }
      if (Buffer.byteLength(pending) > 256 * 1024) throw new Error("Agent event exceeds limit");
    }
    pending += decoder.end();
    if ((await exited) !== 0 || pending || !done) throw new Error("Python agent did not finish");
    signal.throwIfAborted();
  } finally {
    signal.removeEventListener("abort", stop);
    if (child.exitCode === null && child.signalCode === null) stop();
    await exited.catch(() => undefined);
    if (forceKill) clearTimeout(forceKill);
  }
  // A browser-visible completion acknowledges a successful, fully reaped child.
  yield { type: "done" };
}

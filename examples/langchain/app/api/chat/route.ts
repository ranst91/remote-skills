import { z } from "zod";
import { pythonAgent } from "../../../server/python-process.ts";
import { typescriptAgent } from "../../../server/typescript-agent.ts";

export const runtime = "nodejs";
const inputSchema = z
  .object({
    message: z.string().trim().min(1).max(8000),
    path: z.enum([
      "deepagents-ts",
      "langchain-ts",
      "langgraph-ts",
      "deepagents-python",
      "langchain-python",
      "langgraph-python",
    ]),
  })
  .strict();
const failure = "The agent could not complete your message. Please try again.";

export async function POST(request: Request) {
  let input: z.infer<typeof inputSchema>;
  try {
    const text = await request.text();
    if (Buffer.byteLength(text) > 65536) return new Response("Request too large", { status: 413 });
    const parsed: unknown = JSON.parse(text);
    input = inputSchema.parse(parsed);
  } catch {
    return new Response("Invalid message", { status: 400 });
  }
  if (!process.env.OPENAI_API_KEY || !process.env.REMOTE_SKILLS_ORIGIN)
    return new Response("Missing agent configuration", { status: 503 });
  const cancellation = new AbortController();
  const signal = AbortSignal.any([request.signal, cancellation.signal, AbortSignal.timeout(60000)]);
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const events =
          input.path === "deepagents-ts" ||
          input.path === "langchain-ts" ||
          input.path === "langgraph-ts"
            ? typescriptAgent(input.message, input.path, signal)
            : pythonAgent(input.message, input.path, signal);
        for await (const event of events) {
          signal.throwIfAborted();
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        }
      } catch {
        if (!cancellation.signal.aborted && !request.signal.aborted)
          controller.enqueue(
            encoder.encode(`${JSON.stringify({ type: "error", message: failure })}\n`),
          );
      } finally {
        try {
          controller.close();
        } catch {
          /* The browser may have cancelled the stream. */
        }
      }
    },
    cancel() {
      cancellation.abort();
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

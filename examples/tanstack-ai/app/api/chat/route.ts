import { createRemoteSkills } from "@remote-skills/client";
import { remoteSkills } from "@remote-skills/tanstack-ai";
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import { z } from "zod";
import { streamReply } from "../../../agent/index.ts";
import { createUITranslator } from "./stream.ts";

export const runtime = "nodejs";
const failure = "The agent could not complete your message. Please try again.";
const requestSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        parts: z.array(z.object({ type: z.string(), text: z.string().optional() })).max(100),
      }),
    )
    .min(1)
    .max(40),
});

export async function POST(request: Request) {
  let body: z.infer<typeof requestSchema>;
  try {
    const raw = await request.text();
    if (Buffer.byteLength(raw) > 65_536) return new Response("Request too large", { status: 413 });
    const parsed: unknown = JSON.parse(raw);
    body = requestSchema.parse(parsed);
    if (body.messages.at(-1)?.role !== "user") throw new Error("Invalid conversation");
  } catch {
    return new Response("Invalid conversation", { status: 400 });
  }
  const apiKey = process.env.OPENAI_API_KEY;
  const origin = process.env.REMOTE_SKILLS_ORIGIN;
  if (!apiKey || !origin) return new Response("Missing agent configuration", { status: 503 });
  const stream = createUIMessageStream({
    onError: () => {
      console.error("Chat generation failed");
      return failure;
    },
    execute: async ({ writer }) => {
      const client = createRemoteSkills({
        origins: { local: { url: origin, allowLoopbackHttp: true } },
        cache: "memory",
      });
      // A response owns its session. Tools are reselected on later turns; only
      // plain conversation text is replayed from the browser's display history.
      await using skills = await remoteSkills({ client, origin: "local" });
      const testUrl =
        process.env.REMOTE_SKILLS_EXAMPLE_TEST === "1" ? process.env.OPENAI_BASE_URL : undefined;
      if (testUrl) {
        const url = new URL(testUrl);
        if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
          throw new Error("Invalid test provider URL");
      }
      const messages = body.messages
        .map((message) => {
          const content = message.parts
            .filter((part) => part.type === "text")
            .map((part) => part.text ?? "")
            .join("\n");
          return message.role === "user"
            ? { role: "user" as const, content }
            : { role: "assistant" as const, content };
        })
        .filter((message) => message.content.trim());
      writer.write({ type: "start", messageId: crypto.randomUUID() });
      const controller = new AbortController();
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(60_000)]);
      const abort = () => controller.abort();
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      try {
        const translate = createUITranslator();
        for await (const chunk of streamReply(
          skills,
          messages,
          { apiKey, ...(testUrl ? { baseURL: testUrl } : {}) },
          controller,
        )) {
          const translated = translate(chunk);
          if (translated) writer.write(translated);
        }
      } finally {
        signal.removeEventListener("abort", abort);
        controller.abort();
      }
      writer.write({ type: "finish" });
    },
  });
  return createUIMessageStreamResponse({ stream });
}

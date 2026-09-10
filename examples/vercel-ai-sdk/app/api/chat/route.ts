import { createOpenAI } from "@ai-sdk/openai";
import { remoteSkills } from "@remote-skills/ai-sdk";
import { createRemoteSkills } from "@remote-skills/client";
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  type InferUITools,
  stepCountIs,
  streamText,
  type UIMessage,
  validateUIMessages,
} from "ai";
import { z } from "zod";

export const runtime = "nodejs";
const failure = "The agent could not complete your message. Please try again.";
const requestSchema = z.object({
  messages: z
    .array(
      z.object({
        id: z.string(),
        role: z.enum(["user", "assistant"]),
        parts: z.array(z.unknown()).max(100),
      }),
    )
    .min(1)
    .max(40),
});

export async function POST(request: Request) {
  let body: z.infer<typeof requestSchema>;
  try {
    const text = await request.text();
    if (Buffer.byteLength(text) > 65_536) return new Response("Request too large", { status: 413 });
    body = requestSchema.parse(JSON.parse(text));
    if (body.messages.at(-1)?.role !== "user") throw new Error("Invalid conversation");
  } catch {
    return new Response("Invalid conversation", { status: 400 });
  }
  const apiKey = process.env.OPENAI_API_KEY;
  const origin = process.env.REMOTE_SKILLS_ORIGIN;
  if (!apiKey || !origin) return new Response("Missing agent configuration", { status: 503 });

  const stream = createUIMessageStream({
    onError: () => failure,
    execute: async ({ writer }) => {
      const client = createRemoteSkills({
        origins: { local: { url: origin, allowLoopbackHttp: true } },
        cache: "memory",
      });
      // Each response owns a session. Retain an integration across requests if the
      // application requires conversation-wide version pins.
      await using skills = await remoteSkills({ client, origin: "local" });
      const testUrl =
        process.env.REMOTE_SKILLS_EXAMPLE_TEST === "1" ? process.env.OPENAI_BASE_URL : undefined;
      if (testUrl) {
        const url = new URL(testUrl);
        if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
          throw new Error("Invalid test provider URL");
      }
      const openai = createOpenAI({ apiKey, ...(testUrl ? { baseURL: testUrl } : {}) });
      const messages = await validateUIMessages<
        UIMessage<unknown, never, InferUITools<typeof skills.tools>>
      >({ messages: body.messages, tools: skills.tools });
      const result = streamText({
        model: openai.chat(process.env.OPENAI_MODEL || "gpt-4.1-mini"),
        ...skills.agentOptions,
        stopWhen: stepCountIs(6),
        maxRetries: 0,
        messages: await convertToModelMessages(messages),
        abortSignal: AbortSignal.any([request.signal, AbortSignal.timeout(60_000)]),
        onError: () => console.error("Chat generation failed"),
      });
      for await (const chunk of result.toUIMessageStream({
        originalMessages: messages,
        onError: () => failure,
      }))
        writer.write(chunk);
    },
  });
  return createUIMessageStreamResponse({ stream });
}

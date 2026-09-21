import type { RemoteSkillSource } from "@remote-skills/tanstack-ai";
import { chat, maxIterations } from "@tanstack/ai";
import { createOpenaiChatCompletions } from "@tanstack/ai-openai";
import { createResourceTool, withSkills } from "@tanstack/ai-skills";

function options(
  source: RemoteSkillSource,
  messages: { role: "user" | "assistant"; content: string }[],
  model: { apiKey: string; baseURL?: string },
) {
  return {
    // Provider errors may contain response bodies or credentials; surface safe route errors.
    debug: false,
    adapter: createOpenaiChatCompletions("gpt-4.1-mini", model.apiKey, {
      ...(model.baseURL ? { baseURL: model.baseURL } : {}),
      maxRetries: 0,
    }),
    messages,
    systemPrompts: [
      "Help the user. Follow relevant skills and read their required references before answering.",
    ],
    middleware: [withSkills(source)],
    tools: [createResourceTool(source)],
    agentLoopStrategy: maxIterations(5),
  };
}

export function reply(
  source: RemoteSkillSource,
  message: string,
  model: { apiKey: string; baseURL?: string },
) {
  return chat({ ...options(source, [{ role: "user", content: message }], model), stream: false });
}

export function streamReply(
  source: RemoteSkillSource,
  messages: { role: "user" | "assistant"; content: string }[],
  model: { apiKey: string; baseURL?: string },
  abortController: AbortController,
) {
  return chat({ ...options(source, messages, model), abortController });
}

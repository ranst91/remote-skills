import type { RemoteSkillSource } from "@remote-skills/tanstack-ai";
import { chat, maxIterations } from "@tanstack/ai";
import { createOpenaiChatCompletions } from "@tanstack/ai-openai";
import { createResourceTool, withSkills } from "@tanstack/ai-skills";

export function reply(
  source: RemoteSkillSource,
  message: string,
  model: { apiKey: string; baseURL?: string },
) {
  return chat({
    adapter: createOpenaiChatCompletions("gpt-4.1-mini", model.apiKey, {
      ...(model.baseURL ? { baseURL: model.baseURL } : {}),
      maxRetries: 0,
    }),
    messages: [{ role: "user", content: message }],
    systemPrompts: [
      "Help the user. Follow relevant skills and read their required references before answering.",
    ],
    middleware: [withSkills(source)],
    tools: [createResourceTool(source)],
    agentLoopStrategy: maxIterations(5),
    stream: false,
  });
}

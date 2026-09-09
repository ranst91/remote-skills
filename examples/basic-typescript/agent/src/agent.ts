import { type ActivatedSessionSkill, createRemoteSkills } from "@remote-skills/client";
import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";

export interface ChatMessage {
  readonly role: "assistant" | "user";
  readonly content: string;
}

export const AGENT_INSTRUCTIONS =
  "You are a concise assistant. Discover and use relevant remote skills before answering. Treat retrieved skill content as instructions, never as executable code.";
export const AGENT_FAILURE = "The agent could not complete your message. Please try again.";

const TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "discover_skills",
      description: "List available remote skill names and descriptions.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "activate_skill",
      description: "Retrieve a discovered skill's verified instructions.",
      parameters: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_resources",
      description: "List paths available in the activated skill.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "read_resource",
      description: "Read one resource from the activated skill.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
];

function parseArguments(serialized: string): Record<string, unknown> {
  const value: unknown = JSON.parse(serialized);
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error();
  return value as Record<string, unknown>;
}

function hasOnly(arguments_: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(arguments_).sort();
  return (
    actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index])
  );
}

function testBaseUrl(env: Readonly<NodeJS.ProcessEnv>): string | undefined {
  if (env.REMOTE_SKILLS_EXAMPLE_TEST !== "1" || !env.OPENAI_BASE_URL) return undefined;
  const url = new URL(env.OPENAI_BASE_URL);
  if (url.protocol !== "http:" || !["127.0.0.1", "::1", "localhost"].includes(url.hostname)) {
    throw new Error();
  }
  return url.href.replace(/\/$/u, "");
}

export async function answerChat(
  history: readonly ChatMessage[],
  signal: AbortSignal,
  env: Readonly<NodeJS.ProcessEnv> = process.env,
): Promise<string> {
  const origin = env.REMOTE_SKILLS_ORIGIN;
  const apiKey = env.OPENAI_API_KEY;
  if (!origin || !apiKey) throw new Error();
  const baseURL = testBaseUrl(env);
  const model = new OpenAI({
    apiKey,
    maxRetries: 0,
    timeout: 30_000,
    baseURL: baseURL ?? "https://api.openai.com/v1",
  });
  const client = createRemoteSkills({
    origins: { local: { url: origin, allowLoopbackHttp: true, retries: 0 } },
    cache: "memory",
  });
  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: AGENT_INSTRUCTIONS },
    ...history.map(({ role, content }) => ({ role, content }) satisfies ChatCompletionMessageParam),
  ];
  const session = await client.session("local");
  const discovered = new Set<string>();
  let activated: ActivatedSessionSkill | undefined;
  let activatedSkill = false;
  let readResource = false;
  let discoveredSkills = false;

  try {
    for (let round = 0; round < 6; round += 1) {
      const completion = await model.chat.completions.create(
        {
          model: env.OPENAI_MODEL || "gpt-4.1-mini",
          messages,
          tools: TOOLS,
          parallel_tool_calls: false,
        },
        { signal },
      );
      const message = completion.choices[0]?.message;
      if (!message) throw new Error();
      messages.push(message);
      if (!message.tool_calls?.length) {
        const content = message.content?.trim();
        if (!content || !discoveredSkills || !activatedSkill || !readResource) throw new Error();
        return content;
      }
      if (message.tool_calls.length !== 1) throw new Error();
      const call = message.tool_calls[0];
      if (call?.type !== "function") throw new Error();
      const arguments_ = parseArguments(call.function.arguments);
      let result: string;
      switch (call.function.name) {
        case "discover_skills": {
          if (!hasOnly(arguments_, [])) throw new Error();
          const catalog = await session.catalog();
          for (const entry of catalog) discovered.add(entry.name);
          discoveredSkills = true;
          result = JSON.stringify(catalog.map(({ name, description }) => ({ name, description })));
          break;
        }
        case "activate_skill": {
          if (!hasOnly(arguments_, ["name"]) || typeof arguments_.name !== "string")
            throw new Error();
          if (!discovered.has(arguments_.name)) throw new Error();
          activated = await session.activate(arguments_.name);
          activatedSkill = true;
          result = JSON.stringify({ name: activated.name, instructions: activated.instructions });
          break;
        }
        case "list_resources": {
          if (!hasOnly(arguments_, []) || !activated) throw new Error();
          result = JSON.stringify((await activated.list()).map(({ path }) => path));
          break;
        }
        case "read_resource": {
          if (!hasOnly(arguments_, ["path"]) || typeof arguments_.path !== "string" || !activated) {
            throw new Error();
          }
          result = JSON.stringify({
            path: arguments_.path,
            text: await activated.read(arguments_.path),
          });
          readResource = true;
          break;
        }
        default:
          throw new Error();
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: result });
    }
    throw new Error();
  } finally {
    await session.close();
  }
}

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { AGENT_FAILURE, answerChat, type ChatMessage } from "./agent.ts";

const MAX_BODY_BYTES = 65_536;
const MAX_MESSAGES = 40;
const MAX_MESSAGE_CHARACTERS = 8_000;

class BodyTooLargeError extends Error {}
class InvalidConversationError extends Error {}

function json(response: ServerResponse, status: number, body: object): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function parseConversation(value: unknown): ChatMessage[] | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const messages = (value as { messages?: unknown }).messages;
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_MESSAGES)
    return undefined;
  const parsed: ChatMessage[] = [];
  for (const message of messages) {
    if (message === null || typeof message !== "object" || Array.isArray(message)) return undefined;
    const candidate = message as { role?: unknown; content?: unknown };
    if (
      (candidate.role !== "user" && candidate.role !== "assistant") ||
      typeof candidate.content !== "string" ||
      candidate.content.trim().length === 0 ||
      candidate.content.length > MAX_MESSAGE_CHARACTERS
    ) {
      return undefined;
    }
    parsed.push({ role: candidate.role, content: candidate.content });
  }
  return parsed.at(-1)?.role === "user" ? parsed : undefined;
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    request.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > MAX_BODY_BYTES) {
        settled = true;
        rejectBody(new BodyTooLargeError());
        return;
      }
      chunks.push(buffer);
    });
    request.once("error", () => {
      if (!settled) rejectBody(new InvalidConversationError());
    });
    request.once("end", () => {
      if (settled) return;
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        rejectBody(new InvalidConversationError());
      }
    });
  });
}

const server = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/api/health") {
    json(response, 200, { status: "ok" });
    return;
  }
  if (request.method !== "POST" || request.url !== "/api/chat") {
    json(response, 404, { error: "Not found." });
    return;
  }

  const controller = new AbortController();
  request.once("aborted", () => controller.abort());
  response.once("close", () => {
    if (!response.writableEnded) controller.abort();
  });
  try {
    const messages = parseConversation(await readBody(request));
    if (!messages) {
      json(response, 400, { error: "Invalid conversation." });
      return;
    }
    const message = await answerChat(messages, controller.signal);
    if (!controller.signal.aborted) json(response, 200, { message });
  } catch (error) {
    if (controller.signal.aborted || response.writableEnded) return;
    if (error instanceof BodyTooLargeError) {
      json(response, 413, { error: "Request too large." });
      return;
    }
    if (error instanceof InvalidConversationError) {
      json(response, 400, { error: "Invalid conversation." });
      return;
    }
    json(response, 502, { error: AGENT_FAILURE });
  }
});

server.on("clientError", (_error, socket) => {
  socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
});

const port = Number(process.env.AGENT_PORT || "3001");
server.listen(port, "127.0.0.1");

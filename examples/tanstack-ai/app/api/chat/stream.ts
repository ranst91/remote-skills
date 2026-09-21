import type { StreamChunk } from "@tanstack/ai";
import type { UIMessageChunk } from "ai";

function toolInput(input: unknown, raw: string): unknown {
  if (input !== undefined) return input;
  const parsed: unknown = JSON.parse(raw || "{}");
  return parsed;
}

/** Translate transport only: TanStack owns selection, execution, and the agent loop. */
export function createUITranslator() {
  const calls = new Map<string, { name: string; arguments: string }>();
  return (chunk: StreamChunk): UIMessageChunk | undefined => {
    switch (chunk.type) {
      case "TEXT_MESSAGE_START":
        return { type: "text-start", id: chunk.messageId };
      case "TEXT_MESSAGE_CONTENT":
        return { type: "text-delta", id: chunk.messageId, delta: chunk.delta };
      case "TEXT_MESSAGE_END":
        return { type: "text-end", id: chunk.messageId };
      case "TOOL_CALL_START":
        calls.set(chunk.toolCallId, { name: chunk.toolCallName, arguments: "" });
        return undefined;
      case "TOOL_CALL_ARGS": {
        const call = calls.get(chunk.toolCallId);
        if (!call) throw new Error("Unknown tool call");
        call.arguments += chunk.delta;
        return undefined;
      }
      case "TOOL_CALL_END": {
        const call = calls.get(chunk.toolCallId);
        if (!call) throw new Error("Unknown tool call");
        const input = toolInput(chunk.input, call.arguments);
        return {
          type: "tool-input-available",
          toolCallId: chunk.toolCallId,
          toolName: call.name,
          input,
        };
      }
      case "TOOL_CALL_RESULT": {
        if (!calls.delete(chunk.toolCallId)) throw new Error("Unknown tool result");
        const output: unknown = JSON.parse(chunk.content);
        return { type: "tool-output-available", toolCallId: chunk.toolCallId, output };
      }
      case "RUN_ERROR":
        throw new Error("Chat generation failed");
      default:
        return undefined;
    }
  };
}

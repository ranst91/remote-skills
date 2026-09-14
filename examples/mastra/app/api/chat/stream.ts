import type { ChunkType } from "@mastra/core/stream";
import type { UIMessageChunk } from "ai";

/** Translate transport events in arrival order; Mastra retains the agent/tool loop. */
export function uiChunk(chunk: ChunkType): UIMessageChunk | undefined {
  switch (chunk.type) {
    case "text-start":
      return { type: "text-start", id: chunk.payload.id };
    case "text-delta":
      return { type: "text-delta", id: chunk.payload.id, delta: chunk.payload.text };
    case "text-end":
      return { type: "text-end", id: chunk.payload.id };
    case "step-start":
      return { type: "start-step" };
    case "step-finish":
      return { type: "finish-step" };
    case "tool-call":
      return {
        type: "tool-input-available",
        toolCallId: chunk.payload.toolCallId,
        toolName: chunk.payload.toolName,
        input: chunk.payload.args ?? {},
      };
    case "tool-result":
      return chunk.payload.isError
        ? {
            type: "tool-output-error",
            toolCallId: chunk.payload.toolCallId,
            errorText: "The skill operation failed.",
          }
        : {
            type: "tool-output-available",
            toolCallId: chunk.payload.toolCallId,
            output: chunk.payload.result,
          };
    case "error":
      throw new Error("Chat generation failed");
    default:
      return undefined;
  }
}

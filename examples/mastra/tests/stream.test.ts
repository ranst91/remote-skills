import assert from "node:assert/strict";
import test from "node:test";
import { ChunkFrom, type ChunkType } from "@mastra/core/stream";
import { uiChunk } from "../app/api/chat/stream.ts";

test("Mastra events preserve narration, native selection, native read and final answer order", () => {
  const chunks: ChunkType[] = [
    { type: "text-start", runId: "run", from: ChunkFrom.AGENT, payload: { id: "intro" } },
    {
      type: "text-delta",
      runId: "run",
      from: ChunkFrom.AGENT,
      payload: { id: "intro", text: "One moment." },
    },
    { type: "text-end", runId: "run", from: ChunkFrom.AGENT, payload: { id: "intro" } },
    {
      type: "tool-call",
      runId: "run",
      from: ChunkFrom.AGENT,
      payload: {
        toolCallId: "load",
        toolName: "skill",
        args: { name: "greeting" } as Record<string, unknown>,
      },
    },
    {
      type: "tool-result",
      runId: "run",
      from: ChunkFrom.AGENT,
      payload: { toolCallId: "load", toolName: "skill", result: "Read references/greeting.md" },
    },
    {
      type: "tool-call",
      runId: "run",
      from: ChunkFrom.AGENT,
      payload: {
        toolCallId: "read",
        toolName: "skill_read",
        args: { skillName: "greeting", path: "references/greeting.md" } as Record<string, unknown>,
      },
    },
    {
      type: "tool-result",
      runId: "run",
      from: ChunkFrom.AGENT,
      payload: { toolCallId: "read", toolName: "skill_read", result: "Ahoy!" },
    },
    { type: "text-start", runId: "run", from: ChunkFrom.AGENT, payload: { id: "answer" } },
    {
      type: "text-delta",
      runId: "run",
      from: ChunkFrom.AGENT,
      payload: { id: "answer", text: "Ahoy!" },
    },
    { type: "text-end", runId: "run", from: ChunkFrom.AGENT, payload: { id: "answer" } },
  ];
  assert.deepEqual(
    chunks.map(uiChunk).map((chunk) => chunk?.type),
    [
      "text-start",
      "text-delta",
      "text-end",
      "tool-input-available",
      "tool-output-available",
      "tool-input-available",
      "tool-output-available",
      "text-start",
      "text-delta",
      "text-end",
    ],
  );
});

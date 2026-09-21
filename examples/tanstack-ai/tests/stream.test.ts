import assert from "node:assert/strict";
import test from "node:test";
import { EventType } from "@ag-ui/core";
import type { StreamChunk } from "@tanstack/ai";
import { createUITranslator } from "../app/api/chat/stream.ts";

test("native streamed arguments and results preserve narration, tools and final text order", () => {
  const translate = createUITranslator();
  const chunks: StreamChunk[] = [
    { type: EventType.TEXT_MESSAGE_START, messageId: "intro", role: "assistant" },
    { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "intro", delta: "One moment." },
    { type: EventType.TEXT_MESSAGE_END, messageId: "intro" },
    { type: EventType.TOOL_CALL_START, toolCallId: "load", toolCallName: "load_skill" },
    { type: EventType.TOOL_CALL_ARGS, toolCallId: "load", delta: '{"name":' },
    { type: EventType.TOOL_CALL_ARGS, toolCallId: "load", delta: '"greeting"}' },
    { type: EventType.TOOL_CALL_END, toolCallId: "load" },
    {
      type: EventType.TOOL_CALL_RESULT,
      toolCallId: "load",
      messageId: "result",
      content: '{"content":"Read references/greeting.md"}',
      role: "tool",
    },
    { type: EventType.TEXT_MESSAGE_START, messageId: "answer", role: "assistant" },
    { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "answer", delta: "Ahoy!" },
    { type: EventType.TEXT_MESSAGE_END, messageId: "answer" },
  ];
  const output = chunks.map(translate).filter((chunk) => chunk !== undefined);
  assert.deepEqual(
    output.map((chunk) => chunk.type),
    [
      "text-start",
      "text-delta",
      "text-end",
      "tool-input-available",
      "tool-output-available",
      "text-start",
      "text-delta",
      "text-end",
    ],
  );
  assert.deepEqual(output[3], {
    type: "tool-input-available",
    toolCallId: "load",
    toolName: "load_skill",
    input: { name: "greeting" },
  });
  assert.deepEqual(output[4], {
    type: "tool-output-available",
    toolCallId: "load",
    output: { content: "Read references/greeting.md" },
  });
});

test("stream errors are sanitized and inconsistent tool events fail closed", () => {
  const translate = createUITranslator();
  assert.throws(
    () => translate({ type: EventType.RUN_ERROR, message: "private-secret-sentinel" }),
    {
      message: "Chat generation failed",
    },
  );
  assert.throws(
    () => translate({ type: EventType.TOOL_CALL_END, toolCallId: "unknown" }),
    /Unknown tool call/u,
  );
  assert.throws(
    () =>
      translate({
        type: EventType.TOOL_CALL_RESULT,
        toolCallId: "unknown",
        messageId: "x",
        content: "{}",
        role: "tool",
      }),
    /Unknown tool result/u,
  );
});

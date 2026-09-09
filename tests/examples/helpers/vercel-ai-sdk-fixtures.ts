import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { LLMock } from "@copilotkit/aimock";

export const GREETING = "Ahoy, curious human! What would you like to explore?";
export const FAILURE = "The agent could not complete your message. Please try again.";
export const MODEL = "gpt-4.1-mini";

export async function skillExpectations(exampleRoot: string) {
  const root = resolve(exampleRoot, "skills/source/greeting");
  const markdown = await readFile(resolve(root, "SKILL.md"), "utf8");
  const description = /^description: (.+)$/mu.exec(markdown)?.[1];
  const instructions = /^---\n[\s\S]*?\n---\n\n([\s\S]*)$/u.exec(markdown)?.[1];
  assert.ok(description && instructions, "The example has an explicit skill description and body.");
  return {
    description,
    instructions,
    resourceText: await readFile(resolve(root, "references/greeting.md"), "utf8"),
  };
}

export function createModel() {
  // Only the model is replaced. SDK discovery, downloads, activation and reads remain real.
  return new LLMock({ host: "127.0.0.1", port: 0, strict: true, logLevel: "silent" });
}

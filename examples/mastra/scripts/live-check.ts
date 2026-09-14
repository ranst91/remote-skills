import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";
import { WELCOME_PROMPT } from "../app/prompt.ts";

function object(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
const origin = process.env.MASTRA_DEMO_URL ?? "http://127.0.0.1:5181";
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  let browserErrors = 0;
  page.on("pageerror", () => browserErrors++);
  await page.goto(origin);
  const responsePromise = page.waitForResponse(
    (response) => response.url() === `${origin}/api/chat`,
    { timeout: 90_000 },
  );
  await page.getByRole("button", { name: "Welcome a teammate", exact: true }).click();
  const response = await responsePromise;
  assert.equal(response.status(), 200);
  // Inspect transport payloads in memory. Never persist or log their contents.
  const text = await response.text();
  const chunks = text
    .split("\n")
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => {
      const parsed: unknown = JSON.parse(line.slice(6));
      return object(parsed);
    });
  const calls = chunks.filter((chunk) => chunk.type === "tool-input-available");
  assert.deepEqual(
    calls.map((chunk) => chunk.toolName),
    ["skill", "skill_read"],
  );
  const activation = chunks.find(
    (chunk) => chunk.type === "tool-output-available" && chunk.toolCallId === calls[0]?.toolCallId,
  );
  const read = chunks.find(
    (chunk) => chunk.type === "tool-output-available" && chunk.toolCallId === calls[1]?.toolCallId,
  );
  const instructions = (
    await readFile(new URL("../skills/source/greeting/SKILL.md", import.meta.url), "utf8")
  )
    .replace(/^---\n[\s\S]*?\n---\n/u, "")
    .trim();
  const resource = await readFile(
    new URL("../skills/source/greeting/references/greeting.md", import.meta.url),
    "utf8",
  );
  assert.ok(
    typeof activation?.output === "string" && activation.output.includes(instructions),
    "Full instructions must reach native activation",
  );
  assert.ok(read?.output === resource, "Native resource bytes must match the published resource");
  assert.ok(read && activation);
  const readIndex = chunks.indexOf(read);
  assert.ok(chunks.indexOf(activation) < readIndex);
  const answer = chunks
    .slice(readIndex + 1)
    .filter((chunk) => chunk.type === "text-delta")
    .map((chunk) => chunk.delta)
    .join("");
  assert.ok(answer.includes("Ahoy, curious human!"), "The answer must use the skill's greeting");
  await page.getByRole("button", { name: "Send", exact: true }).waitFor();
  // Next.js also creates an empty route-announcer alert outside the demo UI.
  assert.equal(await page.locator(".alert[role='alert']").count(), 0);
  assert.equal(browserErrors, 0);
  const ordered = await page
    .locator("article.assistant > p:not(.author), article.assistant > details")
    .evaluateAll((elements) => elements.map((element) => element.tagName));
  assert.deepEqual(ordered.slice(-3), ["DETAILS", "DETAILS", "P"]);
  console.log(
    JSON.stringify(
      {
        model: process.env.OPENAI_MODEL || "gpt-4.1",
        prompt: WELCOME_PROMPT,
        nativeTools: calls.map((chunk) => chunk.toolName),
        activationOutputSha256: createHash("sha256").update(activation.output).digest("hex"),
        resourceOutputSha256: createHash("sha256").update(resource).digest("hex"),
        fullInstructionsVerified: true,
        resourceBytesVerified: true,
        streamOrderVerified: true,
        greetingVerified: true,
        browserErrors,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}

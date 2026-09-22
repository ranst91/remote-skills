import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import type { ChatCompletionRequest } from "@copilotkit/aimock";
import { chromium } from "playwright";
import { WELCOME_PROMPT } from "../../examples/tanstack-ai/app/prompt.ts";
import { startMastra } from "./helpers/mastra-process.ts";
import { createModel, skillExpectations } from "./helpers/vercel-ai-sdk-fixtures.ts";
import { disposableExample, startupFails, until } from "./helpers/vercel-ai-sdk-process.ts";

function toolResult(request: ChatCompletionRequest, id: string): string | undefined {
  const content = request.messages.find(
    (message) => message.role === "tool" && message.tool_call_id === id,
  )?.content;
  return typeof content === "string" ? content : undefined;
}

// The provider alone is scripted. Browser, Next route, native TanStack tools and published origin are real.
test("tanstack-ai: real browser loads the selected published skill lazily, reads its exact reference, and orders the UI", {
  timeout: 240_000,
}, async (t) => {
  const checkout = await disposableExample("tanstack-ai");
  const cleanups: (() => Promise<void>)[] = [checkout.clean];
  t.after(async () => {
    const errors: unknown[] = [];
    for (const cleanup of cleanups.reverse()) {
      try {
        await cleanup();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, "TanStack E2E cleanup failed.");
  });
  await t.test("invalid startup fails before launching services", async () => {
    await startupFails(checkout.exampleRoot, {}, /OPENAI_API_KEY is required/u);
    await startupFails(
      checkout.exampleRoot,
      { REMOTE_SKILLS_EXAMPLE_TEST: "1", APP_PORT: "5183", SKILLS_PORT: "5183" },
      /must be distinct/u,
    );
  });
  const skill = await skillExpectations(resolve(checkout.root, "examples/tanstack-ai"));
  const opening = /^Open greeting replies with: (.+)$/mu.exec(skill.resourceText)?.[1]?.trim();
  assert.ok(opening, "The published reference declares an explicit greeting opening.");
  const expectedReply = `${opening} What would you like to explore?`;
  const unusedRoot = resolve(checkout.root, "examples/tanstack-ai/skills/source/weather");
  await mkdir(unusedRoot, { recursive: true });
  await writeFile(
    resolve(unusedRoot, "SKILL.md"),
    "---\nname: weather\ndescription: Explain the weather forecast.\n---\n\nUnused weather instructions.\n",
  );
  const model = createModel();
  await model.start();
  cleanups.push(() => model.stop());
  const app = await startMastra(checkout.root, model.url, "tanstack-ai");
  cleanups.push(app.stop);
  const browser = await chromium.launch();
  cleanups.push(() => browser.close());
  const page = await browser.newPage();
  page.setDefaultTimeout(20_000);
  let browserErrors = 0;
  page.on("pageerror", () => {
    browserErrors += 1;
  });
  const rounds: number[] = [];
  const matches = (request: ChatCompletionRequest, round: number) => {
    const results = request.messages.filter((message) => message.role === "tool");
    if (request.model !== "gpt-4.1-mini" || results.length !== round) return false;
    const prompt = request.messages
      .map((message) => (typeof message.content === "string" ? message.content : ""))
      .join("\n");
    const tools = request.tools?.map((tool) => tool.function.name) ?? [];
    if (!["load_skill", "read_skill_resource"].every((name) => tools.includes(name))) return false;
    if (
      !request.messages.some(
        (message) => message.role === "user" && message.content === WELCOME_PROMPT,
      )
    )
      return false;
    const catalogRequests = app.paths.filter((path) => path.endsWith("/index.json"));
    const artifactRequests = app.paths.filter((path) => !path.endsWith("/index.json"));
    if (catalogRequests.length !== 1 || artifactRequests.length !== (round === 0 ? 0 : 1))
      return false;
    if (
      round === 0 &&
      (!prompt.includes(skill.description) ||
        !prompt.includes("Explain the weather forecast.") ||
        prompt.includes(skill.instructions.trim()) ||
        prompt.includes(skill.resourceText))
    )
      return false;
    if (
      round >= 1 &&
      !toolResult(request, "load")?.includes(JSON.stringify(skill.instructions.trim()).slice(1, -1))
    )
      return false;
    if (
      round >= 2 &&
      !toolResult(request, "read")?.includes(JSON.stringify(skill.resourceText).slice(1, -1))
    )
      return false;
    rounds.push(round);
    return true;
  };
  model.addFixtures([
    {
      match: { predicate: (request) => matches(request, 0) },
      response: {
        toolCalls: [{ id: "load", name: "load_skill", arguments: '{"name":"greeting"}' }],
      },
    },
    {
      match: { predicate: (request) => matches(request, 1) },
      response: {
        toolCalls: [
          {
            id: "read",
            name: "read_skill_resource",
            arguments: '{"skill":"greeting","path":"references/greeting.md"}',
          },
        ],
      },
    },
    {
      match: { predicate: (request) => matches(request, 2) },
      response: { content: expectedReply },
    },
  ]);
  await page.goto(app.origin);
  assert.equal(app.paths.length, 0, "Rendering the page does not download a catalog or artifact.");
  await page.getByRole("button", { name: "Welcome a teammate", exact: true }).click();
  await until(
    async () =>
      (
        await page.getByRole("log").locator("article.assistant > p:not(.author)").allTextContents()
      ).join("") === expectedReply,
    "the rendered reply uses the exact reference-derived opening",
    20_000,
  );
  assert.deepEqual(rounds, [0, 1, 2]);
  assert.equal(model.getRequests().length, 3);
  assert.ok(
    model
      .getRequests()
      .every(
        (request) => request.path === "/v1/chat/completions" && request.response.status === 200,
      ),
  );
  const assistant = page.getByRole("log").locator("article.assistant");
  assert.deepEqual(
    await assistant
      .locator(":scope > :not(.author)")
      .evaluateAll((nodes) => nodes.map((node) => node.tagName)),
    ["DETAILS", "DETAILS", "P"],
  );
  const details = await assistant.locator("details pre").allTextContents();
  const first: unknown = JSON.parse(details[0] ?? "null");
  const second: unknown = JSON.parse(details[1] ?? "null");
  assert.ok(
    first &&
      typeof first === "object" &&
      "type" in first &&
      first.type === "tool-load_skill" &&
      "output" in first &&
      first.output &&
      typeof first.output === "object" &&
      "content" in first.output &&
      first.output.content === skill.instructions.trim(),
    "Native activation output reaches the browser intact.",
  );
  assert.ok(
    second &&
      typeof second === "object" &&
      "type" in second &&
      second.type === "tool-read_skill_resource" &&
      "output" in second &&
      second.output &&
      typeof second.output === "object" &&
      "content" in second.output &&
      second.output.content === skill.resourceText,
    "Exact native reference output reaches the browser intact.",
  );
  const published: unknown = JSON.parse(
    await readFile(
      resolve(
        checkout.root,
        "examples/tanstack-ai/skills/dist/.well-known/agent-skills/index.json",
      ),
      "utf8",
    ),
  );
  assert.ok(
    published &&
      typeof published === "object" &&
      "skills" in published &&
      Array.isArray(published.skills),
  );
  assert.equal(published.skills.length, 2, "The origin publishes both candidate skills.");
  for (const candidate of published.skills) {
    const entry: unknown = candidate;
    assert.ok(
      entry &&
        typeof entry === "object" &&
        "name" in entry &&
        "url" in entry &&
        typeof entry.url === "string",
    );
    const artifactUrl = entry.url;
    const fetched = app.paths.some((path) => path.endsWith(artifactUrl));
    assert.equal(
      fetched,
      entry.name === "greeting",
      "Only the selected catalog artifact is downloaded.",
    );
  }
  await t.test("an ordinary direct answer leaves all artifacts unfetched", async () => {
    await page.getByRole("button", { name: "Reset", exact: true }).click();
    model.clearFixtures();
    model.clearRequests();
    app.paths.length = 0;
    model.addFixture({
      match: {
        predicate: (request) =>
          request.messages.some(
            (message) => message.role === "user" && message.content === "What is two plus two?",
          ) &&
          app.paths.length === 1 &&
          app.paths[0]?.endsWith("/index.json") === true,
      },
      response: { content: "Four." },
    });
    await page.getByLabel("Your message").fill("What is two plus two?");
    await page.getByLabel("Your message").press("Enter");
    await page.getByText("Four.", { exact: true }).waitFor();
    assert.equal(model.getRequests().length, 1);
    assert.equal(app.paths.length, 1);
    assert.equal(await assistant.locator("details").count(), 0);
  });

  await t.test("Stop cancels an in-flight reply and Reset clears the conversation", async () => {
    await page.getByRole("button", { name: "Reset", exact: true }).click();
    model.clearFixtures();
    model.clearRequests();
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    model.addFixture({
      match: { userMessage: "Wait for me" },
      response: async () => {
        entered();
        await waiting;
        return { content: "Late answer must not appear." };
      },
    });
    try {
      await page.getByLabel("Your message").fill("Wait for me");
      await page.getByLabel("Your message").press("Enter");
      await Promise.race([
        started,
        new Promise<never>((_resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("Model request did not start")), 10_000);
          timer.unref();
        }),
      ]);
      await page.getByRole("button", { name: "Stop", exact: true }).click();
      await until(() => page.getByLabel("Your message").isEnabled(), "composer enabled after stop");
      await page.getByRole("button", { name: "Reset", exact: true }).click();
      release();
      assert.equal(await page.getByRole("log").locator("article").count(), 0);
    } finally {
      release();
    }
  });
  await t.test("provider failures show a safe error and restore the composer", async () => {
    await page.getByRole("button", { name: "Reset", exact: true }).click();
    model.clearFixtures();
    model.clearRequests();
    await page.getByRole("button", { name: "Welcome a teammate", exact: true }).click();
    await page.locator(".alert").waitFor();
    assert.equal(
      await page.locator(".alert").textContent(),
      "The agent could not complete your message. Please try again.",
    );
    assert.equal(await page.getByLabel("Your message").isEnabled(), true);
    await page.getByRole("button", { name: "Reset", exact: true }).click();
    assert.equal(await page.locator(".alert").count(), 0);
  });
  await t.test(
    "corrupted published bytes never reach the model or browser as instructions",
    async () => {
      model.clearFixtures();
      model.clearRequests();
      app.paths.length = 0;
      app.corruptArtifacts();
      model.addFixture({
        match: {
          predicate: (request) => !request.messages.some((message) => message.role === "tool"),
        },
        response: {
          toolCalls: [{ id: "bad-load", name: "load_skill", arguments: '{"name":"greeting"}' }],
        },
      });
      await page.getByRole("button", { name: "Welcome a teammate", exact: true }).click();
      await page.locator(".alert").waitFor();
      assert.equal(app.paths.filter((path) => !path.endsWith("/index.json")).length, 1);
      assert.equal(
        (await page.getByRole("log").textContent())?.includes(skill.instructions.trim()),
        false,
      );
      for (const request of model.getRequests())
        assert.equal(
          JSON.stringify(request).includes(JSON.stringify(skill.instructions.trim()).slice(1, -1)),
          false,
        );
      await page.getByRole("button", { name: "Reset", exact: true }).click();
    },
  );
  assert.equal(browserErrors, 0);
  assert.equal(await page.locator(".alert").count(), 0);
});

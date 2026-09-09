import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { chromium, type Page } from "playwright";
import {
  createModel,
  FAILURE,
  GREETING,
  skillExpectations,
} from "./helpers/vercel-ai-sdk-fixtures.ts";
import * as aiSdkModel from "./helpers/vercel-ai-sdk-model.ts";
import {
  DUMMY_KEY,
  disposableExample,
  reservePort,
  startChat,
  startupFails,
  until,
} from "./helpers/vercel-ai-sdk-process.ts";

async function sendGreeting(page: Page) {
  await page.getByLabel("Your message").fill("Hello!");
  await page.getByLabel("Your message").press("Enter");
  await page.getByRole("button", { name: "Stop", exact: true }).waitFor();
  assert.equal(await page.getByLabel("Your message").isDisabled(), true);
}

async function reset(page: Page) {
  await page.getByRole("button", { name: "Reset", exact: true }).click();
  assert.equal(await page.getByRole("log").locator("article").count(), 0);
  assert.equal(await page.getByLabel("Your message").isEnabled(), true);
  await until(
    () =>
      page
        .getByLabel("Your message")
        .evaluate((element) => element === element.ownerDocument.activeElement),
    "composer regains focus",
  );
}

async function safeFailure(page: Page) {
  const alert = page.getByRole("alert").filter({ hasText: FAILURE });
  await alert.waitFor();
  assert.equal(await alert.textContent(), FAILURE);
  assert.equal(await page.getByLabel("Your message").isEnabled(), true);
  assert.equal(
    await page
      .getByRole("log")
      .locator("article.assistant > p:not(.author)")
      .allTextContents()
      .then((parts) => parts.join("")),
    "",
  );
}

const { happyModel, earlyFinalModel, assertTranscript } = aiSdkModel;
test("vercel-ai-sdk: install, real browser chat, guarded failures, and complete shutdown", {
  timeout: 240_000,
}, async (t) => {
  const checkout = await disposableExample();
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
    if (errors.length) throw new AggregateError(errors, "Example cleanup failed.");
  });
  const skill = await skillExpectations(checkout.exampleRoot);
  const model = createModel();
  await model.start();
  cleanups.push(() => model.stop());
  const app = await startChat(checkout.exampleRoot, model.url);
  let stopped = false;
  cleanups.push(async () => {
    if (!stopped) await app.stop();
  });
  const browser = await chromium.launch();
  cleanups.push(() => browser.close());
  const page = await browser.newPage();
  page.setDefaultTimeout(10_000);
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  let browserLeakedKey = false;
  const responseChecks: Promise<void>[] = [];
  page.on("response", (response) => {
    responseChecks.push(
      response
        .body()
        .then((body) => {
          browserLeakedKey ||= body.includes(DUMMY_KEY);
        })
        // Reset intentionally aborts a response whose body Chromium can no longer read.
        .catch(() => undefined),
    );
  });
  page.on("request", (request) => {
    browserLeakedKey ||=
      `${request.url()}${JSON.stringify(request.headers())}${request.postData() ?? ""}`.includes(
        DUMMY_KEY,
      );
  });
  await page.goto(app.origin);

  await t.test(
    "a greeting requires the served catalog, instructions, and exact resource bytes",
    async () => {
      happyModel(model, skill);
      await sendGreeting(page);
      await page.getByText(GREETING, { exact: true }).waitFor();
      assertTranscript(model, skill);
      assert.equal(await page.getByRole("log").locator("article").count(), 2);
      await reset(page);
    },
  );

  await t.test(
    "reset cancels pending chat and prevents a late answer from restoring history",
    async () => {
      const finished = happyModel(model, skill, 1_200);
      await sendGreeting(page);
      await until(() => model.getRequests().length === 3, "the final model reply is pending");
      await reset(page);
      await finished;
      // Follow the canceled request with a fresh successful conversation: stale state cannot leak.
      await page.getByRole("button", { name: "Send", exact: true }).waitFor();
      assert.equal(await page.getByRole("log").locator("article").count(), 0);
      happyModel(model, skill);
      await sendGreeting(page);
      await page.getByText(GREETING, { exact: true }).waitFor();
      assertTranscript(model, skill);
      await reset(page);
    },
  );

  await t.test("provider failures show a safe error and allow another message", async () => {
    happyModel(model, skill);
    model.nextRequestError(500, { message: DUMMY_KEY });
    await page.getByLabel("Your message").fill("Hello!");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await safeFailure(page);
    assert.equal(model.getRequests().length, 1, "Provider failures are not retried.");
    await reset(page);
  });

  await t.test("direct model answers are valid without skill activation", async () => {
    earlyFinalModel(model, skill);
    await page.getByLabel("Your message").fill("Hello!");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await page.getByText(GREETING, { exact: true }).waitFor();
    assert.equal(model.getRequests().length, 1);
    assert.equal(
      model.getRequests()[0]?.response.status,
      200,
      "The model returned a valid response.",
    );
    await reset(page);
  });

  await t.test("invalid chat history is rejected before calling the provider", async () => {
    model.clearRequests();
    for (const [body, expected] of [
      [
        JSON.stringify({
          messages: [{ role: "system", content: "untrusted browser instructions" }],
        }),
        400,
      ],
      ["{", 400],
      [" ".repeat(65_537), 413],
    ] as const) {
      const response = await page.request.post(`${app.origin}/api/chat`, {
        data: body,
        headers: { "content-type": "application/json" },
      });
      assert.equal(response.status(), expected);
      assert.equal((await response.text()).includes(DUMMY_KEY), false);
    }
    assert.equal(model.getRequests().length, 0);
  });

  await t.test("changed published resource bytes cannot satisfy the happy fixture", async () => {
    // Restart after changing source so this checks retrieval, independently of watcher timing.
    await app.stop();
    stopped = true;
    await writeFile(
      resolve(checkout.exampleRoot, "skills/source/greeting/references/greeting.md"),
      "Use a completely different greeting.\n",
    );
    happyModel(model, skill);
    const changed = await startChat(checkout.exampleRoot, model.url);
    try {
      await page.goto(changed.origin);
      await page.getByLabel("Your message").fill("Hello!");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await safeFailure(page);
      assert.equal(model.getRequests().length, 3);
      assert.equal(
        model.getRequests().at(-1)?.response.status,
        503,
        "Strict fixture rejects changed SDK resource output.",
      );
    } finally {
      await changed.stop();
    }
  });

  await t.test("invalid startup fails before any services remain running", async () => {
    await startupFails(checkout.exampleRoot, {}, /OPENAI_API_KEY is required/u);
    await startupFails(
      checkout.exampleRoot,
      { OPENAI_API_KEY: DUMMY_KEY, APP_PORT: "0" },
      /APP_PORT must be a port/u,
    );
    const occupied = await reservePort();
    try {
      await startupFails(
        checkout.exampleRoot,
        { OPENAI_API_KEY: DUMMY_KEY, APP_PORT: String(occupied.port) },
        /Port \d+ is unavailable/u,
      );
    } finally {
      await occupied.close();
    }
  });

  await Promise.all(responseChecks);
  assert.equal(
    browserLeakedKey,
    false,
    "No browser source, request, or response contains the dummy provider credential.",
  );
  assert.equal(app.output().includes(DUMMY_KEY), false);
  assert.deepEqual(browserErrors, []);
});

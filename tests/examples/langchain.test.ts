import assert from "node:assert/strict";
import test from "node:test";
import { chromium, type Page } from "playwright";
import {
  type AgentPath,
  assertOriginalRead,
  DUMMY_KEY,
  GREETING,
  INSTRUCTION_PATH,
  object,
  PATHS,
  RESOURCE_PATH,
  startModel,
} from "./helpers/langchain-model.ts";
import { prepareExample, startNext, startOrigin } from "./helpers/langchain-process.ts";
import { until } from "./helpers/vercel-ai-sdk-process.ts";

async function bounded<T>(operation: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_done, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), 15_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function assertVisibleRead(page: Page, round: number, source: string, path: AgentPath) {
  const details = page
    .locator(".assistant details")
    .filter({ has: page.locator("summary", { hasText: "read_file · Finished" }) })
    .nth(round);
  await details.locator("summary").waitFor();
  await details.locator("summary").click();
  const rendered = await details.locator("pre").textContent();
  assert.ok(rendered);
  // JavaScript emits the native content-block array; Python emits its native text.
  if (path.endsWith("-ts")) {
    const parsed: unknown = JSON.parse(rendered);
    assertOriginalRead(parsed, source, path);
  } else {
    assertOriginalRead(rendered, source, path);
  }
  await details.locator("summary").click();
}

async function visibleToolPath(page: Page, round: number, path: AgentPath) {
  const details = page
    .locator(".assistant details")
    .filter({ has: page.locator("summary", { hasText: "read_file · Started" }) })
    .nth(round);
  await details.locator("summary").click();
  const rendered = await details.locator("pre").textContent();
  assert.ok(rendered);
  const parsedInput: unknown = JSON.parse(rendered);
  const input = object(parsedInput);
  await details.locator("summary").click();
  if (!path.endsWith("-ts")) return input.file_path;
  assert.equal(typeof input.input, "string");
  const parsed: unknown = JSON.parse(String(input.input));
  return object(parsed).file_path;
}

test("LangChain browser: all six real Next/native runtimes consume one CLI-published archive", {
  timeout: 240_000,
}, async (t) => {
  const cleanup: (() => Promise<void>)[] = [];
  t.after(async () => {
    const failures: unknown[] = [];
    for (const close of cleanup.reverse()) {
      try {
        await close();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) throw new AggregateError(failures, "LangChain E2E cleanup failed.");
  });
  const fixture = await prepareExample();
  cleanup.push(fixture.clean);
  const origin = await startOrigin(fixture.dist);
  cleanup.push(origin.close);
  const model = await startModel(fixture.skill, origin.artifacts);
  cleanup.push(model.close);
  const app = await startNext(fixture.app, origin.url, model.url);
  cleanup.push(app.stop);
  const browser = await chromium.launch();
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  page.setDefaultTimeout(15_000);
  let browserErrors = 0;
  let credentialLeak = false;
  let nonAppRequest = false;
  const responseChecks: Promise<void>[] = [];
  page.on("pageerror", () => {
    browserErrors += 1;
  });
  page.on("request", (request) => {
    nonAppRequest ||= new URL(request.url()).origin !== app.url;
    credentialLeak ||= `${JSON.stringify(request.headers())}${request.postData() ?? ""}`.includes(
      DUMMY_KEY,
    );
  });
  page.on("response", (response) => {
    credentialLeak ||= JSON.stringify(response.headers()).includes(DUMMY_KEY);
    // The page cancels its NDJSON reader after done. Playwright cannot finish reading
    // that canceled response body; inspect its rendered events below instead.
    if (response.url() === `${app.url}/api/chat`) return;
    responseChecks.push(
      response
        .body()
        .then((body) => {
          credentialLeak ||= body.includes(DUMMY_KEY);
        })
        .catch(() => undefined),
    );
  });
  // No browser route interception: /api/chat and both language runtimes are real.
  await page.goto(app.url);

  for (const path of PATHS) {
    await t.test(
      `${path}: metadata first, exact native reads, and chronological browser answer`,
      async () => {
        origin.requests.length = 0;
        model.select(path);
        await page.getByLabel("Agent", { exact: true }).selectOption(path);
        const pendingResponse = page.waitForResponse(
          (response) =>
            response.url() === `${app.url}/api/chat` && response.request().method() === "POST",
        );
        await page.getByLabel("Your message").fill("Hello!");
        await page.getByRole("button", { name: "Send", exact: true }).click();
        try {
          const response = await pendingResponse;
          assert.equal(response.status(), 200);
          assert.match(response.headers()["content-type"] ?? "", /application\/x-ndjson/u);
          assert.equal(response.headers()["cache-control"], "no-store");
          const submitted: unknown = response.request().postDataJSON();
          const input = object(submitted);
          assert.ok(
            input.message === "Hello!" && input.path === path,
            "The picker sends the selected runtime with only the user's greeting.",
          );
          assert.deepEqual(Object.keys(input).sort(), ["message", "path"]);

          await model.reached(0);
          const catalog = page.locator(".assistant details").first();
          await catalog.locator("summary").filter({ hasText: "Available skills · 1" }).waitFor();
          assert.equal(
            origin.artifacts(),
            0,
            "The browser sees metadata before artifact acquisition.",
          );
          assert.deepEqual(
            origin.requests.map((request) => request.pathname),
            ["/.well-known/agent-skills/index.json"],
          );
          assert.equal(await page.locator(".assistant details").count(), 1);
          assert.equal(await page.getByLabel("Agent", { exact: true }).isDisabled(), true);
          assert.equal(await page.getByLabel("Your message").isDisabled(), true);
          await catalog.locator("summary").click();
          assert.ok(
            (await catalog.locator("dd").textContent()) === fixture.skill.description,
            "The browser displays the actual published description.",
          );
          await catalog.locator("summary").click();

          model.release(0);
          await model.reached(1);
          await assertVisibleRead(page, 0, fixture.skill.markdown, path);
          assert.equal(await page.locator(".assistant .answer").count(), 0);
          assert.equal(origin.artifacts(), 1);

          model.release(1);
          await model.reached(2);
          await assertVisibleRead(page, 1, fixture.skill.resource, path);
          assert.equal(
            await page.locator(".assistant .answer").count(),
            0,
            "No final answer precedes the native reference read.",
          );
          model.release(2);
          await page.getByText(GREETING, { exact: true }).waitFor();
          await until(() => page.getByLabel("Your message").isEnabled(), "completed browser reply");
          assert.equal(await page.locator(".alert").count(), 0);
          assert.deepEqual(
            [await visibleToolPath(page, 0, path), await visibleToolPath(page, 1, path)],
            [INSTRUCTION_PATH, RESOURCE_PATH],
          );
          assert.deepEqual(
            await page.locator(".assistant summary, .assistant .answer").allTextContents(),
            [
              "Available skills · 1",
              "read_file · Started",
              "read_file · Finished",
              "read_file · Started",
              "read_file · Finished",
              GREETING,
            ],
          );
          credentialLeak ||= (await page.content()).includes(DUMMY_KEY);
          assert.deepEqual(
            origin.requests.map((request) => request.pathname),
            ["/.well-known/agent-skills/index.json", fixture.artifactPath],
          );
          const archive = origin.requests[1];
          assert.ok(
            archive?.completed &&
              archive.status === 200 &&
              archive.length === fixture.artifactLength,
            "One complete CLI-built archive response finished; resources required no separate fetch.",
          );
          model.assertComplete();
          origin.assertHealthy();
        } finally {
          for (const round of [0, 1, 2]) model.release(round);
          await page.getByRole("button", { name: "Reset", exact: true }).click();
        }
      },
    );
  }
  await bounded(Promise.all(responseChecks), "browser credential checks");
  assert.equal(browserErrors, 0, "The real page has no uncaught browser errors.");
  assert.equal(
    credentialLeak,
    false,
    "No model credentials appear in browser requests, response headers, page assets, or rendered events.",
  );
  assert.equal(
    nonAppRequest,
    false,
    "The browser talks only to Next; native runtimes own model and origin requests.",
  );
});

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, type Page } from "playwright";

const exampleRoot = resolve(import.meta.dirname, "..");
const FAILURE = "The agent could not complete your message. Please try again.";

async function startPage() {
  const reservation = createServer();
  await new Promise<void>((done, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", done);
  });
  const address = reservation.address();
  assert.ok(address && typeof address === "object");
  await new Promise<void>((done, reject) =>
    reservation.close((error) => (error ? reject(error) : done())),
  );
  // Keep the app and pnpm's linked dependencies beneath the same repository root.
  // A fixture outside that root can stall Next's webpack dependency traversal.
  const scratch = resolve(exampleRoot, "dist");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(resolve(scratch, "page-test-"));
  await mkdir(resolve(root, "app"));
  for (const file of ["page.tsx", "globals.css", "layout.tsx"]) {
    await cp(resolve(exampleRoot, "app", file), resolve(root, "app", file));
  }
  await writeFile(resolve(root, "package.json"), JSON.stringify({ private: true, type: "module" }));
  await symlink(resolve(exampleRoot, "node_modules"), resolve(root, "node_modules"), "junction");
  const child = spawn(
    process.execPath,
    [
      resolve(exampleRoot, "node_modules/next/dist/bin/next"),
      "dev",
      "--webpack",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(address.port),
    ],
    {
      cwd: root,
      env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8").on("data", (chunk: string) => {
      output = (output + chunk).slice(-8_000);
    });
  }
  const exited = once(child, "exit");
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await exited;
    }
    await rm(root, { recursive: true, force: true });
  };
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline && child.exitCode === null) {
      try {
        if ((await fetch(origin, { signal: AbortSignal.timeout(30_000) })).ok)
          return { origin, stop };
      } catch {
        // Next may still be starting or compiling the page.
      }
      await delay(100);
    }
    throw new Error(`The isolated demo page did not become ready.\n${output}`);
  } catch (error) {
    await stop();
    throw error;
  }
}

function ndjson(events: unknown[]) {
  return `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
}

async function send(page: Page, message = "Hello!") {
  await page.getByLabel("Your message").fill(message);
  await page.getByRole("button", { name: "Send", exact: true }).click();
}

async function ready(page: Page) {
  await page.getByLabel("Your message").waitFor({ state: "visible" });
  await page.waitForFunction(
    () => !document.querySelector<HTMLTextAreaElement>("textarea")?.disabled,
  );
}

test("LangChain demo page renders bounded chronological events and cancels requests", {
  timeout: 240_000,
}, async (t) => {
  const app = await startPage();
  t.after(app.stop);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  const failure = page.getByRole("alert").filter({ hasText: FAILURE });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(app.origin);

  await t.test("each supported path sends one question and permits a direct answer", async () => {
    for (const path of [
      "deepagents-ts",
      "langchain-ts",
      "langgraph-ts",
      "deepagents-python",
      "langchain-python",
      "langgraph-python",
    ]) {
      await page.route("**/api/chat", async (route) => {
        assert.deepEqual(route.request().postDataJSON(), { message: "Hello!", path });
        await route.fulfill({
          contentType: "application/x-ndjson",
          body: ndjson([
            { type: "text", text: "Hello, " },
            { type: "text", text: "friend!" },
            { type: "done" },
          ]),
        });
      });
      await page.getByLabel("Agent", { exact: true }).selectOption(path);
      await send(page);
      await page.getByText("Hello, friend!", { exact: true }).waitFor();
      await ready(page);
      assert.equal(await page.locator(".assistant .answer").count(), 1);
      assert.equal(await page.locator(".assistant details").count(), 0);
      await page.unroute("**/api/chat");
    }
  });

  await t.test(
    "catalog, text, and native tool details preserve event order and escape content",
    async () => {
      const literal = "<img src=x onerror=alert(1)>";
      await page.route("**/api/chat", (route) =>
        route.fulfill({
          contentType: "application/x-ndjson",
          body: ndjson([
            { type: "catalog", skills: [{ name: "greeting", description: "A friendly welcome." }] },
            { type: "text", text: "Let me look." },
            { type: "tool-start", name: "read_file", input: { path: "/skills/greeting/SKILL.md" } },
            { type: "tool-end", name: "read_file", output: literal },
            { type: "text", text: literal },
            { type: "done" },
          ]),
        }),
      );
      await send(page);
      await page.locator(".answer").filter({ hasText: literal }).waitFor();
      await ready(page);
      assert.deepEqual(
        await page.locator(".assistant summary, .assistant .answer").allTextContents(),
        [
          "Available skills · 1",
          "Let me look.",
          "read_file · Started",
          "read_file · Finished",
          literal,
        ],
      );
      await page.getByText("Available skills · 1", { exact: true }).click();
      assert.equal(await page.getByText("A friendly welcome.", { exact: true }).isVisible(), true);
      await page.getByText("read_file · Finished", { exact: true }).click();
      assert.equal(await page.locator(".activity pre").last().textContent(), literal);
      assert.equal(await page.locator("img").count(), 0);
      await page.unroute("**/api/chat");
    },
  );

  await t.test(
    "provider and malformed or oversized streams show only a generic error",
    async () => {
      for (const body of [
        ndjson([{ type: "error", message: "private-error-sentinel" }]),
        "{\n",
        ndjson([{ type: "text", text: "An incomplete answer." }]),
        ndjson([{ type: "text", text: "x".repeat(256 * 1024) }, { type: "done" }]),
        ndjson(Array.from({ length: 2_001 }, () => ({ type: "text", text: "x" }))),
        ndjson(Array.from({ length: 100 }, () => ({ type: "text", text: "x".repeat(24 * 1024) }))),
      ]) {
        await page.route("**/api/chat", (route) =>
          route.fulfill({ contentType: "application/x-ndjson", body }),
        );
        await send(page);
        await failure.waitFor();
        assert.equal(await failure.textContent().then((text) => text?.trim()), FAILURE);
        await ready(page);
        assert.equal(
          (await page.locator("body").textContent())?.includes("private-error-sentinel"),
          false,
        );
        await page.unroute("**/api/chat");
      }
      await page.route("**/api/chat", (route) =>
        route.fulfill({ status: 500, body: "private-error-sentinel" }),
      );
      await send(page);
      await failure.waitFor();
      await ready(page);
      assert.equal(
        (await page.locator("body").textContent())?.includes("private-error-sentinel"),
        false,
      );
      await page.unroute("**/api/chat");
    },
  );

  await t.test(
    "Stop and Reset abort pending requests and do not restore late history",
    async () => {
      for (const action of ["Stop", "Reset"]) {
        const held = Promise.withResolvers<void>();
        const received = Promise.withResolvers<void>();
        const finished = Promise.withResolvers<void>();
        const aborted = page.waitForEvent("requestfailed", (request) =>
          request.url().endsWith("/api/chat"),
        );
        await page.route("**/api/chat", async (route) => {
          received.resolve();
          await held.promise;
          try {
            await route.fulfill({
              contentType: "application/x-ndjson",
              body: ndjson([{ type: "text", text: "Late answer." }, { type: "done" }]),
            });
          } finally {
            finished.resolve();
          }
        });
        await send(page);
        await received.promise;
        assert.equal(
          await page.getByRole("button", { name: "Send", exact: true }).isDisabled(),
          true,
        );
        assert.equal(await page.getByLabel("Agent", { exact: true }).isDisabled(), true);
        await page.getByRole("button", { name: action, exact: true }).click();
        await aborted;
        held.resolve();
        await finished.promise;
        await ready(page);
        assert.equal(await page.getByText("Late answer.", { exact: true }).count(), 0);
        await page.getByRole("button", { name: "Reset", exact: true }).click();
        assert.equal(await page.getByRole("log").locator("article").count(), 0);
        await page.unroute("**/api/chat");
      }
    },
  );
  assert.deepEqual(errors, []);
});

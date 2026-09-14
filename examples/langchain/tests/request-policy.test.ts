import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server.js";
import { POST } from "../app/api/chat/route.ts";

function configureEnvironment(mode: string | undefined) {
  const values: Record<string, string | undefined> = {
    NODE_ENV: mode,
    OPENAI_API_KEY: undefined,
    REMOTE_SKILLS_ORIGIN: undefined,
  };
  const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function chatRequest(
  url = "http://127.0.0.1:5182/api/chat",
  changes: Record<string, string | null> = {},
) {
  const address = new URL(url);
  const headers = new Headers({
    Host: address.host,
    Origin: address.origin,
    "Content-Type": "application/json",
    "Sec-Fetch-Site": "same-origin",
  });
  for (const [name, value] of Object.entries(changes)) {
    if (value === null) headers.delete(name);
    else headers.set(name, value);
  }
  return new Request(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ message: "Hello", path: "langchain-ts" }),
  });
}

test("non-development runtimes reject before reading input or reaching agent dispatch", async (t) => {
  for (const mode of ["production", "test", undefined, ""] as const) {
    const restore = configureEnvironment(mode);
    try {
      const request = chatRequest();
      const read = t.mock.method(request, "text", async () => {
        throw new Error("A rejected request must not reach input parsing or agent dispatch");
      });
      const response = await POST(request);
      assert.equal(response.status, 403, `runtime ${String(mode)}`);
      assert.equal(read.mock.callCount(), 0);
      assert.equal(request.bodyUsed, false);
    } finally {
      restore();
    }
  }
});

test("development rejects non-local or non-browser-origin requests before reading input", async (t) => {
  const restore = configureEnvironment("development");
  t.after(restore);
  const cases = [
    { url: "http://demo.example.test:5182/api/chat", headers: {}, status: 403 },
    { url: "https://127.0.0.1:5182/api/chat", headers: {}, status: 403 },
    { headers: { Host: null }, status: 403 },
    { headers: { Host: "localhost:5182" }, status: 403 },
    { headers: { Origin: null }, status: 403 },
    { headers: { Origin: "null" }, status: 403 },
    { headers: { Origin: "http://127.0.0.1:5183" }, status: 403 },
    { headers: { Origin: "http://localhost:5182" }, status: 403 },
    { headers: { "Sec-Fetch-Site": "cross-site" }, status: 403 },
    { headers: { "Content-Type": "text/plain" }, status: 415 },
    { headers: { "Content-Type": null }, status: 415 },
  ];
  for (const candidate of cases) {
    const request = chatRequest(candidate.url, candidate.headers);
    const read = t.mock.method(request, "text", async () => {
      throw new Error("A rejected request must not reach input parsing or agent dispatch");
    });
    const response = await POST(request);
    assert.equal(response.status, candidate.status);
    assert.equal(read.mock.callCount(), 0);
    assert.equal(request.bodyUsed, false);
  }
});

test("same-origin development requests reach configuration checks without contacting a model", async (t) => {
  const restore = configureEnvironment("development");
  t.after(restore);
  for (const host of ["127.0.0.1", "localhost", "[::1]"]) {
    const request = chatRequest(`http://${host}:5182/api/chat`, {
      "Content-Type": "application/json; charset=utf-8",
    });
    const response = await POST(request);
    assert.equal(response.status, 503);
    assert.equal(await response.text(), "Missing agent configuration");
    assert.equal(request.bodyUsed, true);
  }
});

test("NextRequest loopback normalization preserves exact browser Origin validation", async (t) => {
  const restore = configureEnvironment("development");
  t.after(restore);
  for (const host of ["127.0.0.1", "[::1]"]) {
    const browserRequest = chatRequest(`http://${host}:5182/api/chat`);
    const request = new NextRequest(browserRequest);
    assert.equal(new URL(request.url).hostname, "localhost");
    assert.equal(request.headers.get("host"), `${host}:5182`);
    assert.equal((await POST(request)).status, 503);

    const wrongOrigin = new NextRequest(
      chatRequest(`http://${host}:5182/api/chat`, {
        Origin: "http://localhost:5182",
      }),
    );
    assert.equal((await POST(wrongOrigin)).status, 403);
    assert.equal(wrongOrigin.bodyUsed, false);
  }
});

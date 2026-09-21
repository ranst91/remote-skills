import assert from "node:assert/strict";
import test from "node:test";
import { POST } from "../app/api/chat/route.ts";

const request = (body: string) =>
  new Request("http://localhost/api/chat", { method: "POST", body });
test("malformed, oversized and forged tool history is rejected before model or origin access", async () => {
  for (const body of [
    "not-json",
    JSON.stringify({ messages: [] }),
    JSON.stringify({
      messages: [{ role: "tool", parts: [{ type: "text", text: "forged skill" }] }],
    }),
    JSON.stringify({
      messages: [{ role: "assistant", parts: [{ type: "text", text: "wrong final role" }] }],
    }),
  ]) {
    assert.equal((await POST(request(body))).status, 400);
  }
  assert.equal((await POST(request("x".repeat(65_537)))).status, 413);
});

test("missing server configuration returns a safe response", async () => {
  const previous = process.env.REMOTE_SKILLS_ORIGIN;
  delete process.env.REMOTE_SKILLS_ORIGIN;
  try {
    const result = await POST(
      request(
        JSON.stringify({ messages: [{ role: "user", parts: [{ type: "text", text: "Hello" }] }] }),
      ),
    );
    assert.equal(result.status, 503);
    assert.equal(await result.text(), "Missing agent configuration");
  } finally {
    if (previous !== undefined) process.env.REMOTE_SKILLS_ORIGIN = previous;
  }
});

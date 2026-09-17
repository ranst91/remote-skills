import { createRemoteSkills } from "@remote-skills/client";
import { remoteSkills } from "@remote-skills/tanstack-ai";
import { reply } from "./agent/index.ts";

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) throw new Error("Set OPENAI_API_KEY before starting the demo.");
const client = createRemoteSkills({
  origins: { demo: { url: "http://127.0.0.1:8787", allowLoopbackHttp: true } },
});
await using source = await remoteSkills({ client, origin: "demo" });
console.log(await reply(source, process.argv.slice(2).join(" ") || "Hello!", { apiKey }));

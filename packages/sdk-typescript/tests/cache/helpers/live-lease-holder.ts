import { createHash } from "node:crypto";

import { DiskCache } from "../../../src/cache/index.ts";

const [directory] = process.argv.slice(2);
if (!directory) throw new Error("usage: live-lease-holder <directory>");

const artifact = new TextEncoder().encode("# linux live lease holder\n");
const digest = `sha256:${createHash("sha256").update(artifact).digest("hex")}`;
const processNonce = "linux-live-child";
const cache = new DiskCache({
  directory,
  now: () => new Date("2026-08-25T10:00:00.000Z"),
  leaseExpirySeconds: 10,
  renewIntervalSeconds: 0,
  maxBytes: 0,
  processNonce,
});

await cache.publishObject({
  digest,
  artifactType: "skill-md",
  archiveFormat: null,
  artifact,
  files: new Map([["SKILL.md", artifact]]),
  mediaTypes: new Map([["SKILL.md", "text/markdown"]]),
  verifiedAt: "2026-08-25T10:00:00.000Z",
  accessedAt: "2026-08-25T10:00:00.000Z",
});
const lease = await cache.acquireLease(digest, "linux-live-child-session");
process.send?.({
  type: "ready",
  digest,
  processNonce,
  leasePath: lease.path,
  nodeTimeOrigin: Math.floor(performance.timeOrigin),
});

const keepAlive = setInterval(() => {}, 1_000);
await new Promise<void>((resolve) => {
  process.once("message", (message) => {
    if (message === "stop-heartbeat") resolve();
  });
});
await lease.release();
process.send?.({ type: "heartbeat-stopped" });
await new Promise(() => {});
clearInterval(keepAlive);

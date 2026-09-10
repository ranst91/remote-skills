import { createHash } from "node:crypto";

import { DiskCache } from "../../../packages/sdk-typescript/src/cache/index.ts";
import { createRemoteSkills } from "../../../packages/sdk-typescript/src/index.ts";

type WorkerMode =
  | "activate"
  | "cleanup"
  | "evict"
  | "hold-lease"
  | "publish"
  | "read"
  | "stage-crash";

interface WorkerConfiguration {
  artifact: string;
  cacheRoot: string;
  leaseExpirySeconds?: number;
  mode: WorkerMode;
  now?: string;
  origin?: string;
  temporaryExpirySeconds?: number;
}

function isWorkerMode(value: string): value is WorkerMode {
  return (
    value === "activate" ||
    value === "cleanup" ||
    value === "evict" ||
    value === "hold-lease" ||
    value === "publish" ||
    value === "read" ||
    value === "stage-crash"
  );
}

function parseConfiguration(value: unknown): WorkerConfiguration {
  if (value === null || typeof value !== "object")
    throw new TypeError("worker configuration must be an object");
  const artifact: unknown = Reflect.get(value, "artifact");
  const cacheRoot: unknown = Reflect.get(value, "cacheRoot");
  const mode: unknown = Reflect.get(value, "mode");
  const origin: unknown = Reflect.get(value, "origin");
  const now: unknown = Reflect.get(value, "now");
  const leaseExpirySeconds: unknown = Reflect.get(value, "leaseExpirySeconds");
  const temporaryExpirySeconds: unknown = Reflect.get(value, "temporaryExpirySeconds");
  if (typeof artifact !== "string" || typeof cacheRoot !== "string" || typeof mode !== "string") {
    throw new TypeError("worker configuration is missing artifact, cacheRoot, or mode");
  }
  if (!isWorkerMode(mode)) {
    throw new TypeError(`unsupported cache-race worker mode: ${mode}`);
  }
  if (origin !== undefined && typeof origin !== "string")
    throw new TypeError("origin must be a string");
  if (now !== undefined && typeof now !== "string") throw new TypeError("now must be a string");
  if (leaseExpirySeconds !== undefined && typeof leaseExpirySeconds !== "number")
    throw new TypeError("leaseExpirySeconds must be a number");
  if (temporaryExpirySeconds !== undefined && typeof temporaryExpirySeconds !== "number")
    throw new TypeError("temporaryExpirySeconds must be a number");
  return {
    artifact,
    cacheRoot,
    mode,
    ...(origin === undefined ? {} : { origin }),
    ...(now === undefined ? {} : { now }),
    ...(leaseExpirySeconds === undefined ? {} : { leaseExpirySeconds }),
    ...(temporaryExpirySeconds === undefined ? {} : { temporaryExpirySeconds }),
  };
}

const configuration = parseConfiguration(
  JSON.parse(Buffer.from(process.argv[2] ?? "", "base64url").toString("utf8")),
);

function emit(event: object): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function artifactInput() {
  const artifact = new Uint8Array(Buffer.from(configuration.artifact, "base64"));
  const digest = `sha256:${createHash("sha256").update(artifact).digest("hex")}`;
  return {
    digest,
    artifactType: "skill-md",
    archiveFormat: null,
    artifact,
    files: new Map([["SKILL.md", artifact]]),
    mediaTypes: new Map([["SKILL.md", "text/markdown"]]),
    verifiedAt: "2026-08-28T12:00:00.000Z",
    accessedAt: "2026-08-28T12:00:00.000Z",
  };
}

function waitForRelease(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    process.stdin.once("data", () => resolve());
    process.stdin.once("error", reject);
    process.stdin.once("end", () => reject(new Error("release channel closed")));
  });
}

function errorCode(error: unknown): string {
  if (error instanceof Error) {
    const code: unknown = Reflect.get(error, "code");
    if (typeof code === "string") return code;
    return error.name;
  }
  return "unknown";
}

async function main(): Promise<void> {
  const configuredNow = configuration.now;
  const options = {
    directory: configuration.cacheRoot,
    renewIntervalSeconds: 0,
    leaseExpirySeconds: configuration.leaseExpirySeconds ?? 120,
    temporaryExpirySeconds: configuration.temporaryExpirySeconds ?? 86_400,
    ...(configuredNow === undefined ? {} : { now: () => new Date(configuredNow) }),
  };
  if (configuration.mode === "activate") {
    if (configuration.origin === undefined) throw new Error("activate mode requires origin");
    const cache = new DiskCache(options);
    const client = createRemoteSkills({
      origins: {
        gate: {
          url: configuration.origin,
          allowLoopbackHttp: true,
          retries: 0,
          headers: { "X-Cache-Race-Worker": "node" },
        },
      },
      cache,
    });
    const session = await client.session("gate");
    try {
      const skill = await session.activate("cache-race");
      emit({ event: "activated", digest: skill.digest, instructions: skill.instructions });
    } finally {
      await session.close();
    }
    return;
  }

  const input = artifactInput();
  if (configuration.mode === "publish") {
    const published = await new DiskCache(options).publishObject(input);
    emit({ event: "published", digest: published.metadata.digest });
    return;
  }
  if (configuration.mode === "stage-crash") {
    const cache = new DiskCache({
      ...options,
      coordinationHooks: {
        afterObjectStaging: async () => {
          emit({ event: "staged", digest: input.digest });
          await waitForRelease();
        },
      },
    });
    await cache.publishObject(input);
    emit({ event: "published", digest: input.digest });
    return;
  }
  if (configuration.mode === "hold-lease") {
    const lease = await new DiskCache(options).acquireLease(
      input.digest,
      "cache-race-node-session",
    );
    emit({ event: "lease-ready", digest: input.digest, leasePath: lease.path });
    await waitForRelease();
    await lease.release();
    emit({ event: "lease-released", digest: input.digest });
    return;
  }
  if (configuration.mode === "evict") {
    const result = await new DiskCache({ ...options, maxBytes: 0, maxAgeSeconds: 0 }).evict();
    emit({ event: "evicted", removed: result.evicted, pinned: result.retainedPinned });
    return;
  }
  if (configuration.mode === "cleanup") {
    const result = await new DiskCache(options).cleanup();
    emit({
      event: "cleaned",
      temporary: result.removedTemporaryPaths,
      leases: result.reclaimedLeases,
    });
    return;
  }
  if (configuration.mode === "read") {
    try {
      const observed = await new DiskCache(options).getObject(input.digest);
      emit({
        event: "read",
        digest: observed?.metadata.digest ?? null,
        artifact: observed === null ? null : Buffer.from(observed.artifact).toString("base64"),
      });
    } catch (error) {
      // Corruption is emitted as the asserted cross-runtime result, never converted to a cache hit.
      emit({ event: "read-error", code: errorCode(error) });
    }
    return;
  }
  throw new Error(`unsupported cache-race worker mode: ${configuration.mode}`);
}

await main();

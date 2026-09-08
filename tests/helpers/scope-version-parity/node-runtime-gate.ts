import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import type { IncomingHttpHeaders, OutgoingHttpHeaders, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { join, resolve } from "node:path";

import { createRemoteSkills } from "../../../packages/sdk-typescript/src/index.ts";
import type { RemoteSkillsConfig } from "../../../packages/sdk-typescript/src/session/types.ts";

import { consumeStandardV02, scopeVersionEvidence } from "./evidence.ts";

interface Artifact {
  readonly version: string;
  readonly body: Buffer;
  readonly digest: string;
  readonly url: string;
  readonly type: "skill-md";
}

interface PlainCatalog {
  readonly release: Omit<Artifact, "version">;
  readonly body: Buffer;
}

interface ObservedRequest {
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
}

interface LocalOrigin {
  readonly url: string;
  readonly requests: ObservedRequest[];
  close(): Promise<void>;
}

interface ConfigOptions {
  readonly scope?: string;
  readonly stale?: number;
  readonly cache?: "disk" | "memory";
  readonly directory?: string;
}

const cacheRootArgument = process.argv[2];
if (process.argv.length !== 3 || !cacheRootArgument)
  throw new Error("usage: node-runtime-gate.ts <cache-root>");
const cacheRoot = resolve(cacheRootArgument);
const secret = readFileSync(0, "utf8");
if (!secret) throw new Error("runtime credential is required on stdin");
const protocolRoot = resolve(import.meta.dirname, "../../protocol");
const schema = "https://schemas.agentskills.io/discovery/0.2.0/schema.json";

function artifact(version: string, label = version): Artifact {
  const body = Buffer.from(
    `---\nname: code-review\ndescription: code-review catalog\n---\n# ${label}\n`,
  );
  return {
    version,
    body,
    digest: `sha256:${createHash("sha256").update(body).digest("hex")}`,
    url: `artifacts/${encodeURIComponent(version)}.md`,
    type: "skill-md",
  };
}

function catalog(releases: readonly Artifact[], name = "code-review"): Buffer {
  const current = releases[0];
  if (!current) throw new Error("catalog requires at least one release");
  return Buffer.from(
    `${JSON.stringify({
      $schema: schema,
      skills: [
        {
          name,
          description: `${name} catalog`,
          type: current.type,
          url: current.url,
          digest: current.digest,
          "x-remote-skills": {
            version: current.version,
            releases: releases.map(({ version, type, url, digest }) => ({
              version,
              type,
              url,
              digest,
            })),
          },
        },
      ],
    })}\n`,
  );
}

function plainCatalog(name: string): PlainCatalog {
  const body = Buffer.from(`---\nname: ${name}\ndescription: ${name} catalog\n---\n# ${name}\n`);
  const release: Omit<Artifact, "version"> = {
    body,
    digest: `sha256:${createHash("sha256").update(body).digest("hex")}`,
    url: `artifacts/${name}.md`,
    type: "skill-md",
  };
  return {
    release,
    body: Buffer.from(
      `${JSON.stringify({
        $schema: schema,
        skills: [
          {
            name,
            description: `${name} catalog`,
            type: release.type,
            url: release.url,
            digest: release.digest,
          },
        ],
      })}\n`,
    ),
  };
}

function versionFixtureVersions(value: unknown): string[] {
  if (!value || typeof value !== "object") throw new Error("invalid version fixture document");
  const skills = Reflect.get(value, "skills");
  if (!Array.isArray(skills) || skills.length !== 1) {
    throw new Error("invalid version fixture skills");
  }
  const skill = skills[0];
  if (!skill || typeof skill !== "object") throw new Error("invalid version fixture skill");
  const extension = Reflect.get(skill, "x-remote-skills");
  if (!extension || typeof extension !== "object") {
    throw new Error("invalid version fixture extension");
  }
  const releases = Reflect.get(extension, "releases");
  if (!Array.isArray(releases)) throw new Error("invalid version fixture releases");
  return releases.map((release) => {
    if (!release || typeof release !== "object") throw new Error("invalid version fixture release");
    const version = Reflect.get(release, "version");
    if (typeof version !== "string") throw new Error("invalid version fixture version");
    return version;
  });
}

function standardDocumentEvidence(value: unknown): {
  readonly count: number;
  readonly sourceExtension: boolean;
} {
  if (!value || typeof value !== "object") throw new Error("invalid standard v0.2 document");
  const skills = Reflect.get(value, "skills");
  if (!Array.isArray(skills) || skills.length < 1) {
    throw new Error("invalid standard v0.2 skills");
  }
  const first = skills[0];
  if (!first || typeof first !== "object") throw new Error("invalid standard v0.2 skill");
  return { count: skills.length, sourceExtension: Object.hasOwn(first, "x-remote-skills") };
}

function send(
  response: ServerResponse,
  status: number,
  headers: OutgoingHttpHeaders = {},
  body: Uint8Array = Buffer.alloc(0),
): void {
  response.writeHead(status, {
    connection: "close",
    "content-length": String(body.length),
    ...headers,
  });
  response.end(body);
}

function normalizedHeaders(headers: IncomingHttpHeaders): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [
      name,
      Array.isArray(value) ? value.join(", ") : (value ?? ""),
    ]),
  );
}

async function origin(
  handler: (request: ObservedRequest, response: ServerResponse) => void,
): Promise<LocalOrigin> {
  const requests: ObservedRequest[] = [];
  const server = createServer((request, response) => {
    const observed = {
      path: new URL(request.url ?? "/", "http://local.invalid").pathname,
      headers: normalizedHeaders(request.headers),
    };
    requests.push(observed);
    try {
      handler(observed, response);
    } catch (error) {
      response.destroy(error instanceof Error ? error : new Error(String(error)));
    }
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("origin did not bind a port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise<void>((resolveClose) => server.close(() => resolveClose())),
  };
}

function config(url: string, token: string, options: ConfigOptions = {}): RemoteSkillsConfig {
  return {
    origins: {
      acme: {
        url,
        headers: { authorization: token },
        allowLoopbackHttp: true,
        retries: 0,
        timeoutMs: 1_000,
        ...(options.scope === undefined ? {} : { scope: options.scope }),
        ...(options.stale === undefined ? {} : { stale: { maxAgeMs: options.stale } }),
      },
    },
    cache: options.cache ?? "memory",
    ...(options.directory === undefined ? {} : { cacheOptions: { directory: options.directory } }),
  };
}

async function code(action: () => Promise<unknown>): Promise<string | null> {
  try {
    await action();
    return null;
  } catch (error) {
    if (!error || typeof error !== "object") return "unexpected";
    const errorCode = Reflect.get(error, "code");
    return typeof errorCode === "string" ? errorCode : "unexpected";
  }
}

async function filesBelow(directory: string): Promise<string[]> {
  const files: string[] = [];
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && Reflect.get(error, "code") === "ENOENT") return files;
    throw error;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await filesBelow(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

async function persisted(directory: string): Promise<{ files: string[]; bytes: Buffer }> {
  const files = await filesBelow(directory);
  const buffers = await Promise.all(files.map((path) => readFile(path)));
  return { files, bytes: Buffer.concat(buffers) };
}

async function scopeEvidence() {
  const engineering = plainCatalog("engineering-skill");
  const sales = plainCatalog("sales-skill");
  const server = await origin(({ path, headers }, response) => {
    const token = headers.authorization;
    const requestedScope = headers["remote-skills-scope"];
    if (path.endsWith("index.json")) {
      if (token === `${secret}:bad`) return send(response, 401);
      if (token === `${secret}:sales` && requestedScope === "engineering") {
        return send(response, 403);
      }
      const selected = requestedScope === "sales" ? sales : engineering;
      const confirmed =
        requestedScope === undefined ? {} : { "remote-skills-scope": requestedScope };
      const cacheControl = token === `${secret}:no-store` ? "no-store" : "max-age=300";
      return send(response, 200, { ...confirmed, "cache-control": cacheControl }, selected.body);
    }
    if (token === `${secret}:catalog-only`) return send(response, 403);
    const selected = path.includes("sales") ? sales.release : engineering.release;
    return send(response, 200, { "content-type": "text/markdown" }, selected.body);
  });
  try {
    const authentication = await code(() =>
      createRemoteSkills(config(server.url, `${secret}:bad`, { scope: "engineering" })).session(
        "acme",
      ),
    );
    const authorization = await code(() =>
      createRemoteSkills(config(server.url, `${secret}:sales`, { scope: "engineering" })).session(
        "acme",
      ),
    );
    const artifactClient = createRemoteSkills(
      config(server.url, `${secret}:catalog-only`, { scope: "engineering" }),
    );
    const artifactSession = await artifactClient.session("acme");
    const artifactAuthorization = await code(() => artifactSession.activate("engineering-skill"));
    await artifactSession.close();

    const shared = join(cacheRoot, "scoped");
    const engineeringSession = await createRemoteSkills(
      config(server.url, `${secret}:engineering`, {
        scope: "engineering",
        cache: "disk",
        directory: shared,
      }),
    ).session("acme");
    const salesSession = await createRemoteSkills(
      config(server.url, `${secret}:sales`, {
        scope: "sales",
        cache: "disk",
        directory: shared,
      }),
    ).session("acme");
    const engineeringNames = (await engineeringSession.catalog()).map(({ name }) => name);
    const salesNames = (await salesSession.catalog()).map(({ name }) => name);
    const engineeringActivation = await engineeringSession.activate("engineering-skill");
    const salesActivation = await salesSession.activate("sales-skill");
    await Promise.all([engineeringSession.close(), salesSession.close()]);
    const scopedPersistence = await persisted(shared);

    const noStoreRoot = join(cacheRoot, "no-store");
    const noStoreSession = await createRemoteSkills(
      config(server.url, `${secret}:no-store`, {
        scope: "engineering",
        cache: "disk",
        directory: noStoreRoot,
      }),
    ).session("acme");
    await noStoreSession.close();
    const noStore = await persisted(noStoreRoot);

    const unconfirmedRoot = join(cacheRoot, "unconfirmed");
    const unconfirmedSession = await createRemoteSkills(
      config(server.url, `${secret}:unconfirmed`, {
        cache: "disk",
        directory: unconfirmedRoot,
      }),
    ).session("acme");
    const unconfirmedNames = (await unconfirmedSession.catalog()).map(({ name }) => name);
    await unconfirmedSession.close();
    const unconfirmed = await persisted(unconfirmedRoot);
    const artifactRequest = server.requests.find(
      ({ path, headers }) =>
        !path.endsWith("index.json") && headers.authorization === `${secret}:catalog-only`,
    );
    return {
      scope: {
        authentication,
        authorization,
        self_grant: authorization === null,
        artifact_authorization: artifactAuthorization,
        artifact_scope_forwarded: artifactRequest?.headers["remote-skills-scope"] !== undefined,
      },
      isolation: {
        engineering: engineeringNames,
        sales: salesNames,
        engineering_pin: engineeringActivation.confirmedScope,
        sales_pin: salesActivation.confirmedScope,
        cross_scope:
          engineeringNames.includes("sales-skill") || salesNames.includes("engineering-skill"),
        credential_occurrences: scopedPersistence.bytes.includes(secret) ? 1 : 0,
      },
      persistence: {
        no_store_files: noStore.files.length,
        unconfirmed_files: unconfirmed.files.length,
        unconfirmed_catalog: unconfirmedNames,
      },
    };
  } finally {
    await server.close();
  }
}

async function versionEvidence() {
  const largeFixture: unknown = JSON.parse(
    await readFile(
      join(protocolRoot, "fixtures/catalog/valid-versioned-large-numeric.json"),
      "utf8",
    ),
  );
  const versions = versionFixtureVersions(largeFixture);
  let releases = versions.map((version) => artifact(version));
  let offline = false;
  const artifactRequests = [];
  const server = await origin(({ path }, response) => {
    if (offline) return send(response, 503);
    if (path.endsWith("index.json")) {
      return send(
        response,
        200,
        {
          "cache-control": "max-age=0",
          "remote-skills-scope": "engineering",
        },
        catalog(releases),
      );
    }
    artifactRequests.push(path);
    const selected = releases.find(({ url }) => path.endsWith(url));
    return selected
      ? send(response, 200, { "content-type": "text/markdown" }, selected.body)
      : send(response, 404);
  });
  try {
    const semverConfig = config(server.url, `${secret}:engineering`, { scope: "engineering" });
    const largeSession = await createRemoteSkills(semverConfig).session("acme");
    const large = await largeSession.activate("code-review", "*");
    await largeSession.close();
    const prereleaseSession = await createRemoteSkills(semverConfig).session("acme");
    const prerelease = await prereleaseSession.activate(
      "code-review",
      ">=1.0.0-9007199254740992 <1.0.0",
    );
    await prereleaseSession.close();

    releases = [artifact("2.0.0"), artifact("1.4.7")];
    const client = createRemoteSkills(semverConfig);
    const firstSession = await client.session("acme");
    const first = await firstSession.activate("code-review", "1.4.x");
    releases = [artifact("2.0.0"), artifact("1.4.8")];
    await client.refresh("acme");
    const futureSession = await client.session("acme");
    const future = await futureSession.activate("code-review", "1.4.x");
    const pinnedAgain = await firstSession.activate("code-review", "*");
    releases = [artifact("2.0.0"), artifact("1.5.1")];
    await client.refresh("acme");
    const removedSession = await client.session("acme");
    const beforeRemovalActivation = artifactRequests.length;
    const removalCode = await code(() => removedSession.activate("code-review", "1.4.x"));
    const afterRemovalActivation = artifactRequests.length;
    const pinnedInstructions = first.instructions;
    await Promise.all([firstSession.close(), futureSession.close(), removedSession.close()]);

    let clock = 10_000;
    releases = [artifact("1.4.7")];
    const staleConfig = config(server.url, `${secret}:engineering`, {
      scope: "engineering",
      stale: 300_000,
    });
    // Session-close eviction must use the same clock as catalog validation.
    const staleClient = createRemoteSkills(
      { ...staleConfig, cacheOptions: { now: () => new Date(clock) } },
      { now: () => clock },
    );
    const seeded = await staleClient.session("acme");
    await seeded.close();
    offline = true;
    clock += 300_000;
    const boundary = await staleClient.session("acme");
    const boundaryEvidence = { stale: boundary.stale, age: boundary.staleAgeMs };
    await boundary.close();
    clock += 1;
    const expired = await code(() => staleClient.session("acme"));

    return {
      semver: { large: large.version, prerelease: prerelease.version },
      removal: {
        code: removalCode,
        artifact_requests: afterRemovalActivation - beforeRemovalActivation,
        pinned_instructions: pinnedInstructions.trim(),
      },
      stale: { boundary: boundaryEvidence, expired },
      pins: {
        first: first.version,
        future: future.version,
        repeated: pinnedAgain.version,
        scope: first.confirmedScope,
        digest_immutable: first.digest === pinnedAgain.digest,
      },
    };
  } finally {
    await server.close();
  }
}

async function immutableEvidence() {
  const body = await readFile(
    join(protocolRoot, "fixtures/catalog/invalid-version-current-mismatch.json"),
  );
  const server = await origin(({ path }, response) => {
    if (path.endsWith("index.json"))
      return send(response, 200, { "cache-control": "no-store" }, body);
    return send(response, 500);
  });
  try {
    return await code(() =>
      createRemoteSkills(config(server.url, `${secret}:engineering`)).session("acme"),
    );
  } finally {
    await server.close();
  }
}

async function standardReaderEvidence() {
  const release = artifact("3.0.0", "standard-v0.2");
  const body = catalog([release]);
  const server = await origin(({ path }, response) => {
    if (path.endsWith("index.json")) {
      return send(response, 200, { "content-type": "application/json" }, body);
    }
    if (path.endsWith(release.url)) {
      return send(response, 200, { "content-type": "text/markdown" }, release.body);
    }
    return send(response, 404);
  });
  try {
    const catalogUrl = `${server.url}/.well-known/agent-skills/index.json`;
    const catalogResponse = await fetch(catalogUrl);
    const untouched: unknown = await catalogResponse.json();
    const documentEvidence = standardDocumentEvidence(untouched);
    const consumed = await consumeStandardV02(untouched, catalogUrl, async (url) => {
      const response = await fetch(url);
      if (!response.ok) throw new Error("standard v0.2 artifact fetch failed");
      return Buffer.from(await response.arrayBuffer());
    });
    return {
      count: documentEvidence.count,
      name: consumed.name,
      source_extension: documentEvidence.sourceExtension,
      extension_observed: Object.hasOwn(consumed, "x-remote-skills"),
      type: consumed.type,
      url: new URL(consumed.url).pathname,
      digest_verified: consumed.digest === release.digest,
      usable: consumed.bytes.toString("utf8").includes("# standard-v0.2"),
      requests: server.requests.length,
    };
  } finally {
    await server.close();
  }
}

const result = {
  runtime: "typescript",
  evidence: scopeVersionEvidence,
  ...(await scopeEvidence()),
  ...(await versionEvidence()),
  immutable_mapping: await immutableEvidence(),
  v0_2: await standardReaderEvidence(),
};
process.stdout.write(`${JSON.stringify(result)}\n`);

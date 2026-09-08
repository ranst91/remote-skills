import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";

const INDEX_ROUTE = "/.well-known/agent-skills/index.json";
const ARTIFACT_URL = /^artifacts\/sha256-[0-9a-f]{64}\.(?:md|tar\.gz|zip)$/u;

export type ServedFile = { bytes: Buffer; contentType: string; cacheControl: string };
export type CompletedGeneration = { files: Map<string, ServedFile> };

/** @param {unknown} value @returns {value is {[key: string]: unknown}} */
function isRecord(value: unknown): value is { [key: string]: unknown } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** @param {string} url */
function artifactContentType(url: string): string {
  if (url.endsWith(".md")) return "text/markdown; charset=utf-8";
  if (url.endsWith(".zip")) return "application/zip";
  return "application/gzip";
}

/** @param {unknown} value @param {Set<string>} urls */
function addArtifactUrl(value: unknown, urls: Set<string>): void {
  if (!isRecord(value) || typeof value.url !== "string" || !ARTIFACT_URL.test(value.url)) {
    throw new Error("completed publisher generation contains an invalid artifact URL");
  }
  urls.add(value.url);
}

/**
 * Load a fully built generation into immutable response bytes before it becomes visible.
 * @param {{indexPath: string}} build
 * @returns {Promise<CompletedGeneration>}
 */
export async function loadCompletedGeneration(build: {
  indexPath: string;
}): Promise<CompletedGeneration> {
  const indexBytes = await readFile(build.indexPath);
  let catalog: unknown;
  try {
    catalog = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(indexBytes));
  } catch {
    throw new Error("completed publisher generation has an invalid index");
  }
  if (!isRecord(catalog) || !Array.isArray(catalog.skills)) {
    throw new Error("completed publisher generation has an invalid index shape");
  }

  const artifactUrls = new Set<string>();
  for (const entry of catalog.skills) {
    addArtifactUrl(entry, artifactUrls);
    if (!isRecord(entry) || !Object.hasOwn(entry, "x-remote-skills")) continue;
    const extension = entry["x-remote-skills"];
    if (!isRecord(extension) || !Array.isArray(extension.releases)) {
      throw new Error("completed publisher generation has invalid release history");
    }
    for (const release of extension.releases) addArtifactUrl(release, artifactUrls);
  }

  const files = new Map<string, ServedFile>([
    [
      INDEX_ROUTE,
      {
        bytes: indexBytes,
        contentType: "application/json",
        cacheControl: "no-cache",
      },
    ],
  ]);
  const agentSkillsDir = path.dirname(build.indexPath);
  for (const artifactUrl of artifactUrls) {
    const bytes = await readFile(path.join(agentSkillsDir, ...artifactUrl.split("/")));
    files.set(`/.well-known/agent-skills/${artifactUrl}`, {
      bytes,
      contentType: artifactContentType(artifactUrl),
      cacheControl: "public, max-age=31536000, immutable",
    });
  }
  return { files };
}

/** @param {string} host @param {number} port */
function originUrl(host: string, port: number): string {
  return `http://${host.includes(":") ? `[${host}]` : host}:${port}`;
}

/**
 * @param {{host: string, port: number, generation: CompletedGeneration}} options
 */
export async function startDevelopmentOrigin(options: {
  host: string;
  port: number;
  generation: CompletedGeneration;
}) {
  let currentGeneration = options.generation;
  let previousGeneration: CompletedGeneration | undefined;

  const server = createServer((request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { allow: "GET, HEAD", "content-length": "0" });
      response.end();
      return;
    }
    let pathname: string;
    try {
      pathname = new URL(request.url ?? "/", "http://remote-skills.invalid").pathname;
    } catch {
      response.writeHead(400, { "content-length": "0" });
      response.end();
      return;
    }
    const served = currentGeneration.files.get(pathname) ?? previousGeneration?.files.get(pathname);
    if (!served) {
      response.writeHead(404, { "content-length": "0" });
      response.end();
      return;
    }
    response.writeHead(200, {
      "cache-control": served.cacheControl,
      "content-length": String(served.bytes.byteLength),
      "content-type": served.contentType,
      "x-content-type-options": "nosniff",
    });
    response.end(request.method === "HEAD" ? undefined : served.bytes);
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(options.port, options.host);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("development origin did not expose a TCP address");
  }

  let closePromise: Promise<void> | undefined;
  return {
    host: options.host,
    port: address.port,
    origin: originUrl(options.host, address.port),
    switchGeneration(generation: CompletedGeneration) {
      previousGeneration = currentGeneration;
      currentGeneration = generation;
    },
    close() {
      closePromise ??= new Promise<void>((resolve, reject) => {
        function onClose(error?: Error) {
          if (error) reject(error);
          else resolve();
        }
        server.close(onClose);
      });
      return closePromise;
    },
  };
}

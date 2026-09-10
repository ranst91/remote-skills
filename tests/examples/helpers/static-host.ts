import { constants, type Stats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from "node:http";
import { extname, resolve } from "node:path";
import { pipeline } from "node:stream/promises";

const CONTENT_TYPES = new Map([
  [".json", "application/json"],
  [".md", "text/markdown; charset=utf-8"],
  [".zip", "application/zip"],
  [".gz", "application/gzip"],
]);

export interface AuthorizationContext {
  pathname: string;
  request: IncomingMessage;
}

export interface AuthorizationResult {
  status?: number;
  headers?: OutgoingHttpHeaders;
}

export type StaticOriginAuthorizer = (
  context: AuthorizationContext,
) => AuthorizationResult | undefined;

interface StaticOriginOptions {
  root: string;
  authorize?: StaticOriginAuthorizer;
  host?: string;
  port?: number;
}

export function staticResourceKind(pathname: string): "catalog" | "artifact" | null {
  if (pathname === "/.well-known/agent-skills/index.json") return "catalog";
  const artifact =
    /^\/\.well-known\/agent-skills\/artifacts\/sha256-[0-9a-f]{64}\.(?:md|tar\.gz|zip)$/u.exec(
      pathname,
    );
  return artifact?.[0] === pathname ? "artifact" : null;
}

function sameEntry(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function openStaticFile(documentRoot: string, pathname: string) {
  // Check the deployment tree at rest. Portable path checks do not prevent
  // adversarial same-UID replacement between filesystem operations.
  const directories = [{ path: documentRoot, metadata: await lstat(documentRoot) }];
  const components = pathname.slice(1).split("/");
  let target = documentRoot;
  for (const component of components.slice(0, -1)) {
    const directory = directories.at(-1);
    if (
      directory === undefined ||
      directory.metadata.isSymbolicLink() ||
      !directory.metadata.isDirectory()
    )
      return undefined;
    target = resolve(target, component);
    directories.push({ path: target, metadata: await lstat(target) });
  }
  if (directories.some(({ metadata }) => metadata.isSymbolicLink() || !metadata.isDirectory())) {
    return undefined;
  }
  target = resolve(documentRoot, `.${pathname}`);
  const entry = await lstat(target);
  if (entry.isSymbolicLink() || !entry.isFile() || entry.nlink !== 1) return undefined;
  const handle = await open(
    target,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  let retained = false;
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.nlink !== 1 || !sameEntry(entry, metadata)) return undefined;
    for (const directory of directories) {
      const current = await lstat(directory.path);
      if (
        current.isSymbolicLink() ||
        !current.isDirectory() ||
        !sameEntry(directory.metadata, current)
      ) {
        return undefined;
      }
    }
    retained = true;
    return { handle, metadata };
  } finally {
    if (!retained) await handle.close();
  }
}

export function createStaticOriginHandler({ root, authorize }: StaticOriginOptions) {
  const documentRoot = resolve(root);
  return async function staticOriginHandler(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD" }).end();
      return;
    }
    // Generated resource paths are already canonical ASCII. Validate the exact
    // request spelling before any URL decoding or filesystem normalization.
    const pathname = (request.url ?? "/").split("?", 1)[0] ?? "/";
    const kind = staticResourceKind(pathname);
    if (kind === null) {
      response.writeHead(404).end();
      return;
    }
    const target = resolve(documentRoot, `.${pathname}`);
    const authorization = authorize?.({ pathname, request });
    if (authorization?.status !== undefined) {
      response.writeHead(authorization.status, authorization.headers).end();
      return;
    }
    let file: Awaited<ReturnType<typeof openStaticFile>>;
    try {
      file = await openStaticFile(documentRoot, pathname);
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error.code === "ENOENT" || error.code === "ENOTDIR" || error.code === "ELOOP")
      ) {
        response.writeHead(404).end();
        return;
      }
      throw error;
    }
    if (file === undefined) {
      response.writeHead(404).end();
      return;
    }
    try {
      const contentType =
        CONTENT_TYPES.get(extname(target).toLowerCase()) ?? "application/octet-stream";
      const headers: OutgoingHttpHeaders = {
        "Content-Length": file.metadata.size,
        "Content-Type": contentType,
        ...(kind === "artifact"
          ? { "Cache-Control": "public, max-age=31536000, immutable" }
          : { "Cache-Control": "no-cache" }),
        ...authorization?.headers,
      };
      response.writeHead(200, headers);
      if (request.method === "HEAD") {
        response.end();
        return;
      }
      await pipeline(file.handle.createReadStream(), response);
    } finally {
      await file.handle.close();
    }
  };
}

export async function startStaticOrigin({
  root,
  authorize,
  host = "127.0.0.1",
  port = 0,
}: StaticOriginOptions) {
  const rootMetadata = await lstat(resolve(root));
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new Error("static origin root must be an unlinked directory");
  }
  const handler = createStaticOriginHandler({
    root,
    ...(authorize === undefined ? {} : { authorize }),
  });
  const server = createServer((request, response) => {
    handler(request, response).catch((error: unknown) =>
      response.destroy(error instanceof Error ? error : new Error("static origin failed")),
    );
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, host, () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("static origin has no port");
  const authorityHost = host.includes(":") ? `[${address.address}]` : host;
  return {
    origin: `http://${authorityHost}:${address.port}`,
    async close() {
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => (error === undefined ? resolveClose() : rejectClose(error)));
      });
    },
  };
}

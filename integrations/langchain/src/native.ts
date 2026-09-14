import {
  type ActivatedSessionSkill,
  RemoteSkillsError,
  type RemoteSkillsSession,
} from "@remote-skills/client";
import {
  type BackendProtocolV2,
  createFilesystemMiddleware,
  createSkillsMiddleware,
  type FileInfo,
  normalizeReadPagination,
  type ReadResult,
} from "deepagents";

export interface RemoteSkillsOptions {
  /** A caller-owned session. The adapter never closes it. */
  readonly session: RemoteSkillsSession;
  /** Absolute virtual directory, with a trailing slash. Defaults to /skills/. */
  readonly root?: string;
  /** Host-selected version ranges, keyed by catalog skill name. */
  readonly versions?: Readonly<Record<string, string>>;
}

export interface RemoteSkillMetadata {
  readonly name: string;
  readonly description: string;
  readonly path: string;
}

export interface RemoteSkillsIntegration extends AsyncDisposable {
  /** Catalog frontmatter projections for native discovery only; never verified content. */
  readonly discoveryBackend: BackendProtocolV2;
  /** Original verified content and resources, activated lazily through the SDK. */
  readonly contentBackend: BackendProtocolV2;
  readonly sources: string[];
  readonly catalog: readonly RemoteSkillMetadata[];
  readonly middleware: readonly [
    ReturnType<typeof createSkillsMiddleware>,
    ReturnType<typeof createFilesystemMiddleware>,
  ];
  /** Public native options that also preserve general-purpose subagent discovery. */
  readonly deepAgentOptions: {
    readonly backend: BackendProtocolV2;
    readonly skills: string[];
    readonly middleware: RemoteSkillsIntegration["middleware"];
  };
  /** Disable this adapter and drain its work. The caller still owns the session. */
  close(): Promise<void>;
}

interface Location {
  readonly name: string;
  readonly resource: string;
}

/** Keep native discovery, prompt generation, model selection, and file tools intact. */
export async function remoteSkills(options: RemoteSkillsOptions): Promise<RemoteSkillsIntegration> {
  const { session } = options;
  const root = options.root ?? "/skills/";
  if (!/^\/(?:[a-zA-Z0-9_-]+\/)+$/u.test(root))
    throw new RemoteSkillsError("configuration_invalid");
  const entries = await session.catalog();
  const names = new Set(entries.map((entry) => entry.name));
  const versions = new Map(Object.entries(options.versions ?? {}));
  for (const [name, range] of versions) {
    if (!names.has(name) || typeof range !== "string" || !range.trim())
      throw new RemoteSkillsError("configuration_invalid");
  }
  const catalog = Object.freeze(
    entries.map(({ name, description }) =>
      Object.freeze({ name, description, path: `${root}${name}/SKILL.md` }),
    ),
  );
  const projections = new Map(
    catalog.map((entry) => [
      entry.name,
      `---\nname: ${JSON.stringify(entry.name)}\ndescription: ${JSON.stringify(entry.description)}\n---\n`,
    ]),
  );
  const pending = new Set<Promise<unknown>>();
  let closed = false;
  let closing: Promise<void> | undefined;

  function assertOpen() {
    if (closed) throw new RemoteSkillsError("session_closed");
  }
  function operation<T>(work: () => Promise<T>): Promise<T> {
    const task = (async () => {
      try {
        assertOpen();
        // The SDK session checks its own lifetime without making another request.
        await session.catalog();
        const result = await work();
        assertOpen();
        return result;
      } catch (error) {
        if (error instanceof RemoteSkillsError) throw new RemoteSkillsError(error.code);
        throw new Error("Remote Skills operation failed");
      }
    })();
    pending.add(task);
    void task.then(
      () => pending.delete(task),
      () => pending.delete(task),
    );
    return task;
  }
  function close(): Promise<void> {
    if (closing) return closing;
    closed = true;
    closing = Promise.allSettled([...pending]).then(() => undefined);
    return closing;
  }
  function location(path: string, directory = false): Location {
    if (
      !path.startsWith(root) ||
      path.includes("\\") ||
      !path.isWellFormed() ||
      path.normalize("NFC") !== path ||
      [...path].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
    )
      throw new RemoteSkillsError("path_invalid");
    const relative = path.slice(root.length);
    const parts = (directory && relative.endsWith("/") ? relative.slice(0, -1) : relative).split(
      "/",
    );
    if (parts.some((part) => !part || part === "." || part === ".."))
      throw new RemoteSkillsError("path_invalid");
    const name = parts.shift();
    if (!name || !names.has(name)) throw new RemoteSkillsError("resource_not_found");
    const resource = parts.join("/");
    if (!directory && !resource) throw new RemoteSkillsError("path_invalid");
    return { name, resource };
  }
  function activate(name: string): Promise<ActivatedSessionSkill> {
    return session.activate(name, versions.get(name));
  }
  async function content(path: string, discovery: boolean) {
    const { name, resource } = location(path);
    if (discovery) {
      if (resource !== "SKILL.md") throw new RemoteSkillsError("resource_not_found");
      const text = projections.get(name);
      if (text === undefined) throw new RemoteSkillsError("resource_not_found");
      return { bytes: new TextEncoder().encode(text), mimeType: "text/markdown" };
    }
    const skill = await activate(name);
    const bytes = await skill.readBytes(resource);
    const metadata = (await skill.list(resource)).find((file) => file.path === resource);
    if (!metadata) throw new RemoteSkillsError("resource_not_found");
    return { bytes, mimeType: metadata.media_type };
  }
  function createView(discovery: boolean): BackendProtocolV2 {
    return {
      ls: (path) =>
        operation(async () => {
          if (path === root || path === root.slice(0, -1)) {
            return {
              files: catalog.map((entry) => ({ path: `${root}${entry.name}/`, is_dir: true })),
            };
          }
          const { name, resource } = location(path, true);
          if (discovery) {
            if (resource) throw new RemoteSkillsError("resource_not_found");
            return { files: [{ path: `${root}${name}/SKILL.md`, is_dir: false }] };
          }
          const selected = await activate(name);
          const resources = await selected.list(resource);
          const prefix = resource ? `${resource}/` : "";
          const files = new Map<string, FileInfo>();
          for (const file of resources) {
            if (!file.path.startsWith(prefix)) continue;
            const relative = file.path.slice(prefix.length);
            const first = relative.split("/")[0];
            if (!first) continue;
            const isDirectory = relative.includes("/");
            const absolute = `${root}${name}/${prefix}${first}${isDirectory ? "/" : ""}`;
            files.set(absolute, {
              path: absolute,
              is_dir: isDirectory,
              ...(isDirectory ? {} : { size: file.size }),
            });
          }
          return { files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)) };
        }),
      read: (path, offset = 0, limit = 500) =>
        operation(async (): Promise<ReadResult> => {
          const { bytes, mimeType } = await content(path, discovery);
          if (!mimeType.startsWith("text/") && !/json|xml|yaml|javascript/u.test(mimeType))
            return { content: bytes, mimeType };
          let text: string;
          try {
            text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          } catch {
            throw new RemoteSkillsError("resource_not_text");
          }
          const lines = text.split("\n");
          const normalized = normalizeReadPagination(offset, limit);
          const selected = lines
            .slice(normalized.offset, normalized.offset + normalized.limit)
            .join("\n");
          // A terminal newline ends the last logical line, as in native StateBackend.
          const totalLines = lines.length - (lines.at(-1) === "" ? 1 : 0);
          if (normalized.offset >= totalLines || normalized.limit === 0)
            return { content: selected, mimeType };
          const end = Math.min(normalized.offset + normalized.limit, totalLines);
          return {
            content: selected,
            mimeType,
            totalLines,
            startLine: normalized.offset + 1,
            endLine: end,
            ...(end < totalLines ? { nextOffset: end } : {}),
          };
        }),
      readRaw: (path) =>
        operation(async () => {
          const { bytes, mimeType } = await content(path, discovery);
          return {
            data: {
              content: bytes,
              mimeType,
              created_at: "1970-01-01T00:00:00.000Z",
              modified_at: "1970-01-01T00:00:00.000Z",
            },
          };
        }),
      downloadFiles: (paths) =>
        operation(() =>
          Promise.all(
            paths.map(async (path) => ({
              path,
              content: (await content(path, discovery)).bytes,
              error: null,
            })),
          ),
        ),
      async write() {
        return { error: "Remote skills are read-only" };
      },
      async edit() {
        return { error: "Remote skills are read-only" };
      },
      async glob() {
        return { error: "Use ls to list remote skill resources" };
      },
      async grep() {
        return { error: "Use read_file to read remote skill resources" };
      },
    };
  }
  const discoveryBackend = createView(true);
  const contentBackend = createView(false);
  const sources = [root];
  const middleware = [
    createSkillsMiddleware({ backend: discoveryBackend, sources: [...sources] }),
    createFilesystemMiddleware({
      backend: contentBackend,
      tools: ["ls", "read_file"],
      toolTokenLimitBeforeEvict: null,
      humanMessageTokenLimitBeforeEvict: null,
    }),
  ] as const;
  return {
    discoveryBackend,
    contentBackend,
    sources,
    catalog,
    middleware,
    deepAgentOptions: { backend: contentBackend, skills: [...sources], middleware },
    close,
    [Symbol.asyncDispose]: close,
  };
}

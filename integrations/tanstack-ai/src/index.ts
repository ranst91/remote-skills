import {
  type RemoteSkillsClient,
  RemoteSkillsError,
  type RemoteSkillsSession,
} from "@remote-skills/client";
import type { SkillSource } from "@tanstack/ai-skills";

export type RemoteSkillsOptions = (
  | { client: RemoteSkillsClient; origin: string; session?: never }
  | { session: RemoteSkillsSession; client?: never; origin?: never }
) & { versions?: Readonly<Record<string, string>> };

export interface RemoteSkillSource extends SkillSource, AsyncDisposable {
  readonly session: RemoteSkillsSession;
  listResources: NonNullable<SkillSource["listResources"]>;
  readResource: NonNullable<SkillSource["readResource"]>;
  close(): Promise<void>;
}

function resourcePath(path: string): void {
  if (
    typeof path !== "string" ||
    !/^(references|assets)\//u.test(path) ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.split("/").some((part) => !part || part === "." || part === ".." || part === "~")
  )
    throw new RemoteSkillsError("path_invalid");
}

/** One source per conversation; closing a borrowed session remains the caller's job. */
export async function remoteSkills(options: RemoteSkillsOptions): Promise<RemoteSkillSource> {
  const owned = options.session === undefined;
  let session: RemoteSkillsSession;
  try {
    session = options.session ?? (await options.client.session(options.origin));
  } catch (error) {
    if (error instanceof RemoteSkillsError) throw new RemoteSkillsError(error.code);
    throw new Error("Remote skill discovery failed");
  }
  const versions = new Map(Object.entries(options.versions ?? {}));
  let closed = false;
  let closing: Promise<void> | undefined;
  const pending = new Set<Promise<unknown>>();
  function assertOpen() {
    if (closed) throw new RemoteSkillsError("session_closed");
  }
  async function run<T>(operation: () => Promise<T>): Promise<T> {
    assertOpen();
    const task = Promise.resolve().then(operation);
    pending.add(task);
    try {
      const result = await task;
      assertOpen();
      return result;
    } catch (error) {
      // Never pass transport errors or credential-bearing SDK context to a model.
      if (error instanceof RemoteSkillsError) throw new RemoteSkillsError(error.code);
      throw new Error("Remote skill operation failed");
    } finally {
      pending.delete(task);
    }
  }
  function close(): Promise<void> {
    if (closing) return closing;
    closed = true;
    closing = (async () => {
      await Promise.allSettled([...pending]);
      if (owned) await session.close();
    })();
    return closing;
  }
  try {
    const catalog = await session.catalog();
    const names = new Set(catalog.map((entry) => entry.name));
    for (const [name, range] of versions) {
      if (!names.has(name) || typeof range !== "string" || !range.trim())
        throw new RemoteSkillsError("configuration_invalid");
    }
    const activate = (name: string) => {
      if (!names.has(name)) throw new RemoteSkillsError("skill_not_found");
      return session.activate(name, versions.get(name));
    };
    return {
      session,
      // Re-read the session catalog to enforce a borrowed session's lifecycle.
      list: () =>
        run(async () =>
          (await session.catalog()).map(({ name, description }) => ({ name, description })),
        ),
      load: (name) => run(async () => (await activate(name)).read("SKILL.md")),
      listResources: (name) =>
        run(async () =>
          (await (await activate(name)).list())
            .map(({ path }) => path)
            .filter((path) => /^(references|assets)\//u.test(path)),
        ),
      readResource: (name, path) =>
        run(async () => {
          resourcePath(path);
          const skill = await activate(name);
          try {
            return await skill.read(path);
          } catch (error) {
            if (!(error instanceof RemoteSkillsError) || error.code !== "resource_not_text")
              throw error;
            return skill.readBytes(path);
          }
        }),
      close,
      [Symbol.asyncDispose]: close,
    };
  } catch (error) {
    await close();
    if (error instanceof RemoteSkillsError) throw new RemoteSkillsError(error.code);
    throw new Error("Remote skill discovery failed");
  }
}

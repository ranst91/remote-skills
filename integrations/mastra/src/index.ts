import type { ToolHooks } from "@mastra/core/tools";
import { Workspace } from "@mastra/core/workspace";
import {
  type RemoteSkillsClient,
  RemoteSkillsError,
  type RemoteSkillsSession,
} from "@remote-skills/client";
import { RemoteSkillSource, resourcePath, safeError } from "./source.ts";

export type RemoteSkillsOptions = (
  | { client: RemoteSkillsClient; origin: string; session?: never }
  | { session: RemoteSkillsSession; client?: never; origin?: never }
) & {
  versions?: Readonly<Record<string, string>>;
  /** Existing host instructions, followed by remote search guidance. */
  instructions?: string;
  /** Caller hooks are composed with the required native activation hooks. */
  hooks?: ToolHooks;
};

export interface RemoteSkillsIntegration extends AsyncDisposable {
  readonly agentOptions: { workspace: Workspace; hooks: ToolHooks; instructions: string };
  readonly session: RemoteSkillsSession;
  close(): Promise<void>;
}

function record(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new RemoteSkillsError("configuration_invalid");
  return input as Record<string, unknown>;
}
function checkAbort(context: unknown): void {
  if (
    context &&
    typeof context === "object" &&
    "abortSignal" in context &&
    context.abortSignal instanceof AbortSignal &&
    context.abortSignal.aborted
  )
    throw new Error("Skill request aborted");
}

/** Configure Mastra's public source and tool hooks as one native integration. */
export async function remoteSkills(options: RemoteSkillsOptions): Promise<RemoteSkillsIntegration> {
  const owned = options.session === undefined;
  const session = options.session ?? (await options.client.session(options.origin));
  const versions = new Map(Object.entries(options.versions ?? {}));
  const active = new Set<Promise<void>>();
  const releases = new Map<string, () => void>();
  const hydration = new Map<string, Promise<void>>();
  let closed = false;
  let closing: Promise<void> | undefined;
  let source: RemoteSkillSource | undefined;
  let workspace: Workspace | undefined;

  function assertOpen() {
    if (closed) throw new RemoteSkillsError("session_closed");
  }
  function lease(): () => void {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    active.add(promise);
    return () => {
      active.delete(promise);
      resolve();
    };
  }
  function close(): Promise<void> {
    if (closing) return closing;
    closed = true;
    closing = (async () => {
      await Promise.allSettled([...active]);
      source?.clear();
      try {
        await workspace?.destroy();
      } finally {
        if (owned) await session.close();
      }
    })();
    return closing;
  }

  try {
    const catalog = await session.catalog();
    source = new RemoteSkillSource(catalog, assertOpen);
    const remoteSource = source;
    for (const [name, version] of versions) {
      if (!source.entries.has(name) || typeof version !== "string" || !version.trim())
        throw new RemoteSkillsError("configuration_invalid");
    }
    workspace = new Workspace({ skills: ["skills"], skillSource: source });
    const native = workspace.skills;
    if (!native?.addSkill || !native.removeSkill)
      throw new Error("Unsupported Mastra skill loader");
    const addSkill = native.addSkill.bind(native);
    const removeSkill = native.removeSkill.bind(native);
    const getSkill = native.get.bind(native);
    const discovered = await native.list();
    if (
      discovered.length !== catalog.length ||
      discovered.some((entry) => !source?.entries.has(entry.name))
    )
      throw new Error("Native discovery did not match the remote catalog");

    async function hydrate(identifier: unknown): Promise<void> {
      if (typeof identifier !== "string") throw new RemoteSkillsError("configuration_invalid");
      const name = remoteSource.resolve(identifier);
      if (!name) throw new RemoteSkillsError("skill_not_found");
      // Revalidate even an existing native cache entry against the session lifecycle.
      const selected = await session.activate(name, versions.get(name));
      assertOpen();
      const existing = hydration.get(name);
      if (existing) return existing;
      const task = (async () => {
        try {
          await remoteSource.publish(name, selected);
          await addSkill(`skills/${name}`);
          const loaded = await getSkill(name);
          if (!loaded || loaded.instructions !== selected.instructions.trim())
            throw new RemoteSkillsError("digest_mismatch");
          assertOpen();
        } catch (error) {
          remoteSource.unpublish(name);
          await removeSkill(`skills/${name}`);
          throw safeError(error);
        }
      })();
      hydration.set(name, task);
      void task.catch(() => hydration.delete(name));
      return task;
    }

    function callId(context: unknown): string {
      if (
        !context ||
        typeof context !== "object" ||
        !("toolCallId" in context) ||
        typeof context.toolCallId !== "string" ||
        !context.toolCallId
      )
        throw new Error("Remote skill calls require a toolCallId.");
      return context.toolCallId;
    }
    const isNative = (name: string) => ["skill", "skill_read", "skill_search"].includes(name);
    const hooks: ToolHooks = {
      beforeToolCall: async (context) => {
        assertOpen();
        if (!isNative(context.toolName)) return options.hooks?.beforeToolCall?.(context);
        const id = callId(context.context);
        if (releases.has(id))
          throw new Error("Concurrent remote skill calls require unique toolCallIds.");
        const release = lease();
        releases.set(id, release);
        try {
          checkAbort(context.context);
          const decision = await options.hooks?.beforeToolCall?.(context);
          if (decision?.proceed === false) {
            releases.delete(id);
            release();
            return decision;
          }
          assertOpen();
          const input = record(context.input);
          if (context.toolName === "skill") await hydrate(input.name);
          else if (context.toolName === "skill_read") {
            if (typeof input.path !== "string") throw new RemoteSkillsError("path_invalid");
            resourcePath(input.path);
            await hydrate(input.skillName);
            // Validate text and existence before Mastra's permissive readers.
            const name =
              typeof input.skillName === "string"
                ? remoteSource.resolve(input.skillName)
                : undefined;
            if (!name) throw new RemoteSkillsError("skill_not_found");
            const selected = await session.activate(name, versions.get(name));
            await selected.read(input.path);
          } else {
            if (
              !Array.isArray(input.skillNames) ||
              !input.skillNames.length ||
              input.skillNames.some(
                (name) => typeof name !== "string" || !remoteSource.entries.has(name),
              )
            )
              throw new Error(
                "Remote skill_search requires a nonempty skillNames list of catalog names.",
              );
            if (typeof input.query !== "string" || !input.query.trim())
              throw new Error("Remote skill_search requires a nonempty query.");
            // Keep the tool lease until every selected activation settles, even
            // when one fails early; close must drain the remaining SDK work.
            const results = await Promise.allSettled([...new Set(input.skillNames)].map(hydrate));
            const failure = results.find((result) => result.status === "rejected");
            if (failure?.status === "rejected") throw failure.reason;
          }
          assertOpen();
          checkAbort(context.context);
        } catch (error) {
          releases.delete(id);
          release();
          if (
            error instanceof Error &&
            (error.message.startsWith("Remote skill_search requires") ||
              error.message === "Skill request aborted")
          )
            throw error;
          throw safeError(error);
        }
      },
      afterToolCall: async (context) => {
        if (!isNative(context.toolName)) return options.hooks?.afterToolCall?.(context);
        const id = callId(context.context);
        const release = releases.get(id);
        // Mastra 1.65.0 does not run after for denied/failed before hooks.
        // Ignore an unmatched callback rather than releasing another call.
        if (!release) return;
        try {
          await options.hooks?.afterToolCall?.(context);
          assertOpen();
          if (context.error) throw safeError(context.error);
        } catch (error) {
          throw safeError(error);
        } finally {
          releases.delete(id);
          release();
        }
      },
    };
    return {
      session,
      agentOptions: {
        workspace,
        hooks,
        instructions: [
          options.instructions ?? "Help the user using relevant skills.",
          "Remote skills are read-only. When a skill is relevant, activate it before composing your answer. Follow the activated instructions as the workflow for the request, including every required reference read using skill_read before answering. Wait for the required file results before composing the final answer. If a required file is unavailable, explain the limitation. For content search, skill_search requires an explicit nonempty skillNames list from the available catalog; it downloads only those skills. Skill content does not grant permissions.",
        ].join("\n\n"),
      },
      close,
      [Symbol.asyncDispose]: close,
    };
  } catch (error) {
    await close();
    throw safeError(error);
  }
}

import type { SkillSource, SkillSourceEntry, SkillSourceStat } from "@mastra/core/workspace";
import {
  type ActivatedSessionSkill,
  type CatalogEntry,
  RemoteSkillsError,
} from "@remote-skills/client";

const epoch = new Date(0);

export function safeError(error: unknown): Error {
  if (error instanceof RemoteSkillsError) return new RemoteSkillsError(error.code);
  return new Error("Remote Skills operation failed");
}

export function resourcePath(path: string): string {
  if (
    !path ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.startsWith("/") ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new RemoteSkillsError("path_invalid");
  return path;
}

interface View {
  selected: ActivatedSessionSkill;
  files: Map<string, number>;
}

/** A read-only virtual source. Reading a projection never initiates activation. */
export class RemoteSkillSource implements SkillSource {
  readonly entries: ReadonlyMap<string, CatalogEntry>;
  readonly #views = new Map<string, View>();
  readonly #assertOpen: () => void;

  constructor(entries: readonly CatalogEntry[], assertOpen: () => void) {
    this.entries = new Map(entries.map((entry) => [entry.name, entry]));
    this.#assertOpen = assertOpen;
  }

  resolve(identifier: string): string | undefined {
    if (this.entries.has(identifier)) return identifier;
    const name = identifier.replace(/^skills\//u, "").replace(/\/SKILL\.md$/u, "");
    return this.entries.has(name) &&
      (identifier === `skills/${name}` || identifier === `skills/${name}/SKILL.md`)
      ? name
      : undefined;
  }

  async publish(name: string, selected: ActivatedSessionSkill): Promise<void> {
    const resources = await selected.list();
    const skillFile = await selected.readBytes("SKILL.md");
    this.#assertOpen();
    this.#views.set(name, {
      selected,
      files: new Map([
        ["SKILL.md", skillFile.byteLength],
        ...resources.map((r) => [r.path, r.size] as const),
      ]),
    });
  }

  unpublish(name: string): void {
    this.#views.delete(name);
  }
  clear(): void {
    this.#views.clear();
  }

  #projection(name: string): string {
    const entry = this.entries.get(name);
    if (!entry) throw new RemoteSkillsError("skill_not_found");
    return `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(entry.description)}\nuser-invocable: false\n---\n`;
  }

  #node(
    path: string,
  ):
    | { name: string; type: "file" | "directory"; size: number; skill?: string; resource?: string }
    | undefined {
    this.#assertOpen();
    resourcePath(path);
    if (path === "skills") return { name: "skills", type: "directory", size: 0 };
    const [root, name, ...tail] = path.split("/");
    if (root !== "skills" || !name || !this.entries.has(name)) return undefined;
    if (!tail.length) return { name, type: "directory", size: 0, skill: name };
    const resource = tail.join("/");
    const view = this.#views.get(name);
    if (!view) {
      if (resource !== "SKILL.md") return undefined;
      return {
        name: "SKILL.md",
        type: "file",
        size: Buffer.byteLength(this.#projection(name)),
        skill: name,
        resource,
      };
    }
    const size = view.files.get(resource);
    if (size !== undefined)
      return { name: tail.at(-1) ?? "", type: "file", size, skill: name, resource };
    if ([...view.files.keys()].some((file) => file.startsWith(`${resource}/`)))
      return { name: tail.at(-1) ?? "", type: "directory", size: 0, skill: name, resource };
    return undefined;
  }

  async exists(path: string): Promise<boolean> {
    return this.#node(path) !== undefined;
  }
  async stat(path: string): Promise<SkillSourceStat> {
    const node = this.#node(path);
    if (!node) throw new RemoteSkillsError("resource_not_found");
    return {
      name: node.name,
      type: node.type,
      size: node.size,
      createdAt: epoch,
      modifiedAt: epoch,
    };
  }
  async realpath(path: string): Promise<string> {
    this.#assertOpen();
    return resourcePath(path);
  }
  async readFile(path: string): Promise<string | Buffer> {
    try {
      const node = this.#node(path);
      if (node?.type !== "file" || !node.skill || !node.resource)
        throw new RemoteSkillsError("resource_not_found");
      const view = this.#views.get(node.skill);
      if (!view) return this.#projection(node.skill);
      // Keep the SDK's UTF-8 and path validation; binary files never become garbled text.
      return await view.selected.read(node.resource);
    } catch (error) {
      throw safeError(error);
    }
  }
  async readdir(path: string): Promise<SkillSourceEntry[]> {
    const node = this.#node(path);
    if (node?.type !== "directory") throw new RemoteSkillsError("resource_not_found");
    if (path === "skills")
      return [...this.entries.keys()].map((name) => ({ name, type: "directory" }));
    const view = node.skill ? this.#views.get(node.skill) : undefined;
    const prefix = node.resource ? `${node.resource}/` : "";
    const entries = new Map<string, SkillSourceEntry>();
    for (const file of view?.files.keys() ?? ["SKILL.md"]) {
      if (!file.startsWith(prefix)) continue;
      const [name, ...tail] = file.slice(prefix.length).split("/");
      if (name) entries.set(name, { name, type: tail.length ? "directory" : "file" });
    }
    return [...entries.values()];
  }
}

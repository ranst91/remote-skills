import type { CachedObject } from "../cache/types.ts";
import { RemoteSkillsError } from "../catalog/errors.ts";
import { parseSkillMarkdown } from "./frontmatter.ts";
import { normalizedResourcePath } from "./paths.ts";
import type { ActivatedResource, ActivatedSkill } from "./types.ts";

export function activatedSkillFromObject(
  object: CachedObject,
  name: string,
  version?: string,
  expectedDescription?: string,
): ActivatedSkill {
  const skillBytes = object.root.get("SKILL.md");
  if (skillBytes === undefined) {
    throw new RemoteSkillsError("archive_unsafe", { path: "SKILL.md" });
  }
  const parsed = parseSkillMarkdown(skillBytes, name);
  if (expectedDescription !== undefined && parsed.description !== expectedDescription) {
    throw new RemoteSkillsError("catalog_invalid", { field: "description" });
  }
  const resources = Object.freeze(
    object.metadata.files.map((file) =>
      Object.freeze({ path: file.path, size: file.size, media_type: file.mediaType }),
    ),
  );
  const root = object.root;
  const skill: ActivatedSkill = {
    name: parsed.name,
    description: parsed.description,
    digest: object.metadata.digest,
    ...(version === undefined ? {} : { version }),
    instructions: parsed.instructions,
    frontmatter: parsed.frontmatter,
    async list(prefix = ""): Promise<readonly ActivatedResource[]> {
      const normalized = normalizedResourcePath(prefix, true);
      const directoryPrefix = normalized.endsWith("/") ? normalized : `${normalized}/`;
      const listed = resources.filter(
        ({ path }) => normalized === "" || path === normalized || path.startsWith(directoryPrefix),
      );
      if (normalized !== "" && listed.length === 0) {
        throw new RemoteSkillsError("resource_not_found", { path: normalized });
      }
      return listed;
    },
    async read(path: string): Promise<string> {
      const bytes = await skill.readBytes(path);
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new RemoteSkillsError("resource_not_text", { path });
      }
    },
    async readBytes(path: string): Promise<Uint8Array> {
      const normalized = normalizedResourcePath(path);
      const bytes = root.get(normalized);
      if (bytes === undefined) {
        throw new RemoteSkillsError("resource_not_found", { path: normalized });
      }
      return new Uint8Array(bytes);
    },
  };
  return Object.freeze(skill);
}

import { normalizePortableRelativePath } from "@remote-skills/core/authoring";

import { PublisherVerifyError } from "./verify-errors.ts";

type PathIdentity = {
  segment: string;
  directory: boolean;
  explicit: boolean;
  children: Map<string, PathIdentity>;
};

/** Private archive metadata table, including directories implied by descendants. */
export class ArchivePathTable {
  private readonly identities = new Map<string, PathIdentity>();

  admit(name: string, directory: boolean): void {
    const normalized = normalizePortableRelativePath(name);
    if (!normalized || normalized.path !== name) throw new PublisherVerifyError("archive_unsafe");

    const segments = name.split("/");
    let siblings = this.identities;
    // Store and fold each component, never every complete ancestor prefix.
    // Shared ancestors occupy one node, so metadata stays linear in input names.
    for (const [index, segment] of segments.entries()) {
      const identity = normalizePortableRelativePath(segment);
      if (!identity) throw new PublisherVerifyError("archive_unsafe");
      const explicit = index === segments.length - 1;
      const isDirectory = !explicit || directory;
      let previous = siblings.get(identity.collisionKey);
      if (previous) {
        if (
          previous.segment !== segment ||
          previous.directory !== isDirectory ||
          (explicit && previous.explicit)
        )
          throw new PublisherVerifyError("archive_unsafe");
        if (explicit) previous.explicit = true;
      } else {
        previous = {
          segment,
          directory: isDirectory,
          explicit,
          children: new Map(),
        };
        siblings.set(identity.collisionKey, previous);
      }
      siblings = previous.children;
    }
  }
}

import { RemoteSkillsError } from "../catalog/errors.ts";
import { selectCatalogRelease } from "../catalog/semver.ts";
import type { CatalogEntry } from "../catalog/types.ts";
import { activateSkill } from "./activate.ts";
import type {
  ActivatedSkill,
  ActivationCoordinator,
  ActivationCoordinatorInput,
  ActivationDependencies,
  ActivationPin,
  ActivationResult,
} from "./types.ts";

function pinnedView(result: ActivationResult): ActivatedSkill & ActivationPin {
  const { skill, pin } = result;
  return Object.freeze({
    name: skill.name,
    description: skill.description,
    digest: skill.digest,
    ...(skill.version === undefined ? {} : { version: skill.version }),
    instructions: skill.instructions,
    frontmatter: skill.frontmatter,
    list: skill.list.bind(skill),
    read: skill.read.bind(skill),
    readBytes: skill.readBytes.bind(skill),
    originAlias: pin.originAlias,
    ...(pin.confirmedScope === undefined ? {} : { confirmedScope: pin.confirmedScope }),
    descriptor: pin.descriptor,
  });
}

export function createActivationCoordinator(
  input: ActivationCoordinatorInput,
  dependencies: ActivationDependencies = {},
): ActivationCoordinator {
  const pins = new Map<string, Promise<ActivationResult>>();
  const views = new Map<string, Promise<ActivatedSkill & ActivationPin>>();
  let released = false;
  const entryByName = new Map(input.catalog.entries.map((entry) => [entry.name, entry]));
  async function activate(
    name: string,
    requestedRange?: string,
  ): Promise<ActivatedSkill & ActivationPin> {
    if (released)
      throw new RemoteSkillsError("session_closed", { origin_alias: input.catalog.originAlias });
    const existingView = views.get(name);
    if (existingView !== undefined) return existingView;
    let pending = pins.get(name);
    if (pending === undefined) {
      const entry = entryByName.get(name);
      if (entry === undefined)
        throw new RemoteSkillsError("skill_not_found", {
          origin_alias: input.catalog.originAlias,
          skill_name: name,
        });
      const release = selectCatalogRelease(entry, requestedRange);
      pending = activateSkill(
        {
          origin: input.origin,
          originAlias: input.catalog.originAlias,
          ...(input.catalog.confirmedScope === undefined
            ? {}
            : { confirmedScope: input.catalog.confirmedScope }),
          entry: entry as CatalogEntry,
          release,
          cache: input.cache,
          sessionNonce: input.sessionNonce,
          ...(input.limits === undefined ? {} : { limits: input.limits }),
        },
        dependencies,
      );
      pins.set(name, pending);
      pending.catch(() => {
        if (pins.get(name) === pending) {
          pins.delete(name);
          views.delete(name);
        }
      });
    }
    const view = pending.then(pinnedView);
    views.set(name, view);
    return view;
  }
  return Object.freeze({
    activate,
    async release(): Promise<void> {
      if (released) return;
      released = true;
      const settled = await Promise.allSettled(pins.values());
      await Promise.all(
        settled.flatMap((item) =>
          item.status === "fulfilled" ? [item.value.lease.release()] : [],
        ),
      );
      pins.clear();
      views.clear();
    },
  });
}

import type { RemoteSkillsClient, RemoteSkillsSession } from "@remote-skills/client";

type Source =
  | {
      readonly client: RemoteSkillsClient;
      readonly origin: string;
      readonly origins?: never;
      readonly session?: never;
    }
  | {
      readonly client: RemoteSkillsClient;
      readonly origins: readonly string[];
      readonly origin?: never;
      readonly session?: never;
    }
  | {
      readonly session: RemoteSkillsSession;
      readonly client?: never;
      readonly origin?: never;
      readonly origins?: never;
    };

export type RemoteSkillsOptions = Source & {
  /** Skill name, or origin/name when using multiple origins. Never chosen by the model. */
  readonly versions?: Readonly<Record<string, string>>;
};

import type {
  ActivatedSessionSkill,
  RemoteSkillsClient,
  RemoteSkillsSession,
  SessionMetadata,
} from "../src/index.ts";

declare const client: RemoteSkillsClient;
declare const session: RemoteSkillsSession;
declare const skill: ActivatedSessionSkill;
declare const metadata: SessionMetadata;

const catalog = client.catalog({ strict: false });
const refreshed = client.refresh("acme");
const opened = client.session("acme");
const entries = session.catalog();
const activated = session.activate("code-review", "1.4.x");
const closed = session.close();
const disposed = session[Symbol.asyncDispose]();

void catalog;
void refreshed;
void opened;
void entries;
void activated;
void closed;
void disposed;

metadata.stale satisfies boolean;
skill.originAlias satisfies string;

// @ts-expect-error Session snapshot metadata is immutable.
metadata.stale = false;
// @ts-expect-error Activated session identities are immutable.
skill.digest = "sha256:mutated";
// @ts-expect-error Public sessions do not support synchronous disposal.
session[Symbol.dispose]();

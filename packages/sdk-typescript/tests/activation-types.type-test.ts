import type { ActivatedSkill, ActivationPin } from "../src/activation/index.ts";

declare const skill: ActivatedSkill;
declare const pin: ActivationPin;

const listed: Promise<readonly { path: string; size: number; media_type: string }[]> = skill.list();
const text: Promise<string> = skill.read("references/security.md");
const bytes: Promise<Uint8Array> = skill.readBytes("assets/template.bin");

void listed;
void text;
void bytes;

// @ts-expect-error Activated identities are immutable.
skill.digest = "sha256:mutated";
// @ts-expect-error Authorized scope pins are immutable.
pin.confirmedScope = "other";
// @ts-expect-error Artifact descriptor pins are immutable.
pin.descriptor.digest = "sha256:mutated";
// @ts-expect-error Skill content is data and has no execution API.
skill.execute();

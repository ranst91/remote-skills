import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  createRemoteSkills,
  type OriginConfig,
  type RemoteSkillsConfig,
  type RemoteSkillsDependencies,
} from "@remote-skills/client";
import { encodeZip } from "../../../packages/core/src/build/archive.ts";
export const TOKEN = "private-test-auth-sentinel";
export const INSTRUCTIONS = "Read references/greeting.md before greeting the user.";
export const TEXT = "Ahoy, curious human!";
const digest = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const bytes = (text: string) => Buffer.from(text);

export function fixture(
  overrides: Partial<RemoteSkillsConfig> = {},
  originOverrides: Partial<OriginConfig> = {},
) {
  const archive = (version: string) =>
    encodeZip([
      {
        path: "SKILL.md",
        bytes: bytes(
          `---\nname: greeting\ndescription: Greeting\nmetadata:\n  version: ${version}\n---\n${INSTRUCTIONS}\n`,
        ),
      },
      { path: "references/greeting.md", bytes: bytes(`${TEXT} ${version}`) },
      { path: "assets/icon.bin", bytes: Buffer.from([0, 255, 128]) },
    ]);
  const artifacts = new Map([
    ["1.0.0", archive("1.0.0")],
    ["2.0.0", archive("2.0.0")],
  ]);
  const artifact = (version: string) => {
    const value = artifacts.get(version);
    assert.ok(value, `missing fixture version ${version}`);
    return value;
  };
  const requests: { path: string; headers: Readonly<Record<string, string>> }[] = [];
  let current = "1.0.0";
  let offline = false;
  let corrupt = false;
  let status: number | undefined;
  let failures = 0;
  let now = Date.parse("2026-09-09T00:00:00Z");
  const release = (version: string) => ({
    version,
    type: "archive",
    url: `artifacts/${version}.zip`,
    digest: digest(artifact(version)),
  });
  const dependencies: RemoteSkillsDependencies = {
    now: () => now,
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    transport: async (request) => {
      const path = new URL(request.url).pathname;
      requests.push({ path, headers: request.headers });
      if (failures-- > 0) return { status: 503, headers: {}, body: bytes("Unavailable") };
      if (offline) throw new Error(TOKEN);
      if (status) return { status, headers: {}, body: bytes(TOKEN) };
      if (request.headers.authorization !== `Bearer ${TOKEN}`)
        return { status: 401, headers: {}, body: bytes(TOKEN) };
      if (path.endsWith("index.json")) {
        return {
          status: 200,
          headers: { "remote-skills-scope": "engineering", "cache-control": "max-age=0" },
          body: bytes(
            JSON.stringify({
              $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
              skills: [
                {
                  name: "greeting",
                  description: "Greeting",
                  ...release(current),
                  "x-remote-skills": {
                    version: current,
                    releases: [...artifacts.keys()].sort().reverse().map(release),
                  },
                },
              ],
            }),
          ),
        };
      }
      const version = path.split("/").at(-1)?.replace(".zip", "");
      return {
        status: 200,
        headers: { "content-type": "application/zip" },
        body: corrupt ? bytes("tampered") : artifact(version ?? ""),
      };
    },
  };
  const client = createRemoteSkills(
    {
      origins: {
        team: {
          url: "https://skills.example.test",
          headers: { Authorization: `Bearer ${TOKEN}` },
          scope: "engineering",
          retries: 0,
          ...originOverrides,
        },
        other: {
          url: "https://other.example.test",
          headers: { Authorization: `Bearer ${TOKEN}` },
          scope: "engineering",
          retries: 0,
        },
      },
      cache: "memory",
      ...overrides,
    },
    dependencies,
  );
  return {
    client,
    requests,
    artifactRequests: () => requests.filter((r) => !r.path.endsWith("index.json")),
    update: () => {
      current = "2.0.0";
      now += 1000;
    },
    offline: () => {
      offline = true;
      now += 1000;
    },
    corrupt: () => {
      corrupt = true;
    },
    status: (value: number) => {
      status = value;
    },
    failNext: () => {
      failures = 1;
    },
  };
}

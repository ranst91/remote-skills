import { createRemoteSkills, RemoteSkillsError } from "@remote-skills/client";

const HELP = `Usage: REMOTE_SKILLS_ORIGIN=http://127.0.0.1:8787 pnpm start

Optional environment:
  REMOTE_SKILLS_AUTH_TOKEN       bearer token for a private origin
  REMOTE_SKILLS_SCOPE            provider-authorized catalog scope
  REMOTE_SKILLS_VERSION_RANGE    SemVer range, for example 1.4.x
`;

async function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    process.stdout.write(HELP);
    return;
  }
  const origin = process.env.REMOTE_SKILLS_ORIGIN;
  if (origin === undefined) throw new Error("REMOTE_SKILLS_ORIGIN is required");
  const token = process.env.REMOTE_SKILLS_AUTH_TOKEN;
  const scope = process.env.REMOTE_SKILLS_SCOPE;
  const versionRange = process.env.REMOTE_SKILLS_VERSION_RANGE;
  const client = createRemoteSkills({
    origins: {
      example: {
        url: origin,
        ...(token === undefined ? {} : { headers: { Authorization: `Bearer ${token}` } }),
        ...(scope === undefined ? {} : { scope }),
        ...(new URL(origin).protocol === "http:" ? { allowLoopbackHttp: true } : {}),
        retries: 0,
      },
    },
    cache: "memory",
  });
  const session = await client.session("example");
  try {
    const catalog = await session.catalog();
    const skill = await session.activate("code-review", versionRange);
    const resources = await skill.list();
    const reference = await skill.read("references/security.md");
    process.stdout.write(
      `${JSON.stringify({
        catalogEntries: catalog.length,
        confirmedScope: session.metadata.confirmedScope ?? null,
        name: skill.name,
        version: skill.version ?? null,
        digest: skill.digest,
        resources: resources.map(({ path }) => path),
        referenceBytes: Buffer.byteLength(reference),
      })}\n`,
    );
  } finally {
    await session.close();
  }
}

try {
  await main();
} catch (error) {
  const diagnostic =
    error instanceof RemoteSkillsError ? error.toDiagnostic() : { code: "example_failed" };
  process.stderr.write(`${JSON.stringify(diagnostic)}\n`);
  process.exitCode = 1;
}

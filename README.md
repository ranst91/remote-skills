# Remote Skills

### Serve skills. Don't install them.

Remote Skills is an open-source toolkit for publishing and consuming [Agent Skills](https://agentskills.io/) directly from remote origins.

Publishers keep authority over their skills. Agents discover a compact catalog, activate only what they need, verify the downloaded bytes, and reuse a disposable content-addressed cache.

```text
Discover metadata → activate by name → verify digest → pin for the session → read resources as needed
```

No marketplace. No copied installation in every agent. No proprietary skill format.

## Publish a remote skill origin

Start with ordinary Agent Skills:

```text
skills/
├── code-review/
│   ├── SKILL.md
│   └── references/
│       └── security.md
└── release-notes/
    └── SKILL.md
```

Validate and serve them locally:

```bash
npx @remote-skills/cli validate
npx @remote-skills/cli dev
```

The development origin is available at `http://127.0.0.1:8787`.

Build deploy-ready static output:

```bash
npx @remote-skills/cli build
```

```text
dist/
└── .well-known/
    └── agent-skills/
        ├── index.json
        └── artifacts/
            ├── sha256-….md
            └── sha256-….tar.gz
```

Deploy `dist/` to any HTTPS static host or application server. Remote Skills does not require a hosted Remote Skills service.

Verify the deployed origin:

```bash
npx @remote-skills/cli verify https://skills.example.com
```

Private origins can use ordinary headers:

```bash
SKILLS_AUTH='Bearer …' npx @remote-skills/cli verify \
  https://skills.example.com \
  --header-env Authorization=SKILLS_AUTH
```

## Consume skills from TypeScript

```bash
npm install @remote-skills/client
```

```ts
import { createRemoteSkills } from "@remote-skills/client";

const client = createRemoteSkills({
  origins: {
    acme: { url: "https://skills.example.com" },
  },
});

const session = await client.session("acme");
const catalog = await session.catalog();

const skill = await session.activate("code-review");
console.log(skill.instructions);

const security = await skill.read("references/security.md");
await session.close();
```

`catalog()` returns compact discovery metadata. `activate()` downloads and verifies the current artifact only when needed, then pins that exact digest for the session. `read()` loads a resource from the already verified artifact; it does not make another network request.

## Consume skills from Python

```bash
uv add remote-skills
```

```python
from remote_skills import Origin, RemoteSkills

client = RemoteSkills(
    origins={
        "acme": Origin(url="https://skills.example.com"),
    }
)

async with client.session("acme") as session:
    catalog = await session.catalog()
    skill = await session.activate("code-review")

    print(skill.instructions)
    security = await skill.read("references/security.md")
```

The TypeScript and Python SDKs follow the same behavior and stable error codes.

## Updates and caching

Artifacts are identified by their SHA-256 digest.

- An active session never changes halfway through.
- A later session can resolve and pin a newly published digest.
- Standard HTTP caching uses `ETag`, `Last-Modified`, and `Cache-Control`.
- `client.refresh()` revalidates catalogs for future sessions.
- Existing pinned sessions continue offline.
- New offline sessions fail closed unless stale use is explicitly enabled and age-bounded.

The cache is not an installation. It is bounded, disposable, and safe to rebuild from the configured origin.

## Trust boundary

Digest verification proves that downloaded bytes match the publisher's catalog. It does **not** prove that the instructions or scripts are safe.

Remote Skills:

- never executes bundled scripts;
- never treats `allowed-tools` as authorization;
- never forwards origin credentials to an unconfigured artifact host;
- rejects unsafe archive paths, links, special files, and decompression bombs;
- requires HTTPS, except for explicitly configured loopback development.

The host agent remains responsible for trust, permissions, relevance, and execution.

## Standards, not another registry

Remote Skills connects existing open formats:

- [Agent Skills](https://agentskills.io/specification) defines `SKILL.md` and its resources.
- [Agent Skills Discovery v0.2.0](https://github.com/cloudflare/agent-skills-discovery-rfc) defines the well-known catalog, artifact URLs, and SHA-256 digests.
- HTTP provides distribution and cache validation.

Remote Skills provides the publisher CLI and model-agnostic consumer SDKs around those standards.

## Documentation

The full publisher, hosting, TypeScript, Python, caching, authentication, security, and API documentation lives in the self-hostable Fumadocs site under `apps/docs`.

## License

Apache-2.0

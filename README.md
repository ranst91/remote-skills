# Remote Skills

### Serve skills. Don't install them.

Remote Skills is an open-source toolkit for publishing and consuming [Agent Skills](https://agentskills.io/) directly from remote origins.

Publishers keep authority over their skills. Agents discover a compact catalog, activate only what they need, verify the downloaded bytes, and reuse a disposable content-addressed cache.

No marketplace. No copied installation in every agent. No proprietary skill format.

## Publish a remote skill origin

Start with ordinary Agent Skills such as `skills/code-review/SKILL.md`. Optional resources live inside the skill folder, for example `skills/code-review/references/security.md`.

With the CLI installed in your project, validate and serve them locally:

```bash
remote-skills validate
remote-skills dev
```

The development origin is available at `http://127.0.0.1:8787`.

Build deploy-ready static output:

```bash
remote-skills build
```

## I bundled it; what do I host?

Upload or mount the complete contents of `dist/` unchanged at your HTTPS origin root. For `https://skills.example.com`, the fixed catalog must resolve at `https://skills.example.com/.well-known/agent-skills/index.json`. Preserve the generated relative artifact URLs and exact response bytes or digest verification will fail. Keep archives compressed; their members already start at the archive root, with `SKILL.md` at that root rather than inside a skill-name wrapper.

Serve the generated files with these media types:

| Output | `Content-Type` |
| --- | --- |
| `index.json` | `application/json` |
| `*.md` | `text/markdown; charset=utf-8` |
| `*.zip` | `application/zip` |
| `*.tar.gz` | `application/gzip` |

Content-addressed artifacts may use immutable caching. Keep the fixed catalog on ordinary HTTP revalidation.

Configure the SDK with the origin root, such as `https://skills.example.com`, not the catalog URL. Then verify the deployed origin:

```bash
remote-skills verify https://skills.example.com
```

Private origins can use ordinary headers:

```bash
SKILLS_AUTH='Bearer …' remote-skills verify \
  https://skills.example.com \
  --header-env Authorization=SKILLS_AUTH
```

A configured scope only requests a provider-defined catalog view; it does not grant access. The provider still authenticates the caller, authorizes that view, and authorizes every artifact request.

See [Build and host](apps/docs/content/docs/hosting/archive-to-origin.mdx) for static hosting and [Git and Pages hosting](apps/docs/content/docs/hosting/git-pages.mdx) for Git-backed hosting and origin-root routing. If a small, fixed skill set should update and roll back with one container, copy or clone it into the image instead; [When to use remote skills](apps/docs/content/docs/hosting/local-or-remote.mdx) covers that choice.

## Consume skills from TypeScript

```bash
pnpm add @remote-skills/client
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

`catalog()` returns compact discovery metadata. `activate()` downloads and verifies the complete current artifact only when needed, then pins that exact digest for the session. Resource access is context-lazy: `read()` loads a selected resource from the already verified local artifact and does not make another network request.

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

The production default is a bounded disk cache, not RAM. Memory-only and custom caches are also available. Every cache is disposable, is not an installation, and is safe to rebuild from the configured origin.

A version range selects among releases currently advertised by the provider; it is not a retention guarantee. The provider may prune a release, and a new online session cannot resurrect that removed release from cached bytes.

## Trust boundary

Digest verification proves **byte integrity**: downloaded bytes match the publisher's catalog. It does **not** prove that the instructions or scripts are safe.

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

There is no managed Remote Skills service. You host the exact static build output and integrate a consumer SDK into your own host application. For Vercel AI SDK, the [integration](apps/docs/content/docs/vercel-ai-sdk.mdx) connects remote skills to its existing skill loader.

See the [integration package](integrations/ai-sdk/README.md) and [TypeScript chat demo](examples/vercel-ai-sdk/README.md) for package details and a runnable example. For LangChain and DeepAgents, start with the [integration guide](apps/docs/content/docs/integrations/langchain.mdx), then use the [TypeScript adapter](integrations/langchain/README.md), [Python adapter](integrations/langchain-python/README.md), and [six-path Next.js demo](examples/langchain/README.md).


## Documentation

Start with the [Quickstart](apps/docs/content/docs/quickstart.mdx): install the packages, publish a greeting skill, and use its instructions in your agent.

The documentation site under `apps/docs` groups the rest into Publish, Consume, Integrations, Concepts, and Reference.
Runnable examples and their setup commands are indexed in [examples/README.md](examples/README.md).

## License

Apache-2.0

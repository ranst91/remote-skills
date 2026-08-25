## Context

See [proposal.md](proposal.md) for motivation and scope. The repository currently contains only a conceptual README. The implementation must connect two existing standards without changing them: Agent Skills defines the source directory and `SKILL.md`; Cloudflare discovery draft v0.2.0 defines the remote catalog, artifact types, URLs, and SHA-256 digest.

The central constraint is that “remote” describes authority and acquisition, not repeated context fetching. An archive is downloaded and verified as one immutable object at activation; its `SKILL.md` enters context first, and resources are read from the pinned local object only when the host agent requests them.

## Goals / Non-Goals

**Goals:**

- One repository and release process for a deterministic publisher CLI, TypeScript consumer, async Python consumer, protocol fixtures, examples, and docs.
- A compact discovery path and an immutable activation path with no mid-session updates.
- Exact TypeScript/Python behavior where it affects wire requests, security, cache state, and host applications.
- Deploy-ready static output that works on any conforming HTTPS host.
- Fail-closed handling of untrusted catalogs, archives, paths, redirects, credentials, and cache writers.

**Non-Goals:**

- Sharing implementation code between TypeScript and Python at runtime.
- Fetching individual archive resources over the network after activation.
- Executing scripts, selecting relevant skills, enforcing `allowed-tools`, or assigning trust to content.
- A hosted control plane, marketplace, deploy command, MCP bridge, browser bundle, or framework adapter.

## Decisions

### 1. Monorepo shape and dependency direction

```text
remote-skills/
├── apps/
│   └── docs/                    # Fumadocs
├── packages/
│   ├── core/                    # private TypeScript protocol/build/cache code
│   ├── cli/                     # @remote-skills/cli; binary remote-skills
│   ├── sdk-typescript/          # @remote-skills/client
│   └── sdk-python/              # PyPI remote-skills; import remote_skills
├── tests/
│   └── protocol/
│       ├── fixtures/            # immutable wire/archive/filesystem inputs
│       └── expected-results/    # language-neutral normalized outcomes
├── examples/
│   ├── publisher/
│   ├── typescript-consumer/
│   └── python-consumer/
├── skills/                      # optional repository dogfood skills later
└── openspec/
```

pnpm workspaces and Turborepo orchestrate Node.js 24+ packages and the docs application. uv owns Python 3.11+ environments, lock state, build, tests, and publication. Turborepo treats uv operations as explicit tasks with declared inputs and outputs.

`packages/core` is private and may be used only by the CLI and TypeScript SDK. Python independently implements the consumer contract. Shared executable fixtures—not language bindings—prevent accidental semantic drift.

Alternatives rejected:

- **One npm package for CLI and SDK:** convenient initially, but creates an unnecessary coupled public API and makes later version separation painful.
- **Nx:** stronger project graph and polyglot modeling, but more operational surface than this initial repository needs.
- **Root scripts only:** simple, but insufficient dependency ordering and cache discipline across packages, docs, and uv.

### 2. Standards are explicit modules, not “best effort” parsing

The publisher validates the current canonical Agent Skills format. The discovery layer recognizes exactly:

```text
https://schemas.agentskills.io/discovery/0.2.0/schema.json
```

Missing, v0.1, or unknown discovery schemas return `unsupported_schema`; no heuristic upgrade or fallback occurs. Within recognized v0.2.0 documents, unknown fields are ignored as the RFC requires. Local `remote-skills.json` does the opposite and rejects unknown keys because local typos should fail immediately.

The v0.2.0 parser, URL resolver, digest grammar, and fixture set live behind an internal versioned protocol boundary so a later discovery schema can be added alongside it rather than silently changing v0.2 behavior.

Alternative rejected: accepting v0.1 catalogs. Their lack of content digests contradicts the product's immutable verification guarantee.

### 3. Declarative publisher configuration

The initial JSON shape is:

```json
{
  "$schema": "https://remote-skills.dev/schemas/config/0.0.1.json",
  "sourceRoots": ["skills"],
  "outDir": "dist",
  "format": "tar.gz",
  "strict": false,
  "limits": {
    "catalogBytes": 1048576,
    "archiveBytes": 52428800,
    "extractedBytes": 104857600,
    "files": 1000,
    "fileBytes": 10485760
  },
  "dev": {
    "host": "127.0.0.1",
    "port": 8787
  }
}
```

All fields are optional and receive these defaults. Paths are project-relative. CLI flags override effective configuration without rewriting the file. Authentication values do not belong in this file; `verify` accepts literal headers for basic use and environment-variable references for secrets.

Alternative rejected: executable TypeScript configuration. It adds code execution to validation/build, makes behavior language-specific, and weakens deterministic configuration hashing.

### 4. Source selection and safety

Each immediate child of each source root is one candidate. A candidate must contain regular-file `SKILL.md`; its directory name and frontmatter name match. Default exclusions cover `.git`, dependency/cache/build directories, OS metadata, `.env*`, common private-key names, and other obvious secrets. `.skillignore` adds gitignore-style patterns after defaults but cannot re-include safety exclusions.

All symlinks and hard links are rejected, even those currently resolving inside the tree. This is stricter than Cloudflare's minimum but removes time-of-check/time-of-use escapes and cross-platform archive ambiguity. Markdown links remain normal text references and are validated separately when local.

### 5. Deterministic publisher output

Default output:

```text
dist/
└── .well-known/
    └── agent-skills/
        ├── index.json
        └── artifacts/
            ├── sha256-<hex>.md
            ├── sha256-<hex>.tar.gz
            └── sha256-<hex>.zip
```

The index is UTF-8 JSON with stable key order, skills sorted by name, two-space indentation, and one trailing newline. URLs are relative to the index directory. An artifact path includes its full digest, making immutable caching safe and allowing identical bytes to deduplicate.

Single-file skills use `skill-md` unless `--archive` is set. Resource-bearing skills use archives. Archive entries are relative POSIX paths at archive root. Entries are byte-sorted; files use normalized mode `0644`, directories `0755`, UID/GID zero, empty owner/group, and fixed timestamps. Gzip header time/OS fields and compression settings are fixed. ZIP uses the minimum representable fixed timestamp, stable UTF-8 flags, no comments/extras, and fixed compression settings. Source executable bits are intentionally not authority; scripts are distributed as data.

The builder writes a complete sibling staging directory, fsyncs completed artifacts where supported, then atomically replaces the previous output. `dev` calls the same build pipeline and serves only a completed output pointer. It does not invent a live-update channel.

### 6. Public consumer API

TypeScript:

```ts
const client = createRemoteSkills({
  origins: {
    acme: {
      url: "https://skills.example.com",
      headers: { Authorization: `Bearer ${token}` },
      timeoutMs: 30_000,
      retries: 2,
    },
  },
});

const aggregate = await client.catalog({ strict: false });
const session = await client.session("acme");
const entries = await session.catalog();
const skill = await session.activate("code-review");

skill.name;
skill.description;
skill.digest;
skill.instructions;
skill.frontmatter;
await skill.list("references/");
await skill.read("references/security.md");
await skill.readBytes("assets/template.bin");

await session.close();
await client.refresh("acme");
```

Python:

```python
client = RemoteSkills(
    origins={
        "acme": Origin(
            url="https://skills.example.com",
            headers={"Authorization": f"Bearer {token}"},
            timeout=30.0,
            retries=2,
        )
    }
)

aggregate = await client.catalog(strict=False)
async with client.session("acme") as session:
    entries = await session.catalog()
    skill = await session.activate("code-review")
    instructions = skill.instructions
    reference = await skill.read("references/security.md")

await client.refresh("acme")
```

The concrete names above are the intended v0 public seam. TypeScript additionally supports async disposal; Python is async-only. `client.catalog()` aggregates origin-qualified entries and failures. `session.catalog()` is one-origin and throws. `session.activate()` never decides relevance: the host agent or application supplies the name.

`ActivatedSkill.instructions` is the Markdown body and `frontmatter` is the parsed standard metadata. `read()` validates strict UTF-8. `readBytes()` returns `Uint8Array` or `bytes`. `list()` returns normalized path, size, and media type without content.

### 7. Catalog snapshots, refresh, removal, and offline use

A session obtains one immutable catalog snapshot. Normal HTTP freshness, ETag, and Last-Modified semantics determine whether its once-per-session consultation needs a transfer. `client.refresh(alias?)` performs forced conditional revalidation and updates the shared catalog state for future sessions only.

If an online refreshed catalog removes a skill, new sessions no longer see or activate it. Existing sessions retain their already pinned bytes. Offline stale mode can expose the removed entry only because it explicitly uses an older catalog; the session is marked stale and the configured maximum age bounds that behavior.

No polling occurs. The application starts a new session when it wants a new catalog generation.

### 8. Activation pipeline and validation order

Activation follows one order in both languages:

1. Resolve the entry from the session snapshot.
2. Validate type, digest grammar, and URL under origin policy.
3. Acquire a digest pin/lease.
4. Use an already verified object, or perform the bounded request.
5. Stream raw bytes to a private temporary file while hashing and enforcing compressed size.
6. Compare the complete hash before cache publication.
7. For `skill-md`, parse that exact file; for archives, perform metadata-first safety checks and bounded extraction to a private directory.
8. Validate root `SKILL.md`, normalized file table, and standard frontmatter.
9. Atomically publish immutable artifact/extraction metadata.
10. Return an activated view bound to the session and digest.

Digest, schema, policy, and archive errors are terminal and never retried. Idempotent network failures, 408, 429, and 5xx use bounded jittered backoff up to the configured two retries and honor a capped Retry-After. Closing a session releases leases; it never deletes content directly.

### 9. Shared disk cache

Both SDKs implement a documented `cache-v1` layout beneath the OS cache directory:

```text
remote-skills/
└── cache-v1/
    ├── catalogs/<origin-sha256>/
    │   ├── body.json
    │   └── metadata.json
    ├── objects/sha256/<first-two>/<remaining>/
    │   ├── artifact
    │   ├── object.json
    │   └── root/...
    ├── leases/<digest>/<process-and-session-nonce>.json
    └── tmp/...
```

The origin identifier hashes the canonical well-known index URL, never headers. Catalog metadata stores validators, freshness, retrieval time, and sanitized URL state but no headers. Object metadata contains only verified digest, artifact type/format, sizes, normalized file table, and access timestamps.

Writers create random same-filesystem temporary paths, stream and verify, then use no-clobber atomic publication. Losing writers discard their temporary object after verifying the winner. Readers ignore all temporary paths. Per-session lease files are atomically created and periodically renewed; eviction skips live leases. Expired leases are reclaimable after conservative age and process-liveness checks. LRU bookkeeping is advisory, while object integrity is always rechecked against immutable metadata before reuse.

Memory-only and custom caches implement the same semantic interface but need not reproduce the disk layout.

### 10. Archive normalization and resource access

Extraction first reads central-directory/header metadata without eagerly expanding unrelated entries. It rejects:

- absolute, drive-prefixed, NUL-containing, invalid UTF-8, dot-segment, or escaping paths;
- duplicate normalized paths and portable case collisions;
- symlinks, hard links, devices, FIFOs, sockets, or other special entries;
- missing/non-regular root `SKILL.md`;
- per-file, total-size, or count declarations over configured limits;
- actual streamed sizes exceeding declarations or limits.

The entire verified archive is local after activation. Resource reads are context-lazy but make no further network calls. Media type is conservative extension-based metadata only; it does not authorize parsing or execution.

### 11. Network and credential boundary

Origin configuration accepts HTTPS. Explicit loopback development configuration may use HTTP. URLs with embedded userinfo are rejected, sensitive configuration is header-based, and diagnostics sanitize URL query and fragment data.

Every initial connection and redirect is checked at connection time against policy. Default policy rejects private, loopback, link-local, multicast, unspecified, and other non-public IP ranges, except the explicit loopback development origin. Redirects are capped at five and re-evaluated independently to resist DNS rebinding and public-to-private redirect chains.

Headers belong to one configured host boundary. Same-host requests receive that origin's headers. A cross-host CDN URL is allowed only by URL policy and receives no source-origin headers. An operator can add explicit host-scoped artifact headers in origin configuration; those headers apply only to that exact host boundary.

Alternative rejected: forwarding headers on RFC URL resolution. It is convenient for private CDNs but turns an origin-controlled URL into a credential-exfiltration primitive.

### 12. Error and diagnostic contract

The protocol package defines stable snake-case codes, including:

```text
configuration_invalid
origin_unavailable
request_timeout
catalog_invalid
unsupported_schema
skill_not_found
artifact_unsupported
digest_mismatch
archive_unsafe
limit_exceeded
resource_not_found
resource_not_text
path_invalid
policy_denied
session_closed
cache_corrupt
```

Errors carry sanitized structured fields such as origin alias, skill name, digest, path, status, and retryability. Raw response bodies, instructions, resources, headers, and complete credential-bearing URLs never enter errors or default logs. Debug logging is opt-in, local, metadata-only, and sink-injected for tests.

### 13. Compatibility fixtures and test ownership

Package-local unit tests stay beside their implementation. Shared fixtures contain exact input bytes and static expected results. Fixtures cover catalogs, URL resolution, redirects, retry schedules, both archive types, malformed archives, Unicode/path cases, limits, deterministic publisher bytes, cache races, offline state, and cross-language cache reuse.

Expected results are reviewed artifacts, not regenerated by the implementation under test. Linux, macOS, and Windows CI run both consumers and deterministic builder fixtures. Dedicated race tests use multiple TypeScript/Python processes against one cache directory.

### 14. Documentation and release sequence

The current README is replaced only after the complete proposed text is pasted to the user and approved. It remains a minimal promise and quickstart. Fumadocs owns the detailed publisher, hosting, TypeScript, Python, cache, auth, security, offline, and release documentation. Examples are executed or compiled in CI.

Tag-driven publishing uses npm and PyPI Trusted Publishing with short-lived OIDC identity, protected environments, package dry runs, provenance/attestations where available, and no long-lived registry token in the repository. All packages begin coordinated. A legitimate Python `0.0.1.dev0` claims the PyPI project after approval; the first intended non-development tag is `0.0.1`.

## Risks / Trade-offs

- **Cloudflare discovery is still a draft** → Pin schema v0.2.0 explicitly, isolate its parser, and add future schemas rather than silently changing behavior.
- **Two independent consumer implementations can drift** → Make shared fixtures and cache interoperability release-blocking on all supported platforms.
- **Cross-process cache leases add complexity** → Keep immutable publication independent from eviction metadata; crashes can leak cache space temporarily but cannot expose corrupt objects.
- **Deterministic ZIP/tar behavior is easy to get subtly wrong** → Check exact golden bytes and digests across operating systems, not merely extracted equality.
- **Static authorization headers can expire** → v0 stays intentionally basic; applications recreate clients or supply updated configuration. OAuth and credential managers remain deferred.
- **Full archive activation uses more bandwidth than resource-level fetching** → This is required by the chosen RFC artifact model; progressive disclosure saves model context, not download bytes.
- **Rejecting all symlinks is stricter than the RFC minimum** → Portability and safety outweigh preserving link semantics in v0.
- **Offline stale mode weakens publisher revocation** → Keep it opt-in, age-bounded, and visibly marked; default new sessions fail closed.
- **A verified digest does not make instructions safe** → Documentation and APIs consistently describe verification as byte integrity only, and no execution helper is provided.

## Migration Plan

There is no installed product or data migration.

1. Land and approve these OpenSpec artifacts.
2. Paste and approve the replacement README before starting implementation.
3. Build the repository foundation and static protocol fixtures.
4. Implement publisher and consumers behind the fixture contract.
5. Complete cross-platform, docs, packaging, and publication dry-run gates.
6. Register PyPI Trusted Publishing and publish `0.0.1.dev0` to claim the name.
7. Publish `0.0.1` only after every v0 acceptance gate is green.

A faulty static-origin release is rolled back by redeploying the prior index and immutable artifact set. Client sessions already pinned to either digest remain internally consistent.

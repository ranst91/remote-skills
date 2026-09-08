## Context

See [proposal.md](proposal.md) for motivation and scope. The repository currently contains only a conceptual README. The implementation must connect two existing standards without changing them: Agent Skills defines the source directory and `SKILL.md`; Cloudflare discovery draft v0.2.0 defines the remote catalog, artifact types, URLs, and SHA-256 digest.

The central constraint is that “remote” describes authority and acquisition, not repeated context fetching. An archive is downloaded and verified as one immutable object at activation; its `SKILL.md` enters context first, and resources are read from the pinned local object only when the host agent requests them.

## Goals / Non-Goals

**Goals:**

- One repository and release process for a deterministic publisher CLI, TypeScript consumer, async Python consumer, protocol fixtures, examples, and docs.
- A compact discovery path and an immutable activation path with no mid-session updates.
- Exact TypeScript/Python behavior where it affects wire requests, security, cache state, and host applications.
- Deploy-ready static output that works on any conforming HTTPS host.
- Provider-authorized catalog views and optional, deterministic SemVer selection without replacing the Cloudflare discovery format.
- Fail-closed handling of untrusted catalogs, archives, paths, redirects, credentials, and cache writers.

**Non-Goals:**

- Sharing implementation code between TypeScript and Python at runtime.
- Fetching individual archive resources over the network after activation.
- Executing scripts, selecting relevant skills, enforcing `allowed-tools`, or assigning trust to content.
- A hosted control plane, marketplace, deploy command, MCP bridge, browser bundle, or framework adapter.
- A client-side blacklist, whitelist, or authorization policy language, and generated TypeScript/Python catalog types.

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
│   └── sdk-python/              # distribution name remote-skills; import remote_skills
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

pnpm workspaces and Turborepo orchestrate Node.js 24+ packages and the docs application. uv owns Python 3.11+ environments, lock state, local distribution builds, and tests. Turborepo treats uv operations as explicit tasks with declared inputs and outputs.

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

### 2a. Remote Skills extensions remain ignorable

Cloudflare discovery v0.2.0 stays the base wire contract. Remote Skills uses only additive fields that an ordinary v0.2.0 consumer is required to ignore. Standard top-level skill fields always describe the provider's current release, so a consumer that does not understand Remote Skills scope or version extensions can still discover and activate it.

The v0 extension namespace is the entry-level `x-remote-skills` object. A version-aware entry has this bounded form:

```json
{
  "name": "code-review",
  "description": "Reviews code.",
  "type": "archive",
  "url": "artifacts/sha256-current.tar.gz",
  "digest": "sha256:current",
  "x-remote-skills": {
    "version": "2.0.0",
    "releases": [
      {
        "version": "2.0.0",
        "type": "archive",
        "url": "artifacts/sha256-current.tar.gz",
        "digest": "sha256:current"
      },
      {
        "version": "1.4.7",
        "type": "archive",
        "url": "artifacts/sha256-previous.tar.gz",
        "digest": "sha256:previous"
      }
    ]
  }
}
```

The examples abbreviate digests for readability; wire values retain the standard lowercase `sha256:<64-hex>` grammar. `version` is strict SemVer. `releases` contains the current descriptor as well as every advertised historical descriptor and has at most 100 members per skill in v0. Each member contains exactly `version`, `type`, `url`, and `digest`. Members have unique exact version strings and are sorted by descending SemVer precedence, then lexical version string as the deterministic build tie-break. The extension's `version` and matching release descriptor must reproduce the standard top-level `type`, `url`, and `digest` exactly. Invalid, ambiguous, duplicate, oversized, or conflicting extensions fail closed as `catalog_invalid`.

The publisher interprets standard Agent Skills `metadata.version`, when present, as the current strict SemVer value. Version metadata remains optional. A version-aware build may carry forward only verified prior output that the provider supplies; every retained content-addressed artifact is copied unchanged. Reusing one skill name and version with different `type`, `url`, or `digest` fails the build. The provider may explicitly prune history, and a build without prior output advertises only releases actually available in that output. No consumer baseline creates a provider obligation to retain an unavailable release.

Alternatives rejected:

- **Replace standard entry fields with a version manifest:** breaks ordinary Cloudflare clients and adds another request/caching boundary.
- **Infer versions from digests or timestamps:** produces labels with no SemVer meaning.
- **Make versions mandatory:** needlessly rejects valid latest-only Agent Skills origins.

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

The builder keeps content-addressed artifacts immutable and makes a new generation visible by atomically replacing the fixed `index.json` pathname after every referenced artifact is durable. It preserves the immediately previous index generation's artifacts while concurrent readers can still hold that catalog, then reclaims only verified unreferenced builder artifacts. Cooperative build processes serialize publication for one output directory. `dev` calls the same build pipeline and serves either the complete prior index generation or the complete next index generation. It does not invent a live-update channel.

The v0 publisher is implemented with the public, portable Node.js filesystem API. It rejects symlinks or reparse points already present in the project-relative output chain, retains handles and rename-sensitive filesystem-generation evidence for that chain, and rechecks the intended output and exact published bytes before reporting success. Final verification detects any ancestor or output swap during the command, including an ABA swap restored before that verification, and fails closed; a build never reports success for an intended output whose final index or referenced artifacts differ from the generation it built. Normal cooperative concurrent publishers remain serialized.

This is a verification boundary, not an operating-system access-control boundary. Portable Node.js does not expose descriptor-relative `openat`/`renameat`/`unlinkat`, conditional pathname replacement, or a cross-platform advisory file lock. A malicious same-UID local process can therefore rename an ancestor after the publisher's last check but before a pathname-based mutation. V0 does not promise to prevent or undo a write redirected by that race. The publisher still performs final retained-generation and exact-content verification and fails when the intended output no longer matches; mutation after successful return is likewise outside the command's lifetime. Strong prevention requires an OS-specific native adapter or publishing each build to a new one-shot output followed by an external deployment-pointer switch, both deferred from v0.

The complete output directory is the deployment unit. An operator maps `dist/` to the HTTPS origin root and serves `/.well-known/agent-skills/index.json` plus every referenced artifact byte-for-byte. Archives remain compressed and must not be unpacked, recompressed, renamed, or placed beneath an extra wrapper directory. JSON is served as `application/json`, Markdown as `text/markdown; charset=utf-8`, ZIP as `application/zip`, and tar-gzip as `application/gzip`; content-addressed artifacts may use immutable cache directives while the catalog uses ordinary revalidation. The catalog digest always covers the exact artifact response bytes.

Git may remain the authoring source of truth without becoming a second SDK transport. The supported Git-backed path is repository source → CI build → generated `dist/` → GitHub Pages, GitLab Pages, another static Pages product, or a custom-domain host. A project site mounted at `/repository-name/` does not satisfy the origin-root well-known URL; it requires a dedicated hostname, a custom domain, or host routing that maps `dist/` to `/`. SDKs do not clone repositories or special-case raw Git hosting.

Remote Skills is not always preferable to local files. A small, fixed, application-owned skill set that should update and roll back with its container should be copied or cloned into the image. Remote Skills is intended for independently owned releases, many consumers, selective activation, digest verification, or updating future sessions without redeploying every agent.

### 6. Public consumer API

TypeScript:

```ts
const client = createRemoteSkills({
  origins: {
    acme: {
      url: "https://skills.example.com",
      headers: { Authorization: `Bearer ${token}` },
      scope: "engineering",
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
            scope="engineering",
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

Both public clients accept an optional SemVer range when selecting or activating a named skill. The range itself is the public policy rather than separate baseline/update-mode fields. Supported forms follow standard SemVer, including `*`, `1.x`, `1.4.x`, `^1.4.2`, `~1.4.2`, and exact `1.4.2`; the restrictive forms contain their explicit baseline. The precise idiomatic method overload is owned by the language task, but equivalent calls must normalize to the same range and fixture result.

`ActivatedSkill.instructions` is the Markdown body and `frontmatter` is the parsed standard metadata. `read()` validates strict UTF-8. `readBytes()` returns `Uint8Array` or `bytes`. `list()` returns normalized path, size, and media type without content.

### 6a. Scope requests are authorization inputs, not grants

`scope` is an optional provider-defined requested catalog view. For catalog requests the SDK sends its value in the `Remote-Skills-Scope` HTTP request header. Values are non-secret visible ASCII strings from 1 through 128 bytes; control characters, leading/trailing whitespace, commas, and multiple header instances are rejected as `configuration_invalid`.

The provider authenticates the ordinary configured credentials and authorizes the requested view. Invalid or missing required authentication returns HTTP `401`; a valid identity that may not access the requested view returns `403`. Every successful `200` or `304` scoped catalog response returns exactly one `Remote-Skills-Scope` response header containing the same canonical scope requested by the client; a missing or different value fails closed. Providers therefore expose canonical scope names rather than response-time aliases. Merely configuring `scope: "engineering"` never establishes membership or grants access.

The response header is also the cache-safety confirmation. A confirmed canonical scope means every principal allowed to reuse that scope receives a cache-equivalent catalog view. A provider that personalizes entries inside a named scope must require the application to configure a more-specific scope or send `Cache-Control: no-store`. Authenticated catalog responses without a configured and matching confirmed scope remain memory-only and are not written to the persistent catalog cache. `no-store` always wins. Credentials, token hashes, and header values never become cache keys or metadata.

Scope filtering is not artifact authorization. Same-origin artifact requests continue to carry the origin's configured host-scoped credentials, and the provider must authorize each artifact. Cross-host artifacts receive only separately configured headers under the existing credential boundary; the provider must arrange equivalent protection or use authorized opaque URLs. The `Remote-Skills-Scope` request header is defined for catalog selection, not forwarded automatically to an unconfigured artifact host.

Stable sanitized failures include `authentication_failed` for `401`, `authorization_denied` for `403`, and `version_unavailable` for version selection. Context may contain origin alias, non-secret scope, skill name, and requested range, but never credentials, response bodies, or complete credential-bearing URLs.

### 7. Catalog snapshots, refresh, removal, and offline use

A session obtains one immutable catalog snapshot. Normal HTTP freshness, ETag, and Last-Modified semantics determine whether its once-per-session consultation needs a transfer. `client.refresh(alias?)` performs forced conditional revalidation and updates the shared catalog state for future sessions only.

If an online refreshed catalog removes a skill, new sessions no longer see or activate it. Existing sessions retain their already pinned bytes. Offline stale mode can expose the removed entry only because it explicitly uses an older catalog; the session is marked stale and the configured maximum age bounds that behavior.

No polling occurs. The application starts a new session when it wants a new catalog generation.

A session snapshot also records its confirmed scope and chosen release descriptors. On each new online session, the current catalog is authoritative. For a versioned skill the client selects the highest advertised stable release satisfying the requested SemVer range. Prereleases are excluded unless the range explicitly includes a prerelease comparator for the relevant version. No constraint or `*` selects the highest advertised stable release; for an unversioned entry either selects the current top-level artifact. A restrictive range against an unversioned entry or any range with no compatible advertised release fails `version_unavailable` without silently using current/latest.

Existing sessions remain pinned to their authorized catalog generation, selected version, descriptor, and digest. A later compatible release affects only a future session. A release absent from a newly validated online catalog cannot be resurrected for that session from the object cache. An explicitly stale session may resolve against its bounded older catalog snapshot, is marked stale, and otherwise follows the same deterministic range rules.

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
    ├── leases/<digest>/<process-session-and-lease-nonce>.json
    └── tmp/
        ├── coordination-v1/
        │   ├── locks/<digest>/
        │   │   ├── <owner-nonce>.intent
        │   │   └── <zero-padded-ticket>-<owner-nonce>.lock
        │   └── processes/<digest>/<process-nonce>.json
        └── <private-random-name>/writer.json
```

The catalog identifier hashes the canonical well-known index URL plus the confirmed non-secret scope when one exists, never credentials or other headers. An authenticated response without a confirmed scope is not persisted. Catalog metadata stores the confirmed scope, validators, freshness, retrieval time, and sanitized URL state but no credentials or arbitrary headers. Object metadata contains only verified digest, artifact type/format, sizes, normalized file table, and access timestamps.

Writers create random same-filesystem temporary paths, stream and verify, then use no-clobber atomic publication. Each active lease or writer references the same digest-scoped `remote-skills-cache-process-registration-v1` record by `process_nonce`; writer metadata uses `remote-skills-cache-writer-v1` and never substitutes a runtime-specific identity field. `process_identity` is optional and is used only when a peer can verify that platform token; otherwise peers require a live PID and a fresh registration heartbeat. Losing writers discard their temporary object after verifying the winner. Readers ignore all temporary paths.

Per-session lease files are atomically created, carry a unique persisted `lease_nonce`, and are periodically renewed; eviction skips live leases owned by either runtime. Lease acquisition and the final eviction pin-check-through-removal interval serialize through one digest-scoped Lamport bakery gate. A contender first publishes a live process registration, then a generation-unique `remote-skills-cache-mutation-intent-v1` record, selects an integer ticket from the bounded current record set, and publishes its immutable `remote-skills-cache-mutation-lock-v1` record. The intent remains published through the critical section so no directory-observation window can miss both phases; release removes the ticket and intent before the registration. Ticket number plus owner nonce gives a total cross-runtime order. Its optional `operation` discriminator records `acquire`, `evict`, or another `mutation`: an acquisition that observed an eviction-owned gate and then finds that eviction won fails instead of returning a handle to a removed object, while an acquisition that owns the gate first publishes its lease before eviction can make its final decision. The cross-runtime order is fixed: acquire the shared mutation gate first, then any runtime-compatibility lock, and release in reverse; no path waits for the shared gate while holding a compatibility lock. Unknown lock schemas are preserved conservatively. Every intent and lock pathname contains its owner generation and is never reused, eliminating the non-portable snapshot-check-to-fixed-path-unlink race. Crashed gate owners are reclaimed only after bounded age and registration/process-identity checks. The acquisition nonce keeps an old handle distinct after its lease directory and generation tombstone have been finitely reclaimed and later recreated, even under clock regression. Expired leases are reclaimable only after conservative age and shared registration/process-liveness checks. The final lease or writer removes its registration. Bounded cleanup also traverses digest-scoped coordination state even when no lease, writer, or object was published, and removes expired dead registrations, orphan lease-generation records, and empty known-version coordination directories only after snapshot identity, liveness, and final directory-generation rechecks. Unknown versions and live or replaced state are preserved. Crashed registrations, writer state, lease-generation records, locks, and prior catalog generations are reclaimed with bounded record sizes, shared bounded scans and depths, age checks, and a final liveness/race recheck so coordination metadata cannot grow without limit while active owners remain protected. LRU bookkeeping is advisory, while object integrity is always rechecked against immutable metadata before reuse.

The eviction handoff does not rely on a read followed by separate intent publication being atomic. Before announcing a lease acquisition, the runtime anchors the filesystem identity of every directory from the cache root through any legitimate immutable object generation with a retained no-follow directory chain. After the acquisition owns the mutation gate and before it publishes a lease, it verifies both the retained handles and their current path identities; a missing, replaced, or symlinked generation or ancestor is the durable eviction outcome and makes the acquisition fail closed. A future acquisition may lease a newly published generation, while an acquisition that began without an object generation retains the ordinary pin-before-download path. Ticket selection also persists `contended_with_eviction: true` in the successor's immutable ticket when it directly observes an eviction predecessor, covering predecessor release before the first turn-state scan. The bounded object ancestor chain itself and the ordinary successor ticket bound both signals, so no eviction tombstone set or new cleanup lifecycle is introduced.

Memory-only and custom caches implement the same semantic interface but need not reproduce the disk layout.

The default production cache is on disk, not a promise to eliminate local storage. Activation downloads the complete artifact, verifies it, and extracts an archive locally before returning; only instructions and explicitly read resources enter application/model memory. Persistent cache volumes let container replicas reuse immutable objects. An ephemeral cache repeats network, hashing, extraction, and storage work after restart, so documentation presents that cost honestly and recommends local image bundling when independent remote distribution is not needed.

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
authentication_failed
authorization_denied
skill_not_found
version_unavailable
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

Expected results are reviewed artifacts, not regenerated by the implementation under test. The primary Linux CI lanes run both consumers and deterministic builder fixtures; a focused Windows lane clean-installs and exercises each public distribution. Dedicated race tests use multiple TypeScript/Python processes against one cache directory.

### 14. Documentation and release sequence

The current README is replaced only after the complete proposed text is pasted to the user and approved. It remains a minimal promise and quickstart, but must answer “I bundled it; what exactly do I host?” with the complete `dist/` deployment unit, origin-root mapping, catalog/artifact paths, exact-byte/digest rule, MIME types, archive-root rule, and consumer origin URL. Fumadocs owns the detailed publisher, hosting, TypeScript, Python, cache, auth, scope, version, security, offline, and release documentation. Examples are executed or compiled in CI.

Git-backed hosting is a v0 release requirement. The docs and runnable/static examples cover Git repository → CI → GitHub Pages, GitLab Pages, another Pages provider, or custom-domain static origin, including the project-subpath versus origin-root well-known-path caveat. A deployment decision guide explains when Docker/image-local cloning is the simpler correct solution. Cache guidance distinguishes disk from RAM, full artifact download from context-lazy resource reads, and persistent volumes from repeated ephemeral-container cost.

The repository produces coordinated `0.0.1` npm tarballs and Python wheel/source-distribution artifacts for local inspection and clean-install smoke tests only. It contains no npm/PyPI upload step, Trusted Publishing/OIDC registry configuration, publication credential, name-reservation action, or tag-triggered publication workflow. Publication-readiness evidence records artifact contents, hashes, and installation results without contacting a registry or claiming ownership of a package name.

### 15. Agent-accessible entry points stay conventional and small

Remote Skills treats coding agents as first-class readers without creating a separate agent product surface.

The repository has one concise root `AGENTS.md`. It explains the project and points to canonical architecture, ownership, setup, focused verification, full verification, and release-safety guidance. It contains only durable repository facts that an agent cannot reliably infer from package manifests or source. Detailed material remains in canonical docs rather than being copied into the instruction file. Nested or vendor-specific instruction files are not added in v0 unless a later package demonstrates a concrete conflicting need.

The built documentation site publishes a concise `/llms.txt` following the prevailing Markdown index convention. It links agents to clean Markdown representations of the canonical quickstarts, CLI, TypeScript, Python, archive-to-origin hosting, Git-backed hosting, scoped authentication/authorization, version policy, cache/offline, trust/security, and API documentation. The index is generated from or checked against the canonical docs navigation so it cannot become a second hand-maintained documentation tree. Essential information does not exist only inside client-rendered UI, screenshots, or interactive tabs.

This is an accessibility and discoverability promise, not an intelligence benchmark. v0 does not add live-model CI, multi-agent scoring, `llms-full.txt`, an MCP documentation bridge, or duplicate instruction files for individual vendors. Existing docs build and link checks verify the artifacts are present and navigable; dedicated agent-behavior tests are deferred until real usage identifies a concrete failure mode.

### 16. Explicitly deferred extensions

v0 exposes the provider-neutral `scope` transport and enforcement contract but does not ship a blacklist, whitelist, role mapper, or rules/policy language. Providers implement those decisions in their existing authentication and authorization layer.

Catalog-derived code generation is also deferred. A later tool may generate TypeScript string unions/enums and Python `Literal`/enum types for known skill names or resource paths, analogous to OpenAPI client generation, but it is not required for v0 interoperability and must not become a runtime dependency or a substitute for catalog validation.

### 17. Authored JavaScript moves to a strict TypeScript source boundary

The approved correction migrates the 128 repository-authored JavaScript files in the baseline inventory to TypeScript. That count excludes the generated `packages/core/src/authoring/unicode-case-fold-v15.mjs`, vendored `packages/core/src/build/vendor/pako-deflate.mjs`, and immutable `tests/protocol/fixtures/adapters/typescript-noop.mjs`, which remain separately governed inputs, and leaves exactly three intentional authored `.mjs` files:

- `apps/docs/postcss.config.mjs` remains declarative PostCSS configuration;
- `packages/sdk-typescript/src/cache/protocol-worker.mjs` remains a stable process entry path; and
- `tests/protocol/adapters/typescript-protocol-adapter.mjs` remains a stable language-neutral adapter entry path.

The two stable entry-path shims contain import and launch plumbing only. Argument parsing, input/output, orchestration, protocol or domain decisions, and error handling move into adjacent typed implementations. A transition-safe checked inventory requires exactly one baseline-JavaScript or migrated-TypeScript form for every migration target during execution; each owning wave adds its final-state assertion before converting that slice. The completed inventory rejects new authored JavaScript and rejects migrated logic returning to either shim. The vendored pako file remains byte- and license-governed vendor code, while the noop fixture remains immutable protocol input; neither is made to satisfy project type policy by editing it.

All first-party TypeScript uses the strongest explicit project contract: `strict`, `noImplicitAny`, `useUnknownInCatchVariables`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, and `forceConsistentCasingInFileNames`. Explicit and implicit `any` are forbidden in authored code; uncertain external input is `unknown` and must be narrowed at its boundary. Packages may add environment-specific compiler settings but may not weaken this shared contract.

Production sources for the npm packages compile to deterministic runtime JavaScript and declaration files before packing. Package manifests and internal imports resolve emitted output rather than source TypeScript. The CLI package exposes the emitted JavaScript entrypoint with its shebang as the first bytes and executable archive mode preserved. Local tarballs contain the intended emitted runtime, declarations, licenses, and declared or bundled dependencies only; clean installations remain offline, registry-independent, and reproducible from locked inputs.

Repository tests, test workers, scripts, protocol tools, and examples run their `.ts` sources directly with native Node.js 24 TypeScript support. They stay within Node's erasable-syntax subset and are typechecked but are not compiled into a second test tree. Child processes use `process.execPath`, resolved script or package-manager entrypoints, argument arrays, and `shell: false` so paths containing spaces, backslashes, or Windows drive prefixes remain data rather than commands. Cross-process and Windows-focused compatibility behavior is unchanged.

The CI topology is a public repository contract and does not change during the correction: jobs remain exactly `check`, `test (core)`, `test (typescript)`, `test (python)`, `test (protocol)`, `test (examples)`, `package`, and `windows`. `windows` remains the focused installed-product compatibility lane; the other responsibility groups keep their existing ownership and do not duplicate nested Turbo work.

Every conversion wave begins by adding and running independently scoped RED contracts for the files it owns, performs only the conversions needed to make that slice green, and reaches its own `pnpm test:repository` green checkpoint before any dependent consumer wave begins. Explicitly independent waves with disjoint ownership may run concurrently, but each must satisfy that checkpoint independently. The baseline inventory check is transition-safe rather than an always-RED assertion about the eventual tree. Final-state assertions live in and remain enforced by their owning waves. Root scripts and repository tests use an explicit, bounded pre/post path table while package and tool paths are in flight; after all conversion waves, a bounded root-convergence task updates every renamed command/path consumer, removes transitional alternatives, and proves the final exact paths. Protocol fixtures and expected results remain static reviewed inputs. Package and portability acceptance compares observable requests, errors, bytes, modes, process behavior, and offline installation rather than accepting a rename-only result.

The independent release-automation owner retains exclusive ownership of `.github/workflows/prepare-release.yml`, `.github/workflows/publish-release.yml`, `scripts/release/**`, and `docs/maintainers/releases.md`. Migration owners never create, edit, delete, or absorb those files and this correction does not broaden publication authority. After the typed paths and emitted package layout stabilize, the migration owner hands the exact path and command changes to the independent owner. If its separate task requires reconciliation, only that owner creates or edits the release paths and returns focused evidence; if the paths are absent or no change is required, it returns explicit no-op evidence. Migration convergence consumes that evidence and never silently repairs release automation.

## Risks / Trade-offs

- **Cloudflare discovery is still a draft** → Pin schema v0.2.0 explicitly, isolate its parser, and add future schemas rather than silently changing behavior.
- **Two independent consumer implementations can drift** → Make shared fixtures and cache interoperability release-blocking in the primary CI lanes and exercise both installed clients on Windows.
- **Cross-process cache leases add complexity** → Keep immutable publication independent from eviction metadata; crashes can leak cache space temporarily but cannot expose corrupt objects.
- **Deterministic ZIP/tar behavior is easy to get subtly wrong** → Check exact platform-independent golden bytes and digests in the deterministic-build gate, not merely extracted equality.
- **Static authorization headers can expire** → v0 stays intentionally basic; applications recreate clients or supply updated configuration. OAuth and credential managers remain deferred.
- **A scope name can be mistaken for a permission grant** → Define it only as a requested provider view, require server authentication/authorization plus response confirmation, and enforce artifacts independently.
- **Personalized catalogs can leak through shared caches** → Persist only public or confirmed cache-equivalent scope views; authenticated unconfirmed views stay memory-only and `no-store` wins.
- **Optional release history increases catalogs and can disappear** → Bound history to 100 deterministic descriptors, let providers prune explicitly, and fail clearly rather than widening a consumer's range or resurrecting removed releases online.
- **Remote distribution can cost more than image-local skills** → Document full-artifact download, disk use, persistent cache volumes, and the cases where local Docker/Git bundling is preferable.
- **Full archive activation uses more bandwidth than resource-level fetching** → This is required by the chosen RFC artifact model; progressive disclosure saves model context, not download bytes.
- **Rejecting all symlinks is stricter than the RFC minimum** → Portability and safety outweigh preserving link semantics in v0.
- **Offline stale mode weakens publisher revocation** → Keep it opt-in, age-bounded, and visibly marked; default new sessions fail closed.
- **A verified digest does not make instructions safe** → Documentation and APIs consistently describe verification as byte integrity only, and no execution helper is provided.
- **A repository-wide source conversion can hide behavioral changes** → Lead every wave with observable contracts, keep fixtures immutable, and require byte-, process-, package-, and cross-language-equivalent results before proceeding.
- **Native test TypeScript and compiled package TypeScript can drift** → Apply one non-weakening strictness contract to both, constrain native files to erasable syntax, and test emitted package entrypoints independently from source execution.
- **Renamed tooling can break only on Windows or in release automation** → Preserve argument-array process launches and the focused Windows lane, and require an explicit path handoff to the separate release-automation owner.

## Migration Plan

There is no installed product or data migration. The source-language correction is an internal build migration and must not change the wire, cache, CLI, SDK, fixture, or documentation contracts above.

1. Land and approve these OpenSpec artifacts.
2. Paste and approve the replacement README before starting implementation.
3. Build the repository foundation and static protocol fixtures.
4. Implement publisher and consumers behind the fixture contract.
5. Complete the primary Linux lanes, focused Windows installed-product checks, docs, local packaging, clean-install, and publication-readiness gates.
6. Record a green, transition-safe migration inventory and boundary harness without asserting the final tree early.
7. Convert the 128-file authored inventory in dependency-ordered RED→GREEN waves, compiling npm production sources while running tests and tools natively on Node.js 24; preserve the generated Unicode module byte-for-byte while emitting it and its declaration into the package; leave repository tests green between waves.
8. Reconcile root command/path consumers after all renames, then hand only release-owned path changes to the independent release-automation owner for focused or explicit no-op evidence.
9. Run the complete verification, local publication-readiness, and no-publication chain and record reproducible artifact hashes without publishing, reserving a name, creating a tag, or configuring a registry.

A faulty static-origin release is rolled back by redeploying the prior index and immutable artifact set. Client sessions already pinned to either digest remain internally consistent.

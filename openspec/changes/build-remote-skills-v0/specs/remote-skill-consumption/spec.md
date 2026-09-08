## Purpose

Define a model-agnostic runtime client that discovers remote skills compactly and activates verified, immutable skill snapshots on demand without installing or executing them.

## ADDED Requirements

### Requirement: Origins have explicit identities and policy
Clients SHALL accept a map of explicit origin aliases to origin URLs and optional headers, provider-defined `scope`, timeouts, retry counts, stale policy, and network policy. Aliases SHALL NOT be inferred from hosts. Aggregate catalog identities SHALL be origin-qualified, while an origin-bound session SHALL resolve short skill names only within its selected origin.

#### Scenario: Session uses contextual short name
- **WHEN** a client creates a session for alias `acme` and activates `code-review`
- **THEN** only the `code-review` entry from `acme` can be selected even if another configured origin publishes the same name

#### Scenario: Aggregate collision stays explicit
- **WHEN** two healthy origins publish `code-review`
- **THEN** the aggregate catalog returns two origin-qualified entries and applies no silent precedence

### Requirement: Requested scopes are authenticated and provider-authorized
When origin configuration contains `scope`, the client SHALL send its value in exactly one `Remote-Skills-Scope` request header on the well-known catalog request. Every successful `200` or `304` scoped response SHALL contain exactly one `Remote-Skills-Scope` response header confirming the same provider-canonical scope requested by the client. Merely naming a scope SHALL NOT grant access. The client SHALL map HTTP `401` to `authentication_failed` and `403` to `authorization_denied`, and SHALL expose only sanitized non-secret context.

Scope values SHALL be visible ASCII from 1 through 128 bytes and SHALL reject control characters, leading or trailing whitespace, commas, and multiple header instances. A malformed, missing, or non-matching confirmation on an otherwise successful scoped response SHALL fail closed as `catalog_invalid`.

#### Scenario: Engineering scope is authorized
- **WHEN** a client with valid engineering credentials requests `scope: "engineering"` and the provider authorizes and confirms that canonical scope
- **THEN** the session sees only the authorized engineering catalog view and records the confirmed non-secret scope

#### Scenario: Scope name cannot self-grant access
- **WHEN** a valid sales identity requests `scope: "engineering"` and the provider denies it
- **THEN** the request fails with `authorization_denied` and no engineering catalog body is cached or exposed

#### Scenario: Invalid credentials are distinct
- **WHEN** the provider returns `401` for an invalid credential on a scoped request
- **THEN** the request fails with `authentication_failed` without exposing the credential or response body

### Requirement: Scoped catalog persistence is cache-safe
Persistent catalog identity SHALL be derived from the canonical well-known index URL plus the confirmed non-secret scope and SHALL never include credentials, credential hashes, or arbitrary headers. A public unscoped catalog MAY use normal persistent HTTP caching. An authenticated response without a confirmed scope SHALL remain memory-only. `Cache-Control: no-store` SHALL prevent persistence in every case.

One confirmed scope SHALL identify one cache-equivalent catalog view. Providers that personalize results within a named scope SHALL require a more-specific configured scope or prevent persistence. The SDK SHALL NOT infer that two credential-bearing requests share a view merely because their requested scope strings match without a successful matching confirmation.

#### Scenario: Confirmed scopes do not leak
- **WHEN** engineering and sales responses confirm different canonical scopes at one origin
- **THEN** their persistent bodies, validators, freshness, and future-session lookups use different catalog identities

#### Scenario: Authenticated unconfirmed response stays memory-only
- **WHEN** an authenticated unscoped request succeeds without a confirmed scope
- **THEN** the current client may use the response in memory but no persistent catalog body or validator is written

### Requirement: Catalog discovery is compact and standards-bound
The client SHALL discover a configured origin only through `/.well-known/agent-skills/index.json`. It SHALL process only the explicit Cloudflare v0.2.0 `$schema`, fail closed on missing or unknown schemas, and ignore unknown fields within a recognized catalog for forward compatibility. Catalog results SHALL expose only origin, confirmed scope when present, name, description, current artifact type, URL, digest, and valid optional Remote Skills version metadata and SHALL NOT fetch skill artifacts.

#### Scenario: Catalog does not activate skills
- **WHEN** an application requests a session catalog
- **THEN** the client makes no artifact request and returns only compact discovery metadata

#### Scenario: Digest-less catalog is rejected
- **WHEN** an origin returns a v0.1-style catalog without the v0.2.0 `$schema` and digests
- **THEN** catalog discovery fails with a stable unsupported-schema error and no skill is made activatable

#### Scenario: Recognized catalog tolerates an extension
- **WHEN** a valid v0.2.0 catalog includes an unknown non-conflicting field
- **THEN** the client ignores that field and preserves all defined behavior

### Requirement: Optional Remote Skills release history is bounded and ignorable
A version-aware v0.2.0 entry SHALL retain standard top-level current fields and MAY contain `x-remote-skills` with strict SemVer `version` and `releases`. `releases` SHALL contain at most 100 descriptors, each with exactly `version`, `type`, `url`, and `digest`; it SHALL include a descriptor exactly matching the extension version and standard top-level type, URL, and digest. Versions SHALL be unique exact strings and descriptors SHALL be ordered by descending SemVer precedence with lexical version as tie-break. Invalid SemVer, ordering, bounds, duplicate versions, mismatched current data, or conflicting mappings SHALL fail as `catalog_invalid`.

Unknown fields outside the recognized extension SHALL retain Cloudflare v0.2.0 ignore behavior. A non-Remote-Skills client can ignore `x-remote-skills` and use the standard current entry.

#### Scenario: Ordinary current fields remain usable
- **WHEN** a version-aware catalog is read by a consumer that ignores `x-remote-skills`
- **THEN** the standard top-level type, URL, and digest still identify the provider's current artifact

#### Scenario: Conflicting current descriptor fails
- **WHEN** the extension version descriptor has a digest different from the standard top-level digest
- **THEN** catalog discovery fails with `catalog_invalid` before any artifact request

### Requirement: Consumers select versions with SemVer ranges
The public consumer policy SHALL use a SemVer range directly, including `*`, `1.x`, `1.4.x`, `^1.4.2`, `~1.4.2`, and exact `1.4.2`. Each new session SHALL select the highest advertised stable release satisfying the range. A prerelease SHALL be eligible only when the range explicitly contains a prerelease comparator for the relevant version. Selection SHALL be deterministic and identical in TypeScript and Python.

No constraint or `*` against an unversioned entry SHALL use its current top-level artifact. Any restrictive range against an unversioned entry SHALL fail `version_unavailable`. A versioned entry with no compatible advertised release SHALL also fail `version_unavailable`; the client SHALL NOT widen the range or silently select current/latest.

#### Scenario: Patch line selects latest compatible release
- **WHEN** a session requests `1.4.x` and the catalog advertises `1.4.2`, `1.4.7`, `1.5.1`, and `2.0.0`
- **THEN** it selects and pins `1.4.7`

#### Scenario: Restrictive range rejects an unversioned skill
- **WHEN** a session requests `1.4.x` for an entry with no Remote Skills version metadata
- **THEN** activation fails with `version_unavailable` rather than consuming the unversioned current artifact

#### Scenario: Prerelease requires explicit intent
- **WHEN** the highest otherwise compatible release is a prerelease and the requested range contains no prerelease comparator
- **THEN** the client ignores that prerelease and selects the highest compatible stable release or fails `version_unavailable`

### Requirement: Aggregate discovery reports partial failure
An aggregate catalog request SHALL return healthy origin results together with explicit per-origin failures and SHALL never silently omit an unhealthy origin. A strict aggregate option SHALL fail unless every configured origin succeeds. A single-origin session catalog request SHALL throw its typed origin failure.

#### Scenario: One origin is unavailable
- **WHEN** one of two configured origins succeeds and the other times out
- **THEN** non-strict aggregate discovery returns the healthy catalog plus a timeout failure associated with the failed alias

#### Scenario: Strict aggregate requires all origins
- **WHEN** the same request uses strict aggregate mode
- **THEN** the operation fails and retains the per-origin failure details

### Requirement: Sessions pin immutable skill identities
Creating a session SHALL establish an origin-and-confirmed-scope catalog view. Activating a skill SHALL pin the selected version when present, artifact descriptor, and exact digest for that session. Catalog refresh, scope changes, or publisher updates SHALL NOT change an already activated skill. A subsequent session MAY observe and activate a newer compatible digest.

#### Scenario: Update does not alter active session
- **WHEN** session A activates digest D1 and the publisher later advertises D2
- **THEN** session A continues to read D1 while a new session after revalidation can activate D2

#### Scenario: Repeated activation is stable
- **WHEN** one session activates the same skill name more than once
- **THEN** every activation resolves to the same pinned digest and verified contents

#### Scenario: New session applies the range again
- **WHEN** session A pins `1.4.7`, the provider later advertises `1.4.8`, and a new session requests `1.4.x`
- **THEN** session A remains on `1.4.7` while the new session selects `1.4.8`

### Requirement: Catalog removal affects only future validated sessions
When a revalidated online catalog removes an entry, sessions created from that catalog SHALL no longer list or activate the removed skill. Existing sessions SHALL retain their pinned artifact. Explicit stale-catalog sessions MAY still expose the older entry only within their configured maximum age and SHALL identify themselves as stale.

The same rule SHALL apply to an individual advertised release or authorized scope view. A new online session SHALL NOT resurrect a removed release or unauthorized entry from content-addressed cache bytes. An explicitly stale session MAY select from its bounded older snapshot and SHALL remain visibly stale.

#### Scenario: Publisher removes a skill
- **WHEN** session A has pinned a skill, refresh observes a new catalog without it, and session B is created
- **THEN** session A remains readable while session B returns `skill_not_found` for that name

#### Scenario: Publisher removes one retained release
- **WHEN** cached `1.4.7` is absent from a newly validated catalog and a new session requests `1.4.x`
- **THEN** the session selects another advertised compatible release or fails `version_unavailable` without resurrecting cached `1.4.7`

### Requirement: Activation verifies before use
Activation SHALL resolve the catalog entry, use an existing verified cache object when present, otherwise download the raw artifact, enforce byte limits, compute SHA-256 over the exact raw bytes, compare it with the declared digest, and publish the object to cache only after verification. A mismatch or interrupted download SHALL never become readable or replace a valid object.

#### Scenario: Matching artifact activates
- **WHEN** downloaded bytes match the catalog digest and the artifact is structurally valid
- **THEN** activation returns parsed instructions and metadata pinned to that digest

#### Scenario: Digest mismatch fails closed
- **WHEN** downloaded bytes do not match the catalog digest
- **THEN** activation fails with `digest_mismatch`, removes temporary bytes, and exposes no instructions or resources

### Requirement: Both discovery artifact types are consumable
The client SHALL support `skill-md` and `archive` entries. It SHALL support both `.tar.gz` and `.zip` archives, determine archive type from a supported media type with URL extension fallback, require root `SKILL.md`, and parse the activated instructions using the canonical Agent Skills format.

#### Scenario: Direct Markdown activates
- **WHEN** a valid `skill-md` artifact passes digest verification
- **THEN** its standard frontmatter and Markdown body become the activated skill and it lists only `SKILL.md`

#### Scenario: ZIP and tar fixtures agree
- **WHEN** equivalent valid ZIP and tar-gzip fixtures are activated
- **THEN** both expose the same normalized paths and skill contents

### Requirement: Archive extraction is fail-closed and bounded
Before exposing any archive resource, the client SHALL reject absolute paths, traversal, duplicate normalized paths, case-collision ambiguity on supported filesystems, symlinks, hard links, device or special files, invalid UTF-8 paths, and paths outside the skill root. It SHALL enforce defaults of 50 MiB downloaded bytes, 100 MiB extracted bytes, 1,000 files, and 10 MiB per file, with explicit configuration overrides.

#### Scenario: Link entry is rejected
- **WHEN** an otherwise valid archive contains a symlink or hard link
- **THEN** activation fails with `archive_unsafe` and no archive member becomes readable

#### Scenario: Declared expansion exceeds limit
- **WHEN** archive metadata declares a total expansion above the configured limit
- **THEN** activation rejects it before unbounded extraction or allocation

### Requirement: Activated resources are safe and explicit
An activated skill SHALL expose `read(path)` for strict UTF-8 text, `readBytes(path)` for raw bytes, and `list(prefix?)` for normalized path, byte-size, and media-type metadata. These operations SHALL address only safe relative paths within the pinned skill. `read` SHALL fail on invalid UTF-8, and all operations SHALL fail on missing resources or traversal attempts.

#### Scenario: Text reference is read lazily into context
- **WHEN** an application calls `read("references/security.md")`
- **THEN** it receives the text from the already downloaded pinned artifact without a new network request

#### Scenario: Binary access is explicit
- **WHEN** a resource is not valid UTF-8
- **THEN** `read` fails and `readBytes` returns its exact verified bytes

#### Scenario: Prefix listing returns no contents
- **WHEN** an application lists `references/`
- **THEN** it receives metadata for paths under that prefix without file bodies

### Requirement: The toolkit never executes skill content
The consumer SHALL treat instructions, scripts, assets, and references as untrusted data. It SHALL NOT execute scripts, grant permissions, interpret `allowed-tools` as authorization, or assert that verified bytes are safe. It SHALL preserve standard optional metadata so the host application can apply its own policy.

#### Scenario: Executable script remains data
- **WHEN** an activated skill contains an executable-looking `scripts/check.sh`
- **THEN** the client can list or read its bytes but never launches it or changes host permissions

### Requirement: HTTP caching uses standard validators
Catalog access SHALL honor `ETag`, `Last-Modified`, and `Cache-Control`. Each session SHALL consult its origin's catalog cache once. `client.refresh(originAlias?)` SHALL force revalidation for future sessions while permitting a standard `304 Not Modified` result and SHALL NOT mutate existing sessions.

#### Scenario: Fresh catalog avoids transfer
- **WHEN** a cached catalog remains fresh under valid HTTP cache metadata
- **THEN** session creation reuses it according to HTTP semantics without downloading its body again

#### Scenario: Explicit refresh receives 304
- **WHEN** refresh sends a conditional request and the origin reports no change
- **THEN** the cached catalog remains current and future sessions reuse its entries

### Requirement: Offline behavior is explicit
An existing session SHALL continue to use verified pinned artifacts while offline. A new session SHALL fail closed by default when its catalog cannot be validated. An explicit stale-catalog option SHALL permit a new session only when the cached catalog's verified age is within the configured maximum; stale use SHALL be surfaced in session metadata.

#### Scenario: Active session survives outage
- **WHEN** a session has activated a skill and the origin becomes unavailable
- **THEN** reads from that pinned verified skill continue without network access

#### Scenario: Expired stale catalog is refused
- **WHEN** a new offline session enables stale use but the cached catalog exceeds its maximum age
- **THEN** session creation fails with an origin-unavailable error rather than activating unvalidated state

### Requirement: Cache storage is content-addressed, bounded, and shareable
The default cache SHALL persist in the operating system's standard cache location and key immutable artifacts by verified SHA-256 digest rather than mutable skill name. The client SHALL also support memory-only and custom cache implementations. Disk caching SHALL enforce configurable size and age bounds with least-recently-used eviction, SHALL NOT evict an artifact pinned by an active session, and SHALL store no origin credentials or credential-bearing URLs.

#### Scenario: Different names deduplicate identical bytes
- **WHEN** two catalog entries resolve to the same verified digest
- **THEN** the disk cache stores one immutable artifact object while each session retains its own catalog identity

#### Scenario: Eviction skips a live pin
- **WHEN** the cache exceeds its configured size while an artifact is pinned by an active session
- **THEN** eviction selects eligible unpinned entries and the active session remains readable

### Requirement: Concurrent cache publication is atomic
TypeScript and Python processes SHALL safely share the specified disk-cache layout. Writers SHALL use private temporary paths, verify complete bytes before publication, and insert immutable objects atomically. Concurrent duplicate downloads MAY occur, but no process SHALL observe partial, corrupt, or digest-mismatched content. Stale temporary files and crashed-session leases SHALL be recoverable without deleting valid objects.

#### Scenario: Two processes activate one uncached digest
- **WHEN** TypeScript and Python clients concurrently download the same valid artifact
- **THEN** both activations succeed against the same final immutable object and neither observes the other's partial write

#### Scenario: One writer crashes
- **WHEN** a process exits after writing only part of a temporary artifact
- **THEN** another process ignores and can later clean the temporary file while the digest namespace contains no published partial object

### Requirement: Network policy prevents credential and SSRF leaks
Production origins SHALL use HTTPS. Plain HTTP SHALL be accepted only for explicitly configured loopback development. The client SHALL resolve every initial URL and redirect under policy, reject credentials, query-based secrets, private, loopback, link-local, or otherwise denied destinations unless explicitly allowed, and cap redirects. Origin headers SHALL be sent only to their configured origin. A cross-host artifact SHALL receive no origin headers unless that artifact host has separate explicit header configuration.

The provider SHALL enforce artifact authorization independently of catalog filtering. Same-origin artifact requests SHALL use the configured origin credentials under this host boundary. `Remote-Skills-Scope` SHALL select the catalog view and SHALL NOT be forwarded automatically to an unconfigured artifact host.

#### Scenario: CDN artifact receives only its own headers
- **WHEN** an origin catalog points to an allowed HTTPS CDN host with separate configured headers
- **THEN** the artifact request contains the CDN headers and not the origin's authorization header

#### Scenario: Redirect to private address is blocked
- **WHEN** a public origin redirects an artifact request to a private or loopback address
- **THEN** activation fails with `policy_denied` before transmitting configured credentials or fetching content

#### Scenario: Hidden catalog entry is not the authorization boundary
- **WHEN** a caller guesses an artifact URL that its credential may not access
- **THEN** the provider denies the artifact request and the SDK exposes a sanitized authorization failure rather than relying on catalog omission

### Requirement: Network work is bounded and retry-safe
The client SHALL default to a 30-second request timeout and at most two retries, configurable globally and per origin. It SHALL retry only idempotent catalog or artifact GETs after network failures, `408`, `429`, or `5xx`, SHALL honor bounded `Retry-After`, and SHALL never retry schema, policy, archive, or digest failures.

#### Scenario: Origin disables retries
- **WHEN** one origin configures `retries: 0` and its artifact GET fails transiently
- **THEN** activation returns the first typed failure without another request

#### Scenario: Digest failure is not retried
- **WHEN** an artifact response completes with a digest mismatch
- **THEN** exactly one artifact request is made regardless of the retry setting

### Requirement: Sessions have explicit lifecycle
TypeScript sessions SHALL support `close()` and async disposal. Python sessions SHALL support `async with` and explicit async close. Closing SHALL release in-process resources and cache pins without deleting verified content. An unclosed session SHALL remain pinned only until its process exits.

#### Scenario: Closed session releases pin
- **WHEN** an application closes its session
- **THEN** subsequent reads fail with a typed closed-session error and the cache may later evict the artifact under policy

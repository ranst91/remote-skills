## Purpose

Define a model-agnostic runtime client that discovers remote skills compactly and activates verified, immutable skill snapshots on demand without installing or executing them.

## ADDED Requirements

### Requirement: Origins have explicit identities and policy
Clients SHALL accept a map of explicit origin aliases to origin URLs and optional headers, timeouts, retry counts, stale policy, and network policy. Aliases SHALL NOT be inferred from hosts. Aggregate catalog identities SHALL be origin-qualified, while an origin-bound session SHALL resolve short skill names only within its selected origin.

#### Scenario: Session uses contextual short name
- **WHEN** a client creates a session for alias `acme` and activates `code-review`
- **THEN** only the `code-review` entry from `acme` can be selected even if another configured origin publishes the same name

#### Scenario: Aggregate collision stays explicit
- **WHEN** two healthy origins publish `code-review`
- **THEN** the aggregate catalog returns two origin-qualified entries and applies no silent precedence

### Requirement: Catalog discovery is compact and standards-bound
The client SHALL discover a configured origin only through `/.well-known/agent-skills/index.json`. It SHALL process only the explicit Cloudflare v0.2.0 `$schema`, fail closed on missing or unknown schemas, and ignore unknown fields within a recognized catalog for forward compatibility. Catalog results SHALL expose only origin, name, description, artifact type, URL, and digest and SHALL NOT fetch skill artifacts.

#### Scenario: Catalog does not activate skills
- **WHEN** an application requests a session catalog
- **THEN** the client makes no artifact request and returns only compact discovery metadata

#### Scenario: Digest-less catalog is rejected
- **WHEN** an origin returns a v0.1-style catalog without the v0.2.0 `$schema` and digests
- **THEN** catalog discovery fails with a stable unsupported-schema error and no skill is made activatable

#### Scenario: Recognized catalog tolerates an extension
- **WHEN** a valid v0.2.0 catalog includes an unknown non-conflicting field
- **THEN** the client ignores that field and preserves all defined behavior

### Requirement: Aggregate discovery reports partial failure
An aggregate catalog request SHALL return healthy origin results together with explicit per-origin failures and SHALL never silently omit an unhealthy origin. A strict aggregate option SHALL fail unless every configured origin succeeds. A single-origin session catalog request SHALL throw its typed origin failure.

#### Scenario: One origin is unavailable
- **WHEN** one of two configured origins succeeds and the other times out
- **THEN** non-strict aggregate discovery returns the healthy catalog plus a timeout failure associated with the failed alias

#### Scenario: Strict aggregate requires all origins
- **WHEN** the same request uses strict aggregate mode
- **THEN** the operation fails and retains the per-origin failure details

### Requirement: Sessions pin immutable skill identities
Creating a session SHALL establish an origin-scoped catalog view. Activating a skill SHALL pin the entry's exact digest for that session. Catalog refresh or publisher updates SHALL NOT change an already activated skill. A subsequent session MAY observe and activate a newer digest.

#### Scenario: Update does not alter active session
- **WHEN** session A activates digest D1 and the publisher later advertises D2
- **THEN** session A continues to read D1 while a new session after revalidation can activate D2

#### Scenario: Repeated activation is stable
- **WHEN** one session activates the same skill name more than once
- **THEN** every activation resolves to the same pinned digest and verified contents

### Requirement: Catalog removal affects only future validated sessions
When a revalidated online catalog removes an entry, sessions created from that catalog SHALL no longer list or activate the removed skill. Existing sessions SHALL retain their pinned artifact. Explicit stale-catalog sessions MAY still expose the older entry only within their configured maximum age and SHALL identify themselves as stale.

#### Scenario: Publisher removes a skill
- **WHEN** session A has pinned a skill, refresh observes a new catalog without it, and session B is created
- **THEN** session A remains readable while session B returns `skill_not_found` for that name

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

#### Scenario: CDN artifact receives only its own headers
- **WHEN** an origin catalog points to an allowed HTTPS CDN host with separate configured headers
- **THEN** the artifact request contains the CDN headers and not the origin's authorization header

#### Scenario: Redirect to private address is blocked
- **WHEN** a public origin redirects an artifact request to a private or loopback address
- **THEN** activation fails with `policy_denied` before transmitting configured credentials or fetching content

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

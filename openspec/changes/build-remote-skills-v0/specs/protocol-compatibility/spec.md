## Purpose

Define the shared behavioral contract that keeps publisher output and the independently implemented TypeScript and Python consumers interoperable across platforms and releases.

## ADDED Requirements

### Requirement: Consumer SDK behavior is language-parity tested
The TypeScript and Python SDKs SHALL implement the same catalog, scope authorization, SemVer selection, session, activation, refresh, cache, resource, offline, network-policy, and lifecycle semantics. Language syntax MAY be idiomatic, but equivalent inputs SHALL produce equivalent normalized outputs, requests, cache effects, and stable error codes.

#### Scenario: Shared success fixture agrees
- **WHEN** both SDKs consume the same catalog and artifact fixture under equivalent configuration
- **THEN** they report the same entry identity, pinned digest, normalized paths, instructions, metadata, and request count

#### Scenario: Shared failure fixture agrees
- **WHEN** both SDKs consume the same malformed or unsafe fixture
- **THEN** both fail at the same boundary with the same stable error code and no published cache object

### Requirement: Protocol fixtures are executable contracts
Repository-level `tests/protocol/fixtures` and `tests/protocol/expected-results` SHALL contain language-neutral wire bytes, archives, filesystem cases, cache states, policies, and normalized expectations. Each SDK SHALL execute those fixtures directly in addition to its package-local unit tests. Fixture expectations SHALL NOT be generated independently by either implementation under test.

#### Scenario: Fixture change requires both consumers
- **WHEN** a protocol fixture or expected result changes
- **THEN** CI runs both SDKs against it and rejects the change unless both conform

#### Scenario: Unit tests remain package-local
- **WHEN** behavior is an internal implementation detail with no cross-language contract
- **THEN** its tests remain beside the owning package rather than becoming a protocol fixture

### Requirement: Stable errors cross the language boundary
The shared contract SHALL define stable codes at least for unavailable origins, timeouts, invalid or unsupported catalogs, authentication failure, authorization denial, unavailable versions, missing skills, digest mismatch, unsupported artifacts, unsafe archives, missing or invalid resources, denied network policy, closed sessions, cache corruption, and configuration errors. TypeScript error classes and Python exception classes SHALL expose the same code and sanitized structured context. Messages MAY be idiomatic and SHALL NOT contain headers, tokens, artifact bodies, or skill instructions.

#### Scenario: Digest mismatch has one code
- **WHEN** equivalent activation requests encounter mismatched bytes
- **THEN** both SDKs expose `digest_mismatch` with the origin alias, skill name, and expected digest but no response content

#### Scenario: Secrets are absent from errors
- **WHEN** a request using authorization headers fails after redirects or retries
- **THEN** no thrown error, debug event, or fixture snapshot contains header values or credential-bearing URLs

#### Scenario: Version failure is sanitized and equivalent
- **WHEN** equivalent clients request `1.4.x` from an unversioned entry or a history with no compatible release
- **THEN** both expose `version_unavailable` with origin alias, skill name, and requested range but no catalog body or credentials

#### Scenario: Authentication and authorization remain distinct
- **WHEN** equivalent scoped requests receive `401` and `403`
- **THEN** both SDKs map them respectively to `authentication_failed` and `authorization_denied` with the same sanitized scope context

### Requirement: The disk cache layout is shared and versioned
The repository SHALL specify one versioned content-addressed disk layout, canonical catalog identifier derivation from origin plus confirmed non-secret scope, artifact path derivation, catalog metadata format, extraction normalization, atomic-publication protocol, lease format, writer-liveness format, digest-scoped process-registration format, generation-unique mutation-intent and ticket records, bounded coordination lifecycle, and eviction metadata format. Credentials and credential hashes SHALL never participate in the catalog identifier. Authenticated responses without confirmed scope SHALL not enter the shared persistent catalog layout. A mutation contender SHALL publish its live process registration before its intent, retain that intent through its ticket's critical section, and never let a legitimate successor reuse an earlier owner's intent or ticket pathname. TypeScript and Python SHALL read objects and honor live leases, writers, intents, and mutation tickets produced by the other implementation. A cache-layout break during major version zero SHALL use a new layout namespace rather than misreading old data.

A lease acquisition SHALL anchor every directory identity from the cache root through any legitimate immutable object generation with a retained no-follow directory chain before announcing itself, then verify both retained handles and current path identities after it owns the mutation gate and before publishing its lease. If that generation or any anchored ancestor is missing, replaced, or symlinked, the removal or redirection itself is the durable eviction outcome and the acquisition SHALL fail closed; a future acquisition may lease a newly published generation, and an acquisition that began without an object generation MAY retain the ordinary pin-before-download behavior. Ticket selection SHALL also persist a directly observed eviction predecessor in the successor's immutable ticket so predecessor release cannot erase that observation before the first turn-state scan. Neither mechanism SHALL require an eviction tombstone set.

#### Scenario: Python reuses TypeScript cache object
- **WHEN** TypeScript has published a verified artifact and closed its session
- **THEN** Python can activate the same digest without downloading artifact bytes again

#### Scenario: Scope partitions shared catalogs but not immutable objects
- **WHEN** TypeScript caches confirmed engineering and sales catalog views that reference one identical authorized digest
- **THEN** Python observes distinct catalog identities while the verified object remains content-addressed and deduplicated

#### Scenario: Unknown cache layout is isolated
- **WHEN** a client finds a cache namespace from an unsupported layout version
- **THEN** it leaves that namespace untouched and uses its supported namespace rather than interpreting incompatible metadata

#### Scenario: A live cross-runtime owner pins an expired object or writer
- **WHEN** logical expiry passes while a Python or TypeScript process still owns a lease or temporary writer through the shared digest-scoped registration
- **THEN** the other runtime preserves that object or writer until the owner exits or releases it

#### Scenario: Crashed coordination metadata is finitely reclaimed
- **WHEN** an owner crashes after publishing lease, writer, registration, generation, or lock state
- **THEN** bounded cleanup rechecks age, process identity or heartbeat, and filesystem generation before reclaiming the stale records without removing a live successor

#### Scenario: A pre-publication crash leaves only coordination state
- **WHEN** an owner crashes after creating its registration or lease-generation record but before publishing a lease, writer, or object
- **THEN** either runtime finitely reclaims the dead orphan and empty known-version parents using the shared scan budget while preserving live, unknown-version, or replaced state

#### Scenario: Reclaimed generation cannot alias a future lease handle
- **WHEN** an orphan lease-generation record is removed and the same process and session identifiers later reacquire under an equal or regressed clock
- **THEN** the persisted acquisition nonce distinguishes the successor so the stale handle cannot renew or release it

#### Scenario: Cross-runtime acquisition and final eviction are mutually exclusive
- **WHEN** one runtime begins lease acquisition while the other runtime is between its final live-pin check and irreversible object removal
- **THEN** both runtimes serialize through the same digest-scoped mutation gate, so either acquisition publishes its lease first and eviction retains the object, or eviction wins and acquisition fails without returning a handle to the removed object

#### Scenario: A crashed mutation-gate owner is safely reclaimed
- **WHEN** a gate owner crashes, its heartbeat expires, and another runtime needs the same digest
- **THEN** the contender rechecks the versioned record, process registration and identity, age, and filesystem generation before reclaiming it, while unknown-version, live, reused-PID, or replaced records remain protected

### Requirement: Publisher and consumers agree on exact wire bytes
The deterministic publisher fixtures SHALL be consumed without transformation by both SDKs. Expected index bytes, `skill-md` bytes, tar-gzip bytes, ZIP bytes, digest strings, URL resolution, and normalized archive views SHALL be checked into the shared fixture contract.

#### Scenario: Built artifact activates in both languages
- **WHEN** the CLI builds the canonical multi-resource fixture
- **THEN** its checked digest and archive bytes match the fixture and activate successfully in both SDKs

### Requirement: Scope and version extensions have one executable contract
Shared fixtures SHALL define exact `Remote-Skills-Scope` request and confirmation headers, `401`/`403` mapping, no-store and unconfirmed-auth persistence, cross-scope isolation, artifact authorization, `x-remote-skills` JSON bytes, strict SemVer parsing, deterministic ordering, highest-compatible selection, prerelease behavior, immutable mapping, online removal, stale fallback, and session pinning. TypeScript and Python SHALL consume the same expectations, and publisher goldens SHALL produce the same extension shape.

#### Scenario: One fixture proves authorized range selection
- **WHEN** both SDKs request the same authorized scope and `1.4.x` range from a publisher golden containing `1.4.7`, `1.5.0`, and `2.0.0`
- **THEN** they send the same scope header, confirm the same catalog identity, select `1.4.7`, request the same artifact URL, and pin the same digest

#### Scenario: Ordinary v0.2 consumer can ignore history
- **WHEN** a version-aware publisher golden is processed without Remote Skills extension support
- **THEN** its standard top-level current fields remain a valid Cloudflare discovery entry

### Requirement: Supported-platform CI proves portability
CI SHALL run validation, deterministic build fixtures, shared protocol fixtures, package-local tests, lint, type checking, and package dry runs in its primary Linux environment using Node.js 24+ and supported Python 3.11+ versions. It SHALL separately clean-install and exercise the public CLI, TypeScript client, and Python distribution on Windows. Platform-specific behavior SHALL not weaken path, link, archive, or cache safety.

#### Scenario: Installed public packages work on Windows
- **WHEN** local v0 distribution artifacts are evaluated for completion
- **THEN** the primary CI gates pass and Windows clean-installs and exercises the CLI, TypeScript client, and Python distribution through their public entry points

### Requirement: Distribution artifacts are independently installable
The monorepo SHALL locally produce npm tarballs for `@remote-skills/cli` and `@remote-skills/client` plus a Python wheel and source distribution named `remote-skills`, each with independently valid manifests, licenses, READMEs, contents, and clean-install smoke tests. Artifacts SHALL initially use a coordinated `0.0.1` version while preserving the ability to version packages separately later, and compatibility SHALL follow SemVer major-zero rules.

#### Scenario: Package dry run is self-contained
- **WHEN** CI packs each npm package and builds the Python wheel and source distribution without workspace-only sources
- **THEN** each artifact installs and imports or invokes successfully in a clean environment

### Requirement: V0 performs no package publication
The repository SHALL NOT require or perform npm/PyPI publication, package-name reservation, registry or Trusted Publishing/OIDC configuration, registry credential handling, package upload, publication tag creation, or a tag-triggered publication workflow. Packaging and acceptance SHALL stop at local pack/build/inspect/install checks and publication-readiness evidence.

#### Scenario: Acceptance is registry-free
- **WHEN** the complete v0 acceptance workflow runs
- **THEN** it creates and tests local distribution artifacts without contacting npm or PyPI, configuring registry state, requesting publication credentials, creating a tag, or uploading bytes

#### Scenario: Readiness evidence cannot imply publication
- **WHEN** acceptance records artifact names, versions, hashes, and smoke-test results
- **THEN** it labels them as local artifacts and makes no package-ownership, registry-availability, upload, or publication claim

### Requirement: Documentation is part of compatibility
The repository SHALL contain an approved minimal README, a self-hostable Fumadocs application, and runnable publisher, TypeScript consumer, and Python consumer examples. Documentation SHALL state the standards versions, exact static deployment bytes and paths, Git-backed hosting, local-image alternative, trust model, disk-versus-memory caching and update behavior, scoped authentication/authorization, SemVer policy and history, security limits, offline semantics, deployment boundary, package versions, and deferred features. Documented snippets SHALL be compiled or executed in CI.

#### Scenario: README remains minimal and accurate
- **WHEN** a reader follows the README quickstart
- **THEN** it demonstrates standards-compatible local serving and one origin-bound activation without claiming deferred adapters, hosting, or script safety

#### Scenario: Documentation snippet is tested
- **WHEN** a public API changes during major version zero
- **THEN** stale TypeScript, Python, CLI, and configuration snippets fail the documentation gate until updated

#### Scenario: Git-backed hosting is release-blocking
- **WHEN** v0 acceptance validates documentation and examples
- **THEN** it proves a repository-to-CI-to-static-origin path and explains why a project-subpath URL needs a dedicated hostname or equivalent origin-root mapping

#### Scenario: Local bundling is positioned honestly
- **WHEN** a reader owns a small fixed skill set that releases with one container
- **THEN** documentation recommends local copy/clone as the simpler option and reserves Remote Skills for independent distribution, selection, or updates

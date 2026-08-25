## Purpose

Define the shared behavioral contract that keeps publisher output and the independently implemented TypeScript and Python consumers interoperable across platforms and releases.

## ADDED Requirements

### Requirement: Consumer SDK behavior is language-parity tested
The TypeScript and Python SDKs SHALL implement the same catalog, session, activation, refresh, cache, resource, offline, network-policy, and lifecycle semantics. Language syntax MAY be idiomatic, but equivalent inputs SHALL produce equivalent normalized outputs, requests, cache effects, and stable error codes.

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
The shared contract SHALL define stable codes at least for unavailable origins, timeouts, invalid or unsupported catalogs, missing skills, digest mismatch, unsupported artifacts, unsafe archives, missing or invalid resources, denied network policy, closed sessions, cache corruption, and configuration errors. TypeScript error classes and Python exception classes SHALL expose the same code and sanitized structured context. Messages MAY be idiomatic and SHALL NOT contain headers, tokens, artifact bodies, or skill instructions.

#### Scenario: Digest mismatch has one code
- **WHEN** equivalent activation requests encounter mismatched bytes
- **THEN** both SDKs expose `digest_mismatch` with the origin alias, skill name, and expected digest but no response content

#### Scenario: Secrets are absent from errors
- **WHEN** a request using authorization headers fails after redirects or retries
- **THEN** no thrown error, debug event, or fixture snapshot contains header values or credential-bearing URLs

### Requirement: The disk cache layout is shared and versioned
The repository SHALL specify one versioned content-addressed disk layout, canonical origin identifier derivation, artifact path derivation, catalog metadata format, extraction normalization, atomic-publication protocol, lease format, and eviction metadata format. TypeScript and Python SHALL read objects produced by the other implementation. A cache-layout break during major version zero SHALL use a new layout namespace rather than misreading old data.

#### Scenario: Python reuses TypeScript cache object
- **WHEN** TypeScript has published a verified artifact and closed its session
- **THEN** Python can activate the same digest without downloading artifact bytes again

#### Scenario: Unknown cache layout is isolated
- **WHEN** a client finds a cache namespace from an unsupported layout version
- **THEN** it leaves that namespace untouched and uses its supported namespace rather than interpreting incompatible metadata

### Requirement: Publisher and consumers agree on exact wire bytes
The deterministic publisher fixtures SHALL be consumed without transformation by both SDKs. Expected index bytes, `skill-md` bytes, tar-gzip bytes, ZIP bytes, digest strings, URL resolution, and normalized archive views SHALL be checked into the shared fixture contract.

#### Scenario: Built artifact activates in both languages
- **WHEN** the CLI builds the canonical multi-resource fixture
- **THEN** its checked digest and archive bytes match the fixture and activate successfully in both SDKs

### Requirement: Supported-platform CI proves portability
CI SHALL run validation, deterministic build fixtures, shared protocol fixtures, package-local tests, lint, type checking, and package dry runs on Linux, macOS, and Windows using Node.js 24+ and supported Python 3.11+ versions. Platform-specific behavior SHALL not weaken path, link, archive, or cache safety.

#### Scenario: Release cannot bypass an operating system
- **WHEN** a tagged release candidate is created
- **THEN** publication is blocked until the required matrix passes on all three supported operating systems

### Requirement: Public packages are independently publishable
The monorepo SHALL produce public packages `@remote-skills/cli`, `@remote-skills/client`, and `remote-skills` with independently valid manifests, licenses, READMEs, artifacts, and installation smoke tests. Releases SHALL initially use a coordinated version while preserving the ability to version packages separately later. The first intended non-development release SHALL be `0.0.1`, and compatibility SHALL follow SemVer major-zero rules.

#### Scenario: Package dry run is self-contained
- **WHEN** CI packs each npm package and builds the Python wheel and source distribution without workspace-only sources
- **THEN** each artifact installs and imports or invokes successfully in a clean environment

#### Scenario: Python development claim precedes 0.0.1
- **WHEN** the approved implementation is ready to claim the unregistered PyPI project
- **THEN** Trusted Publishing uploads a legitimate `0.0.1.dev0` package and leaves `0.0.1` available as the first non-development release

### Requirement: Publishing uses short-lived trusted identity
Tag-driven npm and PyPI release jobs SHALL use each registry's Trusted Publishing mechanism rather than repository-stored long-lived publication tokens. Release environments SHALL permit explicit maintainer approval, and package provenance or attestations SHALL be enabled when the registry supports them.

#### Scenario: Release workflow has no registry secret
- **WHEN** the repository's release workflow is inspected
- **THEN** it requests the minimum OIDC permissions and references no npm or PyPI publication token secret

### Requirement: Documentation is part of compatibility
The repository SHALL contain an approved minimal README, a self-hostable Fumadocs application, and runnable publisher, TypeScript consumer, and Python consumer examples. Documentation SHALL state the standards versions, trust model, caching and update behavior, authentication behavior, security limits, offline semantics, deployment boundary, package versions, and deferred features. Documented snippets SHALL be compiled or executed in CI.

#### Scenario: README remains minimal and accurate
- **WHEN** a reader follows the README quickstart
- **THEN** it demonstrates standards-compatible local serving and one origin-bound activation without claiming deferred adapters, hosting, or script safety

#### Scenario: Documentation snippet is tested
- **WHEN** a public API changes during major version zero
- **THEN** stale TypeScript, Python, CLI, and configuration snippets fail the documentation gate until updated

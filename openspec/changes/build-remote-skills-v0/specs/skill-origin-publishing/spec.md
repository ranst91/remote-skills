## Purpose

Define how authors validate ordinary Agent Skills and turn them into deterministic, deploy-ready Cloudflare discovery v0.2.0 origins without adopting a proprietary skill format or hosting service.

## ADDED Requirements

### Requirement: Standard Agent Skills are the publishing source
The publisher SHALL treat each immediate child of the configured source roots that contains `SKILL.md` as one skill. It SHALL validate that skill against the canonical Agent Skills specification, derive catalog `name` and `description` from standard YAML frontmatter, and require the frontmatter name to match the parent directory. It SHALL NOT require a second per-skill manifest.

#### Scenario: Default source tree is discovered
- **WHEN** an author runs a publisher command without source-root overrides and `skills/code-review/SKILL.md` is valid
- **THEN** the publisher discovers `code-review` from the default `skills/` root and derives its catalog metadata from `SKILL.md`

#### Scenario: Standard metadata is preserved
- **WHEN** a valid skill includes `license`, `compatibility`, `metadata`, or `allowed-tools`
- **THEN** the publisher preserves those fields in the skill artifact without interpreting permissions or executing tools

#### Scenario: Version metadata is optional
- **WHEN** a valid skill omits `metadata.version`
- **THEN** the publisher emits a standards-compatible latest-only entry and does not invent a version from a digest, timestamp, or build number

#### Scenario: Name mismatch fails validation
- **WHEN** a directory named `code-review` contains frontmatter with `name: security-review`
- **THEN** validation fails with a stable error that identifies the mismatch

### Requirement: Publisher configuration is declarative and strict
The publisher SHALL read optional project settings from `remote-skills.json`. The configuration SHALL support source roots, output directory, archive format, strict validation, development bind settings, and build limits. CLI flags SHALL override file settings. Unknown configuration fields SHALL fail validation, and loading configuration SHALL NOT execute repository code.

#### Scenario: Typo in local configuration is rejected
- **WHEN** `remote-skills.json` contains an unsupported field such as `outputDIr`
- **THEN** the command fails before reading or writing skill artifacts and identifies the unknown field

#### Scenario: CLI override wins
- **WHEN** the configuration selects `tar.gz` and the author passes `--format zip`
- **THEN** the command builds deterministic ZIP artifacts without mutating the configuration file

### Requirement: Input inclusion is safe and explicit
The publisher SHALL apply safe default exclusions for repository metadata, dependency directories, build outputs, and common secret files. Authors MAY add gitignore-compatible patterns in `.skillignore`. The publisher SHALL reject filesystem symlinks and hard links in the included source tree and SHALL prevent any included path from escaping its skill root.

#### Scenario: Ignored secret is excluded
- **WHEN** a skill tree contains a common environment-secret file covered by the default exclusions
- **THEN** the file is absent from validation inputs and built artifacts

#### Scenario: Symlink is rejected
- **WHEN** any included path is a filesystem symlink, including one that appears to remain inside the skill directory
- **THEN** the build fails before producing or replacing deploy-ready output

### Requirement: Validation distinguishes correctness from writing guidance
`remote-skills validate` SHALL report Agent Skills violations, discovery incompatibilities, unsafe paths, invalid names or digests, archive-limit violations, and broken local references as errors. It SHALL report non-normative writing-quality guidance as warnings. `--strict` SHALL promote warnings to errors. Diagnostics SHALL identify the skill and source path without exposing file contents or configured header values.

#### Scenario: Broken local reference is an error
- **WHEN** `SKILL.md` references a missing relative resource
- **THEN** validation exits unsuccessfully and identifies the missing relative path

#### Scenario: Writing warning is strict-only failure
- **WHEN** a skill is structurally valid but triggers a writing-quality warning
- **THEN** normal validation succeeds with a warning and `--strict` validation fails

### Requirement: Build output implements discovery v0.2.0
`remote-skills build` SHALL emit the explicit schema `https://schemas.agentskills.io/discovery/0.2.0/schema.json` at `dist/.well-known/agent-skills/index.json` by default. Every entry SHALL contain the standard `name`, `description`, `type`, relative `url`, and lowercase `sha256:<64-hex>` digest. The digest SHALL cover the exact raw artifact bytes. Build output SHALL require no final deployment origin.

#### Scenario: Deploy-ready relative index
- **WHEN** valid skills are built without a configured public URL
- **THEN** the index contains RFC-resolvable relative artifact URLs and can be deployed unchanged beneath any HTTPS origin

#### Scenario: Catalog metadata matches the artifact
- **WHEN** the built artifact's `SKILL.md` is parsed
- **THEN** its standard `name` and `description` exactly match the corresponding index entry

### Requirement: Optional version history preserves Cloudflare interoperability
When standard Agent Skills `metadata.version` is present, the publisher SHALL require strict SemVer and SHALL emit an entry-level `x-remote-skills` object containing that current `version` and an inline `releases` array. The ordinary Cloudflare `name`, `description`, `type`, `url`, and `digest` fields SHALL continue to describe the provider's current artifact. The current release descriptor SHALL exactly match the standard top-level type, URL, and digest so consumers that ignore the extension remain interoperable.

Each release descriptor SHALL contain exactly `version`, `type`, `url`, and `digest`. The array SHALL contain at most 100 unique exact versions and SHALL be sorted by descending SemVer precedence with lexical version as deterministic tie-break. The publisher SHALL reject invalid versions, duplicates, malformed history, a current-descriptor mismatch, or any attempt to map one previously supplied skill-name/version pair to different type, URL, or digest.

#### Scenario: Version-aware output remains standard-consumable
- **WHEN** `code-review` declares `metadata.version: "1.4.7"`
- **THEN** the standard top-level entry identifies `1.4.7` and the extension contains the identical current descriptor for Remote Skills consumers

#### Scenario: Existing version cannot be replaced
- **WHEN** verified prior output maps `code-review` version `1.4.7` to digest D1 and a later build presents different bytes with digest D2 under `1.4.7`
- **THEN** the build fails without replacing deploy-ready output

### Requirement: Prior release retention is explicit and bounded
When the provider supplies verified prior build output, the publisher SHALL carry forward its retained version descriptors and referenced content-addressed artifact bytes unchanged unless the provider explicitly prunes them. A build without prior output SHALL advertise only releases whose artifacts are actually present in its completed output. The publisher SHALL NOT claim that arbitrary consumer baselines remain available and SHALL fail rather than silently exceed the 100-release-per-skill bound.

#### Scenario: Prior compatible release remains downloadable
- **WHEN** a new `2.0.0` build receives verified prior output containing `1.4.7` and the provider does not prune it
- **THEN** the completed static output advertises both releases and retains the exact `1.4.7` artifact bytes

#### Scenario: Clean build promises no unavailable history
- **WHEN** a clean build has only `2.0.0` source and no verified prior output
- **THEN** it advertises only `2.0.0` rather than fabricating or referencing an unavailable `1.4.x` release

### Requirement: Artifact selection follows the discovery standard
The builder SHALL emit a content-addressed `skill-md` artifact when a skill contains only `SKILL.md`, and an `archive` artifact when supporting files exist. `--archive` SHALL force a single-file skill into an archive. Archives SHALL place `SKILL.md` and resources at the archive root without a wrapper directory. The default archive format SHALL be deterministic `.tar.gz`; `--format zip` SHALL produce deterministic ZIP output.

#### Scenario: Single-file skill remains a file
- **WHEN** a skill contains only `SKILL.md` and `--archive` is absent
- **THEN** its index type is `skill-md` and its content-addressed artifact digest equals the SHA-256 of the raw Markdown bytes

#### Scenario: Resource-bearing skill becomes an archive
- **WHEN** a skill contains `SKILL.md` and `references/security.md`
- **THEN** its index type is `archive` and the archive root contains both paths without an extra skill-name directory

### Requirement: Completed output is the static deployment unit
The complete build output SHALL be deployable by mapping `dist/` to an HTTPS origin root and serving every generated byte unchanged. The catalog SHALL be available at `/.well-known/agent-skills/index.json`; archives SHALL remain compressed and SHALL NOT be unpacked, recompressed, renamed, or wrapped. The digest SHALL cover exact response bytes. Documented serving media types SHALL be `application/json` for the index, `text/markdown; charset=utf-8` for `skill-md`, `application/zip` for ZIP, and `application/gzip` for tar-gzip.

#### Scenario: Operator uploads dist unchanged
- **WHEN** an operator uploads the contents of `dist/` at `https://skills.example.com/`
- **THEN** the well-known catalog and every relative content-addressed artifact resolve without server-side Remote Skills code

#### Scenario: Project subpath is not an origin root
- **WHEN** a Pages product mounts output only at `https://example.github.io/repository/`
- **THEN** documentation explains that a dedicated hostname, custom domain, or equivalent routing is required for the origin-root well-known path

### Requirement: Local publication is serialized and finally verified
For one output directory, cooperative publisher processes SHALL serialize publication. Before publication the publisher SHALL reject symlinks or reparse points present in the project-relative output ancestor chain. It SHALL retain directory handles and rename-sensitive filesystem-generation evidence for the intended chain through publication and, before reporting success, SHALL verify both that chain and the exact final index and every artifact referenced by the generation it built. Final verification SHALL detect any ancestor/output swap during the command, including an ABA swap restored before the final check. Any such swap or final byte mismatch SHALL fail closed. The command SHALL NOT silently succeed with a corrupted or incomplete intended output.

The v0 threat boundary SHALL NOT claim to prevent or undo a pathname operation redirected by a malicious same-UID local process that races between the last check and the portable Node.js pathname syscall. Such a process already has authority to mutate the output after the command returns. If the race leaves the intended output different from the built generation, final verification SHALL fail. Strong prevention through descriptor-relative filesystem mutation, native advisory locks, or an external one-shot deployment pointer is outside v0.

#### Scenario: Cooperative concurrent builds serialize complete generations
- **WHEN** two ordinary publisher processes target the same output directory concurrently
- **THEN** their publication critical sections are serialized and the final index references one complete set of content-addressed artifact bytes

#### Scenario: At-rest output link is rejected
- **WHEN** any existing component in the project-relative output chain is a symlink or reparse point before publication
- **THEN** the build fails before accepting that chain as a publication target

#### Scenario: Output swap cannot produce success
- **WHEN** an output ancestor or final file generation changes during publication, including an ABA swap restored before final verification
- **THEN** the build fails and does not report the intended output as a completed generation

#### Scenario: Last-syscall local race is outside prevention scope
- **WHEN** a malicious same-UID local process redirects a pathname after the publisher's last pre-operation check and before the portable Node.js filesystem syscall
- **THEN** v0 makes no prevention or rollback guarantee for the redirected write, while final verification still fails if the intended output does not exactly equal the built generation

### Requirement: Builds are byte deterministic
Given identical included source bytes, effective configuration, tool version, and archive format, the publisher SHALL produce byte-identical artifacts, digests, and index output on supported operating systems. It SHALL normalize traversal order, archive timestamps, ownership, path separators, permissions, compression settings, and other host-dependent metadata.

#### Scenario: Cross-platform rebuild is identical
- **WHEN** the shared deterministic-build fixture is built in a supported runtime environment
- **THEN** every artifact and the index have the same platform-independent expected SHA-256 digest

#### Scenario: Content change creates a new identity
- **WHEN** one included source byte changes
- **THEN** the affected artifact digest and URL change while unchanged artifacts retain their previous bytes and URLs

### Requirement: Development server is a consumable local origin
`remote-skills dev` SHALL atomically build and serve the same well-known layout as `build`, watch included sources, and make completed rebuilds available to normal consumers. It SHALL bind to `127.0.0.1:8787` by default, allow host and port configuration, and require an explicit `--unsafe-host` acknowledgement before binding a non-loopback host. It SHALL use ordinary catalog refresh rather than a proprietary push or WebSocket protocol.

#### Scenario: Local SDK consumes development origin
- **WHEN** the development server is running with defaults
- **THEN** a client explicitly permitting loopback HTTP can consume `http://127.0.0.1:8787/.well-known/agent-skills/index.json`

#### Scenario: Watch rebuild is atomic
- **WHEN** a source edit triggers a rebuild while a client requests the catalog
- **THEN** the client receives either the complete previous output or the complete next output, never a mixed or partially written origin

### Requirement: Remote verification checks the deployed origin
`remote-skills verify <origin>` SHALL fetch the well-known catalog, resolve and download every supported entry, enforce consumer network and size policy, verify every digest, validate each artifact, and report origin-wide success only when all entries pass. It SHALL accept repeatable `--header NAME=VALUE` and `--header-env NAME=ENV_VAR` options. Header values SHALL NOT be logged, cached, or forwarded to an unconfigured cross-origin artifact host.

#### Scenario: Private origin verifies with environment header
- **WHEN** the verifier is given `--header-env Authorization=SKILLS_AUTH` and the environment variable is present
- **THEN** the header is sent to the configured origin, verification can succeed, and output contains neither the variable value nor a credential-bearing URL

#### Scenario: One invalid artifact fails the origin
- **WHEN** one catalog entry returns bytes that do not match its declared digest
- **THEN** verification fails, identifies that entry with a stable digest-mismatch code, and does not describe the origin as verified

### Requirement: Publisher commands enforce bounded inputs
Publisher commands SHALL default to a 1 MiB catalog limit, 50 MiB compressed artifact limit, 100 MiB extracted-skill limit, 1,000 files per skill, and 10 MiB per file. Limits SHALL be explicitly configurable and SHALL be enforced before or during allocation so compressed or metadata-declared expansion cannot bypass them.

#### Scenario: Decompression bomb fails before publication
- **WHEN** an archive or source fixture would exceed the configured extracted-size limit
- **THEN** the command fails without publishing a partial artifact or allocating beyond the bounded extraction strategy

## Purpose

Define the lightweight, tool-neutral entry points that make the Remote Skills repository and published documentation straightforward for coding agents to navigate without creating a separate agent integration or duplicated documentation surface.

## ADDED Requirements

### Requirement: Repository contribution guidance is agent-accessible

The repository SHALL provide one concise root `AGENTS.md` for coding agents. It SHALL identify the project purpose, canonical architecture and ownership references, supported setup and verification commands, documentation locations, and release-safety boundaries. It SHALL link to canonical sources instead of duplicating detailed documentation and SHALL remain tool-neutral.

#### Scenario: Coding agent finds the supported workflow

- **WHEN** a coding agent begins from the repository root
- **THEN** `AGENTS.md` directs it to the applicable package ownership, setup, focused checks, full checks, and documentation without requiring a vendor-specific instruction file

#### Scenario: Guidance does not create a second source of truth

- **WHEN** architecture, commands, or public APIs require detailed explanation
- **THEN** `AGENTS.md` links to the canonical repository source rather than maintaining a competing copy

### Requirement: Published documentation has an agent-readable index

The production documentation site SHALL publish a concise `/llms.txt` in the prevailing Markdown index format. It SHALL identify Remote Skills accurately and link to clean Markdown representations of the canonical publisher, archive-to-origin hosting, Git-backed static hosting, CLI, TypeScript, Python, scoped authentication/authorization, version selection, cache/offline, trust/security, and API documentation. The index SHALL be derived from or checked against canonical documentation navigation.

#### Scenario: Consumer agent starts from llms.txt

- **WHEN** an agent requests `/llms.txt` from the production documentation site
- **THEN** it can locate the canonical quickstarts and operational boundaries without crawling the entire site or executing client-side JavaScript

#### Scenario: Agent links resolve to canonical text

- **WHEN** an agent follows a documentation link listed in `/llms.txt`
- **THEN** the route resolves to clean Markdown containing the same essential guidance as the canonical human-readable page

#### Scenario: Agent can complete deployment without UI-only knowledge

- **WHEN** an agent starts with built `dist/` output and follows `/llms.txt`
- **THEN** it can find the exact well-known path, artifact-byte, MIME, archive-root, Git/Pages origin-root, scope, and version-policy guidance without executing client-side JavaScript

### Requirement: Agent accessibility remains proportionate

The v0 implementation SHALL use conventional text entry points and existing documentation build/link verification. It SHALL NOT require live-model evaluation, model scoring, `llms-full.txt`, an MCP documentation bridge, or parallel vendor-specific instruction files. Dedicated behavioral agent tests MAY be added later only for a demonstrated accessibility failure.

#### Scenario: Documentation ships without an agent benchmark

- **WHEN** the repository and documentation entry points satisfy their structural and navigation requirements
- **THEN** v0 acceptance does not depend on a live AI model or vendor-specific agent runtime

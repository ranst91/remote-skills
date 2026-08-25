# Remote Skills

### Serve skills. Don’t install them.

Remote Skills is an open-source toolkit for publishing and consuming Agent Skills directly from the web.

Skills remain on the publisher’s server. Agents discover them, fetch them when needed, verify their contents, and keep only a disposable cache.

No marketplace. No copying skills into every agent. No manual updates.

Built around Cloudflare’s [Agent Skills Discovery RFC](https://github.com/cloudflare/agent-skills-discovery-rfc).

---

## Skills should work like web modules

Today, sharing an Agent Skill usually means asking someone to install a directory into their agent.

That creates copies:

- Every agent has its own installation.
- Updates require reinstalling or synchronizing.
- Publishers cannot reliably fix or revoke a skill.
- Large skill libraries accumulate on every machine.

Remote Skills uses a different model:

```text
Connect to an origin once.
Discover its catalog.
Fetch a skill when it is activated.
Cache it by content hash.
Fetch a new version when the hash changes.
```

The remote origin remains authoritative. The cache is not an installation.

---

## Publish a skill origin

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

Run a local origin:

```bash
remote-skills dev ./skills
```

Build it for any static host:

```bash
remote-skills build ./skills --out ./public
```

Remote Skills generates:

```text
public/
└── .well-known/
    └── agent-skills/
        ├── index.json
        ├── code-review.tar.gz
        └── release-notes/
            └── SKILL.md
```

The generated index contains the skill catalog, artifact URLs and SHA-256 digests required by the discovery RFC.

Deploy it to any HTTPS origin:

- Cloudflare
- S3
- R2
- Vercel
- Netlify
- GitHub Pages with a custom domain
- Your existing application server

There is no Remote Skills hosting service you are required to use.

---

## Consume skills at runtime

Agent developers add a remote origin:

```ts
const skills = remoteSkills({
  origins: ["https://skills.example.com"],
});
```

The agent receives only the compact catalog:

```ts
const catalog = await skills.catalog();
```

When a skill becomes relevant:

```ts
const skill = await skills.activate("code-review");
```

Remote Skills then:

1. Resolves the current artifact.
2. Checks the local content-addressed cache.
3. Downloads it only when necessary.
4. Verifies its SHA-256 digest.
5. Pins that exact version for the current session.
6. Returns its instructions to the agent.

Supporting resources are exposed through the same activated skill:

```ts
await skill.read("references/security.md");
```

A skill update never changes an active session halfway through. The next session resolves the new digest and fetches the updated artifact.

---

## Use it with existing agents

Agents without native Remote Skills support can connect through the included bridge:

```bash
remote-skills bridge https://skills.example.com
```

The bridge exposes a small, vendor-neutral interface:

```text
list_skills
activate_skill
read_skill_resource
```

It can be used through MCP or embedded directly into an agent runtime.

The bridge is generic. You configure it once; you do not install every skill behind it.

```text
Agent
  │
  └── Remote Skills bridge
          │
          ├── skills.example.com
          ├── security.example.org
          └── docs.vendor.com
```

---

## One toolkit for both sides

### For skill publishers

```bash
remote-skills dev
remote-skills validate
remote-skills build
remote-skills verify https://skills.example.com
```

You get:

- Local development with live updates
- Agent Skills validation
- Deterministic archives
- SHA-256 digest generation
- Discovery-index generation
- Cache-header recommendations
- Deployment-ready static output
- Remote conformance verification

### For agent developers

You get:

- Remote catalog discovery
- Activation-time fetching
- Digest verification
- Content-addressed caching
- Session version pinning
- Safe archive extraction
- Resource access
- HTTP and MCP adapters
- Offline and stale-cache policies
- Revocation handling

---

## What Remote Skills is not

Remote Skills is not:

- A marketplace
- A skill installer
- A proprietary registry
- A new skill format
- A reason to trust arbitrary remote instructions
- A mechanism for automatically executing downloaded scripts

Publishers retain their domain and distribution. Agent hosts retain control over trust, permissions and execution.

---

## Open infrastructure

Remote Skills connects the pieces that already exist:

- **Agent Skills** defines how skills are written.
- **Agent Skills Discovery** defines how a domain advertises them.
- **HTTP** provides distribution and caching.
- **SHA-256** provides immutable content identity.
- **MCP** can provide a compatibility bridge for existing agents.

Remote Skills provides the missing end-to-end developer experience.

```text
Write locally.
Serve remotely.
Consume on demand.
Update by publishing new bytes.
```

# Mastra verification evidence

## Current delivery

Branch: `feat/mastra-integration`.
Rebased onto freshly fetched `origin/main` at
`16af9989895d90dea5345cbd8b9438256459e04f` on 2026-09-11.
The existing CLI, client, AI SDK, Python alpha release records and issued artifact
inventory were preserved. Mastra is an **unreleased local alpha**,
`0.0.1-alpha.0`, with client peer `^0.0.1-alpha.0` and exact Mastra peer `1.65.0`.
The package is enrolled in scoped release planning as `integration-mastra`.
Only an explicit Mastra selection enters the publication plan; core and other
integrations retain their versions. Already-issued coordinated releases retain
their original package inventory. No publishing, push, pull request, tag, or merge
was performed by this task.

Verified on macOS arm64, Node 24.21.0, pnpm 10.33.4, and the repository's locked
uv environment. No Windows or Linux execution is claimed.

## Installed alpha artifacts

`pnpm --filter @remote-skills/mastra package:check` passed. The checker builds
sanitized local client and Mastra tarballs, creates a consumer outside the
workspace, and installs offline with strict peer resolution using the committed
lockfile. It verifies the original installed native skill loader, complete
instructions, exact file reads, zero artifacts before activation, and one artifact
after activation. Packed manifests contain runtime metadata only; documentation,
license, built JavaScript, and declarations are present.

The shared integration dependency helper gained an optional integration path;
its AI SDK default is unchanged. The existing
`pnpm --filter @remote-skills/ai-sdk package:check` regression passed. The Mastra
package gate is explicitly registered in the TypeScript CI group.

Locked offline installation and Mastra `check` passed, including all 19 adapter
and real native-loop contract tests. Package scripts are included in typechecking.

## Real browser E2E for CI

`pnpm test:mastra` passed both cases. It uses a disposable checkout and a real
Chromium browser, real Next.js `/api/chat` route, original native Mastra tools,
and actual publisher CLI output. Only the external model provider is scripted;
`/api/chat`, the SDK, native tools, catalog, and archives are not mocked.

The publisher exposes a greeting skill with a reference plus an unrelated weather
skill. A transparent local proxy counts origin requests without substituting
published bytes. The scripted provider accepts requests only when:

1. The first model request contains catalog descriptions but no instruction or
   resource contents, with one catalog request and **zero artifact requests**.
2. The next contains the full native selected-skill instructions, after exactly
   **one selected artifact request**.
3. The final request contains the **exact native reference result**. The expected
   answer is derived from that reference's explicit opening instruction.

The browser verifies intact native tool outputs and activity order:
`DETAILS` (skill), `DETAILS` (reference read), then `P` (answer). The unselected
weather artifact is never fetched. A separate ordinary direct-answer case fetches
one catalog and zero artifacts, with no tool panels. No browser errors or app
error alerts are observed.

The examples CI group invokes this real browser gate explicitly, in addition to
the existing Vercel gate and both demo package checks. Repository tests verify
these registrations. Provider credentials are synthetic in CI.

## Fresh live model and visual evidence

On 2026-09-11, both the live browser checker and manual in-app browser completed
this contextual request using the actual GPT-4.1 provider:

> Welcome a new teammate using our prescribed greeting style.

The request names neither a skill nor a tool. The model selected native `skill`,
read `references/greeting.md` with native `skill_read`, and used the required
opening in its final answer. No custom replacement skill tools, forced tool
choice, hardcoded answer, or modified skill instructions were used.

Sanitized machine evidence:

```json
{
  "model": "gpt-4.1",
  "prompt": "Welcome a new teammate using our prescribed greeting style.",
  "nativeTools": ["skill", "skill_read"],
  "activationOutputSha256": "a79f55cd44d242e393cfc0bd092484cbe5ba5c1e7c63a89dd119af9c4b7a9a13",
  "resourceOutputSha256": "ff5b252e38e0bd0b237e7c468ee86e7e637b3129112ce64dfe6ee0e736f567af",
  "fullInstructionsVerified": true,
  "resourceBytesVerified": true,
  "streamOrderVerified": true,
  "greetingVerified": true,
  "browserErrors": 0
}
```

The starter button and placeholder use the same contextual welcome request as the
live checker. The CI E2E and live checker both click that actual starter button;
generic greetings remain valid direct-answer inputs. The live checker compares
response bodies only in memory, then emits tool names,
hashes, and flags. The existing authorized environment file was loaded directly;
credentials were neither copied nor printed. Two fresh screenshots show the
native activity before the answer and the actual expanded reference read. No
supported browser recording API was available, so no video is claimed.

An initial fresh generic `Hello!` run returned no tool events. Generic greetings
can receive direct answers; a separate diagnostic greeting exercised both native
tools without error. The contextual acceptance request above establishes relevant
skill behavior without forcing selection. Earlier GPT-4.1-mini runs activated the
skill but omitted its required read. The demo therefore defaults to GPT-4.1 while
preserving nonempty caller model overrides. These observations do not guarantee
adherence by arbitrary models or skills.

The app-error assertion excludes Next.js's empty route-announcer accessibility
alert; actual demo error alerts remain checked.

## Website and verification commands

The common Integrations submenu is a separable docs-only commit. It links the
unchanged `/docs/vercel-ai-sdk` page and adds a guide at
`/docs/integrations/mastra`; its index is `/docs/integrations`. LLM discovery,
Markdown routes, internal links, and compiled consumer snippets are covered.
Full docs `check` passed, including the production route and preserved Vercel URL.
The demo remains TypeScript-only and needs no Python runtime to start.

Applicable commands run for this delivery:

- `pnpm install --frozen-lockfile --offline --ignore-scripts`
- `pnpm --filter @remote-skills/mastra check`
- `pnpm --filter @remote-skills/mastra package:check`
- `pnpm --filter @remote-skills/ai-sdk package:check`
- `pnpm test:mastra`
- `pnpm --filter @remote-skills/example-mastra check`
- `pnpm --filter @remote-skills/example-mastra build`
- `UV_CACHE_DIR=/tmp/mastra-uv-cache uv run --locked pnpm --filter @remote-skills/docs check`

Final root gate results are recorded with the final commit in the task's sanitized
machine-evidence report. Required commands are `pnpm test:repository`,
`UV_CACHE_DIR=/tmp/mastra-uv-cache uv run --locked pnpm test:protocol`,
`pnpm typecheck`, `UV_CACHE_DIR=/tmp/mastra-uv-cache uv run --locked pnpm check`,
and `pnpm ci:verify-projects`. The uv wrapper selects the locked interpreter;
ordinary approved cache and local-listener access is required for these gates.

Raw Workspace activation bypassing Agent hooks, replacement hooks or remapped
skill tools, automatic whole-catalog indexing, binary native text reads, and other
Mastra releases remain outside the supported path. See the compatibility matrix
in `README.md`. The SDK remains responsible for authentication, scope, digests,
limits, caches, and immutable session pins.

## Scoped release verification

The scoped release tests exercise no-write previews, Mastra-only version changes,
repeated requests, multi-scope accumulation, simulated merge validation, and exact
selected publication artifact hashes. Missing current required manifests fail;
new integration manifests absent from an issued historical commit do not expand
its release inventory.

The candidate artifact gate runs the actual Mastra browser journey only when the
candidate contains Mastra. That mode installs exact archives outside the workspace,
checks their resolved versions and paths, runs the installed publisher CLI, and
asserts that no workspace CLI, SDK, or Mastra build output exists. The model provider
alone remains scripted. Final command results and the isolated Mastra-only release
simulation are recorded in the task's machine-evidence report.

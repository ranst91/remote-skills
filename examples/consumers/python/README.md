# Python consumer example

This async reference imports only the public `remote_skills` package. The shared test runner builds
and installs the local wheel in a temporary environment, so this reference is tested without a release.
Start a local origin, then run:

```bash
REMOTE_SKILLS_ORIGIN=http://127.0.0.1:8787 pnpm start
```

For an authenticated origin, also set `REMOTE_SKILLS_AUTH_TOKEN` and
`REMOTE_SKILLS_SCOPE=engineering`. Set `REMOTE_SKILLS_VERSION_RANGE=1.4.x` for deterministic
highest-compatible selection. Activation verifies and pins the complete artifact; reading a
resource loads local verified data and does not execute it.

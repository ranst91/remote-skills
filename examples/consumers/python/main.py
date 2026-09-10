"""Consume one verified skill without executing its content."""

from __future__ import annotations

import asyncio
import json
import os
import sys

from remote_skills import CatalogError, Origin, RemoteSkills


HELP = """Usage: REMOTE_SKILLS_ORIGIN=http://127.0.0.1:8787 pnpm start

Optional environment:
  REMOTE_SKILLS_AUTH_TOKEN       bearer token for a private origin
  REMOTE_SKILLS_SCOPE            provider-authorized catalog scope
  REMOTE_SKILLS_VERSION_RANGE    SemVer range, for example 1.4.x
"""


async def main() -> None:
    if "--help" in sys.argv:
        print(HELP, end="")
        return
    origin_url = os.environ.get("REMOTE_SKILLS_ORIGIN")
    if origin_url is None:
        raise RuntimeError("REMOTE_SKILLS_ORIGIN is required")
    token = os.environ.get("REMOTE_SKILLS_AUTH_TOKEN")
    scope = os.environ.get("REMOTE_SKILLS_SCOPE")
    version_range = os.environ.get("REMOTE_SKILLS_VERSION_RANGE")
    origin = Origin(
        url=origin_url,
        headers={} if token is None else {"Authorization": f"Bearer {token}"},
        scope=scope,
        retries=0,
        allow_loopback_http=origin_url.startswith("http://"),
    )
    client = RemoteSkills(origins={"example": origin})
    async with client.session("example") as session:
        catalog = await session.catalog()
        skill = await session.activate("code-review", version_range)
        resources = await skill.list()
        reference = await skill.read("references/security.md")
        print(
            json.dumps(
                {
                    "catalogEntries": len(catalog),
                    "confirmedScope": session.metadata.confirmed_scope,
                    "name": skill.name,
                    "version": skill.version,
                    "digest": skill.digest,
                    "resources": [resource.path for resource in resources],
                    "referenceBytes": len(reference.encode()),
                },
                separators=(",", ":"),
                sort_keys=True,
            )
        )


try:
    asyncio.run(main())
except CatalogError as error:
    print(json.dumps(error.to_diagnostic(), separators=(",", ":")), file=sys.stderr)
    raise SystemExit(1) from None
except Exception:
    print(json.dumps({"code": "example_failed"}), file=sys.stderr)
    raise SystemExit(1) from None

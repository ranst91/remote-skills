from __future__ import annotations

import asyncio
import base64
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sys


REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPOSITORY_ROOT / "packages/sdk-python/src"))

from remote_skills import Origin, RemoteSkills
from remote_skills.cache import CachedObject, DiskCache


configuration = json.loads(base64.urlsafe_b64decode(sys.argv[1] + "===").decode())


def emit(event: dict[str, object]) -> None:
    print(json.dumps(event, separators=(",", ":")), flush=True)


def artifact_input() -> CachedObject:
    artifact = base64.b64decode(configuration["artifact"])
    digest = f"sha256:{hashlib.sha256(artifact).hexdigest()}"
    timestamp = datetime(2026, 8, 28, 12, tzinfo=timezone.utc)
    return CachedObject(
        digest=digest,
        artifact_type="skill-md",
        archive_format=None,
        artifact=artifact,
        files={"SKILL.md": artifact},
        media_types={"SKILL.md": "text/markdown"},
        verified_at=timestamp,
        accessed_at=timestamp,
    )


def cache() -> DiskCache:
    now = configuration.get("now")
    clock = None
    if now is not None:
        instant = datetime.fromisoformat(now.replace("Z", "+00:00"))
        clock = lambda: instant
    return DiskCache(
        configuration["cacheRoot"],
        touch_on_read=False,
        clock=clock,
        lease_expiry_seconds=configuration.get("leaseExpirySeconds", 120),
    )


async def activate() -> None:
    backend = cache()
    client = RemoteSkills(
        origins={
            "gate": Origin(
                url=configuration["origin"],
                allow_loopback_http=True,
                retries=0,
                headers={"X-Cache-Race-Worker": "python"},
            )
        },
        cache=backend,
    )
    async with client.session("gate") as session:
        skill = await session.activate("cache-race")
        emit(
            {
                "event": "activated",
                "digest": skill.digest,
                "instructions": skill.instructions,
            }
        )


def main() -> None:
    mode = configuration["mode"]
    if mode == "activate":
        asyncio.run(activate())
        return
    candidate = artifact_input()
    if mode == "publish":
        published = cache().publish_object(candidate)
        emit({"event": "published", "digest": published.digest})
        return
    if mode == "stage-crash":
        class PausingDiskCache(DiskCache):
            def _after_private_object(self, private: Path, cached: CachedObject) -> None:
                emit({"event": "staged", "digest": cached.digest})
                if not sys.stdin.buffer.readline():
                    raise RuntimeError("release channel closed")

        PausingDiskCache(
            configuration["cacheRoot"],
            touch_on_read=False,
            lease_expiry_seconds=configuration.get("leaseExpirySeconds", 120),
        ).publish_object(candidate)
        emit({"event": "published", "digest": candidate.digest})
        return
    if mode == "hold-lease":
        backend = cache()
        lease = backend.acquire_lease(
            candidate.digest,
            process_nonce="cache-race-python-process",
            session_nonce="cache-race-python-session",
        )
        emit(
            {
                "event": "lease-ready",
                "digest": candidate.digest,
                "leasePath": str(backend._lease_path(lease)),
            }
        )
        if not sys.stdin.buffer.readline():
            raise RuntimeError("release channel closed")
        backend.release_lease(lease)
        emit({"event": "lease-released", "digest": candidate.digest})
        return
    if mode == "evict":
        result = cache().evict(max_bytes=0, max_age_seconds=0, lease_expiry_seconds=1)
        emit(
            {
                "event": "evicted",
                "removed": list(result.removed_digests),
                "pinned": list(result.retained_pinned),
            }
        )
        return
    if mode == "cleanup":
        backend = cache()
        emit(
            {
                "event": "cleaned",
                "temporary": backend.cleanup_stale_temporaries(max_age_seconds=1),
                "leases": backend.cleanup_stale_leases(lease_expiry_seconds=1),
            }
        )
        return
    if mode == "read":
        try:
            observed = cache().get_object(candidate.digest)
            emit(
                {
                    "event": "read",
                    "digest": None if observed is None else observed.digest,
                    "artifact": (
                        None
                        if observed is None
                        else base64.b64encode(observed.artifact).decode()
                    ),
                }
            )
        except Exception as error:
            # Corruption is emitted as the asserted cross-runtime result, never a cache hit.
            emit(
                {
                    "event": "read-error",
                    "code": getattr(error, "code", type(error).__name__),
                }
            )
        return
    raise RuntimeError(f"unsupported cache-race worker mode: {mode}")


if __name__ == "__main__":
    main()

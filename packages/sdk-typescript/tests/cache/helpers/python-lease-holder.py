from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
import sys
import time
from types import MethodType


REPOSITORY_ROOT = Path(__file__).resolve().parents[5]
sys.path.insert(0, str(REPOSITORY_ROOT / "packages/sdk-python/src"))

from remote_skills.cache import DiskCache


def main() -> None:
    cache_root = Path(sys.argv[1])
    digest = sys.argv[2]
    ready = Path(sys.argv[3])
    release = Path(sys.argv[4])
    pause_mode = sys.argv[5] if len(sys.argv) > 5 else None
    pause_entered = Path(sys.argv[6]) if len(sys.argv) > 6 else None
    pause_resume = Path(sys.argv[7]) if len(sys.argv) > 7 else None
    cache = DiskCache(
        cache_root,
        touch_on_read=False,
        clock=lambda: datetime(2026, 8, 25, 10, 0, tzinfo=timezone.utc),
    )
    if pause_mode == "turn" and pause_entered is not None and pause_resume is not None:
        original_turn = cache._mutation_turn_state

        def pause_before_first_turn(
            self: DiskCache,
            digest_value: str,
            **kwargs: object,
        ) -> tuple[bool, bool]:
            pause_entered.write_text("paused", encoding="utf-8")
            deadline = time.monotonic() + 15
            while not pause_resume.exists():
                if time.monotonic() >= deadline:
                    raise TimeoutError("Python mutation-turn resume timed out")
                time.sleep(0.005)
            return original_turn(digest_value, **kwargs)

        cache._mutation_turn_state = MethodType(pause_before_first_turn, cache)
    if pause_mode == "prepublish" and pause_entered is not None and pause_resume is not None:
        original_scan = cache._open_object_generation_guard

        def pause_after_prepublication_scan(
            self: DiskCache,
            digest_value: str,
        ) -> object:
            result = original_scan(digest_value)
            pause_entered.write_text("paused", encoding="utf-8")
            deadline = time.monotonic() + 15
            while not pause_resume.exists():
                if time.monotonic() >= deadline:
                    raise TimeoutError("Python prepublication resume timed out")
                time.sleep(0.005)
            return result

        cache._open_object_generation_guard = MethodType(
            pause_after_prepublication_scan, cache
        )
    lease = cache.acquire_lease(
        digest,
        process_nonce="python-mixed-live",
        session_nonce="python-mixed-session",
    )
    ready.write_text("ready", encoding="utf-8")
    deadline = time.monotonic() + 15
    while not release.exists():
        if time.monotonic() >= deadline:
            raise TimeoutError("Python mixed-runtime lease release timed out")
        time.sleep(0.005)
    cache.release_lease(lease)


if __name__ == "__main__":
    main()

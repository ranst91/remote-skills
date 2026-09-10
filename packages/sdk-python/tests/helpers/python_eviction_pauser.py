from __future__ import annotations

import json
from pathlib import Path
import sys
import time


REPOSITORY_ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(REPOSITORY_ROOT / "packages/sdk-python/src"))

from remote_skills.cache import DiskCache
import remote_skills.cache.disk as disk_cache_module


def main() -> None:
    cache_root = Path(sys.argv[1])
    paused = Path(sys.argv[2])
    resume = Path(sys.argv[3])
    result_path = Path(sys.argv[4])
    original_remove = disk_cache_module._remove_tree_at

    def pause_before_irreversible_removal(*args: object, **kwargs: object) -> None:
        paused.write_text("paused", encoding="utf-8")
        deadline = time.monotonic() + 15
        while not resume.exists():
            if time.monotonic() >= deadline:
                raise TimeoutError("Python eviction resume timed out")
            time.sleep(0.005)
        original_remove(*args, **kwargs)

    disk_cache_module._remove_tree_at = pause_before_irreversible_removal
    result = DiskCache(cache_root, touch_on_read=False).evict(
        max_bytes=0,
        max_age_seconds=0,
    )
    result_path.write_text(
        json.dumps(
            {
                "removed": list(result.removed_digests),
                "pinned": list(result.retained_pinned),
            }
        ),
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()

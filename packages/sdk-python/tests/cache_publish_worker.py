from __future__ import annotations

import sys
import time
from pathlib import Path


def main() -> None:
    source_root, fixture_root, cache_root, ready_root, worker = map(Path, sys.argv[1:])
    sys.path.insert(0, str(source_root))

    from remote_skills.cache import DiskCache

    fixture_cache = DiskCache(fixture_root, touch_on_read=False)
    digest = "sha256:e4bb9c0cb022778c3e22703220eb387a5405b2025dad77b870291fc692c4e21d"
    cached = fixture_cache.get_object(digest)
    if cached is None:
        raise RuntimeError("fixture object missing")

    ready_root.mkdir(parents=True, exist_ok=True)
    (ready_root / worker.name).write_text("ready", encoding="utf-8")
    deadline = time.monotonic() + 10
    while len(list(ready_root.iterdir())) < 2:
        if time.monotonic() >= deadline:
            raise TimeoutError("publication race barrier timed out")
        time.sleep(0.005)

    published = DiskCache(cache_root, touch_on_read=False).publish_object(cached)
    print(published.digest)


if __name__ == "__main__":
    main()

from __future__ import annotations

import sys
import time
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[5]
sys.path.insert(0, str(REPOSITORY_ROOT / "packages/sdk-python/src"))

from remote_skills.cache import DiskCache
import remote_skills.cache.disk as disk_cache_module


fixture_root = Path(sys.argv[1])
cache_root = Path(sys.argv[2])
digest_value = sys.argv[3]
ready = Path(sys.argv[4])
release = Path(sys.argv[5])
source = DiskCache(fixture_root, touch_on_read=False).get_object(digest_value)
if source is None:
    raise RuntimeError("fixture object is missing")
cache = DiskCache(cache_root, touch_on_read=False, lease_expiry_seconds=1)
write_file_at = disk_cache_module._write_file_at


def pause(descriptor: int, directory: Path, name: str, content: bytes) -> None:
    write_file_at(descriptor, directory, name, content)
    if name == "writer.json":
        ready.write_text("ready", encoding="utf-8")
        deadline = time.monotonic() + 10
        while not release.exists():
            if time.monotonic() >= deadline:
                raise TimeoutError("timed out waiting for writer release")
            time.sleep(0.005)


disk_cache_module._write_file_at = pause
cache.publish_object(source)

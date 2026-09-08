from __future__ import annotations

import os
from pathlib import Path
import sys

from remote_skills.cache import DiskCache
import remote_skills.cache.disk as disk_module

root = Path(sys.argv[1])
digest = sys.argv[2]
if not digest.startswith("sha256:") or len(digest) != 71:
    raise ValueError("digest")

original_create = disk_module._atomic_create_file_at


def crash_after_registration(
    directory_descriptor: int | None,
    directory_path: Path,
    name: str,
    content: bytes,
) -> None:
    if name.endswith(".json") and not name.startswith("."):
        os._exit(0)
    original_create(directory_descriptor, directory_path, name, content)


disk_module._atomic_create_file_at = crash_after_registration
DiskCache(root, touch_on_read=False).acquire_lease(
    digest,
    process_nonce="python-orphan-before-publication",
    session_nonce="never-published",
)
raise RuntimeError("orphan crash hook was not reached")

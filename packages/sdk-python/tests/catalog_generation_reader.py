from __future__ import annotations

import hashlib
import json
import sys
import time
from pathlib import Path


def main() -> None:
    source_root = Path(sys.argv[1])
    cache_root = Path(sys.argv[2])
    ready_path = Path(sys.argv[3])
    stop_path = Path(sys.argv[4])
    observations_path = Path(sys.argv[5])
    canonical_url = sys.argv[6]
    old_generation = (sys.argv[7], sys.argv[8])
    new_generation = (sys.argv[9], sys.argv[10])
    sys.path.insert(0, str(source_root))

    from remote_skills.cache import DiskCache

    cache = DiskCache(cache_root, touch_on_read=False)
    ready_path.write_text("ready", encoding="utf-8")
    with observations_path.open("a", encoding="utf-8") as observations:
        while not stop_path.exists():
            try:
                catalog = cache.get_catalog(canonical_url)
                if catalog is None:
                    label = "missing"
                else:
                    generation = (
                        hashlib.sha256(catalog.body).hexdigest(),
                        catalog.metadata.etag or "",
                    )
                    if generation == old_generation:
                        label = "old"
                    elif generation == new_generation:
                        label = "new"
                    else:
                        label = "mixed"
            except Exception as error:
                label = f"error:{type(error).__name__}"
            observations.write(json.dumps(label) + "\n")
            observations.flush()
            (observations_path.parent / label.replace(":", "-")).touch()
            time.sleep(0.0005)


if __name__ == "__main__":
    main()

from datetime import datetime, timezone
import json
from pathlib import Path
import sys


def main() -> None:
    source_root = Path(sys.argv[1])
    cache_root = Path(sys.argv[2])
    canonical_url = sys.argv[3]
    confirmed_scope = sys.argv[4]
    sys.path.insert(0, str(source_root))

    from remote_skills.cache import CachedCatalog, CatalogMetadata, DiskCache

    cache = DiskCache(cache_root, touch_on_read=False)
    initial = cache.get_catalog_state(
        canonical_url, confirmed_scope=confirmed_scope
    )
    if initial.catalog is not None:
        if not cache.delete_catalog(
            canonical_url,
            confirmed_scope=confirmed_scope,
            expected_generation=initial.generation,
        ):
            raise RuntimeError("worker failed to delete initial catalog")
        initial = cache.get_catalog_state(
            canonical_url, confirmed_scope=confirmed_scope
        )
    now = datetime(2026, 8, 27, tzinfo=timezone.utc)
    catalog = CachedCatalog(
        body=json.dumps(
            {
                "$schema": "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
                "skills": [],
            },
            separators=(",", ":"),
        ).encode(),
        metadata=CatalogMetadata(
            canonical_url=canonical_url,
            retrieved_at=now,
            validated_at=now,
            confirmed_scope=confirmed_scope,
        ),
    )
    if not cache.replace_catalog(catalog, expected_generation=initial.generation):
        raise RuntimeError("worker failed to publish catalog")
    present = cache.get_catalog_state(
        canonical_url, confirmed_scope=confirmed_scope
    )
    print(present.generation.token)


if __name__ == "__main__":
    main()

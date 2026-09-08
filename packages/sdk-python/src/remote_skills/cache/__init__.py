"""Content-addressed cache primitives shared with the TypeScript SDK."""

from .base import ArchiveVerifier, CacheBackend, catalog_absence_generation
from .disk import (
    CACHE_COORDINATION_VERSION,
    DiskCache,
    catalog_mutation_digest,
    catalog_generation_state_digest,
    default_cache_root,
    origin_identifier,
)
from .errors import CacheConfigurationError, CacheCorruptError
from .memory import MemoryCache
from .models import (
    CacheLease,
    CachedCatalog,
    CachedObject,
    CatalogGeneration,
    CatalogMetadata,
    CatalogState,
    EvictionResult,
)

__all__ = [
    "CacheBackend",
    "ArchiveVerifier",
    "CACHE_COORDINATION_VERSION",
    "CacheConfigurationError",
    "CacheCorruptError",
    "CacheLease",
    "CachedCatalog",
    "CachedObject",
    "CatalogGeneration",
    "CatalogMetadata",
    "CatalogState",
    "DiskCache",
    "EvictionResult",
    "MemoryCache",
    "catalog_mutation_digest",
    "catalog_absence_generation",
    "catalog_generation_state_digest",
    "default_cache_root",
    "origin_identifier",
]

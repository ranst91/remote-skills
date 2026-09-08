"""Content-addressed cache primitives shared with the TypeScript SDK."""

from .base import ArchiveVerifier, CacheBackend, catalog_absence_generation
from .errors import CacheConfigurationError, CacheCorruptError
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
    "CacheConfigurationError",
    "CacheCorruptError",
    "CacheLease",
    "CachedCatalog",
    "CachedObject",
    "CatalogGeneration",
    "CatalogMetadata",
    "CatalogState",
    "EvictionResult",
    "catalog_absence_generation",
]

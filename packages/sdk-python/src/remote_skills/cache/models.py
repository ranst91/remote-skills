"""Language-neutral cache-v1 values."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from types import MappingProxyType
from typing import Mapping


@dataclass(frozen=True, slots=True)
class CatalogGeneration:
    """Opaque cross-runtime token for one exact catalog state."""

    token: str


@dataclass(frozen=True, slots=True)
class CatalogState:
    """One catalog value and the opaque generation that observed it."""

    catalog: CachedCatalog | None
    generation: CatalogGeneration


@dataclass(frozen=True, slots=True)
class CachedObject:
    """A verified immutable artifact and its already-normalized files."""

    digest: str
    artifact_type: str
    archive_format: str | None
    artifact: bytes
    files: Mapping[str, bytes]
    media_types: Mapping[str, str]
    verified_at: datetime
    accessed_at: datetime

    def __post_init__(self) -> None:
        object.__setattr__(self, "files", MappingProxyType(dict(self.files)))
        object.__setattr__(self, "media_types", MappingProxyType(dict(self.media_types)))


@dataclass(frozen=True, slots=True)
class CatalogMetadata:
    """Credential-free HTTP validators and freshness state."""

    canonical_url: str
    retrieved_at: datetime
    validated_at: datetime
    confirmed_scope: str | None = None
    etag: str | None = None
    last_modified: str | None = None
    cache_control: str | None = None


@dataclass(frozen=True, slots=True)
class CachedCatalog:
    """A validated catalog body and its cache metadata."""

    body: bytes
    metadata: CatalogMetadata


@dataclass(frozen=True, slots=True)
class CacheLease:
    """A cross-process pin for one immutable digest."""

    digest: str
    pid: int
    process_nonce: str
    session_nonce: str
    created_at: datetime
    renewed_at: datetime
    lease_nonce: str | None = None


@dataclass(frozen=True, slots=True)
class EvictionResult:
    """Deterministic summary of one bounded eviction run."""

    removed_digests: tuple[str, ...]
    retained_pinned: tuple[str, ...]
    bytes_before: int
    bytes_after: int

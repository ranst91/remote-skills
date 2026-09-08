"""Memory-only cache implementation."""

from __future__ import annotations

import os
import re
import secrets
from dataclasses import replace
from datetime import datetime, timezone
from threading import RLock
from typing import Callable

from ..catalog_scope import catalog_identifier, is_valid_scope
from .base import (
    ArchiveVerifier,
    _canonical_lease_timestamp,
    catalog_absence_generation,
    _next_lease_timestamp,
    _snapshot_datetime,
    snapshot_cache_lease,
    snapshot_cached_catalog,
    snapshot_cached_object,
    snapshot_unicode_scalar_string,
    validate_catalog_lookup_url,
    validate_cached_catalog,
    validate_cached_object,
    validate_catalog_generation,
    validate_digest,
    validate_nonnegative_safe_integer,
    validate_process_id,
)
from .errors import CacheConfigurationError, CacheCorruptError
from .models import (
    CacheLease,
    CachedCatalog,
    CachedObject,
    CatalogGeneration,
    CatalogState,
)


_NONCE_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}\Z")
_MAX_SAFE_INTEGER = 2**53 - 1


class MemoryCache:
    """Process-local immutable object cache with no filesystem side effects."""

    def __init__(
        self,
        *,
        clock: Callable[[], datetime] | None = None,
        archive_verifier: ArchiveVerifier | None = None,
    ) -> None:
        self._objects: dict[str, CachedObject] = {}
        self._catalogs: dict[tuple[str, str | None], CachedCatalog] = {}
        self._catalog_generations: dict[
            tuple[str, str | None], CatalogGeneration
        ] = {}
        self._catalog_epoch = 0
        self._leases: dict[tuple[str, str, str], CacheLease] = {}
        self._lease_generations: dict[str, datetime] = {}
        self._lock = RLock()
        self._clock = clock or (lambda: datetime.now(timezone.utc))
        self._archive_verifier = archive_verifier

    def get_catalog(
        self, canonical_url: str, *, confirmed_scope: str | None = None
    ) -> CachedCatalog | None:
        canonical_url = validate_catalog_lookup_url(canonical_url)
        if confirmed_scope is not None and not is_valid_scope(confirmed_scope):
            raise CacheConfigurationError("confirmed_scope")
        with self._lock:
            return self._catalogs.get((canonical_url, confirmed_scope))

    def get_catalog_state(
        self, canonical_url: str, *, confirmed_scope: str | None = None
    ) -> CatalogState:
        canonical_url = validate_catalog_lookup_url(canonical_url)
        if confirmed_scope is not None and not is_valid_scope(confirmed_scope):
            raise CacheConfigurationError("confirmed_scope")
        key = (canonical_url, confirmed_scope)
        with self._lock:
            catalog = self._catalogs.get(key)
            generation = self._catalog_generations.get(key)
            if generation is None:
                identifier = catalog_identifier(canonical_url, confirmed_scope)
                generation = catalog_absence_generation(
                    identifier, self._catalog_epoch
                )
            return CatalogState(catalog, generation)

    def publish_catalog(self, catalog: CachedCatalog) -> CachedCatalog:
        catalog = snapshot_cached_catalog(catalog)
        validate_cached_catalog(catalog)
        with self._lock:
            key = (catalog.metadata.canonical_url, catalog.metadata.confirmed_scope)
            self._advance_catalog_epoch()
            self._catalogs[key] = catalog
            self._catalog_generations[key] = _new_catalog_generation()
            return catalog

    def replace_catalog(
        self,
        catalog: CachedCatalog,
        *,
        expected_generation: CatalogGeneration,
    ) -> bool:
        """Atomically replace an unchanged catalog generation."""

        catalog = snapshot_cached_catalog(catalog)
        validate_cached_catalog(catalog)
        expected_generation = validate_catalog_generation(expected_generation)
        key = (catalog.metadata.canonical_url, catalog.metadata.confirmed_scope)
        with self._lock:
            current = self.get_catalog_state(
                key[0], confirmed_scope=key[1]
            ).generation
            if current != expected_generation:
                return False
            self._advance_catalog_epoch()
            self._catalogs[key] = catalog
            self._catalog_generations[key] = _new_catalog_generation()
            return True

    def delete_catalog(
        self,
        canonical_url: str,
        *,
        confirmed_scope: str | None,
        expected_generation: CatalogGeneration,
    ) -> bool:
        """Atomically delete one unchanged scoped catalog generation."""

        canonical_url = validate_catalog_lookup_url(canonical_url)
        if confirmed_scope is not None and not is_valid_scope(confirmed_scope):
            raise CacheConfigurationError("confirmed_scope")
        key = (canonical_url, confirmed_scope)
        expected_generation = validate_catalog_generation(expected_generation)
        with self._lock:
            if self.get_catalog_state(
                canonical_url, confirmed_scope=confirmed_scope
            ).generation != expected_generation:
                return False
            if key not in self._catalogs:
                return False
            self._advance_catalog_epoch()
            del self._catalogs[key]
            self._catalog_generations.pop(key, None)
            return True

    def get_object(self, digest: str) -> CachedObject | None:
        digest = validate_digest(digest)
        with self._lock:
            cached = self._objects.get(digest)
            if cached is not None:
                validate_cached_object(
                    cached,
                    archive_verifier=self._archive_verifier,
                )
            return cached

    def publish_object(self, cached: CachedObject) -> CachedObject:
        cached = snapshot_cached_object(cached)
        validate_cached_object(cached, archive_verifier=self._archive_verifier)
        with self._lock:
            return self._objects.setdefault(cached.digest, cached)

    def acquire_lease(
        self,
        digest: str,
        *,
        process_nonce: str,
        session_nonce: str,
        pid: int | None = None,
    ) -> CacheLease:
        digest = validate_digest(digest)
        process_nonce = self._validate_nonce(process_nonce)
        session_nonce = self._validate_nonce(session_nonce)
        selected_pid = os.getpid() if pid is None else pid
        selected_pid = validate_process_id(selected_pid)
        key = (digest, process_nonce, session_nonce)
        with self._lock:
            if key in self._leases:
                raise CacheConfigurationError("session_nonce")
            now = _canonical_lease_timestamp(self._now())
            previous = self._lease_generations.get(digest)
            if previous is not None:
                now = _next_lease_timestamp(now, previous)
            lease = CacheLease(
                digest=digest,
                pid=selected_pid,
                process_nonce=process_nonce,
                session_nonce=session_nonce,
                created_at=now,
                renewed_at=now,
            )
            self._leases[key] = lease
            self._lease_generations[digest] = now
        return lease

    def renew_lease(self, lease: CacheLease) -> CacheLease:
        lease = snapshot_cache_lease(lease)
        self._validate_lease(lease)
        key = (lease.digest, lease.process_nonce, lease.session_nonce)
        with self._lock:
            if self._leases.get(key) != lease:
                raise CacheCorruptError(lease.digest)
            renewed_at = _next_lease_timestamp(self._now(), lease.renewed_at)
            previous = self._lease_generations.get(lease.digest)
            if previous is not None and renewed_at <= previous:
                renewed_at = _next_lease_timestamp(renewed_at, previous)
            renewed = replace(lease, renewed_at=renewed_at)
            self._leases[key] = renewed
            self._lease_generations[lease.digest] = renewed.renewed_at
            return renewed

    def release_lease(self, lease: CacheLease) -> None:
        lease = snapshot_cache_lease(lease)
        self._validate_lease(lease)
        key = (lease.digest, lease.process_nonce, lease.session_nonce)
        with self._lock:
            current = self._leases.get(key)
            if current is None:
                return
            if current != lease:
                raise CacheCorruptError(lease.digest)
            del self._leases[key]
            previous = self._lease_generations.get(lease.digest)
            values = (lease.created_at, lease.renewed_at)
            self._lease_generations[lease.digest] = (
                max(*values, previous) if previous is not None else max(values)
            )

    def has_live_lease(self, digest: str, *, lease_expiry_seconds: int = 120) -> bool:
        digest = validate_digest(digest)
        validate_nonnegative_safe_integer(
            lease_expiry_seconds,
            "lease_expiry_seconds",
        )
        with self._lock:
            return any(key[0] == digest for key in self._leases)

    def _validate_nonce(self, value: object) -> str:
        if not isinstance(value, str):
            raise CacheConfigurationError("nonce")
        exact = snapshot_unicode_scalar_string(value)
        if _NONCE_PATTERN.fullmatch(exact) is None:
            raise CacheConfigurationError("nonce")
        return exact

    def _validate_lease(self, lease: CacheLease) -> None:
        if not isinstance(lease, CacheLease):
            raise CacheConfigurationError("lease")
        validate_digest(lease.digest)
        validate_process_id(lease.pid)
        self._validate_nonce(lease.process_nonce)
        self._validate_nonce(lease.session_nonce)
        for value in (lease.created_at, lease.renewed_at):
            if not isinstance(value, datetime) or value.utcoffset() is None:
                raise CacheConfigurationError("lease_timestamp")

    def _now(self) -> datetime:
        failed = False
        try:
            value = _snapshot_datetime(self._clock())
        except Exception:
            failed = True
            value = None
        if failed:
            raise CacheCorruptError()
        if not isinstance(value, datetime) or value.tzinfo is None:
            raise CacheConfigurationError("clock")
        return value.astimezone(timezone.utc)

    def _advance_catalog_epoch(self) -> None:
        if self._catalog_epoch >= _MAX_SAFE_INTEGER:
            raise CacheCorruptError()
        self._catalog_epoch += 1


def _new_catalog_generation() -> CatalogGeneration:
    return CatalogGeneration(f"sha256:{secrets.token_hex(32)}")

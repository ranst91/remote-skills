"""Digest-first activation of immutable catalog-selected artifacts."""

from __future__ import annotations

import asyncio
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from datetime import datetime, timezone
import hashlib
import re
import secrets
from typing import cast
from urllib.parse import urlsplit

from .archive import extract_archive, verify_cached_archive
from .cache import CacheBackend, CacheLease, CachedObject, DiskCache, MemoryCache
from .cache.disk import _ProcessRegistrationHeartbeat
from .catalog import SelectedCatalogRelease
from .catalog_errors import CatalogError
from .catalog_network import (
    AsyncTransport,
    Entropy,
    Resolver,
    Sleeper,
    default_resolver,
    request_with_policy,
)
from .catalog_origin import Origin
from .resources import ResourceInfo, ResourceView
from .skill_md import parse_skill_markdown


_DIGEST = re.compile(r"sha256:[0-9a-f]{64}\Z")
_MAX_SAFE_INTEGER = 2**53 - 1


@dataclass(frozen=True, slots=True)
class ActivationLimits:
    archive_bytes: int = 52_428_800
    extracted_bytes: int = 104_857_600
    files: int = 1_000
    file_bytes: int = 10_485_760

    def __post_init__(self) -> None:
        for name in ("archive_bytes", "extracted_bytes", "files", "file_bytes"):
            value = getattr(self, name)
            if (
                isinstance(value, bool)
                or type(value) is not int
                or not 1 <= value <= _MAX_SAFE_INTEGER
            ):
                raise CatalogError.configuration(name)


@dataclass(frozen=True, slots=True)
class ActivationPin:
    """The complete immutable authorization and artifact decision."""

    origin_alias: str
    confirmed_scope: str | None
    skill_name: str
    description: str
    artifact_type: str
    url: str
    version: str | None
    digest: str
    stale: bool
    is_current: bool = True

    @classmethod
    def from_selection(
        cls,
        selection: SelectedCatalogRelease,
        *,
        confirmed_scope: str | None = None,
    ) -> ActivationPin:
        if not isinstance(selection, SelectedCatalogRelease):
            raise CatalogError.configuration("selection")
        values = {
            "origin_alias": selection.origin_alias,
            "skill_name": selection.skill_name,
            "description": selection.description,
            "artifact_type": selection.artifact_type,
            "url": selection.url,
            "digest": selection.digest,
        }
        if any(type(value) is not str for value in values.values()):
            raise CatalogError.configuration("selection")
        if selection.version is not None and type(selection.version) is not str:
            raise CatalogError.configuration("selection")
        if type(selection.stale) is not bool or type(selection.is_current) is not bool:
            raise CatalogError.configuration("selection")
        if confirmed_scope is not None and type(confirmed_scope) is not str:
            raise CatalogError.configuration("confirmed_scope")
        if selection.artifact_type not in {"skill-md", "archive"}:
            raise CatalogError(
                "artifact_unsupported",
                retryable=False,
                context={
                    "origin_alias": selection.origin_alias,
                    "skill_name": selection.skill_name,
                },
            )
        if _DIGEST.fullmatch(selection.digest) is None:
            raise CatalogError(
                "artifact_unsupported",
                retryable=False,
                context={
                    "origin_alias": selection.origin_alias,
                    "skill_name": selection.skill_name,
                },
            )
        try:
            parsed = urlsplit(selection.url)
            parsed.port
        except ValueError:
            parsed = None
        if (
            parsed is None
            or parsed.scheme not in {"http", "https"}
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or parsed.query
            or parsed.fragment
        ):
            raise CatalogError(
                "artifact_unsupported",
                retryable=False,
                context={
                    "origin_alias": selection.origin_alias,
                    "skill_name": selection.skill_name,
                },
            )
        return cls(
            origin_alias=selection.origin_alias,
            confirmed_scope=confirmed_scope,
            skill_name=selection.skill_name,
            description=selection.description,
            artifact_type=selection.artifact_type,
            url=selection.url,
            version=selection.version,
            digest=selection.digest,
            stale=selection.stale,
            is_current=selection.is_current,
        )


@dataclass(slots=True)
class _ActiveLease:
    cache: CacheBackend
    lease: CacheLease
    heartbeat: _ProcessRegistrationHeartbeat | None = None
    released: bool = False

    def start(self) -> None:
        if isinstance(self.cache, DiskCache):
            self.heartbeat = self.cache._start_process_registration_heartbeat(
                self.lease.digest,
                self.lease.pid,
                self.lease.process_nonce,
                renew=self.renew,
            )

    def renew(self) -> None:
        self.lease = self.cache.renew_lease(self.lease)

    def release(self) -> None:
        if self.released:
            return
        try:
            if self.heartbeat is not None and isinstance(self.cache, DiskCache):
                self.cache._stop_process_registration_heartbeat(
                    self.heartbeat, self.lease.digest
                )
        finally:
            # Joining first makes the last renewed generation stable for release.
            if self.heartbeat is None or not self.heartbeat.thread.is_alive():
                self.cache.release_lease(self.lease)
                self.released = True


@dataclass(frozen=True, slots=True)
class ActivatedSkill:
    pin: ActivationPin
    instructions: str
    frontmatter: Mapping[str, object]
    _resources: ResourceView = field(repr=False, compare=False)
    _cache: CacheBackend | None = field(default=None, repr=False, compare=False)
    _lease: CacheLease | None = field(default=None, repr=False, compare=False)
    _active_lease: _ActiveLease | None = field(default=None, repr=False, compare=False)
    _session_guard: Callable[[], None] | None = field(
        default=None, repr=False, compare=False
    )

    @property
    def origin_alias(self) -> str:
        return self.pin.origin_alias

    @property
    def confirmed_scope(self) -> str | None:
        return self.pin.confirmed_scope

    @property
    def name(self) -> str:
        return self.pin.skill_name

    @property
    def description(self) -> str:
        return cast(str, self.frontmatter["description"])

    @property
    def artifact_type(self) -> str:
        return self.pin.artifact_type

    @property
    def url(self) -> str:
        return self.pin.url

    @property
    def version(self) -> str | None:
        return self.pin.version

    @property
    def digest(self) -> str:
        return self.pin.digest

    @property
    def stale(self) -> bool:
        return self.pin.stale

    async def list(self, prefix: str | None = None) -> tuple[ResourceInfo, ...]:
        self._ensure_session_open()
        return await self._resources.list(prefix)

    async def read(self, path: str) -> str:
        self._ensure_session_open()
        return await self._resources.read(path)

    async def read_bytes(self, path: str) -> bytes:
        self._ensure_session_open()
        return await self._resources.read_bytes(path)

    def _ensure_session_open(self) -> None:
        if self._session_guard is not None:
            self._session_guard()

    async def _release_pin(self) -> None:
        if self._active_lease is not None:
            self._active_lease.release()
        elif self._cache is not None and self._lease is not None:
            self._cache.release_lease(self._lease)


def _archive_format(url: str, content_type: str | None) -> str:
    normalized = (content_type or "").split(";", 1)[0].strip().lower()
    if normalized == "application/zip":
        return "zip"
    if normalized in {"application/gzip", "application/x-gzip"}:
        return "tar.gz"
    path = urlsplit(url).path.lower()
    if path.endswith(".zip"):
        return "zip"
    if path.endswith((".tar.gz", ".tgz")):
        return "tar.gz"
    raise CatalogError("artifact_unsupported", retryable=False, context={})


def _artifact_accept(pin: ActivationPin) -> str:
    if pin.artifact_type == "skill-md":
        return "text/markdown"
    path = urlsplit(pin.url).path.lower()
    if path.endswith(".zip"):
        return "application/zip"
    if path.endswith((".tar.gz", ".tgz")):
        return "application/gzip"
    return "application/octet-stream"


def _parse_verified_object(
    pin: ActivationPin,
    artifact: bytes,
    *,
    content_type: str | None,
    limits: ActivationLimits,
) -> CachedObject:
    if len(artifact) > limits.archive_bytes:
        raise CatalogError(
            "limit_exceeded", retryable=False, context={"limit": "archive_bytes"}
        )
    actual_digest = f"sha256:{hashlib.sha256(artifact).hexdigest()}"
    if actual_digest != pin.digest:
        raise CatalogError(
            "digest_mismatch",
            retryable=False,
            context={
                "origin_alias": pin.origin_alias,
                "skill_name": pin.skill_name,
                "expected_digest": pin.digest,
            },
        )

    archive_format: str | None = None
    if pin.artifact_type == "skill-md":
        if limits.files < 1:
            raise CatalogError(
                "limit_exceeded", retryable=False, context={"limit": "files"}
            )
        if len(artifact) > limits.file_bytes:
            raise CatalogError(
                "limit_exceeded", retryable=False, context={"limit": "file_bytes"}
            )
        if len(artifact) > limits.extracted_bytes:
            raise CatalogError(
                "limit_exceeded",
                retryable=False,
                context={"limit": "extracted_bytes"},
            )
        files = {"SKILL.md": artifact}
        media_types = {"SKILL.md": "text/markdown"}
    else:
        archive_format = _archive_format(pin.url, content_type)
        files, media_types = extract_archive(
            artifact,
            archive_format,
            extracted_bytes=limits.extracted_bytes,
            files=limits.files,
            file_bytes=limits.file_bytes,
        )

    frontmatter, _instructions = parse_skill_markdown(files["SKILL.md"])
    if frontmatter["name"] != pin.skill_name:
        raise CatalogError(
            "catalog_invalid", retryable=False, context={"field": "name"}
        )
    if pin.is_current and frontmatter["description"] != pin.description:
        raise CatalogError(
            "catalog_invalid", retryable=False, context={"field": "description"}
        )
    now = datetime.now(timezone.utc)
    return CachedObject(
        digest=pin.digest,
        artifact_type=pin.artifact_type,
        archive_format=archive_format,
        artifact=artifact,
        files=files,
        media_types=media_types,
        verified_at=now,
        accessed_at=now,
    )


def _skill_from_cached(
    pin: ActivationPin,
    cached: CachedObject,
    *,
    cache: CacheBackend | None = None,
    lease: CacheLease | None = None,
    active_lease: _ActiveLease | None = None,
) -> ActivatedSkill:
    frontmatter, instructions = parse_skill_markdown(cached.files["SKILL.md"])
    if frontmatter["name"] != pin.skill_name:
        raise CatalogError(
            "catalog_invalid", retryable=False, context={"field": "name"}
        )
    if pin.is_current and frontmatter["description"] != pin.description:
        raise CatalogError(
            "catalog_invalid", retryable=False, context={"field": "description"}
        )
    return ActivatedSkill(
        pin=pin,
        instructions=instructions,
        frontmatter=frontmatter,
        _resources=ResourceView(cached.files, cached.media_types),
        _cache=cache,
        _lease=lease,
        _active_lease=active_lease,
    )


def _enforce_cached_limits(cached: CachedObject, limits: ActivationLimits) -> None:
    if len(cached.artifact) > limits.archive_bytes:
        raise CatalogError(
            "limit_exceeded", retryable=False, context={"limit": "archive_bytes"}
        )
    if len(cached.files) > limits.files:
        raise CatalogError(
            "limit_exceeded", retryable=False, context={"limit": "files"}
        )
    total = 0
    for content in cached.files.values():
        if len(content) > limits.file_bytes:
            raise CatalogError(
                "limit_exceeded", retryable=False, context={"limit": "file_bytes"}
            )
        total += len(content)
        if total > limits.extracted_bytes:
            raise CatalogError(
                "limit_exceeded",
                retryable=False,
                context={"limit": "extracted_bytes"},
            )


def activate_artifact_bytes(
    selection: SelectedCatalogRelease,
    artifact: bytes,
    *,
    confirmed_scope: str | None = None,
    content_type: str | None = None,
    limits: ActivationLimits | None = None,
) -> ActivatedSkill:
    """Verify exact bytes before parsing or exposing any content."""

    pin = ActivationPin.from_selection(selection, confirmed_scope=confirmed_scope)
    if type(artifact) is not bytes:
        raise CatalogError.configuration("artifact")
    if content_type is not None and type(content_type) is not str:
        raise CatalogError.configuration("content_type")
    selected_limits = limits or ActivationLimits()
    if not isinstance(selected_limits, ActivationLimits):
        raise CatalogError.configuration("limits")
    cached = _parse_verified_object(
        pin,
        artifact,
        content_type=content_type,
        limits=selected_limits,
    )
    return _skill_from_cached(pin, cached)


async def activate_selected(
    selection: SelectedCatalogRelease,
    *,
    origin: Origin,
    transport: AsyncTransport,
    resolver: Resolver = default_resolver,
    confirmed_scope: str | None = None,
    cache: CacheBackend | None = None,
    limits: ActivationLimits | None = None,
    process_nonce: str | None = None,
    session_nonce: str | None = None,
    sleeper: Sleeper = asyncio.sleep,
    entropy: Entropy = secrets.SystemRandom().random,
) -> ActivatedSkill:
    """Acquire a digest pin, reuse or fetch bytes, then publish only verified data."""

    if not isinstance(origin, Origin):
        raise CatalogError.configuration("origin")
    if origin.scope is not None and confirmed_scope != origin.scope:
        raise CatalogError(
            "catalog_invalid",
            retryable=False,
            context={"origin_alias": selection.origin_alias, "field": "confirmed_scope"},
        )
    pin = ActivationPin.from_selection(selection, confirmed_scope=confirmed_scope)
    selected_limits = limits or ActivationLimits()
    if not isinstance(selected_limits, ActivationLimits):
        raise CatalogError.configuration("limits")
    if cache is not None and not isinstance(cache, CacheBackend):
        raise CatalogError.configuration("cache")
    selected_cache = (
        cache
        if cache is not None
        else MemoryCache(archive_verifier=verify_cached_archive)
    )
    process_id = process_nonce or f"python-{secrets.token_hex(16)}"
    session_id = session_nonce or f"activation-{secrets.token_hex(16)}"
    lease = selected_cache.acquire_lease(
        pin.digest,
        process_nonce=process_id,
        session_nonce=session_id,
    )
    active_lease = _ActiveLease(selected_cache, lease)
    try:
        active_lease.start()
        cached = selected_cache.get_object(pin.digest)
        if cached is None:
            result = await request_with_policy(
                origin_alias=pin.origin_alias,
                origin=origin,
                url=pin.url,
                purpose="skill-md" if pin.artifact_type == "skill-md" else "archive",
                transport=transport,
                resolver=resolver,
                sleeper=sleeper,
                entropy=entropy,
                max_bytes=selected_limits.archive_bytes,
                response_limit="archive_bytes",
                accept=_artifact_accept(pin),
            )
            if result.error is not None:
                raise result.error
            response = result.response
            if response is None or response.status != 200:
                raise CatalogError(
                    "origin_unavailable",
                    retryable=True,
                    context={"origin_alias": pin.origin_alias},
                )
            cached = _parse_verified_object(
                pin,
                response.body,
                content_type=response.headers.get("content-type"),
                limits=selected_limits,
            )
            cached = selected_cache.publish_object(cached)
        if cached.digest != pin.digest or cached.artifact_type != pin.artifact_type:
            raise CatalogError(
                "cache_corrupt", retryable=False, context={"digest": pin.digest}
            )
        _enforce_cached_limits(cached, selected_limits)
        return _skill_from_cached(
            pin, cached, cache=selected_cache, lease=lease, active_lease=active_lease
        )
    except BaseException:
        active_lease.release()
        raise


__all__ = [
    "ActivatedSkill",
    "ActivationLimits",
    "ActivationPin",
    "ResourceInfo",
    "activate_artifact_bytes",
    "activate_selected",
    "verify_cached_archive",
]

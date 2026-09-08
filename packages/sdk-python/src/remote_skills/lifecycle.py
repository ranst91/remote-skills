"""Public async facade and immutable origin-bound session lifecycle."""

from __future__ import annotations

import asyncio
from collections.abc import Callable, Coroutine, Generator, Mapping
from dataclasses import dataclass, replace
import math
import secrets
import time
from types import TracebackType
from typing import Any

from .activation import (
    ActivatedSkill,
    ActivationLimits,
    activate_selected,
    verify_cached_archive,
)
from .cache import CacheBackend, DiskCache
from .cache.disk import DEFAULT_MAX_CATALOG_BYTES
from .cache.errors import CacheCorruptError
from .catalog import CatalogEntry, CatalogSnapshot, select_catalog_release
from .catalog_client import AggregateCatalog, CatalogDiscovery
from .catalog_errors import CatalogError
from .catalog_network import (
    AsyncTransport,
    Resolver,
    StdlibTransport,
    default_resolver,
)
from .catalog_origin import CatalogDefaults, Origin


_MAX_STALE_AGE_SECONDS = 2_147_483_648.0


@dataclass(frozen=True, slots=True)
class SessionMetadata:
    """Non-secret identity and freshness metadata for one catalog snapshot."""

    origin_alias: str
    confirmed_scope: str | None
    stale: bool
    catalog_age_seconds: float | None = None


@dataclass(frozen=True, slots=True)
class StaleCatalog:
    """Explicit maximum verified catalog age for offline session creation."""

    max_age_seconds: float

    def __post_init__(self) -> None:
        value = self.max_age_seconds
        if (
            isinstance(value, bool)
            or not isinstance(value, (int, float))
            or not math.isfinite(value)
            or not 0 <= value <= _MAX_STALE_AGE_SECONDS
        ):
            raise CatalogError.configuration("max_age_seconds")
        object.__setattr__(self, "max_age_seconds", float(value))


class RemoteSkillsSession:
    """One immutable catalog snapshot and its digest-pinned activations."""

    def __init__(
        self,
        *,
        snapshot: CatalogSnapshot,
        origin: Origin,
        cache: CacheBackend,
        transport: AsyncTransport,
        resolver: Resolver,
        limits: ActivationLimits,
        process_nonce: str,
    ) -> None:
        self._snapshot = snapshot
        self._origin = origin
        self._cache = cache
        self._transport = transport
        self._resolver = resolver
        self._limits = limits
        self._process_nonce = process_nonce
        self._session_nonce = f"session-{secrets.token_hex(16)}"
        self._activation_tasks: dict[str, asyncio.Task[ActivatedSkill]] = {}
        self._close_task: asyncio.Task[None] | None = None
        self._closed = False

    @property
    def metadata(self) -> SessionMetadata:
        return SessionMetadata(
            origin_alias=self._snapshot.origin_alias,
            confirmed_scope=self._snapshot.confirmed_scope,
            stale=self._snapshot.stale,
            catalog_age_seconds=self._snapshot.catalog_age_seconds,
        )

    @property
    def stale(self) -> bool:
        return self._snapshot.stale

    @property
    def closed(self) -> bool:
        return self._closed

    async def catalog(self) -> tuple[CatalogEntry, ...]:
        self._ensure_open()
        return self._snapshot.entries

    async def activate(
        self, skill_name: str, version_range: str | None = None
    ) -> ActivatedSkill:
        self._ensure_open()
        task = self._activation_tasks.get(skill_name)
        if task is None:
            task = asyncio.create_task(self._activate(skill_name, version_range))
            self._activation_tasks[skill_name] = task
            task.add_done_callback(
                lambda completed: self._discard_failed_activation(
                    skill_name, completed
                )
            )
        skill = await asyncio.shield(task)
        self._ensure_open()
        return skill

    def _discard_failed_activation(
        self, skill_name: str, task: asyncio.Task[ActivatedSkill]
    ) -> None:
        if not task.cancelled() and task.exception() is None:
            return
        if self._activation_tasks.get(skill_name) is task:
            self._activation_tasks.pop(skill_name, None)

    async def _activate(
        self, skill_name: str, version_range: str | None
    ) -> ActivatedSkill:
        selection = select_catalog_release(
            self._snapshot,
            skill_name=skill_name,
            requested_range=version_range,
        )
        skill = await activate_selected(
            selection,
            origin=self._origin,
            transport=self._transport,
            resolver=self._resolver,
            confirmed_scope=self._snapshot.confirmed_scope,
            cache=self._cache,
            limits=self._limits,
            process_nonce=self._process_nonce,
            session_nonce=f"{self._session_nonce}-{secrets.token_hex(8)}",
        )
        return replace(skill, _session_guard=self._ensure_open)

    async def close(self) -> None:
        """Release all pins; a later call retries only unfinished releases."""
        if self._close_task is None or (
            self._close_task.done() and self._close_task.exception() is not None
        ):
            self._closed = True
            self._close_task = asyncio.create_task(self._release_activations())
        await asyncio.shield(self._close_task)

    async def _release_activations(self) -> None:
        activations = tuple(self._activation_tasks.items())
        settled = await asyncio.gather(
            *(task for _, task in activations), return_exceptions=True
        )
        failed = False
        for (name, _), result in zip(activations, settled):
            if isinstance(result, ActivatedSkill):
                try:
                    await result._release_pin()
                except Exception:
                    failed = True
                    # Heartbeat shutdown may report an error after releasing the pin.
                    if result._active_lease is None or not result._active_lease.released:
                        continue
            self._activation_tasks.pop(name, None)
        if failed:
            # Backend exceptions may contain private paths or other unsafe details.
            raise CacheCorruptError()

    async def __aenter__(self) -> RemoteSkillsSession:
        self._ensure_open()
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        del exc_type, exc_value, traceback
        await self.close()

    def _ensure_open(self) -> None:
        if self._closed:
            raise CatalogError(
                "session_closed",
                retryable=False,
                context={"origin_alias": self._snapshot.origin_alias},
            )


class _SessionRequest(Coroutine[Any, Any, RemoteSkillsSession]):
    def __init__(
        self,
        client: RemoteSkills,
        origin_alias: str,
        stale: StaleCatalog | None,
    ) -> None:
        self._coroutine = client._open_session(origin_alias, stale=stale)
        self._session: RemoteSkillsSession | None = None

    def send(self, value: Any) -> Any:
        return self._coroutine.send(value)

    def throw(self, *args: Any) -> Any:
        return self._coroutine.throw(*args)

    def close(self) -> None:
        self._coroutine.close()

    def __await__(self) -> Generator[Any, None, RemoteSkillsSession]:
        return self._coroutine.__await__()

    async def __aenter__(self) -> RemoteSkillsSession:
        self._session = await self
        return await self._session.__aenter__()

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        if self._session is not None:
            await self._session.__aexit__(exc_type, exc_value, traceback)


class RemoteSkills:
    """Async Remote Skills client across explicitly configured origins."""

    def __init__(
        self,
        *,
        origins: Mapping[str, Origin],
        defaults: CatalogDefaults | None = None,
        cache: CacheBackend | None = None,
        transport: AsyncTransport | None = None,
        resolver: Resolver | None = None,
        clock: Callable[[], float] = time.time,
        limits: ActivationLimits | None = None,
    ) -> None:
        if not isinstance(origins, Mapping) or not origins:
            raise CatalogError.configuration("origins")
        selected_defaults = defaults or CatalogDefaults()
        if not isinstance(selected_defaults, CatalogDefaults):
            raise CatalogError.configuration("defaults")
        if any(not isinstance(origin, Origin) for origin in origins.values()):
            raise CatalogError.configuration("origins")
        selected_origins = {
            alias: origin.with_defaults(selected_defaults)
            for alias, origin in origins.items()
        }
        selected_limits = limits if limits is not None else ActivationLimits()
        if not isinstance(selected_limits, ActivationLimits):
            raise CatalogError.configuration("limits")
        # Shared cache-v1 keeps its fixed body cap; larger network catalogs remain usable.
        catalog_cache_bytes = min(
            DEFAULT_MAX_CATALOG_BYTES,
            max(
                origin.catalog_bytes for origin in selected_origins.values()
                if origin.catalog_bytes is not None
            ),
        )
        selected_cache = (
            cache
            if cache is not None
            else DiskCache(
                archive_verifier=verify_cached_archive,
                max_catalog_bytes=catalog_cache_bytes,
                max_artifact_bytes=selected_limits.archive_bytes,
                max_extracted_bytes=selected_limits.extracted_bytes,
                max_file_bytes=selected_limits.file_bytes,
                max_files_per_object=selected_limits.files,
            )
        )
        selected_transport = transport if transport is not None else StdlibTransport()
        selected_resolver = resolver if resolver is not None else default_resolver
        self._origins = selected_origins
        self._cache = selected_cache
        self._transport = selected_transport
        self._resolver = selected_resolver
        self._limits = selected_limits
        self._process_nonce = f"python-{secrets.token_hex(16)}"
        self._discovery = CatalogDiscovery(
            origins=selected_origins,
            defaults=selected_defaults,
            cache=selected_cache,
            transport=selected_transport,
            resolver=selected_resolver,
            clock=clock,
            catalog_persistence_max_bytes=(catalog_cache_bytes if cache is None else None),
        )

    async def catalog(self, *, strict: bool = False) -> AggregateCatalog:
        return await self._discovery.aggregate(strict=strict)

    def session(
        self, origin_alias: str, *, stale: StaleCatalog | None = None
    ) -> _SessionRequest:
        if stale is not None and not isinstance(stale, StaleCatalog):
            raise CatalogError.configuration("stale")
        return _SessionRequest(self, origin_alias, stale)

    async def refresh(self, origin_alias: str | None = None) -> None:
        aliases = tuple(self._origins) if origin_alias is None else (origin_alias,)
        for alias in aliases:
            if alias not in self._origins:
                raise CatalogError.configuration("origin_alias")
        for alias in aliases:
            await self._discovery.catalog(alias, refresh=True)

    async def _open_session(
        self, origin_alias: str, *, stale: StaleCatalog | None
    ) -> RemoteSkillsSession:
        origin = self._origins.get(origin_alias)
        if origin is None:
            raise CatalogError.configuration("origin_alias")
        snapshot = await self._discovery.catalog(
            origin_alias,
            stale_max_age=(None if stale is None else stale.max_age_seconds),
        )
        return RemoteSkillsSession(
            snapshot=snapshot,
            origin=origin,
            cache=self._cache,
            transport=self._transport,
            resolver=self._resolver,
            limits=self._limits,
            process_nonce=self._process_nonce,
        )


__all__ = [
    "RemoteSkills",
    "RemoteSkillsSession",
    "SessionMetadata",
    "StaleCatalog",
]

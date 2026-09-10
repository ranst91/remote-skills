"""Async catalog-only discovery across explicitly configured origins."""

from __future__ import annotations

import asyncio
from collections.abc import Callable, Mapping
from dataclasses import dataclass, replace
from datetime import datetime, timezone
import math
import re
import time
from types import MappingProxyType
from weakref import WeakKeyDictionary

from .cache.base import CacheBackend, validate_cached_catalog
from .cache.errors import CacheConfigurationError, CacheCorruptError
from .cache.models import CachedCatalog, CatalogGeneration, CatalogMetadata
from .catalog import CatalogEntry, CatalogSnapshot, parse_catalog
from .catalog_errors import CatalogError
from .catalog_http_date import parse_imf_fixdate, trim_ecmascript_whitespace
from .catalog_network import (
    AsyncTransport,
    Resolver,
    StdlibTransport,
    default_resolver,
    request_with_policy,
)
from .catalog_origin import CatalogDefaults, Origin
from .catalog_scope import SCOPE_HEADER, catalog_identifier, is_valid_scope


_ALIAS = re.compile(r"[a-z][a-z0-9._-]{0,62}\Z")
_DELTA_SECONDS_BOUND = 2_147_483_648
_DELTA_SECONDS_BOUND_DIGITS = len(str(_DELTA_SECONDS_BOUND))
_DELTA_SECONDS = re.compile(r"[0-9]+\Z")
_QUOTED_DELTA_SECONDS = re.compile(r'"([0-9]+)"\Z')
_HTTP_TOKEN = re.compile(r"[!#$%&'*+\-.^_`|~0-9A-Za-z]+\Z")


@dataclass(frozen=True, slots=True)
class OriginFailure:
    origin_alias: str
    error: CatalogError


@dataclass(frozen=True, slots=True)
class _ParsedCacheControl:
    max_age: int | None
    max_age_invalid: bool
    no_cache: bool
    no_store: bool


@dataclass(frozen=True, slots=True)
class AggregateCatalog:
    entries: tuple[CatalogEntry, ...]
    failures: tuple[OriginFailure, ...]


_AGGREGATE_ERROR_STATE: WeakKeyDictionary[
    BaseException, tuple[tuple[OriginFailure, ...], str]
] = WeakKeyDictionary()


class AggregateCatalogError(Exception):
    """Strict aggregate failure retaining sanitized per-origin details."""

    __slots__ = ("__weakref__",)

    def __init__(self, failures: tuple[OriginFailure, ...]) -> None:
        message = "Remote Skills aggregate catalog failed"
        super().__init__(message)
        _AGGREGATE_ERROR_STATE[self] = (tuple(failures), message)

    def __getattribute__(self, name: str) -> object:
        if name == "__dict__":
            instance_dict = super().__getattribute__("__dict__")
            return MappingProxyType(instance_dict)
        return super().__getattribute__(name)

    def __setattr__(self, name: str, value: object) -> None:
        if name in {"__dict__", "_failures", "failures", "args"}:
            raise AttributeError(f"{name} is read-only")
        super().__setattr__(name, value)

    def __delattr__(self, name: str) -> None:
        if name in {"__dict__", "_failures", "failures", "args"}:
            raise AttributeError(f"{name} is read-only")
        super().__delattr__(name)

    @property
    def _state(self) -> tuple[tuple[OriginFailure, ...], str]:
        return _AGGREGATE_ERROR_STATE[self]

    @property
    def _failures(self) -> tuple[OriginFailure, ...]:
        return self._state[0]

    @property
    def failures(self) -> tuple[OriginFailure, ...]:
        return self._failures

    @property
    def args(self) -> tuple[str]:
        return (self._state[1],)

    @args.setter
    def args(self, _value: object) -> None:
        raise AttributeError("args is read-only")

    @args.deleter
    def args(self) -> None:
        raise AttributeError("args is read-only")

    def __str__(self) -> str:
        return self._state[1]

    def __repr__(self) -> str:
        return f"{type(self).__name__}({self._state[1]!r})"


@dataclass(frozen=True, slots=True)
class _CacheRecord:
    snapshot: CatalogSnapshot
    body: bytes
    response_headers: Mapping[str, str]
    etag: str | None
    last_modified: str | None
    fresh_until: float
    retrieved_at: datetime
    validated_at: datetime
    persistent_generation: CatalogGeneration | None = None
    authoritative: bool = True


_ACCEPTED_CATALOGS: WeakKeyDictionary[
    CacheBackend, dict[str, _CacheRecord]
] = WeakKeyDictionary()


def _accepted_records(backend: CacheBackend) -> dict[str, _CacheRecord] | None:
    try:
        return _ACCEPTED_CATALOGS.setdefault(backend, {})
    except TypeError:
        # Custom backends need not support weak references; cold reuse remains conservative.
        return None


class CatalogDiscovery:
    """Catalog-only async access with optional persistent catalog caching."""

    def __init__(
        self,
        *,
        origins: Mapping[str, Origin],
        defaults: CatalogDefaults | None = None,
        transport: AsyncTransport | None = None,
        resolver: Resolver | None = None,
        clock: Callable[[], float] = time.time,
        cache: CacheBackend | None = None,
        catalog_persistence_max_bytes: int | None = None,
    ) -> None:
        if not isinstance(origins, Mapping) or not origins:
            raise CatalogError.configuration("origins")
        selected_defaults = defaults or CatalogDefaults()
        if not isinstance(selected_defaults, CatalogDefaults):
            raise CatalogError.configuration("defaults")
        validated: dict[str, Origin] = {}
        for alias, origin in origins.items():
            if not isinstance(alias, str) or _ALIAS.fullmatch(alias) is None:
                raise CatalogError.configuration("origins")
            if not isinstance(origin, Origin):
                raise CatalogError.configuration("origins")
            validated[alias] = origin.with_defaults(selected_defaults)
        self._origins = validated
        self._transport = transport or StdlibTransport()
        self._resolver = resolver or default_resolver
        self._clock = clock
        if cache is not None and not isinstance(cache, CacheBackend):
            raise CatalogError.configuration("cache")
        self._catalog_cache = cache
        if catalog_persistence_max_bytes is not None and (
            type(catalog_persistence_max_bytes) is not int
            or not 1 <= catalog_persistence_max_bytes <= 2**53 - 1
        ):
            raise CatalogError.configuration("catalog_persistence_max_bytes")
        self._catalog_persistence_max_bytes = catalog_persistence_max_bytes
        identities = {
            alias: _catalog_cache_identity(alias, origin)
            for alias, origin in validated.items()
        }
        self._cache_identities = identities
        self._cache: dict[str, _CacheRecord] = {}
        self._persistent_generations: dict[str, CatalogGeneration] = {}
        self._generations = {identity: 0 for identity in identities.values()}
        self._identity_locks = {
            identity: asyncio.Lock() for identity in identities.values()
        }

    async def catalog(
        self,
        origin_alias: str,
        *,
        refresh: bool = False,
        stale_max_age: float | None = None,
    ) -> CatalogSnapshot:
        """Return one origin's compact catalog snapshot or raise its typed failure."""

        if type(refresh) is not bool:
            raise CatalogError.configuration("refresh")
        if stale_max_age is not None and (
            isinstance(stale_max_age, bool)
            or not isinstance(stale_max_age, (int, float))
            or not 0 <= stale_max_age <= _DELTA_SECONDS_BOUND
        ):
            raise CatalogError.configuration("stale_max_age")
        origin = self._origins.get(origin_alias)
        if origin is None:
            raise CatalogError.configuration("origin_alias")
        identity = self._cache_identities[origin_alias]
        identity_lock = self._identity_locks[identity]
        async with identity_lock:
            cached = self._cache.get(identity)
            if cached is None:
                cached, persistent_generation = await asyncio.to_thread(
                    self._load_persistent_state, origin_alias, origin
                )
                if persistent_generation is not None:
                    self._persistent_generations[identity] = persistent_generation
                if cached is not None:
                    self._cache[identity] = cached
            cached = _retarget_record(cached, origin_alias, origin)
            request_time = self._clock()
            if cached is not None and not refresh and request_time < cached.fresh_until:
                return cached.snapshot
            generation = self._generations[identity] + 1
            self._generations[identity] = generation

        def is_current_generation() -> bool:
            return self._generations[identity] == generation

        validators: dict[str, str] = {}
        if cached is not None:
            if cached.etag is not None:
                validators["if-none-match"] = cached.etag
            if cached.last_modified is not None:
                validators["if-modified-since"] = cached.last_modified
        result = await request_with_policy(
            origin_alias=origin_alias,
            origin=origin,
            url=origin.catalog_url,
            purpose="catalog",
            transport=self._transport,
            resolver=self._resolver,
            request_headers=validators,
            wall_clock=self._clock,
        )
        response_time = self._clock()
        if result.error is not None:
            if (
                stale_max_age is not None
                and cached is not None
                and result.error.code in {"origin_unavailable", "request_timeout"}
            ):
                age = response_time - cached.validated_at.timestamp()
                if math.isfinite(age) and 0 <= age <= stale_max_age:
                    return replace(
                        cached.snapshot,
                        stale=True,
                        catalog_age_seconds=age,
                    )
            raise result.error
        response = result.response
        if response is None:
            raise AssertionError("successful network result omitted response")

        try:
            confirmed_scope = _confirmed_scope(
                origin_alias=origin_alias,
                requested_scope=origin.scope,
                response_headers=response.headers,
            )
        except CatalogError:
            async with identity_lock:
                if is_current_generation():
                    await self._invalidate_persistent_record(
                        identity=identity,
                        origin_alias=origin_alias,
                        origin=origin,
                        cached=cached,
                    )
            raise

        if response.status == 304:
            if cached is None:
                raise CatalogError(
                    "origin_unavailable",
                    retryable=True,
                    context={"origin_alias": origin_alias, "status": 304},
                )
            cached = _retarget_record(cached, origin_alias, origin)
            if cached is None:
                raise AssertionError("catalog record disappeared during 304 reuse")
            merged_headers = {**cached.response_headers, **response.headers}
            persistent = (
                _persistent_eligible(
                    origin=origin,
                    headers=merged_headers,
                    confirmed_scope=confirmed_scope,
                )
                and self._catalog_body_fits_persistence(cached.body)
                and _preserves_resolution(cached.body, cached.snapshot, origin)
            )
            snapshot = replace(
                cached.snapshot,
                confirmed_scope=confirmed_scope,
                persistent=persistent,
                catalog_identifier=(
                    catalog_identifier(origin.catalog_url, confirmed_scope)
                    if persistent
                    else None
                ),
            )
            if not _should_store(merged_headers):
                async with identity_lock:
                    if is_current_generation():
                        await self._invalidate_persistent_record(
                            identity=identity,
                            origin_alias=origin_alias,
                            origin=origin,
                            cached=cached,
                        )
                return snapshot
            record = _updated_record(
                replace(cached, snapshot=snapshot),
                merged_headers,
                request_time=request_time,
                response_time=response_time,
            )
            async with identity_lock:
                if is_current_generation():
                    committed = await self._publish_persistent_record(
                        origin=origin,
                        record=record,
                        validated_at=response_time,
                    )
                    if committed is not None and committed.authoritative:
                        self._cache[identity] = committed
                    return (committed or record).snapshot
            return record.snapshot

        if response.url is None:
            raise AssertionError("successful network response omitted final URL")
        try:
            snapshot = parse_catalog(
                _accepted_record_body(response.body, origin_alias, origin),
                origin_alias=origin_alias,
                index_url=response.url,
            )
        except CatalogError:
            async with identity_lock:
                if is_current_generation():
                    await self._invalidate_persistent_record(
                        identity=identity,
                        origin_alias=origin_alias,
                        origin=origin,
                        cached=cached,
                    )
            raise
        persistent = (
            _persistent_eligible(
                origin=origin,
                headers=response.headers,
                confirmed_scope=confirmed_scope,
            )
            and self._catalog_body_fits_persistence(response.body)
            and _preserves_resolution(response.body, snapshot, origin)
        )
        snapshot = replace(
            snapshot,
            confirmed_scope=confirmed_scope,
            persistent=persistent,
            catalog_identifier=(
                catalog_identifier(origin.catalog_url, confirmed_scope)
                if persistent
                else None
            ),
        )
        record = _new_record(
            snapshot,
            response.body,
            response.headers,
            request_time=request_time,
            response_time=response_time,
        )
        async with identity_lock:
            if not is_current_generation():
                return snapshot
            if not persistent:
                await self._invalidate_persistent_record(
                    identity=identity,
                    origin_alias=origin_alias,
                    origin=origin,
                    cached=cached,
                )
                if _should_store(response.headers):
                    self._cache[identity] = record
            else:
                committed = await self._publish_persistent_record(
                    origin=origin,
                    record=replace(
                        record,
                        persistent_generation=(
                            cached.persistent_generation
                            if cached is not None
                            and cached.persistent_generation is not None
                            else self._persistent_generations.get(identity)
                        ),
                    ),
                    validated_at=response_time,
                )
                if committed is not None and committed.authoritative:
                    self._cache[identity] = committed
                return (committed or record).snapshot
        return snapshot

    def _catalog_body_fits_persistence(self, body: bytes) -> bool:
        maximum = self._catalog_persistence_max_bytes
        return maximum is None or len(body) <= maximum

    def _load_persistent_state(
        self,
        origin_alias: str,
        origin: Origin,
        accepted: tuple[_CacheRecord, CachedCatalog] | None = None,
    ) -> tuple[_CacheRecord | None, CatalogGeneration | None]:
        backend = self._catalog_cache
        if backend is None or (origin.scope is None and origin.headers):
            return None, None
        state = backend.get_catalog_state(
            origin.catalog_url,
            confirmed_scope=origin.scope,
        )
        cached = state.catalog
        if cached is None:
            return None, state.generation
        metadata = cached.metadata
        if (
            metadata.canonical_url != origin.catalog_url
            or metadata.confirmed_scope != origin.scope
        ):
            raise CatalogError.invalid(origin_alias, "persistent_catalog")
        _accepted_record_body(cached.body, origin_alias, origin)
        records = _accepted_records(backend)
        key = _catalog_cache_identity(origin_alias, origin)
        if accepted is not None and cached == accepted[1]:
            # Keep the network's full freshness and resolved descriptors when our CAS won.
            record = replace(accepted[0], persistent_generation=state.generation)
            if records is not None:
                if len(records) >= 128:
                    del records[next(iter(records))]
                records[key] = record
            return record, state.generation
        previous = records.get(key) if records is not None else None
        if previous is not None and previous.persistent_generation == state.generation:
            return _retarget_record(previous, origin_alias, origin), state.generation
        snapshot = parse_catalog(
            _accepted_record_body(cached.body, origin_alias, origin),
            origin_alias=origin_alias,
            index_url=origin.catalog_url,
        )
        # Cache-v1 records no final URL, so relative references lack resolution evidence.
        alternate_scheme = "http" if origin.catalog_url.startswith("https:") else "https"
        alternate = parse_catalog(
            cached.body,
            origin_alias=origin_alias,
            index_url=f"{alternate_scheme}://catalog-cache-base.invalid/other/index.json",
        )
        if snapshot.entries != alternate.entries:
            return None, state.generation
        snapshot = replace(
            snapshot,
            confirmed_scope=metadata.confirmed_scope,
            persistent=True,
            catalog_identifier=catalog_identifier(
                origin.catalog_url, metadata.confirmed_scope
            ),
        )
        headers = _metadata_headers(metadata)
        # Date, Age, Expires and response delay are absent from cache-v1 metadata.
        headers["cache-control"] = "no-cache"
        return _CacheRecord(
            snapshot=snapshot,
            body=cached.body,
            response_headers=headers,
            etag=metadata.etag,
            last_modified=metadata.last_modified,
            fresh_until=float("-inf"),
            retrieved_at=metadata.retrieved_at,
            validated_at=metadata.validated_at,
            persistent_generation=state.generation,
        ), state.generation

    async def _publish_persistent_record(
        self,
        *,
        origin: Origin,
        record: _CacheRecord,
        validated_at: float,
    ) -> _CacheRecord | None:
        backend = self._catalog_cache
        if backend is None or not record.snapshot.persistent:
            return record
        sensitive_values = _configured_sensitive_values(origin)
        candidate = CachedCatalog(
            body=record.body,
            metadata=CatalogMetadata(
                canonical_url=origin.catalog_url,
                retrieved_at=record.retrieved_at,
                validated_at=datetime.fromtimestamp(validated_at, timezone.utc),
                confirmed_scope=record.snapshot.confirmed_scope,
                etag=_sanitized_metadata_value(record.etag, sensitive_values),
                last_modified=_sanitized_metadata_value(
                    record.last_modified, sensitive_values
                ),
                cache_control=_sanitized_metadata_value(
                    record.response_headers.get("cache-control"), sensitive_values
                ),
            ),
        )
        expected_generation = record.persistent_generation
        if expected_generation is None:
            return replace(
                record,
                snapshot=replace(
                    record.snapshot,
                    persistent=False,
                    catalog_identifier=None,
                ),
                authoritative=False,
            )
        try:
            # Admission inspects raw ignored metadata too. Only this pure candidate
            # validation may refuse optional storage; backend failures still propagate.
            await asyncio.to_thread(validate_cached_catalog, candidate)
        except (CacheConfigurationError, CacheCorruptError):
            identity = _catalog_cache_identity(record.snapshot.origin_alias, origin)
            state = await asyncio.to_thread(
                backend.get_catalog_state,
                origin.catalog_url,
                confirmed_scope=origin.scope,
            )
            # Backends may decline deletion of an already absent record. Its exact
            # generation still permits authoritative in-memory admission.
            authoritative = (
                state.catalog is None and state.generation == expected_generation
            )
            if not authoritative:
                authoritative = await self._invalidate_persistent_record(
                    identity=identity,
                    origin_alias=record.snapshot.origin_alias,
                    origin=origin,
                    cached=record,
                )
            return replace(
                record,
                snapshot=replace(
                    record.snapshot, persistent=False, catalog_identifier=None
                ),
                persistent_generation=self._persistent_generations.get(identity),
                authoritative=authoritative,
            )
        published = await asyncio.to_thread(
            backend.replace_catalog,
            candidate,
            expected_generation=expected_generation,
        )
        winner, _generation = await asyncio.to_thread(
            self._load_persistent_state,
            record.snapshot.origin_alias,
            origin,
            (record, candidate) if published else None,
        )
        identity = _catalog_cache_identity(record.snapshot.origin_alias, origin)
        if not published:
            if winner is not None:
                self._cache[identity] = winner
            return replace(
                record,
                snapshot=replace(
                    record.snapshot,
                    persistent=False,
                    catalog_identifier=None,
                ),
                persistent_generation=None,
                authoritative=False,
            )
        if winner is not None:
            self._cache[identity] = winner
            return (
                winner
                if winner.snapshot == record.snapshot
                else replace(record, persistent_generation=None, authoritative=False)
            )
        return replace(
            record,
            persistent_generation=None,
            authoritative=False,
        )

    async def _invalidate_persistent_record(
        self,
        *,
        identity: str,
        origin_alias: str,
        origin: Origin,
        cached: _CacheRecord | None,
    ) -> bool:
        backend = self._catalog_cache
        expected = (
            cached.persistent_generation
            if cached is not None and cached.persistent_generation is not None
            else self._persistent_generations.get(identity)
        )
        if backend is not None and expected is not None:
            deleted = await asyncio.to_thread(
                backend.delete_catalog,
                origin.catalog_url,
                confirmed_scope=origin.scope,
                expected_generation=expected,
            )
            if not deleted:
                replacement, generation = await asyncio.to_thread(
                    self._load_persistent_state, origin_alias, origin
                )
                if generation is not None:
                    self._persistent_generations[identity] = generation
                if replacement is not None:
                    self._cache[identity] = replacement
                else:
                    self._cache.pop(identity, None)
                return False
            else:
                state = await asyncio.to_thread(
                    backend.get_catalog_state,
                    origin.catalog_url,
                    confirmed_scope=origin.scope,
                )
                self._persistent_generations[identity] = state.generation
        self._cache.pop(identity, None)
        return True

    async def aggregate(self, *, strict: bool = False) -> AggregateCatalog:
        """Return all healthy entries plus explicit failures, or fail strictly."""

        aliases = tuple(self._origins)
        results = await asyncio.gather(
            *(self.catalog(alias) for alias in aliases), return_exceptions=True
        )
        entries: list[CatalogEntry] = []
        failures: list[OriginFailure] = []
        for alias, result in zip(aliases, results, strict=True):
            if isinstance(result, CatalogError):
                failures.append(OriginFailure(alias, result))
            elif isinstance(result, BaseException):
                raise result
            else:
                entries.extend(result.entries)

        aggregate = AggregateCatalog(tuple(entries), tuple(failures))
        if strict and aggregate.failures:
            raise AggregateCatalogError(aggregate.failures)
        return aggregate


def _catalog_cache_identity(origin_alias: str, origin: Origin) -> str:
    if origin.scope is None and origin.headers:
        return f"memory:{origin_alias}"
    return f"persistent:{catalog_identifier(origin.catalog_url, origin.scope)}"


def _retarget_record(
    record: _CacheRecord | None,
    origin_alias: str,
    origin: Origin,
) -> _CacheRecord | None:
    if record is None:
        return None
    _accepted_record_body(record.body, origin_alias, origin)
    snapshot = replace(
        record.snapshot,
        origin_alias=origin_alias,
        entries=tuple(
            replace(entry, origin_alias=origin_alias)
            for entry in record.snapshot.entries
        ),
    )
    return replace(record, snapshot=snapshot)


def _preserves_resolution(body: bytes, snapshot: CatalogSnapshot, origin: Origin) -> bool:
    canonical = parse_catalog(
        body, origin_alias=snapshot.origin_alias, index_url=origin.catalog_url
    )
    return canonical.entries == snapshot.entries


def _accepted_record_body(
    body: bytes,
    origin_alias: str,
    origin: Origin,
) -> bytes:
    max_bytes = origin.catalog_bytes
    if max_bytes is None:
        raise AssertionError("origin defaults were not resolved")
    if len(body) > max_bytes:
        raise CatalogError(
            "limit_exceeded",
            retryable=False,
            context={"origin_alias": origin_alias, "limit": "catalog_bytes"},
        )
    return body


def _new_record(
    snapshot: CatalogSnapshot,
    body: bytes,
    headers: Mapping[str, str],
    *,
    request_time: float,
    response_time: float,
) -> _CacheRecord:
    return _CacheRecord(
        snapshot=snapshot,
        body=body,
        response_headers=dict(headers),
        etag=headers.get("etag"),
        last_modified=headers.get("last-modified"),
        fresh_until=response_time
        + _remaining_freshness(headers, request_time, response_time),
        retrieved_at=datetime.fromtimestamp(response_time, timezone.utc),
        validated_at=datetime.fromtimestamp(response_time, timezone.utc),
    )


def _updated_record(
    cached: _CacheRecord,
    headers: Mapping[str, str],
    *,
    request_time: float,
    response_time: float,
) -> _CacheRecord:
    return _CacheRecord(
        snapshot=cached.snapshot,
        body=cached.body,
        response_headers=dict(headers),
        etag=headers.get("etag", cached.etag),
        last_modified=headers.get("last-modified", cached.last_modified),
        fresh_until=response_time
        + _remaining_freshness(headers, request_time, response_time),
        retrieved_at=cached.retrieved_at,
        validated_at=datetime.fromtimestamp(response_time, timezone.utc),
        persistent_generation=cached.persistent_generation,
    )


def _metadata_headers(metadata: CatalogMetadata) -> dict[str, str]:
    headers: dict[str, str] = {}
    if metadata.etag is not None:
        headers["etag"] = metadata.etag
    if metadata.last_modified is not None:
        headers["last-modified"] = metadata.last_modified
    if metadata.cache_control is not None:
        headers["cache-control"] = metadata.cache_control
    return headers


def _configured_sensitive_values(origin: Origin) -> frozenset[str]:
    sensitive_names = origin.sensitive_headers_for(origin.catalog_url)
    return frozenset(
        value
        for name, value in origin.headers.items()
        if name in sensitive_names and value
    )


def _sanitized_metadata_value(
    value: str | None, sensitive_values: frozenset[str]
) -> str | None:
    if value is None:
        return None
    if any(sensitive in value for sensitive in sensitive_values):
        return None
    return value


def _remaining_freshness(
    headers: Mapping[str, str], request_time: float, response_time: float
) -> float:
    directives = _parse_cache_control(headers.get("cache-control"))
    if directives.no_cache or directives.no_store:
        return 0.0
    if directives.max_age_invalid:
        freshness_lifetime = 0.0
    elif directives.max_age is not None:
        freshness_lifetime = float(directives.max_age)
    else:
        freshness_lifetime = _expires_lifetime(headers, response_time)

    date = _http_timestamp(headers.get("date"))
    apparent_age = 0.0 if date is None else max(0.0, response_time - date)
    response_delay = max(0.0, response_time - request_time)
    age_value = _parse_age(headers.get("age"))
    corrected_initial_age = max(apparent_age, float(age_value) + response_delay)
    return max(0.0, freshness_lifetime - corrected_initial_age)


def _should_store(headers: Mapping[str, str]) -> bool:
    return not _parse_cache_control(headers.get("cache-control")).no_store


def _confirmed_scope(
    *,
    origin_alias: str,
    requested_scope: str | None,
    response_headers: Mapping[str, str],
) -> str | None:
    if requested_scope is None:
        return None
    confirmation = response_headers.get(SCOPE_HEADER)
    if not is_valid_scope(confirmation) or confirmation != requested_scope:
        raise CatalogError.invalid(origin_alias, SCOPE_HEADER)
    return confirmation


def _persistent_eligible(
    *,
    origin: Origin,
    headers: Mapping[str, str],
    confirmed_scope: str | None,
) -> bool:
    if not _should_store(headers):
        return False
    if confirmed_scope is not None:
        return True
    return not bool(origin.headers)


def _parse_cache_control(cache_control: str | None) -> _ParsedCacheControl:
    if cache_control is None:
        return _ParsedCacheControl(
            max_age=None,
            max_age_invalid=False,
            no_cache=False,
            no_store=False,
        )
    members, malformed = _split_cache_control(cache_control)
    max_age: int | None = None
    max_age_count = 0
    max_age_invalid = malformed
    no_cache = False
    no_store = False
    for part in members:
        directive = trim_ecmascript_whitespace(part)
        if not directive:
            max_age_invalid = True
            continue
        name, separator, value = directive.partition("=")
        name = trim_ecmascript_whitespace(name).lower()
        argument = trim_ecmascript_whitespace(value) if separator else None
        if _HTTP_TOKEN.fullmatch(name) is None or (
            argument is not None and not _valid_directive_argument(argument)
        ):
            max_age_invalid = True
            continue
        if name == "no-cache":
            no_cache = True
        if name == "no-store":
            no_store = True
        if name != "max-age":
            continue
        max_age_count += 1
        parsed = None if argument is None else _parse_delta_seconds(argument)
        if parsed is None:
            max_age_invalid = True
        else:
            max_age = parsed
    if max_age_count > 1:
        max_age_invalid = True
    return _ParsedCacheControl(
        max_age=max_age,
        max_age_invalid=max_age_invalid,
        no_cache=no_cache,
        no_store=no_store,
    )


def _split_cache_control(value: str) -> tuple[tuple[str, ...], bool]:
    members: list[str] = []
    member_start = 0
    quoted = False
    escaped = False
    for index, character in enumerate(value):
        if escaped:
            escaped = False
        elif quoted and character == "\\":
            escaped = True
        elif character == '"':
            quoted = not quoted
        elif not quoted and character == ",":
            members.append(value[member_start:index])
            member_start = index + 1
    members.append(value[member_start:])
    return tuple(members), quoted or escaped


def _valid_directive_argument(value: str) -> bool:
    if _HTTP_TOKEN.fullmatch(value) is not None:
        return True
    if not value.startswith('"') or not value.endswith('"'):
        return False
    escaped = False
    for character in value[1:-1]:
        if escaped:
            escaped = False
            continue
        if character == "\\":
            escaped = True
            continue
        if character == '"' or ord(character) < 32 or ord(character) == 127:
            return False
    return not escaped


def _parse_age(value: str | None) -> int:
    if value is None:
        return 0
    parsed = _parse_delta_seconds(trim_ecmascript_whitespace(value.split(",", 1)[0]))
    return 0 if parsed is None else parsed


def _parse_delta_seconds(value: str) -> int | None:
    quoted = _QUOTED_DELTA_SECONDS.fullmatch(value)
    digits = quoted.group(1) if quoted is not None else value
    if _DELTA_SECONDS.fullmatch(digits) is None:
        return None
    if len(digits) > _DELTA_SECONDS_BOUND_DIGITS:
        return _DELTA_SECONDS_BOUND
    return min(int(digits), _DELTA_SECONDS_BOUND)


def _expires_lifetime(headers: Mapping[str, str], response_time: float) -> float:
    expires = _http_timestamp(headers.get("expires"))
    if expires is None:
        return 0.0
    date = _http_timestamp(headers.get("date"))
    return max(0.0, expires - (response_time if date is None else date))


def _http_timestamp(value: str | None) -> float | None:
    return parse_imf_fixdate(value)

"""Interoperable cache-v1 disk storage."""

from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
import stat
import subprocess
import sys
import tempfile
import threading
import time
from contextlib import contextmanager, nullcontext
from errno import EEXIST, EINVAL, ENOTEMPTY, ENOTSUP
from collections.abc import Mapping
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from functools import wraps
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Any, Callable

from ..catalog_scope import catalog_identifier, is_valid_scope
from .base import (
    ArchiveVerifier,
    _canonical_lease_timestamp,
    catalog_absence_generation,
    _catalog_body_contains_credentials,
    _next_lease_timestamp,
    _parse_cache_json,
    _snapshot_datetime,
    is_portable_cache_path,
    is_supported_artifact_contract,
    is_unicode_scalar_string,
    snapshot_cache_lease,
    snapshot_cached_catalog,
    snapshot_cached_object,
    snapshot_unicode_scalar_string,
    validate_catalog_lookup_url,
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
    CatalogMetadata,
    CatalogState,
    EvictionResult,
)
from .unicode_casefold import pinned_unicode_15_casefold


LAYOUT_VERSION = "cache-v1"
CACHE_COORDINATION_VERSION = "remote-skills-cache-coordination-v1"
DEFAULT_MAX_BYTES = 512 * 1024 * 1024
DEFAULT_MAX_AGE_SECONDS = 30 * 24 * 60 * 60
DEFAULT_MAX_CATALOG_BYTES = 1024 * 1024
DEFAULT_MAX_OBJECT_METADATA_BYTES = 1024 * 1024
DEFAULT_MAX_ARTIFACT_BYTES = 50 * 1024 * 1024
DEFAULT_MAX_EXTRACTED_BYTES = 100 * 1024 * 1024
DEFAULT_MAX_FILES_PER_OBJECT = 1000
DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024
DEFAULT_MAX_PATH_DEPTH = 64
DEFAULT_MAX_LEASE_METADATA_BYTES = 64 * 1024
DEFAULT_MAX_CLAIM_METADATA_BYTES = 1024
DEFAULT_MAX_SCAN_ENTRIES = 100_000
MAX_CATALOG_GENERATION_RETRIES = 3
MAX_SAFE_INTEGER = 2**53 - 1
_DIGEST_PATTERN = re.compile(r"sha256:([0-9a-f]{64})\Z")
_CATALOG_IDENTIFIER_PATTERN = re.compile(r"[0-9a-f]{64}\Z")
_CATALOG_GENERATION_PATTERN = re.compile(r"sha256:[0-9a-f]{64}\Z")
_CATALOG_GENERATION_STATE_SCHEMA = "remote-skills-catalog-generation-state-v1"
_CATALOG_GENERATION_SCHEMA = "remote-skills-catalog-generation-v1"
_CATALOG_GENERATION_DIRECTORY = "catalog-generations-v1"
_CATALOG_GENERATION_STATE_NAME = "state.json"
_OBJECT_KEYS = {
    "schema",
    "digest",
    "artifact_type",
    "archive_format",
    "artifact_bytes",
    "extracted_bytes",
    "files",
    "verified_at",
    "accessed_at",
}
_FILE_KEYS = {"path", "size", "media_type"}
_CATALOG_REQUIRED_KEYS = {"schema", "canonical_url", "retrieved_at", "validated_at"}
_CATALOG_OPTIONAL_KEYS = {
    "confirmed_scope",
    "etag",
    "last_modified",
    "cache_control",
}
_LEASE_REQUIRED_KEYS = {
    "schema",
    "digest",
    "pid",
    "process_nonce",
    "session_nonce",
    "created_at",
    "renewed_at",
}
_LEASE_OPTIONAL_KEYS = {"lease_nonce"}
_PROCESS_REQUIRED_KEYS = {"schema", "pid", "process_nonce", "renewed_at"}
_PROCESS_OPTIONAL_KEYS = {"process_identity"}
_CLAIM_KEYS = {
    "schema",
    "coordination_version",
    "pid",
    "process_nonce",
    "process_identity",
    "created_at",
}
_LEASE_GENERATION_KEYS = {"schema", "coordination_version", "generation"}
_EVICTION_CLAIM_NAME = ".eviction-claim.json"
_LEASE_GENERATION_NAME = ".lease-generation.json"
_MAX_TIMER_DELAY_SECONDS = 2_147_483_647 / 1_000
_NONCE_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}\Z")
_TIMESTAMP_PATTERN = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\Z")
_DESCRIPTOR_MUTATIONS = (os.open, os.rename, os.unlink, os.rmdir, os.stat)
_DESCRIPTOR_LISTDIR = os.listdir


@dataclass(frozen=True, slots=True)
class _EvictionClaim:
    digest: str
    token: str
    content: bytes
    gate: _MutationGate | None


@dataclass(slots=True)
class _MutationGate:
    digest: str
    process_nonce: str
    owner_nonce: str
    directory: Path
    name: str
    heartbeat: _ProcessRegistrationHeartbeat
    contended_with_eviction: bool


@dataclass(slots=True)
class _ProcessRegistrationHandle:
    descriptor: int | None
    directory: Path
    name: str
    content: bytes
    identity: tuple[int, int, int]


@dataclass(slots=True)
class _ProcessRegistrationHeartbeat:
    stop: threading.Event
    thread: threading.Thread
    errors: list[BaseException]


@dataclass(frozen=True, slots=True)
class _EvictionCandidate:
    accessed_at: datetime
    kind: str
    identifier: str
    path: Path
    size: int
    identity: tuple[int, int, int]
    digest: str | None = None


@dataclass(slots=True)
class _ScanBudget:
    limit: int
    used: int = 0

    def consume(self) -> None:
        if self.used >= self.limit:
            raise ValueError("directory entry count")
        self.used += 1


def _windows_mode() -> bool:
    return sys.platform == "win32"


def _requires_closed_mutation_snapshot() -> bool:
    return _windows_mode()


def _guarded_cache_operation(method=None, *, preflight=None):
    def decorate(operation):
        @wraps(operation)
        def guarded(self, *args, **kwargs):
            try:
                if preflight is not None:
                    preflight(*args, **kwargs)
                with self._platform_mutation_guard():
                    return operation(self, *args, **kwargs)
            except (CacheCorruptError, CacheConfigurationError) as error:
                error.__cause__ = None
                error.__context__ = None
                raise error from None

        return guarded

    return decorate(method) if method is not None else decorate


def _validate_stale_lease_cleanup(*, lease_expiry_seconds: int = 120) -> None:
    validate_nonnegative_safe_integer(lease_expiry_seconds, "lease_expiry_seconds")


def _validate_stale_temporary_cleanup(*, max_age_seconds: int) -> None:
    validate_nonnegative_safe_integer(max_age_seconds, "max_age_seconds")


def _validate_eviction_limits(
    *,
    max_bytes: int,
    max_age_seconds: int,
    lease_expiry_seconds: int = 120,
) -> None:
    validate_nonnegative_safe_integer(max_bytes, "max_bytes")
    validate_nonnegative_safe_integer(max_age_seconds, "max_age_seconds")
    validate_nonnegative_safe_integer(lease_expiry_seconds, "lease_expiry_seconds")


def origin_identifier(
    canonical_url: str, *, confirmed_scope: str | None = None
) -> str:
    """Return the cache-v1 identifier for a canonical catalog URL."""

    canonical_url = snapshot_unicode_scalar_string(canonical_url)
    validate_catalog_lookup_url(canonical_url)
    if confirmed_scope is not None:
        confirmed_scope = snapshot_unicode_scalar_string(confirmed_scope)
        if not is_valid_scope(confirmed_scope):
            raise CacheConfigurationError("confirmed_scope")
    return catalog_identifier(canonical_url, confirmed_scope)


def catalog_mutation_digest(identifier: str) -> str:
    """Derive the cross-runtime mutation-gate digest for one catalog identity."""

    identifier = snapshot_unicode_scalar_string(identifier)
    if _CATALOG_IDENTIFIER_PATTERN.fullmatch(identifier) is None:
        raise CacheConfigurationError("catalog_identifier")
    framed = f"remote-skills-catalog-mutation-v1\n{identifier}\n".encode("utf-8")
    return f"sha256:{hashlib.sha256(framed).hexdigest()}"


def catalog_generation_state_digest() -> str:
    """Return cache-v1's shared eviction-decision Lamport gate digest."""

    framed = b"remote-skills-cache-eviction-decision-v1"
    return f"sha256:{hashlib.sha256(framed).hexdigest()}"


def _catalog_temporary_identifier(name: str) -> str | None:
    match = re.fullmatch(
        r"(?:"
        r"(?:catalog-python|catalog-old|evict-catalog)-([0-9a-f]{64})-[0-9a-f]+"
        r"|catalog-([0-9a-f]{64})-"
        r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
        r")",
        name,
    )
    return None if match is None else (match.group(1) or match.group(2))


def default_cache_root(
    *,
    platform_name: str | None = None,
    environ: Mapping[str, str] | None = None,
    home: Path | None = None,
) -> Path:
    """Resolve the operating system's standard cache directory."""

    selected_platform = platform_name or sys.platform
    selected_environment = os.environ if environ is None else environ
    selected_home = Path.home() if home is None else home
    if selected_platform == "darwin":
        base = selected_home / "Library" / "Caches"
    elif selected_platform.startswith("win"):
        local_value = selected_environment.get("LOCALAPPDATA")
        local_path = Path(local_value) if local_value else None
        base = (
            local_path
            if local_path is not None
            and (local_path.is_absolute() or PureWindowsPath(local_value).is_absolute())
            else selected_home / "AppData" / "Local"
        )
    else:
        xdg_value = selected_environment.get("XDG_CACHE_HOME")
        xdg_cache_home = Path(xdg_value) if xdg_value else None
        base = (
            xdg_cache_home
            if xdg_cache_home is not None and xdg_cache_home.is_absolute()
            else selected_home / ".cache"
        )
    return base / "remote-skills"


def _parse_timestamp(value: object) -> datetime:
    if not isinstance(value, str) or _TIMESTAMP_PATTERN.fullmatch(value) is None:
        raise ValueError("timestamp")
    parsed = datetime.fromisoformat(f"{value[:-1]}+00:00")
    if parsed.tzinfo is None or _format_timestamp(parsed) != value:
        raise ValueError("timestamp")
    return parsed


def _format_timestamp(value: datetime) -> str:
    if value.tzinfo is None:
        raise ValueError("timestamp must be timezone-aware")
    return value.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _regular_file(path: Path) -> bool:
    try:
        return stat.S_ISREG(path.lstat().st_mode)
    except OSError:
        return False


def _regular_directory(path: Path) -> bool:
    try:
        return stat.S_ISDIR(path.lstat().st_mode)
    except OSError:
        return False


def _identity(value: os.stat_result) -> tuple[int, int, int]:
    return value.st_dev, value.st_ino, stat.S_IFMT(value.st_mode)


def _file_generation(value: os.stat_result) -> tuple[int, int, int, int, int, int]:
    return (*_identity(value), value.st_size, value.st_mtime_ns, value.st_ctime_ns)


def _open_directory(path: Path, parent_descriptor: int | None = None) -> int | None:
    expected = path.lstat()
    if not stat.S_ISDIR(expected.st_mode):
        raise ValueError("directory")
    if os.name == "nt":
        import ctypes

        handle = _windows_open_directory_handle(path)
        try:
            _windows_handle_identity(handle)
            if _identity(path.lstat()) != _identity(expected):
                raise ValueError("directory identity")
        finally:
            ctypes.windll.kernel32.CloseHandle(handle)
        return None
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_DIRECTORY", 0)
    flags |= getattr(os, "O_NOFOLLOW", 0)
    if parent_descriptor is not None and os.open in os.supports_dir_fd:
        descriptor = os.open(path.name, flags, dir_fd=parent_descriptor)
    else:
        descriptor = os.open(path, flags)
    actual = os.fstat(descriptor)
    if not stat.S_ISDIR(actual.st_mode) or _identity(expected) != _identity(actual):
        os.close(descriptor)
        raise ValueError("directory identity")
    return descriptor


def _open_directory_chain(root: Path, parts: tuple[str, ...]) -> tuple[int | None, Path]:
    current_path = root
    current_descriptor = _open_directory(current_path)
    try:
        for part in parts:
            child_path = current_path / part
            child_descriptor = _open_directory(child_path, current_descriptor)
            if current_descriptor is not None:
                os.close(current_descriptor)
            current_path = child_path
            current_descriptor = child_descriptor
        return current_descriptor, current_path
    except Exception:
        if current_descriptor is not None:
            os.close(current_descriptor)
        raise


@dataclass(slots=True)
class _AnchoredDirectory:
    paths: tuple[Path, ...]
    descriptors: tuple[int, ...]
    identities: tuple[tuple[int, int, int], ...]

    @property
    def descriptor(self) -> int:
        return self.descriptors[-1]

    @property
    def path(self) -> Path:
        return self.paths[-1]

    def validate(self) -> None:
        for path, descriptor, identity in zip(
            self.paths,
            self.descriptors,
            self.identities,
            strict=True,
        ):
            current = path.lstat()
            opened = os.fstat(descriptor)
            if (
                not stat.S_ISDIR(current.st_mode)
                or not stat.S_ISDIR(opened.st_mode)
                or _identity(current) != identity
                or _identity(opened) != identity
            ):
                raise ValueError("directory chain identity")


@dataclass(slots=True)
class _PrivateDirectoryGeneration:
    parent: _AnchoredDirectory
    name: str
    path: Path
    descriptor: int
    identity: tuple[int, int, int]


@contextmanager
def _anchored_directory_chain(root: Path, parts: tuple[str, ...]):
    paths: list[Path] = [root]
    descriptors: list[int] = []
    identities: list[tuple[int, int, int]] = []
    try:
        root_descriptor = _open_directory(root)
        if root_descriptor is None:
            raise ValueError("descriptor-relative mutation unavailable")
        descriptors.append(root_descriptor)
        identities.append(_identity(os.fstat(root_descriptor)))
        current_path = root
        current_descriptor = root_descriptor
        for part in parts:
            current_path = current_path / part
            child_descriptor = _open_directory(current_path, current_descriptor)
            if child_descriptor is None:
                raise ValueError("descriptor-relative mutation unavailable")
            paths.append(current_path)
            descriptors.append(child_descriptor)
            identities.append(_identity(os.fstat(child_descriptor)))
            current_descriptor = child_descriptor
        anchored = _AnchoredDirectory(
            paths=tuple(paths),
            descriptors=tuple(descriptors),
            identities=tuple(identities),
        )
        anchored.validate()
        yield anchored
    finally:
        for descriptor in reversed(descriptors):
            if descriptor is not None:
                os.close(descriptor)


@contextmanager
def _private_directory_generation(
    root: Path,
    temporary_root: Path,
    *,
    prefix: str,
    max_entries: int = DEFAULT_MAX_SCAN_ENTRIES,
    max_depth: int = DEFAULT_MAX_PATH_DEPTH,
):
    _require_descriptor_mutation()
    with _anchored_directory_chain(
        root,
        temporary_root.relative_to(root).parts,
    ) as temporary_chain:
        name = f"{prefix}{secrets.token_hex(16)}"
        descriptor: int | None = None
        identity: tuple[int, int, int] | None = None
        os.mkdir(name, 0o700, dir_fd=temporary_chain.descriptor)
        try:
            descriptor = _open_directory_entry_at(temporary_chain.descriptor, name)
            identity = _identity(os.fstat(descriptor))
            temporary_chain.validate()
            yield _PrivateDirectoryGeneration(
                parent=temporary_chain,
                name=name,
                path=temporary_chain.path / name,
                descriptor=descriptor,
                identity=identity,
            )
        finally:
            if descriptor is not None:
                os.close(descriptor)
            if identity is not None:
                try:
                    current = os.stat(
                        name,
                        dir_fd=temporary_chain.descriptor,
                        follow_symlinks=False,
                    )
                    if _identity(current) == identity:
                        _remove_tree_at(
                            temporary_chain.descriptor,
                            temporary_chain.path,
                            name,
                            expected_identity=identity,
                            max_entries=max_entries,
                            max_depth=max_depth,
                        )
                except FileNotFoundError:
                    pass


def _require_descriptor_mutation(expected_digest: str | None = None) -> None:
    if _windows_mode():
        return
    if (
        any(operation not in os.supports_dir_fd for operation in _DESCRIPTOR_MUTATIONS)
        or _DESCRIPTOR_LISTDIR not in os.supports_fd
    ):
        raise CacheCorruptError(expected_digest)


@dataclass(slots=True)
class _WindowsDirectoryChain:
    paths: tuple[Path, ...]
    identities: tuple[tuple[int, int, int], ...]
    handles: tuple[int, ...]
    handle_identities: tuple[tuple[int, int, int], ...]

    @property
    def path(self) -> Path:
        return self.paths[-1]

    def validate(self) -> None:
        for path, identity in zip(self.paths, self.identities, strict=True):
            current = path.lstat()
            if not stat.S_ISDIR(current.st_mode) or _identity(current) != identity:
                raise ValueError("directory chain identity")
        if os.name == "nt":
            for handle, identity in zip(
                self.handles,
                self.handle_identities,
                strict=True,
            ):
                if _windows_handle_identity(handle) != identity:
                    raise ValueError("directory handle identity")


def _windows_open_directory_handle(
    path: Path,
    *,
    desired_access: int = 0x0080,
) -> int:
    import ctypes
    from ctypes import wintypes

    create_file = ctypes.windll.kernel32.CreateFileW
    create_file.argtypes = [
        wintypes.LPCWSTR,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.LPVOID,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.HANDLE,
    ]
    create_file.restype = wintypes.HANDLE
    handle = create_file(
        str(path),
        desired_access,
        0x00000001 | 0x00000002 | 0x00000004,
        None,
        3,
        0x02000000 | 0x00200000,
        None,
    )
    if handle == wintypes.HANDLE(-1).value:
        raise ctypes.WinError()
    return int(handle)


def _windows_touch_directory(
    path: Path,
    *,
    expected_identity: tuple[int, int, int],
    timestamp_ns: int,
) -> None:
    """Update one pinned directory generation without following a replacement path."""

    if os.name != "nt":
        expected = path.lstat()
        if not stat.S_ISDIR(expected.st_mode):
            raise ValueError("directory generation")
        flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0)
        flags |= getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(path, flags)
        try:
            opened = os.fstat(descriptor)
            if (
                _identity(expected) != expected_identity
                or _identity(opened) != expected_identity
            ):
                raise ValueError("directory generation")
            os.utime(descriptor, ns=(timestamp_ns, timestamp_ns))
            if _identity(os.fstat(descriptor)) != expected_identity:
                raise ValueError("directory generation")
        finally:
            if descriptor is not None:
                os.close(descriptor)
        return

    import ctypes
    from ctypes import wintypes

    class FileTime(ctypes.Structure):
        _fields_ = [("low", wintypes.DWORD), ("high", wintypes.DWORD)]

    handle = _windows_open_directory_handle(
        path,
        desired_access=0x0080 | 0x0100,
    )
    try:
        if _windows_handle_identity(handle) != expected_identity:
            raise ValueError("directory generation")
        windows_ticks = timestamp_ns // 100 + 116_444_736_000_000_000
        if windows_ticks < 0:
            raise ValueError("timestamp")
        value = FileTime(
            windows_ticks & 0xFFFFFFFF,
            (windows_ticks >> 32) & 0xFFFFFFFF,
        )
        operation = ctypes.windll.kernel32.SetFileTime
        operation.argtypes = [
            wintypes.HANDLE,
            ctypes.POINTER(FileTime),
            ctypes.POINTER(FileTime),
            ctypes.POINTER(FileTime),
        ]
        operation.restype = wintypes.BOOL
        if not operation(handle, None, ctypes.byref(value), ctypes.byref(value)):
            raise ctypes.WinError()
        if _windows_handle_identity(handle) != expected_identity:
            raise ValueError("directory generation")
    finally:
        ctypes.windll.kernel32.CloseHandle(handle)


def _windows_handle_identity(handle: int) -> tuple[int, int, int]:
    import ctypes
    from ctypes import wintypes

    class ByHandleFileInformation(ctypes.Structure):
        _fields_ = [
            ("file_attributes", wintypes.DWORD),
            ("creation_time", wintypes.FILETIME),
            ("last_access_time", wintypes.FILETIME),
            ("last_write_time", wintypes.FILETIME),
            ("volume_serial_number", wintypes.DWORD),
            ("file_size_high", wintypes.DWORD),
            ("file_size_low", wintypes.DWORD),
            ("number_of_links", wintypes.DWORD),
            ("file_index_high", wintypes.DWORD),
            ("file_index_low", wintypes.DWORD),
        ]

    info = ByHandleFileInformation()
    if not ctypes.windll.kernel32.GetFileInformationByHandle(handle, ctypes.byref(info)):
        raise ctypes.WinError()
    if not info.file_attributes & 0x00000010 or info.file_attributes & 0x00000400:
        raise ValueError("directory reparse point")
    file_index = (info.file_index_high << 32) | info.file_index_low
    return (
        int(info.volume_serial_number),
        int(file_index),
        stat.S_IFDIR,
    )


@contextmanager
def _windows_directory_chain(root: Path, parts: tuple[str, ...]):
    paths: list[Path] = []
    identities: list[tuple[int, int, int]] = []
    handles: list[int] = []
    handle_identities: list[tuple[int, int, int]] = []
    current = root
    try:
        for part in (None, *parts):
            if part is not None:
                current = current / part
            info = current.lstat()
            if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
                raise ValueError("directory chain")
            paths.append(current)
            identities.append(_identity(info))
            if os.name == "nt":
                handle = _windows_open_directory_handle(current)
                handles.append(handle)
                handle_identity = _windows_handle_identity(handle)
                if handle_identity != _identity(info):
                    raise ValueError("directory path and handle identity")
                handle_identities.append(handle_identity)
        chain = _WindowsDirectoryChain(
            tuple(paths),
            tuple(identities),
            tuple(handles),
            tuple(handle_identities),
        )
        chain.validate()
        yield chain
    finally:
        if os.name == "nt":
            import ctypes

            for handle in reversed(handles):
                ctypes.windll.kernel32.CloseHandle(handle)


@dataclass(slots=True)
class _ObjectGenerationGuard:
    digest: str
    context: Any
    chain: _AnchoredDirectory | _WindowsDirectoryChain


def _open_directory_entry_at(parent_descriptor: int, name: str) -> int:
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_DIRECTORY", 0)
    flags |= getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(name, flags, dir_fd=parent_descriptor)
    info = os.fstat(descriptor)
    if not stat.S_ISDIR(info.st_mode):
        os.close(descriptor)
        raise ValueError("directory entry")
    return descriptor


def _open_replaceable_directory_generation(
    root: Path,
    path: Path,
) -> tuple[int | None, Path]:
    if _windows_mode():
        return _open_directory_chain(
            root,
            path.relative_to(root).parts,
        )

    with _anchored_directory_chain(
        root,
        path.parent.relative_to(root).parts,
    ) as parent:
        descriptor = _open_directory_entry_at(parent.descriptor, path.name)
        try:
            parent.validate()
        except Exception:
            os.close(descriptor)
            raise
        return descriptor, path


@dataclass(frozen=True, slots=True)
class _TreePlanEntry:
    name: str
    identity: tuple[int, int, int]
    directory: _TreePlan | None


@dataclass(frozen=True, slots=True)
class _TreePlan:
    identity: tuple[int, int, int]
    entries: tuple[_TreePlanEntry, ...]


def _preflight_tree_at(
    parent_descriptor: int,
    parent_path: Path,
    name: str,
    *,
    expected_identity: tuple[int, int, int] | None,
    max_entries: int,
    max_depth: int,
    scan_budget: _ScanBudget | None,
    budget: list[int],
    depth: int,
) -> _TreePlan:
    if depth > max_depth:
        raise ValueError("directory depth")
    descriptor = _open_directory_entry_at(parent_descriptor, name)
    try:
        identity = _identity(os.fstat(descriptor))
        if expected_identity is not None and identity != expected_identity:
            raise ValueError("directory generation")
        names = _bounded_directory_names(
            descriptor,
            parent_path / name,
            max_entries=max_entries - budget[0],
            scan_budget=scan_budget,
        )
        entries: list[_TreePlanEntry] = []
        for child_name in names:
            budget[0] += 1
            if budget[0] > max_entries:
                raise ValueError("directory entry count")
            child_info = os.stat(child_name, dir_fd=descriptor, follow_symlinks=False)
            child_identity = _identity(child_info)
            if stat.S_ISDIR(child_info.st_mode):
                child_plan = _preflight_tree_at(
                    descriptor,
                    parent_path / name,
                    child_name,
                    expected_identity=child_identity,
                    max_entries=max_entries,
                    max_depth=max_depth,
                    scan_budget=scan_budget,
                    budget=budget,
                    depth=depth + 1,
                )
            elif stat.S_ISREG(child_info.st_mode):
                child_plan = None
            else:
                raise ValueError("special file in managed tree")
            entries.append(_TreePlanEntry(child_name, child_identity, child_plan))
        current = os.stat(name, dir_fd=parent_descriptor, follow_symlinks=False)
        if _identity(current) != identity:
            raise ValueError("directory generation")
        return _TreePlan(identity, tuple(entries))
    finally:
        os.close(descriptor)


def _delete_planned_tree_contents_at(
    descriptor: int,
    directory_path: Path,
    plan: _TreePlan,
) -> None:
    if _identity(os.fstat(descriptor)) != plan.identity:
        raise ValueError("directory generation")
    for entry in plan.entries:
        info = os.stat(entry.name, dir_fd=descriptor, follow_symlinks=False)
        if _identity(info) != entry.identity:
            raise ValueError("entry generation")
        if entry.directory is not None:
            child_descriptor = _open_directory_entry_at(descriptor, entry.name)
            try:
                _delete_planned_tree_contents_at(
                    child_descriptor,
                    directory_path / entry.name,
                    entry.directory,
                )
            finally:
                os.close(child_descriptor)
            current = os.stat(entry.name, dir_fd=descriptor, follow_symlinks=False)
            if _identity(current) != entry.identity:
                raise ValueError("directory generation")
            os.rmdir(entry.name, dir_fd=descriptor)
        else:
            removal_name = f".delete-file-{secrets.token_hex(16)}"
            os.rename(
                entry.name,
                removal_name,
                src_dir_fd=descriptor,
                dst_dir_fd=descriptor,
            )
            current = os.stat(removal_name, dir_fd=descriptor, follow_symlinks=False)
            if _identity(current) != entry.identity:
                raise ValueError("file generation")
            os.unlink(removal_name, dir_fd=descriptor)


def _remove_tree_at(
    parent_descriptor: int,
    parent_path: Path,
    name: str,
    *,
    expected_identity: tuple[int, int, int] | None = None,
    max_entries: int = DEFAULT_MAX_SCAN_ENTRIES,
    max_depth: int = DEFAULT_MAX_PATH_DEPTH,
    scan_budget: _ScanBudget | None = None,
    _budget: list[int] | None = None,
    _depth: int = 0,
) -> None:
    budget = [0] if _budget is None else _budget
    plan = _preflight_tree_at(
        parent_descriptor,
        parent_path,
        name,
        expected_identity=expected_identity,
        max_entries=max_entries,
        max_depth=max_depth,
        scan_budget=scan_budget,
        budget=budget,
        depth=_depth,
    )
    descriptor = _open_directory_entry_at(parent_descriptor, name)
    if _identity(os.fstat(descriptor)) != plan.identity:
        os.close(descriptor)
        raise ValueError("directory generation")
    removal_name = f".delete-{secrets.token_hex(16)}"
    try:
        os.rename(
            name,
            removal_name,
            src_dir_fd=parent_descriptor,
            dst_dir_fd=parent_descriptor,
        )
    except Exception:
        os.close(descriptor)
        raise
    try:
        claimed = os.stat(
            removal_name,
            dir_fd=parent_descriptor,
            follow_symlinks=False,
        )
        if _identity(claimed) != plan.identity:
            raise ValueError("directory generation")
        _delete_planned_tree_contents_at(descriptor, parent_path / removal_name, plan)
        current = os.stat(
            removal_name,
            dir_fd=parent_descriptor,
            follow_symlinks=False,
        )
        if _identity(current) != plan.identity:
            raise ValueError("directory generation")
    finally:
        os.close(descriptor)
    os.rmdir(removal_name, dir_fd=parent_descriptor)
    _sync_directory_descriptor(parent_descriptor)


def _windows_remove_tree_path(
    path: Path,
    *,
    expected_identity: tuple[int, int, int],
    max_entries: int = DEFAULT_MAX_SCAN_ENTRIES,
    max_depth: int = DEFAULT_MAX_PATH_DEPTH,
    scan_budget: _ScanBudget | None = None,
    _budget: list[int] | None = None,
    _depth: int = 0,
) -> None:
    budget = [0] if _budget is None else _budget

    def preflight(candidate: Path, identity: tuple[int, int, int], depth: int) -> _TreePlan:
        if depth > max_depth:
            raise ValueError("directory depth")
        info = candidate.lstat()
        if not stat.S_ISDIR(info.st_mode) or _identity(info) != identity:
            raise ValueError("directory generation")
        entries: list[_TreePlanEntry] = []
        with os.scandir(candidate) as scanned:
            for entry in scanned:
                if budget[0] >= max_entries:
                    raise ValueError("directory entry count")
                if scan_budget is not None:
                    scan_budget.consume()
                budget[0] += 1
                child = candidate / entry.name
                child_info = child.lstat()
                child_identity = _identity(child_info)
                if stat.S_ISDIR(child_info.st_mode):
                    child_plan = preflight(child, child_identity, depth + 1)
                elif stat.S_ISREG(child_info.st_mode):
                    child_plan = None
                else:
                    raise ValueError("special file in managed tree")
                entries.append(_TreePlanEntry(entry.name, child_identity, child_plan))
        if _identity(candidate.lstat()) != identity:
            raise ValueError("directory generation")
        return _TreePlan(identity, tuple(entries))

    def delete(candidate: Path, plan: _TreePlan) -> None:
        if _identity(candidate.lstat()) != plan.identity:
            raise ValueError("directory generation")
        for entry in plan.entries:
            child = candidate / entry.name
            if _identity(child.lstat()) != entry.identity:
                raise ValueError("entry generation")
            if entry.directory is not None:
                delete(child, entry.directory)
                if _identity(child.lstat()) != entry.identity:
                    raise ValueError("directory generation")
                child.rmdir()
            else:
                child.unlink()

    plan = preflight(path, expected_identity, _depth)
    removal = path.parent / f".delete-{secrets.token_hex(16)}"
    if _identity(path.lstat()) != plan.identity:
        raise ValueError("directory generation")
    os.rename(path, removal)
    if _identity(removal.lstat()) != plan.identity:
        raise ValueError("directory generation")
    delete(removal, plan)
    if _identity(removal.lstat()) != plan.identity:
        raise ValueError("directory generation")
    removal.rmdir()


def _atomic_exchange_directories(
    source_parent_descriptor: int,
    source_name: str,
    destination_parent_descriptor: int,
    destination_name: str,
) -> None:
    import ctypes

    library = ctypes.CDLL(None, use_errno=True)
    if sys.platform.startswith("linux"):
        try:
            operation = library.renameat2
        except AttributeError as error:
            raise OSError(ENOTSUP, "atomic directory exchange unavailable") from error
        operation.argtypes = [
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_uint,
        ]
        operation.restype = ctypes.c_int
        result = operation(
            source_parent_descriptor,
            os.fsencode(source_name),
            destination_parent_descriptor,
            os.fsencode(destination_name),
            2,
        )
    elif sys.platform == "darwin":
        try:
            operation = library.renameatx_np
        except AttributeError as error:
            raise OSError(ENOTSUP, "atomic directory exchange unavailable") from error
        operation.argtypes = [
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_uint,
        ]
        operation.restype = ctypes.c_int
        result = operation(
            source_parent_descriptor,
            os.fsencode(source_name),
            destination_parent_descriptor,
            os.fsencode(destination_name),
            2,
        )
    else:
        raise OSError(ENOTSUP, "atomic directory exchange unavailable")
    if result != 0:
        error_number = ctypes.get_errno()
        raise OSError(error_number, os.strerror(error_number))
    _sync_directory_descriptor(source_parent_descriptor)
    if destination_parent_descriptor != source_parent_descriptor:
        _sync_directory_descriptor(destination_parent_descriptor)


def _read_regular_file(
    directory_descriptor: int | None,
    directory_path: Path,
    name: str,
    *,
    max_bytes: int | None = None,
    expected_size: int | None = None,
    descriptor_anchored: bool = False,
) -> bytes:
    content, _, _ = _read_regular_file_snapshot_at(
        directory_descriptor,
        directory_path,
        name,
        max_bytes=max_bytes,
        expected_size=expected_size,
        descriptor_anchored=descriptor_anchored,
    )
    return content


def _read_regular_file_snapshot_at(
    directory_descriptor: int | None,
    directory_path: Path,
    name: str,
    *,
    max_bytes: int | None = None,
    expected_size: int | None = None,
    calculate_sha256: bool = False,
    descriptor_anchored: bool = False,
) -> tuple[bytes, os.stat_result, str | None]:
    path = directory_path / name
    if (
        descriptor_anchored
        and directory_descriptor is not None
        and os.stat in os.supports_dir_fd
        and os.open in os.supports_dir_fd
    ):
        expected = None
    else:
        expected = path.lstat()
    if expected is not None and not stat.S_ISREG(expected.st_mode):
        raise ValueError("regular file")
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    if directory_descriptor is not None and os.open in os.supports_dir_fd:
        descriptor = os.open(name, flags, dir_fd=directory_descriptor)
    else:
        descriptor = os.open(path, flags)
    try:
        before = os.fstat(descriptor)
        if (
            not stat.S_ISREG(before.st_mode)
            or (expected is not None and _identity(expected) != _identity(before))
            or (max_bytes is not None and before.st_size > max_bytes)
            or (expected_size is not None and before.st_size != expected_size)
        ):
            raise ValueError("file identity")
        chunks: list[bytes] = []
        digest = hashlib.sha256() if calculate_sha256 else None
        total = 0
        while True:
            if max_bytes is None:
                read_size = 1024 * 1024
            else:
                remaining = max_bytes - total
                read_size = min(1024 * 1024, remaining) if remaining > 0 else 1
            chunk = os.read(descriptor, read_size)
            if not chunk:
                break
            if max_bytes is not None and total + len(chunk) > max_bytes:
                raise ValueError("file grew beyond limit")
            chunks.append(chunk)
            total += len(chunk)
            if digest is not None:
                digest.update(chunk)
        after = os.fstat(descriptor)
        if (
            _identity(before) != _identity(after)
            or before.st_size != after.st_size
            or before.st_mtime_ns != after.st_mtime_ns
            or before.st_ctime_ns != after.st_ctime_ns
        ):
            raise ValueError("file changed while reading")
        return (
            b"".join(chunks),
            after,
            digest.hexdigest() if digest is not None else None,
        )
    finally:
        os.close(descriptor)


def _regular_file_snapshot_info_at(
    directory_descriptor: int | None,
    directory_path: Path,
    name: str,
) -> os.stat_result:
    """Capture a no-follow file identity without reading its potentially large body."""

    path = directory_path / name
    expected = path.lstat()
    if not stat.S_ISREG(expected.st_mode):
        raise ValueError("regular file")
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    if directory_descriptor is not None and os.open in os.supports_dir_fd:
        descriptor = os.open(name, flags, dir_fd=directory_descriptor)
    else:
        descriptor = os.open(path, flags)
    try:
        opened = os.fstat(descriptor)
        if not stat.S_ISREG(opened.st_mode) or _identity(expected) != _identity(opened):
            raise ValueError("file identity")
        return opened
    finally:
        os.close(descriptor)


def _entry_matches_generation(
    directory_descriptor: int | None,
    directory_path: Path,
    name: str,
    expected: os.stat_result,
) -> bool:
    try:
        return _file_generation(
            _regular_file_snapshot_info_at(directory_descriptor, directory_path, name)
        ) == _file_generation(expected)
    except (OSError, ValueError):
        return False


def _regular_file_size_at(
    directory_descriptor: int | None,
    directory_path: Path,
    name: str,
    *,
    max_bytes: int,
    expected_size: int | None = None,
) -> int:
    path = directory_path / name
    expected = path.lstat()
    if not stat.S_ISREG(expected.st_mode):
        raise ValueError("regular file")
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    if directory_descriptor is not None and os.open in os.supports_dir_fd:
        descriptor = os.open(name, flags, dir_fd=directory_descriptor)
    else:
        descriptor = os.open(path, flags)
    try:
        opened = os.fstat(descriptor)
        if (
            not stat.S_ISREG(opened.st_mode)
            or _identity(expected) != _identity(opened)
            or opened.st_size > max_bytes
            or (expected_size is not None and opened.st_size != expected_size)
        ):
            raise ValueError("file size")
        return opened.st_size
    finally:
        os.close(descriptor)


def _entry_matches_snapshot(
    directory_descriptor: int | None,
    directory_path: Path,
    name: str,
    *,
    content: bytes,
    identity: tuple[int, int, int],
    max_bytes: int,
) -> bool:
    try:
        current, current_info, _ = _read_regular_file_snapshot_at(
            directory_descriptor,
            directory_path,
            name,
            max_bytes=max_bytes,
        )
        return _identity(current_info) == identity and current == content
    except (OSError, ValueError):
        return False


def _bounded_directory_names(
    directory_descriptor: int | None,
    directory_path: Path,
    *,
    max_entries: int,
    scan_budget: _ScanBudget | None = None,
) -> list[str]:
    names: list[str] = []
    target: int | Path = directory_descriptor if directory_descriptor is not None else directory_path
    with os.scandir(target) as entries:
        for entry in entries:
            if len(names) >= max_entries:
                raise ValueError("directory entry count")
            if scan_budget is not None:
                scan_budget.consume()
            names.append(entry.name)
    return names


def _root_file_inventory(
    object_descriptor: int | None,
    object_path: Path,
    *,
    expected_sizes: Mapping[str, int],
    max_files: int,
    max_depth: int,
    max_file_bytes: int,
    max_extracted_bytes: int,
    max_entries: int,
) -> dict[str, bytes]:
    root_path = object_path / "root"
    root_descriptor = _open_directory(root_path, object_descriptor)
    inventory: dict[str, bytes] = {}
    total_size = 0
    entries = 0

    def visit(
        directory_descriptor: int | None,
        directory_path: Path,
        relative_directory: PurePosixPath,
    ) -> None:
        nonlocal entries, total_size
        names = _bounded_directory_names(
            directory_descriptor,
            directory_path,
            max_entries=max_entries - entries,
        )
        for name in names:
            entries += 1
            if entries > max_entries:
                raise ValueError("object entry count")
            relative = relative_directory / name
            if len(relative.parts) > max_depth:
                raise ValueError("object path depth")
            info = (directory_path / name).lstat()
            if stat.S_ISDIR(info.st_mode):
                child_path = directory_path / name
                child_descriptor = _open_directory(child_path, directory_descriptor)
                try:
                    visit(child_descriptor, child_path, relative)
                finally:
                    if child_descriptor is not None:
                        os.close(child_descriptor)
            elif stat.S_ISREG(info.st_mode):
                relative_value = relative.as_posix()
                expected_size = expected_sizes.get(relative_value)
                if expected_size is None or len(inventory) >= max_files:
                    raise ValueError("object file count")
                content = _read_regular_file(
                    directory_descriptor,
                    directory_path,
                    name,
                    max_bytes=max_file_bytes,
                    expected_size=expected_size,
                )
                total_size += len(content)
                if total_size > max_extracted_bytes:
                    raise ValueError("object extracted bytes")
                inventory[relative_value] = content
            else:
                raise ValueError("object special file")

    try:
        visit(root_descriptor, root_path, PurePosixPath())
    finally:
        if root_descriptor is not None:
            os.close(root_descriptor)
    return inventory


def _root_file_sizes(
    object_descriptor: int | None,
    object_path: Path,
    *,
    expected_sizes: Mapping[str, int],
    max_files: int,
    max_depth: int,
    max_file_bytes: int,
    max_extracted_bytes: int,
    max_entries: int,
    scan_budget: _ScanBudget | None = None,
) -> dict[str, int]:
    root_path = object_path / "root"
    root_descriptor = _open_directory(root_path, object_descriptor)
    inventory: dict[str, int] = {}
    total_size = 0
    entries = 0

    def visit(
        directory_descriptor: int | None,
        directory_path: Path,
        relative_directory: PurePosixPath,
    ) -> None:
        nonlocal entries, total_size
        names = _bounded_directory_names(
            directory_descriptor,
            directory_path,
            max_entries=max_entries - entries,
            scan_budget=scan_budget,
        )
        for name in names:
            entries += 1
            if entries > max_entries:
                raise ValueError("object entry count")
            relative = relative_directory / name
            if len(relative.parts) > max_depth:
                raise ValueError("object path depth")
            info = (directory_path / name).lstat()
            if stat.S_ISDIR(info.st_mode):
                child_path = directory_path / name
                child_descriptor = _open_directory(child_path, directory_descriptor)
                try:
                    visit(child_descriptor, child_path, relative)
                finally:
                    if child_descriptor is not None:
                        os.close(child_descriptor)
            elif stat.S_ISREG(info.st_mode):
                relative_value = relative.as_posix()
                expected_size = expected_sizes.get(relative_value)
                if expected_size is None or len(inventory) >= max_files:
                    raise ValueError("object file count")
                size = _regular_file_size_at(
                    directory_descriptor,
                    directory_path,
                    name,
                    max_bytes=max_file_bytes,
                    expected_size=expected_size,
                )
                total_size += size
                if total_size > max_extracted_bytes:
                    raise ValueError("object extracted bytes")
                inventory[relative_value] = size
            else:
                raise ValueError("object special file")

    try:
        visit(root_descriptor, root_path, PurePosixPath())
    finally:
        if root_descriptor is not None:
            os.close(root_descriptor)
    return inventory


def _normalized_file_path(value: object) -> str:
    if not is_portable_cache_path(value):
        raise ValueError("path")
    return value


def _integer(value: object) -> int:
    if (
        not isinstance(value, int)
        or isinstance(value, bool)
        or value < 0
        or value > MAX_SAFE_INTEGER
    ):
        raise ValueError("integer")
    return value


def _validate_credential_free_url(value: str) -> None:
    if not isinstance(value, str):
        raise CacheConfigurationError("canonical_url")
    if not is_unicode_scalar_string(value):
        raise CacheCorruptError()
    validate_catalog_lookup_url(value)


def _process_start_identity(pid: int) -> str | None:
    if pid <= 0:
        return None
    proc_stat = Path(f"/proc/{pid}/stat")
    if proc_stat.exists():
        try:
            fields = proc_stat.read_text(encoding="utf-8").rsplit(")", 1)[1].split()
            return f"linux:{fields[19]}"
        except (IndexError, OSError, UnicodeError):
            return None
    if sys.platform == "darwin":
        try:
            import ctypes

            class ProcessBsdInfo(ctypes.Structure):
                _fields_ = [
                    ("pbi_flags", ctypes.c_uint32),
                    ("pbi_status", ctypes.c_uint32),
                    ("pbi_xstatus", ctypes.c_uint32),
                    ("pbi_pid", ctypes.c_uint32),
                    ("pbi_ppid", ctypes.c_uint32),
                    ("pbi_uid", ctypes.c_uint32),
                    ("pbi_gid", ctypes.c_uint32),
                    ("pbi_ruid", ctypes.c_uint32),
                    ("pbi_rgid", ctypes.c_uint32),
                    ("pbi_svuid", ctypes.c_uint32),
                    ("pbi_svgid", ctypes.c_uint32),
                    ("rfu_1", ctypes.c_uint32),
                    ("pbi_comm", ctypes.c_char * 16),
                    ("pbi_name", ctypes.c_char * 32),
                    ("pbi_nfiles", ctypes.c_uint32),
                    ("pbi_pgid", ctypes.c_uint32),
                    ("pbi_pjobc", ctypes.c_uint32),
                    ("e_tdev", ctypes.c_uint32),
                    ("e_tpgid", ctypes.c_uint32),
                    ("pbi_nice", ctypes.c_int32),
                    ("pbi_start_tvsec", ctypes.c_uint64),
                    ("pbi_start_tvusec", ctypes.c_uint64),
                ]

            info = ProcessBsdInfo()
            libproc = ctypes.CDLL("/usr/lib/libproc.dylib")
            size = libproc.proc_pidinfo(
                pid,
                3,
                0,
                ctypes.byref(info),
                ctypes.sizeof(info),
            )
            if size == ctypes.sizeof(info):
                return f"darwin:{info.pbi_start_tvsec}:{info.pbi_start_tvusec}"
        except (AttributeError, OSError):
            return None
    if sys.platform == "win32":
        try:
            import ctypes
            from ctypes import wintypes

            process = ctypes.windll.kernel32.OpenProcess(0x1000, False, pid)
            if not process:
                return None
            creation = wintypes.FILETIME()
            exit_time = wintypes.FILETIME()
            kernel = wintypes.FILETIME()
            user = wintypes.FILETIME()
            try:
                if not ctypes.windll.kernel32.GetProcessTimes(
                    process,
                    ctypes.byref(creation),
                    ctypes.byref(exit_time),
                    ctypes.byref(kernel),
                    ctypes.byref(user),
                ):
                    return None
                value = (creation.dwHighDateTime << 32) | creation.dwLowDateTime
                return f"windows:{value}"
            finally:
                ctypes.windll.kernel32.CloseHandle(process)
        except (AttributeError, OSError):
            return None
    try:
        result = subprocess.run(
            ["ps", "-o", "lstart=", "-p", str(pid)],
            check=False,
            capture_output=True,
            text=True,
            timeout=2,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    started_at = result.stdout.strip()
    return f"ps:{started_at}" if result.returncode == 0 and started_at else None


def _windows_pid_is_alive(pid: int) -> bool | None:
    try:
        import ctypes
        from ctypes import wintypes

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        open_process = kernel32.OpenProcess
        open_process.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        open_process.restype = wintypes.HANDLE
        process = open_process(0x1000, False, pid)
        if not process:
            error = ctypes.get_last_error()
            return False if error in {87, 1168} else None
        try:
            exit_code = wintypes.DWORD()
            get_exit_code = kernel32.GetExitCodeProcess
            get_exit_code.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
            get_exit_code.restype = wintypes.BOOL
            if not get_exit_code(process, ctypes.byref(exit_code)):
                return None
            return exit_code.value == 259
        finally:
            kernel32.CloseHandle(process)
    except (AttributeError, OSError):
        return None


def _pid_may_be_alive(pid: int) -> bool:
    if _windows_mode():
        try:
            return _windows_pid_is_alive(pid) is not False
        except (OSError, OverflowError):
            return True
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except (PermissionError, OSError, OverflowError):
        return True
    return True


class DiskCache:
    """Disk-backed cache-v1 storage with integrity checked reads."""

    def __init__(
        self,
        root: str | Path | None = None,
        *,
        touch_on_read: bool = True,
        clock: Callable[[], datetime] | None = None,
        process_is_alive: Callable[[int, str], bool] | None = None,
        process_identity: Callable[[int], str | None] | None = None,
        archive_verifier: ArchiveVerifier | None = None,
        max_bytes: int = DEFAULT_MAX_BYTES,
        max_age_seconds: int = DEFAULT_MAX_AGE_SECONDS,
        lease_expiry_seconds: int = 120,
        max_catalog_bytes: int = DEFAULT_MAX_CATALOG_BYTES,
        max_object_metadata_bytes: int = DEFAULT_MAX_OBJECT_METADATA_BYTES,
        max_artifact_bytes: int = DEFAULT_MAX_ARTIFACT_BYTES,
        max_extracted_bytes: int = DEFAULT_MAX_EXTRACTED_BYTES,
        max_files_per_object: int = DEFAULT_MAX_FILES_PER_OBJECT,
        max_file_bytes: int = DEFAULT_MAX_FILE_BYTES,
        max_path_depth: int = DEFAULT_MAX_PATH_DEPTH,
        max_lease_metadata_bytes: int = DEFAULT_MAX_LEASE_METADATA_BYTES,
        max_scan_entries: int = DEFAULT_MAX_SCAN_ENTRIES,
    ) -> None:
        limits = {
            "max_bytes": max_bytes,
            "max_age_seconds": max_age_seconds,
            "lease_expiry_seconds": lease_expiry_seconds,
            "max_catalog_bytes": max_catalog_bytes,
            "max_object_metadata_bytes": max_object_metadata_bytes,
            "max_artifact_bytes": max_artifact_bytes,
            "max_extracted_bytes": max_extracted_bytes,
            "max_files_per_object": max_files_per_object,
            "max_file_bytes": max_file_bytes,
            "max_path_depth": max_path_depth,
            "max_lease_metadata_bytes": max_lease_metadata_bytes,
            "max_scan_entries": max_scan_entries,
        }
        for name, value in limits.items():
            validate_nonnegative_safe_integer(value, name)
        if max_path_depth == 0:
            raise CacheConfigurationError("max_path_depth")
        self.root = default_cache_root() if root is None else Path(root)
        self.namespace = self.root / LAYOUT_VERSION
        self.touch_on_read = touch_on_read
        self._clock = clock or (lambda: datetime.now(timezone.utc))
        self._process_identity = process_identity or _process_start_identity
        self._injected_process_is_alive = process_is_alive
        self._process_is_alive = process_is_alive or (
            lambda pid, _process_nonce: _pid_may_be_alive(pid)
        )
        self._archive_verifier = archive_verifier
        self.max_bytes = max_bytes
        self.max_age_seconds = max_age_seconds
        self.lease_expiry_seconds = lease_expiry_seconds
        self.max_catalog_bytes = max_catalog_bytes
        self.max_object_metadata_bytes = max_object_metadata_bytes
        self.max_artifact_bytes = max_artifact_bytes
        self.max_extracted_bytes = max_extracted_bytes
        self.max_files_per_object = max_files_per_object
        self.max_file_bytes = max_file_bytes
        self.max_path_depth = max_path_depth
        self.max_lease_metadata_bytes = max_lease_metadata_bytes
        self.max_scan_entries = max_scan_entries
        self._platform_lock = threading.RLock()
        self._platform_lock_state = threading.local()
        self._catalog_guard_state = threading.local()

    @contextmanager
    def _platform_mutation_guard(self):
        if not _windows_mode():
            yield
            return
        with self._platform_lock:
            depth = getattr(self._platform_lock_state, "depth", 0)
            if depth:
                self._platform_lock_state.depth = depth + 1
                try:
                    yield
                finally:
                    self._platform_lock_state.depth -= 1
                return
            self.root.mkdir(parents=True, exist_ok=True)
            if not _regular_directory(self.root):
                raise CacheCorruptError()
            lock_path = self.root / ".cache-v1-windows.lock"
            flags = os.O_RDWR | os.O_CREAT | getattr(os, "O_CLOEXEC", 0)
            flags |= getattr(os, "O_NOFOLLOW", 0)
            expected = lock_path.lstat() if os.path.lexists(lock_path) else None
            if expected is not None and (
                not stat.S_ISREG(expected.st_mode) or stat.S_ISLNK(expected.st_mode)
            ):
                raise CacheCorruptError()
            descriptor = os.open(lock_path, flags, 0o600)
            try:
                info = os.fstat(descriptor)
                current = lock_path.lstat()
                if (
                    not stat.S_ISREG(info.st_mode)
                    or not stat.S_ISREG(current.st_mode)
                    or _identity(info) != _identity(current)
                    or (expected is not None and _identity(expected) != _identity(current))
                ):
                    raise CacheCorruptError()
                if info.st_size == 0:
                    os.write(descriptor, b"\0")
                    os.fsync(descriptor)
                _lock_descriptor(descriptor)
                self._platform_lock_state.depth = 1
                try:
                    with _windows_directory_chain(self.root, ()) as root_chain:
                        root_chain.validate()
                        yield
                        root_chain.validate()
                finally:
                    self._platform_lock_state.depth = 0
                    _unlock_descriptor(descriptor)
            finally:
                os.close(descriptor)

    def object_path(self, digest: str) -> Path:
        value = validate_digest(digest)[7:]
        return self.namespace / "objects" / "sha256" / value[:2] / value[2:]

    def _open_object_generation_guard(
        self,
        digest: str,
    ) -> _ObjectGenerationGuard | None:
        path = self.object_path(digest)
        context = (
            _windows_directory_chain(self.root, path.relative_to(self.root).parts)
            if _windows_mode()
            else _anchored_directory_chain(self.root, path.relative_to(self.root).parts)
        )
        try:
            chain = context.__enter__()
        except FileNotFoundError:
            return None
        except (OSError, ValueError) as error:
            raise CacheCorruptError(digest) from error
        return _ObjectGenerationGuard(digest=digest, context=context, chain=chain)

    def _validate_object_generation_guard(self, guard: _ObjectGenerationGuard) -> None:
        try:
            guard.chain.validate()
        except (OSError, ValueError) as error:
            raise CacheCorruptError(guard.digest) from error

    def _close_object_generation_guard(self, guard: _ObjectGenerationGuard | None) -> None:
        if guard is None:
            return
        try:
            guard.context.__exit__(None, None, None)
        except (OSError, ValueError) as error:
            raise CacheCorruptError(guard.digest) from error

    def catalog_path(
        self, canonical_url: str, *, confirmed_scope: str | None = None
    ) -> Path:
        canonical_url = snapshot_unicode_scalar_string(canonical_url)
        _validate_credential_free_url(canonical_url)
        return self.namespace / "catalogs" / origin_identifier(
            canonical_url, confirmed_scope=confirmed_scope
        )

    def _windows_publish_object_directory(self, private: Path, destination: Path) -> None:
        temporary_root = private.parent
        destination_parent = destination.parent
        with (
            _windows_directory_chain(
                self.root,
                temporary_root.relative_to(self.root).parts,
            ) as temporary_chain,
            _windows_directory_chain(
                self.root,
                destination_parent.relative_to(self.root).parts,
            ) as destination_chain,
        ):
            private_info = private.lstat()
            if not stat.S_ISDIR(private_info.st_mode):
                raise ValueError("private object")
            private_identity = _identity(private_info)
            temporary_chain.validate()
            destination_chain.validate()
            os.rename(private, destination)
            temporary_chain.validate()
            destination_chain.validate()
            published = destination.lstat()
            if not stat.S_ISDIR(published.st_mode) or _identity(published) != private_identity:
                raise ValueError("published object generation")
            _sync_directory(destination_parent)

    def _windows_publish_catalog_directory(self, private: Path, destination: Path) -> None:
        temporary_root = private.parent
        destination_parent = destination.parent
        quarantine = temporary_root / (
            f"catalog-old-{destination.name}-{secrets.token_hex(16)}"
        )
        with (
            _windows_directory_chain(
                self.root,
                temporary_root.relative_to(self.root).parts,
            ) as temporary_chain,
            _windows_directory_chain(
                self.root,
                destination_parent.relative_to(self.root).parts,
            ) as destination_chain,
        ):
            private_info = private.lstat()
            if not stat.S_ISDIR(private_info.st_mode):
                raise ValueError("private catalog")
            private_identity = _identity(private_info)
            moved_existing = False
            published = False
            temporary_chain.validate()
            destination_chain.validate()
            try:
                if os.path.lexists(destination):
                    existing = destination.lstat()
                    if not stat.S_ISDIR(existing.st_mode):
                        raise ValueError("catalog generation")
                    os.rename(destination, quarantine)
                    moved_existing = True
                os.rename(private, destination)
                published = True
                temporary_chain.validate()
                destination_chain.validate()
                actual = destination.lstat()
                if not stat.S_ISDIR(actual.st_mode) or _identity(actual) != private_identity:
                    raise ValueError("catalog generation")
            except Exception:
                if published and os.path.lexists(destination):
                    current = destination.lstat()
                    if _identity(current) == private_identity:
                        os.rename(destination, private)
                        published = False
                if moved_existing and not os.path.lexists(destination):
                    os.rename(quarantine, destination)
                    moved_existing = False
                raise
            _sync_directory(destination_parent)
            if moved_existing:
                old_identity = _identity(quarantine.lstat())
                _windows_remove_tree_path(
                    quarantine,
                    expected_identity=old_identity,
                    max_entries=self.max_scan_entries,
                    max_depth=self.max_path_depth,
                )

    def _windows_cleanup_private_directory(self, private: Path) -> None:
        if not os.path.lexists(private):
            return
        with _windows_directory_chain(
            self.root,
            private.parent.relative_to(self.root).parts,
        ) as parent_chain:
            info = private.lstat()
            if not stat.S_ISDIR(info.st_mode):
                raise ValueError("private generation")
            parent_chain.validate()
            _windows_remove_tree_path(
                private,
                expected_identity=_identity(info),
                max_entries=self.max_scan_entries,
                max_depth=self.max_path_depth,
            )

    @_guarded_cache_operation
    def get_catalog(
        self, canonical_url: str, *, confirmed_scope: str | None = None
    ) -> CachedCatalog | None:
        canonical_url = validate_catalog_lookup_url(canonical_url)
        if confirmed_scope is not None and not is_valid_scope(confirmed_scope):
            raise CacheConfigurationError("confirmed_scope")
        catalog = self._read_catalog(
            canonical_url,
            confirmed_scope=confirmed_scope,
            remaining_generation_retries=MAX_CATALOG_GENERATION_RETRIES,
        )
        if catalog is not None:
            return catalog
        with self._catalog_mutation_guard(canonical_url, confirmed_scope):
            current = self._read_catalog(
                canonical_url,
                confirmed_scope=confirmed_scope,
                remaining_generation_retries=MAX_CATALOG_GENERATION_RETRIES,
            )
            if current is not None:
                return current
            restored = self._restore_catalog_previous_before_absence_unlocked(
                canonical_url, confirmed_scope
            )
            if not restored:
                return None
            return self._read_catalog(
                canonical_url,
                confirmed_scope=confirmed_scope,
                remaining_generation_retries=MAX_CATALOG_GENERATION_RETRIES,
            )

    @_guarded_cache_operation
    def get_catalog_state(
        self, canonical_url: str, *, confirmed_scope: str | None = None
    ) -> CatalogState:
        canonical_url = validate_catalog_lookup_url(canonical_url)
        if confirmed_scope is not None and not is_valid_scope(confirmed_scope):
            raise CacheConfigurationError("confirmed_scope")
        with self._catalog_mutation_guard(canonical_url, confirmed_scope):
            self._restore_catalog_previous_before_absence_unlocked(
                canonical_url, confirmed_scope
            )
            return self._read_catalog_state_unlocked(canonical_url, confirmed_scope)

    def _restore_catalog_previous_before_absence_unlocked(
        self, canonical_url: str, confirmed_scope: str | None
    ) -> bool:
        current = self.catalog_path(canonical_url, confirmed_scope=confirmed_scope)
        if os.path.lexists(current):
            return False
        identifier = catalog_identifier(canonical_url, confirmed_scope)
        previous = (
            self._catalog_generation_directory(create=False)
            / identifier
            / "previous"
        )
        if not os.path.lexists(previous):
            return False
        self._cleanup_catalog_previous_generation(
            identifier,
            scan_budget=_ScanBudget(self.max_scan_entries),
            already_guarded=True,
        )
        return os.path.lexists(current)

    def _read_catalog_state_unlocked(
        self, canonical_url: str, confirmed_scope: str | None
    ) -> CatalogState:
        catalog = self._read_catalog(
            canonical_url,
            confirmed_scope=confirmed_scope,
            remaining_generation_retries=MAX_CATALOG_GENERATION_RETRIES,
        )
        identifier = catalog_identifier(canonical_url, confirmed_scope)
        if catalog is None:
            return CatalogState(
                None,
                catalog_absence_generation(identifier, self._read_catalog_epoch()),
            )
        path = self.catalog_path(canonical_url, confirmed_scope=confirmed_scope)
        generation = self._read_present_catalog_generation(path, identifier)
        return CatalogState(catalog, generation)

    def _read_catalog(
        self,
        canonical_url: str,
        *,
        confirmed_scope: str | None,
        remaining_generation_retries: int,
    ) -> CachedCatalog | None:
        path = self.catalog_path(canonical_url, confirmed_scope=confirmed_scope)
        if not os.path.lexists(path):
            return None
        descriptor: int | None = None
        opened_identity: tuple[int, int, int] | None = None
        try:
            descriptor, opened_path = _open_replaceable_directory_generation(
                self.root,
                path,
            )
            if descriptor is not None:
                opened_identity = _identity(os.fstat(descriptor))
            names = _bounded_directory_names(
                descriptor,
                opened_path,
                max_entries=3,
            )
            if set(names) not in (
                {"body.json", "metadata.json"},
                {"body.json", "metadata.json", "generation.json"},
            ):
                raise ValueError("catalog files")
            metadata_value: Any = _parse_cache_json(
                _read_regular_file(
                    descriptor,
                    opened_path,
                    "metadata.json",
                    max_bytes=self.max_object_metadata_bytes,
                    descriptor_anchored=True,
                )
            )
            if not isinstance(metadata_value, dict):
                raise ValueError("catalog metadata")
            keys = set(metadata_value)
            if not _CATALOG_REQUIRED_KEYS <= keys or not keys <= (
                _CATALOG_REQUIRED_KEYS | _CATALOG_OPTIONAL_KEYS
            ):
                raise ValueError("catalog schema")
            if (
                metadata_value["schema"] != "remote-skills-catalog-metadata-v1"
                or metadata_value["canonical_url"] != canonical_url
                or metadata_value.get("confirmed_scope") != confirmed_scope
            ):
                raise ValueError("catalog identity")
            for optional in _CATALOG_OPTIONAL_KEYS:
                if optional in metadata_value:
                    if not is_unicode_scalar_string(metadata_value[optional]):
                        raise ValueError("catalog validator")
            body = _read_regular_file(
                descriptor,
                opened_path,
                "body.json",
                max_bytes=self.max_catalog_bytes,
                descriptor_anchored=True,
            )
            try:
                body_value = _parse_cache_json(body)
                body_parsed = True
            except ValueError:
                body_parsed = False
                body_value = None
            if not body_parsed:
                raise ValueError("catalog body")
            if _catalog_body_contains_credentials(
                body_value,
                max_entries=self.max_scan_entries,
                max_depth=self.max_path_depth,
            ):
                raise ValueError("credential-bearing catalog body")
            cached = CachedCatalog(
                body=body,
                metadata=CatalogMetadata(
                    canonical_url=canonical_url,
                    retrieved_at=_parse_timestamp(metadata_value["retrieved_at"]),
                    validated_at=_parse_timestamp(metadata_value["validated_at"]),
                    confirmed_scope=metadata_value.get("confirmed_scope"),
                    etag=metadata_value.get("etag"),
                    last_modified=metadata_value.get("last_modified"),
                    cache_control=metadata_value.get("cache_control"),
                ),
            )
            if self.touch_on_read and descriptor is not None and os.utime in os.supports_fd:
                timestamp = int(self._now().timestamp() * 1_000_000_000)
                os.utime(descriptor, ns=(timestamp, timestamp))
            elif self.touch_on_read and _windows_mode():
                timestamp = int(self._now().timestamp() * 1_000_000_000)
                with _windows_directory_chain(
                    self.root,
                    opened_path.relative_to(self.root).parts,
                ) as catalog_chain:
                    catalog_chain.validate()
                    _windows_touch_directory(
                        opened_path,
                        expected_identity=catalog_chain.identities[-1],
                        timestamp_ns=timestamp,
                    )
                    catalog_chain.validate()
            return cached
        except (OSError, UnicodeError, ValueError, TypeError, json.JSONDecodeError):
            if (
                opened_identity is not None
                and self._catalog_generation_changed(path, opened_identity)
            ):
                if remaining_generation_retries == 0:
                    return None
                return self._read_catalog(
                    canonical_url,
                    confirmed_scope=confirmed_scope,
                    remaining_generation_retries=remaining_generation_retries - 1,
                )
            raise CacheCorruptError() from None
        finally:
            if descriptor is not None:
                os.close(descriptor)

    def _catalog_generation_changed(
        self,
        path: Path,
        opened_identity: tuple[int, int, int],
    ) -> bool:
        current_descriptor: int | None = None
        try:
            current_descriptor, _ = _open_replaceable_directory_generation(
                self.root,
                path,
            )
            return current_descriptor is not None and _identity(
                os.fstat(current_descriptor)
            ) != opened_identity
        except (OSError, ValueError):
            return False
        finally:
            if current_descriptor is not None:
                os.close(current_descriptor)

    def _read_catalog_generation_snapshot(
        self,
        path: Path,
        identifier: str,
        *,
        scan_budget: _ScanBudget,
    ) -> tuple[CachedCatalog, tuple[int, int, int]]:
        descriptor: int | None = None
        try:
            descriptor, opened_path = _open_replaceable_directory_generation(
                self.root, path
            )
            opened_info = (
                os.fstat(descriptor)
                if descriptor is not None
                else opened_path.lstat()
            )
            opened_identity = _identity(opened_info)
            names = _bounded_directory_names(
                descriptor,
                opened_path,
                max_entries=3,
                scan_budget=scan_budget,
            )
            if set(names) != {"body.json", "metadata.json", "generation.json"}:
                raise ValueError("catalog files")
            metadata_value: Any = _parse_cache_json(
                _read_regular_file(
                    descriptor,
                    opened_path,
                    "metadata.json",
                    max_bytes=self.max_object_metadata_bytes,
                    descriptor_anchored=True,
                )
            )
            if not isinstance(metadata_value, dict):
                raise ValueError("catalog metadata")
            keys = set(metadata_value)
            if not _CATALOG_REQUIRED_KEYS <= keys or not keys <= (
                _CATALOG_REQUIRED_KEYS | _CATALOG_OPTIONAL_KEYS
            ):
                raise ValueError("catalog schema")
            if metadata_value.get("schema") != "remote-skills-catalog-metadata-v1":
                raise ValueError("catalog schema")
            canonical_url = validate_catalog_lookup_url(
                metadata_value.get("canonical_url")
            )
            confirmed_scope = metadata_value.get("confirmed_scope")
            if confirmed_scope is not None and not is_valid_scope(confirmed_scope):
                raise ValueError("catalog scope")
            if catalog_identifier(canonical_url, confirmed_scope) != identifier:
                raise ValueError("catalog identity")
            for optional in _CATALOG_OPTIONAL_KEYS:
                if optional in metadata_value and not is_unicode_scalar_string(
                    metadata_value[optional]
                ):
                    raise ValueError("catalog validator")
            body = _read_regular_file(
                descriptor,
                opened_path,
                "body.json",
                max_bytes=self.max_catalog_bytes,
                descriptor_anchored=True,
            )
            body_value = _parse_cache_json(body)
            if _catalog_body_contains_credentials(
                body_value,
                max_entries=self.max_scan_entries,
                max_depth=self.max_path_depth,
            ):
                raise ValueError("credential-bearing catalog body")
            generation_value: Any = _parse_cache_json(
                _read_regular_file(
                    descriptor,
                    opened_path,
                    "generation.json",
                    max_bytes=1024,
                    descriptor_anchored=True,
                )
            )
            if (
                not isinstance(generation_value, dict)
                or set(generation_value)
                != {"schema", "catalog_identifier", "generation", "state"}
                or generation_value.get("schema") != _CATALOG_GENERATION_SCHEMA
                or generation_value.get("catalog_identifier") != identifier
                or generation_value.get("state") != "present"
                or not isinstance(generation_value.get("generation"), str)
                or _CATALOG_GENERATION_PATTERN.fullmatch(
                    generation_value["generation"]
                )
                is None
            ):
                raise ValueError("catalog generation")
            current_info = (
                os.fstat(descriptor)
                if descriptor is not None
                else opened_path.lstat()
            )
            if _identity(current_info) != opened_identity:
                raise ValueError("catalog generation")
            return (
                CachedCatalog(
                    body=body,
                    metadata=CatalogMetadata(
                        canonical_url=canonical_url,
                        retrieved_at=_parse_timestamp(
                            metadata_value["retrieved_at"]
                        ),
                        validated_at=_parse_timestamp(
                            metadata_value["validated_at"]
                        ),
                        confirmed_scope=confirmed_scope,
                        etag=metadata_value.get("etag"),
                        last_modified=metadata_value.get("last_modified"),
                        cache_control=metadata_value.get("cache_control"),
                    ),
                ),
                opened_identity,
            )
        except (
            CacheConfigurationError,
            OSError,
            UnicodeError,
            ValueError,
            TypeError,
            json.JSONDecodeError,
        ) as error:
            raise CacheCorruptError() from error
        finally:
            if descriptor is not None:
                os.close(descriptor)

    def _read_present_catalog_generation(
        self, path: Path, identifier: str
    ) -> CatalogGeneration:
        descriptor: int | None = None
        try:
            descriptor, opened_path = _open_replaceable_directory_generation(
                self.root, path
            )
            raw = _read_regular_file(
                descriptor,
                opened_path,
                "generation.json",
                max_bytes=1024,
                descriptor_anchored=True,
            )
            value = _parse_cache_json(raw)
            if (
                not isinstance(value, dict)
                or set(value)
                != {"schema", "catalog_identifier", "generation", "state"}
                or value.get("schema") != _CATALOG_GENERATION_SCHEMA
                or value.get("catalog_identifier") != identifier
                or value.get("state") != "present"
                or not isinstance(value.get("generation"), str)
                or _CATALOG_GENERATION_PATTERN.fullmatch(value["generation"]) is None
            ):
                raise ValueError("catalog generation")
            return CatalogGeneration(value["generation"])
        except (OSError, TypeError, ValueError, json.JSONDecodeError) as error:
            raise CacheCorruptError() from error
        finally:
            if descriptor is not None:
                os.close(descriptor)

    def _catalog_generation_directory(self, *, create: bool) -> Path:
        directory = (
            self._ensure_cache_directory("tmp", _CATALOG_GENERATION_DIRECTORY)
            if create
            else self.namespace / "tmp" / _CATALOG_GENERATION_DIRECTORY
        )
        if not _regular_directory(directory):
            if not create and not os.path.lexists(directory):
                return directory
            raise CacheCorruptError()
        return directory

    def _read_catalog_epoch(self) -> int:
        directory = self._catalog_generation_directory(create=False)
        if not os.path.lexists(directory):
            if os.path.lexists(self.namespace / "catalogs"):
                raise CacheCorruptError()
            return 0
        try:
            context = (
                _windows_directory_chain(
                    self.root, directory.relative_to(self.root).parts
                )
                if _windows_mode()
                else _anchored_directory_chain(
                    self.root, directory.relative_to(self.root).parts
                )
            )
            with context as chain:
                raw = _read_regular_file(
                    getattr(chain, "descriptor", None),
                    chain.path,
                    _CATALOG_GENERATION_STATE_NAME,
                    max_bytes=1024,
                    descriptor_anchored=True,
                )
                chain.validate()
            value = _parse_cache_json(raw)
            if (
                not isinstance(value, dict)
                or set(value) != {"schema", "generation"}
                or value.get("schema") != _CATALOG_GENERATION_STATE_SCHEMA
                or not isinstance(value.get("generation"), int)
                or isinstance(value.get("generation"), bool)
                or not 1 <= value["generation"] <= MAX_SAFE_INTEGER
            ):
                raise ValueError("catalog generation state")
            return value["generation"]
        except (OSError, TypeError, ValueError, json.JSONDecodeError) as error:
            raise CacheCorruptError() from error

    def _advance_catalog_epoch(self) -> int:
        current = self._read_catalog_epoch()
        if current >= MAX_SAFE_INTEGER:
            raise CacheCorruptError()
        generation = current + 1
        directory = self._catalog_generation_directory(create=True)
        context = (
            _windows_directory_chain(
                self.root, directory.relative_to(self.root).parts
            )
            if _windows_mode()
            else _anchored_directory_chain(
                self.root, directory.relative_to(self.root).parts
            )
        )
        with context as chain:
            _atomic_replace_file_at(
                getattr(chain, "descriptor", None),
                chain.path,
                _CATALOG_GENERATION_STATE_NAME,
                _json_bytes(
                    {
                        "schema": _CATALOG_GENERATION_STATE_SCHEMA,
                        "generation": generation,
                    }
                ),
            )
            chain.validate()
        return generation

    def _new_present_catalog_generation(
        self, identifier: str
    ) -> tuple[CatalogGeneration, bytes]:
        generation = CatalogGeneration(f"sha256:{secrets.token_hex(32)}")
        return generation, _json_bytes(
            {
                "schema": _CATALOG_GENERATION_SCHEMA,
                "catalog_identifier": identifier,
                "generation": generation.token,
                "state": "present",
            }
        )

    @contextmanager
    def _catalog_mutation_guard(
        self,
        canonical_url: str,
        confirmed_scope: str | None,
    ):
        """Serialize one catalog identity through cache-v1's Lamport gate."""

        identifier = catalog_identifier(canonical_url, confirmed_scope)
        with self._catalog_mutation_guard_identifier(identifier):
            yield

    @contextmanager
    def _catalog_mutation_guard_identifier(self, identifier: str):
        if _CATALOG_IDENTIFIER_PATTERN.fullmatch(identifier) is None:
            raise CacheConfigurationError("catalog_identifier")
        held = getattr(self._catalog_guard_state, "identifiers", None)
        if held is None:
            held = set()
            self._catalog_guard_state.identifiers = held
        if identifier in held:
            yield
            return
        global_claim = self._acquire_eviction_claim(
            catalog_generation_state_digest(), operation="mutation"
        )
        identity_claim = None
        try:
            identity_claim = self._acquire_eviction_claim(
                catalog_mutation_digest(identifier), operation="mutation"
            )
            held.add(identifier)
            try:
                yield
            finally:
                held.remove(identifier)
        finally:
            if identity_claim is not None:
                self._release_eviction_claim(identity_claim)
            self._release_eviction_claim(global_claim)

    @_guarded_cache_operation
    def replace_catalog(
        self,
        catalog: CachedCatalog,
        *,
        expected_generation: CatalogGeneration,
    ) -> bool:
        """Conditionally publish under a process-shared exact-generation CAS.

        The guarantee covers all clients using this conditional API, including
        separate ``DiskCache`` instances and processes sharing a root. It rejects
        a write when any catalog generation has committed since the caller read
        ``expected``; it does not impose request-start order across processes.
        """

        catalog = snapshot_cached_catalog(catalog)
        _validate_credential_free_url(catalog.metadata.canonical_url)
        self._validate_catalog(catalog)
        expected_generation = validate_catalog_generation(expected_generation)
        with self._catalog_mutation_guard(
            catalog.metadata.canonical_url,
            catalog.metadata.confirmed_scope,
        ):
            current = self._read_catalog_state_unlocked(
                catalog.metadata.canonical_url,
                catalog.metadata.confirmed_scope,
            )
            if current.generation != expected_generation:
                return False
            self._advance_catalog_epoch()
            identifier = catalog_identifier(
                catalog.metadata.canonical_url,
                catalog.metadata.confirmed_scope,
            )
            _generation, generation_bytes = self._new_present_catalog_generation(
                identifier
            )
            self._publish_catalog_unlocked(catalog, generation_bytes)
        self._apply_configured_bounds()
        return True

    @_guarded_cache_operation
    def delete_catalog(
        self,
        canonical_url: str,
        *,
        confirmed_scope: str | None,
        expected_generation: CatalogGeneration,
    ) -> bool:
        """Conditionally delete one exact, scoped catalog generation."""

        canonical_url = validate_catalog_lookup_url(canonical_url)
        if confirmed_scope is not None and not is_valid_scope(confirmed_scope):
            raise CacheConfigurationError("confirmed_scope")
        expected_generation = validate_catalog_generation(expected_generation)
        with self._catalog_mutation_guard(canonical_url, confirmed_scope):
            current = self._read_catalog_state_unlocked(
                canonical_url, confirmed_scope
            )
            if (
                current.catalog is None
                or current.generation != expected_generation
            ):
                return False
            self._advance_catalog_epoch()
            destination = self.catalog_path(
                canonical_url,
                confirmed_scope=confirmed_scope,
            )
            try:
                if _windows_mode():
                    self._windows_cleanup_private_directory(destination)
                else:
                    catalog_parent = self._ensure_cache_directory("catalogs")
                    with _anchored_directory_chain(
                        self.root,
                        catalog_parent.relative_to(self.root).parts,
                    ) as catalog_chain:
                        descriptor = _open_directory_entry_at(
                            catalog_chain.descriptor,
                            destination.name,
                        )
                        try:
                            identity = _identity(os.fstat(descriptor))
                        finally:
                            os.close(descriptor)
                        _remove_tree_at(
                            catalog_chain.descriptor,
                            catalog_chain.path,
                            destination.name,
                            expected_identity=identity,
                            max_entries=self.max_scan_entries,
                            max_depth=self.max_path_depth,
                        )
                        _sync_directory_descriptor(catalog_chain.descriptor)
                        catalog_chain.validate()
            except (OSError, ValueError) as error:
                raise CacheCorruptError() from error
            return True

    @_guarded_cache_operation
    def publish_catalog(self, catalog: CachedCatalog) -> CachedCatalog:
        catalog = snapshot_cached_catalog(catalog)
        _validate_credential_free_url(catalog.metadata.canonical_url)
        self._validate_catalog(catalog)
        try:
            body_value = _parse_cache_json(catalog.body)
            if _catalog_body_contains_credentials(
                body_value,
                max_entries=self.max_scan_entries,
                max_depth=self.max_path_depth,
            ):
                raise CacheConfigurationError("catalog_body")
        except CacheConfigurationError:
            raise
        except (TypeError, ValueError) as error:
            raise CacheCorruptError() from error
        identifier = catalog_identifier(
            catalog.metadata.canonical_url,
            catalog.metadata.confirmed_scope,
        )
        with self._catalog_mutation_guard(
            catalog.metadata.canonical_url,
            catalog.metadata.confirmed_scope,
        ):
            self._advance_catalog_epoch()
            _generation, generation_bytes = self._new_present_catalog_generation(
                identifier
            )
            published = self._publish_catalog_unlocked(catalog, generation_bytes)
        self._apply_configured_bounds()
        return published

    def _publish_catalog_unlocked(
        self, catalog: CachedCatalog, generation_bytes: bytes
    ) -> CachedCatalog:
        catalog = snapshot_cached_catalog(catalog)
        identifier = catalog_identifier(
            catalog.metadata.canonical_url,
            catalog.metadata.confirmed_scope,
        )
        _validate_credential_free_url(catalog.metadata.canonical_url)
        self._validate_catalog(catalog)
        try:
            body_value = _parse_cache_json(catalog.body)
            body_parsed = True
        except ValueError:
            body_parsed = False
            body_value = None
        if not body_parsed:
            raise CacheCorruptError()
        try:
            if _catalog_body_contains_credentials(
                body_value,
                max_entries=self.max_scan_entries,
                max_depth=self.max_path_depth,
            ):
                raise CacheConfigurationError("catalog_body")
        except CacheConfigurationError:
            raise
        except ValueError:
            raise CacheCorruptError() from None
        destination = self.catalog_path(
            catalog.metadata.canonical_url,
            confirmed_scope=catalog.metadata.confirmed_scope,
        )
        temporary_root = self._ensure_cache_directory("tmp")
        if _windows_mode():
            private = Path(
                tempfile.mkdtemp(
                    prefix=f"catalog-python-{identifier}-", dir=temporary_root
                )
            )
            private_commit_started = False
            try:
                _write_file(private / "body.json", catalog.body)
                _write_file(
                    private / "metadata.json",
                    self._serialize_catalog(catalog.metadata),
                )
                _write_file(private / "generation.json", generation_bytes)
                self._ensure_cache_directory("catalogs")
                self._windows_publish_catalog_directory(private, destination)
                private_commit_started = True
                return catalog
            except CacheCorruptError:
                raise
            except (OSError, ValueError) as error:
                raise CacheCorruptError() from error
            finally:
                if not private_commit_started and private.exists():
                    try:
                        self._windows_cleanup_private_directory(private)
                    except (OSError, ValueError) as error:
                        raise CacheCorruptError() from error

        try:
            with _private_directory_generation(
                self.root,
                temporary_root,
                prefix=f"catalog-python-{identifier}-",
                max_entries=self.max_scan_entries,
                max_depth=self.max_path_depth,
            ) as private:
                _write_file_at(
                    private.descriptor,
                    private.path,
                    "body.json",
                    catalog.body,
                )
                _write_file_at(
                    private.descriptor,
                    private.path,
                    "metadata.json",
                    self._serialize_catalog(catalog.metadata),
                )
                _write_file_at(
                    private.descriptor,
                    private.path,
                    "generation.json",
                    generation_bytes,
                )
                _sync_directory_descriptor(private.descriptor)
                private.parent.validate()
                catalog_parent = self._ensure_cache_directory("catalogs")
                with _anchored_directory_chain(
                    self.root,
                    catalog_parent.relative_to(self.root).parts,
                ) as catalog_chain:
                    exchanged = False
                    existing_identity: tuple[int, int, int] | None = None
                    try:
                        existing_descriptor = _open_directory_entry_at(
                            catalog_chain.descriptor,
                            destination.name,
                        )
                    except FileNotFoundError:
                        existing_descriptor = None
                    if existing_descriptor is not None:
                        existing_identity = _identity(os.fstat(existing_descriptor))
                        os.close(existing_descriptor)
                        _atomic_exchange_directories(
                            private.parent.descriptor,
                            private.name,
                            catalog_chain.descriptor,
                            destination.name,
                        )
                        exchanged = True
                    else:
                        try:
                            os.rename(
                                private.name,
                                destination.name,
                                src_dir_fd=private.parent.descriptor,
                                dst_dir_fd=catalog_chain.descriptor,
                            )
                        except OSError as error:
                            if error.errno not in {EEXIST, ENOTEMPTY}:
                                raise
                            existing_descriptor = _open_directory_entry_at(
                                catalog_chain.descriptor,
                                destination.name,
                            )
                            try:
                                existing_identity = _identity(os.fstat(existing_descriptor))
                            finally:
                                os.close(existing_descriptor)
                            _atomic_exchange_directories(
                                private.parent.descriptor,
                                private.name,
                                catalog_chain.descriptor,
                                destination.name,
                            )
                            exchanged = True
                    private.parent.validate()
                    catalog_chain.validate()
                    published_descriptor = _open_directory_entry_at(
                        catalog_chain.descriptor,
                        destination.name,
                    )
                    try:
                        if _identity(os.fstat(published_descriptor)) != private.identity:
                            raise ValueError("catalog generation")
                    finally:
                        os.close(published_descriptor)
                    _sync_directory_descriptor(catalog_chain.descriptor)
                    if exchanged:
                        if existing_identity is None:
                            raise ValueError("catalog generation")
                        _remove_tree_at(
                            private.parent.descriptor,
                            private.parent.path,
                            private.name,
                            expected_identity=existing_identity,
                            max_entries=self.max_scan_entries,
                            max_depth=self.max_path_depth,
                        )
            return catalog
        except CacheCorruptError:
            raise
        except (OSError, ValueError) as error:
            raise CacheCorruptError() from error

    def _validate_catalog(self, catalog: CachedCatalog) -> None:
        metadata = catalog.metadata
        if not isinstance(catalog.body, bytes):
            raise CacheConfigurationError("catalog_body")
        if len(catalog.body) > self.max_catalog_bytes:
            raise CacheConfigurationError("catalog_body")
        if metadata.confirmed_scope is not None and not is_valid_scope(
            metadata.confirmed_scope
        ):
            raise CacheConfigurationError("confirmed_scope")
        for field in _CATALOG_OPTIONAL_KEYS:
            if field == "confirmed_scope":
                continue
            value = getattr(metadata, field)
            if value is not None and not isinstance(value, str):
                raise CacheConfigurationError(field)
            if value is not None and not is_unicode_scalar_string(value):
                raise CacheCorruptError()
        for field in ("retrieved_at", "validated_at"):
            value = getattr(metadata, field)
            if not isinstance(value, datetime) or value.utcoffset() is None:
                raise CacheConfigurationError(field)
        if len(self._serialize_catalog(metadata)) > self.max_object_metadata_bytes:
            raise CacheConfigurationError("catalog_metadata")

    def _serialize_catalog(self, metadata: CatalogMetadata) -> bytes:
        value: dict[str, object] = {
            "schema": "remote-skills-catalog-metadata-v1",
            "canonical_url": metadata.canonical_url,
        }
        if metadata.confirmed_scope is not None:
            value["confirmed_scope"] = metadata.confirmed_scope
        if metadata.etag is not None:
            value["etag"] = metadata.etag
        if metadata.last_modified is not None:
            value["last_modified"] = metadata.last_modified
        if metadata.cache_control is not None:
            value["cache_control"] = metadata.cache_control
        value["retrieved_at"] = _format_timestamp(metadata.retrieved_at)
        value["validated_at"] = _format_timestamp(metadata.validated_at)
        return _json_bytes(value)

    @_guarded_cache_operation
    def get_object(self, digest: str) -> CachedObject | None:
        digest = validate_digest(digest)
        object_path = self.object_path(digest)
        if not os.path.lexists(object_path):
            return None
        object_descriptor: int | None = None
        try:
            relative = object_path.relative_to(self.root)
            object_descriptor, opened_path = _open_directory_chain(self.root, relative.parts)
            cached = self._read_object(object_descriptor, opened_path, digest)
            if self.touch_on_read:
                cached = self._touch_object_accessed_at(
                    digest,
                    object_descriptor,
                    opened_path,
                    cached,
                )
            return cached
        except (OSError, UnicodeError, ValueError, TypeError, json.JSONDecodeError) as error:
            raise CacheCorruptError(digest) from error
        finally:
            if object_descriptor is not None:
                os.close(object_descriptor)

    def _touch_object_accessed_at(
        self,
        digest: str,
        observed_descriptor: int | None,
        observed_path: Path,
        observed: CachedObject,
    ) -> CachedObject:
        """Advance LRU metadata without allowing concurrent touches to regress it."""

        requested_at = self._now()
        relative = observed_path.relative_to(self.root)
        if observed_descriptor is None:
            try:
                with _windows_directory_chain(self.root, relative.parts) as chain:
                    chain.validate()
                    current = self._read_object(None, chain.path, digest)
                    touched = replace(
                        current,
                        accessed_at=max(current.accessed_at, requested_at),
                    )
                    chain.validate()
                    _atomic_replace_file_at(
                        None,
                        chain.path,
                        "object.json",
                        self._serialize_object(touched),
                    )
                    chain.validate()
                    return touched
            except (OSError, ValueError):
                return observed

        observed_identity = _identity(os.fstat(observed_descriptor))
        try:
            claim = self._try_acquire_eviction_claim(digest)
        except Exception:
            return observed
        if claim is None:
            return observed
        current_descriptor: int | None = None
        try:
            try:
                current_descriptor, current_path = _open_directory_chain(
                    self.root,
                    relative.parts,
                )
            except (OSError, ValueError):
                return observed
            if _identity(os.fstat(current_descriptor)) != observed_identity:
                return observed
            current = self._read_object(current_descriptor, current_path, digest)
            touched = replace(
                current,
                accessed_at=max(current.accessed_at, requested_at),
            )
            _atomic_replace_file_at(
                current_descriptor,
                current_path,
                "object.json",
                self._serialize_object(touched),
            )
            return touched
        finally:
            if current_descriptor is not None:
                os.close(current_descriptor)
            self._release_eviction_claim(claim)

    @_guarded_cache_operation
    def acquire_lease(
        self,
        digest: str,
        *,
        process_nonce: str,
        session_nonce: str,
        pid: int | None = None,
    ) -> CacheLease:
        digest = validate_digest(digest)
        self.object_path(digest)
        process_nonce = self._validate_nonce(process_nonce)
        session_nonce = self._validate_nonce(session_nonce)
        selected_pid = validate_process_id(os.getpid() if pid is None else pid)
        object_generation = self._open_object_generation_guard(digest)
        try:
            claim = self._acquire_eviction_claim(digest, operation="acquire")
            descriptor: int | None = None
            try:
                if object_generation is not None:
                    self._validate_object_generation_guard(object_generation)
                elif claim.gate is not None and claim.gate.contended_with_eviction:
                    if not _regular_directory(self.object_path(digest)):
                        raise CacheCorruptError(digest)
                descriptor, directory = self._open_lease_directory(digest, create=False)
                if self._matching_lease_identity_exists(
                    descriptor,
                    directory,
                    digest=digest,
                    process_nonce=process_nonce,
                    session_nonce=session_nonce,
                ):
                    raise CacheConfigurationError("session_nonce")
                now = self._reserve_lease_generation(
                    descriptor,
                    directory,
                    _canonical_lease_timestamp(self._now()),
                )
                lease = CacheLease(
                    digest=digest,
                    pid=selected_pid,
                    process_nonce=process_nonce,
                    session_nonce=session_nonce,
                    created_at=now,
                    renewed_at=now,
                    lease_nonce=secrets.token_hex(16),
                )
                path = self._lease_path(lease)
                self._register_process(lease)
                try:
                    _atomic_create_file_at(
                        descriptor,
                        directory,
                        path.name,
                        self._serialize_lease(lease),
                    )
                except FileExistsError as error:
                    self._remove_process_registration_if_unused(
                        lease.digest,
                        lease.pid,
                        lease.process_nonce,
                    )
                    raise CacheConfigurationError("session_nonce") from error
                return lease
            except CacheConfigurationError:
                raise
            except (OSError, UnicodeError, ValueError, TypeError) as error:
                raise CacheCorruptError(digest) from error
            finally:
                if descriptor is not None:
                    os.close(descriptor)
                self._release_eviction_claim(claim)
        finally:
            self._close_object_generation_guard(object_generation)

    @_guarded_cache_operation
    def renew_lease(self, lease: CacheLease) -> CacheLease:
        lease = snapshot_cache_lease(lease)
        path = self._lease_path(lease)
        claim = self._acquire_eviction_claim(lease.digest)
        try:
            descriptor: int | None = None
            try:
                descriptor, directory = self._open_lease_directory(lease.digest, create=False)
                content, info, _ = _read_regular_file_snapshot_at(
                    descriptor,
                    directory,
                    path.name,
                    max_bytes=self.max_lease_metadata_bytes,
                )
                current = self._deserialize_lease(content, lease.digest)
                if current != lease or not _entry_matches_snapshot(
                    descriptor,
                    directory,
                    path.name,
                    content=content,
                    identity=_identity(info),
                    max_bytes=self.max_lease_metadata_bytes,
                ):
                    raise ValueError("lease generation")
                renewed = replace(
                    lease,
                    renewed_at=self._reserve_lease_generation(
                        descriptor,
                        directory,
                        _next_lease_timestamp(self._now(), current.renewed_at),
                    ),
                )
                _atomic_replace_file_at(
                    descriptor,
                    directory,
                    path.name,
                    self._serialize_lease(renewed),
                )
                self._register_process(renewed)
                return renewed
            except (OSError, UnicodeError, ValueError, TypeError, json.JSONDecodeError) as error:
                raise CacheCorruptError(lease.digest) from error
            finally:
                if descriptor is not None:
                    os.close(descriptor)
        finally:
            self._release_eviction_claim(claim)

    @_guarded_cache_operation
    def release_lease(self, lease: CacheLease) -> None:
        lease = snapshot_cache_lease(lease)
        path = self._lease_path(lease)
        claim = self._acquire_eviction_claim(lease.digest)
        try:
            descriptor: int | None = None
            try:
                descriptor, directory = self._open_lease_directory(lease.digest, create=False)
                content, info, _ = _read_regular_file_snapshot_at(
                    descriptor,
                    directory,
                    path.name,
                    max_bytes=self.max_lease_metadata_bytes,
                )
                current = self._deserialize_lease(content, lease.digest)
                if current != lease or not _entry_matches_snapshot(
                    descriptor,
                    directory,
                    path.name,
                    content=content,
                    identity=_identity(info),
                    max_bytes=self.max_lease_metadata_bytes,
                ):
                    raise ValueError("lease generation")
                self._record_lease_generation(
                    descriptor,
                    directory,
                    max(current.created_at, current.renewed_at),
                )
                _unlink_at(descriptor, directory, path.name)
                self._remove_process_registration_if_unused(
                    lease.digest,
                    lease.pid,
                    lease.process_nonce,
                )
            except FileNotFoundError:
                if descriptor is not None and self._matching_lease_identity_exists(
                    descriptor,
                    directory,
                    digest=lease.digest,
                    process_nonce=lease.process_nonce,
                    session_nonce=lease.session_nonce,
                ):
                    raise CacheCorruptError(lease.digest)
                return
            except (OSError, ValueError) as error:
                raise CacheCorruptError(lease.digest) from error
            finally:
                if descriptor is not None:
                    os.close(descriptor)
        finally:
            self._release_eviction_claim(claim)

    @_guarded_cache_operation
    def has_live_lease(self, digest: str, *, lease_expiry_seconds: int = 120) -> bool:
        return self._has_live_lease(
            digest,
            lease_expiry_seconds=lease_expiry_seconds,
            ignore_eviction_claim=False,
            scan_budget=_ScanBudget(self.max_scan_entries),
        )

    def _has_live_lease(
        self,
        digest: str,
        *,
        lease_expiry_seconds: int,
        ignore_eviction_claim: bool,
        scan_budget: _ScanBudget | None = None,
    ) -> bool:
        validate_nonnegative_safe_integer(lease_expiry_seconds, "lease_expiry_seconds")
        directory = self._lease_directory(digest)
        if not os.path.lexists(directory):
            return False
        descriptor: int | None = None
        try:
            descriptor, opened_directory = self._open_lease_directory(digest, create=False)
            names = _bounded_directory_names(
                descriptor,
                opened_directory,
                max_entries=self.max_scan_entries,
                scan_budget=scan_budget,
            )
        except (OSError, ValueError):
            return True
        try:
            for name in names:
                if name.startswith("."):
                    continue
                if not name.endswith(".json"):
                    return True
                info: os.stat_result | None = None
                try:
                    info = _regular_file_snapshot_info_at(
                        descriptor,
                        opened_directory,
                        name,
                    )
                    content, info, _ = _read_regular_file_snapshot_at(
                        descriptor,
                        opened_directory,
                        name,
                        max_bytes=self.max_lease_metadata_bytes,
                    )
                    lease = self._deserialize_lease(content, digest)
                except (UnicodeError, ValueError, TypeError, json.JSONDecodeError):
                    if info is not None and self._lease_snapshot_is_expired(
                        info,
                        lease_expiry_seconds,
                    ):
                        continue
                    return True
                except OSError:
                    return True
                if self._lease_is_live(lease, lease_expiry_seconds):
                    return True
            return False
        finally:
            if descriptor is not None:
                os.close(descriptor)

    @_guarded_cache_operation(preflight=_validate_stale_lease_cleanup)
    def cleanup_stale_leases(self, *, lease_expiry_seconds: int = 120) -> int:
        validate_nonnegative_safe_integer(lease_expiry_seconds, "lease_expiry_seconds")
        leases_root = self.namespace / "leases"
        scan_budget = _ScanBudget(self.max_scan_entries)
        if not _regular_directory(leases_root):
            self._cleanup_coordination_state(
                scan_budget=scan_budget,
                lease_expiry_seconds=lease_expiry_seconds,
            )
            return 0
        root_descriptor: int | None = None
        removed = 0
        try:
            relative = leases_root.relative_to(self.root)
            root_descriptor, opened_root = _open_directory_chain(self.root, relative.parts)
            directory_names = _bounded_directory_names(
                root_descriptor,
                opened_root,
                max_entries=self.max_scan_entries,
                scan_budget=scan_budget,
            )
            for directory_name in directory_names:
                digest = f"sha256:{directory_name}"
                if _DIGEST_PATTERN.fullmatch(digest) is None:
                    continue
                directory = opened_root / directory_name
                descriptor: int | None = None
                claim: _EvictionClaim | None = None
                try:
                    try:
                        claim = self._acquire_eviction_claim(digest)
                        descriptor = _open_directory(directory, root_descriptor)
                        names = _bounded_directory_names(
                            descriptor,
                            directory,
                            max_entries=self.max_scan_entries,
                            scan_budget=scan_budget,
                        )
                    except (OSError, ValueError):
                        continue
                    for name in names:
                        if name.startswith(".") or not name.endswith(".json"):
                            continue
                        content: bytes | None = None
                        info: os.stat_result | None = None
                        try:
                            info = _regular_file_snapshot_info_at(
                                descriptor,
                                directory,
                                name,
                            )
                            content, info, _ = _read_regular_file_snapshot_at(
                                descriptor,
                                directory,
                                name,
                                max_bytes=self.max_lease_metadata_bytes,
                            )
                            lease = self._deserialize_lease(content, digest)
                            ordinary_lease = self._lease_path(lease).name == name
                            if self._lease_is_live(lease, lease_expiry_seconds):
                                continue
                            if not _entry_matches_snapshot(
                                descriptor,
                                directory,
                                name,
                                content=content,
                                identity=_identity(info),
                                max_bytes=self.max_lease_metadata_bytes,
                            ):
                                continue
                            if ordinary_lease:
                                try:
                                    self._record_lease_generation(
                                        descriptor,
                                        directory,
                                        max(lease.created_at, lease.renewed_at),
                                        scan_budget=scan_budget,
                                    )
                                except (
                                    OSError,
                                    ValueError,
                                    CacheConfigurationError,
                                    CacheCorruptError,
                                ):
                                    continue
                            _unlink_at(descriptor, directory, name)
                            self._remove_process_registration_if_unused(
                                lease.digest,
                                lease.pid,
                                lease.process_nonce,
                            )
                            removed += 1
                        except (UnicodeError, ValueError, TypeError, json.JSONDecodeError):
                            if (
                                info is not None
                                and self._lease_snapshot_is_expired(
                                    info,
                                    lease_expiry_seconds,
                                )
                                and (
                                    _entry_matches_snapshot(
                                        descriptor,
                                        directory,
                                        name,
                                        content=content,
                                        identity=_identity(info),
                                        max_bytes=self.max_lease_metadata_bytes,
                                    )
                                    if content is not None
                                    else _entry_matches_generation(
                                        descriptor,
                                        directory,
                                        name,
                                        info,
                                    )
                                )
                            ):
                                _unlink_at(descriptor, directory, name)
                                removed += 1
                        except OSError:
                            continue
                    self._cleanup_orphan_lease_generation(
                        descriptor,
                        directory,
                        names,
                        scan_budget=scan_budget,
                    )
                finally:
                    try:
                        if descriptor is not None:
                            os.close(descriptor)
                    finally:
                        if claim is not None:
                            self._release_eviction_claim(claim)
                    try:
                        directory.rmdir()
                    except (FileNotFoundError, OSError):
                        pass
        except (OSError, ValueError):
            pass
        finally:
            if root_descriptor is not None:
                os.close(root_descriptor)
        self._cleanup_coordination_state(
            scan_budget=scan_budget,
            lease_expiry_seconds=lease_expiry_seconds,
        )
        return removed

    def _cleanup_orphan_lease_generation(
        self,
        descriptor: int | None,
        directory: Path,
        observed_names: list[str],
        *,
        scan_budget: _ScanBudget,
    ) -> None:
        for name in observed_names:
            if name in {_LEASE_GENERATION_NAME, _EVICTION_CLAIM_NAME}:
                continue
            try:
                if descriptor is not None and os.stat in os.supports_dir_fd:
                    os.stat(name, dir_fd=descriptor, follow_symlinks=False)
                else:
                    (directory / name).lstat()
                return
            except FileNotFoundError:
                continue
        try:
            content, info, _ = _read_regular_file_snapshot_at(
                descriptor,
                directory,
                _LEASE_GENERATION_NAME,
                max_bytes=self._claim_metadata_limit(),
            )
            value: Any = _parse_cache_json(content)
            if (
                not isinstance(value, dict)
                or set(value) != _LEASE_GENERATION_KEYS
                or value.get("schema") != "remote-skills-cache-lease-generation-v1"
                or value.get("coordination_version") != CACHE_COORDINATION_VERSION
            ):
                return
            _parse_timestamp(value.get("generation"))
            current_names = _bounded_directory_names(
                descriptor,
                directory,
                max_entries=self.max_scan_entries,
                scan_budget=scan_budget,
            )
            if any(
                name not in {_LEASE_GENERATION_NAME, _EVICTION_CLAIM_NAME}
                for name in current_names
            ):
                return
            if _entry_matches_snapshot(
                descriptor,
                directory,
                _LEASE_GENERATION_NAME,
                content=content,
                identity=_identity(info),
                max_bytes=self._claim_metadata_limit(),
            ):
                _unlink_at(descriptor, directory, _LEASE_GENERATION_NAME)
        except (FileNotFoundError, OSError, UnicodeError, ValueError, TypeError):
            return

    def _lease_snapshot_is_expired(
        self,
        info: os.stat_result,
        lease_expiry_seconds: int,
    ) -> bool:
        return self._now().timestamp() - info.st_mtime > lease_expiry_seconds

    def _cleanup_catalog_temporary_at(
        self,
        temporary_chain: _AnchoredDirectory,
        name: str,
        info: os.stat_result,
        identifier: str,
        *,
        scan_budget: _ScanBudget,
    ) -> bool:
        if not stat.S_ISDIR(info.st_mode):
            return False
        with self._catalog_mutation_guard_identifier(identifier):
            current = os.stat(
                name,
                dir_fd=temporary_chain.descriptor,
                follow_symlinks=False,
            )
            if _identity(current) != _identity(info):
                return False
            temporary_chain.validate()
            _remove_tree_at(
                temporary_chain.descriptor,
                temporary_chain.path,
                name,
                expected_identity=_identity(info),
                max_entries=self.max_scan_entries,
                max_depth=self.max_path_depth,
                scan_budget=scan_budget,
            )
            return True

    def _windows_cleanup_catalog_temporary(
        self,
        path: Path,
        info: os.stat_result,
        identifier: str,
        *,
        scan_budget: _ScanBudget,
    ) -> bool:
        if not stat.S_ISDIR(info.st_mode):
            return False
        with self._catalog_mutation_guard_identifier(identifier):
            current = path.lstat()
            if _identity(current) != _identity(info):
                return False
            _windows_remove_tree_path(
                path,
                expected_identity=_identity(info),
                max_entries=self.max_scan_entries,
                max_depth=self.max_path_depth,
                scan_budget=scan_budget,
            )
            return True

    def _remove_empty_catalog_generation_parent(self, identifier: str) -> None:
        generation_root = self._catalog_generation_directory(create=False)
        origin_parent = generation_root / identifier
        if not os.path.lexists(origin_parent):
            return
        try:
            if _windows_mode():
                with _windows_directory_chain(
                    self.root,
                    generation_root.relative_to(self.root).parts,
                ) as generation_chain:
                    info = origin_parent.lstat()
                    if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
                        raise ValueError("catalog generation parent")
                    generation_chain.validate()
                    origin_parent.rmdir()
                    generation_chain.validate()
                return
            with _anchored_directory_chain(
                self.root,
                generation_root.relative_to(self.root).parts,
            ) as generation_chain:
                info = os.stat(
                    identifier,
                    dir_fd=generation_chain.descriptor,
                    follow_symlinks=False,
                )
                if not stat.S_ISDIR(info.st_mode):
                    raise ValueError("catalog generation parent")
                generation_chain.validate()
                os.rmdir(identifier, dir_fd=generation_chain.descriptor)
                _sync_directory_descriptor(generation_chain.descriptor)
                generation_chain.validate()
        except FileNotFoundError:
            return
        except OSError as error:
            if error.errno in {ENOTEMPTY, EEXIST}:
                return
            raise

    def _cleanup_catalog_previous_generation(
        self,
        identifier: str,
        *,
        scan_budget: _ScanBudget,
        already_guarded: bool = False,
    ) -> None:
        guard = (
            nullcontext()
            if already_guarded
            else self._catalog_mutation_guard_identifier(identifier)
        )
        with guard:
            generation_root = self._catalog_generation_directory(create=False)
            previous_parent = generation_root / identifier
            previous = previous_parent / "previous"
            if not os.path.lexists(previous):
                self._remove_empty_catalog_generation_parent(identifier)
                return
            previous_catalog, previous_identity = (
                self._read_catalog_generation_snapshot(
                    previous,
                    identifier,
                    scan_budget=scan_budget,
                )
            )
            current = self.catalog_path(
                previous_catalog.metadata.canonical_url,
                confirmed_scope=previous_catalog.metadata.confirmed_scope,
            )
            if not os.path.lexists(current):
                self._advance_catalog_epoch()
                catalog_parent = self._ensure_cache_directory("catalogs")
                if _windows_mode():
                    with (
                        _windows_directory_chain(
                            self.root,
                            previous_parent.relative_to(self.root).parts,
                        ) as previous_chain,
                        _windows_directory_chain(
                            self.root,
                            catalog_parent.relative_to(self.root).parts,
                        ) as catalog_chain,
                    ):
                        if os.path.lexists(current):
                            return
                        current_previous = previous.lstat()
                        if (
                            not stat.S_ISDIR(current_previous.st_mode)
                            or stat.S_ISLNK(current_previous.st_mode)
                            or _identity(current_previous) != previous_identity
                        ):
                            raise ValueError("catalog generation")
                        previous_chain.validate()
                        catalog_chain.validate()
                        os.rename(previous, current)
                        previous_chain.validate()
                        catalog_chain.validate()
                else:
                    _require_descriptor_mutation()
                    with (
                        _anchored_directory_chain(
                            self.root,
                            previous_parent.relative_to(self.root).parts,
                        ) as previous_chain,
                        _anchored_directory_chain(
                            self.root,
                            catalog_parent.relative_to(self.root).parts,
                        ) as catalog_chain,
                    ):
                        try:
                            os.stat(
                                identifier,
                                dir_fd=catalog_chain.descriptor,
                                follow_symlinks=False,
                            )
                        except FileNotFoundError:
                            pass
                        else:
                            return
                        current_previous = os.stat(
                            "previous",
                            dir_fd=previous_chain.descriptor,
                            follow_symlinks=False,
                        )
                        if (
                            not stat.S_ISDIR(current_previous.st_mode)
                            or _identity(current_previous) != previous_identity
                        ):
                            raise ValueError("catalog generation")
                        previous_chain.validate()
                        catalog_chain.validate()
                        os.rename(
                            "previous",
                            identifier,
                            src_dir_fd=previous_chain.descriptor,
                            dst_dir_fd=catalog_chain.descriptor,
                        )
                        _sync_directory_descriptor(previous_chain.descriptor)
                        _sync_directory_descriptor(catalog_chain.descriptor)
                        previous_chain.validate()
                        catalog_chain.validate()
                self._read_catalog_generation_snapshot(
                    current,
                    identifier,
                    scan_budget=scan_budget,
                )
                self._remove_empty_catalog_generation_parent(identifier)
                return

            current_catalog, _current_identity = (
                self._read_catalog_generation_snapshot(
                    current,
                    identifier,
                    scan_budget=scan_budget,
                )
            )
            current_freshness = (
                current_catalog.metadata.validated_at,
                current_catalog.metadata.retrieved_at,
            )
            previous_freshness = (
                previous_catalog.metadata.validated_at,
                previous_catalog.metadata.retrieved_at,
            )
            if current_freshness < previous_freshness:
                return
            self._advance_catalog_epoch()
            if _windows_mode():
                with _windows_directory_chain(
                    self.root,
                    previous_parent.relative_to(self.root).parts,
                ) as previous_chain:
                    current_previous = previous.lstat()
                    if (
                        not stat.S_ISDIR(current_previous.st_mode)
                        or stat.S_ISLNK(current_previous.st_mode)
                        or _identity(current_previous) != previous_identity
                    ):
                        raise ValueError("catalog generation")
                    previous_chain.validate()
                    _windows_remove_tree_path(
                        previous,
                        expected_identity=previous_identity,
                        max_entries=self.max_scan_entries,
                        max_depth=self.max_path_depth,
                        scan_budget=scan_budget,
                    )
                    previous_chain.validate()
            else:
                with _anchored_directory_chain(
                    self.root,
                    previous_parent.relative_to(self.root).parts,
                ) as previous_chain:
                    current_previous = os.stat(
                        "previous",
                        dir_fd=previous_chain.descriptor,
                        follow_symlinks=False,
                    )
                    if (
                        not stat.S_ISDIR(current_previous.st_mode)
                        or _identity(current_previous) != previous_identity
                    ):
                        raise ValueError("catalog generation")
                    previous_chain.validate()
                    _remove_tree_at(
                        previous_chain.descriptor,
                        previous_chain.path,
                        "previous",
                        expected_identity=previous_identity,
                        max_entries=self.max_scan_entries,
                        max_depth=self.max_path_depth,
                        scan_budget=scan_budget,
                    )
                    previous_chain.validate()
            self._remove_empty_catalog_generation_parent(identifier)

    def _cleanup_catalog_previous_generations(
        self,
        *,
        scan_budget: _ScanBudget,
    ) -> None:
        generation_root = self._catalog_generation_directory(create=False)
        if not os.path.lexists(generation_root):
            return
        try:
            context = (
                _windows_directory_chain(
                    self.root,
                    generation_root.relative_to(self.root).parts,
                )
                if _windows_mode()
                else _anchored_directory_chain(
                    self.root,
                    generation_root.relative_to(self.root).parts,
                )
            )
            with context as generation_chain:
                names = _bounded_directory_names(
                    getattr(generation_chain, "descriptor", None),
                    generation_chain.path,
                    max_entries=self.max_scan_entries,
                    scan_budget=scan_budget,
                )
                generation_chain.validate()
                identifiers: list[str] = []
                for name in names:
                    if name == _CATALOG_GENERATION_STATE_NAME:
                        continue
                    if _CATALOG_IDENTIFIER_PATTERN.fullmatch(name) is None:
                        continue
                    info = (
                        (generation_chain.path / name).lstat()
                        if _windows_mode()
                        else os.stat(
                            name,
                            dir_fd=generation_chain.descriptor,
                            follow_symlinks=False,
                        )
                    )
                    if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
                        raise ValueError("catalog generation parent")
                    identifiers.append(name)
                generation_chain.validate()
            for identifier in identifiers:
                self._cleanup_catalog_previous_generation(
                    identifier,
                    scan_budget=scan_budget,
                )
        except CacheCorruptError:
            raise
        except (OSError, UnicodeError, ValueError, TypeError) as error:
            raise CacheCorruptError() from error

    @_guarded_cache_operation(preflight=_validate_stale_temporary_cleanup)
    def cleanup_stale_temporaries(self, *, max_age_seconds: int) -> int:
        validate_nonnegative_safe_integer(max_age_seconds, "max_age_seconds")
        temporary_root = self.namespace / "tmp"
        if not _regular_directory(temporary_root):
            return 0
        removed = 0
        now = self._now().timestamp()
        scan_budget = _ScanBudget(self.max_scan_entries)
        self._cleanup_catalog_previous_generations(scan_budget=scan_budget)
        if _windows_mode():
            removed = self._windows_cleanup_stale_temporaries(
                temporary_root,
                now=now,
                max_age_seconds=max_age_seconds,
                scan_budget=scan_budget,
            )
            self._cleanup_coordination_state(
                scan_budget=scan_budget,
                lease_expiry_seconds=self.lease_expiry_seconds,
            )
            return removed
        try:
            _require_descriptor_mutation()
            with _anchored_directory_chain(
                self.root,
                temporary_root.relative_to(self.root).parts,
            ) as temporary_chain:
                names = _bounded_directory_names(
                    temporary_chain.descriptor,
                    temporary_chain.path,
                    max_entries=self.max_scan_entries,
                    scan_budget=scan_budget,
                )
                temporary_chain.validate()
                for name in names:
                    if name in {"coordination-v1", "catalog-generations-v1"}:
                        continue
                    try:
                        info = os.stat(
                            name,
                            dir_fd=temporary_chain.descriptor,
                            follow_symlinks=False,
                        )
                        if (
                            stat.S_ISLNK(info.st_mode)
                            or now - info.st_mtime <= max_age_seconds
                        ):
                            continue
                        is_catalog_temporary = name.startswith(
                            (
                                "catalog-",
                                "catalog-python-",
                                "catalog-old-",
                                "evict-catalog-",
                            )
                        )
                        if is_catalog_temporary:
                            identifier = _catalog_temporary_identifier(name)
                            if identifier is None:
                                continue
                            if self._cleanup_catalog_temporary_at(
                                temporary_chain,
                                name,
                                info,
                                identifier,
                                scan_budget=scan_budget,
                            ):
                                removed += 1
                            continue
                        temporary_chain.validate()
                        if stat.S_ISDIR(info.st_mode):
                            writer: tuple[int, str, str] | None = None
                            if self._temporary_has_live_claim(name):
                                continue
                            candidate_descriptor = _open_directory_entry_at(
                                temporary_chain.descriptor,
                                name,
                            )
                            try:
                                writer = self._temporary_writer(
                                    candidate_descriptor,
                                    temporary_chain.path / name,
                                )
                            finally:
                                os.close(candidate_descriptor)
                            if writer is not None:
                                pid, process_nonce, writer_digest = writer
                                if self._registered_process_is_alive(
                                    pid,
                                    process_nonce,
                                    writer_digest,
                                ):
                                    continue
                            temporary_chain.validate()
                            _remove_tree_at(
                                temporary_chain.descriptor,
                                temporary_chain.path,
                                name,
                                expected_identity=_identity(info),
                                max_entries=self.max_scan_entries,
                                max_depth=self.max_path_depth,
                                scan_budget=scan_budget,
                            )
                            if writer is not None:
                                self._remove_process_registration_if_unused(
                                    writer[2], writer[0], writer[1]
                                )
                        elif stat.S_ISREG(info.st_mode):
                            with _locked_regular_file_at(
                                temporary_chain.descriptor,
                                temporary_chain.path,
                                name,
                            ) as (file_descriptor, _):
                                if not _entry_matches_descriptor(
                                    temporary_chain.descriptor,
                                    temporary_chain.path,
                                    name,
                                    file_descriptor,
                                ):
                                    continue
                                temporary_chain.validate()
                                _unlink_at(
                                    temporary_chain.descriptor,
                                    temporary_chain.path,
                                    name,
                                )
                        else:
                            continue
                        removed += 1
                    except (FileNotFoundError, OSError, ValueError):
                        continue
        except (OSError, ValueError, CacheCorruptError):
            pass
        self._cleanup_coordination_state(
            scan_budget=scan_budget,
            lease_expiry_seconds=self.lease_expiry_seconds,
        )
        return removed

    def _cleanup_coordination_state(
        self,
        *,
        scan_budget: _ScanBudget,
        lease_expiry_seconds: int,
    ) -> None:
        self._cleanup_coordination_locks(
            scan_budget=scan_budget,
            lease_expiry_seconds=lease_expiry_seconds,
        )
        processes_root = self._coordination_directory() / "processes"
        if not _regular_directory(processes_root):
            for directory in (
                processes_root,
                self._coordination_directory() / "locks",
                self._coordination_directory(),
            ):
                try:
                    directory.rmdir()
                except (FileNotFoundError, OSError):
                    pass
            return
        root_descriptor: int | None = None
        try:
            root_descriptor, opened_root = _open_directory_chain(
                self.root,
                processes_root.relative_to(self.root).parts,
            )
            digest_names = _bounded_directory_names(
                root_descriptor,
                opened_root,
                max_entries=self.max_scan_entries,
                scan_budget=scan_budget,
            )
            for digest_name in digest_names:
                digest = f"sha256:{digest_name}"
                if _DIGEST_PATTERN.fullmatch(digest) is None:
                    continue
                directory = opened_root / digest_name
                descriptor: int | None = None
                try:
                    descriptor = _open_directory(directory, root_descriptor)
                    names = _bounded_directory_names(
                        descriptor,
                        directory,
                        max_entries=self.max_scan_entries,
                        scan_budget=scan_budget,
                    )
                    for name in names:
                        if re.fullmatch(r"[A-Za-z0-9._-]+\.json", name) is None:
                            continue
                        try:
                            content, info, _ = _read_regular_file_snapshot_at(
                                descriptor,
                                directory,
                                name,
                                max_bytes=self.max_lease_metadata_bytes,
                            )
                            value: Any = _parse_cache_json(content)
                            if (
                                not isinstance(value, dict)
                                or value.get("schema")
                                != "remote-skills-cache-process-registration-v1"
                            ):
                                continue
                            pid = value.get("pid")
                            process_nonce = value.get("process_nonce")
                            if (
                                not isinstance(pid, int)
                                or isinstance(pid, bool)
                                or pid <= 0
                                or pid > MAX_SAFE_INTEGER
                                or not isinstance(process_nonce, str)
                                or name != f"{process_nonce}.json"
                            ):
                                continue
                            self._validate_nonce(process_nonce)
                            renewed = _parse_timestamp(value.get("renewed_at"))
                            if (
                                (self._now() - renewed).total_seconds()
                                <= lease_expiry_seconds
                                or self._registered_process_is_alive(
                                    pid,
                                    process_nonce,
                                    digest,
                                )
                            ):
                                continue
                            if _entry_matches_snapshot(
                                descriptor,
                                directory,
                                name,
                                content=content,
                                identity=_identity(info),
                                max_bytes=self.max_lease_metadata_bytes,
                            ):
                                _unlink_at(descriptor, directory, name)
                        except (
                            FileNotFoundError,
                            OSError,
                            UnicodeError,
                            ValueError,
                            TypeError,
                            json.JSONDecodeError,
                        ):
                            continue
                except (FileNotFoundError, OSError, ValueError):
                    continue
                finally:
                    if descriptor is not None:
                        os.close(descriptor)
                try:
                    directory.rmdir()
                except (FileNotFoundError, OSError):
                    pass
        except (FileNotFoundError, OSError, ValueError):
            return
        finally:
            if root_descriptor is not None:
                os.close(root_descriptor)
        for directory in (
            processes_root,
            self._coordination_directory() / "locks",
            self._coordination_directory(),
        ):
            try:
                directory.rmdir()
            except (FileNotFoundError, OSError):
                pass

    def _cleanup_coordination_locks(
        self,
        *,
        scan_budget: _ScanBudget,
        lease_expiry_seconds: int,
    ) -> None:
        del lease_expiry_seconds
        locks_root = self._coordination_directory() / "locks"
        if not _regular_directory(locks_root):
            return
        descriptor: int | None = None
        try:
            descriptor, opened_root = _open_directory_chain(
                self.root,
                locks_root.relative_to(self.root).parts,
            )
            names = _bounded_directory_names(
                descriptor,
                opened_root,
                max_entries=self.max_scan_entries,
                scan_budget=scan_budget,
            )
            for name in names:
                if re.fullmatch(r"[0-9a-f]{64}", name) is None:
                    continue
                digest = f"sha256:{name}"
                digest_descriptor: int | None = None
                try:
                    digest_descriptor, directory = self._open_mutation_gate_directory(
                        digest,
                        create=False,
                    )
                    records = _bounded_directory_names(
                        digest_descriptor,
                        directory,
                        max_entries=self.max_scan_entries,
                        scan_budget=scan_budget,
                    )
                    for record in records:
                        if record.endswith((".intent", ".lock", ".tmp")):
                            self._reclaim_mutation_gate_record(digest, record)
                except (FileNotFoundError, OSError, ValueError):
                    continue
                finally:
                    if digest_descriptor is not None:
                        os.close(digest_descriptor)
                try:
                    self._mutation_gate_digest_directory(digest).rmdir()
                except (FileNotFoundError, OSError):
                    pass
        except (FileNotFoundError, OSError, ValueError):
            return
        finally:
            if descriptor is not None:
                os.close(descriptor)
        try:
            locks_root.rmdir()
        except (FileNotFoundError, OSError):
            pass

    def _windows_cleanup_stale_temporaries(
        self,
        temporary_root: Path,
        *,
        now: float,
        max_age_seconds: int,
        scan_budget: _ScanBudget,
    ) -> int:
        removed = 0
        try:
            with _windows_directory_chain(
                self.root,
                temporary_root.relative_to(self.root).parts,
            ) as temporary_chain:
                names = _bounded_directory_names(
                    None,
                    temporary_root,
                    max_entries=self.max_scan_entries,
                    scan_budget=scan_budget,
                )
                temporary_chain.validate()
                for name in names:
                    if name in {"coordination-v1", "catalog-generations-v1"}:
                        continue
                    path = temporary_root / name
                    try:
                        info = path.lstat()
                        if (
                            stat.S_ISLNK(info.st_mode)
                            or now - info.st_mtime <= max_age_seconds
                        ):
                            continue
                        is_catalog_temporary = name.startswith(
                            (
                                "catalog-",
                                "catalog-python-",
                                "catalog-old-",
                                "evict-catalog-",
                            )
                        )
                        if is_catalog_temporary:
                            identifier = _catalog_temporary_identifier(name)
                            if identifier is None:
                                continue
                            if self._windows_cleanup_catalog_temporary(
                                path,
                                info,
                                identifier,
                                scan_budget=scan_budget,
                            ):
                                removed += 1
                            continue
                        temporary_chain.validate()
                        if stat.S_ISDIR(info.st_mode):
                            writer: tuple[int, str, str] | None = None
                            if self._temporary_has_live_claim(name):
                                continue
                            writer = self._temporary_writer(None, path)
                            if writer is not None:
                                pid, process_nonce, writer_digest = writer
                                if self._registered_process_is_alive(
                                    pid,
                                    process_nonce,
                                    writer_digest,
                                ):
                                    continue
                            _windows_remove_tree_path(
                                path,
                                expected_identity=_identity(info),
                                max_entries=self.max_scan_entries,
                                max_depth=self.max_path_depth,
                                scan_budget=scan_budget,
                            )
                            if writer is not None:
                                self._remove_process_registration_if_unused(
                                    writer[2], writer[0], writer[1]
                                )
                        elif stat.S_ISREG(info.st_mode):
                            with _locked_regular_file_at(
                                None,
                                temporary_root,
                                name,
                            ) as (file_descriptor, _):
                                if not _entry_matches_descriptor(
                                    None,
                                    temporary_root,
                                    name,
                                    file_descriptor,
                                ):
                                    continue
                                path.unlink()
                        else:
                            continue
                        removed += 1
                    except (FileNotFoundError, OSError, ValueError):
                        continue
        except (OSError, ValueError):
            return removed
        return removed

    def _temporary_has_live_claim(self, name: str) -> bool:
        match = re.fullmatch(r"evict-([0-9a-f]{64})-[0-9a-f]+", name)
        if match is None:
            return False
        digest = f"sha256:{match.group(1)}"
        if not self._eviction_claim_exists(digest):
            return False
        return not self._reclaim_stale_eviction_claim(digest)

    def _temporary_writer(
        self,
        directory_descriptor: int | None,
        directory: Path,
    ) -> tuple[int, str, str] | None:
        try:
            value: Any = _parse_cache_json(
                _read_regular_file(
                    directory_descriptor,
                    directory,
                    "writer.json",
                    max_bytes=self.max_object_metadata_bytes,
                )
            )
        except FileNotFoundError:
            return None
        except (OSError, UnicodeError, ValueError, TypeError, json.JSONDecodeError):
            return None
        if not isinstance(value, dict):
            return None
        pid = value.get("pid")
        process_nonce = value.get("process_nonce")
        digest = value.get("expected_digest")
        if (
            not isinstance(pid, int)
            or isinstance(pid, bool)
            or pid <= 0
            or pid > MAX_SAFE_INTEGER
        ):
            return None
        try:
            process_nonce = self._validate_nonce(process_nonce)
            digest = validate_digest(digest)
        except (CacheConfigurationError, ValueError):
            return None
        return pid, process_nonce, digest

    def _remove_lease_records_for_evicted_object(
        self,
        digest: str,
        *,
        lease_expiry_seconds: int,
        scan_budget: _ScanBudget | None = None,
    ) -> None:
        descriptor: int | None = None
        try:
            descriptor, directory = self._open_lease_directory(digest, create=False)
            names = _bounded_directory_names(
                descriptor,
                directory,
                max_entries=self.max_scan_entries,
                scan_budget=scan_budget,
            )
            for name in names:
                if name.startswith(".") or not name.endswith(".json"):
                    continue
                content: bytes | None = None
                info: os.stat_result | None = None
                try:
                    info = _regular_file_snapshot_info_at(
                        descriptor,
                        directory,
                        name,
                    )
                    content, info, _ = _read_regular_file_snapshot_at(
                        descriptor,
                        directory,
                        name,
                        max_bytes=self.max_lease_metadata_bytes,
                    )
                    self._deserialize_lease(content, digest)
                    if _entry_matches_snapshot(
                        descriptor,
                        directory,
                        name,
                        content=content,
                        identity=_identity(info),
                        max_bytes=self.max_lease_metadata_bytes,
                    ):
                        _unlink_at(descriptor, directory, name)
                except (UnicodeError, ValueError, TypeError, json.JSONDecodeError):
                    if (
                        info is not None
                        and self._lease_snapshot_is_expired(
                            info,
                            lease_expiry_seconds,
                        )
                        and (
                            _entry_matches_snapshot(
                                descriptor,
                                directory,
                                name,
                                content=content,
                                identity=_identity(info),
                                max_bytes=self.max_lease_metadata_bytes,
                            )
                            if content is not None
                            else _entry_matches_generation(
                                descriptor,
                                directory,
                                name,
                                info,
                            )
                        )
                    ):
                        _unlink_at(descriptor, directory, name)
                except (FileNotFoundError, OSError):
                    continue
            try:
                _unlink_at(descriptor, directory, _LEASE_GENERATION_NAME)
            except FileNotFoundError:
                pass
        except FileNotFoundError:
            return
        finally:
            if descriptor is not None:
                os.close(descriptor)
        try:
            directory.rmdir()
        except (FileNotFoundError, OSError):
            pass

    @_guarded_cache_operation(preflight=_validate_eviction_limits)
    def evict(
        self,
        *,
        max_bytes: int,
        max_age_seconds: int,
        lease_expiry_seconds: int = 120,
    ) -> EvictionResult:
        validate_nonnegative_safe_integer(max_bytes, "max_bytes")
        validate_nonnegative_safe_integer(max_age_seconds, "max_age_seconds")
        validate_nonnegative_safe_integer(lease_expiry_seconds, "lease_expiry_seconds")
        self._write_eviction_metadata(max_bytes=max_bytes, max_age_seconds=max_age_seconds)
        scan_budget = _ScanBudget(self.max_scan_entries)
        try:
            candidates = self._eviction_candidates(scan_budget=scan_budget)
        except (OSError, ValueError):
            raise CacheCorruptError() from None
        bytes_before = sum(candidate.size for candidate in candidates)
        remaining = bytes_before
        removed: list[str] = []
        pinned: list[str] = []
        now = self._now()
        for candidate in candidates:
            expired = (now - candidate.accessed_at).total_seconds() > max_age_seconds
            if not expired and remaining <= max_bytes:
                continue
            if candidate.kind == "catalog":
                with self._catalog_mutation_guard_identifier(candidate.identifier):
                    self._advance_catalog_epoch()
                    if (
                        self._windows_evict_catalog_candidate(
                            candidate,
                            scan_budget=scan_budget,
                        )
                        if _windows_mode()
                        else self._evict_catalog_candidate(
                            candidate,
                            scan_budget=scan_budget,
                        )
                    ):
                        remaining -= candidate.size
                continue
            digest = candidate.digest
            if digest is None:
                raise CacheCorruptError()
            path = candidate.path
            claim = self._acquire_eviction_claim(digest, operation="evict")
            try:
                if self._has_live_lease(
                    digest,
                    lease_expiry_seconds=lease_expiry_seconds,
                    ignore_eviction_claim=True,
                    scan_budget=scan_budget,
                ):
                    pinned.append(digest)
                    continue
                if _windows_mode():
                    removed_on_windows, pinned_on_windows = self._windows_evict_object_candidate(
                        candidate,
                        lease_expiry_seconds=lease_expiry_seconds,
                        scan_budget=scan_budget,
                    )
                    if pinned_on_windows:
                        pinned.append(digest)
                    if removed_on_windows:
                        removed.append(digest)
                        remaining -= candidate.size
                    continue
                quarantine_root = self._ensure_cache_directory("tmp", expected_digest=digest)
                _require_descriptor_mutation(digest)
                source_parts = path.parent.relative_to(self.root).parts
                quarantine_parts = quarantine_root.relative_to(self.root).parts
                quarantine_name = f"evict-{digest[7:]}-{secrets.token_hex(16)}"
                with (
                    _anchored_directory_chain(self.root, source_parts) as source_chain,
                    _anchored_directory_chain(self.root, quarantine_parts) as quarantine_chain,
                ):
                    object_descriptor = _open_directory_entry_at(
                        source_chain.descriptor,
                        path.name,
                    )
                    moved = False
                    try:
                        object_identity = _identity(os.fstat(object_descriptor))
                        if object_identity != candidate.identity:
                            continue
                        source_chain.validate()
                        quarantine_chain.validate()
                        os.rename(
                            path.name,
                            quarantine_name,
                            src_dir_fd=source_chain.descriptor,
                            dst_dir_fd=quarantine_chain.descriptor,
                        )
                        moved = True
                        try:
                            source_chain.validate()
                            quarantine_chain.validate()
                        except (OSError, ValueError):
                            os.rename(
                                quarantine_name,
                                path.name,
                                src_dir_fd=quarantine_chain.descriptor,
                                dst_dir_fd=source_chain.descriptor,
                            )
                            moved = False
                            raise
                        quarantine_descriptor = _open_directory_entry_at(
                            quarantine_chain.descriptor,
                            quarantine_name,
                        )
                        try:
                            if _identity(os.fstat(quarantine_descriptor)) != object_identity:
                                raise ValueError("eviction object generation")
                        finally:
                            os.close(quarantine_descriptor)
                        if self._has_live_lease(
                            digest,
                            lease_expiry_seconds=lease_expiry_seconds,
                            ignore_eviction_claim=True,
                            scan_budget=scan_budget,
                        ):
                            os.rename(
                                quarantine_name,
                                path.name,
                                src_dir_fd=quarantine_chain.descriptor,
                                dst_dir_fd=source_chain.descriptor,
                            )
                            moved = False
                            pinned.append(digest)
                            continue
                        _remove_tree_at(
                            quarantine_chain.descriptor,
                            quarantine_chain.path,
                            quarantine_name,
                            expected_identity=object_identity,
                            max_entries=self.max_scan_entries,
                            max_depth=self.max_path_depth,
                            scan_budget=scan_budget,
                        )
                        moved = False
                        self._remove_lease_records_for_evicted_object(
                            digest,
                            lease_expiry_seconds=lease_expiry_seconds,
                            scan_budget=scan_budget,
                        )
                        removed.append(digest)
                        remaining -= candidate.size
                    except (OSError, ValueError) as error:
                        if moved:
                            try:
                                os.rename(
                                    quarantine_name,
                                    path.name,
                                    src_dir_fd=quarantine_chain.descriptor,
                                    dst_dir_fd=source_chain.descriptor,
                                )
                            except OSError:
                                pass
                        raise CacheCorruptError(digest) from error
                    finally:
                        os.close(object_descriptor)
            finally:
                self._release_eviction_claim(claim)
        try:
            bytes_after = sum(
                candidate.size
                for candidate in self._eviction_candidates(scan_budget=scan_budget)
            )
        except (OSError, ValueError):
            raise CacheCorruptError() from None
        return EvictionResult(
            removed_digests=tuple(removed),
            retained_pinned=tuple(dict.fromkeys(pinned)),
            bytes_before=bytes_before,
            bytes_after=bytes_after,
        )

    def _eviction_candidates(
        self,
        *,
        scan_budget: _ScanBudget | None = None,
    ) -> list[_EvictionCandidate]:
        candidates: list[_EvictionCandidate] = []
        object_root = self.namespace / "objects" / "sha256"
        if os.path.lexists(object_root):
            if not _regular_directory(object_root):
                raise CacheCorruptError()
            prefix_names = _bounded_directory_names(
                None,
                object_root,
                max_entries=self.max_scan_entries,
                scan_budget=scan_budget,
            )
            for prefix_name in prefix_names:
                prefix = object_root / prefix_name
                if re.fullmatch(r"[0-9a-f]{2}", prefix_name) is None:
                    continue
                if not _regular_directory(prefix):
                    raise CacheCorruptError()
                object_names = _bounded_directory_names(
                    None,
                    prefix,
                    max_entries=self.max_scan_entries,
                    scan_budget=scan_budget,
                )
                for object_name in object_names:
                    path = prefix / object_name
                    value = f"{prefix.name}{path.name}"
                    digest = f"sha256:{value}"
                    if _DIGEST_PATTERN.fullmatch(digest) is None:
                        continue
                    if not _regular_directory(path):
                        raise CacheCorruptError(digest)
                    descriptor: int | None = None
                    try:
                        relative = path.relative_to(self.root)
                        descriptor, opened_path = _open_directory_chain(self.root, relative.parts)
                        metadata, expected_sizes = self._read_object_metadata(
                            descriptor,
                            opened_path,
                            digest,
                        )
                        root_sizes = _root_file_sizes(
                            descriptor,
                            opened_path,
                            expected_sizes=expected_sizes,
                            max_files=self.max_files_per_object,
                            max_depth=self.max_path_depth,
                            max_file_bytes=self.max_file_bytes,
                            max_extracted_bytes=self.max_extracted_bytes,
                            max_entries=self.max_scan_entries,
                            scan_budget=scan_budget,
                        )
                        if set(root_sizes) != set(expected_sizes):
                            raise ValueError("object file table")
                        size = (
                            _regular_file_size_at(
                                descriptor,
                                opened_path,
                                "object.json",
                                max_bytes=self.max_object_metadata_bytes,
                            )
                            + _regular_file_size_at(
                                descriptor,
                                opened_path,
                                "artifact",
                                max_bytes=self.max_artifact_bytes,
                                expected_size=metadata["artifact_bytes"],
                            )
                            + sum(root_sizes.values())
                        )
                        identity = _identity(
                            os.fstat(descriptor)
                            if descriptor is not None
                            else opened_path.lstat()
                        )
                    except (
                        OSError,
                        UnicodeError,
                        ValueError,
                        TypeError,
                        json.JSONDecodeError,
                    ) as error:
                        raise CacheCorruptError(digest) from error
                    finally:
                        if descriptor is not None:
                            os.close(descriptor)
                    candidates.append(
                        _EvictionCandidate(
                            accessed_at=_parse_timestamp(metadata["accessed_at"]),
                            kind="object",
                            identifier=digest,
                            path=path,
                            size=size,
                            identity=identity,
                            digest=digest,
                        )
                    )

        catalog_root = self.namespace / "catalogs"
        if os.path.lexists(catalog_root):
            if not _regular_directory(catalog_root):
                raise CacheCorruptError()
            catalog_names = _bounded_directory_names(
                None,
                catalog_root,
                max_entries=self.max_scan_entries,
                scan_budget=scan_budget,
            )
            for catalog_name in catalog_names:
                path = catalog_root / catalog_name
                if re.fullmatch(r"[0-9a-f]{64}", path.name) is None:
                    continue
                descriptor = None
                try:
                    descriptor, opened_path = _open_directory_chain(
                        self.root,
                        path.relative_to(self.root).parts,
                    )
                    names = _bounded_directory_names(
                        descriptor,
                        opened_path,
                        max_entries=3,
                        scan_budget=scan_budget,
                    )
                    if set(names) not in (
                        {"body.json", "metadata.json"},
                        {"body.json", "metadata.json", "generation.json"},
                    ):
                        raise ValueError("catalog inventory")
                    size = _regular_file_size_at(
                        descriptor,
                        opened_path,
                        "body.json",
                        max_bytes=self.max_catalog_bytes,
                    ) + _regular_file_size_at(
                        descriptor,
                        opened_path,
                        "metadata.json",
                        max_bytes=self.max_object_metadata_bytes,
                    )
                    if "generation.json" in names:
                        size += _regular_file_size_at(
                            descriptor,
                            opened_path,
                            "generation.json",
                            max_bytes=1024,
                        )
                    info = (
                        os.fstat(descriptor)
                        if descriptor is not None
                        else opened_path.lstat()
                    )
                except (OSError, ValueError) as error:
                    raise CacheCorruptError() from error
                finally:
                    if descriptor is not None:
                        os.close(descriptor)
                candidates.append(
                    _EvictionCandidate(
                        accessed_at=datetime.fromtimestamp(info.st_mtime, timezone.utc),
                        kind="catalog",
                        identifier=path.name,
                        path=path,
                        size=size,
                        identity=_identity(info),
                    )
                )
        return sorted(
            candidates,
            key=lambda candidate: (
                candidate.accessed_at,
                candidate.kind,
                candidate.identifier,
            ),
        )

    def _windows_evict_object_candidate(
        self,
        candidate: _EvictionCandidate,
        *,
        lease_expiry_seconds: int,
        scan_budget: _ScanBudget | None = None,
    ) -> tuple[bool, bool]:
        digest = candidate.digest
        if digest is None:
            raise CacheCorruptError()
        source_parent = candidate.path.parent
        quarantine_root = self._ensure_cache_directory("tmp", expected_digest=digest)
        quarantine = quarantine_root / f"evict-{digest[7:]}-{secrets.token_hex(16)}"
        with (
            _windows_directory_chain(
                self.root,
                source_parent.relative_to(self.root).parts,
            ) as source_chain,
            _windows_directory_chain(
                self.root,
                quarantine_root.relative_to(self.root).parts,
            ) as quarantine_chain,
        ):
            if not os.path.lexists(candidate.path):
                return False, False
            current = candidate.path.lstat()
            if not stat.S_ISDIR(current.st_mode) or _identity(current) != candidate.identity:
                return False, False
            source_chain.validate()
            quarantine_chain.validate()
            moved = False
            try:
                os.rename(candidate.path, quarantine)
                moved = True
                source_chain.validate()
                quarantine_chain.validate()
                quarantined = quarantine.lstat()
                if _identity(quarantined) != candidate.identity:
                    raise ValueError("eviction object generation")
                if self._has_live_lease(
                    digest,
                    lease_expiry_seconds=lease_expiry_seconds,
                    ignore_eviction_claim=True,
                    scan_budget=scan_budget,
                ):
                    os.rename(quarantine, candidate.path)
                    moved = False
                    return False, True
                _windows_remove_tree_path(
                    quarantine,
                    expected_identity=candidate.identity,
                    max_entries=self.max_scan_entries,
                    max_depth=self.max_path_depth,
                    scan_budget=scan_budget,
                )
                moved = False
                self._remove_lease_records_for_evicted_object(
                    digest,
                    lease_expiry_seconds=lease_expiry_seconds,
                    scan_budget=scan_budget,
                )
                return True, False
            except Exception:
                if moved and os.path.lexists(quarantine) and not os.path.lexists(candidate.path):
                    os.rename(quarantine, candidate.path)
                raise

    def _windows_evict_catalog_candidate(
        self,
        candidate: _EvictionCandidate,
        *,
        scan_budget: _ScanBudget | None = None,
    ) -> bool:
        source_parent = candidate.path.parent
        quarantine_root = self._ensure_cache_directory("tmp")
        quarantine = quarantine_root / (
            f"evict-catalog-{candidate.identifier}-{secrets.token_hex(16)}"
        )
        with (
            _windows_directory_chain(
                self.root,
                source_parent.relative_to(self.root).parts,
            ) as source_chain,
            _windows_directory_chain(
                self.root,
                quarantine_root.relative_to(self.root).parts,
            ) as quarantine_chain,
        ):
            if not os.path.lexists(candidate.path):
                return False
            current = candidate.path.lstat()
            if not stat.S_ISDIR(current.st_mode) or _identity(current) != candidate.identity:
                return False
            source_chain.validate()
            quarantine_chain.validate()
            moved = False
            try:
                os.rename(candidate.path, quarantine)
                moved = True
                source_chain.validate()
                quarantine_chain.validate()
                _windows_remove_tree_path(
                    quarantine,
                    expected_identity=candidate.identity,
                    max_entries=self.max_scan_entries,
                    max_depth=self.max_path_depth,
                    scan_budget=scan_budget,
                )
                moved = False
                return True
            except Exception:
                if moved and os.path.lexists(quarantine) and not os.path.lexists(candidate.path):
                    os.rename(quarantine, candidate.path)
                raise

    def _evict_catalog_candidate(
        self,
        candidate: _EvictionCandidate,
        *,
        scan_budget: _ScanBudget | None = None,
    ) -> bool:
        catalog_parent = candidate.path.parent
        if not os.path.lexists(candidate.path):
            return False
        quarantine_root = self._ensure_cache_directory("tmp")
        _require_descriptor_mutation()
        source_parts = catalog_parent.relative_to(self.root).parts
        quarantine_parts = quarantine_root.relative_to(self.root).parts
        quarantine_name = f"evict-catalog-{candidate.identifier}-{secrets.token_hex(16)}"
        try:
            with (
                _anchored_directory_chain(self.root, source_parts) as source_chain,
                _anchored_directory_chain(self.root, quarantine_parts) as quarantine_chain,
            ):
                catalog_descriptor = _open_directory_entry_at(
                    source_chain.descriptor,
                    candidate.path.name,
                )
                moved = False
                try:
                    if _identity(os.fstat(catalog_descriptor)) != candidate.identity:
                        return False
                    os.rename(
                        candidate.path.name,
                        quarantine_name,
                        src_dir_fd=source_chain.descriptor,
                        dst_dir_fd=quarantine_chain.descriptor,
                    )
                    moved = True
                    try:
                        source_chain.validate()
                        quarantine_chain.validate()
                    except (OSError, ValueError):
                        os.rename(
                            quarantine_name,
                            candidate.path.name,
                            src_dir_fd=quarantine_chain.descriptor,
                            dst_dir_fd=source_chain.descriptor,
                        )
                        moved = False
                        raise
                    _remove_tree_at(
                        quarantine_chain.descriptor,
                        quarantine_chain.path,
                        quarantine_name,
                        expected_identity=candidate.identity,
                        max_entries=self.max_scan_entries,
                        max_depth=self.max_path_depth,
                        scan_budget=scan_budget,
                    )
                    moved = False
                    return True
                finally:
                    if moved:
                        try:
                            os.rename(
                                quarantine_name,
                                candidate.path.name,
                                src_dir_fd=quarantine_chain.descriptor,
                                dst_dir_fd=source_chain.descriptor,
                            )
                        except OSError:
                            pass
                    os.close(catalog_descriptor)
        except FileNotFoundError:
            return False
        except (OSError, ValueError) as error:
            raise CacheCorruptError() from error

    def _write_eviction_metadata(self, *, max_bytes: int, max_age_seconds: int) -> None:
        value = {
            "schema": "remote-skills-eviction-metadata-v1",
            "last_run_at": _format_timestamp(self._now()),
            "max_bytes": max_bytes,
            "max_age_seconds": max_age_seconds,
            "candidate_order": ["accessed_at", "digest"],
        }
        namespace = self._ensure_cache_directory()
        _atomic_replace_file(namespace / "eviction.json", _json_bytes(value))

    def _lease_directory(self, digest: str) -> Path:
        return self.namespace / "leases" / validate_digest(digest)[7:]

    def _open_lease_directory(
        self,
        digest: str,
        *,
        create: bool,
    ) -> tuple[int | None, Path]:
        _require_descriptor_mutation(digest)
        directory = self._lease_directory(digest)
        if create:
            self._ensure_cache_directory("leases", digest[7:], expected_digest=digest)
        relative = directory.relative_to(self.root)
        return _open_directory_chain(self.root, relative.parts)

    def _claim_path(self, digest: str) -> Path:
        return self._lease_directory(digest) / _EVICTION_CLAIM_NAME

    def _reserve_lease_generation(
        self,
        directory_descriptor: int | None,
        directory: Path,
        candidate: datetime,
    ) -> datetime:
        """Reserve one root-visible generation while the digest claim is held."""

        previous = self._read_lease_generation(
            directory_descriptor,
            directory,
        )
        if previous is None:
            previous = self._maximum_ordinary_lease_generation(
                directory_descriptor,
                directory,
            )
        selected = _canonical_lease_timestamp(candidate)
        if previous is not None and selected <= previous:
            selected = _next_lease_timestamp(selected, previous)
        self._write_lease_generation(directory_descriptor, directory, selected)
        return selected

    def _read_lease_generation(
        self,
        directory_descriptor: int | None,
        directory: Path,
    ) -> datetime | None:
        try:
            original = _read_regular_file(
                directory_descriptor,
                directory,
                _LEASE_GENERATION_NAME,
                max_bytes=self._claim_metadata_limit(),
            )
        except FileNotFoundError:
            pass
        else:
            value = _parse_cache_json(original)
            if (
                not isinstance(value, dict)
                or set(value) != _LEASE_GENERATION_KEYS
                or value["schema"] != "remote-skills-cache-lease-generation-v1"
                or value["coordination_version"] != CACHE_COORDINATION_VERSION
            ):
                raise ValueError("lease generation schema")
            return _parse_timestamp(value["generation"])
        return None

    def _maximum_ordinary_lease_generation(
        self,
        directory_descriptor: int | None,
        directory: Path,
        *,
        scan_budget: _ScanBudget | None = None,
    ) -> datetime | None:
        maximum: datetime | None = None
        for name in _bounded_directory_names(
            directory_descriptor,
            directory,
            max_entries=self.max_scan_entries,
            scan_budget=scan_budget,
        ):
            if name.startswith(".") or not name.endswith(".json"):
                continue
            try:
                lease = self._deserialize_lease(
                    _read_regular_file(
                        directory_descriptor,
                        directory,
                        name,
                        max_bytes=self.max_lease_metadata_bytes,
                    ),
                    self._digest_from_lease_directory(directory),
                )
                if self._lease_path(lease).name != name:
                    continue
            except (
                OSError,
                UnicodeError,
                ValueError,
                TypeError,
                CacheConfigurationError,
                CacheCorruptError,
            ):
                continue
            observed = max(lease.created_at, lease.renewed_at)
            maximum = observed if maximum is None else max(maximum, observed)
        return maximum

    def _digest_from_lease_directory(self, directory: Path) -> str:
        digest = f"sha256:{directory.name}"
        if _DIGEST_PATTERN.fullmatch(digest) is None:
            raise ValueError("lease digest")
        return digest

    def _record_lease_generation(
        self,
        directory_descriptor: int | None,
        directory: Path,
        observed: datetime,
        *,
        scan_budget: _ScanBudget | None = None,
    ) -> None:
        previous = self._read_lease_generation(directory_descriptor, directory)
        if previous is None:
            previous = self._maximum_ordinary_lease_generation(
                directory_descriptor,
                directory,
                scan_budget=scan_budget,
            )
        selected = _canonical_lease_timestamp(observed)
        if previous is not None and previous > selected:
            selected = previous
        self._write_lease_generation(directory_descriptor, directory, selected)

    def _write_lease_generation(
        self,
        directory_descriptor: int | None,
        directory: Path,
        selected: datetime,
    ) -> None:
        _atomic_replace_file_at(
            directory_descriptor,
            directory,
            _LEASE_GENERATION_NAME,
            _json_bytes(
                {
                    "schema": "remote-skills-cache-lease-generation-v1",
                    "coordination_version": CACHE_COORDINATION_VERSION,
                    "generation": _format_timestamp(selected),
                }
            ),
        )

    def _claim_metadata_limit(self) -> int:
        return max(self.max_lease_metadata_bytes, DEFAULT_MAX_CLAIM_METADATA_BYTES)

    def _mutation_gate_directory(self) -> Path:
        return self._coordination_directory() / "locks"

    def _mutation_gate_digest_directory(self, digest: str) -> Path:
        return self._mutation_gate_directory() / validate_digest(digest)[7:]

    def _mutation_gate_path(self, digest: str, ticket: int, owner_nonce: str) -> Path:
        return self._mutation_gate_digest_directory(digest) / (
            f"{ticket:016d}-{self._validate_nonce(owner_nonce)}.lock"
        )

    def _mutation_intent_path(self, digest: str, owner_nonce: str) -> Path:
        return self._mutation_gate_digest_directory(digest) / (
            f"{self._validate_nonce(owner_nonce)}.intent"
        )

    def _open_mutation_gate_directory(
        self,
        digest: str,
        *,
        create: bool,
    ) -> tuple[int | None, Path]:
        directory = self._mutation_gate_digest_directory(digest)
        if create:
            self._ensure_cache_directory(
                "tmp",
                "coordination-v1",
                "locks",
                validate_digest(digest)[7:],
                expected_digest=digest,
            )
        return _open_directory_chain(self.root, directory.relative_to(self.root).parts)

    def _next_mutation_ticket(self, digest: str) -> tuple[int, bool]:
        descriptor: int | None = None
        maximum = 0
        contended_with_eviction = False
        try:
            descriptor, directory = self._open_mutation_gate_directory(digest, create=False)
            for name in _bounded_directory_names(
                descriptor,
                directory,
                max_entries=self.max_scan_entries,
            ):
                if not name.endswith(".lock"):
                    continue
                try:
                    value: Any = _parse_cache_json(
                        _read_regular_file(
                            descriptor,
                            directory,
                            name,
                            max_bytes=self._claim_metadata_limit(),
                        )
                    )
                except (OSError, UnicodeError, ValueError, TypeError, json.JSONDecodeError):
                    continue
                ticket = value.get("ticket") if isinstance(value, dict) else None
                if (
                    isinstance(value, dict)
                    and value.get("schema") == "remote-skills-cache-mutation-lock-v1"
                    and isinstance(ticket, int)
                    and not isinstance(ticket, bool)
                    and 0 < ticket <= MAX_SAFE_INTEGER
                ):
                    maximum = max(maximum, ticket)
                    contended_with_eviction = (
                        value.get("operation") == "evict" or contended_with_eviction
                    )
        finally:
            if descriptor is not None:
                os.close(descriptor)
        if maximum >= MAX_SAFE_INTEGER:
            raise CacheCorruptError(digest)
        return maximum + 1, contended_with_eviction

    def _reclaim_mutation_gate_record(self, digest: str, name: str) -> bool:
        descriptor: int | None = None
        try:
            descriptor, directory = self._open_mutation_gate_directory(digest, create=False)
            content, info, _ = _read_regular_file_snapshot_at(
                descriptor,
                directory,
                name,
                max_bytes=self._claim_metadata_limit(),
            )
            try:
                value: Any = _parse_cache_json(content)
            except (UnicodeError, ValueError, TypeError, json.JSONDecodeError):
                value = None
            if isinstance(value, dict) and isinstance(value.get("schema"), str) and value.get(
                "schema"
            ) not in {
                "remote-skills-cache-mutation-lock-v1",
                "remote-skills-cache-mutation-intent-v1",
            }:
                return False
            valid = (
                isinstance(value, dict)
                and value.get("schema")
                in {
                    "remote-skills-cache-mutation-lock-v1",
                    "remote-skills-cache-mutation-intent-v1",
                }
                and isinstance(value.get("pid"), int)
                and not isinstance(value.get("pid"), bool)
                and 0 < value["pid"] <= MAX_SAFE_INTEGER
                and isinstance(value.get("process_nonce"), str)
                and isinstance(value.get("owner_nonce"), str)
                and isinstance(value.get("created_at"), str)
                and value.get("operation", "mutation")
                in {"acquire", "evict", "mutation"}
                and (
                    "contended_with_eviction" not in value
                    or isinstance(value.get("contended_with_eviction"), bool)
                )
                and (
                    value.get("schema") == "remote-skills-cache-mutation-intent-v1"
                    or (
                        isinstance(value.get("ticket"), int)
                        and not isinstance(value.get("ticket"), bool)
                        and 0 < value["ticket"] <= MAX_SAFE_INTEGER
                    )
                )
            )
            created = None
            if valid:
                try:
                    self._validate_nonce(value["process_nonce"])
                    self._validate_nonce(value["owner_nonce"])
                    created = _parse_timestamp(value["created_at"])
                except (CacheConfigurationError, TypeError, ValueError):
                    valid = False
            age = (
                (self._now() - created).total_seconds()
                if valid and created is not None
                else self._now().timestamp() - info.st_mtime
            )
            if age <= self.lease_expiry_seconds:
                return False
            if valid:
                if self._registered_process_is_alive(
                    value["pid"],
                    value["process_nonce"],
                    digest,
                ):
                    return False
            # This pathname contains the owner's generation nonce and is never reused by
            # a legitimate successor, so removal cannot unlink a fresh gate generation.
            _unlink_at(descriptor, directory, name)
            return True
        except FileNotFoundError:
            return True
        except (OSError, UnicodeError, ValueError, TypeError, json.JSONDecodeError):
            return False
        finally:
            if descriptor is not None:
                os.close(descriptor)

    def _mutation_turn_state(
        self,
        digest: str,
        *,
        ticket: int,
        owner_nonce: str,
        own_name: str,
    ) -> tuple[bool, bool]:
        descriptor: int | None = None
        blocked = False
        contended_with_eviction = False
        records: list[dict[str, Any]] = []
        try:
            descriptor, directory = self._open_mutation_gate_directory(digest, create=False)
            names = _bounded_directory_names(
                descriptor,
                directory,
                max_entries=self.max_scan_entries,
            )
        finally:
            if descriptor is not None:
                os.close(descriptor)
        for name in names:
            if name == own_name:
                continue
            if name.endswith(".tmp"):
                self._reclaim_mutation_gate_record(digest, name)
                continue
            if not name.endswith((".intent", ".lock")):
                blocked = True
                contended_with_eviction = True
                continue
            self._reclaim_mutation_gate_record(digest, name)
            record_descriptor: int | None = None
            try:
                record_descriptor, directory = self._open_mutation_gate_directory(
                    digest,
                    create=False,
                )
                value: Any = _parse_cache_json(
                    _read_regular_file(
                        record_descriptor,
                        directory,
                        name,
                        max_bytes=self._claim_metadata_limit(),
                    )
                )
            except FileNotFoundError:
                continue
            except (OSError, UnicodeError, ValueError, TypeError, json.JSONDecodeError):
                blocked = True
                contended_with_eviction = True
                continue
            finally:
                if record_descriptor is not None:
                    os.close(record_descriptor)
            if not isinstance(value, dict) or value.get("schema") not in {
                "remote-skills-cache-mutation-lock-v1",
                "remote-skills-cache-mutation-intent-v1",
            }:
                blocked = True
                contended_with_eviction = True
                continue
            common_valid = (
                isinstance(value.get("pid"), int)
                and not isinstance(value.get("pid"), bool)
                and 0 < value["pid"] <= MAX_SAFE_INTEGER
                and isinstance(value.get("process_nonce"), str)
                and isinstance(value.get("owner_nonce"), str)
                and isinstance(value.get("created_at"), str)
                and value.get("operation", "mutation")
                in {"acquire", "evict", "mutation"}
                and (
                    "contended_with_eviction" not in value
                    or isinstance(value.get("contended_with_eviction"), bool)
                )
            )
            if common_valid:
                try:
                    self._validate_nonce(value["process_nonce"])
                    self._validate_nonce(value["owner_nonce"])
                    _parse_timestamp(value["created_at"])
                except (CacheConfigurationError, TypeError, ValueError):
                    common_valid = False
            if not common_valid:
                blocked = True
                contended_with_eviction = True
                continue
            contended_with_eviction = (
                value.get("operation") not in {"acquire", "mutation"}
                or contended_with_eviction
            )
            if value.get("schema") == "remote-skills-cache-mutation-intent-v1":
                records.append(value)
                continue
            other_ticket = value.get("ticket")
            other_owner = value.get("owner_nonce")
            if (
                not isinstance(other_ticket, int)
                or isinstance(other_ticket, bool)
                or other_ticket <= 0
                or not isinstance(other_owner, str)
            ):
                blocked = True
                continue
            if (other_ticket, other_owner) < (ticket, owner_nonce):
                blocked = True
            records.append(value)
        finalized_owners = {owner_nonce}
        finalized_owners.update(
            value["owner_nonce"]
            for value in records
            if value.get("schema") == "remote-skills-cache-mutation-lock-v1"
            and isinstance(value.get("owner_nonce"), str)
        )
        for value in records:
            if value.get("schema") != "remote-skills-cache-mutation-intent-v1":
                continue
            intent_owner = value.get("owner_nonce")
            if not isinstance(intent_owner, str) or intent_owner not in finalized_owners:
                blocked = True
        return not blocked, contended_with_eviction

    def _acquire_mutation_gate(self, digest: str, *, operation: str) -> _MutationGate:
        if operation not in {"acquire", "evict", "mutation"}:
            raise CacheConfigurationError("mutation_gate")
        process_nonce = secrets.token_hex(16)
        owner_nonce = secrets.token_hex(16)
        self._register_process_identity(digest, os.getpid(), process_nonce)
        heartbeat = self._start_process_registration_heartbeat(
            digest,
            os.getpid(),
            process_nonce,
        )
        created_at = _format_timestamp(self._now())
        deadline = time.monotonic() + min(
            _MAX_TIMER_DELAY_SECONDS,
            max(30.0, self.lease_expiry_seconds * 2.0),
        )
        contended_with_eviction = False
        descriptor: int | None = None
        intent_path = self._mutation_intent_path(digest, owner_nonce)
        lock_path: Path | None = None
        try:
            intent_value: dict[str, Any] = {
                "schema": "remote-skills-cache-mutation-intent-v1",
                "pid": os.getpid(),
                "process_nonce": process_nonce,
                "owner_nonce": owner_nonce,
                "created_at": created_at,
                "operation": operation,
            }
            intent_content = _json_bytes(intent_value)
            for attempt in range(8):
                descriptor, directory = self._open_mutation_gate_directory(digest, create=True)
                opened_identity = (
                    _identity(os.fstat(descriptor))
                    if descriptor is not None
                    else _identity(os.stat(directory, follow_symlinks=False))
                )
                _atomic_create_file_at(descriptor, directory, intent_path.name, intent_content)
                try:
                    current_identity = _identity(os.stat(directory, follow_symlinks=False))
                except FileNotFoundError:
                    current_identity = None
                if current_identity == opened_identity:
                    if descriptor is not None:
                        os.close(descriptor)
                    descriptor = None
                    break
                try:
                    _unlink_at(descriptor, directory, intent_path.name)
                finally:
                    if descriptor is not None:
                        os.close(descriptor)
                    descriptor = None
                if attempt == 7:
                    raise CacheCorruptError(digest)
            ticket, observed_eviction = self._next_mutation_ticket(digest)
            contended_with_eviction = observed_eviction or contended_with_eviction
            lock_value: dict[str, Any] = {
                "schema": "remote-skills-cache-mutation-lock-v1",
                "pid": os.getpid(),
                "process_nonce": process_nonce,
                "owner_nonce": owner_nonce,
                "ticket": ticket,
                "created_at": created_at,
                "operation": operation,
            }
            if contended_with_eviction:
                lock_value["contended_with_eviction"] = True
            content = _json_bytes(lock_value)
            lock_path = self._mutation_gate_path(digest, ticket, owner_nonce)
            descriptor, directory = self._open_mutation_gate_directory(digest, create=False)
            _atomic_create_file_at(descriptor, directory, lock_path.name, content)
            _regular_file_snapshot_info_at(descriptor, directory, lock_path.name)
            if descriptor is not None:
                os.close(descriptor)
            descriptor = None
            while True:
                ready, observed_eviction = self._mutation_turn_state(
                    digest,
                    ticket=ticket,
                    owner_nonce=owner_nonce,
                    own_name=lock_path.name,
                )
                contended_with_eviction = observed_eviction or contended_with_eviction
                if ready:
                    return _MutationGate(
                        digest=digest,
                        process_nonce=process_nonce,
                        owner_nonce=owner_nonce,
                        directory=directory,
                        name=lock_path.name,
                        heartbeat=heartbeat,
                        contended_with_eviction=contended_with_eviction,
                    )
                if time.monotonic() >= deadline:
                    raise CacheConfigurationError("mutation_gate")
                time.sleep(0.005)
        except BaseException:
            if descriptor is not None:
                os.close(descriptor)
                descriptor = None
            try:
                descriptor, directory = self._open_mutation_gate_directory(digest, create=False)
                for path in (lock_path, intent_path):
                    if path is None:
                        continue
                    try:
                        _unlink_at(descriptor, directory, path.name)
                    except FileNotFoundError:
                        pass
            except (OSError, ValueError):
                pass
            finally:
                if descriptor is not None:
                    os.close(descriptor)
                    descriptor = None
            self._stop_process_registration_heartbeat(heartbeat, digest)
            self._remove_process_registration_if_unused(
                digest,
                os.getpid(),
                process_nonce,
            )
            raise

    def _release_mutation_gate(self, gate: _MutationGate) -> None:
        descriptor: int | None = None
        failure: BaseException | None = None
        try:
            descriptor, directory = self._open_mutation_gate_directory(gate.digest, create=False)
            _unlink_at(descriptor, directory, gate.name)
            try:
                _unlink_at(
                    descriptor,
                    directory,
                    self._mutation_intent_path(gate.digest, gate.owner_nonce).name,
                )
            except FileNotFoundError:
                pass
        except FileNotFoundError:
            pass
        except BaseException as error:
            failure = error
        finally:
            if descriptor is not None:
                os.close(descriptor)
            try:
                self._stop_process_registration_heartbeat(gate.heartbeat, gate.digest)
                self._remove_process_registration_if_unused(
                    gate.digest,
                    os.getpid(),
                    gate.process_nonce,
                )
            except BaseException as error:
                if failure is None:
                    failure = error
        if failure is not None:
            if isinstance(failure, CacheCorruptError):
                raise failure
            raise CacheCorruptError(gate.digest) from failure

    def _acquire_eviction_claim(
        self,
        digest: str,
        *,
        operation: str = "mutation",
    ) -> _EvictionClaim:
        gate = self._acquire_mutation_gate(digest, operation=operation)
        deadline = time.monotonic() + 5
        try:
            while True:
                claim = self._try_acquire_eviction_claim(digest)
                if claim is not None:
                    return _EvictionClaim(
                        digest=claim.digest,
                        token=claim.token,
                        content=claim.content,
                        gate=gate,
                    )
                try:
                    self._wait_for_eviction_claim(digest, deadline=deadline)
                except FileNotFoundError:
                    continue
        except BaseException:
            self._release_mutation_gate(gate)
            raise

    def _try_acquire_eviction_claim(self, digest: str) -> _EvictionClaim | None:
        identity = self._process_identity(os.getpid())
        if identity is None:
            raise CacheConfigurationError("process_identity")
        token = secrets.token_hex(16)
        value = _json_bytes(
            {
                "schema": "remote-skills-cache-eviction-claim-v1",
                "coordination_version": CACHE_COORDINATION_VERSION,
                "pid": os.getpid(),
                "process_nonce": token,
                "process_identity": identity,
                "created_at": _format_timestamp(self._now()),
            }
        )
        descriptor: int | None = None
        try:
            descriptor, directory = self._open_lease_directory(digest, create=True)
            _atomic_create_file_at(
                descriptor,
                directory,
                _EVICTION_CLAIM_NAME,
                value,
            )
            return _EvictionClaim(
                digest=digest,
                token=token,
                content=value,
                gate=None,
            )
        except FileExistsError:
            return None
        finally:
            if descriptor is not None:
                os.close(descriptor)

    def _wait_for_eviction_claim(self, digest: str, *, deadline: float) -> None:
        while self._eviction_claim_exists(digest):
            if self._reclaim_stale_eviction_claim(digest):
                return
            if time.monotonic() >= deadline:
                raise CacheConfigurationError("eviction_claim")
            time.sleep(0.005)

    def _eviction_claim_exists(self, digest: str) -> bool:
        descriptor: int | None = None
        try:
            descriptor, directory = self._open_lease_directory(digest, create=False)
            _regular_file_snapshot_info_at(
                descriptor,
                directory,
                _EVICTION_CLAIM_NAME,
            )
            return True
        except FileNotFoundError:
            return False
        except (OSError, ValueError) as error:
            raise CacheCorruptError(digest) from error
        finally:
            if descriptor is not None:
                os.close(descriptor)

    def _reclaim_stale_eviction_claim(self, digest: str) -> bool:
        descriptor: int | None = None
        try:
            descriptor, directory = self._open_lease_directory(digest, create=False)
            if not _requires_closed_mutation_snapshot():
                with _locked_regular_file_at(
                    descriptor,
                    directory,
                    _EVICTION_CLAIM_NAME,
                ) as (claim_descriptor, claim_info):
                    try:
                        content = _read_descriptor(
                            claim_descriptor,
                            max_bytes=self._claim_metadata_limit(),
                        )
                    except ValueError:
                        if (
                            not self._lease_snapshot_is_expired(
                                claim_info,
                                self.lease_expiry_seconds,
                            )
                            or not _entry_matches_descriptor(
                                descriptor,
                                directory,
                                _EVICTION_CLAIM_NAME,
                                claim_descriptor,
                                expected=claim_info,
                            )
                        ):
                            return False
                        _unlink_at(descriptor, directory, _EVICTION_CLAIM_NAME)
                        return True
                    if not self._claim_is_stale(content, claim_info):
                        return False
                    if not _entry_matches_descriptor(
                        descriptor,
                        directory,
                        _EVICTION_CLAIM_NAME,
                        claim_descriptor,
                    ):
                        return False
                    _unlink_at(descriptor, directory, _EVICTION_CLAIM_NAME)
                    return True
            info = _regular_file_snapshot_info_at(
                descriptor,
                directory,
                _EVICTION_CLAIM_NAME,
            )
            try:
                content, info, _ = _read_regular_file_snapshot_at(
                    descriptor,
                    directory,
                    _EVICTION_CLAIM_NAME,
                    max_bytes=self._claim_metadata_limit(),
                )
            except ValueError:
                if (
                    not self._lease_snapshot_is_expired(
                        info,
                        self.lease_expiry_seconds,
                    )
                    or not _entry_matches_generation(
                        descriptor,
                        directory,
                        _EVICTION_CLAIM_NAME,
                        info,
                    )
                ):
                    return False
                _unlink_at(descriptor, directory, _EVICTION_CLAIM_NAME)
                return True
            stale = self._claim_is_stale(content, info)
            if not stale or not _entry_matches_snapshot(
                descriptor,
                directory,
                _EVICTION_CLAIM_NAME,
                content=content,
                identity=_identity(info),
                max_bytes=self._claim_metadata_limit(),
            ):
                return False
            _unlink_at(descriptor, directory, _EVICTION_CLAIM_NAME)
            return True
        except FileNotFoundError:
            return True
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            return False
        finally:
            if descriptor is not None:
                os.close(descriptor)

    def _claim_is_stale(self, content: bytes, info: os.stat_result) -> bool:
        modified_age = self._now().timestamp() - info.st_mtime
        try:
            value: Any = _parse_cache_json(content)
            if not isinstance(value, dict) or set(value) != _CLAIM_KEYS:
                return modified_age > self.lease_expiry_seconds
            if (
                value["schema"] != "remote-skills-cache-eviction-claim-v1"
                or value["coordination_version"] != CACHE_COORDINATION_VERSION
            ):
                return modified_age > self.lease_expiry_seconds
            pid = value["pid"]
            token = value["process_nonce"]
            identity = value["process_identity"]
            if (
                not isinstance(pid, int)
                or isinstance(pid, bool)
                or pid <= 0
                or pid > MAX_SAFE_INTEGER
                or not isinstance(token, str)
                or _NONCE_PATTERN.fullmatch(token) is None
                or not isinstance(identity, str)
            ):
                return modified_age > self.lease_expiry_seconds
            created_age = (self._now() - _parse_timestamp(value["created_at"])).total_seconds()
            current_identity = self._process_identity(pid)
            if current_identity == identity:
                return False
            if current_identity is None and self._process_is_alive(pid, token):
                return False
            if current_identity is not None:
                return True
            return min(modified_age, created_age) > self.lease_expiry_seconds
        except (UnicodeError, ValueError, TypeError, json.JSONDecodeError):
            return modified_age > self.lease_expiry_seconds

    def _release_legacy_eviction_claim(self, claim: _EvictionClaim) -> None:
        descriptor: int | None = None
        try:
            descriptor, directory = self._open_lease_directory(claim.digest, create=False)
            if not _requires_closed_mutation_snapshot():
                with _locked_regular_file_at(
                    descriptor,
                    directory,
                    _EVICTION_CLAIM_NAME,
                ) as (claim_descriptor, _):
                    content = _read_descriptor(
                        claim_descriptor,
                        max_bytes=self._claim_metadata_limit(),
                    )
                    try:
                        value: Any = _parse_cache_json(content)
                    except (UnicodeError, ValueError, TypeError, json.JSONDecodeError):
                        return
                    if (
                        content != claim.content
                        or not isinstance(value, dict)
                        or value.get("process_nonce") != claim.token
                        or not _entry_matches_descriptor(
                            descriptor,
                            directory,
                            _EVICTION_CLAIM_NAME,
                            claim_descriptor,
                        )
                    ):
                        return
                    _unlink_at(descriptor, directory, _EVICTION_CLAIM_NAME)
                    return
            content, info, _ = _read_regular_file_snapshot_at(
                descriptor,
                directory,
                _EVICTION_CLAIM_NAME,
                max_bytes=self._claim_metadata_limit(),
            )
            try:
                value: Any = _parse_cache_json(content)
            except (UnicodeError, ValueError, TypeError, json.JSONDecodeError):
                return
            if (
                content != claim.content
                or not isinstance(value, dict)
                or value.get("process_nonce") != claim.token
                or not _entry_matches_snapshot(
                    descriptor,
                    directory,
                    _EVICTION_CLAIM_NAME,
                    content=content,
                    identity=_identity(info),
                    max_bytes=self._claim_metadata_limit(),
                )
            ):
                return
            _unlink_at(descriptor, directory, _EVICTION_CLAIM_NAME)
        except FileNotFoundError:
            pass
        finally:
            if descriptor is not None:
                os.close(descriptor)

    def _release_eviction_claim(self, claim: _EvictionClaim) -> None:
        try:
            self._release_legacy_eviction_claim(claim)
        finally:
            if claim.gate is not None:
                self._release_mutation_gate(claim.gate)

    def _lease_path(self, lease: CacheLease) -> Path:
        process_nonce = self._validate_nonce(lease.process_nonce)
        session_nonce = self._validate_nonce(lease.session_nonce)
        lease_nonce = (
            None
            if lease.lease_nonce is None
            else self._validate_nonce(lease.lease_nonce)
        )
        validate_process_id(lease.pid)
        return self._lease_directory(lease.digest) / (
            f"{process_nonce}-{session_nonce}"
            f"{'' if lease_nonce is None else f'-{lease_nonce}'}.json"
        )

    def _matching_lease_identity_exists(
        self,
        descriptor: int | None,
        directory: Path,
        *,
        digest: str,
        process_nonce: str,
        session_nonce: str,
    ) -> bool:
        for name in _bounded_directory_names(
            descriptor,
            directory,
            max_entries=self.max_scan_entries,
        ):
            if name.startswith(".") or not name.endswith(".json"):
                continue
            try:
                candidate = self._deserialize_lease(
                    _read_regular_file(
                        descriptor,
                        directory,
                        name,
                        max_bytes=self.max_lease_metadata_bytes,
                    ),
                    digest,
                )
            except (
                OSError,
                UnicodeError,
                ValueError,
                TypeError,
                CacheConfigurationError,
                CacheCorruptError,
            ):
                continue
            if (
                candidate.process_nonce == process_nonce
                and candidate.session_nonce == session_nonce
            ):
                return True
        return False

    def _ensure_cache_directory(
        self,
        *parts: str,
        expected_digest: str | None = None,
    ) -> Path:
        """Create an internal directory without accepting symlinked boundaries."""

        current = self.root
        try:
            if _windows_mode():
                current.mkdir(parents=True, exist_ok=True)
                if not _regular_directory(current):
                    raise OSError("cache root is not a directory")
                for part in (LAYOUT_VERSION, *parts):
                    current = current / part
                    current.mkdir(exist_ok=True)
                    if not _regular_directory(current):
                        raise OSError("cache directory is not a regular directory")
                return current

            _require_descriptor_mutation(expected_digest)
            if os.path.lexists(self.root) and stat.S_ISLNK(self.root.lstat().st_mode):
                raise OSError("cache root symlink")
            absolute = self.root.absolute()
            absolute_root = absolute.parent.resolve(strict=False) / absolute.name
            anchor = Path(absolute_root.anchor)
            descriptors: list[int] = []
            paths: list[Path] = []
            identities: list[tuple[int, int, int]] = []
            descriptor = _open_directory(anchor)
            if descriptor is None:
                raise OSError("cache root anchor unavailable")
            descriptors.append(descriptor)
            try:
                path = anchor
                for part in (*absolute_root.parts[1:], LAYOUT_VERSION, *parts):
                    try:
                        os.mkdir(part, 0o700, dir_fd=descriptor)
                    except FileExistsError:
                        pass
                    child = _open_directory_entry_at(descriptor, part)
                    path = path / part
                    descriptors.append(child)
                    paths.append(path)
                    identities.append(_identity(os.fstat(child)))
                    descriptor = child
                for path, opened, identity in zip(
                    paths,
                    descriptors[1:],
                    identities,
                    strict=True,
                ):
                    current_info = path.lstat()
                    if (
                        not stat.S_ISDIR(current_info.st_mode)
                        or _identity(current_info) != identity
                        or _identity(os.fstat(opened)) != identity
                    ):
                        raise OSError("cache directory generation changed")
            finally:
                for opened in reversed(descriptors):
                    os.close(opened)
            current = self.namespace.joinpath(*parts)
        except (OSError, ValueError) as error:
            raise CacheCorruptError(expected_digest) from error
        return current

    def _read_lease(
        self,
        directory_descriptor: int | None,
        directory_path: Path,
        name: str,
        digest: str,
    ) -> tuple[CacheLease, bytes]:
        original = _read_regular_file(
            directory_descriptor,
            directory_path,
            name,
            max_bytes=self.max_lease_metadata_bytes,
        )
        return self._deserialize_lease(original, digest), original

    def _deserialize_lease(self, original: bytes, digest: str) -> CacheLease:
        value: Any = _parse_cache_json(original)
        if (
            not isinstance(value, dict)
            or not _LEASE_REQUIRED_KEYS.issubset(value)
            or not set(value).issubset(_LEASE_REQUIRED_KEYS | _LEASE_OPTIONAL_KEYS)
        ):
            raise ValueError("lease schema")
        if value["schema"] != "remote-skills-cache-lease-v1" or value["digest"] != digest:
            raise ValueError("lease identity")
        pid = value["pid"]
        if (
            not isinstance(pid, int)
            or isinstance(pid, bool)
            or pid <= 0
            or pid > MAX_SAFE_INTEGER
        ):
            raise ValueError("lease pid")
        process_nonce = value["process_nonce"]
        session_nonce = value["session_nonce"]
        self._validate_nonce(process_nonce)
        self._validate_nonce(session_nonce)
        lease_nonce = value.get("lease_nonce")
        if lease_nonce is not None:
            self._validate_nonce(lease_nonce)
        return CacheLease(
            digest=digest,
            pid=pid,
            process_nonce=process_nonce,
            session_nonce=session_nonce,
            created_at=_parse_timestamp(value["created_at"]),
            renewed_at=_parse_timestamp(value["renewed_at"]),
            lease_nonce=lease_nonce,
        )

    def _lease_is_live(self, lease: CacheLease, expiry_seconds: int) -> bool:
        age = (self._now() - lease.renewed_at).total_seconds()
        if age <= expiry_seconds:
            return True
        if self._injected_process_is_alive is not None:
            return self._injected_process_is_alive(lease.pid, lease.process_nonce)
        return self._registered_process_is_alive(
            lease.pid,
            lease.process_nonce,
            lease.digest,
        )

    def _coordination_directory(self) -> Path:
        return self.namespace / "tmp" / "coordination-v1"

    def _process_registration_directory(self, digest: str) -> Path:
        return self._coordination_directory() / "processes" / validate_digest(digest)[7:]

    def _process_path(self, digest: str, pid: int, process_nonce: str) -> Path:
        process_nonce = self._validate_nonce(process_nonce)
        validate_process_id(pid)
        return self._process_registration_directory(digest) / f"{process_nonce}.json"

    def _open_process_directory(
        self,
        digest: str,
        *,
        create: bool,
    ) -> tuple[int | None, Path]:
        directory = self._process_registration_directory(digest)
        if create:
            self._ensure_cache_directory(
                "tmp",
                "coordination-v1",
                "processes",
                validate_digest(digest)[7:],
                expected_digest=digest,
            )
        relative = directory.relative_to(self.root)
        return _open_directory_chain(self.root, relative.parts)

    def _register_process(self, lease: CacheLease) -> None:
        self._register_process_identity(
            lease.digest,
            lease.pid,
            lease.process_nonce,
        )

    def _register_process_identity(
        self,
        digest: str,
        pid: int,
        process_nonce: str,
    ) -> None:
        digest = validate_digest(digest)
        pid = validate_process_id(pid)
        process_nonce = self._validate_nonce(process_nonce)
        identity = self._process_identity(pid)
        path = self._process_path(digest, pid, process_nonce)
        value = _json_bytes(
            {
                "schema": "remote-skills-cache-process-registration-v1",
                "pid": pid,
                "process_nonce": process_nonce,
                **({} if identity is None else {"process_identity": identity}),
                "renewed_at": _format_timestamp(self._now()),
            }
        )
        descriptor: int | None = None
        try:
            descriptor, directory = self._open_process_directory(digest, create=True)
            _write_file_at(descriptor, directory, path.name, value)
        except FileExistsError:
            try:
                if _read_regular_file(
                    descriptor,
                    directory,
                    path.name,
                    max_bytes=self.max_lease_metadata_bytes,
                ) == value:
                    return
            except OSError:
                pass
            _atomic_replace_file_at(descriptor, directory, path.name, value)
        finally:
            if descriptor is not None:
                os.close(descriptor)

    def _start_process_registration_heartbeat(
        self,
        digest: str,
        pid: int,
        process_nonce: str,
        *,
        renew: Callable[[], None] | None = None,
    ) -> _ProcessRegistrationHeartbeat:
        stop = threading.Event()
        errors: list[BaseException] = []
        interval = max(0.05, min(30.0, self.lease_expiry_seconds / 2))

        def heartbeat() -> None:
            while not stop.wait(interval):
                try:
                    if renew is None:
                        self._register_process_identity(digest, pid, process_nonce)
                    else:
                        renew()
                except BaseException as error:
                    errors.append(error)
                    stop.set()

        thread = threading.Thread(
            target=heartbeat,
            name="remote-skills-cache-registration-heartbeat",
            daemon=True,
        )
        thread.start()
        return _ProcessRegistrationHeartbeat(stop, thread, errors)

    def _stop_process_registration_heartbeat(
        self,
        heartbeat: _ProcessRegistrationHeartbeat,
        digest: str,
    ) -> None:
        heartbeat.stop.set()
        heartbeat.thread.join(timeout=max(1.0, self.lease_expiry_seconds))
        if heartbeat.thread.is_alive() or heartbeat.errors:
            raise CacheCorruptError(digest)

    def _open_process_registration_handle(
        self,
        digest: str,
        pid: int,
        process_nonce: str,
    ) -> _ProcessRegistrationHandle:
        descriptor, directory = self._open_process_directory(digest, create=False)
        try:
            path = self._process_path(digest, pid, process_nonce)
            content, info, _ = _read_regular_file_snapshot_at(
                descriptor,
                directory,
                path.name,
                max_bytes=self.max_lease_metadata_bytes,
            )
            return _ProcessRegistrationHandle(
                descriptor=descriptor,
                directory=directory,
                name=path.name,
                content=content,
                identity=_identity(info),
            )
        except Exception:
            if descriptor is not None:
                os.close(descriptor)
            raise

    def _remove_process_registration_handle(
        self,
        handle: _ProcessRegistrationHandle,
    ) -> None:
        try:
            matches = False
            if handle.descriptor is not None and os.stat in os.supports_dir_fd:
                info = os.stat(
                    handle.name,
                    dir_fd=handle.descriptor,
                    follow_symlinks=False,
                )
                flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
                file_descriptor = os.open(handle.name, flags, dir_fd=handle.descriptor)
                try:
                    matches = (
                        stat.S_ISREG(info.st_mode)
                        and _identity(info) == handle.identity
                        and _read_descriptor(
                            file_descriptor,
                            max_bytes=self.max_lease_metadata_bytes,
                        )
                        == handle.content
                    )
                finally:
                    os.close(file_descriptor)
            else:
                matches = _entry_matches_snapshot(
                    handle.descriptor,
                    handle.directory,
                    handle.name,
                    content=handle.content,
                    identity=handle.identity,
                    max_bytes=self.max_lease_metadata_bytes,
                )
            if matches:
                _unlink_at(handle.descriptor, handle.directory, handle.name)
        except (FileNotFoundError, OSError, ValueError):
            pass
        finally:
            if handle.descriptor is not None:
                os.close(handle.descriptor)
                handle.descriptor = None

    def _registered_process_is_alive(
        self,
        pid: int,
        process_nonce: str,
        digest: str,
    ) -> bool:
        path = self._process_path(digest, pid, process_nonce)
        descriptor: int | None = None
        info: os.stat_result | None = None
        try:
            descriptor, directory = self._open_process_directory(digest, create=False)
            content, info, _ = _read_regular_file_snapshot_at(
                descriptor,
                directory,
                path.name,
                max_bytes=self.max_lease_metadata_bytes,
            )
            value: Any = _parse_cache_json(content)
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            return False
        finally:
            if descriptor is not None:
                os.close(descriptor)
        if (
            not isinstance(value, dict)
            or not _PROCESS_REQUIRED_KEYS.issubset(value)
            or not set(value).issubset(_PROCESS_REQUIRED_KEYS | _PROCESS_OPTIONAL_KEYS)
            or value["schema"] != "remote-skills-cache-process-registration-v1"
            or value["pid"] != pid
            or value["process_nonce"] != process_nonce
            or not isinstance(value["renewed_at"], str)
        ):
            return False
        try:
            self._validate_nonce(value["process_nonce"])
            renewed_at = _parse_timestamp(value["renewed_at"])
        except (CacheConfigurationError, ValueError):
            return False
        identity = value.get("process_identity")
        if identity is not None and (
            not isinstance(identity, str) or not identity or len(identity) > 128
        ):
            return False
        try:
            current = self._process_identity(pid)
        except Exception:
            current = None
        if identity is not None and current is not None:
            return current == identity
        if not _pid_may_be_alive(pid):
            return False
        if info is not None:
            filesystem_heartbeat_age = time.time() - info.st_mtime
            return 0 <= filesystem_heartbeat_age <= self.lease_expiry_seconds
        return (self._now() - renewed_at).total_seconds() <= self.lease_expiry_seconds

    def _remove_process_registration_if_unused(
        self,
        digest: str,
        pid: int,
        process_nonce: str,
    ) -> None:
        lease_descriptor: int | None = None
        try:
            lease_descriptor, lease_directory = self._open_lease_directory(
                digest,
                create=False,
            )
            for name in _bounded_directory_names(
                lease_descriptor,
                lease_directory,
                max_entries=self.max_scan_entries,
            ):
                if name.startswith(".") or not name.endswith(".json"):
                    continue
                try:
                    lease = self._deserialize_lease(
                        _read_regular_file(
                            lease_descriptor,
                            lease_directory,
                            name,
                            max_bytes=self.max_lease_metadata_bytes,
                        ),
                        digest,
                    )
                except (
                    OSError,
                    UnicodeError,
                    ValueError,
                    TypeError,
                    json.JSONDecodeError,
                    CacheConfigurationError,
                ):
                    continue
                if lease.pid == pid and lease.process_nonce == process_nonce:
                    return
        except (FileNotFoundError, OSError, ValueError):
            pass
        finally:
            if lease_descriptor is not None:
                os.close(lease_descriptor)

        descriptor: int | None = None
        registration_directory = self._process_registration_directory(digest)
        try:
            descriptor, opened_directory = self._open_process_directory(digest, create=False)
            path = self._process_path(digest, pid, process_nonce)
            content, info, _ = _read_regular_file_snapshot_at(
                descriptor,
                opened_directory,
                path.name,
                max_bytes=self.max_lease_metadata_bytes,
            )
            value: Any = _parse_cache_json(content)
            if (
                isinstance(value, dict)
                and value.get("pid") == pid
                and value.get("process_nonce") == process_nonce
                and _entry_matches_snapshot(
                    descriptor,
                    opened_directory,
                    path.name,
                    content=content,
                    identity=_identity(info),
                    max_bytes=self.max_lease_metadata_bytes,
                )
            ):
                _unlink_at(descriptor, opened_directory, path.name)
        except (FileNotFoundError, OSError, UnicodeError, ValueError, TypeError):
            pass
        finally:
            if descriptor is not None:
                os.close(descriptor)
        for directory in (
            self._mutation_gate_digest_directory(digest),
            self._mutation_gate_directory(),
            registration_directory,
            registration_directory.parent,
            self._coordination_directory(),
        ):
            try:
                directory.rmdir()
            except (FileNotFoundError, OSError):
                pass

    def _serialize_lease(self, lease: CacheLease) -> bytes:
        return _json_bytes(
            {
                "schema": "remote-skills-cache-lease-v1",
                "digest": lease.digest,
                "pid": lease.pid,
                "process_nonce": lease.process_nonce,
                "session_nonce": lease.session_nonce,
                "created_at": _format_timestamp(lease.created_at),
                "renewed_at": _format_timestamp(lease.renewed_at),
                **(
                    {}
                    if lease.lease_nonce is None
                    else {"lease_nonce": self._validate_nonce(lease.lease_nonce)}
                ),
            }
        )

    def _validate_nonce(self, value: object) -> str:
        if not isinstance(value, str):
            raise CacheConfigurationError("nonce")
        exact = snapshot_unicode_scalar_string(value)
        if _NONCE_PATTERN.fullmatch(exact) is None:
            raise CacheConfigurationError("nonce")
        return exact

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

    @_guarded_cache_operation
    def publish_object(self, cached: CachedObject) -> CachedObject:
        """Atomically insert a complete immutable object or reuse its valid winner."""

        cached = snapshot_cached_object(cached)
        self._validate_candidate(cached)
        destination = self.object_path(cached.digest)
        if os.path.lexists(destination):
            winner = self.get_object(cached.digest)
            if winner is None:
                raise CacheCorruptError(cached.digest)
            self._apply_configured_bounds()
            return winner

        temporary_root = self._ensure_cache_directory("tmp", expected_digest=cached.digest)
        if _windows_mode():
            private = Path(tempfile.mkdtemp(prefix="writer-python-", dir=temporary_root))
            writer_process_nonce = f"python-writer-{secrets.token_hex(16)}"
            self._register_process_identity(
                cached.digest,
                os.getpid(),
                writer_process_nonce,
            )
            writer_registration = self._open_process_registration_handle(
                cached.digest,
                os.getpid(),
                writer_process_nonce,
            )
            writer_heartbeat = self._start_process_registration_heartbeat(
                cached.digest,
                os.getpid(),
                writer_process_nonce,
            )
            private_consumed = False
            try:
                self._write_private_object(private, cached, writer_process_nonce)
                self._after_private_object(private, cached)
                destination_parent = self._ensure_cache_directory(
                    "objects",
                    "sha256",
                    cached.digest[7:9],
                    expected_digest=cached.digest,
                )
                try:
                    self._windows_publish_object_directory(private, destination)
                    private_consumed = True
                except FileExistsError as error:
                    winner = self.get_object(cached.digest)
                    if winner is None:
                        raise CacheCorruptError(cached.digest) from error
                    self._apply_configured_bounds()
                    return winner
                published = self.get_object(cached.digest)
                if published is None:
                    raise CacheCorruptError(cached.digest)
                self._apply_configured_bounds()
                return published
            except CacheCorruptError:
                raise
            except (OSError, ValueError) as error:
                raise CacheCorruptError(cached.digest) from error
            finally:
                self._windows_release_object_writer(
                    private,
                    private_consumed,
                    cached.digest,
                    writer_process_nonce,
                    writer_heartbeat,
                    writer_registration,
                )

        writer_process_nonce = f"python-writer-{secrets.token_hex(16)}"
        self._register_process_identity(
            cached.digest,
            os.getpid(),
            writer_process_nonce,
        )
        writer_registration = self._open_process_registration_handle(
            cached.digest,
            os.getpid(),
            writer_process_nonce,
        )
        writer_heartbeat = self._start_process_registration_heartbeat(
            cached.digest,
            os.getpid(),
            writer_process_nonce,
        )
        try:
            with _private_directory_generation(
                self.root,
                temporary_root,
                prefix="writer-python-",
                max_entries=self.max_scan_entries,
                max_depth=self.max_path_depth,
            ) as private:
                self._write_private_object_at(private, cached, writer_process_nonce)
                self._after_private_object(private.path, cached)
                private.parent.validate()
                destination_parent = self._ensure_cache_directory(
                    "objects",
                    "sha256",
                    cached.digest[7:9],
                    expected_digest=cached.digest,
                )
                with _anchored_directory_chain(
                    self.root,
                    destination_parent.relative_to(self.root).parts,
                ) as destination_chain:
                    private.parent.validate()
                    destination_chain.validate()
                    try:
                        os.rename(
                            private.name,
                            destination.name,
                            src_dir_fd=private.parent.descriptor,
                            dst_dir_fd=destination_chain.descriptor,
                        )
                    except OSError as error:
                        if error.errno not in {EEXIST, ENOTEMPTY}:
                            raise
                        winner = self.get_object(cached.digest)
                        if winner is None:
                            raise CacheCorruptError(cached.digest) from error
                        self._apply_configured_bounds()
                        return winner
                    private.parent.validate()
                    destination_chain.validate()
                    published_descriptor = _open_directory_entry_at(
                        destination_chain.descriptor,
                        destination.name,
                    )
                    try:
                        if _identity(os.fstat(published_descriptor)) != private.identity:
                            raise ValueError("published object generation")
                    finally:
                        os.close(published_descriptor)
                    _sync_directory_descriptor(destination_chain.descriptor)
            published = self.get_object(cached.digest)
            if published is None:
                raise CacheCorruptError(cached.digest)
            self._apply_configured_bounds()
            return published
        except CacheCorruptError:
            raise
        except (OSError, ValueError) as error:
            raise CacheCorruptError(cached.digest) from error
        finally:
            try:
                self._stop_process_registration_heartbeat(
                    writer_heartbeat,
                    cached.digest,
                )
            finally:
                self._remove_process_registration_handle(writer_registration)
                self._remove_process_registration_if_unused(
                    cached.digest,
                    os.getpid(),
                    writer_process_nonce,
                )

    def _windows_release_object_writer(
        self,
        private: Path,
        private_consumed: bool,
        digest: str,
        process_nonce: str,
        heartbeat: _ProcessRegistrationHeartbeat,
        registration: _ProcessRegistrationHandle,
    ) -> None:
        try:
            if not private_consumed and private.exists():
                try:
                    self._windows_cleanup_private_directory(private)
                except (OSError, ValueError) as error:
                    raise CacheCorruptError(digest) from error
        finally:
            try:
                self._stop_process_registration_heartbeat(heartbeat, digest)
            finally:
                try:
                    self._remove_process_registration_if_unused(
                        digest, os.getpid(), process_nonce,
                    )
                finally:
                    self._remove_process_registration_handle(registration)

    def _apply_configured_bounds(self) -> None:
        self.evict(
            max_bytes=self.max_bytes,
            max_age_seconds=self.max_age_seconds,
            lease_expiry_seconds=self.lease_expiry_seconds,
        )

    def _validate_candidate(self, cached: CachedObject) -> None:
        if not isinstance(cached.artifact, bytes) or len(cached.artifact) > self.max_artifact_bytes:
            raise CacheCorruptError(cached.digest)
        if not isinstance(cached.files, Mapping) or len(cached.files) > self.max_files_per_object:
            raise CacheCorruptError(cached.digest)
        if not isinstance(cached.media_types, Mapping) or any(
            not isinstance(path, str) or not is_unicode_scalar_string(media_type)
            for path, media_type in cached.media_types.items()
        ):
            raise CacheCorruptError(cached.digest)
        total = 0
        for path, content in cached.files.items():
            if (
                not isinstance(path, str)
                or not isinstance(content, bytes)
                or not is_portable_cache_path(path)
                or len(PurePosixPath(path).parts) > self.max_path_depth
            ):
                raise CacheCorruptError(cached.digest)
            if len(content) > self.max_file_bytes:
                raise CacheCorruptError(cached.digest)
            total += len(content)
            if total > self.max_extracted_bytes or total > MAX_SAFE_INTEGER:
                raise CacheCorruptError(cached.digest)
        validate_cached_object(cached, archive_verifier=self._archive_verifier)
        if len(self._serialize_object(cached)) > self.max_object_metadata_bytes:
            raise CacheCorruptError(cached.digest)

    def _write_private_object(
        self,
        private: Path,
        cached: CachedObject,
        process_nonce: str,
    ) -> None:
        writer = {
            "schema": "remote-skills-cache-writer-v1",
            "writer": "python",
            "pid": os.getpid(),
            "process_nonce": process_nonce,
            "expected_digest": cached.digest,
            "bytes_received": len(cached.artifact),
            "complete": True,
        }
        _write_file(private / "writer.json", _json_bytes(writer))
        _write_file(private / "artifact", cached.artifact)
        for relative, content in cached.files.items():
            path = private / "root" / Path(*PurePosixPath(relative).parts)
            _write_file(path, content)
        _write_file(private / "object.json", self._serialize_object(cached))
        (private / "writer.json").unlink()
        _sync_directory(private)

    def _write_private_object_at(
        self,
        private: _PrivateDirectoryGeneration,
        cached: CachedObject,
        process_nonce: str,
    ) -> None:
        writer = {
            "schema": "remote-skills-cache-writer-v1",
            "writer": "python",
            "pid": os.getpid(),
            "process_nonce": process_nonce,
            "expected_digest": cached.digest,
            "bytes_received": len(cached.artifact),
            "complete": True,
        }
        _write_file_at(private.descriptor, private.path, "writer.json", _json_bytes(writer))
        _write_file_at(private.descriptor, private.path, "artifact", cached.artifact)
        os.mkdir("root", 0o700, dir_fd=private.descriptor)
        root_descriptor = _open_directory_entry_at(private.descriptor, "root")
        try:
            for relative, content in cached.files.items():
                parts = PurePosixPath(relative).parts
                current_descriptor = root_descriptor
                current_path = private.path / "root"
                opened: list[int] = []
                try:
                    for part in parts[:-1]:
                        try:
                            os.mkdir(part, 0o700, dir_fd=current_descriptor)
                        except FileExistsError:
                            pass
                        child_descriptor = _open_directory_entry_at(
                            current_descriptor,
                            part,
                        )
                        opened.append(child_descriptor)
                        current_descriptor = child_descriptor
                        current_path = current_path / part
                    _write_file_at(
                        current_descriptor,
                        current_path,
                        parts[-1],
                        content,
                    )
                finally:
                    for descriptor in reversed(opened):
                        os.close(descriptor)
            _sync_directory_descriptor(root_descriptor)
        finally:
            os.close(root_descriptor)
        _write_file_at(
            private.descriptor,
            private.path,
            "object.json",
            self._serialize_object(cached),
        )
        os.unlink("writer.json", dir_fd=private.descriptor)
        _sync_directory_descriptor(private.descriptor)

    def _after_private_object(self, private: Path, cached: CachedObject) -> None:
        del private, cached

    def _serialize_object(self, cached: CachedObject) -> bytes:
        file_values = [
            {
                "path": path,
                "size": len(content),
                "media_type": cached.media_types[path],
            }
            for path, content in sorted(
                cached.files.items(),
                key=lambda item: item[0].encode("utf-8"),
            )
        ]
        files = ", ".join(
            "{ "
            + ", ".join(
                f"{json.dumps(key)}: {json.dumps(value, ensure_ascii=False)}"
                for key, value in file_value.items()
            )
            + " }"
            for file_value in file_values
        )
        values: list[tuple[str, object]] = [
            ("schema", "remote-skills-object-metadata-v1"),
            ("digest", cached.digest),
            ("artifact_type", cached.artifact_type),
            ("archive_format", cached.archive_format),
            ("artifact_bytes", len(cached.artifact)),
            ("extracted_bytes", sum(len(content) for content in cached.files.values())),
        ]
        lines = ["{"]
        lines.extend(
            f"  {json.dumps(key)}: {json.dumps(value, ensure_ascii=False)}," for key, value in values
        )
        lines.append(f'  "files": [{files}],')
        lines.append(
            f'  "verified_at": {json.dumps(_format_timestamp(cached.verified_at))},'
        )
        lines.append(f'  "accessed_at": {json.dumps(_format_timestamp(cached.accessed_at))}')
        lines.append("}")
        return ("\n".join(lines) + "\n").encode("utf-8")

    def _read_object(
        self,
        object_descriptor: int | None,
        object_path: Path,
        digest: str,
    ) -> CachedObject:
        names = _bounded_directory_names(
            object_descriptor,
            object_path,
            max_entries=3,
        )
        if set(names) != {"artifact", "object.json", "root"}:
            raise ValueError("object inventory")
        metadata, expected_sizes = self._read_object_metadata(
            object_descriptor,
            object_path,
            digest,
        )

        artifact, _, artifact_digest = _read_regular_file_snapshot_at(
            object_descriptor,
            object_path,
            "artifact",
            max_bytes=self.max_artifact_bytes,
            expected_size=metadata["artifact_bytes"],
            calculate_sha256=True,
        )
        if artifact_digest != digest[7:]:
            raise ValueError("artifact integrity")

        inventory = _root_file_inventory(
            object_descriptor,
            object_path,
            expected_sizes=expected_sizes,
            max_files=self.max_files_per_object,
            max_depth=self.max_path_depth,
            max_file_bytes=self.max_file_bytes,
            max_extracted_bytes=self.max_extracted_bytes,
            max_entries=self.max_scan_entries,
        )
        files = {entry["path"]: inventory[entry["path"]] for entry in metadata["files"]}
        media_types = {
            entry["path"]: entry["media_type"] for entry in metadata["files"]
        }
        if set(inventory) != set(files):
            raise ValueError("unlisted root file")
        if metadata["artifact_type"] == "skill-md" and files != {"SKILL.md": artifact}:
            raise ValueError("skill-md root differs from artifact")

        cached = CachedObject(
            digest=digest,
            artifact_type=metadata["artifact_type"],
            archive_format=metadata["archive_format"],
            artifact=artifact,
            files=files,
            media_types=media_types,
            verified_at=_parse_timestamp(metadata["verified_at"]),
            accessed_at=_parse_timestamp(metadata["accessed_at"]),
        )
        validate_cached_object(cached, archive_verifier=self._archive_verifier)
        return cached

    def _read_object_metadata(
        self,
        object_descriptor: int | None,
        object_path: Path,
        digest: str,
    ) -> tuple[dict[str, Any], dict[str, int]]:
        metadata: Any = _parse_cache_json(
            _read_regular_file(
                object_descriptor,
                object_path,
                "object.json",
                max_bytes=self.max_object_metadata_bytes,
                descriptor_anchored=True,
            )
        )
        if not isinstance(metadata, dict) or set(metadata) != _OBJECT_KEYS:
            raise ValueError("object schema")
        if metadata["schema"] != "remote-skills-object-metadata-v1" or metadata["digest"] != digest:
            raise ValueError("object identity")
        if not is_supported_artifact_contract(
            metadata["artifact_type"],
            metadata["archive_format"],
        ):
            raise ValueError("artifact metadata")
        artifact_bytes = _integer(metadata["artifact_bytes"])
        if artifact_bytes > self.max_artifact_bytes:
            raise ValueError("artifact limit")
        extracted_bytes = _integer(metadata["extracted_bytes"])
        if extracted_bytes > self.max_extracted_bytes:
            raise ValueError("extracted limit")
        _parse_timestamp(metadata["verified_at"])
        _parse_timestamp(metadata["accessed_at"])

        file_entries = metadata["files"]
        if not isinstance(file_entries, list) or len(file_entries) > self.max_files_per_object:
            raise ValueError("file table")
        expected_sizes: dict[str, int] = {}
        folded_paths: set[str] = set()
        ordered_paths: list[str] = []
        total_size = 0
        for entry in file_entries:
            if not isinstance(entry, dict) or set(entry) != _FILE_KEYS:
                raise ValueError("file schema")
            relative = _normalized_file_path(entry["path"])
            folded = pinned_unicode_15_casefold(relative)
            if (
                relative in expected_sizes
                or folded in folded_paths
                or not is_unicode_scalar_string(entry["media_type"])
                or len(PurePosixPath(relative).parts) > self.max_path_depth
            ):
                raise ValueError("file identity")
            size = _integer(entry["size"])
            if size > self.max_file_bytes:
                raise ValueError("file size")
            expected_sizes[relative] = size
            ordered_paths.append(relative)
            folded_paths.add(folded)
            total_size += size
            if total_size > MAX_SAFE_INTEGER or total_size > self.max_extracted_bytes:
                raise ValueError("extracted size")
        if total_size != extracted_bytes:
            raise ValueError("extracted size")
        if ordered_paths != sorted(ordered_paths, key=lambda path: path.encode("utf-8")):
            raise ValueError("noncanonical file order")
        return metadata, expected_sizes


def _json_bytes(value: object) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def _write_file(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("xb") as handle:
        handle.write(content)
        handle.flush()
        os.fsync(handle.fileno())


def _write_file_at(
    directory_descriptor: int | None,
    directory_path: Path,
    name: str,
    content: bytes,
) -> None:
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_CLOEXEC", 0)
    flags |= getattr(os, "O_NOFOLLOW", 0)
    if directory_descriptor is not None and os.open in os.supports_dir_fd:
        descriptor = os.open(name, flags, 0o600, dir_fd=directory_descriptor)
    else:
        descriptor = os.open(directory_path / name, flags, 0o600)
    with os.fdopen(descriptor, "wb") as handle:
        handle.write(content)
        handle.flush()
        os.fsync(handle.fileno())


def _atomic_create_file_at(
    directory_descriptor: int | None,
    directory_path: Path,
    name: str,
    content: bytes,
) -> None:
    temporary_name = f".{name}-{secrets.token_hex(16)}.tmp"
    _write_file_at(directory_descriptor, directory_path, temporary_name, content)
    try:
        if directory_descriptor is not None and os.link in os.supports_dir_fd:
            os.link(
                temporary_name,
                name,
                src_dir_fd=directory_descriptor,
                dst_dir_fd=directory_descriptor,
                follow_symlinks=False,
            )
            _sync_directory_descriptor(directory_descriptor)
        else:
            os.link(
                directory_path / temporary_name,
                directory_path / name,
                follow_symlinks=False,
            )
            _sync_directory(directory_path)
    finally:
        try:
            _unlink_at(directory_descriptor, directory_path, temporary_name)
        except FileNotFoundError:
            pass


def _read_descriptor(descriptor: int, *, max_bytes: int) -> bytes:
    if os.fstat(descriptor).st_size > max_bytes:
        raise ValueError("file size")
    os.lseek(descriptor, 0, os.SEEK_SET)
    chunks: list[bytes] = []
    total = 0
    while True:
        remaining = max_bytes - total
        chunk = os.read(
            descriptor,
            min(1024 * 1024, remaining) if remaining > 0 else 1,
        )
        if not chunk:
            break
        if total + len(chunk) > max_bytes:
            raise ValueError("file grew beyond limit")
        chunks.append(chunk)
        total += len(chunk)
    return b"".join(chunks)


def _lock_descriptor(descriptor: int) -> None:
    if os.name == "nt":
        import msvcrt

        os.lseek(descriptor, 0, os.SEEK_SET)
        msvcrt.locking(descriptor, msvcrt.LK_LOCK, 1)
        return
    import fcntl

    fcntl.flock(descriptor, fcntl.LOCK_EX)


def _unlock_descriptor(descriptor: int) -> None:
    if os.name == "nt":
        import msvcrt

        os.lseek(descriptor, 0, os.SEEK_SET)
        msvcrt.locking(descriptor, msvcrt.LK_UNLCK, 1)
        return
    import fcntl

    fcntl.flock(descriptor, fcntl.LOCK_UN)


@contextmanager
def _locked_regular_file_at(
    directory_descriptor: int | None,
    directory_path: Path,
    name: str,
):
    path = directory_path / name
    expected = path.lstat()
    if not stat.S_ISREG(expected.st_mode):
        raise ValueError("regular file")
    flags = os.O_RDWR | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    if directory_descriptor is not None and os.open in os.supports_dir_fd:
        descriptor = os.open(name, flags, dir_fd=directory_descriptor)
    else:
        descriptor = os.open(path, flags)
    try:
        actual = os.fstat(descriptor)
        if not stat.S_ISREG(actual.st_mode) or _identity(expected) != _identity(actual):
            raise ValueError("file identity")
        _lock_descriptor(descriptor)
        try:
            yield descriptor, actual
        finally:
            _unlock_descriptor(descriptor)
    finally:
        os.close(descriptor)


def _entry_matches_descriptor(
    directory_descriptor: int | None,
    directory_path: Path,
    name: str,
    descriptor: int,
    *,
    expected: os.stat_result | None = None,
) -> bool:
    try:
        if directory_descriptor is not None and os.stat in os.supports_dir_fd:
            current = os.stat(name, dir_fd=directory_descriptor, follow_symlinks=False)
        else:
            current = (directory_path / name).lstat()
        opened = os.fstat(descriptor)
        if _identity(current) != _identity(opened):
            return False
        return expected is None or (
            _file_generation(current)
            == _file_generation(opened)
            == _file_generation(expected)
        )
    except OSError:
        return False


def _unlink_at(directory_descriptor: int | None, directory_path: Path, name: str) -> None:
    if directory_descriptor is not None and os.unlink in os.supports_dir_fd:
        os.unlink(name, dir_fd=directory_descriptor)
    else:
        (directory_path / name).unlink()


def _atomic_replace_file_at(
    directory_descriptor: int | None,
    directory_path: Path,
    name: str,
    content: bytes,
) -> None:
    temporary_name = f".{name}-{secrets.token_hex(16)}"
    _write_file_at(directory_descriptor, directory_path, temporary_name, content)
    try:
        if directory_descriptor is not None and os.rename in os.supports_dir_fd:
            os.rename(
                temporary_name,
                name,
                src_dir_fd=directory_descriptor,
                dst_dir_fd=directory_descriptor,
            )
            _sync_directory_descriptor(directory_descriptor)
        else:
            os.replace(directory_path / temporary_name, directory_path / name)
            _sync_directory(directory_path)
    finally:
        try:
            _unlink_at(directory_descriptor, directory_path, temporary_name)
        except FileNotFoundError:
            pass


def _sync_directory(path: Path) -> None:
    if not hasattr(os, "O_DIRECTORY"):
        return
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        try:
            os.fsync(descriptor)
        except OSError as error:
            if error.errno not in {EINVAL, ENOTSUP}:
                raise
    finally:
        os.close(descriptor)


def _sync_directory_descriptor(descriptor: int) -> None:
    try:
        os.fsync(descriptor)
    except OSError as error:
        if error.errno not in {EINVAL, ENOTSUP}:
            raise


def _atomic_replace_file(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}-", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        _sync_directory(path.parent)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass

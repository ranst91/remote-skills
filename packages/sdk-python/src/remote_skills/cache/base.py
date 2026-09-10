"""Semantic seam for application-supplied cache implementations."""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Mapping
from datetime import datetime, timedelta, timezone
from pathlib import PurePosixPath, PureWindowsPath
from typing import Callable, Protocol, TypeAlias, runtime_checkable
from urllib.parse import unquote_plus, urlsplit

from ..catalog_scope import is_valid_scope
from .errors import CacheConfigurationError, CacheCorruptError
from .models import (
    CacheLease,
    CachedCatalog,
    CachedObject,
    CatalogGeneration,
    CatalogMetadata,
    CatalogState,
)
from .unicode_casefold import pinned_unicode_15_casefold
from .unicode_normalization import pinned_unicode_15_nfc


_DIGEST_PATTERN = re.compile(r"sha256:([0-9a-f]{64})\Z")
_CATALOG_IDENTIFIER_PATTERN = re.compile(r"[0-9a-f]{64}\Z")
_SENSITIVE_CATALOG_KEYS = {
    "access-key",
    "access-key-id",
    "access-token",
    "access_token",
    "api-key",
    "api_key",
    "apikey",
    "authorization",
    "authorization-code",
    "authorization_code",
    "bearer-token",
    "bearer_token",
    "client-assertion",
    "client-secret",
    "client_assertion",
    "client_secret",
    "cookie",
    "credential",
    "credentials",
    "device-code",
    "device_code",
    "fragment",
    "headers",
    "id-token",
    "id_token",
    "key",
    "oauth-signature",
    "oauth-token",
    "oauth-token-secret",
    "oauth-verifier",
    "oauth_signature",
    "oauth_token",
    "oauth_token_secret",
    "oauth_verifier",
    "password",
    "proxy-authorization",
    "query",
    "refresh-token",
    "refresh_token",
    "secret",
    "secret-access-key",
    "secret-key",
    "security-token",
    "session-token",
    "set-cookie",
    "sig",
    "signature",
    "subscription-key",
    "subscription_key",
    "token",
    "user-code",
    "user_code",
    "x-amz-credential",
    "aws-access-key-id",
    "aws-secret-access-key",
    "x-amz-security-token",
    "x-amz-signature",
    "x-api-key",
    "x-goog-api-key",
    "x-goog-credential",
    "x-goog-signature",
}
_MAX_CREDENTIAL_NAME_CODEPOINTS = 256
_SENSITIVE_CATALOG_KEY_COMPACT_FORMS = frozenset(
    key.replace("-", "").replace("_", "") for key in _SENSITIVE_CATALOG_KEYS
)
_URL_CATALOG_KEYS = {"canonical_url", "href", "uri", "url"}
ArchiveVerifier: TypeAlias = Callable[[CachedObject], bool]
MAX_SAFE_INTEGER = 2**53 - 1
DEFAULT_MAX_CATALOG_ENTRIES = 100_000
DEFAULT_MAX_CATALOG_DEPTH = 64
_SUPPORTED_ARCHIVE_FORMATS = frozenset({"tar.gz", "zip"})
MAX_PORTABLE_PATH_CODEPOINTS = 4096
MAX_PORTABLE_PATH_UTF8_BYTES = 4096
MAX_PORTABLE_SEGMENT_UTF8_BYTES = 255
_WINDOWS_FORBIDDEN_CHARACTERS = frozenset('<>:"\\|?*')
_WINDOWS_RESERVED_BASENAMES = frozenset(
    {
        "aux",
        "con",
        "conin$",
        "conout$",
        "nul",
        "prn",
        *(f"com{suffix}" for suffix in "123456789¹²³"),
        *(f"lpt{suffix}" for suffix in "123456789¹²³"),
    }
)


def catalog_absence_generation(
    identifier: str, epoch: int
) -> CatalogGeneration:
    """Derive the portable opaque generation for an absent catalog state."""

    identifier = snapshot_unicode_scalar_string(identifier)
    if _CATALOG_IDENTIFIER_PATTERN.fullmatch(identifier) is None:
        raise CacheConfigurationError("catalog_identifier")
    validate_nonnegative_safe_integer(epoch, "catalog_generation")
    framed = f"remote-skills-catalog-absence-v1\n{identifier}\n{epoch}\n".encode(
        "utf-8"
    )
    return CatalogGeneration(f"sha256:{hashlib.sha256(framed).hexdigest()}")


def validate_catalog_generation(value: object) -> CatalogGeneration:
    """Snapshot one exact portable catalog generation token."""

    token: object = None
    if isinstance(value, CatalogGeneration):
        try:
            token = value.token
        except Exception:
            pass
    if not isinstance(token, str):
        raise CacheConfigurationError("catalog_generation")
    exact = token if type(token) is str else str.__str__(token)
    if _DIGEST_PATTERN.fullmatch(exact) is None:
        raise CacheConfigurationError("catalog_generation")
    return CatalogGeneration(exact)


def is_unicode_scalar_string(value: object) -> bool:
    """Return whether value is a string containing only Unicode scalars."""

    if not isinstance(value, str):
        return False
    exact = value if type(value) is str else str.__str__(value)
    return not any(0xD800 <= ord(character) <= 0xDFFF for character in exact)


def snapshot_unicode_scalar_string(value: object) -> str:
    """Return an exact built-in scalar string without invoking subclass hooks."""

    if not isinstance(value, str):
        raise CacheCorruptError()
    exact = value if type(value) is str else str.__str__(value)
    if any(0xD800 <= ord(character) <= 0xDFFF for character in exact):
        raise CacheCorruptError()
    return exact


def _snapshot_string(value: object) -> object:
    if isinstance(value, str) and type(value) is not str:
        return str.__str__(value)
    return value


def _snapshot_bytes(value: object) -> object:
    if isinstance(value, bytes) and type(value) is not bytes:
        return bytes.__bytes__(value)
    return value


def _snapshot_datetime(value: object) -> object:
    if not isinstance(value, datetime):
        return value
    normalized: datetime | None = None
    try:
        if datetime.utcoffset(value) is not None:
            utc_value = datetime.astimezone(value, timezone.utc)
            normalized = datetime(
                utc_value.year,
                utc_value.month,
                utc_value.day,
                utc_value.hour,
                utc_value.minute,
                utc_value.second,
                (utc_value.microsecond // 1000) * 1000,
                tzinfo=timezone.utc,
            )
    except Exception:
        pass
    if normalized is None:
        raise CacheCorruptError()
    return normalized


def _snapshot_integer(value: object) -> object:
    if isinstance(value, int) and not isinstance(value, bool) and type(value) is not int:
        return int.__int__(value)
    return value


def snapshot_cache_lease(lease: CacheLease) -> CacheLease:
    """Snapshot a lease handle before it participates in lookup or mutation."""

    if not isinstance(lease, CacheLease):
        raise CacheConfigurationError("lease")
    snapshot: CacheLease | None = None
    try:
        snapshot = CacheLease(
            digest=_snapshot_string(lease.digest),
            pid=_snapshot_integer(lease.pid),
            process_nonce=_snapshot_string(lease.process_nonce),
            session_nonce=_snapshot_string(lease.session_nonce),
            created_at=_snapshot_datetime(lease.created_at),
            renewed_at=_snapshot_datetime(lease.renewed_at),
            lease_nonce=(
                None
                if lease.lease_nonce is None
                else _snapshot_string(lease.lease_nonce)
            ),
        )
    except Exception:
        pass
    if snapshot is None:
        raise CacheCorruptError()
    return snapshot


def validate_catalog_lookup_url(value: object) -> str:
    """Return the exact credential-free canonical URL used as a catalog key."""

    parsed = None
    port = None
    try:
        exact = snapshot_unicode_scalar_string(value)
        parsed = urlsplit(exact)
        port = parsed.port
    except Exception:
        pass
    if parsed is None:
        raise CacheConfigurationError("canonical_url")
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or "?" in exact
        or "#" in exact
        or parsed.query
        or parsed.fragment
        or parsed.path == ""
        or not parsed.path.startswith("/")
    ):
        raise CacheConfigurationError("canonical_url")
    host = parsed.hostname
    if ":" in host:
        host = f"[{host}]"
    if port is not None:
        if (parsed.scheme, port) in {("http", 80), ("https", 443)}:
            raise CacheConfigurationError("canonical_url")
        host = f"{host}:{port}"
    canonical = f"{parsed.scheme}://{host}{parsed.path}"
    if exact != canonical:
        raise CacheConfigurationError("canonical_url")
    return exact


def snapshot_cached_object(cached: CachedObject) -> CachedObject:
    """Snapshot cache publication input into exact built-in scalar values."""

    try:
        return CachedObject(
            digest=_snapshot_string(cached.digest),
            artifact_type=_snapshot_string(cached.artifact_type),
            archive_format=(
                None
                if cached.archive_format is None
                else _snapshot_string(cached.archive_format)
            ),
            artifact=_snapshot_bytes(cached.artifact),
            files={
                _snapshot_string(path): _snapshot_bytes(content)
                for path, content in cached.files.items()
            },
            media_types={
                _snapshot_string(path): _snapshot_string(media_type)
                for path, media_type in cached.media_types.items()
            },
            verified_at=_snapshot_datetime(cached.verified_at),
            accessed_at=_snapshot_datetime(cached.accessed_at),
        )
    except CacheCorruptError:
        raise
    except Exception:
        raise CacheCorruptError() from None


def snapshot_cached_catalog(catalog: CachedCatalog) -> CachedCatalog:
    """Snapshot catalog publication input into exact built-in scalar values."""

    try:
        metadata = catalog.metadata
        return CachedCatalog(
            body=_snapshot_bytes(catalog.body),
            metadata=CatalogMetadata(
                canonical_url=_snapshot_string(metadata.canonical_url),
                retrieved_at=_snapshot_datetime(metadata.retrieved_at),
                validated_at=_snapshot_datetime(metadata.validated_at),
                confirmed_scope=(
                    None
                    if metadata.confirmed_scope is None
                    else _snapshot_string(metadata.confirmed_scope)
                ),
                etag=(
                    None if metadata.etag is None else _snapshot_string(metadata.etag)
                ),
                last_modified=(
                    None
                    if metadata.last_modified is None
                    else _snapshot_string(metadata.last_modified)
                ),
                cache_control=(
                    None
                    if metadata.cache_control is None
                    else _snapshot_string(metadata.cache_control)
                ),
            ),
        )
    except CacheCorruptError:
        raise
    except Exception:
        raise CacheCorruptError() from None


def is_supported_artifact_contract(
    artifact_type: object,
    archive_format: object,
) -> bool:
    """Return whether cache-v1 artifact metadata is in the closed v0 vocabulary."""

    if type(artifact_type) is not str:
        return False
    return (artifact_type == "skill-md" and archive_format is None) or (
        artifact_type == "archive"
        and type(archive_format) is str
        and archive_format in _SUPPORTED_ARCHIVE_FORMATS
    )


def is_portable_cache_path(value: object) -> bool:
    """Apply the pinned publisher/cache portable relative-path contract."""

    if not is_unicode_scalar_string(value):
        return False
    value = value if type(value) is str else str.__str__(value)
    if len(value) > MAX_PORTABLE_PATH_CODEPOINTS:
        return False
    encoded = value.encode("utf-8")
    if len(encoded) > MAX_PORTABLE_PATH_UTF8_BYTES:
        return False
    parts = value.split("/")
    if any(
        not part or len(part.encode("utf-8")) > MAX_PORTABLE_SEGMENT_UTF8_BYTES
        for part in parts
    ):
        return False
    if (
        not value
        or value.startswith("/")
        or pinned_unicode_15_nfc(value) != value
        or bool(PureWindowsPath(value).drive)
        or any(
            ord(character) < 0x20
            or ord(character) == 0x7F
            or character in _WINDOWS_FORBIDDEN_CHARACTERS
            for character in value
        )
    ):
        return False
    normalized = PurePosixPath(value)
    if normalized.is_absolute() or normalized.as_posix() != value:
        return False
    for part in parts:
        if (
            part in {".", ".."}
            or part.endswith((".", " "))
        ):
            return False
        basename = part.split(".", 1)[0].rstrip(" .")
        if pinned_unicode_15_casefold(basename) in _WINDOWS_RESERVED_BASENAMES:
            return False
    return True


def validate_nonnegative_safe_integer(value: object, field: str) -> int:
    """Validate public cache limits before any backend mutation."""

    value = _snapshot_integer(value)
    if (
        type(value) is not int
        or isinstance(value, bool)
        or value < 0
        or value > MAX_SAFE_INTEGER
    ):
        raise CacheConfigurationError(field)
    return value


def validate_digest(value: object) -> str:
    try:
        exact = snapshot_unicode_scalar_string(value)
    except CacheCorruptError:
        raise ValueError("digest must be lowercase sha256") from None
    if _DIGEST_PATTERN.fullmatch(exact) is None:
        raise ValueError("digest must be lowercase sha256")
    return exact


def validate_process_id(value: object) -> int:
    selected = validate_nonnegative_safe_integer(value, "pid")
    if selected == 0:
        raise CacheConfigurationError("pid")
    return selected


def _canonical_lease_timestamp(value: datetime) -> datetime:
    try:
        value = _snapshot_datetime(value)
    except Exception:
        raise CacheCorruptError() from None
    if not isinstance(value, datetime):
        raise ValueError("timestamp must be a datetime")
    if value.tzinfo is None:
        raise ValueError("timestamp must be timezone-aware")
    normalized = value.astimezone(timezone.utc)
    return normalized.replace(microsecond=(normalized.microsecond // 1000) * 1000)


def _next_lease_timestamp(now: datetime, current: datetime) -> datetime:
    candidate = _canonical_lease_timestamp(now)
    if candidate > current:
        return candidate
    try:
        return current + timedelta(milliseconds=1)
    except OverflowError as error:
        raise CacheCorruptError() from error


def _catalog_body_contains_credentials(
    value: object,
    *,
    max_entries: int = DEFAULT_MAX_CATALOG_ENTRIES,
    max_depth: int = DEFAULT_MAX_CATALOG_DEPTH,
) -> bool:
    pending: list[tuple[object, str, int]] = [(value, "", 0)]
    entries = 0
    while pending:
        item, parent_key, depth = pending.pop()
        entries += 1
        if entries > max_entries or depth > max_depth:
            raise ValueError("catalog traversal limit")
        if isinstance(item, dict):
            if item and (
                depth >= max_depth
                or entries + len(pending) + len(item) > max_entries
            ):
                raise ValueError("catalog traversal limit")
            for key, child in item.items():
                normalized_key = str(key).casefold()
                if _is_sensitive_catalog_key(normalized_key):
                    return True
                pending.append((child, normalized_key, depth + 1))
        elif isinstance(item, list):
            if item and (
                depth >= max_depth
                or entries + len(pending) + len(item) > max_entries
            ):
                raise ValueError("catalog traversal limit")
            pending.extend((child, parent_key, depth + 1) for child in item)
        elif isinstance(item, str):
            parsed = urlsplit(item)
            known_url_field = parent_key in _URL_CATALOG_KEYS
            looks_like_uri_reference = known_url_field or (
                not any(character.isspace() for character in item)
                and (
                    bool(parsed.scheme)
                    or bool(parsed.netloc)
                    or item.startswith(("/", "./", "../", "?", "#"))
                    or bool(parsed.query)
                    or bool(parsed.fragment)
                )
            )
            if not looks_like_uri_reference:
                continue
            if parsed.username is not None or parsed.password is not None:
                return True
            if known_url_field and (parsed.query or parsed.fragment):
                return True
            for component in (parsed.query, parsed.fragment):
                for member in component.replace(";", "&").split("&"):
                    key = member.partition("=")[0]
                    if _is_sensitive_catalog_key(key):
                        return True
    return False


def _is_sensitive_catalog_key(value: str) -> bool:
    if len(value) > _MAX_CREDENTIAL_NAME_CODEPOINTS:
        return False
    normalized = unquote_plus(value).casefold()
    if normalized in _SENSITIVE_CATALOG_KEYS:
        return True
    compact = normalized.replace("-", "").replace("_", "")
    return compact in _SENSITIVE_CATALOG_KEY_COMPACT_FORMS


def _parse_cache_json(value: bytes | str) -> object:
    """Strictly parse untrusted cache JSON without retaining its source bytes."""

    missing = object()
    parsed: object = missing

    def reject_duplicate_members(pairs: list[tuple[str, object]]) -> dict[str, object]:
        result: dict[str, object] = {}
        for key, item in pairs:
            if key in result:
                raise ValueError("duplicate catalog member")
            result[key] = item
        return result

    def reject_nonfinite_constant(value: str) -> object:
        del value
        raise ValueError("non-finite cache number")

    try:
        parsed = json.loads(
            value,
            object_pairs_hook=reject_duplicate_members,
            parse_constant=reject_nonfinite_constant,
        )
    except (UnicodeError, ValueError, TypeError, RecursionError):
        pass
    if parsed is missing:
        raise ValueError("cache JSON")
    return parsed


def validate_cached_catalog(catalog: CachedCatalog) -> None:
    """Enforce the credential-free catalog storage boundary for every backend."""

    canonical_url = catalog.metadata.canonical_url
    if not isinstance(canonical_url, str):
        raise CacheConfigurationError("canonical_url")
    if not is_unicode_scalar_string(canonical_url):
        raise CacheCorruptError()
    validate_catalog_lookup_url(canonical_url)
    if catalog.metadata.confirmed_scope is not None and not is_valid_scope(
        catalog.metadata.confirmed_scope
    ):
        raise CacheConfigurationError("confirmed_scope")
    if not isinstance(catalog.body, bytes):
        raise CacheConfigurationError("catalog_body")
    body_parsed = True
    try:
        body = _parse_cache_json(catalog.body)
    except ValueError:
        body_parsed = False
        body = None
    if not body_parsed:
        raise CacheCorruptError()
    try:
        contains_credentials = _catalog_body_contains_credentials(body)
    except ValueError:
        contains_credentials = None
    if contains_credentials is None:
        raise CacheCorruptError()
    if contains_credentials:
        raise CacheConfigurationError("catalog_body")
    for field in ("etag", "last_modified", "cache_control"):
        value = getattr(catalog.metadata, field)
        if value is not None and not isinstance(value, str):
            raise CacheConfigurationError(field)
        if value is not None and not is_unicode_scalar_string(value):
            raise CacheCorruptError()
    for field in ("retrieved_at", "validated_at"):
        value = getattr(catalog.metadata, field)
        if not isinstance(value, datetime) or value.utcoffset() is None:
            raise CacheConfigurationError(field)


def validate_cached_object(
    cached: CachedObject,
    *,
    archive_verifier: ArchiveVerifier | None = None,
) -> None:
    """Validate content identity and normalized immutable file semantics."""

    match = (
        _DIGEST_PATTERN.fullmatch(cached.digest)
        if isinstance(cached.digest, str)
        else None
    )
    if (
        not isinstance(cached.files, Mapping)
        or not isinstance(cached.media_types, Mapping)
        or any(
            not isinstance(path, str) or not isinstance(content, bytes)
            for path, content in cached.files.items()
        )
        or any(
            not isinstance(path, str) or not isinstance(media_type, str)
            for path, media_type in cached.media_types.items()
        )
    ):
        raise CacheCorruptError(cached.digest)
    if (
        match is None
        or not isinstance(cached.artifact, bytes)
        or hashlib.sha256(cached.artifact).hexdigest() != match.group(1)
        or set(cached.files) != set(cached.media_types)
        or not is_supported_artifact_contract(
            cached.artifact_type,
            cached.archive_format,
        )
        or not isinstance(cached.verified_at, datetime)
        or cached.verified_at.utcoffset() is None
        or not isinstance(cached.accessed_at, datetime)
        or cached.accessed_at.utcoffset() is None
    ):
        raise CacheCorruptError(cached.digest)
    folded_paths: set[str] = set()
    for path, content in cached.files.items():
        if (
            not is_portable_cache_path(path)
            or pinned_unicode_15_casefold(path) in folded_paths
            or not isinstance(content, bytes)
            or not is_unicode_scalar_string(cached.media_types[path])
        ):
            raise CacheCorruptError(cached.digest)
        folded_paths.add(pinned_unicode_15_casefold(path))
    if cached.artifact_type == "skill-md":
        if cached.files != {"SKILL.md": cached.artifact}:
            raise CacheCorruptError(cached.digest)
        return
    if archive_verifier is None:
        raise CacheCorruptError(cached.digest)
    try:
        verified = archive_verifier(cached)
    except Exception:
        verified = False
    if verified is not True:
        raise CacheCorruptError(cached.digest)


@runtime_checkable
class CacheBackend(Protocol):
    """Catalog, immutable-object, and session-pin semantics required by activation."""

    def get_catalog(
        self, canonical_url: str, *, confirmed_scope: str | None = None
    ) -> CachedCatalog | None: ...

    def get_catalog_state(
        self, canonical_url: str, *, confirmed_scope: str | None = None
    ) -> CatalogState: ...

    def publish_catalog(self, catalog: CachedCatalog) -> CachedCatalog: ...

    def replace_catalog(
        self,
        catalog: CachedCatalog,
        *,
        expected_generation: CatalogGeneration,
    ) -> bool:
        """Publish only when the persistent generation still equals expected."""
        ...

    def delete_catalog(
        self,
        canonical_url: str,
        *,
        confirmed_scope: str | None,
        expected_generation: CatalogGeneration,
    ) -> bool:
        """Delete only the exact scoped persistent generation supplied."""
        ...

    def get_object(self, digest: str) -> CachedObject | None: ...

    def publish_object(self, cached: CachedObject) -> CachedObject: ...

    def acquire_lease(
        self,
        digest: str,
        *,
        process_nonce: str,
        session_nonce: str,
        pid: int | None = None,
    ) -> CacheLease: ...

    def renew_lease(self, lease: CacheLease) -> CacheLease: ...

    def release_lease(self, lease: CacheLease) -> None: ...

    def has_live_lease(self, digest: str, *, lease_expiry_seconds: int = 120) -> bool: ...

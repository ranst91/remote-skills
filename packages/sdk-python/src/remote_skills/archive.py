"""Bounded, fail-closed tar-gzip and ZIP normalization."""

from __future__ import annotations

import gzip
import io
import stat
import struct
import tarfile
import zipfile
import zlib

from .cache.base import is_portable_cache_path
from .cache.unicode_casefold import pinned_unicode_15_casefold
from .catalog_errors import CatalogError


_MEDIA_TYPES = {
    "md": "text/markdown",
    "txt": "text/plain",
    "json": "application/json",
    "yaml": "application/yaml",
    "yml": "application/yaml",
    "html": "text/html",
    "css": "text/css",
    "js": "text/javascript",
    "mjs": "text/javascript",
    "ts": "text/typescript",
    "svg": "image/svg+xml",
    "png": "image/png",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "gif": "image/gif",
    "pdf": "application/pdf",
}


def _unsafe(path: str | None = None) -> CatalogError:
    context: dict[str, object] = {}
    if path is not None:
        context["path"] = path
    return CatalogError("archive_unsafe", retryable=False, context=context)


def _limit(name: str) -> CatalogError:
    return CatalogError(
        "limit_exceeded", retryable=False, context={"limit": name}
    )


def media_type_for_path(path: str) -> str:
    # Match the TypeScript consumer's final basename extension, including dotfiles.
    stem, _, extension = path.rsplit("/", 1)[-1].rpartition(".")
    return _MEDIA_TYPES.get(extension.lower() if stem else "", "application/octet-stream")


class _PathTable:
    def __init__(self) -> None:
        self.exact: set[str] = set()
        self.folded: dict[str, bool] = {}
        self.implicit_directories: set[str] = set()

    def add(self, path: str, *, directory: bool = False) -> str:
        candidate = path[:-1] if directory and path.endswith("/") else path
        if not candidate or not is_portable_cache_path(candidate):
            raise _unsafe(path)
        folded = pinned_unicode_15_casefold(candidate)
        if candidate in self.exact or folded in self.folded:
            raise _unsafe(path)
        parts = candidate.split("/")
        for index in range(1, len(parts)):
            ancestor = pinned_unicode_15_casefold("/".join(parts[:index]))
            if self.folded.get(ancestor) is False:
                raise _unsafe(path)
            self.implicit_directories.add(ancestor)
        if not directory and folded in self.implicit_directories:
            raise _unsafe(path)
        self.exact.add(candidate)
        self.folded[folded] = directory
        return candidate


def _tar_size(size_field: bytes) -> int:
    # Support the ordinary TAR octal field, not signed or binary extensions.
    if len(size_field) != 12:
        raise _unsafe()
    digits = size_field.rstrip(b"\0 ").lstrip(b" ")
    if any(digit < ord("0") or digit > ord("7") for digit in digits):
        raise _unsafe()
    return int(digits, 8) if digits else 0


def _next_tar_cursor(cursor: int, size: int, raw_length: int) -> int:
    if (
        size < 0
        or cursor < 0
        or cursor % 512 != 0
        or raw_length % 512 != 0
        or cursor + 512 > raw_length
    ):
        raise _unsafe()
    next_cursor = cursor + 512 + ((size + 511) // 512) * 512
    if next_cursor <= cursor or next_cursor > raw_length:
        raise _unsafe()
    return next_cursor


def _raw_tar_names(raw: bytes) -> None:
    if len(raw) % 512 != 0:
        raise _unsafe()
    cursor = 0
    while cursor + 512 <= len(raw):
        header = raw[cursor : cursor + 512]
        if header == bytes(512):
            return
        name_field = header[:100]
        terminator = name_field.find(b"\0")
        if terminator >= 0 and any(name_field[terminator + 1 :]):
            raise _unsafe()
        raw_name = name_field if terminator < 0 else name_field[:terminator]
        prefix_field = header[345:500].split(b"\0", 1)[0]
        try:
            raw_name.decode("utf-8")
            prefix_field.decode("utf-8")
        except UnicodeDecodeError:
            raise _unsafe() from None
        size = _tar_size(header[124:136])
        cursor = _next_tar_cursor(cursor, size, len(raw))


def _bounded_gzip(payload: bytes, *, extracted_bytes: int, files: int) -> bytes:
    overhead = (files + 32) * 512 + 10_240
    maximum = extracted_bytes + overhead
    try:
        with gzip.GzipFile(fileobj=io.BytesIO(payload)) as source:
            raw = source.read(maximum + 1)
    except (EOFError, OSError, gzip.BadGzipFile, zlib.error):
        raise _unsafe() from None
    if len(raw) > maximum:
        raise _limit("extracted_bytes")
    return raw


def extract_tar_gzip(
    payload: bytes,
    *,
    extracted_bytes: int,
    files: int,
    file_bytes: int,
) -> dict[str, bytes]:
    raw = _bounded_gzip(payload, extracted_bytes=extracted_bytes, files=files)
    _raw_tar_names(raw)
    try:
        with tarfile.open(fileobj=io.BytesIO(raw), mode="r:") as archive:
            members = archive.getmembers()
            paths = _PathTable()
            file_members: list[tarfile.TarInfo] = []
            for member in members:
                if any(0xD800 <= ord(character) <= 0xDFFF for character in member.name):
                    raise _unsafe()
                if member.isdir():
                    paths.add(member.name, directory=True)
                    continue
                paths.add(member.name)
                if not member.isfile():
                    raise _unsafe(member.name)
                file_members.append(member)
            if len(file_members) > files:
                raise _limit("files")
            total = 0
            for member in file_members:
                if member.size > file_bytes:
                    raise _limit("file_bytes")
                total += member.size
                if total > extracted_bytes:
                    raise _limit("extracted_bytes")
            if not any(member.name == "SKILL.md" for member in file_members):
                raise _unsafe("SKILL.md")
            result: dict[str, bytes] = {}
            actual_total = 0
            for member in file_members:
                source = archive.extractfile(member)
                if source is None:
                    raise _unsafe(member.name)
                content = source.read(file_bytes + 1)
                if len(content) != member.size:
                    raise _unsafe(member.name)
                actual_total += len(content)
                if len(content) > file_bytes:
                    raise _limit("file_bytes")
                if actual_total > extracted_bytes:
                    raise _limit("extracted_bytes")
                result[member.name] = content
            return result
    except CatalogError:
        raise
    except (EOFError, OSError, tarfile.TarError, UnicodeError, ValueError):
        raise _unsafe() from None


def _raw_zip_names(payload: bytes) -> tuple[str, ...]:
    eocd = payload.rfind(b"PK\x05\x06", max(0, len(payload) - 65_557))
    if eocd < 0 or eocd + 22 > len(payload):
        raise _unsafe()
    disk, central_disk, disk_entries, entries = struct.unpack_from(
        "<HHHH", payload, eocd + 4
    )
    central_size, cursor = struct.unpack_from("<II", payload, eocd + 12)
    comment_length = struct.unpack_from("<H", payload, eocd + 20)[0]
    if (
        disk != 0
        or central_disk != 0
        or disk_entries != entries
        or eocd + 22 + comment_length != len(payload)
        or cursor + central_size != eocd
    ):
        raise _unsafe()
    central_end = cursor + central_size
    names: list[str] = []
    for _index in range(entries):
        if payload[cursor : cursor + 4] != b"PK\x01\x02":
            raise _unsafe()
        if cursor + 46 > len(payload):
            raise _unsafe()
        flags = struct.unpack_from("<H", payload, cursor + 8)[0]
        name_length, extra_length, comment_length = struct.unpack_from(
            "<HHH", payload, cursor + 28
        )
        start = cursor + 46
        end = start + name_length
        if end > len(payload):
            raise _unsafe()
        raw_name = payload[start:end]
        if b"\0" in raw_name:
            raise _unsafe()
        try:
            name = raw_name.decode("utf-8" if flags & 0x0800 else "cp437")
        except UnicodeDecodeError:
            raise _unsafe() from None
        names.append(name)
        cursor = end + extra_length + comment_length
    if cursor != central_end:
        raise _unsafe()
    return tuple(names)


def extract_zip(
    payload: bytes,
    *,
    extracted_bytes: int,
    files: int,
    file_bytes: int,
) -> dict[str, bytes]:
    raw_names = _raw_zip_names(payload)
    try:
        with zipfile.ZipFile(io.BytesIO(payload)) as archive:
            members = archive.infolist()
            if len(members) != len(raw_names):
                raise _unsafe()
            paths = _PathTable()
            file_members: list[tuple[zipfile.ZipInfo, str]] = []
            for member, raw_name in zip(members, raw_names, strict=True):
                if any(0xD800 <= ord(character) <= 0xDFFF for character in raw_name):
                    raise _unsafe()
                is_directory = raw_name.endswith("/")
                paths.add(raw_name, directory=is_directory)
                mode = member.external_attr >> 16
                if is_directory:
                    if member.create_system == 3 and mode and not stat.S_ISDIR(mode):
                        raise _unsafe(raw_name)
                    continue
                if member.create_system == 3 and (not mode or not stat.S_ISREG(mode)):
                    raise _unsafe(raw_name)
                file_members.append((member, raw_name))
            if len(file_members) > files:
                raise _limit("files")
            total = 0
            for member, _raw_name in file_members:
                if member.file_size > file_bytes:
                    raise _limit("file_bytes")
                total += member.file_size
                if total > extracted_bytes:
                    raise _limit("extracted_bytes")
            if not any(raw_name == "SKILL.md" for _member, raw_name in file_members):
                raise _unsafe("SKILL.md")
            result: dict[str, bytes] = {}
            actual_total = 0
            for member, raw_name in file_members:
                try:
                    with archive.open(member) as source:
                        content = source.read(file_bytes + 1)
                        trailing = source.read(1)
                except (EOFError, OSError, RuntimeError, zipfile.BadZipFile, zlib.error):
                    raise _unsafe(raw_name) from None
                if trailing or len(content) != member.file_size:
                    raise _unsafe(raw_name)
                if len(content) > file_bytes:
                    raise _limit("file_bytes")
                actual_total += len(content)
                if actual_total > extracted_bytes:
                    raise _limit("extracted_bytes")
                result[raw_name] = content
            return result
    except CatalogError:
        raise
    except (EOFError, OSError, UnicodeError, ValueError, zipfile.BadZipFile):
        raise _unsafe() from None


def extract_archive(
    payload: bytes,
    archive_format: str,
    *,
    extracted_bytes: int,
    files: int,
    file_bytes: int,
) -> tuple[dict[str, bytes], dict[str, str]]:
    if archive_format == "tar.gz":
        extracted = extract_tar_gzip(
            payload,
            extracted_bytes=extracted_bytes,
            files=files,
            file_bytes=file_bytes,
        )
    elif archive_format == "zip":
        extracted = extract_zip(
            payload,
            extracted_bytes=extracted_bytes,
            files=files,
            file_bytes=file_bytes,
        )
    else:
        raise CatalogError("artifact_unsupported", retryable=False, context={})
    ordered = dict(sorted(extracted.items()))
    return ordered, {path: media_type_for_path(path) for path in ordered}


def verify_cached_archive(cached: object) -> bool:
    """Re-derive an archive's normalized table before shared-cache reuse."""

    try:
        archive_format = cached.archive_format
        expected_files = dict(cached.files)
        expected_media_types = dict(cached.media_types)
        extracted_bytes = sum(len(content) for content in expected_files.values())
        file_bytes = max(
            (len(content) for content in expected_files.values()), default=1
        )
        files, media_types = extract_archive(
            cached.artifact,
            archive_format,
            extracted_bytes=max(extracted_bytes, 1),
            files=max(len(expected_files), 1),
            file_bytes=max(file_bytes, 1),
        )
        return files == expected_files and media_types == expected_media_types
    except Exception:
        return False

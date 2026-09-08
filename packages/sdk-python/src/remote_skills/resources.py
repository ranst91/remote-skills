"""Immutable, asynchronous views over already verified local resources."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from types import MappingProxyType

from .cache.base import is_portable_cache_path
from .catalog_errors import CatalogError


@dataclass(frozen=True, slots=True)
class ResourceInfo:
    path: str
    size: int
    media_type: str


def _path_error(path: object) -> CatalogError:
    context = {"path": str.__str__(path)} if isinstance(path, str) else {}
    return CatalogError("path_invalid", retryable=False, context=context)


def _resource_path(path: object) -> str:
    if not isinstance(path, str) or not is_portable_cache_path(path):
        raise _path_error(path)
    return path if type(path) is str else str.__str__(path)


def _prefix(prefix: object) -> str:
    if not isinstance(prefix, str):
        raise _path_error(prefix)
    prefix = prefix if type(prefix) is str else str.__str__(prefix)
    if prefix == "":
        return prefix
    trailing = prefix.endswith("/")
    candidate = prefix[:-1] if trailing else prefix
    if not candidate or not is_portable_cache_path(candidate):
        raise _path_error(prefix)
    return candidate + "/" if trailing else candidate


class ResourceView:
    __slots__ = ("_files", "_media_types")

    def __init__(self, files: Mapping[str, bytes], media_types: Mapping[str, str]) -> None:
        self._files = MappingProxyType(dict(files))
        self._media_types = MappingProxyType(dict(media_types))

    async def list(self, prefix: str | None = None) -> tuple[ResourceInfo, ...]:
        selected_prefix = "" if prefix is None else _prefix(prefix)
        if selected_prefix and not selected_prefix.endswith("/"):
            matches = lambda path: path == selected_prefix or path.startswith(
                selected_prefix + "/"
            )
        else:
            matches = lambda path: path.startswith(selected_prefix)
        listed = tuple(
            ResourceInfo(path, len(self._files[path]), self._media_types[path])
            for path in sorted(self._files)
            if matches(path)
        )
        if selected_prefix and not listed:
            raise CatalogError(
                "resource_not_found",
                retryable=False,
                context={"path": selected_prefix},
            )
        return listed

    async def read_bytes(self, path: str) -> bytes:
        selected = _resource_path(path)
        content = self._files.get(selected)
        if content is None:
            raise CatalogError(
                "resource_not_found", retryable=False, context={"path": selected}
            )
        return bytes(content)

    async def read(self, path: str) -> str:
        content = await self.read_bytes(path)
        try:
            return content.decode("utf-8")
        except UnicodeDecodeError:
            raise CatalogError(
                "resource_not_text", retryable=False, context={"path": path}
            ) from None

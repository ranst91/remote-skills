"""Stable cache errors whose context is safe to expose."""

from __future__ import annotations

import re
from collections.abc import Mapping
from types import MappingProxyType


_SAFE_DIGEST = re.compile(r"sha256:[0-9a-f]{64}\Z")


class CacheCorruptError(Exception):
    """A cache-v1 object failed an integrity or schema check."""

    code = "cache_corrupt"
    retryable = False

    @property
    def context(self) -> Mapping[str, str]:
        return self._context

    def __init__(self, expected_digest: str | None = None) -> None:
        context = {"layout_version": "cache-v1"}
        if type(expected_digest) is str and _SAFE_DIGEST.fullmatch(expected_digest):
            context["expected_digest"] = expected_digest
            suffix = f" ({expected_digest})"
        else:
            suffix = ""
        self._context: Mapping[str, str] = MappingProxyType(context)
        super().__init__(f"cache state is corrupt{suffix}")


class CacheConfigurationError(Exception):
    """Cache input would violate the credential-free storage boundary."""

    code = "configuration_invalid"
    retryable = False

    @property
    def context(self) -> Mapping[str, str]:
        return self._context

    def __init__(self, field: str) -> None:
        self._context: Mapping[str, str] = MappingProxyType({"field": field})
        super().__init__(f"invalid cache configuration field: {field}")

"""Stable, sanitized errors used by catalog discovery."""

from __future__ import annotations

from collections.abc import Mapping
from types import MappingProxyType
from typing import Any
from weakref import WeakKeyDictionary


_CATALOG_ERROR_READ_ONLY_ATTRIBUTES = frozenset(
    {
        "__dict__",
        "code",
        "retryable",
        "context",
        "_code",
        "_retryable",
        "_context",
        "args",
        "_READ_ONLY_ATTRIBUTES",
    }
)

_CATALOG_ERROR_STATE: WeakKeyDictionary[
    BaseException, tuple[str, bool, object, str]
] = WeakKeyDictionary()


def _freeze(value: object) -> object:
    if isinstance(value, Mapping):
        return MappingProxyType({key: _freeze(item) for key, item in value.items()})
    if isinstance(value, (list, tuple)):
        return tuple(_freeze(item) for item in value)
    if isinstance(value, (set, frozenset)):
        return frozenset(_freeze(item) for item in value)
    return value


def _thaw(value: object) -> Any:
    if isinstance(value, Mapping):
        return {key: _thaw(item) for key, item in value.items()}
    if isinstance(value, tuple):
        return [_thaw(item) for item in value]
    if isinstance(value, frozenset):
        return [_thaw(item) for item in sorted(value, key=repr)]
    return value


class CatalogError(Exception):
    """A catalog or network failure with a stable cross-language code."""

    __slots__ = ("__weakref__",)

    def __init__(
        self, code: str, *, retryable: bool, context: Mapping[str, object] | None = None
    ) -> None:
        message = f"Remote Skills request failed: {code}"
        super().__init__(message)
        _CATALOG_ERROR_STATE[self] = (
            code,
            retryable,
            _freeze(dict(context or {})),
            message,
        )

    def __getattribute__(self, name: str) -> object:
        if name == "__dict__":
            instance_dict = super().__getattribute__("__dict__")
            return MappingProxyType(instance_dict)
        return super().__getattribute__(name)

    def __setattr__(self, name: str, value: object) -> None:
        if name in _CATALOG_ERROR_READ_ONLY_ATTRIBUTES:
            raise AttributeError(f"{name} is read-only")
        super().__setattr__(name, value)

    def __delattr__(self, name: str) -> None:
        if name in _CATALOG_ERROR_READ_ONLY_ATTRIBUTES:
            raise AttributeError(f"{name} is read-only")
        super().__delattr__(name)

    @property
    def args(self) -> tuple[str]:
        return (self._state[3],)

    @args.setter
    def args(self, _value: object) -> None:
        raise AttributeError("args is read-only")

    @args.deleter
    def args(self) -> None:
        raise AttributeError("args is read-only")

    @property
    def _state(self) -> tuple[str, bool, object, str]:
        return _CATALOG_ERROR_STATE[self]

    @property
    def _code(self) -> str:
        return self._state[0]

    @property
    def _retryable(self) -> bool:
        return self._state[1]

    @property
    def _context(self) -> object:
        return self._state[2]

    @property
    def _READ_ONLY_ATTRIBUTES(self) -> frozenset[str]:
        return _CATALOG_ERROR_READ_ONLY_ATTRIBUTES

    @property
    def code(self) -> str:
        return self._code

    @property
    def retryable(self) -> bool:
        return self._retryable

    @property
    def context(self) -> Mapping[str, object]:
        context = self._context
        if not isinstance(context, Mapping):
            raise AssertionError("catalog error context was not frozen as a mapping")
        return context

    def __str__(self) -> str:
        return self._state[3]

    def __repr__(self) -> str:
        return f"{type(self).__name__}({self._state[3]!r})"

    def to_diagnostic(self) -> dict[str, object]:
        """Return a fresh, stable JSON-compatible diagnostic value."""

        return {
            "code": self.code,
            "retryable": self.retryable,
            "context": _thaw(self.context),
        }

    @classmethod
    def invalid(cls, origin_alias: str, field: str) -> CatalogError:
        return cls(
            "catalog_invalid",
            retryable=False,
            context={"origin_alias": origin_alias, "field": field},
        )

    @classmethod
    def configuration(cls, field: str) -> CatalogError:
        return cls("configuration_invalid", retryable=False, context={"field": field})

    @classmethod
    def policy_denied(cls, origin_alias: str) -> CatalogError:
        return cls(
            "policy_denied", retryable=False, context={"origin_alias": origin_alias}
        )

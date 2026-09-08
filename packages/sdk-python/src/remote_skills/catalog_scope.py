"""Provider-neutral catalog scope value validation."""

from __future__ import annotations

import hashlib


SCOPE_HEADER = "remote-skills-scope"
MAX_SCOPE_BYTES = 128


def is_valid_scope(value: object) -> bool:
    """Return whether a value is the exact non-secret v0 scope grammar."""

    if type(value) is not str or not value or len(value) > MAX_SCOPE_BYTES:
        return False
    if value[0] in " \t" or value[-1] in " \t" or "," in value:
        return False
    return all(0x20 <= ord(character) <= 0x7E for character in value)


def catalog_identifier(canonical_url: str, confirmed_scope: str | None = None) -> str:
    """Hash the exact credential-free persistent catalog identity contract."""

    identity = canonical_url
    if confirmed_scope is not None:
        identity = f"{canonical_url}\n{SCOPE_HEADER}:{confirmed_scope}"
    return hashlib.sha256(identity.encode("utf-8")).hexdigest()

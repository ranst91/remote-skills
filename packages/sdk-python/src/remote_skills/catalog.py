"""Catalog discovery for explicitly configured Remote Skills origins."""

from __future__ import annotations

from dataclasses import dataclass
from functools import cmp_to_key
import json
import re
from urllib.parse import urlsplit

from .catalog_errors import CatalogError
from .catalog_semver import (
    SemVer,
    compare_release_versions,
    parse_semver,
    parse_version_range,
)
from .catalog_url import canonical_http_url


DISCOVERY_SCHEMA_V0_2 = "https://schemas.agentskills.io/discovery/0.2.0/schema.json"
_DISCOVERY_SCHEMA_V0_1 = "https://schemas.agentskills.io/discovery/0.1/schema.json"
_DIGEST = re.compile(r"sha256:[0-9a-f]{64}\Z")
_NAME = re.compile(r"[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\Z")
_ARTIFACT_TYPES = frozenset({"archive", "skill-md"})
_JSON_NUMBER = re.compile(r"-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?")
_NON_STRING = object()
_DUPLICATE_MEMBER = object()
_MAX_RELEASES = 100


@dataclass(frozen=True, slots=True)
class CatalogRelease:
    """One strictly versioned artifact descriptor advertised by a skill."""

    version: str
    artifact_type: str
    url: str
    digest: str


@dataclass(frozen=True, slots=True)
class CatalogEntry:
    """Compact discovery metadata for one skill artifact."""

    origin_alias: str
    name: str
    description: str
    artifact_type: str
    url: str
    digest: str
    version: str | None = None
    releases: tuple[CatalogRelease, ...] = ()


@dataclass(frozen=True, slots=True)
class SelectedCatalogRelease:
    """The immutable catalog descriptor chosen before activation begins."""

    origin_alias: str
    skill_name: str
    description: str
    artifact_type: str
    url: str
    digest: str
    version: str | None
    stale: bool
    # Only the current descriptor is covered by the entry's description.
    is_current: bool = True


@dataclass(frozen=True, slots=True)
class CatalogSnapshot:
    """An immutable catalog view for one configured origin."""

    origin_alias: str
    entries: tuple[CatalogEntry, ...]
    stale: bool = False
    confirmed_scope: str | None = None
    persistent: bool = False
    catalog_identifier: str | None = None
    catalog_age_seconds: float | None = None


def parse_catalog(body: bytes, *, origin_alias: str, index_url: str) -> CatalogSnapshot:
    """Parse exactly discovery v0.2.0 while ignoring extension fields."""

    try:
        document = _parse_catalog_document(body.decode("utf-8-sig"))
    except (UnicodeDecodeError, _JsonSyntaxError):
        raise CatalogError.invalid(origin_alias, "$document") from None

    if not isinstance(document, dict):
        raise CatalogError.invalid(origin_alias, "$document")

    schema = document.get("$schema")
    if schema != DISCOVERY_SCHEMA_V0_2:
        context: dict[str, object] = {"origin_alias": origin_alias}
        if schema == _DISCOVERY_SCHEMA_V0_1:
            context["schema"] = _DISCOVERY_SCHEMA_V0_1
        raise CatalogError("unsupported_schema", retryable=False, context=context)

    skills = document.get("skills")
    if not isinstance(skills, list):
        raise CatalogError.invalid(origin_alias, "skills")

    entries: list[CatalogEntry] = []
    names: set[str] = set()
    for index, raw_entry in enumerate(skills):
        entry = _parse_entry(
            raw_entry, index, origin_alias=origin_alias, index_url=index_url
        )
        if entry is None:
            continue
        if entry.name in names:
            raise CatalogError.invalid(origin_alias, f"skills[{index}].name")
        names.add(entry.name)
        entries.append(entry)
    return CatalogSnapshot(origin_alias=origin_alias, entries=tuple(entries))


def _parse_entry(
    value: object, index: int, *, origin_alias: str, index_url: str
) -> CatalogEntry | None:
    if not isinstance(value, dict):
        raise CatalogError.invalid(origin_alias, f"skills[{index}]")

    name = _required_string(value, "name", index, origin_alias)
    if len(name) > 64 or _NAME.fullmatch(name) is None or "--" in name:
        raise CatalogError.invalid(origin_alias, f"skills[{index}].name")
    description = _required_string(value, "description", index, origin_alias)
    if len(description) > 1024:
        raise CatalogError.invalid(origin_alias, f"skills[{index}].description")
    artifact_type = value.get("type")
    if not isinstance(artifact_type, str):
        raise CatalogError.invalid(origin_alias, f"skills[{index}].type")
    if artifact_type not in _ARTIFACT_TYPES:
        return None
    url_value = _required_string(value, "url", index, origin_alias)
    digest = _required_string(value, "digest", index, origin_alias)
    if _DIGEST.fullmatch(digest) is None:
        raise CatalogError.invalid(origin_alias, f"skills[{index}].digest")

    try:
        resolved_url = _canonical_artifact_url(index_url, url_value)
        parsed_url = urlsplit(resolved_url)
    except ValueError:
        raise CatalogError.invalid(origin_alias, f"skills[{index}].url") from None
    if (
        parsed_url.scheme not in {"http", "https"}
        or not parsed_url.hostname
        or parsed_url.username is not None
        or parsed_url.password is not None
        or parsed_url.query
        or parsed_url.fragment
    ):
        raise CatalogError.invalid(origin_alias, f"skills[{index}].url")

    extension = value.get("x-remote-skills")
    version: str | None = None
    releases: tuple[CatalogRelease, ...] = ()
    if extension is not None:
        version, releases = _parse_remote_skills_extension(
            extension,
            index=index,
            origin_alias=origin_alias,
            index_url=index_url,
            current=(artifact_type, url_value, digest),
        )

    return CatalogEntry(
        origin_alias=origin_alias,
        name=name,
        description=description,
        artifact_type=artifact_type,
        url=resolved_url,
        digest=digest,
        version=version,
        releases=releases,
    )


def select_catalog_release(
    snapshot: CatalogSnapshot,
    *,
    skill_name: str,
    requested_range: str | None = None,
) -> SelectedCatalogRelease:
    """Select the highest compatible descriptor from this authoritative snapshot."""

    entry = next((item for item in snapshot.entries if item.name == skill_name), None)
    if entry is None:
        raise CatalogError(
            "skill_not_found",
            retryable=False,
            context={"origin_alias": snapshot.origin_alias, "skill_name": skill_name},
        )
    if not entry.releases:
        if requested_range not in {None, "*"}:
            raise _version_unavailable(
                snapshot.origin_alias, skill_name, requested_range
            )
        return SelectedCatalogRelease(
            origin_alias=snapshot.origin_alias,
            skill_name=entry.name,
            description=entry.description,
            artifact_type=entry.artifact_type,
            url=entry.url,
            digest=entry.digest,
            version=None,
            stale=snapshot.stale,
        )
    selected_version = select_catalog_version(
        origin_alias=snapshot.origin_alias,
        skill_name=skill_name,
        advertised_versions=tuple(release.version for release in entry.releases),
        requested_range=requested_range,
    )
    release = next(
        release for release in entry.releases if release.version == selected_version
    )
    return SelectedCatalogRelease(
        origin_alias=snapshot.origin_alias,
        skill_name=entry.name,
        description=entry.description,
        artifact_type=release.artifact_type,
        url=release.url,
        digest=release.digest,
        version=release.version,
        stale=snapshot.stale,
        is_current=release.version == entry.version,
    )


def select_catalog_version(
    *,
    origin_alias: str,
    skill_name: str,
    advertised_versions: tuple[str, ...],
    requested_range: str | None = None,
) -> str:
    """Select only from versions advertised by the authoritative current catalog."""

    if not advertised_versions or len(advertised_versions) > _MAX_RELEASES:
        raise CatalogError.invalid(origin_alias, "advertised_versions")
    parsed_versions: list[SemVer] = []
    exact_versions: set[str] = set()
    for value in advertised_versions:
        parsed = parse_semver(value)
        if parsed is None or parsed.text in exact_versions:
            raise CatalogError.invalid(origin_alias, "advertised_versions")
        exact_versions.add(parsed.text)
        parsed_versions.append(parsed)
    version_range = parse_version_range(requested_range)
    for parsed in sorted(
        parsed_versions,
        key=cmp_to_key(compare_release_versions),
    ):
        if version_range.matches(parsed):
            return parsed.text
    raise _version_unavailable(origin_alias, skill_name, requested_range)


def _version_unavailable(
    origin_alias: str, skill_name: str, requested_range: str | None
) -> CatalogError:
    context: dict[str, object] = {
        "origin_alias": origin_alias,
        "skill_name": skill_name,
    }
    if requested_range is not None:
        context["requested_range"] = requested_range
    return CatalogError("version_unavailable", retryable=False, context=context)


def _parse_remote_skills_extension(
    value: object,
    *,
    index: int,
    origin_alias: str,
    index_url: str,
    current: tuple[str, str, str],
) -> tuple[str, tuple[CatalogRelease, ...]]:
    prefix = f"skills[{index}].x-remote-skills"
    if not isinstance(value, dict) or set(value) != {"version", "releases"}:
        raise CatalogError.invalid(origin_alias, prefix)
    version_value = value.get("version")
    current_version = parse_semver(version_value)
    if current_version is None:
        raise CatalogError.invalid(origin_alias, f"{prefix}.version")
    raw_releases = value.get("releases")
    if (
        not isinstance(raw_releases, list)
        or not raw_releases
        or len(raw_releases) > _MAX_RELEASES
    ):
        raise CatalogError.invalid(origin_alias, f"{prefix}.releases")

    releases: list[CatalogRelease] = []
    parsed_versions: list[SemVer] = []
    exact_versions: set[str] = set()
    raw_descriptors: dict[str, tuple[object, object, object]] = {}
    for release_index, raw_release in enumerate(raw_releases):
        release_prefix = f"{prefix}.releases[{release_index}]"
        if not isinstance(raw_release, dict) or set(raw_release) != {
            "version",
            "type",
            "url",
            "digest",
        }:
            raise CatalogError.invalid(origin_alias, release_prefix)
        release_version = parse_semver(raw_release.get("version"))
        if release_version is None:
            raise CatalogError.invalid(origin_alias, f"{release_prefix}.version")
        if release_version.text in exact_versions:
            raise CatalogError.invalid(origin_alias, f"{release_prefix}.version")
        exact_versions.add(release_version.text)
        raw_descriptors[release_version.text] = (
            raw_release.get("type"),
            raw_release.get("url"),
            raw_release.get("digest"),
        )
        descriptor = _parse_release_descriptor(
            raw_release,
            field_prefix=release_prefix,
            origin_alias=origin_alias,
            index_url=index_url,
        )
        releases.append(
            CatalogRelease(
                version=release_version.text,
                artifact_type=descriptor[0],
                url=descriptor[1],
                digest=descriptor[2],
            )
        )
        parsed_versions.append(release_version)

    if any(
        compare_release_versions(left, right) >= 0
        for left, right in zip(parsed_versions, parsed_versions[1:], strict=False)
    ):
        raise CatalogError.invalid(origin_alias, f"{prefix}.releases.order")
    if raw_descriptors.get(current_version.text) != current:
        raise CatalogError.invalid(origin_alias, f"{prefix}.releases.current")
    return current_version.text, tuple(releases)


def _parse_release_descriptor(
    value: dict[object, object],
    *,
    field_prefix: str,
    origin_alias: str,
    index_url: str,
) -> tuple[str, str, str]:
    artifact_type = value.get("type")
    if artifact_type not in _ARTIFACT_TYPES:
        raise CatalogError.invalid(origin_alias, f"{field_prefix}.type")
    url_value = value.get("url")
    if not isinstance(url_value, str) or not url_value:
        raise CatalogError.invalid(origin_alias, f"{field_prefix}.url")
    digest = value.get("digest")
    if not isinstance(digest, str) or _DIGEST.fullmatch(digest) is None:
        raise CatalogError.invalid(origin_alias, f"{field_prefix}.digest")
    try:
        resolved_url = _canonical_artifact_url(index_url, url_value)
        parsed_url = urlsplit(resolved_url)
    except ValueError:
        raise CatalogError.invalid(origin_alias, f"{field_prefix}.url") from None
    if (
        parsed_url.scheme not in {"http", "https"}
        or not parsed_url.hostname
        or parsed_url.username is not None
        or parsed_url.password is not None
        or parsed_url.query
        or parsed_url.fragment
    ):
        raise CatalogError.invalid(origin_alias, f"{field_prefix}.url")
    return artifact_type, resolved_url, digest


def _canonical_artifact_url(index_url: str, url_value: str) -> str:
    return canonical_http_url(url_value, base=index_url)


def _required_string(
    value: dict[object, object], field: str, index: int, origin_alias: str
) -> str:
    item = value.get(field)
    if not isinstance(item, str) or not item:
        raise CatalogError.invalid(origin_alias, f"skills[{index}].{field}")
    return item


class _JsonSyntaxError(ValueError):
    """An intentionally context-free JSON syntax failure."""


class _JsonTokens:
    """Lazy JSON token stream whose unknown-value skipper never recurses."""

    __slots__ = ("_index", "_lookahead", "_text")

    def __init__(self, text: str) -> None:
        self._text = text
        self._index = 0
        self._lookahead: tuple[str, object] | None = None

    def peek(self) -> tuple[str, object]:
        if self._lookahead is None:
            self._lookahead = self._read()
        return self._lookahead

    def take(self) -> tuple[str, object]:
        token = self.peek()
        self._lookahead = None
        return token

    def expect(self, kind: str) -> object:
        token_kind, value = self.take()
        if token_kind != kind:
            raise _JsonSyntaxError
        return value

    def _read(self) -> tuple[str, object]:
        text = self._text
        length = len(text)
        index = self._index
        while index < length and text[index] in " \t\r\n":
            index += 1
        if index == length:
            self._index = index
            return "end", None

        character = text[index]
        if character in "{}[]:,":
            self._index = index + 1
            return character, None
        if character == '"':
            end = index + 1
            escaped = False
            while end < length:
                current = text[end]
                if escaped:
                    escaped = False
                elif current == "\\":
                    escaped = True
                elif current == '"':
                    raw = text[index : end + 1]
                    try:
                        value = json.loads(raw)
                    except (json.JSONDecodeError, ValueError):
                        raise _JsonSyntaxError from None
                    self._index = end + 1
                    return "string", value
                elif ord(current) < 0x20:
                    raise _JsonSyntaxError
                end += 1
            raise _JsonSyntaxError

        for literal, kind in (
            ("true", "literal"),
            ("false", "literal"),
            ("null", "literal"),
        ):
            if text.startswith(literal, index):
                self._index = index + len(literal)
                return kind, _NON_STRING

        number = _JSON_NUMBER.match(text, index)
        if number is not None:
            self._index = number.end()
            return "number", _NON_STRING
        raise _JsonSyntaxError


def _parse_catalog_document(text: str) -> dict[str, object]:
    tokens = _JsonTokens(text)
    if tokens.take()[0] != "{":
        raise _JsonSyntaxError
    document: dict[str, object] = {}
    if tokens.peek()[0] == "}":
        tokens.take()
    else:
        while True:
            key = tokens.expect("string")
            tokens.expect(":")
            # Only recognized members are retained in the document projection.
            if key in document:
                raise _JsonSyntaxError
            if key == "$schema":
                document["$schema"] = _read_string_or_skip(tokens)
            elif key == "skills":
                document["skills"] = _read_skills_or_skip(tokens)
            else:
                _skip_value(tokens)
            delimiter = tokens.take()[0]
            if delimiter == "}":
                break
            if delimiter != "," or tokens.peek()[0] == "}":
                raise _JsonSyntaxError
    if tokens.take()[0] != "end":
        raise _JsonSyntaxError
    return document


def _read_skills_or_skip(tokens: _JsonTokens) -> object:
    if tokens.peek()[0] != "[":
        _skip_value(tokens)
        return _NON_STRING
    tokens.take()
    skills: list[object] = []
    if tokens.peek()[0] == "]":
        tokens.take()
        return skills
    while True:
        if tokens.peek()[0] == "{":
            skills.append(_read_skill(tokens))
        else:
            _skip_value(tokens)
            skills.append(_NON_STRING)
        delimiter = tokens.take()[0]
        if delimiter == "]":
            return skills
        if delimiter != "," or tokens.peek()[0] == "]":
            raise _JsonSyntaxError


def _read_skill(tokens: _JsonTokens) -> dict[str, object]:
    tokens.expect("{")
    skill: dict[str, object] = {}
    if tokens.peek()[0] == "}":
        tokens.take()
        return skill
    while True:
        key = tokens.expect("string")
        tokens.expect(":")
        if key in {"name", "description", "type", "url", "digest"}:
            _store_member(skill, str(key), _read_string_or_skip(tokens))
        elif key == "x-remote-skills":
            _store_member(skill, str(key), _read_remote_skills_or_skip(tokens))
        else:
            _skip_value(tokens)
        delimiter = tokens.take()[0]
        if delimiter == "}":
            return skill
        if delimiter != "," or tokens.peek()[0] == "}":
            raise _JsonSyntaxError


def _read_remote_skills_or_skip(tokens: _JsonTokens) -> object:
    if tokens.peek()[0] != "{":
        _skip_value(tokens)
        return _NON_STRING
    tokens.take()
    extension: dict[str, object] = {}
    if tokens.peek()[0] == "}":
        tokens.take()
        return extension
    while True:
        key = tokens.expect("string")
        tokens.expect(":")
        if key == "version":
            value = _read_string_or_skip(tokens)
        elif key == "releases":
            value = _read_releases_or_skip(tokens)
        else:
            _skip_value(tokens)
            value = _NON_STRING
        _store_member(extension, str(key), value)
        delimiter = tokens.take()[0]
        if delimiter == "}":
            return extension
        if delimiter != "," or tokens.peek()[0] == "}":
            raise _JsonSyntaxError


def _read_releases_or_skip(tokens: _JsonTokens) -> object:
    if tokens.peek()[0] != "[":
        _skip_value(tokens)
        return _NON_STRING
    tokens.take()
    releases: list[object] = []
    if tokens.peek()[0] == "]":
        tokens.take()
        return releases
    while True:
        if tokens.peek()[0] == "{":
            release = _read_release(tokens)
        else:
            _skip_value(tokens)
            release = _NON_STRING
        if len(releases) <= _MAX_RELEASES:
            releases.append(release)
        delimiter = tokens.take()[0]
        if delimiter == "]":
            return releases
        if delimiter != "," or tokens.peek()[0] == "]":
            raise _JsonSyntaxError


def _read_release(tokens: _JsonTokens) -> dict[str, object]:
    tokens.expect("{")
    release: dict[str, object] = {}
    if tokens.peek()[0] == "}":
        tokens.take()
        return release
    while True:
        key = tokens.expect("string")
        tokens.expect(":")
        if key in {"version", "type", "url", "digest"}:
            value = _read_string_or_skip(tokens)
        else:
            _skip_value(tokens)
            value = _NON_STRING
        _store_member(release, str(key), value)
        delimiter = tokens.take()[0]
        if delimiter == "}":
            return release
        if delimiter != "," or tokens.peek()[0] == "}":
            raise _JsonSyntaxError


def _store_member(target: dict[str, object], key: str, value: object) -> None:
    target[key] = _DUPLICATE_MEMBER if key in target else value


def _read_string_or_skip(tokens: _JsonTokens) -> object:
    if tokens.peek()[0] == "string":
        return tokens.take()[1]
    _skip_value(tokens)
    return _NON_STRING


def _skip_value(tokens: _JsonTokens) -> None:
    first = tokens.take()[0]
    if first in {"string", "number", "literal"}:
        return
    if first not in {"{", "["}:
        raise _JsonSyntaxError

    # Each state is (container, expected token class). Explicit state avoids
    # Python recursion even for deeply nested, semantically ignored extensions.
    stack: list[tuple[str, str]] = [
        ("object", "first_key_or_end")
        if first == "{"
        else ("array", "first_value_or_end")
    ]
    while stack:
        container, state = stack[-1]
        kind = tokens.take()[0]
        if state == "first_key_or_end":
            if kind == "}":
                stack.pop()
            elif kind == "string":
                stack[-1] = (container, "colon")
            else:
                raise _JsonSyntaxError
        elif state == "key":
            if kind != "string":
                raise _JsonSyntaxError
            stack[-1] = (container, "colon")
        elif state == "colon":
            if kind != ":":
                raise _JsonSyntaxError
            stack[-1] = (container, "value")
        elif state in {"first_value_or_end", "value"}:
            if state == "first_value_or_end" and kind == "]":
                stack.pop()
                continue
            stack[-1] = (container, "comma_or_end")
            if kind == "{":
                stack.append(("object", "first_key_or_end"))
            elif kind == "[":
                stack.append(("array", "first_value_or_end"))
            elif kind not in {"string", "number", "literal"}:
                raise _JsonSyntaxError
        else:
            closing = "}" if container == "object" else "]"
            if kind == closing:
                stack.pop()
            elif kind == ",":
                stack[-1] = (container, "key" if container == "object" else "value")
            else:
                raise _JsonSyntaxError

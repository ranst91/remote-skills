"""Strict, bounded SemVer parsing and the v0 supported range subset."""

from __future__ import annotations

from dataclasses import dataclass
from functools import total_ordering
import re

from .catalog_errors import CatalogError


_SEMVER = re.compile(
    r"(0|[1-9][0-9]*)\."
    r"(0|[1-9][0-9]*)\."
    r"(0|[1-9][0-9]*)"
    r"(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?"
    r"(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?\Z"
)
_MAJOR_WILDCARD = re.compile(r"(0|[1-9][0-9]*)\.(?:x|X|\*)\Z")
_MINOR_WILDCARD = re.compile(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(?:x|X|\*)\Z")
_COMPARATOR = re.compile(r"(>=|<=|>|<|=)(.+)\Z")
_MAX_RANGE_BYTES = 256


@total_ordering
@dataclass(frozen=True, slots=True)
class SemVer:
    """A strict SemVer value whose numeric identifiers remain arbitrary precision."""

    text: str
    major: str
    minor: str
    patch: str
    prerelease: tuple[str, ...]
    build: tuple[str, ...]

    def __lt__(self, other: object) -> bool:
        if not isinstance(other, SemVer):
            return NotImplemented
        core = (self.major, self.minor, self.patch)
        other_core = (other.major, other.minor, other.patch)
        if core != other_core:
            for left, right in zip(core, other_core, strict=True):
                comparison = _compare_numeric_identifier(left, right)
                if comparison:
                    return comparison < 0
        return _compare_prerelease(self.prerelease, other.prerelease) < 0

    def __eq__(self, other: object) -> bool:
        return isinstance(other, SemVer) and (
            self.major,
            self.minor,
            self.patch,
            self.prerelease,
        ) == (
            other.major,
            other.minor,
            other.patch,
            other.prerelease,
        )

    def __hash__(self) -> int:
        return hash((self.major, self.minor, self.patch, self.prerelease))

    @property
    def core(self) -> tuple[str, str, str]:
        return self.major, self.minor, self.patch


def parse_semver(value: object) -> SemVer | None:
    """Parse strict ASCII SemVer, returning ``None`` for any malformed value."""

    if type(value) is not str:
        return None
    match = _SEMVER.fullmatch(value)
    if match is None:
        return None
    prerelease = tuple(match.group(4).split(".")) if match.group(4) else ()
    if any(
        identifier.isascii()
        and identifier.isdigit()
        and len(identifier) > 1
        and identifier.startswith("0")
        for identifier in prerelease
    ):
        return None
    build = tuple(match.group(5).split(".")) if match.group(5) else ()
    return SemVer(
        text=value,
        major=match.group(1),
        minor=match.group(2),
        patch=match.group(3),
        prerelease=prerelease,
        build=build,
    )


def compare_release_versions(left: SemVer, right: SemVer) -> int:
    """Compare precedence, then ascending full strings for deterministic ties."""

    if left < right:
        return 1
    if right < left:
        return -1
    if left.text < right.text:
        return -1
    if left.text > right.text:
        return 1
    return 0


@dataclass(frozen=True, slots=True)
class VersionRange:
    kind: str
    comparators: tuple[tuple[str, SemVer], ...] = ()
    major: str | None = None
    minor: str | None = None

    def matches(self, candidate: SemVer) -> bool:
        if candidate.prerelease and not self._admits_prerelease(candidate):
            return False
        if self.kind == "any":
            return True
        if self.kind == "major":
            return candidate.major == self.major
        if self.kind == "minor":
            return candidate.major == self.major and candidate.minor == self.minor
        return all(
            _compare(candidate, operator, version)
            for operator, version in self.comparators
        )

    def _admits_prerelease(self, candidate: SemVer) -> bool:
        return any(
            comparator.prerelease and comparator.core == candidate.core
            for _operator, comparator in self.comparators
        )


def parse_version_range(value: str | None) -> VersionRange:
    """Parse the finite v0 public range contract or raise a stable config error."""

    if value is None or value == "*":
        return VersionRange("any")
    if (
        type(value) is not str
        or not value
        or len(value.encode("utf-8")) > _MAX_RANGE_BYTES
    ):
        raise CatalogError.configuration("requested_range")
    if any(ord(character) < 0x20 or ord(character) > 0x7E for character in value):
        raise CatalogError.configuration("requested_range")

    match = _MAJOR_WILDCARD.fullmatch(value)
    if match is not None:
        return VersionRange("major", major=match.group(1))
    match = _MINOR_WILDCARD.fullmatch(value)
    if match is not None:
        return VersionRange("minor", major=match.group(1), minor=match.group(2))

    if value.startswith("^") or value.startswith("~"):
        base = parse_semver(value[1:])
        if base is None:
            raise CatalogError.configuration("requested_range")
        if value[0] == "~":
            upper = SemVer("", base.major, _increment_numeric(base.minor), "0", (), ())
        elif base.major != "0":
            upper = SemVer("", _increment_numeric(base.major), "0", "0", (), ())
        elif base.minor != "0":
            upper = SemVer("", "0", _increment_numeric(base.minor), "0", (), ())
        else:
            upper = SemVer("", "0", "0", _increment_numeric(base.patch), (), ())
        return VersionRange("comparators", ((">=", base), ("<", upper)))

    exact = parse_semver(value)
    if exact is not None:
        return VersionRange("comparators", (("=", exact),))

    comparators: list[tuple[str, SemVer]] = []
    for member in value.split(" "):
        if not member:
            raise CatalogError.configuration("requested_range")
        comparator_match = _COMPARATOR.fullmatch(member)
        if comparator_match is None:
            raise CatalogError.configuration("requested_range")
        version = parse_semver(comparator_match.group(2))
        if version is None:
            raise CatalogError.configuration("requested_range")
        comparators.append((comparator_match.group(1), version))
    if not comparators:
        raise CatalogError.configuration("requested_range")
    return VersionRange("comparators", tuple(comparators))


def _compare(candidate: SemVer, operator: str, comparator: SemVer) -> bool:
    if operator == "=":
        return candidate == comparator
    if operator == ">=":
        return candidate >= comparator
    if operator == "<=":
        return candidate <= comparator
    if operator == ">":
        return candidate > comparator
    if operator == "<":
        return candidate < comparator
    raise AssertionError("unreachable comparator")


def _compare_prerelease(left: tuple[str, ...], right: tuple[str, ...]) -> int:
    if not left or not right:
        if left == right:
            return 0
        return 1 if not left else -1
    for left_identifier, right_identifier in zip(left, right, strict=False):
        if left_identifier == right_identifier:
            continue
        left_numeric = left_identifier.isdigit()
        right_numeric = right_identifier.isdigit()
        if left_numeric and right_numeric:
            return _compare_numeric_identifier(left_identifier, right_identifier)
        if left_numeric != right_numeric:
            return -1 if left_numeric else 1
        return -1 if left_identifier < right_identifier else 1
    if len(left) == len(right):
        return 0
    return -1 if len(left) < len(right) else 1


def _compare_numeric_identifier(left: str, right: str) -> int:
    if len(left) != len(right):
        return -1 if len(left) < len(right) else 1
    if left == right:
        return 0
    return -1 if left < right else 1


def _increment_numeric(value: str) -> str:
    digits = list(value)
    carry = 1
    for index in range(len(digits) - 1, -1, -1):
        updated = ord(digits[index]) - ord("0") + carry
        digits[index] = str(updated % 10)
        carry = updated // 10
        if carry == 0:
            break
    if carry:
        digits.insert(0, "1")
    return "".join(digits)

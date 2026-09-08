"""Strict parsing of the standard Agent Skills ``SKILL.md`` surface."""

from __future__ import annotations

from dataclasses import dataclass
import re
from types import MappingProxyType
from typing import Mapping

from .catalog_errors import CatalogError


_FRONTMATTER = re.compile(
    r"\A---\r?\n(?P<header>[\s\S]*?)\r?\n---(?:\r?\n|\Z)(?P<body>[\s\S]*)\Z"
)
_NAME = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*\Z")
_BLOCK = re.compile(r"(?P<style>[|>])(?P<options>(?:[+-][1-9]?|[1-9][+-]?))?\Z")
_CORE_NULL = re.compile(r"(?:null|Null|NULL|~)\Z")
_CORE_BOOL = re.compile(r"(?:true|True|TRUE|false|False|FALSE)\Z")
_CORE_INT = re.compile(r"(?:0o[0-7]+|0x[0-9a-fA-F]+|[-+]?[0-9]+)\Z")
_CORE_FLOAT = re.compile(
    r"[-+]?(?:(?:[0-9]+\.[0-9]*|\.[0-9]+)(?:[eE][-+]?[0-9]+)?|"
    r"[0-9]+(?:\.[0-9]*)?[eE][-+]?[0-9]+|"
    r"\.(?:inf|Inf|INF|nan|NaN|NAN))\Z"
)
_CORE_NON_STRING = re.compile(
    r"(?:null|Null|NULL|~|true|True|TRUE|false|False|FALSE|"
    r"(?:0o[0-7]+|0x[0-9a-fA-F]+|[-+]?[0-9]+)|"
    r"[-+]?(?:(?:[0-9]+\.[0-9]*|\.[0-9]+)(?:[eE][-+]?[0-9]+)?|"
    r"[0-9]+(?:\.[0-9]*)?[eE][-+]?[0-9]+)|"
    r"[-+]?\.(?:inf|Inf|INF|nan|NaN|NAN))\Z"
)
_ALLOWED = frozenset(
    {"name", "description", "license", "compatibility", "metadata", "allowed-tools"}
)
_TYPED_CORE_TAGS = frozenset({"bool", "float", "int", "null"})
_FRONTMATTER_NODE_LIMIT = 100_000
_FRONTMATTER_DEPTH_LIMIT = 128


@dataclass(frozen=True, slots=True)
class _TypedScalar:
    source: str


@dataclass(slots=True)
class _YamlMap:
    pairs: list[tuple[object, object]]


class _YamlSyntax(Exception):
    pass


class _YamlLimit(Exception):
    pass


def _invalid(field: str) -> CatalogError:
    return CatalogError("catalog_invalid", retryable=False, context={"field": field})


def _limit() -> CatalogError:
    return CatalogError(
        "limit_exceeded",
        retryable=False,
        context={"limit": "frontmatterNodes"},
    )


def _strip_plain_comment(value: str) -> str:
    for index, character in enumerate(value):
        if character == "#" and (index == 0 or value[index - 1].isspace()):
            return value[:index].rstrip()
    return value.rstrip()


def _well_formed(value: str) -> bool:
    return not any(0xD800 <= ord(character) <= 0xDFFF for character in value)


def _quoted_tail_is_empty(source: str) -> bool:
    tail = source.lstrip()
    return not tail or tail.startswith("#")


def _flow_whitespace(
    source: str, index: int, *, escaped: bool = False
) -> tuple[str, int]:
    start = index
    breaks = 0
    while index < len(source) and source[index] in " \t\n":
        breaks += source[index] == "\n"
        index += 1
    if escaped:
        breaks -= 1
        if breaks == 0:
            return "", index
    if breaks:
        return ("\n" * (breaks - 1) if breaks > 1 else " "), index
    return source[start:index], index


def _decode_double_quoted(source: str) -> object:
    escapes = {
        "0": "\0",
        "a": "\a",
        "b": "\b",
        "t": "\t",
        "n": "\n",
        "v": "\v",
        "f": "\f",
        "r": "\r",
        "e": "\x1b",
        " ": " ",
        '"': '"',
        "/": "/",
        "\\": "\\",
        "N": "\u0085",
        "_": "\u00a0",
        "L": "\u2028",
        "P": "\u2029",
    }
    units: list[str] = []
    index = 1
    while index < len(source):
        character = source[index]
        if character == '"':
            if not _quoted_tail_is_empty(source[index + 1 :]):
                raise _YamlSyntax
            value = "".join(units)
            output: list[str] = []
            cursor = 0
            invalid_string = False
            while cursor < len(value):
                codepoint = ord(value[cursor])
                if 0xD800 <= codepoint <= 0xDBFF:
                    if cursor + 1 >= len(value):
                        invalid_string = True
                        cursor += 1
                        continue
                    trailing = ord(value[cursor + 1])
                    if not 0xDC00 <= trailing <= 0xDFFF:
                        invalid_string = True
                        cursor += 1
                        continue
                    output.append(
                        chr(
                            0x10000
                            + ((codepoint - 0xD800) << 10)
                            + trailing
                            - 0xDC00
                        )
                    )
                    cursor += 2
                    continue
                if 0xDC00 <= codepoint <= 0xDFFF:
                    invalid_string = True
                    cursor += 1
                    continue
                output.append(value[cursor])
                cursor += 1
            return (
                _TypedScalar("invalid-string")
                if invalid_string
                else "".join(output)
            )
        if character in " \t\n":
            whitespace, index = _flow_whitespace(source, index)
            units.append(whitespace)
            continue
        if character != "\\":
            units.append(character)
            index += 1
            continue
        index += 1
        if index >= len(source):
            raise _YamlSyntax
        escape = source[index]
        if escape == "\n":
            whitespace, index = _flow_whitespace(source, index, escaped=True)
            units.append(whitespace)
            continue
        if escape in escapes:
            units.append(escapes[escape])
            index += 1
            continue
        widths = {"x": 2, "u": 4, "U": 8}
        width = widths.get(escape)
        if width is None or index + width >= len(source):
            raise _YamlSyntax
        digits = source[index + 1 : index + 1 + width]
        if re.fullmatch(r"[0-9a-fA-F]+", digits) is None:
            raise _YamlSyntax
        codepoint = int(digits, 16)
        if codepoint > 0x10FFFF:
            raise _YamlSyntax
        units.append(chr(codepoint))
        index += width + 1
    raise _YamlSyntax


def _decode_single_quoted(source: str) -> str:
    output: list[str] = []
    index = 1
    while index < len(source):
        character = source[index]
        if character in " \t\n":
            whitespace, index = _flow_whitespace(source, index)
            output.append(whitespace)
            continue
        if character != "'":
            output.append(character)
            index += 1
            continue
        if index + 1 < len(source) and source[index + 1] == "'":
            output.append("'")
            index += 2
            continue
        if not _quoted_tail_is_empty(source[index + 1 :]):
            raise _YamlSyntax
        value = "".join(output)
        if not _well_formed(value):
            raise _YamlSyntax
        return value
    raise _YamlSyntax


def _parse_scalar(source: str) -> object:
    value = source.strip()
    if not value:
        return _TypedScalar("null")
    force_string = False
    if value.startswith("!!"):
        match = re.match(r"!!(?P<tag>[a-z]+)(?:\s+(?P<value>[\s\S]*))?\Z", value)
        if match is None:
            raise _YamlSyntax
        tag = match.group("tag")
        tagged_value = match.group("value") or ""
        if tag == "str":
            if not tagged_value:
                return ""
            force_string = True
            value = tagged_value
        elif tag in _TYPED_CORE_TAGS:
            validators = {
                "bool": _CORE_BOOL,
                "float": _CORE_FLOAT,
                "int": _CORE_INT,
                "null": _CORE_NULL,
            }
            if validators[tag].fullmatch(tagged_value) is None:
                raise _YamlSyntax
            return _TypedScalar(value)
        else:
            raise _YamlSyntax
    elif value.startswith("!") or value.startswith(("&", "*")):
        raise _YamlSyntax
    if value.startswith('"'):
        return _decode_double_quoted(value)
    if value.startswith("'"):
        return _decode_single_quoted(value)
    value = _strip_plain_comment(value)
    if not value or value[0] in "[]{}&*!|>@`":
        raise _YamlSyntax
    if not _well_formed(value):
        raise _YamlSyntax
    if not force_string and _CORE_NON_STRING.fullmatch(value):
        return _TypedScalar(value)
    return value


def _split_mapping_line(line: str, *, flow: bool = False) -> tuple[str, str] | None:
    quote: str | None = None
    depth = 0
    index = 0
    while index < len(line):
        character = line[index]
        if quote == '"':
            if character == "\\":
                index += 2
                continue
            if character == quote:
                quote = None
        elif quote == "'":
            if character == quote:
                if index + 1 < len(line) and line[index + 1] == quote:
                    index += 2
                    continue
                quote = None
        elif character in {'"', "'"}:
            quote = character
        elif character in "[{":
            depth += 1
        elif character in "]}":
            depth -= 1
            if depth < 0:
                raise _YamlSyntax
        elif character == ":" and depth == 0 and (
            flow or index + 1 == len(line) or line[index + 1].isspace()
        ):
            return line[:index], line[index + 1 :]
        index += 1
    if quote is not None or depth != 0:
        raise _YamlSyntax
    return None


def _parse_key(source: str) -> object:
    key = _parse_scalar(source)
    if key == "":
        raise _YamlSyntax
    return key


def _parse_block_scalar(
    lines: list[str],
    index: int,
    *,
    parent_indent: int,
    style: str,
    options: str,
) -> tuple[str, int]:
    start = index
    explicit = next(
        (int(character) for character in options if character.isdigit()), None
    )
    nonblank_indents = [
        len(line) - len(line.lstrip(" "))
        for line in lines[start:]
        if line.strip()
    ]
    if not nonblank_indents:
        return "", len(lines)
    indent = parent_indent + explicit if explicit is not None else nonblank_indents[0]
    if indent < 1:
        raise _invalid("SKILL.md.frontmatter")
    content: list[str] = []
    while index < len(lines):
        line = lines[index]
        line_indent = len(line) - len(line.lstrip(" "))
        if line.strip() and line_indent < indent:
            break
        if line.strip():
            content.append(line[indent:])
        else:
            content.append("")
        index += 1
    if style == "|":
        value = "\n".join(content)
    else:
        pieces: list[str] = []
        for position, line in enumerate(content):
            pieces.append(line)
            if position + 1 < len(content):
                pieces.append("\n" if not line or not content[position + 1] else " ")
        value = "".join(pieces)
    if "-" in options:
        return value.rstrip("\n"), index
    if "+" in options:
        return value + "\n", index
    return value.rstrip("\n") + "\n", index


def _split_flow_items(source: str) -> list[str]:
    items: list[str] = []
    quote: str | None = None
    depth = 0
    start = 0
    index = 0
    while index < len(source):
        character = source[index]
        if quote == '"':
            if character == "\\":
                index += 2
                continue
            if character == quote:
                quote = None
        elif quote == "'":
            if character == quote:
                if index + 1 < len(source) and source[index + 1] == quote:
                    index += 2
                    continue
                quote = None
        elif character in {'"', "'"}:
            quote = character
        elif character in "[{":
            depth += 1
        elif character in "]}":
            depth -= 1
            if depth < 0:
                raise _YamlSyntax
        elif character == "," and depth == 0:
            item = source[start:index].strip()
            if not item:
                raise _YamlSyntax
            items.append(item)
            start = index + 1
        index += 1
    if quote is not None or depth != 0:
        raise _YamlSyntax
    final = source[start:].strip()
    if final:
        items.append(final)
    elif source.strip():
        raise _YamlSyntax
    return items


def _strip_trailing_comment(source: str) -> str:
    quote: str | None = None
    depth = 0
    index = 0
    while index < len(source):
        character = source[index]
        if quote == '"':
            if character == "\\":
                index += 2
                continue
            if character == quote:
                quote = None
        elif quote == "'":
            if character == quote:
                if index + 1 < len(source) and source[index + 1] == quote:
                    index += 2
                    continue
                quote = None
        elif character in {'"', "'"}:
            quote = character
        elif character in "[{":
            depth += 1
        elif character in "]}":
            depth -= 1
        elif character == "#" and depth == 0 and (
            index == 0 or source[index - 1].isspace()
        ):
            return source[:index].rstrip()
        index += 1
    return source.strip()


class _YamlCoreParser:
    def __init__(self, source: str) -> None:
        self.lines = source.splitlines()
        self.nodes = 0

    def _node(self, value: object) -> object:
        self.nodes += 1
        if self.nodes > _FRONTMATTER_NODE_LIMIT:
            raise _YamlLimit
        return value

    def _next_content(self, index: int) -> int:
        while index < len(self.lines):
            line = self.lines[index]
            if "\t" in line[: len(line) - len(line.lstrip("\t "))]:
                raise _YamlSyntax
            if line.strip() and not line.lstrip().startswith("#"):
                break
            index += 1
        return index

    def parse(self) -> object:
        index = self._next_content(0)
        if index == len(self.lines):
            return self._node(_TypedScalar("null"))
        line = self.lines[index]
        if len(line) - len(line.lstrip(" ")) != 0:
            raise _YamlSyntax
        stripped_source = "\n".join(self.lines[index:]).strip()
        if stripped_source.startswith(("{", "[")):
            return self._parse_value(stripped_source, depth=0)
        value, index = self._parse_block(index, 0, depth=0)
        if self._next_content(index) != len(self.lines):
            raise _YamlSyntax
        return value

    def _parse_value(self, source: str, *, depth: int) -> object:
        if depth > _FRONTMATTER_DEPTH_LIMIT:
            raise _YamlSyntax
        source = _strip_trailing_comment(source)
        if source.startswith("{"):
            if not source.endswith("}"):
                raise _YamlSyntax
            result = self._node(_YamlMap([]))
            assert isinstance(result, _YamlMap)
            for item in _split_flow_items(source[1:-1]):
                pair = _split_mapping_line(item, flow=True)
                if pair is None:
                    raise _YamlSyntax
                key = self._node(_parse_key(pair[0].strip()))
                value = self._parse_value(pair[1], depth=depth + 1)
                result.pairs.append((key, value))
            return result
        if source.startswith("["):
            if not source.endswith("]"):
                raise _YamlSyntax
            result = self._node([])
            assert isinstance(result, list)
            for item in _split_flow_items(source[1:-1]):
                result.append(self._parse_value(item, depth=depth + 1))
            return result
        return self._node(_parse_scalar(source))

    def _scalar_continuation(
        self, source: str, index: int, *, parent_indent: int
    ) -> tuple[str, int]:
        """Collect scalar lines once; byte admission and node bounds stay with callers."""
        if source.startswith(("'", '"')):
            quote = source[0]
            parts = [source]
            line = source
            cursor = 1
            while True:
                while cursor < len(line):
                    character = line[cursor]
                    if quote == '"' and character == "\\":
                        cursor += 2
                        continue
                    if character == quote:
                        if quote == "'" and line[cursor + 1 : cursor + 2] == "'":
                            cursor += 2
                            continue
                        return "\n".join(parts), index
                    cursor += 1
                if index >= len(self.lines):
                    raise _YamlSyntax
                line = self.lines[index]
                if "\t" in line[: len(line) - len(line.lstrip("\t "))]:
                    raise _YamlSyntax
                if line.strip() and len(line) - len(line.lstrip(" ")) <= parent_indent:
                    raise _YamlSyntax
                parts.append(line)
                index += 1
                cursor = 0

        if not source or source[0] in "[]{}&*!|>@`":
            return source, index
        parts = [_strip_plain_comment(source)]
        if parts[0] != source.rstrip():
            return parts[0], index
        blank_lines = 0
        while index < len(self.lines):
            line = self.lines[index]
            if "\t" in line[: len(line) - len(line.lstrip("\t "))]:
                raise _YamlSyntax
            if not line.strip():
                blank_lines += 1
                index += 1
                continue
            if line.lstrip().startswith("#"):
                break
            if len(line) - len(line.lstrip(" ")) <= parent_indent:
                break
            content = _strip_plain_comment(line.strip())
            if re.search(r":(?:\s|$)", content):
                raise _YamlSyntax
            parts.extend(("\n" * blank_lines if blank_lines else " ", content))
            blank_lines = 0
            index += 1
            if content != line.strip():
                break
        return "".join(parts), index

    def _parse_block(
        self, index: int, indent: int, *, depth: int
    ) -> tuple[object, int]:
        if depth > _FRONTMATTER_DEPTH_LIMIT:
            raise _YamlSyntax
        index = self._next_content(index)
        if index >= len(self.lines):
            return self._node(_TypedScalar("null")), index
        first = self.lines[index]
        first_indent = len(first) - len(first.lstrip(" "))
        if first_indent != indent:
            raise _YamlSyntax
        sequence = first[indent:].startswith("-") and first[indent:][1:2] in {"", " "}
        result: object = self._node([] if sequence else _YamlMap([]))
        while True:
            index = self._next_content(index)
            if index >= len(self.lines):
                break
            line = self.lines[index]
            line_indent = len(line) - len(line.lstrip(" "))
            if line_indent < indent:
                break
            if line_indent > indent:
                raise _YamlSyntax
            content = line[indent:]
            is_sequence = content.startswith("-") and content[1:2] in {"", " "}
            if is_sequence != sequence:
                raise _YamlSyntax
            index += 1
            if sequence:
                assert isinstance(result, list)
                raw_value = content[1:].lstrip()
                if raw_value:
                    result.append(self._parse_value(raw_value, depth=depth + 1))
                    continue
                nested = self._next_content(index)
                if nested >= len(self.lines):
                    result.append(self._node(_TypedScalar("null")))
                    index = nested
                    continue
                nested_indent = len(self.lines[nested]) - len(
                    self.lines[nested].lstrip(" ")
                )
                if nested_indent <= indent:
                    result.append(self._node(_TypedScalar("null")))
                    index = nested
                else:
                    item, index = self._parse_block(
                        nested, nested_indent, depth=depth + 1
                    )
                    result.append(item)
                continue

            assert isinstance(result, _YamlMap)
            pair = _split_mapping_line(content)
            if pair is None:
                raise _YamlSyntax
            key = self._node(_parse_key(pair[0].strip()))
            raw_value = _strip_trailing_comment(pair[1])
            tagged_string = False
            if raw_value.startswith("!!str") and (
                len(raw_value) == 5 or raw_value[5:6].isspace()
            ):
                tagged_string = True
                raw_value = raw_value[5:].lstrip()
            block = _BLOCK.fullmatch(raw_value)
            if block is not None:
                value, index = _parse_block_scalar(
                    self.lines,
                    index,
                    parent_indent=indent,
                    style=block.group("style"),
                    options=block.group("options") or "",
                )
                value = self._node(value)
            elif raw_value:
                raw_value, index = self._scalar_continuation(
                    raw_value if tagged_string else pair[1].strip(),
                    index,
                    parent_indent=indent,
                )
                value = self._parse_value(
                    f"!!str {raw_value}" if tagged_string else raw_value,
                    depth=depth + 1,
                )
            else:
                nested = self._next_content(index)
                if nested >= len(self.lines):
                    value = self._node("" if tagged_string else _TypedScalar("null"))
                    index = nested
                else:
                    nested_indent = len(self.lines[nested]) - len(
                        self.lines[nested].lstrip(" ")
                    )
                    if nested_indent <= indent:
                        value = self._node(
                            "" if tagged_string else _TypedScalar("null")
                        )
                        index = nested
                    elif tagged_string:
                        raise _YamlSyntax
                    else:
                        value, index = self._parse_block(
                            nested,
                            nested_indent,
                            depth=depth + 1,
                        )
            result.pairs.append((key, value))
        return result, index


def _pairs_to_mapping(value: object, *, field: str) -> dict[str, object]:
    if not isinstance(value, _YamlMap):
        raise _invalid(field)
    result: dict[str, object] = {}
    for key, item in value.pairs:
        if not isinstance(key, str) or not key:
            raise _invalid(field)
        if key in result:
            raise _invalid("SKILL.md.frontmatter")
        result[key] = item
    return result


def _parse_header(source: str) -> dict[str, object]:
    parsed = _YamlCoreParser(source).parse()
    if not isinstance(parsed, _YamlMap):
        raise _invalid("SKILL.md.frontmatter")
    result: dict[str, object] = {}
    for key, value in parsed.pairs:
        if not isinstance(key, str) or key not in _ALLOWED:
            raise _invalid("[unknown-field]")
        if key in result:
            raise _invalid("SKILL.md.frontmatter")
        if key == "metadata":
            metadata = _pairs_to_mapping(value, field="metadata")
            if any(not isinstance(item, str) for item in metadata.values()):
                raise _invalid("metadata")
            result[key] = metadata
        else:
            if not isinstance(value, str):
                raise _invalid(key)
            result[key] = value
    return result


def _freeze_frontmatter(value: Mapping[str, object]) -> Mapping[str, object]:
    frozen: dict[str, object] = {}
    for key, item in value.items():
        frozen[key] = (
            MappingProxyType(dict(item)) if isinstance(item, Mapping) else item
        )
    return MappingProxyType(frozen)


def parse_skill_markdown(payload: bytes) -> tuple[Mapping[str, object], str]:
    """Parse UTF-8 bytes and return deeply immutable metadata plus Markdown body."""

    try:
        text = payload.decode("utf-8")
    except UnicodeDecodeError:
        raise _invalid("SKILL.md") from None
    match = _FRONTMATTER.fullmatch(text)
    if match is None:
        raise _invalid("SKILL.md.frontmatter")
    try:
        frontmatter = _parse_header(match.group("header"))
    except _YamlLimit:
        raise _limit() from None
    except _YamlSyntax:
        raise _invalid("SKILL.md.frontmatter") from None
    except CatalogError:
        raise
    except (RecursionError, UnicodeError, ValueError):
        raise _invalid("SKILL.md.frontmatter") from None

    name = frontmatter.get("name")
    if (
        not isinstance(name, str)
        or not 1 <= len(name) <= 64
        or _NAME.fullmatch(name) is None
    ):
        raise _invalid("name")
    description = frontmatter.get("description")
    if (
        not isinstance(description, str)
        or not description.strip()
        or len(description) > 1024
    ):
        raise _invalid("description")
    license_value = frontmatter.get("license")
    if license_value is not None and not isinstance(license_value, str):
        raise _invalid("license")
    compatibility = frontmatter.get("compatibility")
    if compatibility is not None and (
        not isinstance(compatibility, str)
        or not compatibility.strip()
        or len(compatibility) > 500
    ):
        raise _invalid("compatibility")
    allowed_tools = frontmatter.get("allowed-tools")
    if allowed_tools is not None and not isinstance(allowed_tools, str):
        raise _invalid("allowed-tools")
    metadata = frontmatter.get("metadata")
    if metadata is not None and (
        not isinstance(metadata, Mapping)
        or any(
            not isinstance(key, str)
            or not key
            or not isinstance(value, str)
            for key, value in metadata.items()
        )
    ):
        raise _invalid("metadata")
    body = match.group("body")
    if body.startswith("\r\n"):
        body = body[2:]
    elif body.startswith("\n"):
        body = body[1:]
    return _freeze_frontmatter(frontmatter), body

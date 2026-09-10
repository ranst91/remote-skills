"""Audited, fail-closed WHATWG URL validation for network boundaries."""

from __future__ import annotations

import ipaddress
import re
from urllib.parse import quote, unquote_to_bytes, urlsplit, urlunsplit

from uts46.whatwg import domain_to_ascii

_SCHEME = re.compile(r"([A-Za-z][A-Za-z0-9+.-]*):")
_ASCII_DECIMAL = re.compile(r"[0-9]+\Z")
_ASCII_HEXADECIMAL = re.compile(r"[0-9A-Fa-f]+\Z")
_ASCII_OCTAL = re.compile(r"[0-7]+\Z")
_PATH_SAFE = "/:@!$&'()*+,;=-._~%[]|"


def is_canonical_raw_url_reference(value: str) -> bool:
    """Reject syntax that WHATWG would silently trim or reinterpret."""

    if not value:
        return False
    if _is_ascii_control_or_space(value[0]) or _is_ascii_control_or_space(value[-1]):
        return False
    if any(character in value for character in "\t\n\r\\"):
        return False
    scheme = _SCHEME.match(value)
    if scheme is not None and scheme.group(1).lower() in {"http", "https"}:
        authority_start = scheme.end()
        return value.startswith("//", authority_start) and not value.startswith(
            "///", authority_start
        )
    return not value.startswith("///")


def has_raw_url_userinfo(value: str) -> bool:
    """Detect even empty userinfo before a parser can normalize it away."""

    scheme_authority = re.match(r"[A-Za-z][A-Za-z0-9+.-]*://", value)
    if value.startswith("//"):
        authority_start = 2
    elif scheme_authority is not None:
        authority_start = scheme_authority.end()
    else:
        return False
    remainder = value[authority_start:]
    delimiter_positions = [
        position for marker in "/?#" if (position := remainder.find(marker)) >= 0
    ]
    authority_end = min(delimiter_positions, default=len(remainder))
    return "@" in remainder[:authority_end]


def canonical_http_url(value: str, *, base: str | None = None) -> str:
    """Resolve and serialize one safe HTTP(S) URL like the Node URL class."""

    if (
        not isinstance(value, str)
        or "?" in value
        or "#" in value
        or not is_canonical_raw_url_reference(value)
        or has_raw_url_userinfo(value)
    ):
        raise ValueError("noncanonical URL reference")
    usv_value = _to_usv_string(value)
    try:
        resolved = _resolve_url_reference(usv_value, base)
        parsed = urlsplit(resolved)
        port = parsed.port
    except (TypeError, ValueError):
        raise ValueError("invalid URL reference") from None
    scheme = parsed.scheme.lower()
    hostname = parsed.hostname
    if (
        scheme not in {"http", "https"}
        or hostname is None
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("invalid HTTP URL")

    canonical_host = canonical_hostname(hostname)
    default_port = 443 if scheme == "https" else 80
    authority = (
        canonical_host
        if port is None or port == default_port
        else f"{canonical_host}:{port}"
    )
    normalized_path = _normalize_encoded_dot_segments(parsed.path or "/")
    path = quote(_remove_dot_segments(normalized_path), safe=_PATH_SAFE)
    return urlunsplit((scheme, authority, path, "", ""))


def _to_usv_string(value: str) -> str:
    return value.encode("utf-16-le", "surrogatepass").decode("utf-16-le", "replace")


def _resolve_url_reference(value: str, base: str | None) -> str:
    """Resolve the admitted URL forms without collapsing empty path segments."""

    if base is None or _SCHEME.match(value) is not None:
        return value
    try:
        parsed_base = urlsplit(base)
        parsed_base.port
    except (TypeError, ValueError):
        raise ValueError("invalid base URL") from None
    if (
        parsed_base.scheme.lower() not in {"http", "https"}
        or parsed_base.hostname is None
        or parsed_base.username is not None
        or parsed_base.password is not None
        or parsed_base.query
        or parsed_base.fragment
    ):
        raise ValueError("invalid base URL")
    if value.startswith("//"):
        return f"{parsed_base.scheme}:{value}"
    if value.startswith("/"):
        return urlunsplit((parsed_base.scheme, parsed_base.netloc, value, "", ""))
    base_path = parsed_base.path
    directory = base_path[: base_path.rfind("/") + 1] if "/" in base_path else "/"
    return urlunsplit(
        (parsed_base.scheme, parsed_base.netloc, directory + value, "", "")
    )


def canonical_hostname(hostname: str) -> str:
    if ":" in hostname:
        try:
            return f"[{ipaddress.IPv6Address(hostname).compressed}]"
        except ValueError:
            raise ValueError("invalid IPv6 host") from None
    try:
        decoded_hostname = unquote_to_bytes(hostname).decode("utf-8")
    except UnicodeError:
        raise ValueError("invalid encoded host") from None
    ascii_hostname = _idna_hostname(decoded_hostname)
    canonical_ipv4 = _canonical_whatwg_ipv4(ascii_hostname)
    if canonical_ipv4 is not None:
        return canonical_ipv4
    return ascii_hostname


def _canonical_whatwg_ipv4(hostname: str) -> str | None:
    parts = hostname.split(".")
    if len(parts) > 1 and parts[-1] == "":
        parts.pop()
    if not parts:
        return None
    last_number = _parse_whatwg_ipv4_number(parts[-1])
    if last_number is None and _ASCII_DECIMAL.fullmatch(parts[-1]) is None:
        return None
    if len(parts) > 4:
        raise ValueError("invalid numeric IPv4 host")

    numbers: list[int] = []
    for part in parts:
        number = _parse_whatwg_ipv4_number(part)
        if number is None:
            raise ValueError("invalid numeric IPv4 host")
        numbers.append(number)
    if any(number > 255 for number in numbers[:-1]):
        raise ValueError("invalid numeric IPv4 host")
    if numbers[-1] >= 256 ** (5 - len(numbers)):
        raise ValueError("invalid numeric IPv4 host")

    value = numbers[-1]
    for index, number in enumerate(numbers[:-1]):
        value += number * 256 ** (3 - index)
    return str(ipaddress.IPv4Address(value))


def _parse_whatwg_ipv4_number(value: str) -> int | None:
    if value == "":
        return None
    radix = 10
    digits = value
    if len(digits) >= 2 and digits[:2].lower() == "0x":
        digits = digits[2:]
        radix = 16
        pattern = _ASCII_HEXADECIMAL
    elif len(digits) >= 2 and digits.startswith("0"):
        digits = digits[1:]
        radix = 8
        pattern = _ASCII_OCTAL
    else:
        pattern = _ASCII_DECIMAL
    if digits == "":
        return 0
    if pattern.fullmatch(digits) is None:
        return None
    return int(digits, radix)


def _idna_hostname(hostname: str) -> str:
    try:
        encoded = domain_to_ascii(hostname, be_strict=False)
    except (TypeError, ValueError):
        raise ValueError("invalid IDNA host") from None
    if not encoded or not encoded.isascii():
        raise ValueError("invalid IDNA host")
    return encoded.lower()


def _remove_dot_segments(path: str) -> str:
    remaining = path
    output = ""
    while remaining:
        if remaining.startswith("../"):
            remaining = remaining[3:]
        elif remaining.startswith("./"):
            remaining = remaining[2:]
        elif remaining.startswith("/./"):
            remaining = remaining[2:]
        elif remaining == "/.":
            remaining = "/"
        elif remaining.startswith("/../"):
            remaining = remaining[3:]
            output = output[: output.rfind("/")] if "/" in output else ""
        elif remaining == "/..":
            remaining = "/"
            output = output[: output.rfind("/")] if "/" in output else ""
        elif remaining in {".", ".."}:
            remaining = ""
        else:
            next_slash = remaining.find("/", 1 if remaining.startswith("/") else 0)
            if next_slash == -1:
                output += remaining
                remaining = ""
            else:
                output += remaining[:next_slash]
                remaining = remaining[next_slash:]
    return output


def _normalize_encoded_dot_segments(path: str) -> str:
    normalized: list[str] = []
    for segment in path.split("/"):
        lowered = segment.lower()
        candidate = lowered.replace("%2e", ".")
        normalized.append(candidate if candidate in {".", ".."} else segment)
    return "/".join(normalized)


def _is_ascii_control_or_space(character: str) -> bool:
    value = ord(character)
    return value <= 0x20 or value == 0x7F

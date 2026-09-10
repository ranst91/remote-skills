"""Explicit origin configuration for catalog discovery."""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
import ipaddress
import math
import re
from types import MappingProxyType
from typing import Literal
from urllib.parse import SplitResult, urlsplit, urlunsplit

from .catalog_errors import CatalogError
from .catalog_scope import SCOPE_HEADER, is_valid_scope
from .catalog_url import canonical_hostname, canonical_http_url


_HEADER_NAME = re.compile(r"[!#$%&'*+.^_`|~0-9A-Za-z-]+\Z")
_FORBIDDEN_HEADERS = frozenset(
    {"connection", "content-length", "host", "transfer-encoding"}
)
_STANDARD_SENSITIVE_HEADERS = frozenset(
    {"authorization", "cookie", "proxy-authorization", "set-cookie", "x-api-key"}
)
_CATALOG_PATH = "/.well-known/agent-skills/index.json"
_MAX_RETRIES = 10
_MAX_TIMEOUT_SECONDS = 300.0
_MAX_CATALOG_BYTES = 52_428_800
_MAX_REDIRECTS = 5

RequestPurpose = Literal["archive", "artifact", "catalog", "skill-md"]


@dataclass(frozen=True, slots=True)
class CatalogDefaults:
    """Defaults applied only when an origin omits the corresponding setting."""

    timeout: float = 30.0
    retries: int = 2
    catalog_bytes: int = 1_048_576

    def __post_init__(self) -> None:
        _validate_timeout(self.timeout, "timeout")
        _validate_retries(self.retries, "retries")
        _validate_catalog_bytes(self.catalog_bytes, "catalog_bytes")
        object.__setattr__(self, "timeout", float(self.timeout))


@dataclass(frozen=True, slots=True)
class NetworkPolicy:
    """Explicit address exceptions and a finite redirect bound."""

    allowed_addresses: frozenset[str] = field(default_factory=frozenset)
    max_redirects: int = _MAX_REDIRECTS

    def __post_init__(self) -> None:
        if isinstance(self.allowed_addresses, str):
            raise CatalogError.configuration("allowed_addresses")
        normalized = _normalize_allowed_addresses(self.allowed_addresses)
        if (
            isinstance(self.max_redirects, bool)
            or not isinstance(self.max_redirects, int)
            or not 0 <= self.max_redirects <= _MAX_REDIRECTS
        ):
            raise CatalogError.configuration("max_redirects")
        object.__setattr__(self, "allowed_addresses", normalized)


@dataclass(frozen=True, slots=True)
class Origin:
    """Network settings for one explicitly named origin."""

    url: str
    headers: Mapping[str, str] = field(default_factory=dict, repr=False)
    scope: str | None = None
    sensitive_header_names: frozenset[str] = field(
        default_factory=frozenset, repr=False
    )
    artifact_headers: Mapping[str, Mapping[str, str]] = field(
        default_factory=dict, repr=False
    )
    artifact_sensitive_header_names: Mapping[str, frozenset[str]] = field(
        default_factory=dict, repr=False
    )
    timeout: float | None = None
    retries: int | None = None
    allow_loopback_http: bool = False
    catalog_bytes: int | None = None
    network_policy: NetworkPolicy = field(default_factory=NetworkPolicy)
    _parsed_url: SplitResult = field(init=False, repr=False, compare=False)
    _timeout_configured: bool = field(init=False, repr=False, compare=False)
    _retries_configured: bool = field(init=False, repr=False, compare=False)
    _catalog_bytes_configured: bool = field(init=False, repr=False, compare=False)

    def __post_init__(self) -> None:
        if not isinstance(self.allow_loopback_http, bool):
            raise CatalogError.configuration("allow_loopback_http")
        parsed = _normalize_origin_url(self.url, self.allow_loopback_http)
        if parsed is None:
            raise CatalogError.configuration("url") from None
        if self.allow_loopback_http and parsed.scheme.lower() != "http":
            raise CatalogError.configuration("allow_loopback_http")
        timeout_configured = self.timeout is not None
        retries_configured = self.retries is not None
        catalog_bytes_configured = self.catalog_bytes is not None
        timeout = 30.0 if self.timeout is None else self.timeout
        retries = 2 if self.retries is None else self.retries
        catalog_bytes = 1_048_576 if self.catalog_bytes is None else self.catalog_bytes
        _validate_timeout(timeout, "timeout")
        _validate_retries(retries, "retries")
        _validate_catalog_bytes(catalog_bytes, "catalog_bytes")
        if not isinstance(self.network_policy, NetworkPolicy):
            raise CatalogError.configuration("network_policy")
        if self.scope is not None and not is_valid_scope(self.scope):
            raise CatalogError.configuration("scope")

        normalized_headers = _normalize_headers(self.headers, field_name="headers")
        if SCOPE_HEADER in normalized_headers:
            raise CatalogError.configuration(SCOPE_HEADER)
        sensitive_header_names = _normalize_sensitive_names(
            self.sensitive_header_names,
            normalized_headers,
            field_name="sensitive_header_names",
        )

        if not isinstance(self.artifact_headers, Mapping):
            raise CatalogError.configuration("artifact_headers")
        normalized_artifact_headers: dict[str, Mapping[str, str]] = {}
        for host, host_headers in self.artifact_headers.items():
            host_key = _normalize_host_key(host, field_name="artifact_headers")
            normalized_artifact_headers[host_key] = MappingProxyType(
                _normalize_headers(host_headers, field_name="artifact_headers")
            )
            if SCOPE_HEADER in normalized_artifact_headers[host_key]:
                raise CatalogError.configuration(SCOPE_HEADER)

        if not isinstance(self.artifact_sensitive_header_names, Mapping):
            raise CatalogError.configuration("artifact_sensitive_header_names")
        normalized_artifact_sensitive: dict[str, frozenset[str]] = {}
        for host, names in self.artifact_sensitive_header_names.items():
            host_key = _normalize_host_key(
                host, field_name="artifact_sensitive_header_names"
            )
            host_headers = normalized_artifact_headers.get(host_key)
            if host_headers is None:
                raise CatalogError.configuration("artifact_sensitive_header_names")
            normalized_artifact_sensitive[host_key] = _normalize_sensitive_names(
                names,
                host_headers,
                field_name="artifact_sensitive_header_names",
            )

        object.__setattr__(self, "headers", MappingProxyType(normalized_headers))
        object.__setattr__(self, "sensitive_header_names", sensitive_header_names)
        object.__setattr__(
            self, "artifact_headers", MappingProxyType(normalized_artifact_headers)
        )
        object.__setattr__(
            self,
            "artifact_sensitive_header_names",
            MappingProxyType(normalized_artifact_sensitive),
        )
        object.__setattr__(self, "timeout", float(timeout))
        object.__setattr__(self, "retries", retries)
        object.__setattr__(self, "catalog_bytes", catalog_bytes)
        object.__setattr__(self, "_timeout_configured", timeout_configured)
        object.__setattr__(self, "_retries_configured", retries_configured)
        object.__setattr__(self, "_catalog_bytes_configured", catalog_bytes_configured)
        object.__setattr__(self, "url", urlunsplit(parsed))
        object.__setattr__(self, "_parsed_url", parsed)

    @property
    def catalog_url(self) -> str:
        return urlunsplit(
            (
                self._parsed_url.scheme.lower(),
                self._parsed_url.netloc.lower(),
                _CATALOG_PATH,
                "",
                "",
            )
        )

    def headers_for(
        self, request_url: str, purpose: RequestPurpose = "artifact"
    ) -> Mapping[str, str]:
        """Return credentials only for the exact configured authority."""

        request = urlsplit(request_url)
        if _authority(request) == _authority(self._parsed_url):
            return self.headers
        if purpose == "catalog":
            return {}
        return self.artifact_headers.get(_request_host_key(request), {})

    def with_defaults(self, defaults: CatalogDefaults) -> Origin:
        """Return an equivalent origin with global defaults resolved."""

        return Origin(
            url=self.url,
            headers=self.headers,
            scope=self.scope,
            sensitive_header_names=self.sensitive_header_names,
            artifact_headers=self.artifact_headers,
            artifact_sensitive_header_names=self.artifact_sensitive_header_names,
            timeout=self.timeout if self._timeout_configured else defaults.timeout,
            retries=self.retries if self._retries_configured else defaults.retries,
            allow_loopback_http=self.allow_loopback_http,
            catalog_bytes=(
                self.catalog_bytes
                if self._catalog_bytes_configured
                else defaults.catalog_bytes
            ),
            network_policy=self.network_policy,
        )

    def sensitive_headers_for(self, request_url: str) -> frozenset[str]:
        """Return sensitive names without exposing configured values."""

        request = urlsplit(request_url)
        if _authority(request) == _authority(self._parsed_url):
            standard_sensitive = frozenset(
                name for name in self.headers if name in _STANDARD_SENSITIVE_HEADERS
            )
            return self.sensitive_header_names | standard_sensitive
        host_key = _request_host_key(request)
        artifact_headers = self.artifact_headers.get(host_key, {})
        standard_sensitive = frozenset(
            name for name in artifact_headers if name in _STANDARD_SENSITIVE_HEADERS
        )
        return (
            self.artifact_sensitive_header_names.get(host_key, frozenset())
            | standard_sensitive
        )


def evaluate_ip_address(
    address: str, *, origin_alias: str, allow_loopback: bool = False
) -> None:
    """Reject every non-global address except explicitly allowed loopback."""

    try:
        parsed = ipaddress.ip_address(address)
    except ValueError:
        raise CatalogError.policy_denied(origin_alias) from None

    mapped = parsed.ipv4_mapped if isinstance(parsed, ipaddress.IPv6Address) else None
    effective = mapped or parsed
    if allow_loopback and effective.is_loopback:
        return
    if isinstance(effective, ipaddress.IPv4Address):
        allowed = _is_public_ipv4(effective)
    else:
        allowed = _is_public_ipv6(effective)
    if not allowed:
        raise CatalogError.policy_denied(origin_alias)


_DENIED_IPV4 = tuple(
    ipaddress.ip_network(network)
    for network in (
        "0.0.0.0/8",
        "10.0.0.0/8",
        "100.64.0.0/10",
        "127.0.0.0/8",
        "169.254.0.0/16",
        "172.16.0.0/12",
        "192.0.0.0/24",
        "192.0.2.0/24",
        "192.88.99.0/24",
        "192.168.0.0/16",
        "198.18.0.0/15",
        "198.51.100.0/24",
        "203.0.113.0/24",
        "224.0.0.0/4",
        "240.0.0.0/4",
    )
)

_PUBLIC_IPV6 = tuple(
    ipaddress.ip_network(network)
    for network in (
        "64:ff9b::/96",
        "2001:1::1/128",
        "2001:1::2/128",
        "2001:1::3/128",
        "2001:3::/32",
        "2001:4:112::/48",
        "2001:20::/28",
        "2001:30::/28",
        "2001:200::/23",
        "2001:400::/23",
        "2001:600::/23",
        "2001:800::/22",
        "2001:c00::/23",
        "2001:e00::/23",
        "2001:1200::/23",
        "2001:1400::/22",
        "2001:1800::/23",
        "2001:1a00::/23",
        "2001:1c00::/22",
        "2001:2000::/19",
        "2001:4000::/23",
        "2001:4200::/23",
        "2001:4400::/23",
        "2001:4600::/23",
        "2001:4800::/23",
        "2001:4a00::/23",
        "2001:4c00::/23",
        "2001:5000::/20",
        "2001:8000::/19",
        "2001:a000::/20",
        "2001:b000::/20",
        "2003::/18",
        "2400::/11",
        "2600::/12",
        "2610::/23",
        "2620::/23",
        "2630::/12",
        "2800::/12",
        "2a00::/11",
        "2c00::/12",
    )
)
_DENIED_IPV6 = (ipaddress.ip_network("2001:db8::/32"),)


def _is_public_ipv4(address: ipaddress.IPv4Address) -> bool:
    return not any(address in network for network in _DENIED_IPV4)


def _is_public_ipv6(address: ipaddress.IPv6Address) -> bool:
    return not any(address in network for network in _DENIED_IPV6) and any(
        address in network for network in _PUBLIC_IPV6
    )


def _validate_timeout(value: object, field_name: str) -> None:
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(value)
        or value <= 0
        or value > _MAX_TIMEOUT_SECONDS
    ):
        raise CatalogError.configuration(field_name)


def _validate_retries(value: object, field_name: str) -> None:
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or not 0 <= value <= _MAX_RETRIES
    ):
        raise CatalogError.configuration(field_name)


def _validate_catalog_bytes(value: object, field_name: str) -> None:
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or not 1 <= value <= _MAX_CATALOG_BYTES
    ):
        raise CatalogError.configuration(field_name)


def _normalize_origin_url(
    raw_url: object, allow_loopback_http: bool
) -> SplitResult | None:
    if not isinstance(raw_url, str):
        return None
    try:
        parsed = urlsplit(canonical_http_url(raw_url))
    except (TypeError, ValueError):
        return None
    if (
        not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
    ):
        return None
    scheme = parsed.scheme.lower()
    if scheme == "https":
        pass
    elif scheme != "http" or not allow_loopback_http:
        return None
    elif parsed.hostname.lower() != "localhost":
        try:
            if not ipaddress.ip_address(parsed.hostname).is_loopback:
                return None
        except ValueError:
            return None
    return SplitResult(
        scheme,
        parsed.netloc,
        parsed.path or "/",
        "",
        "",
    )


def _authority(parsed: SplitResult) -> str | None:
    try:
        canonical = _canonical_authority(parsed)
    except ValueError:
        return None
    if canonical is None:
        return None
    return canonical


def _normalize_headers(
    headers: Mapping[str, str], *, field_name: str
) -> dict[str, str]:
    if not isinstance(headers, Mapping):
        raise CatalogError.configuration(field_name)
    normalized: dict[str, str] = {}
    for name, value in headers.items():
        if (
            not isinstance(name, str)
            or _HEADER_NAME.fullmatch(name) is None
            or name.lower() in _FORBIDDEN_HEADERS
            or not isinstance(value, str)
            or any(
                ord(character) < 32 or ord(character) == 127 or ord(character) > 255
                for character in value
            )
        ):
            raise CatalogError.configuration(field_name)
        lower_name = name.lower()
        if lower_name in normalized:
            raise CatalogError.configuration(field_name)
        normalized[lower_name] = value
    return normalized


def _normalize_sensitive_names(
    names: object, headers: Mapping[str, str], *, field_name: str
) -> frozenset[str]:
    if isinstance(names, str) or not isinstance(names, Iterable):
        raise CatalogError.configuration(field_name)
    invalid = False
    try:
        normalized = frozenset(name.lower() for name in names)
    except (TypeError, AttributeError):
        invalid = True
        normalized = frozenset()
    if invalid:
        raise CatalogError.configuration(field_name) from None
    if any(_HEADER_NAME.fullmatch(name) is None for name in normalized):
        raise CatalogError.configuration(field_name)
    if not normalized.issubset(headers):
        raise CatalogError.configuration(field_name)
    return normalized


def _normalize_host_key(host: object, *, field_name: str) -> str:
    if (
        not isinstance(host, str)
        or not host
        or any(character in host for character in "/@?#")
    ):
        raise CatalogError.configuration(field_name)
    try:
        parsed = urlsplit(f"https://{host}/")
        canonical = _canonical_authority(parsed)
    except (TypeError, ValueError):
        canonical = None
    if canonical is None or parsed.netloc.lower() != canonical:
        raise CatalogError.configuration(field_name) from None
    return canonical


def _request_host_key(parsed: SplitResult) -> str:
    try:
        return _canonical_authority(parsed) or ""
    except ValueError:
        return ""


def _canonical_authority(parsed: SplitResult) -> str | None:
    scheme = parsed.scheme.lower()
    hostname = parsed.hostname
    if scheme not in {"http", "https"} or hostname is None:
        return None
    try:
        canonical_host = canonical_hostname(hostname)
    except ValueError:
        return None
    port = parsed.port
    default_port = 443 if scheme == "https" else 80
    if port is not None and port != default_port:
        return f"{canonical_host}:{port}"
    return canonical_host


def _normalize_allowed_addresses(addresses: object) -> frozenset[str]:
    if isinstance(addresses, str) or not isinstance(addresses, Iterable):
        raise CatalogError.configuration("allowed_addresses") from None
    normalized: set[str] = set()
    invalid = False
    try:
        for address in addresses:
            if not isinstance(address, str):
                invalid = True
                break
            normalized.add(str(ipaddress.ip_address(address)).lower())
    except (TypeError, ValueError):
        invalid = True
    if invalid:
        raise CatalogError.configuration("allowed_addresses") from None
    return frozenset(normalized)

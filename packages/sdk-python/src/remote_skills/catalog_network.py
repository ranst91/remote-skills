"""Bounded asynchronous HTTP behavior for catalog discovery."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field
import http.client
import ipaddress
import math
import random
import re
import socket
import ssl
import time
from types import MappingProxyType
from typing import Protocol, TypeVar
from urllib.parse import SplitResult, urlsplit, urlunsplit

from .catalog_errors import CatalogError
from .catalog_http_date import parse_imf_fixdate, trim_ecmascript_whitespace
from .catalog_origin import Origin, RequestPurpose, evaluate_ip_address
from .catalog_scope import SCOPE_HEADER
from .catalog_url import canonical_http_url


_SENSITIVE_HEADERS = frozenset(
    {"authorization", "cookie", "proxy-authorization", "set-cookie", "x-api-key"}
)
_REDIRECT_STATUSES = frozenset({301, 302, 303, 307, 308})
_RETRY_STATUSES = frozenset({408, 429})
_RETRY_AFTER_CAP_SECONDS = 5.0
_MAX_HEADER_BYTES = 65_536
_MAX_HEADER_COUNT = 100
_MAX_INFORMATIONAL_RESPONSES = 100
_MAX_RESOLVED_ADDRESSES = 256
# The longest textual IP literal is an IPv6 address with an embedded dotted
# IPv4 tail: six four-digit hex groups, six colons, and 15 IPv4 characters.
_MAX_IP_ADDRESS_TEXT_LENGTH = 45
_HEADER_NAME = re.compile(r"[!#$%&'*+\-.^_`|~0-9A-Za-z]+\Z")
_CONTENT_LENGTH = re.compile(r"[0-9]+\Z")
_STATUS_CODE = re.compile(rb"[0-9]{3}\Z")
_CHUNK_SIZE = re.compile(rb"[0-9A-Fa-f]+")
_RETRY_AFTER_DELTA = re.compile(r"[0-9]+\Z")
_TOKEN_BYTES = frozenset(
    b"!#$%&'*+-.^_`|~0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
)
_ACCEPT_BY_PURPOSE: Mapping[RequestPurpose, str] = MappingProxyType(
    {
        "archive": "application/octet-stream",
        "artifact": "application/octet-stream",
        "catalog": "application/json",
        "skill-md": "text/markdown",
    }
)
_SUPPORTED_ACCEPT_OVERRIDES = frozenset(
    {
        "application/gzip",
        "application/json",
        "application/octet-stream",
        "application/zip",
        "text/markdown",
    }
)
_T = TypeVar("_T")
_BACKGROUND_TASKS: set[asyncio.Task[object]] = set()


@dataclass(frozen=True, slots=True)
class HttpResponse:
    status: int
    headers: Mapping[str, str]
    body: bytes = field(repr=False)
    url: str | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "headers", _normalize_response_headers(self.headers))
        if self.url is not None:
            try:
                sanitized_url = _sanitized_url(self.url)
            except ValueError:
                raise _TransportProtocolError from None
            object.__setattr__(self, "url", sanitized_url)


class AsyncTransport(Protocol):
    """The sole transport seam receives only a pre-vetted connection target."""

    async def request(
        self,
        url: str,
        headers: dict[str, str],
        timeout: float,
        connect_address: str,
        max_bytes: int,
    ) -> HttpResponse: ...


class _ResponseTooLarge(Exception):
    pass


class _TransportProtocolError(OSError):
    pass


class _BoundaryFailure(OSError):
    pass


def _normalize_response_headers(headers: Mapping[str, str]) -> Mapping[str, str]:
    normalized: dict[str, str] = {}
    total_bytes = 0
    for index, (name, value) in enumerate(headers.items()):
        if (
            index >= _MAX_HEADER_COUNT
            or type(name) is not str
            or type(value) is not str
        ):
            raise _TransportProtocolError
        total_bytes += len(name) + 4
        if total_bytes > _MAX_HEADER_BYTES:
            raise _TransportProtocolError
        if _HEADER_NAME.fullmatch(name) is None:
            raise _TransportProtocolError
        for character in value:
            codepoint = ord(character)
            if (codepoint < 32 and character != "\t") or codepoint == 127:
                raise _TransportProtocolError
            if codepoint <= 0x7F:
                total_bytes += 1
            elif codepoint <= 0x7FF:
                total_bytes += 2
            elif 0xD800 <= codepoint <= 0xDFFF:
                raise _TransportProtocolError
            elif codepoint <= 0xFFFF:
                total_bytes += 3
            else:
                total_bytes += 4
            if total_bytes > _MAX_HEADER_BYTES:
                raise _TransportProtocolError
        lower_name = name.lower()
        normalized_value = value.strip(" \t")
        if lower_name in normalized:
            normalized[lower_name] = f"{normalized[lower_name]}, {normalized_value}"
        else:
            normalized[lower_name] = normalized_value
    return MappingProxyType(normalized)


class StdlibTransport:
    """Cancellation-aware HTTP transport pinned to a policy-checked address."""

    async def request(
        self,
        url: str,
        headers: dict[str, str],
        timeout: float,
        connect_address: str,
        max_bytes: int,
    ) -> HttpResponse:
        del timeout  # The caller owns the deadline; cleanup always aborts.
        parsed = urlsplit(url)
        host = parsed.hostname
        if host is None:
            raise _TransportProtocolError
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
        ssl_context = ssl.create_default_context() if parsed.scheme == "https" else None
        family = socket.AF_INET6 if ":" in connect_address else socket.AF_INET
        writer: asyncio.StreamWriter | None = None
        try:
            reader, writer = await asyncio.open_connection(
                host=connect_address,
                port=port,
                family=family,
                ssl=ssl_context,
                server_hostname=host if ssl_context is not None else None,
            )
            wire_headers = {
                "host": _host_header(parsed),
                "connection": "close",
                **headers,
            }
            request_target = parsed.path or "/"
            lines = [f"GET {request_target} HTTP/1.1"]
            lines.extend(f"{name}: {value}" for name, value in wire_headers.items())
            writer.write(("\r\n".join(lines) + "\r\n\r\n").encode("latin-1"))
            await writer.drain()
            informational_responses = 0
            while True:
                status, response_headers = await _read_response_head(reader)
                if status == 101 or not 100 <= status < 200:
                    break
                informational_responses += 1
                if informational_responses > _MAX_INFORMATIONAL_RESPONSES:
                    raise _TransportProtocolError
            body = await _read_response_body(
                reader, status=status, headers=response_headers, max_bytes=max_bytes
            )
            return HttpResponse(status, response_headers, body)
        except _ResponseTooLarge:
            raise
        except (asyncio.IncompleteReadError, ValueError, UnicodeError) as error:
            raise _TransportProtocolError from error
        finally:
            if writer is not None:
                writer.close()
                _abort_writer(writer)


def _abort_writer(writer: asyncio.StreamWriter) -> None:
    transport = getattr(writer, "transport", None)
    abort = getattr(transport, "abort", None)
    if callable(abort):
        abort()


@dataclass(frozen=True, slots=True)
class PreparedCatalogRequest:
    url: str
    headers: Mapping[str, str]
    sensitive_header_names: tuple[str, ...]
    _wire_headers: Mapping[str, str] = field(repr=False)

    @property
    def wire_headers(self) -> dict[str, str]:
        return dict(self._wire_headers)

    def normalized(self) -> dict[str, object]:
        return {
            "method": "GET",
            "url": _sanitized_url(self.url),
            "headers": dict(self.headers),
            "sensitive_header_names": list(self.sensitive_header_names),
        }


@dataclass(frozen=True, slots=True)
class NetworkResult:
    response: HttpResponse | None
    error: CatalogError | None
    attempts: int
    delays_ms: tuple[int, ...] = ()
    jitter_slots: tuple[int, ...] = ()


Resolver = Callable[[str], Awaitable[tuple[str, ...]]]
Sleeper = Callable[[float], Awaitable[None]]
Entropy = Callable[[], float]


def build_catalog_request(
    origin: Origin, *, validators: Mapping[str, str] | None = None
) -> PreparedCatalogRequest:
    """Build an exact catalog GET while separating sensitive header values."""

    wire_headers = {"accept": "application/json", **origin.headers}
    if origin.scope is not None:
        wire_headers[SCOPE_HEADER] = origin.scope
    if validators:
        etag = validators.get("etag")
        last_modified = validators.get("last_modified")
        if etag:
            wire_headers["if-none-match"] = etag
        if last_modified:
            wire_headers["if-modified-since"] = last_modified

    configured_sensitive = origin.sensitive_headers_for(origin.catalog_url)
    sensitive = tuple(
        sorted(
            name
            for name in wire_headers
            if name in _SENSITIVE_HEADERS or name in configured_sensitive
        )
    )
    visible = {
        name: value for name, value in wire_headers.items() if name not in sensitive
    }
    return PreparedCatalogRequest(
        url=origin.catalog_url,
        headers=MappingProxyType(visible),
        sensitive_header_names=sensitive,
        _wire_headers=MappingProxyType(dict(wire_headers)),
    )


async def request_with_policy(
    *,
    origin_alias: str,
    origin: Origin,
    url: str,
    transport: AsyncTransport,
    resolver: Resolver,
    purpose: RequestPurpose = "catalog",
    request_headers: Mapping[str, str] | None = None,
    sleeper: Sleeper = asyncio.sleep,
    entropy: Entropy = random.random,
    wall_clock: Callable[[], float] = time.time,
    max_bytes: int | None = None,
    response_limit: str = "catalog_bytes",
    accept: str | None = None,
) -> NetworkResult:
    """Perform bounded idempotent GET attempts under caller cancellation."""

    attempts = 0
    delays_ms: list[int] = []
    jitter_slots: list[int] = []
    timeout = origin.timeout
    retries = origin.retries
    if timeout is None or retries is None:
        raise AssertionError("origin defaults were not resolved")
    loop = asyncio.get_running_loop()
    selected_max_bytes = origin.catalog_bytes if max_bytes is None else max_bytes
    if (
        isinstance(selected_max_bytes, bool)
        or not isinstance(selected_max_bytes, int)
        or selected_max_bytes < 1
    ):
        raise CatalogError.configuration("max_bytes")
    if type(response_limit) is not str or not response_limit:
        raise CatalogError.configuration("response_limit")
    if accept is not None and accept not in _SUPPORTED_ACCEPT_OVERRIDES:
        raise CatalogError.configuration("accept")
    selected_accept = _ACCEPT_BY_PURPOSE[purpose] if accept is None else accept

    async def run() -> NetworkResult:
        nonlocal attempts
        for attempt in range(retries + 1):
            attempts = attempt + 1
            attempt_deadline = loop.time() + timeout
            try:
                response = await _within_deadline(
                    lambda: _request_redirect_chain(
                        origin_alias=origin_alias,
                        origin=origin,
                        url=url,
                        purpose=purpose,
                        transport=transport,
                        resolver=resolver,
                        request_headers=request_headers,
                        deadline=attempt_deadline,
                        max_bytes=selected_max_bytes,
                        accept=selected_accept,
                    ),
                    attempt_deadline,
                )
            except CatalogError as error:
                if not error.retryable or attempt == retries:
                    return NetworkResult(
                        None, error, attempts, tuple(delays_ms), tuple(jitter_slots)
                    )
                delay = _jitter_delay(attempt, entropy, jitter_slots)
                delays_ms.append(round(delay * 1000))
                await sleeper(delay)
                continue
            except _ResponseTooLarge:
                return NetworkResult(
                    None,
                    CatalogError(
                        "limit_exceeded",
                        retryable=False,
                        context={
                            "origin_alias": origin_alias,
                            "limit": response_limit,
                        },
                    ),
                    attempts,
                    tuple(delays_ms),
                    tuple(jitter_slots),
                )
            except (asyncio.TimeoutError, TimeoutError):
                failure = "timeout"
            except (http.client.HTTPException, asyncio.IncompleteReadError, OSError):
                failure = "network"
            else:
                if response.status in {200, 304}:
                    return NetworkResult(
                        response,
                        None,
                        attempts,
                        tuple(delays_ms),
                        tuple(jitter_slots),
                    )
                if response.status in {401, 403}:
                    context: dict[str, object] = {
                        "origin_alias": origin_alias,
                        "status": response.status,
                    }
                    if origin.scope is not None:
                        context["scope"] = origin.scope
                    return NetworkResult(
                        None,
                        CatalogError(
                            "authentication_failed"
                            if response.status == 401
                            else "authorization_denied",
                            retryable=False,
                            context=context,
                        ),
                        attempts,
                        tuple(delays_ms),
                        tuple(jitter_slots),
                    )
                if not _retryable_status(response.status) or attempt == retries:
                    return NetworkResult(
                        None,
                        CatalogError(
                            "origin_unavailable",
                            retryable=True,
                            context={
                                "origin_alias": origin_alias,
                                "status": response.status,
                            },
                        ),
                        attempts,
                        tuple(delays_ms),
                        tuple(jitter_slots),
                    )
                retry_after = _retry_after_seconds(
                    response.headers.get("retry-after"), wall_clock()
                )
                delay = (
                    retry_after
                    if retry_after is not None
                    else _jitter_delay(attempt, entropy, jitter_slots)
                )
                delays_ms.append(round(delay * 1000))
                await sleeper(delay)
                continue

            if attempt == retries:
                code = (
                    "request_timeout" if failure == "timeout" else "origin_unavailable"
                )
                return NetworkResult(
                    None,
                    CatalogError(
                        code, retryable=True, context={"origin_alias": origin_alias}
                    ),
                    attempts,
                    tuple(delays_ms),
                    tuple(jitter_slots),
                )
            delay = _jitter_delay(attempt, entropy, jitter_slots)
            delays_ms.append(round(delay * 1000))
            await sleeper(delay)
        raise AssertionError("bounded retry loop exhausted without a result")

    return await run()


async def _request_redirect_chain(
    *,
    origin_alias: str,
    origin: Origin,
    url: str,
    purpose: RequestPurpose,
    transport: AsyncTransport,
    resolver: Resolver,
    request_headers: Mapping[str, str] | None,
    deadline: float,
    max_bytes: int,
    accept: str,
) -> HttpResponse:
    current_url = url
    max_redirects = origin.network_policy.max_redirects
    for redirect_count in range(max_redirects + 1):
        _remaining(deadline)
        parsed = _validate_request_url(
            current_url, origin_alias=origin_alias, origin=origin
        )
        addresses = await _resolve_addresses(parsed, resolver)
        if not addresses:
            raise CatalogError.policy_denied(origin_alias)
        _evaluate_addresses(addresses, parsed, origin_alias=origin_alias, origin=origin)

        conditional_headers = {
            name: value
            for name, value in (request_headers or {}).items()
            if name in {"if-modified-since", "if-none-match"}
        }
        headers = {
            "accept": accept,
            **origin.headers_for(current_url, purpose),
            **conditional_headers,
        }
        if purpose == "catalog" and origin.scope is not None:
            headers[SCOPE_HEADER] = origin.scope
        response = await _request_transport(
            transport,
            url=current_url,
            headers=headers,
            timeout=_remaining(deadline),
            connect_address=addresses[0],
            max_bytes=max_bytes,
        )
        if len(response.body) > max_bytes:
            raise _ResponseTooLarge
        if response.status not in _REDIRECT_STATUSES:
            return HttpResponse(
                response.status,
                response.headers,
                response.body,
                url=current_url,
            )

        location = response.headers.get("location")
        if not location or redirect_count == max_redirects:
            raise CatalogError.policy_denied(origin_alias)
        try:
            current_url = canonical_http_url(location, base=current_url)
        except ValueError:
            raise CatalogError.policy_denied(origin_alias) from None

    raise CatalogError.policy_denied(origin_alias)


async def _resolve_addresses(
    parsed: SplitResult, resolver: Resolver
) -> tuple[str, ...]:
    host = parsed.hostname or ""
    try:
        literal = ipaddress.ip_address(host)
    except ValueError:
        try:
            result = await resolver(host)
            return _normalize_resolver_result(result)
        except (asyncio.TimeoutError, TimeoutError):
            raise
        except Exception:
            raise _BoundaryFailure from None
    return (str(literal),)


async def _request_transport(
    transport: AsyncTransport,
    *,
    url: str,
    headers: dict[str, str],
    timeout: float,
    connect_address: str,
    max_bytes: int,
) -> HttpResponse:
    try:
        result = await transport.request(
            url,
            headers,
            timeout,
            connect_address,
            max_bytes,
        )
        return _normalize_transport_response(result)
    except (_ResponseTooLarge, asyncio.TimeoutError, TimeoutError):
        raise
    except Exception:
        raise _BoundaryFailure from None


def _normalize_resolver_result(result: object) -> tuple[str, ...]:
    if isinstance(result, (str, bytes, bytearray)):
        raise _BoundaryFailure
    iterator = iter(result)
    addresses: list[str] = []
    for index, address in enumerate(iterator):
        if (
            index >= _MAX_RESOLVED_ADDRESSES
            or type(address) is not str
            or len(address) > _MAX_IP_ADDRESS_TEXT_LENGTH
        ):
            raise _BoundaryFailure
        addresses.append(address)
    return tuple(addresses)


def _normalize_transport_response(result: object) -> HttpResponse:
    status = result.status
    if type(status) is not int or not 0 <= status <= 999:
        raise _BoundaryFailure
    headers = result.headers
    if not isinstance(headers, Mapping):
        raise _BoundaryFailure
    normalized_headers = _normalize_response_headers(headers)
    body = result.body
    if type(body) is not bytes:
        raise _BoundaryFailure
    return HttpResponse(status, normalized_headers, body)


def _evaluate_addresses(
    addresses: tuple[str, ...],
    parsed: SplitResult,
    *,
    origin_alias: str,
    origin: Origin,
) -> None:
    if parsed.scheme.lower() == "http":
        if not origin.allow_loopback_http or not all(
            _is_loopback_address(address) for address in addresses
        ):
            raise CatalogError.policy_denied(origin_alias)
        return
    allowed = origin.network_policy.allowed_addresses
    for address in addresses:
        try:
            normalized = str(ipaddress.ip_address(address)).lower()
        except ValueError:
            raise CatalogError.policy_denied(origin_alias) from None
        if normalized not in allowed:
            evaluate_ip_address(address, origin_alias=origin_alias)


def _validate_request_url(
    url: str, *, origin_alias: str, origin: Origin
) -> SplitResult:
    try:
        parsed = urlsplit(url)
        parsed.port
    except ValueError:
        raise CatalogError.policy_denied(origin_alias) from None
    scheme = parsed.scheme.lower()
    if (
        not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or scheme not in {"http", "https"}
        or (scheme == "http" and not origin.allow_loopback_http)
    ):
        raise CatalogError.policy_denied(origin_alias)
    return parsed


def _is_loopback_address(address: str) -> bool:
    try:
        parsed = ipaddress.ip_address(address)
    except ValueError:
        return False
    mapped = parsed.ipv4_mapped if isinstance(parsed, ipaddress.IPv6Address) else None
    return (mapped or parsed).is_loopback


def _retryable_status(status: int) -> bool:
    return status in _RETRY_STATUSES or status >= 500


def _retry_after_seconds(value: str | None, now: float) -> float | None:
    if value is None:
        return None
    field_value = trim_ecmascript_whitespace(value)
    if _RETRY_AFTER_DELTA.fullmatch(field_value) is not None:
        significant = field_value.lstrip("0") or "0"
        if len(significant) > 1:
            return _RETRY_AFTER_CAP_SECONDS
        return min(float(int(significant)), _RETRY_AFTER_CAP_SECONDS)
    retry_at = parse_imf_fixdate(field_value)
    if retry_at is None:
        return None
    return min(max(0.0, retry_at - now), _RETRY_AFTER_CAP_SECONDS)


def _jitter_delay(attempt: int, entropy: Entropy, slots: list[int]) -> float:
    slots.append(attempt)
    value = entropy()
    if not isinstance(value, (int, float)) or not math.isfinite(value):
        value = 0.0
    bounded = max(0.0, min(float(value), 0.999_999))
    window = min(0.25 * (2**attempt), _RETRY_AFTER_CAP_SECONDS)
    return math.floor(bounded * window * 1000) / 1000


def _remaining(deadline: float) -> float:
    remaining = deadline - asyncio.get_running_loop().time()
    if remaining <= 0:
        raise asyncio.TimeoutError
    return remaining


async def _within_deadline(
    operation: Callable[[], Awaitable[_T]], deadline: float
) -> _T:
    """Return at the deadline even when an injected boundary suppresses cancellation."""

    loop = asyncio.get_running_loop()
    remaining = deadline - loop.time()
    if remaining <= 0:
        raise asyncio.TimeoutError
    operation_task = asyncio.create_task(operation())
    timer_task = asyncio.create_task(asyncio.sleep(remaining))
    try:
        done, _pending = await asyncio.wait(
            {operation_task, timer_task}, return_when=asyncio.FIRST_COMPLETED
        )
    except BaseException:
        _cancel_and_drain(operation_task)
        _cancel_and_drain(timer_task)
        raise
    if timer_task in done:
        _cancel_and_drain(operation_task)
        # Give cooperative boundaries one loop turn to run their cancellation
        # cleanup; cancellation-resistant work remains detached and contained.
        await asyncio.sleep(0)
        raise asyncio.TimeoutError
    _cancel_and_drain(timer_task)
    return operation_task.result()


def _cancel_and_drain(task: asyncio.Task[object]) -> None:
    task.cancel()
    if task.done():
        try:
            task.exception()
        except (BaseException, asyncio.InvalidStateError):
            pass
        return
    _BACKGROUND_TASKS.add(task)

    def finished(completed: asyncio.Task[object]) -> None:
        _BACKGROUND_TASKS.discard(completed)
        try:
            completed.exception()
        except (BaseException, asyncio.InvalidStateError):
            pass

    task.add_done_callback(finished)


def _sanitized_url(url: str) -> str:
    parsed = urlsplit(url)
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, "", ""))


async def default_resolver(host: str) -> tuple[str, ...]:
    """Resolve all connection candidates immediately before policy evaluation."""

    loop = asyncio.get_running_loop()
    answers = await loop.getaddrinfo(host, None, type=socket.SOCK_STREAM)
    return tuple(dict.fromkeys(answer[4][0] for answer in answers))


def _host_header(parsed: SplitResult) -> str:
    hostname = parsed.hostname or ""
    if ":" in hostname:
        hostname = f"[{hostname}]"
    default_port = 443 if parsed.scheme == "https" else 80
    return (
        hostname if parsed.port in {None, default_port} else f"{hostname}:{parsed.port}"
    )


async def _read_response_head(
    reader: asyncio.StreamReader,
) -> tuple[int, dict[str, str]]:
    status_line = await reader.readline()
    if (
        not status_line
        or len(status_line) > _MAX_HEADER_BYTES
        or not status_line.endswith(b"\r\n")
    ):
        raise _TransportProtocolError
    protocol, separator, remainder = status_line[:-2].partition(b" ")
    if not separator:
        raise _TransportProtocolError
    status_text, _reason_separator, reason = remainder.partition(b" ")
    if _STATUS_CODE.fullmatch(status_text) is None or any(
        (character < 32 and character != 9) or character == 127 for character in reason
    ):
        raise _TransportProtocolError
    if protocol not in {b"HTTP/1.0", b"HTTP/1.1"}:
        raise _TransportProtocolError
    status = int(status_text)

    headers: dict[str, str] = {}
    total = len(status_line)
    for _index in range(_MAX_HEADER_COUNT):
        line = await reader.readline()
        total += len(line)
        if not line or total > _MAX_HEADER_BYTES:
            raise _TransportProtocolError
        if line == b"\r\n":
            _validate_response_framing(headers)
            return status, headers
        normalized_name, normalized_value = _parse_header_line(line)
        if normalized_name in headers:
            headers[normalized_name] = f"{headers[normalized_name]}, {normalized_value}"
        else:
            headers[normalized_name] = normalized_value
    raise _TransportProtocolError


def _parse_header_line(line: bytes) -> tuple[str, str]:
    if not line.endswith(b"\r\n"):
        raise _TransportProtocolError
    name, separator, value = line[:-2].partition(b":")
    if not separator or not name:
        raise _TransportProtocolError
    try:
        normalized_name = name.decode("ascii").lower()
        normalized_value = value.decode("latin-1").strip(" \t")
    except UnicodeError:
        raise _TransportProtocolError from None
    if _HEADER_NAME.fullmatch(normalized_name) is None or any(
        (ord(character) < 32 and character != "\t") or ord(character) == 127
        for character in normalized_value
    ):
        raise _TransportProtocolError
    return normalized_name, normalized_value


def _validate_response_framing(headers: Mapping[str, str]) -> None:
    transfer_encoding = headers.get("transfer-encoding", "")
    content_length = headers.get("content-length")
    if transfer_encoding and content_length is not None:
        raise _TransportProtocolError
    if content_length is not None and _CONTENT_LENGTH.fullmatch(content_length) is None:
        raise _TransportProtocolError


async def _read_response_body(
    reader: asyncio.StreamReader,
    *,
    status: int,
    headers: Mapping[str, str],
    max_bytes: int,
) -> bytes:
    transfer_encoding = headers.get("transfer-encoding", "").lower()
    content_length = headers.get("content-length")
    _validate_response_framing(headers)
    length: int | None = None
    if content_length is not None:
        significant_length = content_length.lstrip("0") or "0"
        maximum_length = str(max_bytes)
        if len(significant_length) > len(maximum_length) or (
            len(significant_length) == len(maximum_length)
            and significant_length > maximum_length
        ):
            raise _ResponseTooLarge
        length = int(significant_length)
    if 100 <= status < 200 or status in {204, 304}:
        return b""
    if transfer_encoding:
        if transfer_encoding != "chunked":
            raise _TransportProtocolError
        return await _read_chunked_body(reader, max_bytes)
    if length is not None:
        return await reader.readexactly(length)

    body = bytearray()
    while True:
        chunk = await reader.read(min(65_536, max_bytes - len(body) + 1))
        if not chunk:
            return bytes(body)
        if len(body) + len(chunk) > max_bytes:
            raise _ResponseTooLarge
        body.extend(chunk)


async def _read_chunked_body(reader: asyncio.StreamReader, max_bytes: int) -> bytes:
    body = bytearray()
    while True:
        line = await reader.readline()
        if not line or len(line) > _MAX_HEADER_BYTES or not line.endswith(b"\r\n"):
            raise _TransportProtocolError
        field = line[:-2]
        size_match = _CHUNK_SIZE.match(field)
        if size_match is None or not _valid_chunk_extensions(field[size_match.end() :]):
            raise _TransportProtocolError
        size_field = size_match.group(0)
        try:
            size = int(size_field, 16)
        except ValueError:
            raise _TransportProtocolError from None
        if size == 0:
            await _read_trailers(reader)
            return bytes(body)
        if size > max_bytes - len(body):
            raise _ResponseTooLarge
        body.extend(await reader.readexactly(size))
        if await reader.readexactly(2) != b"\r\n":
            raise _TransportProtocolError


def _valid_chunk_extensions(value: bytes) -> bool:
    if not value:
        return True
    index = 0
    while index < len(value):
        index = _skip_chunk_bws(value, index)
        if index >= len(value) or value[index] != ord(";"):
            return False
        index = _skip_chunk_bws(value, index + 1)
        name_end = _chunk_token_end(value, index)
        if name_end == index:
            return False
        equals_index = _skip_chunk_bws(value, name_end)
        if equals_index < len(value) and value[equals_index] == ord("="):
            index = _skip_chunk_bws(value, equals_index + 1)
            if index >= len(value):
                return False
            if value[index] == ord('"'):
                index = _quoted_chunk_value_end(value, index)
                if index < 0:
                    return False
            else:
                token_end = _chunk_token_end(value, index)
                if token_end == index:
                    return False
                index = token_end
        else:
            index = name_end
    return True


def _skip_chunk_bws(value: bytes, index: int) -> int:
    while index < len(value) and value[index] in {ord(" "), ord("\t")}:
        index += 1
    return index


def _chunk_token_end(value: bytes, index: int) -> int:
    while index < len(value) and value[index] in _TOKEN_BYTES:
        index += 1
    return index


def _quoted_chunk_value_end(value: bytes, index: int) -> int:
    index += 1
    while index < len(value):
        character = value[index]
        if character == ord('"'):
            return index + 1
        if character == ord("\\"):
            index += 1
            if index >= len(value) or not _valid_quoted_pair_byte(value[index]):
                return -1
        elif not _valid_qdtext_byte(character):
            return -1
        index += 1
    return -1


def _valid_qdtext_byte(value: int) -> bool:
    return (
        value in {9, 32, 33} or 35 <= value <= 91 or 93 <= value <= 126 or value >= 128
    )


def _valid_quoted_pair_byte(value: int) -> bool:
    return value in {9, 32} or 33 <= value <= 126 or value >= 128


async def _read_trailers(reader: asyncio.StreamReader) -> None:
    total = 0
    for _index in range(_MAX_HEADER_COUNT):
        line = await reader.readline()
        total += len(line)
        if not line or total > _MAX_HEADER_BYTES:
            raise _TransportProtocolError
        if line == b"\r\n":
            return
        _parse_header_line(line)
    raise _TransportProtocolError

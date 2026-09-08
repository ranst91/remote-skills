import asyncio
from collections import defaultdict, deque
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import datetime, timezone
from email.utils import format_datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import http.client
import inspect
import json
from pathlib import Path
import ssl
import sys
import threading
import time
import traceback
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from remote_skills import catalog, catalog_client, catalog_network
from remote_skills.catalog_errors import CatalogError
from remote_skills.catalog_network import HttpResponse
from remote_skills.catalog_origin import NetworkPolicy, Origin, evaluate_ip_address


PUBLIC_ADDRESS = "93.184.216.34"
SCHEMA = "https://schemas.agentskills.io/discovery/0.2.0/schema.json"
DIGEST = f"sha256:{'a' * 64}"


def catalog_bytes(*entries: dict[str, object], **extensions: object) -> bytes:
    document = {"$schema": SCHEMA, "skills": list(entries), **extensions}
    return json.dumps(document, separators=(",", ":")).encode()


def valid_entry(**overrides: object) -> dict[str, object]:
    return {
        "name": "code-review",
        "description": "Review code safely.",
        "type": "skill-md",
        "url": "artifact.md",
        "digest": DIGEST,
        **overrides,
    }


async def public_resolver(host: str) -> tuple[str, ...]:
    del host
    return (PUBLIC_ADDRESS,)


class RecordingTransport:
    def __init__(self, *steps: object) -> None:
        self.steps = deque(steps)
        self.requests: list[dict[str, object]] = []
        self.cancelled = asyncio.Event()

    async def request(
        self,
        url: str,
        headers: dict[str, str],
        timeout: float,
        connect_address: str | None = None,
        max_bytes: int | None = None,
    ) -> HttpResponse:
        self.requests.append(
            {
                "url": url,
                "headers": dict(headers),
                "timeout": timeout,
                "connect_address": connect_address,
                "max_bytes": max_bytes,
            }
        )
        step = self.steps.popleft()
        if callable(step):
            step = step()
        if inspect.isawaitable(step):
            try:
                step = await step
            except asyncio.CancelledError:
                self.cancelled.set()
                raise
        if isinstance(step, BaseException):
            raise step
        if not isinstance(step, HttpResponse):
            raise TypeError("scripted transport step must produce HttpResponse")
        return step


class RoutingTransport:
    def __init__(
        self, *, clock: "MutableClock | None" = None, delay: float = 0.0
    ) -> None:
        self.routes: dict[str, deque[object]] = defaultdict(deque)
        self.requests: list[dict[str, object]] = []
        self.clock = clock
        self.delay = delay

    def add(self, url: str, *steps: object) -> None:
        self.routes[url].extend(steps)

    async def request(
        self,
        url: str,
        headers: dict[str, str],
        timeout: float,
        connect_address: str | None = None,
        max_bytes: int | None = None,
    ) -> HttpResponse:
        self.requests.append(
            {
                "url": url,
                "headers": dict(headers),
                "timeout": timeout,
                "connect_address": connect_address,
                "max_bytes": max_bytes,
            }
        )
        if self.delay:
            if self.clock is not None:
                self.clock.now += self.delay
            else:
                await asyncio.sleep(self.delay)
        step = self.routes[url].popleft()
        if isinstance(step, BaseException):
            raise step
        if not isinstance(step, HttpResponse):
            raise TypeError("routing transport step must produce HttpResponse")
        return step


class MutableClock:
    def __init__(self, now: float) -> None:
        self.now = now

    def __call__(self) -> float:
        return self.now


async def cache_request_count(headers: dict[str, str], advance: float) -> int:
    start = datetime(2026, 8, 25, 10, 0, tzinfo=timezone.utc).timestamp()
    clock = MutableClock(start)
    origin = Origin(url="https://skills.example.test")
    response = HttpResponse(200, headers, catalog_bytes())
    transport = RoutingTransport()
    transport.add(origin.catalog_url, response, response)
    discovery = catalog_client.CatalogDiscovery(
        origins={"acme": origin},
        transport=transport,
        resolver=public_resolver,
        clock=clock,
    )
    await discovery.catalog("acme")
    clock.now += advance
    await discovery.catalog("acme")
    return len(transport.requests)


class StalledCloseWriter:
    def __init__(self, *, ignored_cancellations: int = 0) -> None:
        self.closed = False
        self.aborted = False
        self.wait_closed_started = False
        self.ignored_cancellations = ignored_cancellations
        self.transport = self

    def write(self, data: bytes) -> None:
        del data

    async def drain(self) -> None:
        return None

    def close(self) -> None:
        self.closed = True

    async def wait_closed(self) -> None:
        self.wait_closed_started = True
        while True:
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                if self.ignored_cancellations == 0:
                    raise
                self.ignored_cancellations -= 1

    def abort(self) -> None:
        self.aborted = True


def stream_reader(payload: bytes) -> asyncio.StreamReader:
    reader = asyncio.StreamReader()
    reader.feed_data(payload)
    reader.feed_eof()
    return reader


@contextmanager
def mocked_stream_connection(
    reader: asyncio.StreamReader, writer: StalledCloseWriter
) -> Iterator[None]:
    # The connection is fake; loading host CA certificates adds unrelated I/O.
    tls_context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    with (
        patch.object(
            catalog_network.ssl, "create_default_context", return_value=tls_context
        ),
        patch.object(
            catalog_network.asyncio, "open_connection", return_value=(reader, writer)
        ),
    ):
        yield


async def request_raw_response(payload: bytes) -> HttpResponse:
    writer = StalledCloseWriter()
    with mocked_stream_connection(stream_reader(payload), writer):
        return await catalog_network.StdlibTransport().request(
            "https://skills.example.test/catalog",
            {},
            1.0,
            PUBLIC_ADDRESS,
            1024,
        )


class TransportContractRegressionTest(unittest.IsolatedAsyncioTestCase):
    async def test_status_line_requires_crlf_and_exactly_three_ascii_digits(
        self,
    ) -> None:
        malformed_status_lines = (
            b"HTTP/1.1 +200 OK\r\n\r\n",
            b"HTTP/1.1 200 OK\n\r\n",
            b"HTTP/1.1 20 OK\r\n\r\n",
            b"HTTP/1.1 2000 OK\r\n\r\n",
            b"HTTP/1.1 2 0 OK\r\n\r\n",
        )
        for response in malformed_status_lines:
            with self.subTest(response=response):
                with self.assertRaises(OSError):
                    await catalog_network._read_response_head(stream_reader(response))

        status, headers = await catalog_network._read_response_head(
            stream_reader(b"HTTP/1.1 099 Node-Compatible\r\n\r\n")
        )
        self.assertEqual(status, 99)
        self.assertEqual(headers, {})
        status, _headers = await catalog_network._read_response_head(
            stream_reader(b"HTTP/1.1 200\r\n\r\n")
        )
        self.assertEqual(status, 200)

    async def test_content_length_requires_ascii_decimal_digits(self) -> None:
        malformed_lengths = (
            "+1",
            "1_0",
            "1 0",
            "-0",
            "\N{ARABIC-INDIC DIGIT ONE}",
        )
        for content_length in malformed_lengths:
            with self.subTest(content_length=content_length):
                with self.assertRaises(OSError):
                    await catalog_network._read_response_body(
                        stream_reader(b"0123456789"),
                        status=200,
                        headers={"content-length": content_length},
                        max_bytes=16,
                    )

        duplicate_length = (
            b"HTTP/1.1 200 OK\r\nContent-Length: 1\r\nContent-Length: 1\r\n\r\na"
        )
        with self.assertRaises(OSError):
            await request_raw_response(duplicate_length)

        response = await request_raw_response(
            b"HTTP/1.1 200 OK\r\nContent-Length:\t 2 \t\r\n\r\nok"
        )
        self.assertEqual(response.body, b"ok")

    async def test_informational_responses_are_bounded_and_consumed(self) -> None:
        response = await request_raw_response(
            b"HTTP/1.1 103 Early Hints\r\n"
            b"Link: </catalog.css>; rel=preload\r\n\r\n"
            b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok"
        )
        self.assertEqual(response.status, 200)
        self.assertEqual(response.body, b"ok")

        excessive_chain = (
            b"HTTP/1.1 103 Early Hints\r\n\r\n" * 101
            + b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n"
        )
        with self.assertRaises(OSError):
            await request_raw_response(excessive_chain)

        malformed_chain = (
            b"HTTP/1.1 103 Early Hints\r\n\r\n"
            b"HTTP/1.1 +200 Invalid\r\nContent-Length: 0\r\n\r\n"
        )
        with self.assertRaises(OSError):
            await request_raw_response(malformed_chain)

        malformed_headers = (
            b"HTTP/1.1 103 Early Hints\r\nContent-Length: +1\r\n\r\n"
            b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n"
        )
        with self.assertRaises(OSError):
            await request_raw_response(malformed_headers)

        oversized_head = (
            b"HTTP/1.1 103 Early Hints\r\nX-Padding: " + b"a" * 65_536 + b"\r\n\r\n"
        )
        with self.assertRaises(OSError):
            await request_raw_response(oversized_head)

    async def test_switching_protocols_is_terminal_and_fail_closed(self) -> None:
        response = await request_raw_response(
            b"HTTP/1.1 101 Switching Protocols\r\n"
            b"Connection: upgrade\r\nUpgrade: websocket\r\n\r\n"
            b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok"
        )
        self.assertEqual(response.status, 101)
        self.assertEqual(response.body, b"")

    async def test_response_rejects_conflicting_framing_headers(self) -> None:
        for status in (200, 304):
            with self.subTest(status=status):
                reader = asyncio.StreamReader()
                reader.feed_data(b"1\r\na\r\n0\r\n\r\n")
                reader.feed_eof()

                with self.assertRaises(OSError):
                    await catalog_network._read_response_body(
                        reader,
                        status=status,
                        headers={
                            "transfer-encoding": "chunked",
                            "content-length": "1",
                        },
                        max_bytes=16,
                    )

    async def test_chunk_size_uses_strict_hex_and_crlf_framing(self) -> None:
        malformed_bodies = (
            b"+1\r\na\r\n0\r\n\r\n",
            b"0x1\r\na\r\n0\r\n\r\n",
            b"1\na\r\n0\r\n\r\n",
            b"-0\r\n\r\n",
            b" 1\r\na\r\n0\r\n\r\n",
        )
        for body in malformed_bodies:
            with self.subTest(body=body):
                reader = asyncio.StreamReader()
                reader.feed_data(body)
                reader.feed_eof()
                with self.assertRaises(OSError):
                    await catalog_network._read_chunked_body(reader, 16)

        valid_reader = asyncio.StreamReader()
        valid_reader.feed_data(b"A\r\n0123456789\r\n0\r\n\r\n")
        valid_reader.feed_eof()
        self.assertEqual(
            await catalog_network._read_chunked_body(valid_reader, 16),
            b"0123456789",
        )

    async def test_chunk_extensions_accept_rfc_syntax_and_reject_ambiguity(
        self,
    ) -> None:
        valid_bodies = (
            b"1;extension=value\r\na\r\n0\r\n\r\n",
            b'1 ; foo = "quoted\\"value" ; flag\r\na\r\n0 ; done = yes\r\n\r\n',
        )
        for body in valid_bodies:
            with self.subTest(body=body):
                reader = asyncio.StreamReader()
                reader.feed_data(body)
                reader.feed_eof()
                self.assertEqual(
                    await catalog_network._read_chunked_body(reader, 16), b"a"
                )

        malformed_bodies = (
            b"1;=value\r\na\r\n0\r\n\r\n",
            b"1;name=\r\na\r\n0\r\n\r\n",
            b'1;name="unterminated\r\na\r\n0\r\n\r\n',
            b"1;na(me=value\r\na\r\n0\r\n\r\n",
            b"1;name=value trailing\r\na\r\n0\r\n\r\n",
            b"1;name \r\na\r\n0\r\n\r\n",
            b"1;name=value \r\na\r\n0\r\n\r\n",
            b'1;name="bad\\\x01"\r\na\r\n0\r\n\r\n',
        )
        for body in malformed_bodies:
            with self.subTest(body=body):
                reader = asyncio.StreamReader()
                reader.feed_data(body)
                reader.feed_eof()
                with self.assertRaises(OSError):
                    await catalog_network._read_chunked_body(reader, 16)

    async def test_response_header_names_and_values_are_validated_before_use(
        self,
    ) -> None:
        malformed_headers = (
            b" Location: /redirected\r\n",
            b"Loc@tion: /redirected\r\n",
            b"Location: /redirected\x01secret\r\n",
            b"Location: /redirected\x0bsecret\r\n",
            b"Location: /redirected\x7fsecret\r\n",
        )
        for header in malformed_headers:
            with self.subTest(header=header):
                with self.assertRaises(OSError):
                    await catalog_network._read_response_head(
                        stream_reader(b"HTTP/1.1 302 Found\r\n" + header + b"\r\n")
                    )

        status, headers = await catalog_network._read_response_head(
            stream_reader(
                b"HTTP/1.1 302 Found\r\n"
                b"Location:\t /redirected \t\r\n"
                b"X-Trace: left\tright\r\n\r\n"
            )
        )
        self.assertEqual(status, 302)
        self.assertEqual(headers["location"], "/redirected")
        self.assertEqual(headers["x-trace"], "left\tright")

        injected = HttpResponse(
            302,
            {"Location": "\t /redirected \t", "X-Trace": "left\tright"},
            b"",
        )
        self.assertEqual(injected.headers["location"], "/redirected")
        self.assertEqual(injected.headers["x-trace"], "left\tright")

    async def test_chunked_trailer_fields_use_the_same_strict_validation(
        self,
    ) -> None:
        malformed_trailers = (
            b"0\r\n Bad: value\r\n\r\n",
            b"0\r\nGood: value\x01secret\r\n\r\n",
        )
        for body in malformed_trailers:
            with self.subTest(body=body):
                reader = asyncio.StreamReader()
                reader.feed_data(body)
                reader.feed_eof()
                with self.assertRaises(OSError):
                    await catalog_network._read_chunked_body(reader, 16)

    async def test_sole_transport_contract_receives_vetted_address_and_stream_limit(
        self,
    ) -> None:
        parameters = inspect.signature(
            catalog_network.AsyncTransport.request
        ).parameters
        self.assertIn("connect_address", parameters)
        self.assertIn("max_bytes", parameters)
        self.assertFalse(hasattr(catalog_network, "PinnedAsyncTransport"))

        transport = RecordingTransport(HttpResponse(200, {}, b"ok"))
        result = await catalog_network.request_with_policy(
            origin_alias="acme",
            origin=Origin(
                url="https://skills.example.test", retries=0, catalog_bytes=17
            ),
            url="https://skills.example.test/catalog",
            transport=transport,
            resolver=public_resolver,
        )

        self.assertIsNone(result.error)
        self.assertEqual(transport.requests[0]["connect_address"], PUBLIC_ADDRESS)
        self.assertEqual(transport.requests[0]["max_bytes"], 17)

    async def test_default_transport_connects_to_the_supplied_address_without_resolving_again(
        self,
    ) -> None:
        requests: list[str] = []

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:
                requests.append(self.path)
                body = b"ok"
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, format: str, *args: object) -> None:
                del format, args

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with patch.object(
                catalog_network,
                "default_resolver",
                side_effect=AssertionError("transport must not resolve"),
            ):
                response = await catalog_network.StdlibTransport().request(
                    f"http://localhost:{server.server_port}/catalog",
                    {},
                    1.0,
                    "127.0.0.1",
                    16,
                )
        finally:
            await asyncio.to_thread(server.shutdown)
            server.server_close()
            thread.join(timeout=2)

        self.assertEqual(response.body, b"ok")
        self.assertEqual(requests, ["/catalog"])

    async def test_declared_oversized_body_is_rejected_before_body_allocation(
        self,
    ) -> None:
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:
                self.send_response(200)
                self.send_header("Content-Length", "1000000")
                self.end_headers()
                time.sleep(0.2)

            def log_message(self, format: str, *args: object) -> None:
                del format, args

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            origin = Origin(
                url=f"http://127.0.0.1:{server.server_port}",
                retries=0,
                timeout=0.1,
                allow_loopback_http=True,
                catalog_bytes=32,
            )

            async def loopback_resolver(host: str) -> tuple[str, ...]:
                del host
                return ("127.0.0.1",)

            result = await catalog_network.request_with_policy(
                origin_alias="local",
                origin=origin,
                url=origin.catalog_url,
                transport=catalog_network.StdlibTransport(),
                resolver=loopback_resolver,
            )
        finally:
            await asyncio.to_thread(server.shutdown)
            server.server_close()
            thread.join(timeout=2)

        self.assertEqual(result.error.code, "limit_exceeded")

    async def test_total_deadline_closes_a_real_trickling_socket(self) -> None:
        disconnected = threading.Event()

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:
                self.send_response(200)
                self.send_header("Content-Length", "100")
                self.end_headers()
                try:
                    for _index in range(100):
                        self.wfile.write(b"x")
                        self.wfile.flush()
                        time.sleep(0.02)
                except (BrokenPipeError, ConnectionResetError):
                    disconnected.set()

            def log_message(self, format: str, *args: object) -> None:
                del format, args

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            origin = Origin(
                url=f"http://127.0.0.1:{server.server_port}",
                retries=0,
                timeout=0.05,
                allow_loopback_http=True,
            )
            result = await catalog_network.request_with_policy(
                origin_alias="local",
                origin=origin,
                url=origin.catalog_url,
                transport=catalog_network.StdlibTransport(),
                resolver=public_resolver,
            )
            observed_close = await asyncio.to_thread(disconnected.wait, 0.4)
        finally:
            await asyncio.to_thread(server.shutdown)
            server.server_close()
            thread.join(timeout=2)

        self.assertEqual(result.error.code, "request_timeout")
        self.assertTrue(observed_close)

    async def test_timeout_does_not_wait_forever_for_stream_close(self) -> None:
        reader = asyncio.StreamReader()
        writer = StalledCloseWriter()
        origin = Origin(url="https://skills.example.test", retries=0, timeout=60)
        reading = asyncio.Event()
        read_cancelled = asyncio.Event()
        readuntil = reader.readuntil
        sleep = asyncio.sleep

        async def waiting_readuntil(separator: bytes = b"\n") -> bytes:
            reading.set()
            try:
                return await readuntil(separator)
            except asyncio.CancelledError:
                read_cancelled.set()
                raise

        async def expire_when_reading(delay: float) -> None:
            if delay > 0:
                # Trigger the real deadline cancellation only after the read waits.
                await reading.wait()
            else:
                # Preserve the production cleanup yield after cancellation.
                await sleep(0)

        with (
            mocked_stream_connection(reader, writer),
            patch.object(reader, "readuntil", side_effect=waiting_readuntil),
            patch.object(
                catalog_network.asyncio, "sleep", side_effect=expire_when_reading
            ),
        ):
            result = await asyncio.wait_for(
                catalog_network.request_with_policy(
                    origin_alias="acme",
                    origin=origin,
                    url=origin.catalog_url,
                    transport=catalog_network.StdlibTransport(),
                    resolver=public_resolver,
                ),
                timeout=0.2,  # Safety watchdog, not the request deadline trigger.
            )

        self.assertEqual(result.error.code, "request_timeout")
        self.assertTrue(read_cancelled.is_set())
        self.assertTrue(writer.closed)
        self.assertTrue(writer.aborted)
        self.assertFalse(writer.wait_closed_started)

    async def test_cleanup_aborts_a_cancellation_resistant_wait_closed(self) -> None:
        reader = stream_reader(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok")
        writer = StalledCloseWriter(ignored_cancellations=1)
        origin = Origin(url="https://skills.example.test", retries=0, timeout=60)

        with mocked_stream_connection(reader, writer):
            try:
                result = await asyncio.wait_for(
                    catalog_network.request_with_policy(
                        origin_alias="acme",
                        origin=origin,
                        url=origin.catalog_url,
                        transport=catalog_network.StdlibTransport(),
                        resolver=public_resolver,
                    ),
                    timeout=0.2,
                )
            except TimeoutError:
                self.fail("stream cleanup did not finish before the safety watchdog")

        self.assertIsNone(result.error)
        self.assertEqual(result.response.body, b"ok")
        self.assertTrue(writer.closed)
        self.assertTrue(writer.aborted)
        self.assertFalse(writer.wait_closed_started)


class NetworkPolicyRegressionTest(unittest.IsolatedAsyncioTestCase):
    async def test_malformed_redirect_parser_cause_does_not_expose_peer_data(
        self,
    ) -> None:
        canary = "RUNTIME_SECRET_CANARY"
        transport = RecordingTransport(
            HttpResponse(
                302,
                {"location": f"https://cdn.example.test:{canary}/catalog"},
                b"",
            )
        )
        origin = Origin(url="https://skills.example.test", retries=0)

        result = await catalog_network.request_with_policy(
            origin_alias="acme",
            origin=origin,
            url=origin.catalog_url,
            transport=transport,
            resolver=public_resolver,
        )

        self.assertEqual(result.error.code, "policy_denied")
        rendered = "".join(
            traceback.format_exception(
                type(result.error), result.error, result.error.__traceback__
            )
        )
        self.assertNotIn(canary, rendered)
        self.assertTrue(result.error.__suppress_context__)

    async def test_invalid_resolved_target_cause_does_not_expose_peer_data(
        self,
    ) -> None:
        canary = "RUNTIME_SECRET_CANARY"

        async def invalid_resolver(host: str) -> tuple[str, ...]:
            del host
            return (canary,)

        origin = Origin(url="https://skills.example.test", retries=0)
        result = await catalog_network.request_with_policy(
            origin_alias="acme",
            origin=origin,
            url=origin.catalog_url,
            transport=RecordingTransport(HttpResponse(200, {}, b"ok")),
            resolver=invalid_resolver,
        )

        self.assertEqual(result.error.code, "policy_denied")
        rendered = "".join(
            traceback.format_exception(
                type(result.error), result.error, result.error.__traceback__
            )
        )
        self.assertNotIn(canary, rendered)
        self.assertTrue(result.error.__suppress_context__)

    async def test_configured_address_allowlist_and_redirect_bound_are_enforced(
        self,
    ) -> None:
        allowed_transport = RecordingTransport(HttpResponse(200, {}, b"ok"))

        async def private_resolver(host: str) -> tuple[str, ...]:
            del host
            return ("10.0.0.7",)

        allowed_origin = Origin(
            url="https://skills.example.test",
            retries=0,
            network_policy=NetworkPolicy(allowed_addresses={"10.0.0.7"}),
        )
        allowed = await catalog_network.request_with_policy(
            origin_alias="acme",
            origin=allowed_origin,
            url=allowed_origin.catalog_url,
            transport=allowed_transport,
            resolver=private_resolver,
        )
        self.assertIsNone(allowed.error)
        self.assertEqual(allowed_transport.requests[0]["connect_address"], "10.0.0.7")

        bounded_transport = RecordingTransport(
            HttpResponse(302, {"location": "/redirected"}, b"")
        )
        bounded_origin = Origin(
            url="https://skills.example.test",
            retries=0,
            network_policy=NetworkPolicy(max_redirects=0),
        )
        bounded = await catalog_network.request_with_policy(
            origin_alias="acme",
            origin=bounded_origin,
            url=bounded_origin.catalog_url,
            transport=bounded_transport,
            resolver=public_resolver,
        )
        self.assertEqual(bounded.error.code, "policy_denied")
        self.assertEqual(len(bounded_transport.requests), 1)

    async def test_redirect_location_is_validated_before_url_resolution(self) -> None:
        invalid_locations = (
            "?",
            "#",
            "https://@cdn.example.test/catalog.json",
            "//@cdn.example.test/catalog.json",
            "https://cdn.ex\tample.test/catalog.json",
            "https:\\@cdn.example.test/catalog.json",
            "https:/\\@cdn.example.test/catalog.json",
            "https:////@cdn.example.test/catalog.json",
            "///@cdn.example.test/catalog.json",
        )
        origin = Origin(url="https://skills.example.test", retries=0)
        for location in invalid_locations:
            with self.subTest(location=location):
                transport = RecordingTransport(
                    HttpResponse(302, {"location": location}, b""),
                    HttpResponse(200, {}, b"ok"),
                )
                result = await catalog_network.request_with_policy(
                    origin_alias="acme",
                    origin=origin,
                    url=origin.catalog_url,
                    transport=transport,
                    resolver=public_resolver,
                )
                self.assertIsNotNone(result.error)
                self.assertEqual(result.error.code, "policy_denied")
                self.assertEqual(len(transport.requests), 1)

        valid_locations = (
            ("/catalog.json", "https://skills.example.test/catalog.json"),
            (
                "https://cdn.example.test/catalog.json",
                "https://cdn.example.test/catalog.json",
            ),
            (
                "//cdn.example.test/catalog.json",
                "https://cdn.example.test/catalog.json",
            ),
        )
        for location, expected in valid_locations:
            with self.subTest(location=location):
                transport = RecordingTransport(
                    HttpResponse(302, {"location": location}, b""),
                    HttpResponse(200, {}, b"ok"),
                )
                result = await catalog_network.request_with_policy(
                    origin_alias="acme",
                    origin=origin,
                    url=origin.catalog_url,
                    transport=transport,
                    resolver=public_resolver,
                )
                self.assertIsNone(result.error)
                self.assertEqual(transport.requests[1]["url"], expected)

    async def test_catalog_redirect_never_receives_configured_artifact_credentials(
        self,
    ) -> None:
        transport = RecordingTransport(
            HttpResponse(
                302, {"location": "https://cdn.example.test/v2/index.json"}, b""
            ),
            HttpResponse(200, {}, b"ok"),
        )
        origin = Origin(
            url="https://skills.example.test",
            headers={"authorization": "origin-secret"},
            artifact_headers={"cdn.example.test": {"x-cdn-token": "cdn-secret"}},
        )

        result = await catalog_network.request_with_policy(
            origin_alias="acme",
            origin=origin,
            url=origin.catalog_url,
            purpose="catalog",
            transport=transport,
            resolver=public_resolver,
        )

        self.assertIsNone(result.error)
        self.assertEqual(
            transport.requests[0]["headers"]["authorization"], "origin-secret"
        )
        self.assertNotIn("authorization", transport.requests[1]["headers"])
        self.assertNotIn("x-cdn-token", transport.requests[1]["headers"])

    async def test_final_redirect_url_is_sanitized_and_resolves_relative_artifacts(
        self,
    ) -> None:
        redirected = "https://cdn.example.test/v2/index.json"
        transport = RoutingTransport()
        origin = Origin(url="https://skills.example.test")
        transport.add(
            origin.catalog_url,
            HttpResponse(302, {"location": redirected}, b""),
        )
        transport.add(
            redirected,
            HttpResponse(200, {}, catalog_bytes(valid_entry(url="artifact.md"))),
        )
        discovery = catalog_client.CatalogDiscovery(
            origins={"acme": origin}, transport=transport, resolver=public_resolver
        )

        snapshot = await discovery.catalog("acme")

        self.assertEqual(
            snapshot.entries[0].url, "https://cdn.example.test/v2/artifact.md"
        )

    async def test_attempt_timeout_bounds_resolver_redirect_and_custom_transport(
        self,
    ) -> None:
        async def slow_resolver(host: str) -> tuple[str, ...]:
            del host
            await asyncio.sleep(0.2)
            return (PUBLIC_ADDRESS,)

        transport = RecordingTransport(HttpResponse(200, {}, b"ok"))
        started = asyncio.get_running_loop().time()
        result = await asyncio.wait_for(
            catalog_network.request_with_policy(
                origin_alias="acme",
                origin=Origin(
                    url="https://skills.example.test", retries=0, timeout=0.03
                ),
                url="https://skills.example.test/catalog",
                transport=transport,
                resolver=slow_resolver,
            ),
            timeout=0.15,
        )

        self.assertEqual(result.error.code, "request_timeout")
        self.assertLess(asyncio.get_running_loop().time() - started, 0.12)
        self.assertEqual(transport.requests, [])

    async def test_attempt_timeout_spans_redirects_but_not_retry_backoff(self) -> None:
        async def delayed(response: HttpResponse) -> HttpResponse:
            await asyncio.sleep(0.02)
            return response

        redirected = RecordingTransport(
            lambda: delayed(HttpResponse(302, {"location": "/next"}, b"")),
            lambda: delayed(HttpResponse(200, {}, b"ok")),
        )
        redirect_result = await catalog_network.request_with_policy(
            origin_alias="acme",
            origin=Origin(url="https://skills.example.test", retries=0, timeout=0.03),
            url="https://skills.example.test/catalog",
            transport=redirected,
            resolver=public_resolver,
        )
        self.assertEqual(redirect_result.error.code, "request_timeout")

        retrying = RecordingTransport(
            HttpResponse(500, {}, b""), HttpResponse(200, {}, b"ok")
        )
        retry_result = await asyncio.wait_for(
            catalog_network.request_with_policy(
                origin_alias="acme",
                origin=Origin(
                    url="https://skills.example.test", retries=1, timeout=0.03
                ),
                url="https://skills.example.test/catalog",
                transport=retrying,
                resolver=public_resolver,
                sleeper=asyncio.sleep,
                entropy=lambda: 0.5,
            ),
            timeout=0.3,
        )
        self.assertIsNone(retry_result.error)
        self.assertEqual(len(retrying.requests), 2)
        self.assertEqual(retry_result.delays_ms, (125,))

    async def test_caller_deadline_and_cancellation_bound_the_whole_operation(
        self,
    ) -> None:
        retrying = RecordingTransport(
            HttpResponse(500, {}, b""), HttpResponse(200, {}, b"ok")
        )
        with self.assertRaises(TimeoutError):
            async with asyncio.timeout(0.03):
                await catalog_network.request_with_policy(
                    origin_alias="acme",
                    origin=Origin(
                        url="https://skills.example.test", retries=1, timeout=0.2
                    ),
                    url="https://skills.example.test/catalog",
                    transport=retrying,
                    resolver=public_resolver,
                    sleeper=asyncio.sleep,
                    entropy=lambda: 0.5,
                )
        self.assertEqual(len(retrying.requests), 1)

        async def blocked() -> HttpResponse:
            await asyncio.Event().wait()
            raise AssertionError("unreachable")

        blocked_transport = RecordingTransport(blocked)
        task = asyncio.create_task(
            catalog_network.request_with_policy(
                origin_alias="acme",
                origin=Origin(
                    url="https://skills.example.test", retries=0, timeout=1.0
                ),
                url="https://skills.example.test/catalog",
                transport=blocked_transport,
                resolver=public_resolver,
            )
        )
        try:
            async with asyncio.timeout(0.5):
                while not blocked_transport.requests:
                    if task.done():
                        await task
                        self.fail("request completed before transport readiness")
                    await asyncio.sleep(0)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
            self.assertTrue(blocked_transport.cancelled.is_set())
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    async def test_deadline_cancels_an_injected_async_transport(self) -> None:
        async def blocked() -> HttpResponse:
            await asyncio.Event().wait()
            raise AssertionError("unreachable")

        transport = RecordingTransport(blocked())
        result = await asyncio.wait_for(
            catalog_network.request_with_policy(
                origin_alias="acme",
                origin=Origin(
                    url="https://skills.example.test", retries=0, timeout=0.03
                ),
                url="https://skills.example.test/catalog",
                transport=transport,
                resolver=public_resolver,
            ),
            timeout=0.15,
        )

        self.assertEqual(result.error.code, "request_timeout")
        self.assertTrue(transport.cancelled.is_set())

    async def test_peer_http_exceptions_map_to_sanitized_retryable_error(self) -> None:
        failures = (
            http.client.BadStatusLine("RUNTIME_SECRET_CANARY"),
            http.client.IncompleteRead(b"RUNTIME_SECRET_CANARY", 999),
        )
        for failure in failures:
            transport = RecordingTransport(failure)
            result = await catalog_network.request_with_policy(
                origin_alias="acme",
                origin=Origin(url="https://skills.example.test", retries=0),
                url="https://skills.example.test/catalog",
                transport=transport,
                resolver=public_resolver,
            )
            with self.subTest(exception=type(failure).__name__):
                self.assertEqual(result.error.code, "origin_unavailable")
                self.assertTrue(result.error.retryable)
                self.assertEqual(result.error.context, {"origin_alias": "acme"})
                self.assertNotIn("RUNTIME_SECRET_CANARY", repr(result.error))

    async def test_http_date_retry_after_uses_injected_wall_clock_and_five_second_cap(
        self,
    ) -> None:
        now = datetime(2026, 8, 25, 10, 0, tzinfo=timezone.utc).timestamp()
        retry_at = format_datetime(
            datetime(2026, 8, 25, 10, 0, 30, tzinfo=timezone.utc), usegmt=True
        )
        delays: list[float] = []

        async def record_delay(delay: float) -> None:
            delays.append(delay)

        transport = RecordingTransport(
            HttpResponse(429, {"retry-after": retry_at}, b""),
            HttpResponse(200, {}, b"ok"),
        )
        result = await catalog_network.request_with_policy(
            origin_alias="acme",
            origin=Origin(url="https://skills.example.test", retries=1),
            url="https://skills.example.test/catalog",
            transport=transport,
            resolver=public_resolver,
            sleeper=record_delay,
            wall_clock=lambda: now,
        )

        self.assertIsNone(result.error)
        self.assertEqual(delays, [5.0])

    async def test_retry_after_matches_strict_typescript_syntax(
        self,
    ) -> None:
        now = datetime(2026, 8, 25, 10, 0, tzinfo=timezone.utc).timestamp()

        async def observed_delays(retry_after: str) -> list[float]:
            delays: list[float] = []

            async def record_delay(delay: float) -> None:
                delays.append(delay)

            transport = RecordingTransport(
                HttpResponse(429, {"retry-after": retry_after}, b""),
                HttpResponse(200, {}, b"ok"),
            )
            result = await catalog_network.request_with_policy(
                origin_alias="acme",
                origin=Origin(url="https://skills.example.test", retries=1),
                url="https://skills.example.test/catalog",
                transport=transport,
                resolver=public_resolver,
                sleeper=record_delay,
                entropy=lambda: 0.5,
                wall_clock=lambda: now,
            )
            self.assertIsNone(result.error)
            return delays

        invalid_values = (
            "+2",
            "2.5",
            "1e3",
            "NaN",
            "Infinity",
            "-Infinity",
            "Tuesday, 25-Aug-26 10:00:02 GMT",
            "Tue Aug 25 10:00:02 2026",
            "Mon, 25 Aug 2026 10:00:02 GMT",
        )
        for retry_after in invalid_values:
            with self.subTest(retry_after=retry_after):
                self.assertEqual(await observed_delays(retry_after), [0.125])

        valid_values = (
            ("2", 2.0),
            (" 0002 ", 2.0),
            ("Tue, 25 Aug 2026 10:00:02 GMT", 2.0),
        )
        for retry_after, expected_delay in valid_values:
            with self.subTest(retry_after=retry_after):
                self.assertEqual(await observed_delays(retry_after), [expected_delay])

    async def test_only_200_and_304_are_success_statuses(self) -> None:
        transport = RecordingTransport(HttpResponse(204, {}, b""))
        result = await catalog_network.request_with_policy(
            origin_alias="acme",
            origin=Origin(url="https://skills.example.test", retries=0),
            url="https://skills.example.test/catalog",
            transport=transport,
            resolver=public_resolver,
        )

        self.assertIsNone(result.response)
        self.assertEqual(result.error.code, "origin_unavailable")
        self.assertEqual(result.error.context, {"origin_alias": "acme", "status": 204})

    async def test_loopback_http_redirect_requires_exclusively_loopback_dns_answers(
        self,
    ) -> None:
        origin = Origin(
            url="http://localhost:8787", retries=0, allow_loopback_http=True
        )
        transport = RecordingTransport(
            HttpResponse(302, {"location": "http://localhost:8787/redirected"}, b""),
            HttpResponse(200, {}, b"ok"),
        )
        answers = deque([("127.0.0.1",), ("127.0.0.1", PUBLIC_ADDRESS)])

        async def mixed_resolver(host: str) -> tuple[str, ...]:
            del host
            return answers.popleft()

        result = await catalog_network.request_with_policy(
            origin_alias="local",
            origin=origin,
            url=origin.catalog_url,
            transport=transport,
            resolver=mixed_resolver,
        )

        self.assertEqual(result.error.code, "policy_denied")
        self.assertEqual(len(transport.requests), 1)


class CatalogCacheRegressionTest(unittest.IsolatedAsyncioTestCase):
    async def test_invalid_replacement_200_cannot_revive_old_validators(self) -> None:
        origin = Origin(url="https://skills.example.test")
        transport = RoutingTransport()
        transport.add(
            origin.catalog_url,
            HttpResponse(
                200,
                {"cache-control": "max-age=0", "etag": '"catalog-v1"'},
                catalog_bytes(),
            ),
            HttpResponse(200, {}, b"not-json"),
            HttpResponse(304, {}, b""),
        )
        discovery = catalog_client.CatalogDiscovery(
            origins={"acme": origin}, transport=transport, resolver=public_resolver
        )

        await discovery.catalog("acme")
        with self.assertRaises(CatalogError) as invalid:
            await discovery.catalog("acme")
        self.assertEqual(invalid.exception.code, "catalog_invalid")
        with self.assertRaises(CatalogError) as bare_304:
            await discovery.catalog("acme")

        self.assertEqual(bare_304.exception.code, "origin_unavailable")
        self.assertNotIn("if-none-match", transport.requests[2]["headers"])

    async def test_cache_freshness_uses_age_date_response_delay_and_expires(
        self,
    ) -> None:
        start = datetime(2026, 8, 25, 10, 0, tzinfo=timezone.utc).timestamp()
        clock = MutableClock(start)
        origin = Origin(url="https://skills.example.test")
        transport = RoutingTransport(clock=clock, delay=5.0)
        transport.add(
            origin.catalog_url,
            HttpResponse(
                200,
                {
                    "age": "8",
                    "cache-control": "max-age=20",
                    "date": "Tue, 25 Aug 2026 09:59:50 GMT",
                    "etag": '"v1"',
                },
                catalog_bytes(),
            ),
            HttpResponse(304, {}, b""),
        )
        discovery = catalog_client.CatalogDiscovery(
            origins={"acme": origin},
            transport=transport,
            resolver=public_resolver,
            clock=clock,
        )

        await discovery.catalog("acme")
        clock.now += 4.999
        await discovery.catalog("acme")
        clock.now += 0.002
        await discovery.catalog("acme")

        self.assertEqual(len(transport.requests), 2)

        expires_clock = MutableClock(start)
        expires_transport = RoutingTransport()
        expires_transport.add(
            origin.catalog_url,
            HttpResponse(
                200,
                {
                    "date": "Tue, 25 Aug 2026 10:00:00 GMT",
                    "expires": "Tue, 25 Aug 2026 10:00:10 GMT",
                },
                catalog_bytes(),
            ),
            HttpResponse(200, {}, catalog_bytes()),
        )
        expires_discovery = catalog_client.CatalogDiscovery(
            origins={"acme": origin},
            transport=expires_transport,
            resolver=public_resolver,
            clock=expires_clock,
        )
        await expires_discovery.catalog("acme")
        expires_clock.now += 9.999
        await expires_discovery.catalog("acme")
        expires_clock.now += 0.002
        await expires_discovery.catalog("acme")
        self.assertEqual(len(expires_transport.requests), 2)

    async def test_cache_dates_accept_only_strict_imf_fixdate(self) -> None:
        invalid_dates = (
            "9999",
            "Tuesday, 25-Aug-26 10:10:00 GMT",
            "Tue Aug 25 10:10:00 2026",
            "Mon, 25 Aug 2026 10:10:00 GMT",
        )
        for expires in invalid_dates:
            with self.subTest(field="expires", value=expires):
                self.assertEqual(
                    await cache_request_count({"expires": expires}, 1.0), 2
                )

        self.assertEqual(
            await cache_request_count(
                {"expires": "Tue, 25 Aug 2026 10:05:00 GMT"}, 1.0
            ),
            1,
        )

        expires = "Tue, 25 Aug 2026 10:15:00 GMT"
        for date in invalid_dates:
            with self.subTest(field="date", value=date):
                self.assertEqual(
                    await cache_request_count(
                        {"date": date, "expires": expires}, 400.0
                    ),
                    1,
                )

        self.assertEqual(
            await cache_request_count(
                {
                    "date": "Tue, 25 Aug 2026 10:10:00 GMT",
                    "expires": expires,
                },
                400.0,
            ),
            2,
        )

    async def test_cache_control_and_age_use_ecmascript_trim_semantics(self) -> None:
        cases = (
            ({"cache-control": "\ufeffmax-age=60\ufeff"}, 31.0, 1),
            ({"cache-control": "\u0085max-age=60\u0085"}, 31.0, 2),
            (
                {"cache-control": "max-age=60", "age": "\ufeff30\ufeff"},
                31.0,
                2,
            ),
            (
                {"cache-control": "max-age=60", "age": "\u008530\u0085"},
                31.0,
                1,
            ),
        )
        for headers, advance, expected_requests in cases:
            with self.subTest(headers=headers):
                self.assertEqual(
                    await cache_request_count(headers, advance), expected_requests
                )

    async def test_304_merges_metadata_and_no_store_evicts_cached_validators(
        self,
    ) -> None:
        clock = MutableClock(0.0)
        origin = Origin(url="https://skills.example.test")
        transport = RoutingTransport()
        transport.add(
            origin.catalog_url,
            HttpResponse(
                200, {"cache-control": "max-age=0", "etag": '"v1"'}, catalog_bytes()
            ),
            HttpResponse(304, {"cache-control": "no-store"}, b""),
            HttpResponse(200, {}, catalog_bytes()),
        )
        discovery = catalog_client.CatalogDiscovery(
            origins={"acme": origin},
            transport=transport,
            resolver=public_resolver,
            clock=clock,
        )

        await discovery.catalog("acme")
        await discovery.catalog("acme")
        await discovery.catalog("acme")

        self.assertEqual(transport.requests[1]["headers"]["if-none-match"], '"v1"')
        self.assertNotIn("if-none-match", transport.requests[2]["headers"])

    async def test_initial_304_is_stable_origin_unavailable(self) -> None:
        origin = Origin(url="https://skills.example.test", retries=0)
        transport = RoutingTransport()
        transport.add(origin.catalog_url, HttpResponse(304, {}, b""))
        discovery = catalog_client.CatalogDiscovery(
            origins={"acme": origin}, transport=transport, resolver=public_resolver
        )

        with self.assertRaises(CatalogError) as raised:
            await discovery.catalog("acme")

        self.assertEqual(raised.exception.code, "origin_unavailable")
        self.assertTrue(raised.exception.retryable)
        self.assertEqual(
            raised.exception.context, {"origin_alias": "acme", "status": 304}
        )

    async def test_invalid_duplicate_and_unmatched_max_age_is_immediately_stale(
        self,
    ) -> None:
        start = datetime(2026, 8, 25, 10, 0, tzinfo=timezone.utc).timestamp()
        cases = (
            ("max-age=0, max-age=300", True),
            ("max-age=300, max-age=300", True),
            ("max-age=1e3", True),
            ("max-age=1.5", True),
            ("max-age=+10", True),
            ('max-age="300', True),
            ('max-age=300"', True),
            ('foo="x,max-age=300,y"', False),
            ('foo="x\\",max-age=300,y"', False),
            ('max-age=300, foo="unterminated', True),
            ("max-age=invalid", True),
        )

        for cache_control, include_expires in cases:
            with self.subTest(cache_control=cache_control):
                clock = MutableClock(start)
                origin = Origin(url="https://skills.example.test")
                response = HttpResponse(
                    200,
                    {
                        "cache-control": cache_control,
                        "date": "Tue, 25 Aug 2026 10:00:00 GMT",
                        **(
                            {"expires": "Wed, 25 Aug 2027 10:00:00 GMT"}
                            if include_expires
                            else {}
                        ),
                    },
                    catalog_bytes(),
                )
                transport = RoutingTransport()
                transport.add(origin.catalog_url, response, response)
                discovery = catalog_client.CatalogDiscovery(
                    origins={"acme": origin},
                    transport=transport,
                    resolver=public_resolver,
                    clock=clock,
                )

                await discovery.catalog("acme")
                await discovery.catalog("acme")

                self.assertEqual(len(transport.requests), 2)

    def test_empty_cache_control_members_are_malformed_and_block_expires(self) -> None:
        headers = {
            "date": "Tue, 25 Aug 2026 10:00:00 GMT",
            "expires": "Wed, 25 Aug 2027 10:00:00 GMT",
        }
        for cache_control in (
            "",
            ", max-age=300",
            "max-age=300,",
            "max-age=300,,public",
        ):
            with self.subTest(cache_control=cache_control):
                self.assertEqual(
                    catalog_client._remaining_freshness(
                        {**headers, "cache-control": cache_control},
                        0.0,
                        0.0,
                    ),
                    0.0,
                )

    def test_delta_seconds_parity_is_strict_and_bounded(self) -> None:
        bound = 2_147_483_648
        self.assertEqual(
            catalog_client._remaining_freshness(
                {"cache-control": f"max-age={bound + 99}"}, 0.0, 0.0
            ),
            float(bound),
        )
        self.assertEqual(
            catalog_client._remaining_freshness(
                {"cache-control": 'max-age="300"'}, 0.0, 0.0
            ),
            300.0,
        )
        self.assertEqual(
            catalog_client._remaining_freshness(
                {"cache-control": "max-age=20", "age": "5, 999"},
                0.0,
                0.0,
            ),
            15.0,
        )
        self.assertEqual(
            catalog_client._remaining_freshness(
                {"cache-control": "max-age=20", "age": "1e1"},
                0.0,
                0.0,
            ),
            20.0,
        )
        self.assertEqual(
            catalog_client._remaining_freshness(
                {
                    "cache-control": f"max-age={bound + 10}",
                    "age": str(bound + 5),
                },
                0.0,
                0.0,
            ),
            0.0,
        )
        self.assertEqual(
            catalog_client._remaining_freshness(
                {"cache-control": f"max-age={'9' * 4_301}"}, 0.0, 0.0
            ),
            float(bound),
        )
        self.assertEqual(
            catalog_client._remaining_freshness(
                {"cache-control": "max-age=20", "age": "9" * 4_301},
                0.0,
                0.0,
            ),
            0.0,
        )


class SchemaParityRegressionTest(unittest.TestCase):
    def parse(self, body: bytes):
        return catalog.parse_catalog(
            body,
            origin_alias="acme",
            index_url="https://skills.example.test/.well-known/agent-skills/index.json",
        )

    def test_non_finite_json_constants_are_rejected_even_in_unknown_fields(
        self,
    ) -> None:
        for constant in (b"NaN", b"Infinity", b"-Infinity"):
            body = (
                b'{"$schema":"'
                + SCHEMA.encode()
                + b'","skills":[],"x":'
                + constant
                + b"}"
            )
            with self.subTest(constant=constant):
                with self.assertRaises(CatalogError) as raised:
                    self.parse(body)
                self.assertEqual(raised.exception.code, "catalog_invalid")

    def test_json_and_utf8_parser_causes_are_suppressed(self) -> None:
        canary = "RUNTIME_SECRET_CANARY"
        malformed_documents = (
            (f'{{"{canary}":'.encode(), json.JSONDecodeError),
            (canary.encode() + b"\xff", UnicodeDecodeError),
        )
        for body, cause_type in malformed_documents:
            with self.subTest(cause_type=cause_type.__name__):
                with self.assertRaises(CatalogError) as raised:
                    self.parse(body)
                self.assertIsNone(raised.exception.__cause__)
                self.assertTrue(raised.exception.__suppress_context__)
                rendered = "".join(
                    traceback.format_exception(
                        type(raised.exception),
                        raised.exception,
                        raised.exception.__traceback__,
                    )
                )
                self.assertNotIn(canary, rendered)

    def test_schema_context_only_identifies_the_recognized_legacy_schema(
        self,
    ) -> None:
        canary = "RUNTIME_SECRET_CANARY"
        unknown_schemas = (
            canary * 1_000,
            "https://schemas.peer.example/discovery/0.3/schema.json",
        )
        for schema in unknown_schemas:
            with self.subTest(schema=schema):
                with self.assertRaises(CatalogError) as raised:
                    self.parse(catalog_bytes(**{"$schema": schema}))
                self.assertEqual(raised.exception.context, {"origin_alias": "acme"})
                self.assertNotIn(canary, repr(raised.exception.context))

        legacy_schema = "https://schemas.agentskills.io/discovery/0.1/schema.json"
        with self.assertRaises(CatalogError) as legacy:
            self.parse(catalog_bytes(**{"$schema": legacy_schema}))
        self.assertEqual(
            legacy.exception.context,
            {"origin_alias": "acme", "schema": legacy_schema},
        )

    def test_malformed_artifact_url_parser_cause_is_suppressed(self) -> None:
        canary = "RUNTIME_SECRET_CANARY"
        with self.assertRaises(CatalogError) as raised:
            self.parse(
                catalog_bytes(
                    valid_entry(url=f"https://cdn.example.test:{canary}/artifact.md")
                )
            )

        rendered = "".join(
            traceback.format_exception(
                type(raised.exception),
                raised.exception,
                raised.exception.__traceback__,
            )
        )
        self.assertNotIn(canary, rendered)
        self.assertTrue(raised.exception.__suppress_context__)

    def test_typescript_v0_2_name_and_description_cases_match(self) -> None:
        invalid_entries = (
            valid_entry(name="Bad-Name"),
            valid_entry(name="bad--name"),
            valid_entry(name="x" * 65),
            valid_entry(description="x" * 1025),
        )
        for entry in invalid_entries:
            with self.subTest(entry=entry):
                with self.assertRaises(CatalogError):
                    self.parse(catalog_bytes(entry))

        snapshot = self.parse(catalog_bytes(valid_entry(description="😀" * 1024)))
        self.assertEqual(snapshot.entries[0].description, "😀" * 1024)

    def test_typescript_v0_2_unknown_artifact_type_is_skipped(self) -> None:
        snapshot = self.parse(
            catalog_bytes(
                valid_entry(type="future-type"),
                valid_entry(name="known", url="known.md"),
            )
        )
        self.assertEqual([entry.name for entry in snapshot.entries], ["known"])

    def test_artifact_urls_match_whatwg_canonical_forms(self) -> None:
        cases = (
            (
                "HTTPS://CDN.EXAMPLE.TEST:443/a/../skill.md",
                "https://cdn.example.test/skill.md",
            ),
            (
                "http://CDN.EXAMPLE.TEST:80/a/./skill.md",
                "http://cdn.example.test/a/skill.md",
            ),
            (
                "../artifacts/./skill.md",
                "https://skills.example.test/v2/artifacts/skill.md",
            ),
            (
                "https://b\N{LATIN SMALL LETTER U WITH DIAERESIS}cher.example:443/"
                "skills/\N{LATIN SMALL LETTER U WITH DIAERESIS}ber skill.md",
                "https://xn--bcher-kva.example/skills/%C3%BCber%20skill.md",
            ),
            (
                "https://fa\N{LATIN SMALL LETTER SHARP S}.de/skill.md",
                "https://xn--fa-hia.de/skill.md",
            ),
            (
                "https://\N{FULLWIDTH LATIN SMALL LETTER E}xample.example/skill.md",
                "https://example.example/skill.md",
            ),
            (
                "https://cdn.example.test/skills/[team]|review.md",
                "https://cdn.example.test/skills/[team]|review.md",
            ),
            (
                "https://cdn.example.test/a/%2e/b/skill.md",
                "https://cdn.example.test/a/b/skill.md",
            ),
        )
        index_url = "https://skills.example.test/v2/catalog/index.json"
        for url, expected in cases:
            with self.subTest(url=url):
                try:
                    snapshot = catalog.parse_catalog(
                        catalog_bytes(valid_entry(url=url)),
                        origin_alias="acme",
                        index_url=index_url,
                    )
                except CatalogError as error:
                    self.fail(f"valid TypeScript URL was rejected: {error.code}")
                self.assertEqual(snapshot.entries[0].url, expected)

    def test_artifact_urls_fail_closed_on_noncanonical_forms(
        self,
    ) -> None:
        divergent_urls = (
            "https://cdn.example.test\\artifact.md",
            "https://user:password@cdn.example.test/skill.md",
            "artifact.md?",
            "artifact.md#",
        )
        for url in divergent_urls:
            with self.subTest(url=url):
                with self.assertRaises(CatalogError) as raised:
                    self.parse(catalog_bytes(valid_entry(url=url)))
                self.assertEqual(raised.exception.code, "catalog_invalid")
                self.assertEqual(raised.exception.context["field"], "skills[0].url")

    def test_alias_parity_and_at_least_one_explicit_origin(self) -> None:
        with self.assertRaises(CatalogError):
            catalog_client.CatalogDiscovery(origins={})
        for alias in ("Acme", "1acme", "a" * 64):
            with self.subTest(alias=alias):
                with self.assertRaises(CatalogError):
                    catalog_client.CatalogDiscovery(
                        origins={alias: Origin(url="https://skills.example.test")}
                    )
        valid = catalog_client.CatalogDiscovery(
            origins={"a" * 63: Origin(url="https://skills.example.test")}
        )
        self.assertIsNotNone(valid)

    def test_loopback_http_opt_in_is_rejected_for_https_production_origin(self) -> None:
        with self.assertRaises(CatalogError) as raised:
            Origin(url="https://skills.example.test", allow_loopback_http=True)
        self.assertEqual(raised.exception.code, "configuration_invalid")
        self.assertEqual(raised.exception.context, {"field": "allow_loopback_http"})

    def test_loopback_http_opt_in_requires_an_exact_boolean(self) -> None:
        for value in (0, 1, None, object()):
            with self.subTest(value=value):
                with self.assertRaises(CatalogError) as raised:
                    Origin(
                        url="http://127.0.0.1:8787",
                        allow_loopback_http=value,
                    )
                self.assertEqual(raised.exception.code, "configuration_invalid")
                self.assertEqual(
                    raised.exception.context, {"field": "allow_loopback_http"}
                )

    def test_origin_and_artifact_scope_authorities_are_exactly_canonical(self) -> None:
        origin = Origin(
            url="HTTPS://SKILLS.EXAMPLE.TEST/base",
            artifact_headers={"CDN.EXAMPLE.TEST:8443": {"x-cdn-token": "secret"}},
        )
        self.assertEqual(
            origin.catalog_url,
            "https://skills.example.test/.well-known/agent-skills/index.json",
        )
        self.assertEqual(
            origin.headers_for("https://cdn.example.test:8443/artifact.md"),
            {"x-cdn-token": "secret"},
        )
        self.assertEqual(origin.headers_for("https://cdn.example.test/artifact.md"), {})

        try:
            default_port = Origin(url="https://skills.example.test:443/base")
        except CatalogError as error:
            self.fail(f"default HTTPS port was rejected: {error.code}")
        self.assertEqual(default_port.url, "https://skills.example.test/base")
        try:
            unicode_origin = Origin(
                url="https://b\N{LATIN SMALL LETTER U WITH DIAERESIS}cher.example:443/"
                "caf\N{LATIN SMALL LETTER E WITH ACUTE}"
            )
        except CatalogError as error:
            self.fail(f"Unicode origin URL was rejected: {error.code}")
        self.assertEqual(
            unicode_origin.url,
            "https://xn--bcher-kva.example/caf%C3%A9",
        )
        self.assertEqual(
            unicode_origin.catalog_url,
            "https://xn--bcher-kva.example/.well-known/agent-skills/index.json",
        )
        encoded_origin = Origin(url="https://%65xample.test")
        self.assertEqual(encoded_origin.url, "https://example.test/")
        self.assertEqual(
            encoded_origin.catalog_url,
            "https://example.test/.well-known/agent-skills/index.json",
        )
        numeric_origins = (
            ("https://0x7f000001", "https://127.0.0.1/"),
            ("https://127.1", "https://127.0.0.1/"),
            ("https://0177.0.0.1", "https://127.0.0.1/"),
            ("https://2130706433", "https://127.0.0.1/"),
            ("https://127.0.0x1", "https://127.0.0.1/"),
            ("https://1.2.3.4.", "https://1.2.3.4/"),
        )
        for raw_url, expected_url in numeric_origins:
            with self.subTest(raw_url=raw_url):
                self.assertEqual(Origin(url=raw_url).url, expected_url)

        invalid_origins = (
            42,
            "https://[bad",
            "https://skills.example.test\\redirected",
            "https://skills.example.test?",
            "https://skills.example.test#",
        )
        for url in invalid_origins:
            with self.subTest(url=url):
                with self.assertRaises(CatalogError) as raised:
                    Origin(url=url)
                self.assertEqual(raised.exception.code, "configuration_invalid")
                self.assertEqual(raised.exception.context, {"field": "url"})

        invalid_scopes = (
            "cdn.example.test:443",
            "cdn.example.test\\redirected",
            "b\N{LATIN SMALL LETTER U WITH DIAERESIS}cher.example",
            "%63dn.example.test",
            "0x7f000001",
            "127.1",
        )
        for scope in invalid_scopes:
            with self.subTest(scope=scope):
                with self.assertRaises(CatalogError) as raised:
                    Origin(
                        url="https://skills.example.test",
                        artifact_headers={scope: {"x-cdn-token": "secret"}},
                    )
                self.assertEqual(raised.exception.code, "configuration_invalid")
                self.assertEqual(
                    raised.exception.context, {"field": "artifact_headers"}
                )

    def test_configuration_parser_causes_do_not_retain_canaries(self) -> None:
        canary = "RUNTIME_SECRET_CANARY"

        class LeakyHeaderName:
            def lower(self) -> str:
                raise AttributeError(canary)

        operations = (
            lambda: NetworkPolicy(allowed_addresses={canary}),
            lambda: Origin(url=f"https://skills.example.test:{canary}"),
            lambda: Origin(
                url="https://skills.example.test",
                artifact_headers={
                    f"cdn.example.test:{canary}": {"x-cdn-token": "secret"}
                },
            ),
            lambda: Origin(
                url="https://skills.example.test",
                sensitive_header_names={LeakyHeaderName()},
            ),
        )
        for operation in operations:
            with self.subTest(operation=operation):
                with self.assertRaises(CatalogError) as raised:
                    operation()
                self.assertIsNone(raised.exception.__cause__)
                self.assertIsNone(raised.exception.__context__)
                self.assertTrue(raised.exception.__suppress_context__)
                rendered = "".join(
                    traceback.format_exception(
                        type(raised.exception),
                        raised.exception,
                        raised.exception.__traceback__,
                    )
                )
                self.assertNotIn(canary, rendered)

    def test_configured_header_values_are_wire_safe_latin_1(self) -> None:
        for value in ("secret\x00suffix", "secret\x01suffix", "secret\x7fsuffix", "😀"):
            with self.subTest(value=repr(value)):
                with self.assertRaises(CatalogError) as raised:
                    Origin(
                        url="https://skills.example.test",
                        headers={"x-token": value},
                    )
                self.assertEqual(raised.exception.code, "configuration_invalid")
                self.assertEqual(raised.exception.context, {"field": "headers"})

        accepted = Origin(
            url="https://skills.example.test",
            headers={"x-label": "caf\N{LATIN SMALL LETTER E WITH ACUTE}"},
        )
        self.assertEqual(
            accepted.headers["x-label"], "caf\N{LATIN SMALL LETTER E WITH ACUTE}"
        )
        with self.assertRaises(CatalogError) as artifact_header:
            Origin(
                url="https://skills.example.test",
                artifact_headers={"cdn.example.test": {"x-token": "secret\x00"}},
            )
        self.assertEqual(artifact_header.exception.code, "configuration_invalid")

    def test_global_defaults_and_network_policy_match_typescript_configuration(
        self,
    ) -> None:
        defaults_type = getattr(catalog_client, "CatalogDefaults", None)
        self.assertTrue(callable(defaults_type))
        defaults = defaults_type(timeout=0.25, retries=0, catalog_bytes=64)
        policy = NetworkPolicy(allowed_addresses={"10.0.0.7"}, max_redirects=0)
        origin = Origin(url="https://skills.example.test", network_policy=policy)
        discovery = catalog_client.CatalogDiscovery(
            origins={"acme": origin}, defaults=defaults
        )
        normalized = discovery._origins["acme"]
        self.assertEqual(normalized.timeout, 0.25)
        self.assertEqual(normalized.retries, 0)
        self.assertEqual(normalized.catalog_bytes, 64)
        self.assertEqual(normalized.network_policy.allowed_addresses, {"10.0.0.7"})
        self.assertEqual(normalized.network_policy.max_redirects, 0)


class IpPolicyParityRegressionTest(unittest.TestCase):
    def test_invalid_public_address_parser_cause_is_suppressed(self) -> None:
        canary = "RUNTIME_SECRET_CANARY"
        with self.assertRaises(CatalogError) as raised:
            evaluate_ip_address(canary, origin_alias="acme")

        rendered = "".join(
            traceback.format_exception(
                type(raised.exception),
                raised.exception,
                raised.exception.__traceback__,
            )
        )
        self.assertNotIn(canary, rendered)
        self.assertTrue(raised.exception.__suppress_context__)

    def test_ipv6_policy_is_fail_closed_for_special_and_compatible_ranges(self) -> None:
        cases = {
            "fec0::1": False,
            "64:ff9b:1::1": False,
            "::127.0.0.1": False,
            "2001:db8::1": False,
            "64:ff9b::c000:201": True,
            "2001:3::1": True,
            "2606:4700:4700::1111": True,
        }
        for address, allowed in cases.items():
            with self.subTest(address=address):
                if allowed:
                    evaluate_ip_address(address, origin_alias="acme")
                else:
                    with self.assertRaises(CatalogError) as raised:
                        evaluate_ip_address(address, origin_alias="acme")
                    self.assertEqual(raised.exception.code, "policy_denied")


if __name__ == "__main__":
    unittest.main()

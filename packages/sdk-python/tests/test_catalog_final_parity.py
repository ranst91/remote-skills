from __future__ import annotations

import asyncio
from collections.abc import Iterator, Mapping
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch


PACKAGE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PACKAGE_ROOT / "src"))

from remote_skills import catalog_client, catalog_network
from remote_skills.catalog_network import (
    HttpResponse,
    build_catalog_request,
    request_with_policy,
)
from remote_skills.catalog_errors import CatalogError
from remote_skills.catalog_http_date import parse_imf_fixdate
from remote_skills.catalog_origin import NetworkPolicy, Origin
from remote_skills.catalog_url import canonical_http_url


PUBLIC_ADDRESS = "93.184.216.34"


async def public_resolver(_host: str) -> tuple[str, ...]:
    return (PUBLIC_ADDRESS,)


class RecordingTransport:
    def __init__(self, *responses: HttpResponse) -> None:
        self._responses = list(responses)
        self.requests: list[dict[str, object]] = []

    async def request(
        self,
        url: str,
        headers: dict[str, str],
        timeout: float,
        connect_address: str,
        max_bytes: int,
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
        return self._responses.pop(0)


class SequencedResolver:
    def __init__(self, *answers: tuple[str, ...]) -> None:
        self._answers = list(answers)
        self.calls = 0

    async def __call__(self, _host: str) -> tuple[str, ...]:
        self.calls += 1
        return self._answers.pop(0)


class UncooperativeBoundary:
    def __init__(self, response: HttpResponse | None = None) -> None:
        self.started = asyncio.Event()
        self.release = asyncio.Event()
        self.completed = asyncio.Event()
        self.cancellations = 0
        self.response = response or HttpResponse(200, {}, b"late success")

    async def _finish(self, value: object) -> object:
        self.started.set()
        while not self.release.is_set():
            try:
                await self.release.wait()
            except asyncio.CancelledError:
                self.cancellations += 1
        self.completed.set()
        return value

    async def resolve(self, _host: str) -> tuple[str, ...]:
        value = await self._finish((PUBLIC_ADDRESS,))
        if not isinstance(value, tuple):
            raise AssertionError("resolver boundary returned the wrong type")
        return value

    async def getaddrinfo(
        self, *_args: object, **_kwargs: object
    ) -> list[tuple[int, int, int, str, tuple[str, int]]]:
        value = await self._finish([(2, 1, 6, "", (PUBLIC_ADDRESS, 0))])
        if not isinstance(value, list):
            raise AssertionError("getaddrinfo boundary returned the wrong type")
        return value

    async def request(
        self,
        _url: str,
        _headers: dict[str, str],
        _timeout: float,
        _connect_address: str,
        _max_bytes: int,
    ) -> HttpResponse:
        value = await self._finish(self.response)
        if not isinstance(value, HttpResponse):
            raise AssertionError("transport boundary returned the wrong type")
        return value


class ThrowingBoundary:
    def __init__(self, canary: str) -> None:
        self.canary = canary

    async def resolve(self, _host: str) -> tuple[str, ...]:
        raise RuntimeError(self.canary)

    async def request(
        self,
        _url: str,
        _headers: dict[str, str],
        _timeout: float,
        _connect_address: str,
        _max_bytes: int,
    ) -> HttpResponse:
        raise RuntimeError(self.canary)


class RaisingBoundary:
    def __init__(self, error: BaseException) -> None:
        self.error = error

    async def resolve(self, _host: str) -> tuple[str, ...]:
        raise self.error

    async def request(
        self,
        _url: str,
        _headers: dict[str, str],
        _timeout: float,
        _connect_address: str,
        _max_bytes: int,
    ) -> HttpResponse:
        raise self.error


class ExplodingIterable:
    def __init__(self, canary: str) -> None:
        self.canary = canary

    def __iter__(self) -> Iterator[object]:
        raise RuntimeError(self.canary)


class ExplodingAddress:
    def __init__(self, canary: str) -> None:
        self.canary = canary

    def __contains__(self, _value: object) -> bool:
        raise RuntimeError(self.canary)


class ExplodingHeaders(Mapping[str, str]):
    def __init__(self, canary: str) -> None:
        self.canary = canary

    def __getitem__(self, _key: str) -> str:
        raise RuntimeError(self.canary)

    def __iter__(self) -> Iterator[str]:
        raise RuntimeError(self.canary)

    def __len__(self) -> int:
        return 1


class MalformedResponse:
    def __init__(self, field: str, canary: str) -> None:
        self.field = field
        self.canary = canary

    @property
    def status(self) -> object:
        if self.field == "status":
            raise RuntimeError(self.canary)
        return "200" if self.field == "shape" else 200

    @property
    def headers(self) -> object:
        return ExplodingHeaders(self.canary) if self.field == "headers" else {}

    @property
    def body(self) -> object:
        if self.field == "body":
            raise RuntimeError(self.canary)
        return b"ok"


class ReturningTransport:
    def __init__(self, response: object) -> None:
        self.response = response

    async def request(
        self,
        _url: str,
        _headers: dict[str, str],
        _timeout: float,
        _connect_address: str,
        _max_bytes: int,
    ) -> object:
        return self.response


class PlainResponse:
    def __init__(self, status: object, headers: object, body: object) -> None:
        self.status = status
        self.headers = headers
        self.body = body


def assert_sanitized_origin_unavailable(
    test_case: unittest.TestCase, result: object, canary: str
) -> None:
    error = getattr(result, "error", None)
    test_case.assertIsInstance(error, CatalogError)
    test_case.assertEqual(error.code, "origin_unavailable")
    test_case.assertTrue(error.retryable)
    test_case.assertEqual(error.context, {"origin_alias": "acme"})
    test_case.assertIsNone(error.__cause__)
    rendered = f"{error!r} {error} {error.context!r} {error.to_diagnostic()!r}"
    test_case.assertNotIn(canary, rendered)
    test_case.assertLess(len(rendered), 250)


class WhatwgUrlGoldenTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        path = PACKAGE_ROOT / "tests/fixtures/url-whatwg-cases.json"
        document = json.loads(path.read_text(encoding="utf-8"))
        cls.cases = document["cases"]
        cls.resolution_cases = document["resolution_cases"]
        cls.version_drift_cases = document["version_drift_cases"]
        cls.invalid_cases = document["invalid_cases"]

    def test_package_node_24_url_goldens_match(self) -> None:
        for case in self.cases:
            with self.subTest(case=case["id"]):
                self.assertEqual(canonical_http_url(case["input"]), case["expected"])

    def test_scoped_headers_use_the_same_canonical_authorities(self) -> None:
        for case in self.cases:
            with self.subTest(case=case["id"]):
                origin = Origin(
                    url="https://skills.example.test",
                    artifact_headers={case["authority"]: {"x-scope": case["id"]}},
                )
                self.assertEqual(
                    origin.headers_for(case["input"], purpose="skill-md"),
                    {"x-scope": case["id"]},
                )

        with self.assertRaises(CatalogError) as raised:
            Origin(
                url="https://skills.example.test",
                artifact_headers={"😀.la": {"x-scope": "secret"}},
            )
        self.assertEqual(raised.exception.code, "configuration_invalid")

    def test_relative_references_match_node_24_whatwg_resolution(self) -> None:
        for case in self.resolution_cases:
            with self.subTest(case=case["id"]):
                self.assertEqual(
                    canonical_http_url(case["input"], base=case["base"]),
                    case["expected"],
                )

    def test_pinned_tables_cover_the_48_python_version_drift_scalars(self) -> None:
        self.assertEqual(len(self.version_drift_cases), 48)
        for case in self.version_drift_cases:
            input_url = "https://a" + chr(int(case["codepoint"], 16)) + "b.example/"
            with self.subTest(codepoint=case["codepoint"]):
                if case["expected"] is None:
                    with self.assertRaises(ValueError):
                        canonical_http_url(input_url)
                else:
                    self.assertEqual(canonical_http_url(input_url), case["expected"])

    def test_package_node_24_invalid_host_goldens_fail_closed(self) -> None:
        for case in self.invalid_cases:
            with self.subTest(case=case["id"]):
                with self.assertRaises(ValueError):
                    canonical_http_url(case["input"], base=case.get("base"))


class NetworkRequestParityTest(unittest.IsolatedAsyncioTestCase):
    async def test_proxy_authorization_is_sent_and_always_redacted(self) -> None:
        canary = "RUNTIME_PROXY_CREDENTIAL_CANARY"
        origin = Origin(
            url="https://skills.example.test",
            headers={"Proxy-Authorization": canary},
            artifact_headers={"cdn.example.test": {"Proxy-Authorization": canary}},
            retries=0,
        )
        prepared = build_catalog_request(origin)
        self.assertEqual(prepared.sensitive_header_names, ("proxy-authorization",))
        self.assertNotIn("proxy-authorization", prepared.headers)
        self.assertEqual(prepared.wire_headers["proxy-authorization"], canary)
        self.assertNotIn(canary, repr(prepared))
        self.assertNotIn(canary, repr(prepared.normalized()))

        transport = RecordingTransport(HttpResponse(200, {}, b"ok"))
        result = await request_with_policy(
            origin_alias="acme",
            origin=origin,
            url=origin.catalog_url,
            purpose="catalog",
            transport=transport,
            resolver=public_resolver,
        )
        self.assertIsNone(result.error)
        self.assertEqual(
            transport.requests[0]["headers"]["proxy-authorization"], canary
        )

        cdn_transport = RecordingTransport(HttpResponse(200, {}, b"artifact"))
        cdn_result = await request_with_policy(
            origin_alias="acme",
            origin=origin,
            url="https://cdn.example.test/artifact.md",
            purpose="skill-md",
            transport=cdn_transport,
            resolver=public_resolver,
        )
        self.assertIsNone(cdn_result.error)
        self.assertEqual(
            origin.sensitive_headers_for("https://cdn.example.test/artifact.md"),
            frozenset({"proxy-authorization"}),
        )
        self.assertEqual(
            cdn_transport.requests[0]["headers"]["proxy-authorization"], canary
        )

    async def test_numeric_hosts_canonicalize_before_address_policy(self) -> None:
        public_origin = Origin(url="https://0x08080808")
        self.assertEqual(public_origin.url, "https://8.8.8.8/")
        public_transport = RecordingTransport(HttpResponse(200, {}, b"ok"))
        result = await request_with_policy(
            origin_alias="public",
            origin=public_origin,
            url=public_origin.catalog_url,
            purpose="catalog",
            transport=public_transport,
            resolver=ThrowingBoundary("resolver-must-not-run").resolve,
        )
        self.assertIsNone(result.error)
        self.assertEqual(public_transport.requests[0]["connect_address"], "8.8.8.8")

        blocked = (
            ("https://127.1", "https://127.0.0.1/"),
            ("https://2130706433", "https://127.0.0.1/"),
            ("https://0300.0250.0001.0001", "https://192.168.1.1/"),
        )
        for configured, canonical in blocked:
            with self.subTest(configured=configured):
                blocked_origin = Origin(url=configured, retries=0)
                self.assertEqual(blocked_origin.url, canonical)
                blocked_transport = RecordingTransport(
                    HttpResponse(200, {}, b"unexpected")
                )
                denied = await request_with_policy(
                    origin_alias="blocked",
                    origin=blocked_origin,
                    url=blocked_origin.catalog_url,
                    purpose="catalog",
                    transport=blocked_transport,
                    resolver=ThrowingBoundary("resolver-must-not-run").resolve,
                )
                self.assertEqual(denied.error.code, "policy_denied")
                self.assertEqual(blocked_transport.requests, [])

    async def test_unexpected_injected_boundary_errors_are_sanitized(self) -> None:
        canary = "RUNTIME_CREDENTIAL_CANARY"
        for stage in ("resolver", "transport"):
            with self.subTest(stage=stage):
                boundary = ThrowingBoundary(canary)
                try:
                    result = await request_with_policy(
                        origin_alias="acme",
                        origin=Origin(url="https://skills.example.test", retries=0),
                        url="https://skills.example.test/artifact",
                        purpose="skill-md",
                        transport=(
                            boundary
                            if stage == "transport"
                            else RecordingTransport(HttpResponse(200, {}, b"ok"))
                        ),
                        resolver=(
                            boundary.resolve if stage == "resolver" else public_resolver
                        ),
                    )
                except RuntimeError as error:
                    self.fail(
                        f"unexpected {stage} failure escaped: {type(error).__name__}"
                    )
                assert_sanitized_origin_unavailable(self, result, canary)

    async def test_malformed_resolver_results_are_sanitized_after_return(self) -> None:
        canary = "MALFORMED_RESOLVER_CANARY"

        async def exploding_iterable(_host: str) -> object:
            return ExplodingIterable(canary)

        async def exploding_item(_host: str) -> object:
            return [ExplodingAddress(canary)]

        for case, resolver in (
            ("iterable", exploding_iterable),
            ("item", exploding_item),
        ):
            with self.subTest(case=case):
                result = await request_with_policy(
                    origin_alias="acme",
                    origin=Origin(url="https://skills.example.test", retries=0),
                    url="https://skills.example.test/artifact",
                    purpose="skill-md",
                    transport=RecordingTransport(HttpResponse(200, {}, b"ok")),
                    resolver=resolver,
                )
                assert_sanitized_origin_unavailable(self, result, canary)

    async def test_oversized_resolver_address_is_rejected_before_ip_parsing(
        self,
    ) -> None:
        oversized = "1" * 50_000_000

        async def oversized_resolver(_host: str) -> tuple[str, ...]:
            return (oversized,)

        parsed_addresses: list[str] = []
        parse_address = catalog_network.ipaddress.ip_address

        def recording_parse_address(address: str) -> object:
            parsed_addresses.append(address)
            return parse_address(address)

        with patch.object(
            catalog_network.ipaddress,
            "ip_address",
            side_effect=recording_parse_address,
        ):
            result = await request_with_policy(
                origin_alias="acme",
                origin=Origin(
                    url="https://skills.example.test", retries=0, timeout=0.01
                ),
                url="https://skills.example.test/artifact",
                purpose="skill-md",
                transport=RecordingTransport(HttpResponse(200, {}, b"unexpected")),
                resolver=oversized_resolver,
            )

        assert_sanitized_origin_unavailable(self, result, oversized[:64])
        self.assertTrue(parsed_addresses)
        self.assertLessEqual(max(map(len, parsed_addresses)), 45)

    async def test_maximum_length_ipv6_resolver_address_remains_valid(self) -> None:
        maximum_ipv6 = "ffff:ffff:ffff:ffff:ffff:ffff:255.255.255.255"
        self.assertEqual(len(maximum_ipv6), 45)

        async def maximum_ipv6_resolver(_host: str) -> tuple[str, ...]:
            return (maximum_ipv6,)

        transport = RecordingTransport(HttpResponse(200, {}, b"ok"))
        result = await request_with_policy(
            origin_alias="acme",
            origin=Origin(
                url="https://skills.example.test",
                retries=0,
                network_policy=NetworkPolicy(allowed_addresses={maximum_ipv6}),
            ),
            url="https://skills.example.test/artifact",
            purpose="skill-md",
            transport=transport,
            resolver=maximum_ipv6_resolver,
        )

        self.assertIsNone(result.error)
        self.assertEqual(transport.requests[0]["connect_address"], maximum_ipv6)

    async def test_malformed_transport_results_are_sanitized_after_return(self) -> None:
        canary = "MALFORMED_TRANSPORT_CANARY"
        for field in ("status", "headers", "body", "shape"):
            with self.subTest(field=field):
                result = await request_with_policy(
                    origin_alias="acme",
                    origin=Origin(url="https://skills.example.test", retries=0),
                    url="https://skills.example.test/artifact",
                    purpose="skill-md",
                    transport=ReturningTransport(MalformedResponse(field, canary)),
                    resolver=public_resolver,
                )
                assert_sanitized_origin_unavailable(self, result, canary)

    async def test_injected_status_099_remains_terminal_with_status_context(
        self,
    ) -> None:
        transport = RecordingTransport(
            HttpResponse(99, {}, b""),
            HttpResponse(200, {}, b"unexpected retry"),
        )

        result = await request_with_policy(
            origin_alias="acme",
            origin=Origin(url="https://skills.example.test", retries=1),
            url="https://skills.example.test/artifact",
            purpose="skill-md",
            transport=transport,
            resolver=public_resolver,
        )

        self.assertEqual(result.attempts, 1)
        self.assertEqual(len(transport.requests), 1)
        self.assertEqual(result.error.code, "origin_unavailable")
        self.assertTrue(result.error.retryable)
        self.assertEqual(result.error.context, {"origin_alias": "acme", "status": 99})

    async def test_injected_response_headers_are_bounded(self) -> None:
        cases = (
            ("count", {f"x-header-{index}": "v" for index in range(101)}),
            ("bytes", {"x-large": "v" * 65_536}),
        )
        for case, headers in cases:
            with self.subTest(case=case):
                result = await request_with_policy(
                    origin_alias="acme",
                    origin=Origin(url="https://skills.example.test", retries=0),
                    url="https://skills.example.test/artifact",
                    purpose="skill-md",
                    transport=ReturningTransport(PlainResponse(200, headers, b"ok")),
                    resolver=public_resolver,
                )
                assert_sanitized_origin_unavailable(
                    self, result, "UNTRUSTED_HEADER_CANARY"
                )

    async def test_injected_catalog_errors_are_rebuilt_without_caller_context(
        self,
    ) -> None:
        canary = "TYPED_BOUNDARY_CONTEXT_CANARY"
        for stage in ("resolver", "transport"):
            with self.subTest(stage=stage):
                boundary = RaisingBoundary(
                    CatalogError(
                        canary,
                        retryable=False,
                        context={"origin_alias": canary, "status": canary},
                    )
                )
                result = await request_with_policy(
                    origin_alias="acme",
                    origin=Origin(url="https://skills.example.test", retries=0),
                    url="https://skills.example.test/artifact",
                    purpose="skill-md",
                    transport=(
                        boundary
                        if stage == "transport"
                        else RecordingTransport(HttpResponse(200, {}, b"ok"))
                    ),
                    resolver=(
                        boundary.resolve if stage == "resolver" else public_resolver
                    ),
                )
                assert_sanitized_origin_unavailable(self, result, canary)

    async def test_scheme_change_header_scope_matches_host_only_policy(self) -> None:
        upgrade_origin = Origin(
            url="http://127.0.0.1:8787",
            headers={"authorization": "origin-secret"},
            allow_loopback_http=True,
            network_policy=NetworkPolicy(allowed_addresses={"127.0.0.1"}),
        )
        upgrade_transport = RecordingTransport(
            HttpResponse(
                302,
                {"location": "https://127.0.0.1:8787/upgraded"},
                b"",
            ),
            HttpResponse(200, {}, b"ok"),
        )
        upgraded = await request_with_policy(
            origin_alias="local",
            origin=upgrade_origin,
            url=upgrade_origin.catalog_url,
            purpose="skill-md",
            transport=upgrade_transport,
            resolver=ThrowingBoundary("literal-resolver-must-not-run").resolve,
        )
        self.assertIsNone(upgraded.error)
        self.assertEqual(
            [
                request["headers"].get("authorization")
                for request in upgrade_transport.requests
            ],
            ["origin-secret", "origin-secret"],
        )

        downgrade_origin = Origin(
            url="https://skills.example.test",
            headers={"authorization": "origin-secret"},
            retries=0,
        )
        downgrade_transport = RecordingTransport(
            HttpResponse(
                302,
                {"location": "http://skills.example.test/downgraded"},
                b"",
            )
        )
        downgraded = await request_with_policy(
            origin_alias="acme",
            origin=downgrade_origin,
            url=downgrade_origin.catalog_url,
            purpose="skill-md",
            transport=downgrade_transport,
            resolver=public_resolver,
        )
        self.assertEqual(downgraded.error.code, "policy_denied")
        self.assertEqual(len(downgrade_transport.requests), 1)

    async def test_empty_dns_answer_is_terminal_policy_denied(self) -> None:
        resolver = SequencedResolver((), (PUBLIC_ADDRESS,))
        transport = RecordingTransport(HttpResponse(200, {}, b"ok"))

        result = await request_with_policy(
            origin_alias="acme",
            origin=Origin(url="https://skills.example.test", retries=2),
            url="https://skills.example.test/artifact",
            purpose="skill-md",
            transport=transport,
            resolver=resolver,
            sleeper=self._no_sleep,
            entropy=lambda: 0.0,
        )

        self.assertEqual(result.error.code, "policy_denied")
        self.assertFalse(result.error.retryable)
        self.assertEqual(result.error.context, {"origin_alias": "acme"})
        self.assertEqual(result.attempts, 1)
        self.assertEqual(resolver.calls, 1)
        self.assertEqual(len(transport.requests), 0)
        self.assertEqual(result.delays_ms, ())

    async def test_status_500_and_above_retry_like_typescript(self) -> None:
        for status in (500, 599, 600):
            with self.subTest(status=status):
                transport = RecordingTransport(
                    HttpResponse(status, {}, b""), HttpResponse(200, {}, b"ok")
                )
                result = await request_with_policy(
                    origin_alias="acme",
                    origin=Origin(url="https://skills.example.test", retries=1),
                    url="https://skills.example.test/artifact",
                    purpose="archive",
                    transport=transport,
                    resolver=public_resolver,
                    sleeper=self._no_sleep,
                    entropy=lambda: 0.0,
                )
                self.assertIsNone(result.error)
                self.assertEqual(result.attempts, 2)
                self.assertEqual(len(transport.requests), 2)

    async def test_terminal_origin_unavailable_retryability_is_code_level(self) -> None:
        cases = (
            404,
            408,
            429,
            500,
            599,
            600,
        )
        for status in cases:
            with self.subTest(status=status):
                transport = RecordingTransport(HttpResponse(status, {}, b""))
                result = await request_with_policy(
                    origin_alias="acme",
                    origin=Origin(url="https://skills.example.test", retries=0),
                    url="https://skills.example.test/artifact",
                    purpose="archive",
                    transport=transport,
                    resolver=public_resolver,
                )
                self.assertEqual(result.error.code, "origin_unavailable")
                self.assertTrue(result.error.retryable)
                self.assertEqual(
                    result.error.context,
                    {"origin_alias": "acme", "status": status},
                )
                self.assertEqual(len(transport.requests), 1)

    async def test_404_diagnostic_is_retryable_without_scheduling_a_retry(self) -> None:
        transport = RecordingTransport(HttpResponse(404, {}, b""))
        result = await request_with_policy(
            origin_alias="acme",
            origin=Origin(url="https://skills.example.test", retries=2),
            url="https://skills.example.test/artifact",
            purpose="archive",
            transport=transport,
            resolver=public_resolver,
        )

        self.assertEqual(result.error.code, "origin_unavailable")
        self.assertTrue(result.error.retryable)
        self.assertEqual(result.attempts, 1)
        self.assertEqual(len(transport.requests), 1)

    async def test_attempt_deadline_wins_over_uncooperative_injected_work(self) -> None:
        for stage in ("resolver", "transport"):
            with self.subTest(stage=stage):
                boundary = UncooperativeBoundary()
                request_task = asyncio.create_task(
                    request_with_policy(
                        origin_alias="acme",
                        origin=Origin(
                            url="https://skills.example.test",
                            retries=0,
                            timeout=0.02,
                        ),
                        url="https://skills.example.test/artifact",
                        purpose="skill-md",
                        transport=(
                            RecordingTransport(HttpResponse(200, {}, b"ok"))
                            if stage == "resolver"
                            else boundary
                        ),
                        resolver=(
                            boundary.resolve if stage == "resolver" else public_resolver
                        ),
                    )
                )
                await boundary.started.wait()
                try:
                    result = await asyncio.wait_for(
                        asyncio.shield(request_task), timeout=0.12
                    )
                except TimeoutError:
                    boundary.release.set()
                    await asyncio.wait_for(request_task, timeout=0.2)
                    self.fail(f"{stage} suppressed the independent deadline result")
                boundary.release.set()
                await asyncio.wait_for(boundary.completed.wait(), timeout=0.2)
                await asyncio.sleep(0)

                self.assertEqual(result.error.code, "request_timeout")
                self.assertEqual(result.attempts, 1)
                self.assertGreaterEqual(boundary.cancellations, 1)

    async def test_default_resolver_late_result_is_contained_after_deadline(
        self,
    ) -> None:
        boundary = UncooperativeBoundary()
        loop = asyncio.get_running_loop()
        with patch.object(loop, "getaddrinfo", side_effect=boundary.getaddrinfo):
            request_task = asyncio.create_task(
                request_with_policy(
                    origin_alias="acme",
                    origin=Origin(
                        url="https://skills.example.test", retries=0, timeout=0.02
                    ),
                    url="https://skills.example.test/artifact",
                    purpose="skill-md",
                    transport=RecordingTransport(HttpResponse(200, {}, b"ok")),
                    resolver=catalog_network.default_resolver,
                )
            )
            await boundary.started.wait()
            try:
                result = await asyncio.wait_for(
                    asyncio.shield(request_task), timeout=0.12
                )
            except TimeoutError:
                boundary.release.set()
                await asyncio.wait_for(request_task, timeout=0.2)
                self.fail("default resolver suppressed the independent deadline result")
            boundary.release.set()
            await asyncio.wait_for(boundary.completed.wait(), timeout=0.2)
            await asyncio.sleep(0)

        self.assertEqual(result.error.code, "request_timeout")
        self.assertGreaterEqual(boundary.cancellations, 1)

    async def test_late_redirect_cannot_resolve_after_attempt_deadline(self) -> None:
        boundary = UncooperativeBoundary(
            HttpResponse(
                302,
                {"location": "https://redirect.example.test/late"},
                b"",
            )
        )
        resolved_hosts: list[str] = []

        async def recording_resolver(host: str) -> tuple[str, ...]:
            resolved_hosts.append(host)
            return (PUBLIC_ADDRESS,)

        result = await request_with_policy(
            origin_alias="acme",
            origin=Origin(url="https://skills.example.test", retries=0, timeout=0.02),
            url="https://skills.example.test/artifact",
            purpose="skill-md",
            transport=boundary,
            resolver=recording_resolver,
        )
        self.assertEqual(result.error.code, "request_timeout")

        boundary.release.set()
        await asyncio.wait_for(boundary.completed.wait(), timeout=0.2)
        for _attempt in range(10):
            await asyncio.sleep(0)

        self.assertEqual(resolved_hosts, ["skills.example.test"])

    async def test_retry_after_uses_ecmascript_trim_boundaries(self) -> None:
        async def observed_delay(value: str) -> float:
            delays: list[float] = []

            async def record(delay: float) -> None:
                delays.append(delay)

            result = await request_with_policy(
                origin_alias="acme",
                origin=Origin(url="https://skills.example.test", retries=1),
                url="https://skills.example.test/artifact",
                purpose="skill-md",
                transport=RecordingTransport(
                    HttpResponse(429, {"retry-after": value}, b""),
                    HttpResponse(200, {}, b"ok"),
                ),
                resolver=public_resolver,
                sleeper=record,
                entropy=lambda: 0.5,
            )
            self.assertIsNone(result.error)
            return delays[0]

        self.assertEqual(await observed_delay("\ufeff2\ufeff"), 2.0)
        self.assertEqual(await observed_delay("\u00852\u0085"), 0.125)

    async def test_accept_defaults_and_scoped_overrides_match_typescript(self) -> None:
        catalog_transport = RecordingTransport(
            HttpResponse(
                302, {"location": "https://cdn.example.test/catalog.json"}, b""
            ),
            HttpResponse(200, {}, b"{}"),
        )
        origin = Origin(
            url="https://skills.example.test",
            headers={
                "accept": "text/plain",
                "authorization": "origin-secret",
            },
            artifact_headers={
                "cdn.example.test": {
                    "accept": "text/plain",
                    "x-cdn-token": "cdn-secret",
                }
            },
        )
        self.assertEqual(
            build_catalog_request(origin).wire_headers["accept"], "text/plain"
        )
        await request_with_policy(
            origin_alias="acme",
            origin=origin,
            url=origin.catalog_url,
            purpose="catalog",
            transport=catalog_transport,
            resolver=public_resolver,
        )
        self.assertEqual(
            catalog_transport.requests[0]["headers"],
            {"accept": "text/plain", "authorization": "origin-secret"},
        )
        self.assertEqual(
            catalog_transport.requests[1]["headers"], {"accept": "application/json"}
        )

        skill_transport = RecordingTransport(
            HttpResponse(
                302,
                {"location": "https://cdn.example.test/artifacts/SKILL.md"},
                b"",
            ),
            HttpResponse(200, {}, b"skill"),
        )
        await request_with_policy(
            origin_alias="acme",
            origin=origin,
            url="https://skills.example.test/artifacts/SKILL.md",
            purpose="skill-md",
            transport=skill_transport,
            resolver=public_resolver,
        )
        self.assertEqual(
            skill_transport.requests[0]["headers"],
            {"accept": "text/plain", "authorization": "origin-secret"},
        )
        self.assertEqual(
            skill_transport.requests[1]["headers"],
            {"accept": "text/plain", "x-cdn-token": "cdn-secret"},
        )

        archive_transport = RecordingTransport(HttpResponse(200, {}, b"archive"))
        await request_with_policy(
            origin_alias="acme",
            origin=origin,
            url="https://cdn.example.test/artifacts/skill.tar.gz",
            purpose="archive",
            transport=archive_transport,
            resolver=public_resolver,
        )
        self.assertEqual(
            archive_transport.requests[0]["headers"],
            {"accept": "text/plain", "x-cdn-token": "cdn-secret"},
        )

        default_transport = RecordingTransport(
            HttpResponse(200, {}, b"catalog"),
            HttpResponse(200, {}, b"skill"),
            HttpResponse(200, {}, b"archive"),
        )
        default_origin = Origin(url="https://skills.example.test")
        for purpose, url in (
            ("catalog", default_origin.catalog_url),
            ("skill-md", "https://skills.example.test/SKILL.md"),
            ("archive", "https://skills.example.test/skill.tar.gz"),
        ):
            await request_with_policy(
                origin_alias="acme",
                origin=default_origin,
                url=url,
                purpose=purpose,
                transport=default_transport,
                resolver=public_resolver,
            )
        self.assertEqual(
            [request["headers"] for request in default_transport.requests],
            [
                {"accept": "application/json"},
                {"accept": "text/markdown"},
                {"accept": "application/octet-stream"},
            ],
        )

    async def test_artifact_standard_and_configured_sensitive_names_are_classified(
        self,
    ) -> None:
        origin = Origin(
            url="https://skills.example.test",
            artifact_headers={
                "cdn.example.test": {
                    "authorization": "authorization-secret",
                    "cookie": "cookie-secret",
                    "set-cookie": "set-cookie-secret",
                    "x-api-key": "api-secret",
                    "x-custom-token": "custom-secret",
                }
            },
            artifact_sensitive_header_names={
                "cdn.example.test": frozenset({"x-custom-token"})
            },
        )
        url = "https://cdn.example.test/artifacts/SKILL.md"
        self.assertEqual(
            origin.sensitive_headers_for(url),
            frozenset(
                {
                    "authorization",
                    "cookie",
                    "set-cookie",
                    "x-api-key",
                    "x-custom-token",
                }
            ),
        )
        self.assertEqual(
            origin.sensitive_headers_for("https://other.example.test/artifact"),
            frozenset(),
        )

        origin_headers = Origin(
            url="https://skills.example.test",
            headers={"set-cookie": "origin-secret"},
        )
        self.assertEqual(
            origin_headers.sensitive_headers_for(origin_headers.catalog_url),
            frozenset({"set-cookie"}),
        )

    @staticmethod
    async def _no_sleep(_delay: float) -> None:
        return None


class HttpDateContractTest(unittest.TestCase):
    def test_only_strict_imf_fixdate_matches_the_typescript_contract(self) -> None:
        self.assertIsNotNone(parse_imf_fixdate("Tue, 25 Aug 2026 10:00:02 GMT"))
        # The accepted TypeScript parser deliberately does not use the generic
        # HTTP-date fallback forms; Python must reject the same obsolete syntax.
        for value in (
            "Tuesday, 25-Aug-26 10:00:02 GMT",  # RFC850
            "Tue Aug 25 10:00:02 2026",  # asctime
            "Mon, 25 Aug 2026 10:00:02 GMT",  # mismatched weekday
        ):
            with self.subTest(value=value):
                self.assertIsNone(parse_imf_fixdate(value))

    def test_http_dates_use_ecmascript_trim_boundaries(self) -> None:
        date = "Tue, 25 Aug 2026 10:00:00 GMT"
        expires = "Tue, 25 Aug 2026 10:01:00 GMT"
        timestamp = parse_imf_fixdate(date)
        if timestamp is None:
            self.fail("valid IMF-fixdate control did not parse")

        self.assertEqual(parse_imf_fixdate(f"\ufeff{date}\ufeff"), timestamp)
        self.assertEqual(parse_imf_fixdate(f"\r\n{date}\r\n"), timestamp)
        self.assertIsNone(parse_imf_fixdate(f"\u0085{date}\u0085"))
        self.assertEqual(
            catalog_client._remaining_freshness(
                {"date": f"\ufeff{date}\ufeff", "expires": f"\ufeff{expires}\ufeff"},
                timestamp,
                timestamp,
            ),
            60.0,
        )
        self.assertEqual(
            catalog_client._remaining_freshness(
                {"date": f"\u0085{date}\u0085", "expires": f"\u0085{expires}\u0085"},
                timestamp,
                timestamp,
            ),
            0.0,
        )

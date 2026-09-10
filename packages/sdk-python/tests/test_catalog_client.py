import asyncio
from collections import defaultdict, deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import inspect
import json
from pathlib import Path
import sys
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from remote_skills import RemoteSkills, catalog_client
from remote_skills.cache import MemoryCache
from remote_skills.cache.errors import CacheConfigurationError, CacheCorruptError
from remote_skills.catalog_errors import CatalogError
from remote_skills.catalog_network import HttpResponse, NetworkResult
from remote_skills.catalog_origin import Origin


PROTOCOL_ROOT = Path(__file__).resolve().parents[3] / "tests" / "protocol"
PUBLIC_ADDRESS = "93.184.216.34"
SCHEMA = "https://schemas.agentskills.io/discovery/0.2.0/schema.json"
DIGEST = f"sha256:{'a' * 64}"


def read_protocol_json(relative_path: str) -> dict[str, object]:
    with (PROTOCOL_ROOT / relative_path).open(encoding="utf-8") as handle:
        return json.load(handle)


def catalog_body(name: str) -> bytes:
    return json.dumps(
        {
            "$schema": SCHEMA,
            "skills": [
                {
                    "name": name,
                    "description": f"{name} catalog generation",
                    "type": "skill-md",
                    "url": f"{name}.md",
                    "digest": DIGEST,
                }
            ],
        },
        separators=(",", ":"),
    ).encode()


def deeply_nested_extension(depth: int) -> bytes:
    return b'{"next":' * depth + b"null" + b"}" * depth


def deeply_nested_extension_body(depth: int) -> bytes:
    extension = deeply_nested_extension(depth)
    return (
        b'{"$schema":"'
        + SCHEMA.encode()
        + b'","skills":[],"unknown":'
        + extension
        + b"}"
    )


def deeply_nested_entry_extension_body(depth: int) -> bytes:
    extension = deeply_nested_extension(depth)
    return (
        b'{"$schema":"'
        + SCHEMA.encode()
        + b'","skills":[{"name":"deep-entry","description":"Deep extension",'
        + b'"type":"skill-md","url":"deep.md","digest":"'
        + DIGEST.encode()
        + b'","unknown":'
        + extension
        + b"}]}"
    )


async def wait_for_request_count(transport: "RoutingTransport", count: int) -> None:
    for _attempt in range(100):
        if len(transport.requests) >= count:
            return
        await asyncio.sleep(0)
    raise AssertionError(f"expected {count} requests, got {len(transport.requests)}")


class RoutingTransport:
    def __init__(self) -> None:
        self.routes: dict[str, deque[object]] = defaultdict(deque)
        self.requests: list[tuple[str, dict[str, str], float]] = []

    def add(self, url: str, *steps: object) -> None:
        self.routes[url].extend(steps)

    async def request(
        self,
        url: str,
        headers: dict[str, str],
        timeout: float,
        connect_address: str,
        max_bytes: int,
    ) -> HttpResponse:
        self.asserted_policy = (connect_address, max_bytes)
        self.requests.append((url, dict(headers), timeout))
        step = self.routes[url].popleft()
        if inspect.isawaitable(step):
            step = await step
        if isinstance(step, BaseException):
            raise step
        if not isinstance(step, HttpResponse):
            raise TypeError("routing transport step must produce HttpResponse")
        return step


class MutableClock:
    def __init__(self, now: float = 0.0) -> None:
        self.now = now

    def __call__(self) -> float:
        return self.now


async def public_resolver(host: str) -> tuple[str, ...]:
    del host
    return (PUBLIC_ADDRESS,)


class CatalogClientModuleTest(unittest.TestCase):
    def test_catalog_client_module_is_available(self) -> None:
        try:
            client_module = importlib.util.find_spec("remote_skills.catalog_client")
        except ModuleNotFoundError:
            client_module = None

        self.assertIsNotNone(client_module)


class CatalogDiscoveryTest(unittest.IsolatedAsyncioTestCase):
    async def test_stale_fallback_preserves_failure_when_verified_age_is_invalid(
        self,
    ) -> None:
        origin = Origin(url="https://skills.example.test", retries=0)
        transport = RoutingTransport()
        transport.add(
            origin.catalog_url,
            HttpResponse(200, {"cache-control": "max-age=0"}, catalog_body("review")),
        )
        clock = MutableClock(1_000.0)
        discovery = catalog_client.CatalogDiscovery(
            origins={"acme": origin}, transport=transport,
            resolver=public_resolver, clock=clock,
        )
        await discovery.catalog("acme")

        for code in ("origin_unavailable", "request_timeout"):
            for now in (999.0, float("nan"), float("inf"), float("-inf")):
                with self.subTest(code=code, now=now):
                    clock.now = now
                    failure = CatalogError(
                        code, retryable=True, context={"origin_alias": "acme"}
                    )
                    with patch.object(
                        catalog_client, "request_with_policy",
                        return_value=NetworkResult(None, failure, 1),
                    ) as request:
                        with self.assertRaises(CatalogError) as raised:
                            await discovery.catalog(
                                "acme", refresh=True, stale_max_age=300,
                            )
                        self.assertIs(raised.exception, failure)
                        request.assert_awaited_once()

    async def test_ignored_metadata_survives_public_facade_and_no_store(self) -> None:
        body = deeply_nested_entry_extension_body(80)
        for cache_control in ("max-age=60", "no-store"):
            with self.subTest(cache_control=cache_control):
                origin = Origin(url="https://skills.example.test")
                transport = RoutingTransport()
                backend = MemoryCache()
                transport.add(
                    origin.catalog_url,
                    *[HttpResponse(200, {"cache-control": cache_control}, body)] * 2,
                )
                client = RemoteSkills(
                    origins={"acme": origin},
                    cache=backend,
                    transport=transport,
                    resolver=public_resolver,
                    clock=MutableClock(),
                )
                for _request in range(2):
                    result = await client.catalog()
                    self.assertEqual(result.failures, ())
                    self.assertEqual(
                        [entry.name for entry in result.entries], ["deep-entry"]
                    )
                    self.assertFalse(hasattr(result.entries[0], "unknown"))
                self.assertEqual(
                    len(transport.requests), 2 if cache_control == "no-store" else 1
                )
                self.assertIsNone(backend.get_catalog(origin.catalog_url))

    async def test_optional_storage_refusal_keeps_accepted_snapshot_through_304(self) -> None:
        for refusal in (CacheConfigurationError("catalog_body"), CacheCorruptError()):
            with self.subTest(refusal=refusal.code):
                origin = Origin(url="https://skills.example.test")
                transport = RoutingTransport()
                backend = MemoryCache()
                clock = MutableClock()
                transport.add(
                    origin.catalog_url,
                    HttpResponse(
                        200, {"cache-control": "max-age=0"}, catalog_body("older")
                    ),
                    HttpResponse(
                        200,
                        {"cache-control": "max-age=60", "age": "50", "etag": '"accepted"'},
                        deeply_nested_entry_extension_body(80),
                    ),
                    HttpResponse(
                        304, {"cache-control": "max-age=60", "age": "0"}, b""
                    ),
                )
                discovery = catalog_client.CatalogDiscovery(
                    origins={"acme": origin},
                    transport=transport,
                    resolver=public_resolver,
                    cache=backend,
                    clock=clock,
                )
                await discovery.catalog("acme")
                self.assertIsNotNone(backend.get_catalog(origin.catalog_url))
                with patch.object(
                    catalog_client, "validate_cached_catalog", side_effect=refusal
                ) as admission:
                    accepted = await discovery.catalog("acme")
                    self.assertEqual(
                        [entry.name for entry in accepted.entries], ["deep-entry"]
                    )
                    self.assertFalse(accepted.persistent)
                    self.assertIsNone(accepted.catalog_identifier)
                    self.assertIsNone(backend.get_catalog(origin.catalog_url))
                    clock.now += 5
                    self.assertEqual(await discovery.catalog("acme"), accepted)
                    self.assertEqual(len(transport.requests), 2)
                    clock.now += 6
                    self.assertEqual(await discovery.catalog("acme"), accepted)
                    self.assertEqual(
                        transport.requests[2][1]["if-none-match"], '"accepted"'
                    )
                    self.assertEqual(admission.call_count, 2)
                    self.assertEqual(await discovery.catalog("acme"), accepted)
                    self.assertEqual(len(transport.requests), 3)
                    self.assertIsNone(backend.get_catalog(origin.catalog_url))

    async def test_backend_corruption_remains_visible_during_catalog_storage(self) -> None:
        for operation in ("get_catalog_state", "replace_catalog"):
            with self.subTest(operation=operation):
                origin = Origin(url="https://skills.example.test")
                transport = RoutingTransport()
                backend = MemoryCache()
                transport.add(
                    origin.catalog_url, HttpResponse(200, {}, catalog_body("review"))
                )
                discovery = catalog_client.CatalogDiscovery(
                    origins={"acme": origin},
                    transport=transport,
                    resolver=public_resolver,
                    cache=backend,
                    clock=MutableClock(),
                )
                failure = CacheCorruptError()
                with patch.object(backend, operation, side_effect=failure):
                    with self.assertRaises(CacheCorruptError) as caught:
                        await discovery.catalog("acme")
                self.assertIs(caught.exception, failure)

    async def test_redirected_catalog_keeps_accepted_base_through_reuse(self) -> None:
        origin = Origin(url="https://skills.example.test")
        redirected = "https://skills.example.test/releases/index.json"
        transport = RoutingTransport()
        cache = MemoryCache()
        transport.add(
            origin.catalog_url,
            *[HttpResponse(302, {"location": redirected}, b"") for _ in range(3)],
        )
        transport.add(
            redirected,
            HttpResponse(
                200,
                {"cache-control": "max-age=60", "etag": '"redirected"'},
                catalog_body("review"),
            ),
            HttpResponse(304, {"cache-control": "max-age=60"}, b""),
            HttpResponse(200, {"cache-control": "max-age=60"}, catalog_body("review")),
        )
        discovery = catalog_client.CatalogDiscovery(
            origins={"acme": origin}, transport=transport,
            resolver=public_resolver, cache=cache, clock=MutableClock(),
        )
        first = await discovery.catalog("acme")
        self.assertEqual(
            first.entries[0].url, "https://skills.example.test/releases/review.md"
        )
        self.assertEqual((await discovery.catalog("acme")).entries, first.entries)
        self.assertEqual(len(transport.requests), 2)
        self.assertEqual(
            (await discovery.catalog("acme", refresh=True)).entries, first.entries
        )
        restarted = catalog_client.CatalogDiscovery(
            origins={"acme": origin}, transport=transport,
            resolver=public_resolver, cache=cache, clock=MutableClock(),
        )
        self.assertEqual((await restarted.catalog("acme")).entries, first.entries)
        self.assertEqual(len(transport.requests), 6)
        self.assertNotIn("if-none-match", transport.requests[4][1])

    async def test_persistent_publish_keeps_corrected_age_and_expires(self) -> None:
        for headers in (
            {"cache-control": "max-age=60", "age": "50"},
            {
                "date": "Tue, 25 Aug 2026 10:00:00 GMT",
                "expires": "Tue, 25 Aug 2026 10:01:00 GMT",
                "age": "50",
            },
        ):
            with self.subTest(headers=headers):
                origin = Origin(url="https://skills.example.test")
                transport = RoutingTransport()
                clock = MutableClock(1_787_652_000)
                transport.add(
                    origin.catalog_url,
                    HttpResponse(200, headers, catalog_body("review")),
                    HttpResponse(200, headers, catalog_body("review")),
                )
                discovery = catalog_client.CatalogDiscovery(
                    origins={"acme": origin}, transport=transport,
                    resolver=public_resolver, cache=MemoryCache(), clock=clock,
                )
                await discovery.catalog("acme")
                clock.now += 5
                await discovery.catalog("acme")
                self.assertEqual(len(transport.requests), 1)
                clock.now += 6
                await discovery.catalog("acme")
                self.assertEqual(len(transport.requests), 2)

    async def test_concurrent_misses_return_independent_generations_and_keep_newest(
        self,
    ) -> None:
        origin = Origin(url="https://skills.example.test")
        transport = RoutingTransport()
        loop = asyncio.get_running_loop()
        older: asyncio.Future[HttpResponse] = loop.create_future()
        newer: asyncio.Future[HttpResponse] = loop.create_future()
        transport.add(origin.catalog_url, older, newer)
        discovery = catalog_client.CatalogDiscovery(
            origins={"acme": origin},
            transport=transport,
            resolver=public_resolver,
            clock=MutableClock(),
        )

        first = asyncio.create_task(discovery.catalog("acme"))
        await wait_for_request_count(transport, 1)
        second = asyncio.create_task(discovery.catalog("acme"))
        await wait_for_request_count(transport, 2)
        newer.set_result(
            HttpResponse(
                200,
                {"cache-control": "max-age=300"},
                catalog_body("newer"),
            )
        )
        self.assertEqual((await second).entries[0].name, "newer")
        older.set_result(
            HttpResponse(
                200,
                {"cache-control": "max-age=300"},
                catalog_body("older"),
            )
        )
        self.assertEqual((await first).entries[0].name, "older")

        self.assertEqual(
            (await discovery.catalog("acme")).entries[0].name,
            "newer",
        )
        self.assertEqual(len(transport.requests), 2)

    async def test_deep_unknown_extension_is_ignored_during_partial_aggregate(
        self,
    ) -> None:
        deep = Origin(url="https://deep.example.test")
        healthy = Origin(url="https://healthy.example.test")
        transport = RoutingTransport()
        transport.add(
            deep.catalog_url,
            HttpResponse(200, {}, deeply_nested_extension_body(100_000)),
        )
        transport.add(
            healthy.catalog_url,
            HttpResponse(200, {}, catalog_body("healthy")),
        )
        discovery = catalog_client.CatalogDiscovery(
            origins={"deep": deep, "healthy": healthy},
            transport=transport,
            resolver=public_resolver,
        )

        aggregate = await discovery.aggregate()

        self.assertEqual([entry.name for entry in aggregate.entries], ["healthy"])
        self.assertEqual(aggregate.failures, ())

    async def test_deep_unknown_entry_extension_is_ignored(self) -> None:
        origin = Origin(url="https://deep.example.test")
        transport = RoutingTransport()
        transport.add(
            origin.catalog_url,
            HttpResponse(200, {}, deeply_nested_entry_extension_body(100_000)),
        )
        discovery = catalog_client.CatalogDiscovery(
            origins={"deep": origin},
            transport=transport,
            resolver=public_resolver,
        )

        snapshot = await discovery.catalog("deep")

        self.assertEqual([entry.name for entry in snapshot.entries], ["deep-entry"])

    async def test_checked_in_http_validator_cases_use_cache_and_conditional_headers(
        self,
    ) -> None:
        discovery_type = getattr(catalog_client, "CatalogDiscovery", None)
        self.assertTrue(callable(discovery_type))
        expected = read_protocol_json("expected-results/network-results.json")
        expected_by_id = {case["id"]: case["result"] for case in expected["cases"]}
        origin = Origin(url="https://skills.example.test")
        transport = RoutingTransport()
        clock = MutableClock()
        catalog_body = (
            b'{"$schema":"https://schemas.agentskills.io/discovery/0.2.0/schema.json",'
            b'"skills":[]}'
        )
        transport.add(
            origin.catalog_url,
            HttpResponse(
                200,
                {
                    "cache-control": "max-age=300",
                    "etag": '"catalog-v1"',
                    "last-modified": "Tue, 25 Aug 2026 10:00:00 GMT",
                },
                catalog_body,
            ),
            HttpResponse(304, {"cache-control": "max-age=300"}, b""),
        )
        discovery = discovery_type(
            origins={"acme": origin},
            transport=transport,
            resolver=public_resolver,
            clock=clock,
        )

        before = len(transport.requests)
        initial = await discovery.catalog("acme")
        actual_initial = {
            "outcome": "catalog_success",
            "origin_alias": initial.origin_alias,
            "stale": initial.stale,
            "entries": [],
            "requests": len(transport.requests) - before,
            "body_transfers": 1,
        }
        self.assertEqual(actual_initial, expected_by_id["validator-initial-200"])

        clock.now = 299.999
        before = len(transport.requests)
        fresh = await discovery.catalog("acme")
        actual_fresh = {
            "outcome": "catalog_success",
            "origin_alias": fresh.origin_alias,
            "stale": fresh.stale,
            "entries": [],
            "requests": len(transport.requests) - before,
            "body_transfers": 0,
        }
        self.assertEqual(actual_fresh, expected_by_id["validator-fresh-no-request"])

        clock.now = 300.001
        before = len(transport.requests)
        conditional = await discovery.catalog("acme")
        actual_conditional = {
            "outcome": "catalog_success",
            "origin_alias": conditional.origin_alias,
            "stale": conditional.stale,
            "entries": [],
            "requests": len(transport.requests) - before,
            "body_transfers": 0,
        }
        self.assertEqual(
            actual_conditional, expected_by_id["validator-conditional-304"]
        )
        self.assertEqual(
            transport.requests[-1][1],
            {
                "accept": "application/json",
                "if-modified-since": "Tue, 25 Aug 2026 10:00:00 GMT",
                "if-none-match": '"catalog-v1"',
            },
        )

    async def test_catalog_returns_compact_metadata_without_fetching_artifacts(
        self,
    ) -> None:
        discovery_type = getattr(catalog_client, "CatalogDiscovery", None)
        self.assertTrue(callable(discovery_type))
        origin = Origin(url="https://skills.example.test")
        transport = RoutingTransport()
        transport.add(
            origin.catalog_url,
            HttpResponse(
                200,
                {"cache-control": "max-age=60"},
                (PROTOCOL_ROOT / "fixtures/catalog/valid-v0.2.json").read_bytes(),
            ),
        )
        discovery = discovery_type(
            origins={"acme": origin},
            transport=transport,
            resolver=public_resolver,
        )

        snapshot = await discovery.catalog("acme")

        self.assertEqual(
            [entry.name for entry in snapshot.entries],
            ["code-review", "release-notes"],
        )
        self.assertEqual(len(transport.requests), 1)
        self.assertEqual(transport.requests[0][0], origin.catalog_url)
        self.assertTrue(
            all(request[0].endswith("index.json") for request in transport.requests)
        )
        self.assertFalse(
            any(hasattr(entry, "instructions") for entry in snapshot.entries)
        )

    async def test_aggregate_retains_partial_failures_and_strict_mode_details(
        self,
    ) -> None:
        discovery_type = getattr(catalog_client, "CatalogDiscovery", None)
        aggregate_error_type = getattr(catalog_client, "AggregateCatalogError", None)
        self.assertTrue(callable(discovery_type) and callable(aggregate_error_type))
        healthy = Origin(url="https://skills.example.test")
        unavailable = Origin(url="https://unavailable.example.test", retries=0)
        transport = RoutingTransport()
        transport.add(
            healthy.catalog_url,
            HttpResponse(
                200,
                {"cache-control": "no-store"},
                (
                    PROTOCOL_ROOT / "fixtures/catalog/valid-v0.2-extension.json"
                ).read_bytes(),
            ),
            HttpResponse(
                200,
                {"cache-control": "no-store"},
                (
                    PROTOCOL_ROOT / "fixtures/catalog/valid-v0.2-extension.json"
                ).read_bytes(),
            ),
        )
        transport.add(
            unavailable.catalog_url, OSError("synthetic reset"), OSError("again")
        )
        discovery = discovery_type(
            origins={"acme": healthy, "broken": unavailable},
            transport=transport,
            resolver=public_resolver,
        )

        aggregate = await discovery.aggregate(strict=False)
        self.assertEqual([entry.origin_alias for entry in aggregate.entries], ["acme"])
        self.assertEqual(
            [failure.origin_alias for failure in aggregate.failures], ["broken"]
        )
        self.assertEqual(aggregate.failures[0].error.code, "origin_unavailable")

        with self.assertRaises(aggregate_error_type) as raised:
            await discovery.aggregate(strict=True)
        self.assertEqual(
            [failure.origin_alias for failure in raised.exception.failures],
            ["broken"],
        )

        retained = raised.exception.failures[0].error
        with self.assertRaises(AttributeError):
            retained.code = "policy_denied"
        with self.assertRaises(TypeError):
            retained.context["origin_alias"] = "mutated"
        self.assertEqual(retained.to_diagnostic()["code"], "origin_unavailable")
        self.assertNotIn("synthetic reset", str(raised.exception))

    async def test_default_transport_fetches_explicit_loopback_catalog_only(
        self,
    ) -> None:
        discovery_type = getattr(catalog_client, "CatalogDiscovery", None)
        self.assertTrue(callable(discovery_type))
        requests: list[tuple[str, str | None]] = []
        body = (PROTOCOL_ROOT / "fixtures/catalog/valid-v0.2.json").read_bytes()

        class CatalogHandler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:
                requests.append((self.path, self.headers.get("Authorization")))
                if self.path != "/.well-known/agent-skills/index.json":
                    self.send_response(404)
                    self.end_headers()
                    return
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "max-age=60")
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, format: str, *args: object) -> None:
                del format, args

        server = ThreadingHTTPServer(("127.0.0.1", 0), CatalogHandler)
        server_thread = threading.Thread(target=server.serve_forever, daemon=True)
        server_thread.start()
        try:
            origin = Origin(
                url=f"http://127.0.0.1:{server.server_port}",
                headers={"Authorization": "runtime-secret"},
                allow_loopback_http=True,
            )
            try:
                discovery = discovery_type(origins={"local": origin})
            except TypeError as error:
                self.fail(f"default async transport is unavailable: {error}")
            snapshot = await discovery.catalog("local")
        finally:
            await asyncio.to_thread(server.shutdown)
            server.server_close()
            server_thread.join(timeout=2)

        self.assertEqual(len(snapshot.entries), 2)
        self.assertEqual(
            requests,
            [("/.well-known/agent-skills/index.json", "runtime-secret")],
        )

    async def test_aggregate_sanitizes_unexpected_transport_failures(
        self,
    ) -> None:
        canary = "RUNTIME_CREDENTIAL_CANARY"
        discovery_type = getattr(catalog_client, "CatalogDiscovery", None)
        self.assertTrue(callable(discovery_type))
        origin = Origin(url="https://skills.example.test", retries=0)
        transport = RoutingTransport()
        transport.add(origin.catalog_url, RuntimeError(canary))
        discovery = discovery_type(
            origins={"acme": origin},
            transport=transport,
            resolver=public_resolver,
        )

        try:
            aggregate = await discovery.aggregate()
        except RuntimeError as error:
            self.fail(f"unexpected transport failure escaped: {type(error).__name__}")

        self.assertEqual(len(aggregate.failures), 1)
        retained = aggregate.failures[0].error
        self.assertEqual(retained.code, "origin_unavailable")
        self.assertTrue(retained.retryable)
        self.assertEqual(retained.context, {"origin_alias": "acme"})
        rendered = f"{retained!r} {retained} {retained.context!r}"
        self.assertNotIn(canary, rendered)
        self.assertLess(len(rendered), 200)

    async def test_aggregate_rebuilds_injected_typed_boundary_errors(self) -> None:
        canary = "AGGREGATE_TYPED_CONTEXT_CANARY"
        resolver_bad = Origin(url="https://resolver.example.test", retries=0)
        transport_bad = Origin(url="https://transport.example.test", retries=0)
        healthy = Origin(url="https://healthy.example.test", retries=0)
        transport = RoutingTransport()
        transport.add(
            transport_bad.catalog_url,
            CatalogError(
                canary,
                retryable=False,
                context={"origin_alias": canary, "field": canary},
            ),
        )
        transport.add(
            healthy.catalog_url,
            HttpResponse(200, {}, catalog_body("healthy")),
        )

        async def boundary_resolver(host: str) -> tuple[str, ...]:
            if host == "resolver.example.test":
                raise CatalogError(
                    canary,
                    retryable=False,
                    context={"origin_alias": canary, "status": canary},
                )
            return (PUBLIC_ADDRESS,)

        discovery = catalog_client.CatalogDiscovery(
            origins={
                "resolver-bad": resolver_bad,
                "transport-bad": transport_bad,
                "healthy": healthy,
            },
            transport=transport,
            resolver=boundary_resolver,
        )

        aggregate = await discovery.aggregate()

        self.assertEqual([entry.name for entry in aggregate.entries], ["healthy"])
        self.assertEqual(
            [failure.origin_alias for failure in aggregate.failures],
            ["resolver-bad", "transport-bad"],
        )
        for failure in aggregate.failures:
            self.assertEqual(failure.error.code, "origin_unavailable")
            self.assertTrue(failure.error.retryable)
            self.assertEqual(
                failure.error.context, {"origin_alias": failure.origin_alias}
            )
            rendered = (
                f"{failure.error!r} {failure.error} "
                f"{failure.error.context!r} {failure.error.to_diagnostic()!r}"
            )
            self.assertNotIn(canary, rendered)
            self.assertLess(len(rendered), 300)

    async def test_aggregate_sanitizes_oversized_resolver_addresses(self) -> None:
        oversized = "1" * 1_000_000
        resolver_bad = Origin(url="https://resolver.example.test", retries=0)
        healthy = Origin(url="https://healthy.example.test", retries=0)
        transport = RoutingTransport()
        transport.add(
            healthy.catalog_url,
            HttpResponse(200, {}, catalog_body("healthy")),
        )

        async def boundary_resolver(host: str) -> tuple[str, ...]:
            if host == "resolver.example.test":
                return (oversized,)
            return (PUBLIC_ADDRESS,)

        discovery = catalog_client.CatalogDiscovery(
            origins={"resolver-bad": resolver_bad, "healthy": healthy},
            transport=transport,
            resolver=boundary_resolver,
        )

        aggregate = await discovery.aggregate()

        self.assertEqual([entry.name for entry in aggregate.entries], ["healthy"])
        self.assertEqual(
            [failure.origin_alias for failure in aggregate.failures],
            ["resolver-bad"],
        )
        retained = aggregate.failures[0].error
        self.assertEqual(retained.code, "origin_unavailable")
        self.assertTrue(retained.retryable)
        self.assertEqual(retained.context, {"origin_alias": "resolver-bad"})
        rendered = f"{retained!r} {retained} {retained.to_diagnostic()!r}"
        self.assertNotIn(oversized[:64], rendered)
        self.assertLess(len(rendered), 250)


if __name__ == "__main__":
    unittest.main()

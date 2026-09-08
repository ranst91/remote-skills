from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from remote_skills.cache import (
    CatalogMetadata,
    DiskCache,
    MemoryCache,
    catalog_mutation_digest,
    origin_identifier,
)
from remote_skills.cache.models import CachedCatalog
from remote_skills.catalog import (
    parse_catalog,
    select_catalog_release,
    select_catalog_version,
)
from remote_skills.catalog_client import CatalogDiscovery
from remote_skills.catalog_errors import CatalogError
from remote_skills.catalog_network import HttpResponse, build_catalog_request
from remote_skills.catalog_origin import Origin


PROTOCOL_ROOT = Path(__file__).resolve().parents[3] / "tests" / "protocol"
INDEX_URL = "https://skills.example.test/.well-known/agent-skills/index.json"
PUBLIC_ADDRESS = "93.184.216.34"
EMPTY_CATALOG = json.dumps(
    {
        "$schema": "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
        "skills": [],
    },
    separators=(",", ":"),
).encode()


async def public_resolver(_host: str) -> tuple[str, ...]:
    return (PUBLIC_ADDRESS,)


class SequenceTransport:
    def __init__(self, *responses: HttpResponse) -> None:
        self.responses = list(responses)
        self.requests: list[dict[str, str]] = []

    async def request(
        self,
        _url: str,
        headers: dict[str, str],
        _timeout: float,
        _connect_address: str,
        _max_bytes: int,
    ) -> HttpResponse:
        self.requests.append(dict(headers))
        return self.responses.pop(0)


class DeferredTransport:
    def __init__(self) -> None:
        self.requests: list[dict[str, str]] = []
        self.responses: list[asyncio.Future[HttpResponse]] = []

    async def request(
        self,
        _url: str,
        headers: dict[str, str],
        _timeout: float,
        _connect_address: str,
        _max_bytes: int,
    ) -> HttpResponse:
        response = asyncio.get_running_loop().create_future()
        self.requests.append(dict(headers))
        self.responses.append(response)
        return await response


async def wait_for_requests(transport: DeferredTransport, count: int) -> None:
    deadline = asyncio.get_running_loop().time() + 5.0
    while asyncio.get_running_loop().time() < deadline:
        if len(transport.requests) >= count:
            return
        await asyncio.sleep(0.001)
    raise AssertionError(f"expected {count} requests, got {len(transport.requests)}")


def named_catalog(name: str) -> bytes:
    return json.dumps(
        {
            "$schema": "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
            "skills": [
                {
                    "name": name,
                    "description": f"{name} generation",
                    "type": "skill-md",
                    "url": f"{name}.md",
                    "digest": f"sha256:{'a' * 64}",
                }
            ],
        },
        separators=(",", ":"),
    ).encode()


def cached_catalog(
    body: bytes,
    *,
    scope: str,
    cache_control: str = "max-age=0",
    timestamp: float = 1_777_000_000.0,
) -> CachedCatalog:
    instant = datetime.fromtimestamp(timestamp, timezone.utc)
    return CachedCatalog(
        body=body,
        metadata=CatalogMetadata(
            canonical_url=INDEX_URL,
            retrieved_at=instant,
            validated_at=instant,
            confirmed_scope=scope,
            etag=f'"{scope}-v1"',
            cache_control=cache_control,
        ),
    )


def limited_origins(body: bytes) -> dict[str, Origin]:
    return {
        "high": Origin(
            url="https://skills.example.test",
            scope="engineering",
            catalog_bytes=len(body),
        ),
        "low": Origin(
            url="https://skills.example.test",
            scope="engineering",
            catalog_bytes=len(body) - 1,
        ),
    }


async def seed_accepted_catalog(
    cache: MemoryCache | DiskCache, record: CachedCatalog
) -> None:
    metadata = record.metadata
    headers = {"cache-control": metadata.cache_control or "max-age=0"}
    if metadata.confirmed_scope is not None:
        headers["remote-skills-scope"] = metadata.confirmed_scope
    if metadata.etag is not None:
        headers["etag"] = metadata.etag
    discovery = CatalogDiscovery(
        origins={
            "acme": Origin(
                url="https://skills.example.test", scope=metadata.confirmed_scope
            )
        },
        cache=cache,
        transport=SequenceTransport(HttpResponse(200, headers, record.body)),
        resolver=public_resolver,
        clock=lambda: metadata.validated_at.timestamp(),
    )
    await discovery.catalog("acme")


class ScopeConfigurationTest(unittest.TestCase):
    def test_scope_is_exactly_one_catalog_only_header(self) -> None:
        origin = Origin(
            url="https://skills.example.test",
            headers={"Authorization": "runtime-secret"},
            scope="engineering",
        )

        request = build_catalog_request(origin)

        self.assertEqual(request.headers["remote-skills-scope"], "engineering")
        self.assertEqual(request.wire_headers["remote-skills-scope"], "engineering")
        self.assertNotIn(
            "remote-skills-scope",
            origin.headers_for(
                "https://skills.example.test/artifact.md", purpose="skill-md"
            ),
        )

    def test_scope_rejects_invalid_values_and_reserved_header_configuration(
        self,
    ) -> None:
        invalid = (
            "",
            " engineering",
            "engineering ",
            "engineering,sales",
            "x" * 129,
            "x\x7f",
        )
        for scope in invalid:
            with self.subTest(scope=scope):
                with self.assertRaisesRegex(
                    Exception, "configuration_invalid"
                ) as raised:
                    Origin(url="https://skills.example.test", scope=scope)
                self.assertEqual(raised.exception.context, {"field": "scope"})

        with self.assertRaises(Exception) as raised:
            Origin(
                url="https://skills.example.test",
                scope="engineering",
                headers={"Remote-Skills-Scope": "engineering"},
            )
        self.assertEqual(raised.exception.context, {"field": "remote-skills-scope"})


class CatalogVersionTest(unittest.TestCase):
    def test_catalog_history_is_parsed_and_range_selection_is_deterministic(
        self,
    ) -> None:
        body = (
            PROTOCOL_ROOT / "fixtures/catalog/valid-versioned-history.json"
        ).read_bytes()
        snapshot = parse_catalog(body, origin_alias="acme", index_url=INDEX_URL)

        selection = select_catalog_release(
            snapshot, skill_name="code-review", requested_range="1.4.x"
        )

        self.assertEqual(selection.version, "1.4.7")
        self.assertEqual(selection.digest, f"sha256:{'b' * 64}")
        self.assertFalse(selection.is_current)

        current = select_catalog_release(
            snapshot,
            skill_name="code-review",
            requested_range=snapshot.entries[0].version,
        )
        self.assertTrue(current.is_current)
        self.assertEqual(current.digest, snapshot.entries[0].digest)

    def test_unversioned_restrictive_range_is_unavailable(self) -> None:
        body = (PROTOCOL_ROOT / "fixtures/catalog/valid-v0.2.json").read_bytes()
        snapshot = parse_catalog(body, origin_alias="acme", index_url=INDEX_URL)

        with self.assertRaises(Exception) as raised:
            select_catalog_release(
                snapshot, skill_name="code-review", requested_range="1.4.x"
            )

        self.assertEqual(raised.exception.code, "version_unavailable")
        self.assertEqual(
            raised.exception.context,
            {
                "origin_alias": "acme",
                "skill_name": "code-review",
                "requested_range": "1.4.x",
            },
        )

    def test_current_release_requires_the_exact_top_level_url_spelling(self) -> None:
        body = json.dumps(
            {
                "$schema": "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
                "skills": [
                    {
                        "name": "code-review",
                        "description": "Review code.",
                        "type": "archive",
                        "url": "artifact.tar.gz",
                        "digest": f"sha256:{'a' * 64}",
                        "x-remote-skills": {
                            "version": "1.0.0",
                            "releases": [
                                {
                                    "version": "1.0.0",
                                    "type": "archive",
                                    "url": "./artifact.tar.gz",
                                    "digest": f"sha256:{'a' * 64}",
                                }
                            ],
                        },
                    }
                ],
            }
        ).encode()

        with self.assertRaises(Exception) as raised:
            parse_catalog(body, origin_alias="acme", index_url=INDEX_URL)

        self.assertEqual(
            raised.exception.context,
            {
                "origin_alias": "acme",
                "field": "skills[0].x-remote-skills.releases.current",
            },
        )

    def test_current_online_versions_do_not_resurrect_a_cached_match(self) -> None:
        cached_versions = ("1.4.7",)
        self.assertEqual(
            select_catalog_version(
                origin_alias="acme",
                skill_name="code-review",
                advertised_versions=cached_versions,
                requested_range="1.4.x",
            ),
            "1.4.7",
        )

        with self.assertRaises(Exception) as raised:
            select_catalog_version(
                origin_alias="acme",
                skill_name="code-review",
                advertised_versions=("2.0.0", "1.5.1"),
                requested_range="1.4.x",
            )

        self.assertEqual(raised.exception.code, "version_unavailable")
        self.assertEqual(
            raised.exception.context,
            {
                "origin_alias": "acme",
                "skill_name": "code-review",
                "requested_range": "1.4.x",
            },
        )


class ScopedCacheIdentityTest(unittest.TestCase):
    def test_catalog_mutation_digest_is_cross_runtime_domain_separated(self) -> None:
        identifier = origin_identifier(INDEX_URL, confirmed_scope="engineering")
        self.assertEqual(
            catalog_mutation_digest(identifier),
            "sha256:7462c6cf357bb59bc58f0f8aa158cd5eadfa36c671dbcb6b2be4c4976f132514",
        )

    def test_confirmed_scope_is_part_of_catalog_identity_and_metadata(self) -> None:
        identifier = origin_identifier(INDEX_URL, confirmed_scope="engineering")
        self.assertEqual(
            identifier,
            "9dc5c74ba396dc5b65ff423600466f65b6d0a1bfca3eb6866345481f98de17a9",
        )

        now = datetime(2026, 8, 27, tzinfo=timezone.utc)
        catalog = CachedCatalog(
            body=json.dumps({"$schema": "example", "skills": []}).encode(),
            metadata=CatalogMetadata(
                canonical_url=INDEX_URL,
                confirmed_scope="engineering",
                retrieved_at=now,
                validated_at=now,
            ),
        )
        cache = MemoryCache()
        cache.publish_catalog(catalog)

        self.assertEqual(
            cache.get_catalog(INDEX_URL, confirmed_scope="engineering"), catalog
        )
        self.assertIsNone(cache.get_catalog(INDEX_URL, confirmed_scope="sales"))

    def test_catalog_deletion_is_scoped_and_generation_checked(self) -> None:
        with TemporaryDirectory() as temporary:
            caches = (MemoryCache(), DiskCache(Path(temporary)))
            for cache in caches:
                with self.subTest(cache=type(cache).__name__):
                    engineering = cached_catalog(
                        named_catalog("engineering-old"), scope="engineering"
                    )
                    sales = cached_catalog(named_catalog("sales"), scope="sales")
                    cache.publish_catalog(engineering)
                    cache.publish_catalog(sales)
                    engineering_generation = cache.get_catalog_state(
                        INDEX_URL, confirmed_scope="engineering"
                    ).generation

                    self.assertTrue(
                        cache.delete_catalog(
                            INDEX_URL,
                            confirmed_scope="engineering",
                            expected_generation=engineering_generation,
                        )
                    )
                    self.assertIsNone(
                        cache.get_catalog(INDEX_URL, confirmed_scope="engineering")
                    )
                    self.assertEqual(
                        cache.get_catalog(INDEX_URL, confirmed_scope="sales"), sales
                    )

                    newer = cached_catalog(
                        named_catalog("engineering-new"),
                        scope="engineering",
                        timestamp=1_777_000_001.0,
                    )
                    cache.publish_catalog(newer)
                    self.assertFalse(
                        cache.delete_catalog(
                            INDEX_URL,
                            confirmed_scope="engineering",
                            expected_generation=engineering_generation,
                        )
                    )
                    self.assertEqual(
                        cache.get_catalog(INDEX_URL, confirmed_scope="engineering"),
                        newer,
                    )


class CatalogPersistentCacheTest(unittest.IsolatedAsyncioTestCase):
    def assert_catalog_byte_limit(self, error: CatalogError, alias: str) -> None:
        self.assertEqual(error.code, "limit_exceeded")
        self.assertFalse(error.retryable)
        self.assertEqual(
            error.context,
            {"origin_alias": alias, "limit": "catalog_bytes"},
        )

    async def assert_alias_order(
        self,
        discovery: CatalogDiscovery,
        order: tuple[str, str],
        expected_name: str,
    ) -> None:
        for alias in order:
            if alias == "low":
                with self.assertRaises(CatalogError) as raised:
                    await discovery.catalog(alias)
                self.assert_catalog_byte_limit(raised.exception, alias)
            else:
                self.assertEqual(
                    (await discovery.catalog(alias)).entries[0].name,
                    expected_name,
                )

    async def test_alias_local_limit_applies_to_shared_fresh_memory_both_orders(
        self,
    ) -> None:
        body = named_catalog("shared")
        for backend_name in ("memory", "disk"):
            for order in (("high", "low"), ("low", "high")):
                with self.subTest(backend=backend_name, order=order):
                    with TemporaryDirectory() as temporary:
                        cache = (
                            MemoryCache()
                            if backend_name == "memory"
                            else DiskCache(Path(temporary))
                        )
                        transport = SequenceTransport(
                            HttpResponse(
                                200,
                                {
                                    "cache-control": "max-age=300",
                                    "remote-skills-scope": "engineering",
                                },
                                body,
                            ),
                            HttpResponse(
                                200,
                                {
                                    "cache-control": "max-age=300",
                                    "remote-skills-scope": "engineering",
                                },
                                body,
                            ),
                        )
                        discovery = CatalogDiscovery(
                            origins=limited_origins(body),
                            cache=cache,
                            transport=transport,
                            resolver=public_resolver,
                            clock=lambda: 1_777_000_000.0,
                        )

                        await self.assert_alias_order(discovery, order, "shared")
                        self.assertEqual(
                            len(transport.requests),
                            1 if order == ("high", "low") else 2,
                        )

    async def test_alias_local_limit_applies_to_persistent_reload_both_orders(
        self,
    ) -> None:
        body = named_catalog("persistent")
        for backend_name in ("memory", "disk"):
            for order in (("high", "low"), ("low", "high")):
                with self.subTest(backend=backend_name, order=order):
                    with TemporaryDirectory() as temporary:
                        cache = (
                            MemoryCache()
                            if backend_name == "memory"
                            else DiskCache(Path(temporary))
                        )
                        await seed_accepted_catalog(
                            cache,
                            cached_catalog(
                                body,
                                scope="engineering",
                                cache_control="max-age=300",
                            ),
                        )
                        transport = SequenceTransport()
                        discovery = CatalogDiscovery(
                            origins=limited_origins(body),
                            cache=cache,
                            transport=transport,
                            resolver=public_resolver,
                            clock=lambda: 1_777_000_001.0,
                        )

                        await self.assert_alias_order(discovery, order, "persistent")
                        self.assertEqual(transport.requests, [])

    async def test_no_store_200_and_304_delete_real_persistent_generation(
        self,
    ) -> None:
        for response_status in (200, 304):
            for backend_name in ("memory", "disk"):
                with self.subTest(status=response_status, backend=backend_name):
                    with TemporaryDirectory() as temporary:
                        cache = (
                            MemoryCache()
                            if backend_name == "memory"
                            else DiskCache(Path(temporary))
                        )
                        engineering = cached_catalog(
                            named_catalog("engineering-old"), scope="engineering"
                        )
                        sales = cached_catalog(named_catalog("sales"), scope="sales")
                        await seed_accepted_catalog(cache, engineering)
                        cache.publish_catalog(sales)
                        response = HttpResponse(
                            response_status,
                            {
                                "cache-control": "no-store",
                                "remote-skills-scope": "engineering",
                            },
                            named_catalog("replacement")
                            if response_status == 200
                            else b"",
                        )
                        origin = Origin(
                            url="https://skills.example.test", scope="engineering"
                        )
                        discovery = CatalogDiscovery(
                            origins={"acme": origin},
                            cache=cache,
                            transport=SequenceTransport(response),
                            resolver=public_resolver,
                            clock=lambda: 1_777_000_001.0,
                        )

                        await discovery.catalog("acme")

                        self.assertIsNone(
                            cache.get_catalog(
                                INDEX_URL, confirmed_scope="engineering"
                            )
                        )
                        self.assertEqual(
                            cache.get_catalog(INDEX_URL, confirmed_scope="sales"),
                            sales,
                        )
                        reload_transport = SequenceTransport(
                            HttpResponse(
                                200,
                                {"remote-skills-scope": "engineering"},
                                named_catalog("online"),
                            )
                        )
                        reloaded = CatalogDiscovery(
                            origins={"acme": origin},
                            cache=cache,
                            transport=reload_transport,
                            resolver=public_resolver,
                            clock=lambda: 1_777_000_002.0,
                        )
                        snapshot = await reloaded.catalog("acme")
                        self.assertEqual(snapshot.entries[0].name, "online")
                        self.assertEqual(len(reload_transport.requests), 1)

    async def test_two_aliases_share_generation_order_for_publish_and_delete(
        self,
    ) -> None:
        origin = Origin(url="https://skills.example.test", scope="engineering")
        cases = ((200, False), (200, True), (304, True))
        for older_status, older_no_store in cases:
            with self.subTest(status=older_status, no_store=older_no_store):
                cache = MemoryCache()
                if older_status == 304:
                    await seed_accepted_catalog(
                        cache,
                        cached_catalog(named_catalog("seed"), scope="engineering"),
                    )
                transport = DeferredTransport()
                discovery = CatalogDiscovery(
                    origins={"older": origin, "newer": origin},
                    cache=cache,
                    transport=transport,
                    resolver=public_resolver,
                    clock=lambda: 1_777_000_001.0,
                )
                older = asyncio.create_task(discovery.catalog("older"))
                await wait_for_requests(transport, 1)
                newer = asyncio.create_task(discovery.catalog("newer"))
                await wait_for_requests(transport, 2)
                transport.responses[1].set_result(
                    HttpResponse(
                        200,
                        {"remote-skills-scope": "engineering"},
                        named_catalog("newer"),
                    )
                )
                await newer
                older_headers = {"remote-skills-scope": "engineering"}
                if older_no_store:
                    older_headers["cache-control"] = "no-store"
                transport.responses[0].set_result(
                    HttpResponse(
                        older_status,
                        older_headers,
                        named_catalog("older") if older_status == 200 else b"",
                    )
                )
                await older

                stored = cache.get_catalog(
                    INDEX_URL, confirmed_scope="engineering"
                )
                self.assertIsNotNone(stored)
                assert stored is not None
                self.assertEqual(
                    parse_catalog(
                        stored.body, origin_alias="stored", index_url=INDEX_URL
                    ).entries[0].name,
                    "newer",
                )

    async def test_disk_conditional_publish_rejects_cross_instance_stale_writer(
        self,
    ) -> None:
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            first_cache = DiskCache(root)
            second_cache = DiskCache(root)
            first_cache.publish_catalog(
                cached_catalog(named_catalog("seed"), scope="engineering")
            )
            origin = Origin(url="https://skills.example.test", scope="engineering")
            older_transport = DeferredTransport()
            newer_transport = DeferredTransport()
            older_discovery = CatalogDiscovery(
                origins={"acme": origin},
                cache=first_cache,
                transport=older_transport,
                resolver=public_resolver,
                clock=lambda: 1_777_000_001.0,
            )
            newer_discovery = CatalogDiscovery(
                origins={"acme": origin},
                cache=second_cache,
                transport=newer_transport,
                resolver=public_resolver,
                clock=lambda: 1_777_000_001.0,
            )
            older = asyncio.create_task(older_discovery.catalog("acme"))
            newer = asyncio.create_task(newer_discovery.catalog("acme"))
            await wait_for_requests(older_transport, 1)
            await wait_for_requests(newer_transport, 1)
            newer_transport.responses[0].set_result(
                HttpResponse(
                    200,
                    {"remote-skills-scope": "engineering"},
                    named_catalog("newer"),
                )
            )
            await newer
            older_transport.responses[0].set_result(
                HttpResponse(
                    200,
                    {"remote-skills-scope": "engineering"},
                    named_catalog("older"),
                )
            )
            await older

            stored = DiskCache(root).get_catalog(
                INDEX_URL, confirmed_scope="engineering"
            )
            self.assertIsNotNone(stored)
            assert stored is not None
            self.assertEqual(
                parse_catalog(
                    stored.body, origin_alias="stored", index_url=INDEX_URL
                ).entries[0].name,
                "newer",
            )

    async def test_confirmed_scope_publishes_body_and_sanitized_validators(
        self,
    ) -> None:
        cache = MemoryCache()
        transport = SequenceTransport(
            HttpResponse(
                200,
                {
                    "cache-control": "max-age=300",
                    "etag": '"engineering-v1"',
                    "remote-skills-scope": "engineering",
                },
                EMPTY_CATALOG,
            )
        )
        discovery = CatalogDiscovery(
            origins={
                "acme": Origin(
                    url="https://skills.example.test",
                    scope="engineering",
                    headers={"authorization": "runtime-secret"},
                )
            },
            cache=cache,
            transport=transport,
            resolver=public_resolver,
            clock=lambda: 1_777_000_000.0,
        )

        await discovery.catalog("acme")

        cached = cache.get_catalog(INDEX_URL, confirmed_scope="engineering")
        self.assertIsNotNone(cached)
        assert cached is not None
        self.assertEqual(cached.body, EMPTY_CATALOG)
        self.assertEqual(cached.metadata.etag, '"engineering-v1"')
        self.assertEqual(cached.metadata.cache_control, "max-age=300")
        self.assertEqual(cached.metadata.confirmed_scope, "engineering")
        self.assertFalse(hasattr(cached.metadata, "headers"))
        self.assertNotIn(b"runtime-secret", cached.body)

    async def test_persistent_catalog_reloads_body_and_validator_for_304(self) -> None:
        cache = MemoryCache()
        seed_transport = SequenceTransport(
            HttpResponse(
                200,
                {
                    "cache-control": "max-age=0",
                    "etag": '"engineering-v1"',
                    "remote-skills-scope": "engineering",
                },
                EMPTY_CATALOG,
            )
        )
        origin = Origin(url="https://skills.example.test", scope="engineering")
        seed = CatalogDiscovery(
            origins={"acme": origin},
            cache=cache,
            transport=seed_transport,
            resolver=public_resolver,
            clock=lambda: 1_777_000_000.0,
        )
        await seed.catalog("acme")

        verify_transport = SequenceTransport(
            HttpResponse(
                304,
                {"remote-skills-scope": "engineering"},
                b"",
            )
        )
        verify = CatalogDiscovery(
            origins={"acme": origin},
            cache=cache,
            transport=verify_transport,
            resolver=public_resolver,
            clock=lambda: 1_777_000_001.0,
        )

        snapshot = await verify.catalog("acme")

        self.assertEqual(snapshot.entries, ())
        self.assertEqual(
            verify_transport.requests,
            [
                {
                    "accept": "application/json",
                    "if-none-match": '"engineering-v1"',
                    "remote-skills-scope": "engineering",
                }
            ],
        )
        cached = cache.get_catalog(INDEX_URL, confirmed_scope="engineering")
        self.assertIsNotNone(cached)
        assert cached is not None
        self.assertEqual(
            cached.metadata.validated_at,
            datetime.fromtimestamp(1_777_000_001.0, timezone.utc),
        )

    async def test_no_store_and_authenticated_unscoped_never_publish(self) -> None:
        cases = (
            (
                Origin(url="https://skills.example.test", scope="engineering"),
                {
                    "cache-control": "no-store",
                    "remote-skills-scope": "engineering",
                },
                "engineering",
            ),
            (
                Origin(
                    url="https://skills.example.test",
                    headers={"authorization": "runtime-secret"},
                ),
                {"cache-control": "max-age=300"},
                None,
            ),
        )
        for origin, headers, scope in cases:
            with self.subTest(scope=scope):
                cache = MemoryCache()
                discovery = CatalogDiscovery(
                    origins={"acme": origin},
                    cache=cache,
                    transport=SequenceTransport(
                        HttpResponse(200, headers, EMPTY_CATALOG)
                    ),
                    resolver=public_resolver,
                    clock=lambda: 1_777_000_000.0,
                )

                await discovery.catalog("acme")

                self.assertIsNone(cache.get_catalog(INDEX_URL, confirmed_scope=scope))

    async def test_confirmed_scopes_publish_isolated_catalog_generations(self) -> None:
        cache = MemoryCache()
        sales_body = EMPTY_CATALOG + b"\n"
        transport = SequenceTransport(
            HttpResponse(
                200,
                {"remote-skills-scope": "engineering"},
                EMPTY_CATALOG,
            ),
            HttpResponse(
                200,
                {"remote-skills-scope": "sales"},
                sales_body,
            ),
        )
        discovery = CatalogDiscovery(
            origins={
                "engineering": Origin(
                    url="https://skills.example.test", scope="engineering"
                ),
                "sales": Origin(url="https://skills.example.test", scope="sales"),
            },
            cache=cache,
            transport=transport,
            resolver=public_resolver,
            clock=lambda: 1_777_000_000.0,
        )

        engineering = await discovery.catalog("engineering")
        sales = await discovery.catalog("sales")

        self.assertNotEqual(engineering.catalog_identifier, sales.catalog_identifier)
        engineering_cached = cache.get_catalog(INDEX_URL, confirmed_scope="engineering")
        sales_cached = cache.get_catalog(INDEX_URL, confirmed_scope="sales")
        self.assertIsNotNone(engineering_cached)
        self.assertIsNotNone(sales_cached)
        assert engineering_cached is not None and sales_cached is not None
        self.assertEqual(engineering_cached.body, EMPTY_CATALOG)
        self.assertEqual(sales_cached.body, sales_body)


if __name__ == "__main__":
    unittest.main()

import asyncio
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from remote_skills.cache import (
    CacheConfigurationError,
    CacheCorruptError,
    CatalogGeneration,
    CachedCatalog,
    CatalogMetadata,
    DiskCache,
    MemoryCache,
    catalog_absence_generation,
    catalog_generation_state_digest,
)
from remote_skills.cache import disk as disk_module
from remote_skills.catalog_client import CatalogDiscovery
from remote_skills.catalog_errors import CatalogError
from remote_skills.catalog_network import HttpResponse
from remote_skills.catalog_origin import Origin
from remote_skills.catalog_scope import catalog_identifier
from remote_skills.catalog_semver import parse_semver


CATALOG_URL = "https://skills.example.test/.well-known/agent-skills/index.json"
SCOPE = "tenant-a"
NOW = datetime(2026, 8, 27, tzinfo=timezone.utc)
BODY = json.dumps(
    {
        "$schema": "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
        "skills": [],
    },
    separators=(",", ":"),
).encode()


def cached_catalog(*, body: bytes = BODY, scope: str | None = SCOPE) -> CachedCatalog:
    return CachedCatalog(
        body=body,
        metadata=CatalogMetadata(
            canonical_url=CATALOG_URL,
            retrieved_at=NOW,
            validated_at=NOW,
            confirmed_scope=scope,
            etag='"safe"',
            cache_control="max-age=60",
        ),
    )


def named_catalog_body(name: str) -> bytes:
    return json.dumps(
        {
            "$schema": "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
            "skills": [
                {
                    "name": name,
                    "description": name,
                    "type": "skill-md",
                    "url": f"{name}.md",
                    "digest": f"sha256:{'a' * 64}",
                }
            ],
        },
        separators=(",", ":"),
    ).encode()


def assert_aba_rejected(test: unittest.TestCase, cache: MemoryCache | DiskCache) -> None:
    initial = cache.get_catalog_state(CATALOG_URL, confirmed_scope=SCOPE)
    first = cached_catalog()
    test.assertTrue(cache.replace_catalog(first, expected_generation=initial.generation))
    present = cache.get_catalog_state(CATALOG_URL, confirmed_scope=SCOPE)
    test.assertEqual(present.catalog, first)
    test.assertNotEqual(present.generation, initial.generation)
    test.assertTrue(
        cache.delete_catalog(
            CATALOG_URL,
            confirmed_scope=SCOPE,
            expected_generation=present.generation,
        )
    )
    absent_again = cache.get_catalog_state(CATALOG_URL, confirmed_scope=SCOPE)
    test.assertIsNone(absent_again.catalog)
    test.assertNotEqual(absent_again.generation, initial.generation)
    test.assertFalse(
        cache.replace_catalog(first, expected_generation=initial.generation)
    )
    test.assertTrue(
        cache.replace_catalog(first, expected_generation=absent_again.generation)
    )
    present_again = cache.get_catalog_state(CATALOG_URL, confirmed_scope=SCOPE)
    test.assertNotEqual(present_again.generation, present.generation)
    test.assertFalse(
        cache.replace_catalog(first, expected_generation=present.generation)
    )


class ScriptedTransport:
    def __init__(self, response: HttpResponse) -> None:
        self.response = response
        self.requests: list[dict[str, str]] = []

    async def request(
        self,
        url: str,
        headers: dict[str, str],
        timeout: float,
        connect_address: str,
        max_bytes: int,
    ) -> HttpResponse:
        self.requests.append(dict(headers))
        del timeout, connect_address, max_bytes
        return HttpResponse(
            self.response.status,
            self.response.headers,
            self.response.body,
            url=url,
        )


class BarrierTransport(ScriptedTransport):
    def __init__(
        self, response: HttpResponse, arrivals: list[None], release: asyncio.Event
    ) -> None:
        super().__init__(response)
        self.arrivals = arrivals
        self.release = release

    async def request(
        self,
        url: str,
        headers: dict[str, str],
        timeout: float,
        connect_address: str,
        max_bytes: int,
    ) -> HttpResponse:
        self.arrivals.append(None)
        if len(self.arrivals) == 2:
            self.release.set()
        await self.release.wait()
        return await super().request(
            url, headers, timeout, connect_address, max_bytes
        )


class ReplaceAfterSuccessfulCasCache(MemoryCache):
    def __init__(self, replacement: CachedCatalog) -> None:
        super().__init__()
        self.replacement = replacement
        self.replaced = False

    def replace_catalog(
        self,
        catalog: CachedCatalog,
        *,
        expected_generation: CatalogGeneration,
    ) -> bool:
        published = super().replace_catalog(
            catalog, expected_generation=expected_generation
        )
        if published and not self.replaced:
            self.replaced = True
            current = self.get_catalog_state(
                catalog.metadata.canonical_url,
                confirmed_scope=catalog.metadata.confirmed_scope,
            )
            if not super().replace_catalog(
                self.replacement,
                expected_generation=current.generation,
            ):
                raise AssertionError("replacement generation did not publish")
        return published


async def public_resolver(host: str) -> tuple[str, ...]:
    del host
    return ("93.184.216.34",)


class CatalogGenerationQualityTest(unittest.TestCase):
    def test_scope_confirmation_failure_invalidates_fresh_and_stale_reuse(self) -> None:
        async def exercise(
            backend: MemoryCache | DiskCache,
            status: int,
            confirmation: str | None,
            stale_max_age: float | None,
        ) -> None:
            now = NOW.timestamp()
            transport = ScriptedTransport(HttpResponse(
                200,
                {"remote-skills-scope": SCOPE, "cache-control": "max-age=60"},
                named_catalog_body("initial"),
            ))
            discovery = CatalogDiscovery(
                origins={"acme": Origin(
                    url="https://skills.example.test", scope=SCOPE, retries=0,
                )},
                transport=transport, resolver=public_resolver, cache=backend,
                clock=lambda: now,
            )
            pinned = await discovery.catalog("acme")
            transport.response = HttpResponse(
                status,
                {} if confirmation is None else {"remote-skills-scope": confirmation},
                BODY if status == 200 else b"",
            )
            with self.assertRaises(CatalogError) as failed:
                await discovery.catalog("acme", refresh=True)
            self.assertEqual(failed.exception.code, "catalog_invalid")

            if stale_max_age is not None:
                now += 61
            transport.response = HttpResponse(503, {}, b"")
            with self.assertRaises(CatalogError) as unavailable:
                await discovery.catalog("acme", stale_max_age=stale_max_age)
            self.assertEqual(unavailable.exception.code, "origin_unavailable")
            self.assertEqual(len(transport.requests), 3)
            self.assertIsNone(backend.get_catalog(CATALOG_URL, confirmed_scope=SCOPE))
            self.assertEqual(pinned.entries[0].name, "initial")
            self.assertEqual(pinned.confirmed_scope, SCOPE)
            self.assertFalse(pinned.stale)

        for status in (200, 304):
            for confirmation in (None, "tenant-b"):
                for stale_max_age in (None, 120):
                    with self.subTest(
                        status=status, confirmation=confirmation,
                        stale_max_age=stale_max_age,
                    ):
                        asyncio.run(exercise(
                            MemoryCache(), status, confirmation, stale_max_age,
                        ))
                        with tempfile.TemporaryDirectory() as directory:
                            asyncio.run(exercise(
                                DiskCache(Path(directory)), status, confirmation,
                                stale_max_age,
                            ))

    def test_delayed_scope_failure_preserves_newer_accepted_generation(self) -> None:
        async def exercise(backend: MemoryCache | DiskCache, status: int) -> None:
            accepted_headers = {
                "remote-skills-scope": SCOPE, "cache-control": "max-age=60",
            }
            transport = ScriptedTransport(HttpResponse(
                200, accepted_headers, named_catalog_body("initial"),
            ))
            discovery = CatalogDiscovery(
                origins={"acme": Origin(url="https://skills.example.test", scope=SCOPE)},
                transport=transport, resolver=public_resolver, cache=backend,
                clock=lambda: NOW.timestamp(),
            )
            pinned = await discovery.catalog("acme")
            arrived = asyncio.Event()
            release = asyncio.Event()
            original_request = transport.request

            async def delayed_request(
                url: str, headers: dict[str, str], timeout: float,
                connect_address: str, max_bytes: int,
            ) -> HttpResponse:
                response = await original_request(
                    url, headers, timeout, connect_address, max_bytes,
                )
                if "remote-skills-scope" not in response.headers:
                    arrived.set()
                    await release.wait()
                return response

            transport.response = HttpResponse(status, {}, BODY if status == 200 else b"")
            with patch.object(transport, "request", delayed_request):
                failed_refresh = asyncio.create_task(discovery.catalog("acme", refresh=True))
                try:
                    await asyncio.wait_for(arrived.wait(), timeout=5)
                    transport.response = HttpResponse(
                        200, accepted_headers, named_catalog_body("successor"),
                    )
                    successor = await discovery.catalog("acme", refresh=True)
                finally:
                    release.set()
                with self.assertRaises(CatalogError) as failed:
                    await failed_refresh
                self.assertEqual(failed.exception.code, "catalog_invalid")

            current = await discovery.catalog("acme")
            self.assertEqual(current, successor)
            self.assertEqual(current.entries[0].name, "successor")
            self.assertEqual(len(transport.requests), 3)
            persisted = backend.get_catalog(CATALOG_URL, confirmed_scope=SCOPE)
            self.assertIsNotNone(persisted)
            assert persisted is not None
            self.assertEqual(persisted.body, named_catalog_body("successor"))
            self.assertEqual(pinned.entries[0].name, "initial")
            self.assertFalse(pinned.stale)

        for status in (200, 304):
            with self.subTest(status=status):
                asyncio.run(exercise(MemoryCache(), status))
                with tempfile.TemporaryDirectory() as directory:
                    asyncio.run(exercise(DiskCache(Path(directory)), status))

    def test_semver_equal_precedence_values_have_equal_hashes(self) -> None:
        left = parse_semver("1.2.3+one")
        right = parse_semver("1.2.3+two")
        self.assertIsNotNone(left)
        self.assertIsNotNone(right)
        self.assertEqual(left, right)
        self.assertEqual(hash(left), hash(right))
        self.assertEqual(len({left, right}), 1)

    def test_memory_catalog_generation_rejects_present_and_absence_aba(self) -> None:
        assert_aba_rejected(self, MemoryCache())

    def test_disk_catalog_generation_rejects_present_and_absence_aba(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            assert_aba_rejected(self, DiskCache(Path(directory), touch_on_read=False))

    def test_catalog_mutations_reject_malformed_generation_tokens(self) -> None:
        malformed_tokens: tuple[object, ...] = (
            "not-a-generation",
            f"sha256:{'A' * 64}",
            f"sha256:{'a' * 63}",
            f"sha256:{'a' * 64}suffix",
            7,
        )
        with tempfile.TemporaryDirectory() as directory:
            caches = (
                MemoryCache(),
                DiskCache(Path(directory), touch_on_read=False),
            )
            for cache in caches:
                for token in malformed_tokens:
                    generation = CatalogGeneration(token)  # type: ignore[arg-type]
                    for operation in (
                        lambda: cache.replace_catalog(
                            cached_catalog(), expected_generation=generation
                        ),
                        lambda: cache.delete_catalog(
                            CATALOG_URL,
                            confirmed_scope=SCOPE,
                            expected_generation=generation,
                        ),
                    ):
                        with self.subTest(
                            backend=type(cache).__name__, token=token
                        ):
                            with self.assertRaises(
                                CacheConfigurationError
                            ) as raised:
                                operation()
                            self.assertEqual(
                                raised.exception.context,
                                {"field": "catalog_generation"},
                            )

    def test_separate_process_rejects_absence_and_present_aba(self) -> None:
        worker = Path(__file__).with_name("catalog_generation_worker.py")
        source_root = Path(__file__).resolve().parents[1] / "src"
        with tempfile.TemporaryDirectory() as directory:
            cache = DiskCache(Path(directory), touch_on_read=False)
            initial = cache.get_catalog_state(CATALOG_URL, confirmed_scope=SCOPE)
            subprocess.run(
                [
                    sys.executable,
                    str(worker),
                    str(source_root),
                    directory,
                    CATALOG_URL,
                    SCOPE,
                ],
                check=True,
                capture_output=True,
                text=True,
            )
            present = cache.get_catalog_state(CATALOG_URL, confirmed_scope=SCOPE)
            self.assertFalse(
                cache.replace_catalog(
                    cached_catalog(), expected_generation=initial.generation
                )
            )
            subprocess.run(
                [
                    sys.executable,
                    str(worker),
                    str(source_root),
                    directory,
                    CATALOG_URL,
                    SCOPE,
                ],
                check=True,
                capture_output=True,
                text=True,
            )
            self.assertFalse(
                cache.replace_catalog(
                    cached_catalog(), expected_generation=present.generation
                )
            )

    def test_disk_generation_layout_and_derivations_are_exact(self) -> None:
        identifier = catalog_identifier(CATALOG_URL, SCOPE)
        expected_absence = "sha256:" + hashlib.sha256(
            f"remote-skills-catalog-absence-v1\n{identifier}\n17\n".encode()
        ).hexdigest()
        expected_state_digest = (
            "sha256:52f171c6c5d96edd9ec677a3dbb30b1b5aa0ac1fc93e9007b33f6afd4a3c9f59"
        )
        self.assertEqual(
            catalog_absence_generation(identifier, 17),
            CatalogGeneration(expected_absence),
        )
        self.assertEqual(catalog_generation_state_digest(), expected_state_digest)

        with tempfile.TemporaryDirectory() as directory:
            cache = DiskCache(Path(directory), touch_on_read=False)
            cache.publish_catalog(cached_catalog())
            catalog_path = cache.catalog_path(CATALOG_URL, confirmed_scope=SCOPE)
            self.assertEqual(
                {path.name for path in catalog_path.iterdir()},
                {"body.json", "metadata.json", "generation.json"},
            )
            generation = json.loads(
                (catalog_path / "generation.json").read_text(encoding="utf-8")
            )
            self.assertEqual(
                generation,
                {
                    "schema": "remote-skills-catalog-generation-v1",
                    "catalog_identifier": identifier,
                    "generation": cache.get_catalog_state(
                        CATALOG_URL, confirmed_scope=SCOPE
                    ).generation.token,
                    "state": "present",
                },
            )
            state_path = (
                Path(directory)
                / "cache-v1/tmp/catalog-generations-v1/state.json"
            )
            self.assertEqual(
                json.loads(state_path.read_text(encoding="utf-8")),
                {
                    "schema": "remote-skills-catalog-generation-state-v1",
                    "generation": 1,
                },
            )

    def test_disk_generation_state_fails_closed_at_safe_integer_exhaustion(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            state_directory = (
                Path(directory) / "cache-v1/tmp/catalog-generations-v1"
            )
            state_directory.mkdir(parents=True)
            (state_directory / "state.json").write_text(
                json.dumps(
                    {
                        "schema": "remote-skills-catalog-generation-state-v1",
                        "generation": 2**53 - 1,
                    },
                    indent=2,
                )
                + "\n",
                encoding="utf-8",
            )
            cache = DiskCache(Path(directory), touch_on_read=False)
            with self.assertRaises(CacheCorruptError):
                cache.publish_catalog(cached_catalog())

    def test_cross_identity_mutations_share_one_serial_epoch(self) -> None:
        second_url = "https://other.example.test/.well-known/agent-skills/index.json"
        second = CachedCatalog(
            body=BODY,
            metadata=CatalogMetadata(
                canonical_url=second_url,
                retrieved_at=NOW,
                validated_at=NOW,
                confirmed_scope=SCOPE,
            ),
        )
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            first_cache = DiskCache(root, touch_on_read=False)
            second_cache = DiskCache(root, touch_on_read=False)
            with ThreadPoolExecutor(max_workers=2) as executor:
                outcomes = tuple(
                    executor.map(
                        lambda operation: operation(),
                        (
                            lambda: first_cache.publish_catalog(cached_catalog()),
                            lambda: second_cache.publish_catalog(second),
                        ),
                    )
                )
            self.assertEqual(outcomes, (cached_catalog(), second))
            state = json.loads(
                (
                    root
                    / "cache-v1/tmp/catalog-generations-v1/state.json"
                ).read_text(encoding="utf-8")
            )
            self.assertEqual(state["generation"], 2)

    def test_failed_delete_advances_tombstone_before_removing_present_state(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            cache = DiskCache(Path(directory), touch_on_read=False)
            cache.publish_catalog(cached_catalog())
            before = cache.get_catalog_state(CATALOG_URL, confirmed_scope=SCOPE)
            with patch.object(
                disk_module,
                "_remove_tree_at",
                side_effect=OSError("injected delete failure"),
            ):
                with self.assertRaises(CacheCorruptError):
                    cache.delete_catalog(
                        CATALOG_URL,
                        confirmed_scope=SCOPE,
                        expected_generation=before.generation,
                    )
            after = cache.get_catalog_state(CATALOG_URL, confirmed_scope=SCOPE)
            self.assertEqual(after.catalog, before.catalog)
            self.assertEqual(after.generation, before.generation)
            self.assertTrue(
                cache.delete_catalog(
                    CATALOG_URL,
                    confirmed_scope=SCOPE,
                    expected_generation=before.generation,
                )
            )

    def test_missing_or_malformed_present_generation_fails_closed(self) -> None:
        for content in (None, b"{}"):
            with self.subTest(content=content):
                with tempfile.TemporaryDirectory() as directory:
                    cache = DiskCache(Path(directory), touch_on_read=False)
                    cache.publish_catalog(cached_catalog())
                    generation_path = cache.catalog_path(
                        CATALOG_URL, confirmed_scope=SCOPE
                    ) / "generation.json"
                    generation_path.unlink()
                    if content is not None:
                        generation_path.write_bytes(content)
                    with self.assertRaises(CacheCorruptError):
                        cache.get_catalog_state(CATALOG_URL, confirmed_scope=SCOPE)

    def test_missing_singleton_epoch_cannot_reset_absence_generation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            cache = DiskCache(Path(directory), touch_on_read=False)
            cache.publish_catalog(cached_catalog())
            present = cache.get_catalog_state(CATALOG_URL, confirmed_scope=SCOPE)
            self.assertTrue(
                cache.delete_catalog(
                    CATALOG_URL,
                    confirmed_scope=SCOPE,
                    expected_generation=present.generation,
                )
            )
            state = (
                Path(directory)
                / "cache-v1/tmp/catalog-generations-v1/state.json"
            )
            state.unlink()
            state.parent.rmdir()
            with self.assertRaises(CacheCorruptError):
                cache.get_catalog_state(CATALOG_URL, confirmed_scope=SCOPE)

    def test_eviction_changes_generation_and_rejects_pre_eviction_token(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            cache = DiskCache(Path(directory), touch_on_read=False)
            cache.publish_catalog(cached_catalog())
            before = cache.get_catalog_state(CATALOG_URL, confirmed_scope=SCOPE)
            cache.evict(max_bytes=0, max_age_seconds=0)
            after = cache.get_catalog_state(CATALOG_URL, confirmed_scope=SCOPE)
            self.assertIsNone(after.catalog)
            self.assertNotEqual(after.generation, before.generation)
            self.assertFalse(
                cache.replace_catalog(
                    cached_catalog(), expected_generation=before.generation
                )
            )

    def test_stale_catalog_cleanup_uses_identity_gate_and_preserves_epoch(self) -> None:
        identifier = catalog_identifier(CATALOG_URL, SCOPE)
        with tempfile.TemporaryDirectory() as directory:
            cache = DiskCache(Path(directory), touch_on_read=False)
            cache.publish_catalog(cached_catalog())
            temporary_root = Path(directory) / "cache-v1/tmp"
            stale = temporary_root / f"catalog-python-{identifier}-{'a' * 32}"
            stale.mkdir()
            (stale / "partial").write_bytes(b"partial")
            os.utime(stale, (0, 0))
            malformed = temporary_root / "catalog-python-invalid-deadbeef"
            malformed.mkdir()
            os.utime(malformed, (0, 0))
            seen: list[str] = []
            original_guard = cache._catalog_mutation_guard_identifier

            @contextmanager
            def recording_guard(selected_identifier: str):
                seen.append(selected_identifier)
                with original_guard(selected_identifier):
                    yield

            with patch.object(
                cache,
                "_catalog_mutation_guard_identifier",
                recording_guard,
            ):
                removed = cache.cleanup_stale_temporaries(max_age_seconds=0)
            self.assertEqual(removed, 1)
            self.assertEqual(seen, [identifier])
            self.assertFalse(stale.exists())
            self.assertTrue(malformed.exists())
            self.assertTrue(
                (
                    temporary_root
                    / "catalog-generations-v1/state.json"
                ).is_file()
            )

    def test_stale_typescript_catalog_stage_uses_exact_identity_gate(self) -> None:
        identifier = catalog_identifier(CATALOG_URL, SCOPE)
        with tempfile.TemporaryDirectory() as directory:
            cache = DiskCache(Path(directory), touch_on_read=False)
            cache.publish_catalog(cached_catalog())
            temporary_root = Path(directory) / "cache-v1/tmp"
            stale = temporary_root / (
                f"catalog-{identifier}-123e4567-e89b-42d3-a456-426614174000"
            )
            stale.mkdir()
            (stale / "partial").write_bytes(b"partial")
            os.utime(stale, (0, 0))
            malformed = temporary_root / f"catalog-{identifier}-not-a-uuid"
            malformed.mkdir()
            os.utime(malformed, (0, 0))
            seen: list[str] = []
            original_guard = cache._catalog_mutation_guard_identifier

            @contextmanager
            def recording_guard(selected_identifier: str):
                seen.append(selected_identifier)
                with original_guard(selected_identifier):
                    yield

            with patch.object(
                cache,
                "_catalog_mutation_guard_identifier",
                recording_guard,
            ):
                removed = cache.cleanup_stale_temporaries(max_age_seconds=0)
            self.assertEqual(removed, 1)
            self.assertEqual(seen, [identifier])
            self.assertFalse(stale.exists())
            self.assertTrue(malformed.exists())

    def test_cleanup_recovers_and_removes_typescript_previous_generations(
        self,
    ) -> None:
        identifier = catalog_identifier(CATALOG_URL, SCOPE)
        with tempfile.TemporaryDirectory() as directory:
            cache = DiskCache(Path(directory), touch_on_read=False)
            current = cache.catalog_path(CATALOG_URL, confirmed_scope=SCOPE)
            previous_parent = (
                Path(directory)
                / "cache-v1/tmp/catalog-generations-v1"
                / identifier
            )
            previous = previous_parent / "previous"
            cache.publish_catalog(cached_catalog())
            previous_parent.mkdir()
            current.rename(previous)

            seen: list[str] = []
            original_guard = cache._catalog_mutation_guard_identifier

            @contextmanager
            def recording_guard(selected_identifier: str):
                seen.append(selected_identifier)
                with original_guard(selected_identifier):
                    yield

            with patch.object(
                cache,
                "_catalog_mutation_guard_identifier",
                recording_guard,
            ):
                self.assertEqual(
                    cache.cleanup_stale_temporaries(max_age_seconds=10**9), 0
                )
            self.assertEqual(seen, [identifier])
            self.assertEqual(
                cache.get_catalog(CATALOG_URL, confirmed_scope=SCOPE),
                cached_catalog(),
            )
            self.assertTrue(current.is_dir())
            self.assertFalse(previous_parent.exists())

            previous_parent.mkdir()
            current.rename(previous)
            cache.publish_catalog(cached_catalog(body=named_catalog_body("current")))
            seen.clear()
            with patch.object(
                cache,
                "_catalog_mutation_guard_identifier",
                recording_guard,
            ):
                self.assertEqual(
                    cache.cleanup_stale_temporaries(max_age_seconds=10**9), 0
                )
            self.assertEqual(seen, [identifier])
            self.assertEqual(
                cache.get_catalog(CATALOG_URL, confirmed_scope=SCOPE).body,
                named_catalog_body("current"),
            )
            self.assertFalse(previous_parent.exists())

    def test_catalog_reads_restore_typescript_previous_generation_before_absence(
        self,
    ) -> None:
        identifier = catalog_identifier(CATALOG_URL, SCOPE)
        with tempfile.TemporaryDirectory() as directory:
            cache = DiskCache(Path(directory), touch_on_read=False)
            current = cache.catalog_path(CATALOG_URL, confirmed_scope=SCOPE)
            previous_parent = (
                Path(directory)
                / "cache-v1/tmp/catalog-generations-v1"
                / identifier
            )
            previous = previous_parent / "previous"
            expected = cached_catalog()
            cache.publish_catalog(expected)

            seen: list[str] = []
            original_guard = cache._catalog_mutation_guard_identifier

            @contextmanager
            def recording_guard(selected_identifier: str):
                seen.append(selected_identifier)
                with original_guard(selected_identifier):
                    yield

            previous_parent.mkdir()
            current.rename(previous)
            with patch.object(
                cache,
                "_catalog_mutation_guard_identifier",
                recording_guard,
            ):
                restored = cache.get_catalog(CATALOG_URL, confirmed_scope=SCOPE)
            self.assertEqual(restored, expected)
            self.assertEqual(restored.metadata.etag, '"safe"')
            self.assertEqual(restored.metadata.cache_control, "max-age=60")
            self.assertEqual(seen, [identifier])
            self.assertTrue(current.is_dir())
            self.assertFalse(previous_parent.exists())

            previous_parent.mkdir()
            current.rename(previous)
            seen.clear()
            with patch.object(
                cache,
                "_catalog_mutation_guard_identifier",
                recording_guard,
            ):
                restored_state = cache.get_catalog_state(
                    CATALOG_URL, confirmed_scope=SCOPE
                )
            self.assertEqual(restored_state.catalog, expected)
            self.assertEqual(seen, [identifier])
            self.assertTrue(current.is_dir())
            self.assertFalse(previous_parent.exists())

    def test_catalog_read_rechecks_current_after_initial_miss_before_guard(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            cache = DiskCache(Path(directory), touch_on_read=False)
            expected = cached_catalog()
            original_read = cache._read_catalog
            calls = 0

            def publish_after_miss(*args, **kwargs):
                nonlocal calls
                calls += 1
                if calls == 1:
                    cache.publish_catalog(expected)
                    return None
                return original_read(*args, **kwargs)

            with patch.object(cache, "_read_catalog", publish_after_miss):
                observed = cache.get_catalog(CATALOG_URL, confirmed_scope=SCOPE)
            self.assertEqual(observed, expected)
            self.assertEqual(calls, 2)

    def test_catalog_read_rechecks_current_after_transient_present_miss(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            cache = DiskCache(Path(directory), touch_on_read=False)
            cache.publish_catalog(cached_catalog(body=named_catalog_body("initial")))
            expected = cached_catalog(body=named_catalog_body("successor"))
            original_read = cache._read_catalog
            calls = 0

            def publish_successor_after_miss(*args, **kwargs):
                nonlocal calls
                calls += 1
                if calls == 1:
                    cache.publish_catalog(expected)
                    return None
                return original_read(*args, **kwargs)

            with patch.object(cache, "_read_catalog", publish_successor_after_miss):
                observed = cache.get_catalog(CATALOG_URL, confirmed_scope=SCOPE)
            self.assertEqual(observed, expected)
            self.assertEqual(calls, 2)

    def test_configured_sensitive_values_are_removed_from_persistent_metadata(self) -> None:
        secret = "runtime-secret-value"
        credential = f"Bearer {secret}"
        origin = Origin(
            url="https://skills.example.test",
            scope=SCOPE,
            headers={"authorization": credential},
        )
        response = HttpResponse(
            200,
            {
                "remote-skills-scope": SCOPE,
                "etag": f'"{credential}"',
                "last-modified": f"Wed, 27 Aug 2026 00:00:00 GMT {credential}",
                "cache-control": f"max-age=60, extension={credential}",
            },
            BODY,
            url=origin.catalog_url,
        )
        def assert_backend(backend: MemoryCache | DiskCache) -> None:
            discovery = CatalogDiscovery(
                origins={"acme": origin},
                transport=ScriptedTransport(response),
                resolver=public_resolver,
                cache=backend,
            )
            asyncio.run(discovery.catalog("acme"))
            persisted = backend.get_catalog(CATALOG_URL, confirmed_scope=SCOPE)
            self.assertIsNotNone(persisted)
            metadata = persisted.metadata
            self.assertIsNone(metadata.etag)
            self.assertIsNone(metadata.last_modified)
            self.assertIsNone(metadata.cache_control)

        assert_backend(MemoryCache())
        with tempfile.TemporaryDirectory() as directory:
            disk = DiskCache(Path(directory), touch_on_read=False)
            assert_backend(disk)
            metadata_path = disk.catalog_path(
                CATALOG_URL, confirmed_scope=SCOPE
            ) / "metadata.json"
            self.assertNotIn(credential.encode(), metadata_path.read_bytes())

    def test_catalog_discovery_cas_loser_returns_own_nonpersistent_snapshot(
        self,
    ) -> None:
        async def race() -> tuple[tuple[str, bool], tuple[str, bool], str]:
            origin = Origin(url="https://skills.example.test", scope=SCOPE)
            arrivals: list[None] = []
            release = asyncio.Event()
            with tempfile.TemporaryDirectory() as directory:
                cache_root = Path(directory)
                discoveries = tuple(
                    CatalogDiscovery(
                        origins={"acme": origin},
                        transport=BarrierTransport(
                            HttpResponse(
                                200,
                                {
                                    "remote-skills-scope": SCOPE,
                                    "cache-control": "max-age=60",
                                },
                                named_catalog_body(name),
                                url=origin.catalog_url,
                            ),
                            arrivals,
                            release,
                        ),
                        resolver=public_resolver,
                        cache=DiskCache(cache_root, touch_on_read=False),
                    )
                    for name in ("first", "second")
                )
                results = await asyncio.gather(
                    *(discovery.catalog("acme") for discovery in discoveries)
                )
                persisted = DiskCache(
                    cache_root, touch_on_read=False
                ).get_catalog_state(CATALOG_URL, confirmed_scope=SCOPE)
                self.assertIsNotNone(persisted.catalog)
                persisted_name = json.loads(persisted.catalog.body)["skills"][0]["name"]
                return (
                    (results[0].entries[0].name, results[0].persistent),
                    (results[1].entries[0].name, results[1].persistent),
                    persisted_name,
                )

        first, second, persisted = asyncio.run(race())
        self.assertEqual({first[0], second[0]}, {"first", "second"})
        self.assertEqual(sum((first[1], second[1])), 1)
        self.assertIn(persisted, {first[0], second[0]})
        loser = first if not first[1] else second
        self.assertNotEqual(loser[0], persisted)

    def test_successful_cas_does_not_adopt_later_equal_body_generation(self) -> None:
        origin = Origin(url="https://skills.example.test", scope=SCOPE)
        replacement = CachedCatalog(
            body=BODY,
            metadata=CatalogMetadata(
                canonical_url=origin.catalog_url,
                retrieved_at=NOW,
                validated_at=NOW,
                confirmed_scope=SCOPE,
                etag='"later"',
                cache_control="max-age=60",
            ),
        )
        backend = ReplaceAfterSuccessfulCasCache(replacement)
        discovery = CatalogDiscovery(
            origins={"acme": origin},
            transport=ScriptedTransport(
                HttpResponse(
                    200,
                    {
                        "remote-skills-scope": SCOPE,
                        "etag": '"network"',
                        "cache-control": "max-age=60",
                    },
                    BODY,
                    url=origin.catalog_url,
                )
            ),
            resolver=public_resolver,
            cache=backend,
        )

        result = asyncio.run(discovery.catalog("acme"))

        self.assertTrue(result.persistent)
        internal = next(iter(discovery._cache.values()))
        self.assertEqual(internal.etag, '"later"')
        self.assertEqual(
            internal.persistent_generation,
            backend.get_catalog_state(
                CATALOG_URL, confirmed_scope=SCOPE
            ).generation,
        )

    def test_accepted_freshness_is_preserved_only_for_the_same_backend_generation(
        self,
    ) -> None:
        async def exercise(
            backend: MemoryCache | DiskCache, headers: dict[str, str]
        ) -> None:
            now = NOW.timestamp()
            transport = ScriptedTransport(HttpResponse(200, headers, BODY))
            origin = Origin(url="https://skills.example.test")

            def discovery(cache: MemoryCache | DiskCache) -> CatalogDiscovery:
                return CatalogDiscovery(
                    origins={"acme": origin}, cache=cache,
                    transport=transport, resolver=public_resolver, clock=lambda: now,
                )

            await discovery(backend).catalog("acme")
            now += 5
            await discovery(backend).catalog("acme")
            self.assertEqual(len(transport.requests), 1)
            now += 6
            await discovery(backend).catalog("acme")
            self.assertEqual(len(transport.requests), 2)
            stored = backend.get_catalog(CATALOG_URL)
            self.assertIsNotNone(stored)
            assert stored is not None
            replacement = CachedCatalog(
                body=BODY,
                metadata=CatalogMetadata(
                    canonical_url=CATALOG_URL,
                    retrieved_at=stored.metadata.retrieved_at,
                    validated_at=stored.metadata.validated_at,
                    etag='"replacement"',
                    cache_control="max-age=60",
                ),
            )
            backend.publish_catalog(replacement)
            await discovery(backend).catalog("acme")
            self.assertEqual(len(transport.requests), 3)
            self.assertEqual(transport.requests[-1]["if-none-match"], '"replacement"')
            if isinstance(backend, DiskCache):
                restarted: MemoryCache | DiskCache = DiskCache(backend.root)
            else:
                restarted = MemoryCache()
                restarted.publish_catalog(replacement)
            await discovery(restarted).catalog("acme")
            self.assertEqual(len(transport.requests), 4)

        for headers in (
            {"cache-control": "max-age=60", "age": "50"},
            {
                "date": "Thu, 27 Aug 2026 00:00:00 GMT",
                "expires": "Thu, 27 Aug 2026 00:01:00 GMT",
                "age": "50",
            },
        ):
            with self.subTest(headers=headers):
                asyncio.run(exercise(MemoryCache(), headers))
                with tempfile.TemporaryDirectory() as directory:
                    asyncio.run(exercise(DiskCache(Path(directory)), headers))

    def test_cold_catalog_reuse_requires_independent_resolution_evidence(self) -> None:
        async def exercise(backend: MemoryCache | DiskCache, absolute: bool) -> None:
            body = named_catalog_body("review")
            if absolute:
                body = body.replace(
                    b'"review.md"', b'"https://skills.example.test/artifacts/review.md"'
                )
            backend.publish_catalog(cached_catalog(body=body))
            transport = ScriptedTransport(HttpResponse(
                304 if absolute else 200,
                {"remote-skills-scope": SCOPE},
                b"" if absolute else body,
            ))
            discovery = CatalogDiscovery(
                origins={"acme": Origin(url="https://skills.example.test", scope=SCOPE)},
                cache=backend, transport=transport, resolver=public_resolver,
                clock=lambda: NOW.timestamp() + 1,
            )
            snapshot = await discovery.catalog("acme")
            self.assertEqual(len(transport.requests), 1)
            self.assertEqual(
                transport.requests[0].get("if-none-match"), '"safe"' if absolute else None
            )
            self.assertEqual(snapshot.entries[0].url,
                "https://skills.example.test/artifacts/review.md" if absolute
                else "https://skills.example.test/.well-known/agent-skills/review.md")

        for absolute in (False, True):
            with self.subTest(absolute=absolute):
                asyncio.run(exercise(MemoryCache(), absolute))
                with tempfile.TemporaryDirectory() as directory:
                    asyncio.run(exercise(DiskCache(Path(directory)), absolute))


if __name__ == "__main__":
    unittest.main()

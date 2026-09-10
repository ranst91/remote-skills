from __future__ import annotations

import asyncio
from collections.abc import Callable
from datetime import datetime, timezone
import hashlib
import json
import time
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.parse import urlsplit

from remote_skills import (
    AggregateCatalogError,
    Origin,
    RemoteSkills,
    StaleCatalog,
)
from remote_skills.cache import CacheBackend, CacheLease, MemoryCache
from remote_skills.cache import DiskCache
from remote_skills.cache.errors import CacheCorruptError
from remote_skills.activation import ActivationLimits
from remote_skills.catalog_errors import CatalogError
from remote_skills.catalog_network import HttpResponse


PUBLIC_ADDRESS = "93.184.216.34"


async def public_resolver(_host: str) -> tuple[str, ...]:
    return (PUBLIC_ADDRESS,)


def skill_markdown(name: str, description: str, instructions: str) -> bytes:
    return (
        f"---\nname: {name}\ndescription: {description}\n---\n{instructions}"
    ).encode()


def catalog_body(name: str, description: str, artifact: bytes) -> bytes:
    digest = hashlib.sha256(artifact).hexdigest()
    return json.dumps(
        {
            "$schema": "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
            "skills": [
                {
                    "name": name,
                    "description": description,
                    "type": "skill-md",
                    "url": f"artifacts/sha256-{digest}.md",
                    "digest": f"sha256:{digest}",
                }
            ],
        },
        separators=(",", ":"),
    ).encode()


def versioned_catalog_body(
    name: str,
    description: str,
    releases: tuple[tuple[str, bytes], ...],
) -> bytes:
    descriptors = []
    for version, artifact in releases:
        digest = hashlib.sha256(artifact).hexdigest()
        descriptors.append(
            {
                "version": version,
                "type": "skill-md",
                "url": f"artifacts/sha256-{digest}.md",
                "digest": f"sha256:{digest}",
            }
        )
    current = descriptors[0]
    return json.dumps(
        {
            "$schema": "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
            "skills": [
                {
                    "name": name,
                    "description": description,
                    "type": current["type"],
                    "url": current["url"],
                    "digest": current["digest"],
                    "x-remote-skills": {
                        "version": current["version"],
                        "releases": descriptors,
                    },
                }
            ],
        },
        separators=(",", ":"),
    ).encode()


class ScriptedOrigin:
    def __init__(self, body: bytes, artifact: bytes) -> None:
        self.body = body
        self.artifacts = {
            hashlib.sha256(artifact).hexdigest(): artifact,
        }
        self.requests: list[str] = []
        self.online = True

    async def request(
        self,
        url: str,
        headers: dict[str, str],
        timeout: float,
        connect_address: str,
        max_bytes: int,
    ) -> HttpResponse:
        del headers, timeout, connect_address, max_bytes
        self.requests.append(url)
        if not self.online:
            raise OSError("fixture origin is offline")
        if url.endswith("/.well-known/agent-skills/index.json"):
            return HttpResponse(200, {"cache-control": "max-age=0"}, self.body)
        digest = url.rsplit("sha256-", 1)[-1].removesuffix(".md")
        return HttpResponse(
            200, {"content-type": "text/markdown"}, self.artifacts[digest]
        )

    def publish(self, body: bytes, artifact: bytes) -> None:
        self.body = body
        self.artifacts[hashlib.sha256(artifact).hexdigest()] = artifact

    def add_artifacts(self, *artifacts: bytes) -> None:
        for artifact in artifacts:
            self.artifacts[hashlib.sha256(artifact).hexdigest()] = artifact


class ReleaseCountingMemoryCache(MemoryCache):
    def __init__(self) -> None:
        super().__init__()
        self.release_count = 0

    def release_lease(self, lease: CacheLease) -> None:
        self.release_count += 1
        super().release_lease(lease)


def make_client(
    origin: ScriptedOrigin,
    *,
    cache: CacheBackend | None = None,
    clock: Callable[[], float] | None = None,
) -> RemoteSkills:
    return RemoteSkills(
        origins={"acme": Origin(url="https://skills.example.test", retries=0)},
        cache=cache if cache is not None else MemoryCache(),
        transport=origin,
        resolver=public_resolver,
        clock=clock if clock is not None else time.time,
    )


class MutableClock:
    def __init__(self, value: float) -> None:
        self.value = value

    def __call__(self) -> float:
        return self.value


class RenewalObservingDiskCache(DiskCache):
    def __init__(self, directory: str, clock: MutableClock) -> None:
        super().__init__(
            directory,
            clock=lambda: datetime.fromtimestamp(clock(), timezone.utc),
            lease_expiry_seconds=1,
        )
        self.renewed = threading.Event()
        self.renewals: list[CacheLease] = []
        self.releases: list[CacheLease] = []
        self.renewal_threads: set[threading.Thread] = set()

    def renew_lease(self, lease: CacheLease) -> CacheLease:
        renewed = super().renew_lease(lease)
        self.renewals.append(renewed)
        self.renewal_threads.add(threading.current_thread())
        self.renewed.set()
        return renewed

    def release_lease(self, lease: CacheLease) -> None:
        super().release_lease(lease)
        self.releases.append(lease)


class RemoteSkillsSessionTests(unittest.IsolatedAsyncioTestCase):
    async def test_active_disk_lease_renews_and_close_releases_latest_generation(self) -> None:
        artifact = skill_markdown("code-review", "Review safely.", "# Review\n")
        origin = ScriptedOrigin(
            catalog_body("code-review", "Review safely.", artifact), artifact
        )
        clock = MutableClock(time.time())
        with tempfile.TemporaryDirectory() as directory:
            cache = RenewalObservingDiskCache(directory, clock)
            session = await make_client(origin, cache=cache).session("acme")
            try:
                skill = await session.activate("code-review")
                initial = skill._lease
                self.assertIsNotNone(initial)
                clock.value += 3
                self.assertTrue(await asyncio.to_thread(cache.renewed.wait, 3))
                renewed = cache.renewals[-1]
                self.assertGreater(renewed.renewed_at, initial.renewed_at)
                registration = json.loads(cache._process_path(
                    renewed.digest, renewed.pid, renewed.process_nonce
                ).read_text())
                self.assertGreater(
                    datetime.fromisoformat(registration["renewed_at"]),
                    initial.renewed_at,
                )
                with patch.object(cache, "_process_identity", return_value=None):
                    self.assertTrue(
                        cache._registered_process_is_alive(
                            renewed.pid, renewed.process_nonce, renewed.digest
                        )
                    )
                self.assertEqual(cache.cleanup_stale_leases(lease_expiry_seconds=1), 0)
                self.assertTrue(cache.has_live_lease(skill.digest, lease_expiry_seconds=1))
                self.assertEqual(
                    cache.evict(max_bytes=0, max_age_seconds=0).removed_digests, ()
                )
            finally:
                await session.close()
            self.assertEqual(cache.releases, [cache.renewals[-1]])
            self.assertFalse(cache.has_live_lease(skill.digest))
            self.assertTrue(all(not thread.is_alive() for thread in cache.renewal_threads))
            self.assertEqual(
                cache.evict(max_bytes=0, max_age_seconds=0).removed_digests,
                (skill.digest,),
            )

    async def test_activation_failure_stops_renewal_and_releases_latest_generation(self) -> None:
        artifact = skill_markdown("code-review", "Review safely.", "# Review\n")
        origin = ScriptedOrigin(
            catalog_body("code-review", "Review safely.", artifact), artifact
        )
        clock = MutableClock(time.time())
        with tempfile.TemporaryDirectory() as directory:
            cache = RenewalObservingDiskCache(directory, clock)
            session = await make_client(origin, cache=cache).session("acme")

            async def unavailable(*args, **kwargs):
                del args, kwargs
                clock.value += 3
                self.assertTrue(await asyncio.to_thread(cache.renewed.wait, 3))
                raise OSError("fixture origin is offline")

            try:
                with patch.object(origin, "request", side_effect=unavailable):
                    with self.assertRaises(CatalogError):
                        await session.activate("code-review")
            finally:
                await session.close()
            self.assertTrue(cache.renewals)
            self.assertEqual(cache.releases, [cache.renewals[-1]])
            self.assertFalse(cache.has_live_lease(cache.releases[0].digest))
            self.assertTrue(all(not thread.is_alive() for thread in cache.renewal_threads))

    async def test_disk_renewal_failure_stops_worker_and_close_releases_pin(self) -> None:
        artifact = skill_markdown("code-review", "Review safely.", "# Review\n")
        origin = ScriptedOrigin(
            catalog_body("code-review", "Review safely.", artifact), artifact
        )
        with tempfile.TemporaryDirectory() as directory:
            cache = RenewalObservingDiskCache(directory, MutableClock(time.time()))
            session = await make_client(origin, cache=cache).session("acme")
            skill = await session.activate("code-review")
            heartbeat = skill._active_lease.heartbeat
            try:
                with patch.object(cache, "renew_lease", side_effect=CacheCorruptError(skill.digest)):
                    self.assertTrue(await asyncio.to_thread(heartbeat.stop.wait, 3))
            finally:
                with self.assertRaises(CacheCorruptError):
                    await session.close()
            self.assertFalse(heartbeat.thread.is_alive())
            self.assertEqual(cache.releases, [skill._lease])
            self.assertFalse(cache.has_live_lease(skill.digest))
            await session.close()
            self.assertEqual(cache.releases, [skill._lease])
            self.assertEqual(session._activation_tasks, {})

    async def test_close_releases_every_skill_and_retries_only_failed_releases(self) -> None:
        names = ("code-review", "release-notes", "test-guide")
        artifacts = [skill_markdown(name, "Useful guidance.", "# Guide\n") for name in names]
        body = json.loads(catalog_body(names[0], "Useful guidance.", artifacts[0]))
        body["skills"] = [
            json.loads(catalog_body(name, "Useful guidance.", artifact))["skills"][0]
            for name, artifact in zip(names, artifacts)
        ]
        origin = ScriptedOrigin(json.dumps(body).encode(), artifacts[0])
        origin.add_artifacts(*artifacts[1:])
        cache = ReleaseCountingMemoryCache()
        session = await make_client(origin, cache=cache).session("acme")
        skills = [await session.activate(name) for name in names]
        attempts: list[CacheLease] = []
        release = cache.release_lease

        def fail_first(lease: CacheLease) -> None:
            attempts.append(lease)
            if lease.digest == skills[0].digest:
                raise OSError("fixture release detail must stay private")
            release(lease)

        try:
            with patch.object(cache, "release_lease", side_effect=fail_first):
                with self.assertRaises(CacheCorruptError) as raised:
                    await asyncio.wait_for(session.close(), 3)
                self.assertEqual(str(raised.exception), "cache state is corrupt")
                self.assertIsNone(raised.exception.__context__)
                self.assertEqual(attempts, [skill._lease for skill in skills])
                self.assertEqual(cache.release_count, 2)
                self.assertEqual(list(session._activation_tasks), [names[0]])
                self.assertEqual(
                    [cache.has_live_lease(skill.digest) for skill in skills],
                    [True, False, False],
                )
                with self.assertRaises(CacheCorruptError):
                    await asyncio.wait_for(session.close(), 3)
                self.assertEqual(attempts, [skill._lease for skill in skills] + [skills[0]._lease])
                self.assertEqual(cache.release_count, 2)

            await asyncio.wait_for(asyncio.gather(session.close(), session.close()), 3)
            await asyncio.wait_for(session.close(), 3)
            self.assertEqual(cache.release_count, 3)
            self.assertFalse(any(cache.has_live_lease(skill.digest) for skill in skills))
            self.assertEqual(session._activation_tasks, {})
            self.assertTrue(session.closed)
            with self.assertRaises(CatalogError) as closed:
                await session.activate(names[0])
            self.assertEqual(closed.exception.code, "session_closed")
        finally:
            # Keep the fixture bounded even when a regression leaves pins behind.
            for skill in skills:
                if cache.has_live_lease(skill.digest):
                    cache.release_lease(skill._active_lease.lease)

    async def test_default_cache_honors_public_admission_limits(self) -> None:
        artifact = skill_markdown("code-review", "Review safely.", "# Review\n")
        origin = ScriptedOrigin(
            catalog_body("code-review", "Review safely.", artifact), artifact
        )
        with tempfile.TemporaryDirectory() as directory:

            def disk_cache(**kwargs):
                backend = DiskCache(directory, **kwargs)
                self.assertEqual(backend.max_artifact_bytes, 256)
                self.assertEqual(backend.max_extracted_bytes, 256)
                self.assertEqual(backend.max_file_bytes, 128)
                self.assertEqual(backend.max_files_per_object, 1001)
                self.assertEqual(backend.max_catalog_bytes, 512)
                return backend

            with patch("remote_skills.lifecycle.DiskCache", side_effect=disk_cache):
                client = RemoteSkills(
                    origins={
                        "acme": Origin(url="https://skills.example.test", catalog_bytes=512),
                        "small": Origin(url="https://small.example.test", catalog_bytes=128),
                    },
                    limits=ActivationLimits(
                        archive_bytes=256, extracted_bytes=256, file_bytes=128, files=1001
                    ),
                    transport=origin,
                    resolver=public_resolver,
                )
            async with client.session("acme") as session:
                skill = await session.activate("code-review")
                self.assertEqual(skill.instructions, "# Review\n")

    async def test_default_cache_accepts_above_v1_catalog_without_persistence(self) -> None:
        artifact = skill_markdown("code-review", "Review safely.", "# Review\n")
        body = catalog_body("code-review", "Review safely.", artifact) + b" " * 1_048_576
        origin = ScriptedOrigin(body, artifact)
        responses = [
            HttpResponse(200, {"cache-control": "max-age=60", "etag": '"catalog"'}, body),
            HttpResponse(304, {"cache-control": "max-age=60"}, b""),
        ]
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(origin, "request", side_effect=responses) as request,
        ):
            backend = DiskCache(directory)
            with patch("remote_skills.lifecycle.DiskCache", return_value=backend):
                client = RemoteSkills(
                    origins={
                        "acme": Origin(url="https://skills.example.test", catalog_bytes=len(body))
                    },
                    transport=origin,
                    resolver=public_resolver,
                )
            for _ in range(2):
                async with client.session("acme") as session:
                    self.assertEqual(
                        [entry.name for entry in await session.catalog()], ["code-review"]
                    )
            self.assertEqual(request.call_count, 1)
            await client.refresh("acme")
            async with client.session("acme") as session:
                self.assertEqual(
                    [entry.name for entry in await session.catalog()], ["code-review"]
                )
            self.assertEqual(request.call_count, 2)
            self.assertIsNone(backend.get_catalog(
                "https://skills.example.test/.well-known/agent-skills/index.json"
            ))

    async def test_invalid_public_limits_do_not_construct_default_cache(self) -> None:
        with patch("remote_skills.lifecycle.DiskCache") as constructor:
            with self.assertRaises(CatalogError):
                RemoteSkills(
                    origins={"acme": Origin(url="https://skills.example.test")}, limits=object()
                )
            constructor.assert_not_called()

    async def test_custom_cache_keeps_independent_admission_policy(self) -> None:
        with (
            tempfile.TemporaryDirectory() as directory,
            patch("remote_skills.lifecycle.DiskCache") as constructor,
        ):
            backend = DiskCache(directory, max_files_per_object=1)
            RemoteSkills(
                origins={"acme": Origin(url="https://skills.example.test")},
                cache=backend,
                limits=ActivationLimits(files=1001),
            )
            constructor.assert_not_called()
            self.assertEqual(backend.max_files_per_object, 1)

    async def test_facade_configuration_failures_use_stable_typed_errors(self) -> None:
        for origins in ([], {"acme": object()}):
            with self.subTest(origins=origins):
                with self.assertRaises(CatalogError) as raised:
                    RemoteSkills(origins=origins)
                self.assertEqual(raised.exception.code, "configuration_invalid")
                self.assertEqual(raised.exception.context, {"field": "origins"})

    async def test_documented_context_manager_uses_the_public_facade(self) -> None:
        artifact = skill_markdown("code-review", "Review safely.", "# Review\n")
        origin = ScriptedOrigin(
            catalog_body("code-review", "Review safely.", artifact), artifact
        )
        client = make_client(origin)

        async with client.session("acme") as session:
            entries = await session.catalog()
            skill = await session.activate("code-review")

        self.assertEqual([entry.name for entry in entries], ["code-review"])
        self.assertEqual(skill.instructions, "# Review\n")
        self.assertTrue(session.closed)
        self.assertEqual(len(origin.requests), 2)

    async def test_refresh_changes_only_future_session_snapshots(self) -> None:
        first_bytes = skill_markdown("code-review", "Review safely.", "# D1\n")
        second_bytes = skill_markdown("code-review", "Review safely.", "# D2\n")
        origin = ScriptedOrigin(
            catalog_body("code-review", "Review safely.", first_bytes), first_bytes
        )
        client = make_client(origin)
        first_session = await client.session("acme")
        first_skill = await first_session.activate("code-review")

        origin.publish(
            catalog_body("code-review", "Review safely.", second_bytes), second_bytes
        )
        await client.refresh("acme")
        second_session = await client.session("acme")
        second_skill = await second_session.activate("code-review")

        self.assertEqual(first_skill.instructions, "# D1\n")
        self.assertEqual(second_skill.instructions, "# D2\n")
        self.assertNotEqual(first_skill.digest, second_skill.digest)
        await first_session.close()
        await second_session.close()

    async def test_repeated_concurrent_activation_is_one_pin_until_idempotent_close(
        self,
    ) -> None:
        artifact = skill_markdown("code-review", "Review safely.", "# Review\n")
        origin = ScriptedOrigin(
            catalog_body("code-review", "Review safely.", artifact), artifact
        )
        cache = MemoryCache()
        client = make_client(origin, cache=cache)
        session = await client.session("acme")

        first, second = await asyncio.gather(
            session.activate("code-review"),
            session.activate("code-review"),
        )

        self.assertIs(first, second)
        self.assertTrue(cache.has_live_lease(first.digest))
        self.assertEqual(
            sum(not url.endswith("index.json") for url in origin.requests), 1
        )
        await asyncio.gather(session.close(), session.close())
        self.assertFalse(cache.has_live_lease(first.digest))
        for operation in (
            session.catalog,
            lambda: session.activate("code-review"),
            lambda: first.read("SKILL.md"),
        ):
            with self.subTest(operation=operation):
                with self.assertRaises(CatalogError) as raised:
                    await operation()
                self.assertEqual(raised.exception.code, "session_closed")

    async def test_cancelled_waiter_cannot_orphan_a_completed_activation_lease(
        self,
    ) -> None:
        artifact = skill_markdown("code-review", "Review safely.", "# Review\n")
        origin = ScriptedOrigin(
            catalog_body("code-review", "Review safely.", artifact), artifact
        )
        cache = ReleaseCountingMemoryCache()
        session = await make_client(origin, cache=cache).session("acme")
        waiter = asyncio.create_task(session.activate("code-review"))
        await asyncio.sleep(0)
        activation = session._activation_tasks["code-review"]
        activation.add_done_callback(lambda _task: waiter.cancel())

        with self.assertRaises(asyncio.CancelledError):
            await waiter
        completed = activation.result()
        self.assertTrue(cache.has_live_lease(completed.digest))

        await session.close()

        self.assertEqual(
            (cache.release_count, cache.has_live_lease(completed.digest)),
            (1, False),
        )

    async def test_offline_stale_sessions_are_explicit_visible_and_age_bounded(
        self,
    ) -> None:
        artifact = skill_markdown("code-review", "Review safely.", "# Review\n")
        origin = ScriptedOrigin(
            catalog_body("code-review", "Review safely.", artifact), artifact
        )
        clock = MutableClock(1_000.0)
        client = make_client(origin, cache=MemoryCache(), clock=clock)
        seeded = await client.session("acme")
        await seeded.close()
        origin.online = False

        zero_age = await client.session(
            "acme", stale=StaleCatalog(max_age_seconds=0)
        )
        self.assertTrue(zero_age.metadata.stale)
        self.assertEqual(zero_age.metadata.catalog_age_seconds, 0.0)
        await zero_age.close()

        clock.value = 1_060.0

        with self.assertRaises(CatalogError) as default_error:
            await client.session("acme")
        self.assertEqual(default_error.exception.code, "origin_unavailable")

        stale = await client.session(
            "acme", stale=StaleCatalog(max_age_seconds=300)
        )
        self.assertTrue(stale.metadata.stale)
        self.assertEqual(stale.metadata.catalog_age_seconds, 60.0)
        await stale.close()

        clock.value = 1_300.0
        boundary = await client.session(
            "acme", stale=StaleCatalog(max_age_seconds=300)
        )
        self.assertEqual(boundary.metadata.catalog_age_seconds, 300.0)
        await boundary.close()

        clock.value = 1_300.001
        with self.assertRaises(CatalogError) as expired_error:
            await client.session(
                "acme", stale=StaleCatalog(max_age_seconds=300)
            )
        self.assertEqual(expired_error.exception.code, "origin_unavailable")

    async def test_online_release_removal_never_resurrects_cached_bytes(self) -> None:
        version_200 = skill_markdown("code-review", "Review safely.", "# 2.0.0\n")
        version_151 = skill_markdown("code-review", "Review safely.", "# 1.5.1\n")
        version_147 = skill_markdown("code-review", "Review safely.", "# 1.4.7\n")
        initial = versioned_catalog_body(
            "code-review",
            "Review safely.",
            (("2.0.0", version_200), ("1.4.7", version_147)),
        )
        origin = ScriptedOrigin(initial, version_200)
        origin.add_artifacts(version_147, version_151)
        client = make_client(origin, cache=MemoryCache())
        existing = await client.session("acme")
        pinned = await existing.activate("code-review", "1.4.x")
        artifact_requests_before_removal = sum(
            not url.endswith("index.json") for url in origin.requests
        )

        origin.body = versioned_catalog_body(
            "code-review",
            "Review safely.",
            (("2.0.0", version_200), ("1.5.1", version_151)),
        )
        await client.refresh("acme")
        future = await client.session("acme")
        with self.assertRaises(CatalogError) as removed:
            await future.activate("code-review", "1.4.x")

        self.assertEqual(removed.exception.code, "version_unavailable")
        self.assertEqual(await pinned.read("SKILL.md"), version_147.decode())
        self.assertEqual(
            sum(not url.endswith("index.json") for url in origin.requests),
            artifact_requests_before_removal,
        )
        await existing.close()
        await future.close()

    async def test_compatible_version_update_is_selected_only_by_future_session(
        self,
    ) -> None:
        version_200 = skill_markdown("code-review", "Review safely.", "# 2.0.0\n")
        version_148 = skill_markdown("code-review", "Review safely.", "# 1.4.8\n")
        version_147 = skill_markdown("code-review", "Review safely.", "# 1.4.7\n")
        origin = ScriptedOrigin(
            versioned_catalog_body(
                "code-review",
                "Review safely.",
                (("2.0.0", version_200), ("1.4.7", version_147)),
            ),
            version_200,
        )
        origin.add_artifacts(version_147, version_148)
        client = make_client(origin, cache=MemoryCache())
        existing = await client.session("acme")
        pinned = await existing.activate("code-review", "1.4.x")

        origin.body = versioned_catalog_body(
            "code-review",
            "Review safely.",
            (
                ("2.0.0", version_200),
                ("1.4.8", version_148),
                ("1.4.7", version_147),
            ),
        )
        await client.refresh("acme")
        future = await client.session("acme")
        updated = await future.activate("code-review", "1.4.x")

        self.assertEqual(pinned.version, "1.4.7")
        self.assertEqual(updated.version, "1.4.8")
        self.assertEqual(await pinned.read("SKILL.md"), version_147.decode())
        await existing.close()
        await future.close()

    async def test_explicit_stale_session_can_select_cached_removed_release(self) -> None:
        version_200 = skill_markdown("code-review", "Review safely.", "# 2.0.0\n")
        version_147 = skill_markdown("code-review", "Review safely.", "# 1.4.7\n")
        origin = ScriptedOrigin(
            versioned_catalog_body(
                "code-review",
                "Review safely.",
                (("2.0.0", version_200), ("1.4.7", version_147)),
            ),
            version_200,
        )
        origin.add_artifacts(version_147)
        clock = MutableClock(2_000.0)
        client = make_client(origin, cache=MemoryCache(), clock=clock)
        seeded = await client.session("acme")
        seeded_skill = await seeded.activate("code-review", "1.4.x")
        await seeded.close()
        origin.online = False
        clock.value = 2_060.0

        stale = await client.session(
            "acme", stale=StaleCatalog(max_age_seconds=300)
        )
        selected = await stale.activate("code-review", "1.4.x")

        self.assertTrue(stale.stale)
        self.assertEqual(selected.version, "1.4.7")
        self.assertEqual(selected.digest, seeded_skill.digest)
        self.assertEqual(await selected.read("SKILL.md"), version_147.decode())
        await stale.close()

    async def test_aggregate_catalog_retains_partial_failures_and_strict_details(
        self,
    ) -> None:
        artifact = skill_markdown("code-review", "Review safely.", "# Review\n")
        body = catalog_body("code-review", "Review safely.", artifact)

        class AggregateTransport:
            async def request(
                self,
                url: str,
                headers: dict[str, str],
                timeout: float,
                connect_address: str,
                max_bytes: int,
            ) -> HttpResponse:
                del headers, timeout, connect_address, max_bytes
                if "unavailable.example.test" in url:
                    raise OSError("fixture origin unavailable")
                return HttpResponse(200, {"cache-control": "max-age=0"}, body)

        client = RemoteSkills(
            origins={
                "acme": Origin(url="https://skills.example.test", retries=0),
                "broken": Origin(url="https://unavailable.example.test", retries=0),
            },
            cache=MemoryCache(),
            transport=AggregateTransport(),
            resolver=public_resolver,
        )

        aggregate = await client.catalog()
        self.assertEqual([entry.origin_alias for entry in aggregate.entries], ["acme"])
        self.assertEqual(
            [(failure.origin_alias, failure.error.code) for failure in aggregate.failures],
            [("broken", "origin_unavailable")],
        )
        with self.assertRaises(AggregateCatalogError) as strict_error:
            await client.catalog(strict=True)
        self.assertEqual(strict_error.exception.failures[0].origin_alias, "broken")

    async def test_same_named_skills_remain_origin_qualified_and_session_bound(
        self,
    ) -> None:
        acme_artifact = skill_markdown(
            "code-review", "Review with Acme policy.", "Follow Acme's review policy.\n"
        )
        partner_artifact = skill_markdown(
            "code-review",
            "Review with partner policy.",
            "Follow the partner's review policy.\n",
        )
        fixtures = {
            "skills.example.test": (
                catalog_body(
                    "code-review", "Review with Acme policy.", acme_artifact
                ),
                acme_artifact,
            ),
            "partner.example.test": (
                catalog_body(
                    "code-review",
                    "Review with partner policy.",
                    partner_artifact,
                ),
                partner_artifact,
            ),
        }

        class MultiOriginTransport:
            async def request(
                self,
                url: str,
                headers: dict[str, str],
                timeout: float,
                connect_address: str,
                max_bytes: int,
            ) -> HttpResponse:
                del headers, timeout, connect_address, max_bytes
                catalog, artifact = fixtures[urlsplit(url).hostname]
                if url.endswith("/index.json"):
                    return HttpResponse(
                        200, {"cache-control": "max-age=0"}, catalog
                    )
                return HttpResponse(
                    200, {"content-type": "text/markdown"}, artifact
                )

        client = RemoteSkills(
            origins={
                "acme": Origin(url="https://skills.example.test", retries=0),
                "partner": Origin(
                    url="https://partner.example.test", retries=0
                ),
            },
            cache=MemoryCache(),
            transport=MultiOriginTransport(),
            resolver=public_resolver,
        )

        aggregate = await client.catalog()
        self.assertEqual(
            [(entry.origin_alias, entry.name) for entry in aggregate.entries],
            [("acme", "code-review"), ("partner", "code-review")],
        )

        acme_session, partner_session = await asyncio.gather(
            client.session("acme"), client.session("partner")
        )
        try:
            acme, partner = await asyncio.gather(
                acme_session.activate("code-review"),
                partner_session.activate("code-review"),
            )
            self.assertEqual(
                [
                    (skill.origin_alias, skill.instructions)
                    for skill in (acme, partner)
                ],
                [
                    ("acme", "Follow Acme's review policy.\n"),
                    ("partner", "Follow the partner's review policy.\n"),
                ],
            )
        finally:
            await asyncio.gather(acme_session.close(), partner_session.close())

    async def test_authorization_loss_blocks_future_and_stale_sessions_only(self) -> None:
        artifact = skill_markdown("code-review", "Review safely.", "# Review\n")
        body = catalog_body("code-review", "Review safely.", artifact)
        denied = False

        class ScopedTransport:
            async def request(
                self,
                url: str,
                headers: dict[str, str],
                timeout: float,
                connect_address: str,
                max_bytes: int,
            ) -> HttpResponse:
                del timeout, connect_address, max_bytes
                if url.endswith("index.json"):
                    if denied:
                        return HttpResponse(403, {}, b"not exposed")
                    self.assert_scope(headers)
                    return HttpResponse(
                        200,
                        {
                            "cache-control": "max-age=0",
                            "remote-skills-scope": "engineering",
                        },
                        body,
                    )
                return HttpResponse(
                    200, {"content-type": "text/markdown"}, artifact
                )

            @staticmethod
            def assert_scope(headers: dict[str, str]) -> None:
                if headers.get("remote-skills-scope") != "engineering":
                    raise AssertionError("scoped session omitted its requested scope")

        transport = ScopedTransport()
        client = RemoteSkills(
            origins={
                "acme": Origin(
                    url="https://skills.example.test",
                    headers={"authorization": "runtime-only"},
                    scope="engineering",
                    retries=0,
                )
            },
            cache=MemoryCache(),
            transport=transport,
            resolver=public_resolver,
        )
        existing = await client.session("acme")
        pinned = await existing.activate("code-review")
        denied = True

        with self.assertRaises(CatalogError) as refresh_error:
            await client.refresh("acme")
        self.assertEqual(refresh_error.exception.code, "authorization_denied")
        with self.assertRaises(CatalogError) as stale_error:
            await client.session(
                "acme", stale=StaleCatalog(max_age_seconds=300)
            )

        self.assertEqual(stale_error.exception.code, "authorization_denied")
        self.assertEqual(await pinned.read("SKILL.md"), artifact.decode())
        await existing.close()


if __name__ == "__main__":
    unittest.main()

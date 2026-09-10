import ctypes
import hashlib
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from collections.abc import Callable
from contextlib import contextmanager
from dataclasses import replace
from datetime import datetime, timedelta, timezone, tzinfo
from pathlib import Path
from unittest.mock import patch


PACKAGE_ROOT = Path(__file__).resolve().parents[1]
SRC_ROOT = PACKAGE_ROOT / "src"
sys.path.insert(0, str(SRC_ROOT))

from remote_skills.cache import (
    CACHE_COORDINATION_VERSION,
    CacheBackend,
    CacheConfigurationError,
    CacheCorruptError,
    CacheLease,
    CachedCatalog,
    CachedObject,
    CatalogGeneration,
    CatalogMetadata,
    CatalogState,
    DiskCache,
    MemoryCache,
    default_cache_root,
    origin_identifier,
)
from remote_skills.cache.protocol import (
    _release_publishers_as_ready,
    _same_immutable_object,
    run_protocol_case,
)
from remote_skills.cache.unicode_casefold import pinned_unicode_15_casefold
import remote_skills.cache.base as base_cache_module
import remote_skills.cache.disk as disk_cache_module
import remote_skills.cache.unicode_normalization as unicode_normalization_module


FIXTURE_DIGEST = "sha256:e4bb9c0cb022778c3e22703220eb387a5405b2025dad77b870291fc692c4e21d"
FIXTURE_ORIGIN = "https://skills.example.test/.well-known/agent-skills/index.json"
FIXTURE_ORIGIN_ID = "e396390b2552f0cd92e2bf23ef6af15aedc1d1bb03c6cb2c8ba82d12932b260c"
REPOSITORY_ROOT = PACKAGE_ROOT.parents[1]
VALID_STATE = REPOSITORY_ROOT / "tests/protocol/fixtures/cache/states/valid"
CRASHED_LEASE_STATE = (
    REPOSITORY_ROOT / "tests/protocol/fixtures/cache/states/crashed-lease"
)
PARTIAL_WRITER_STATE = (
    REPOSITORY_ROOT / "tests/protocol/fixtures/cache/states/partial-writer"
)
UNKNOWN_LAYOUT_STATE = (
    REPOSITORY_ROOT / "tests/protocol/fixtures/cache/states/unknown-layout"
)
CROSS_PROCESS_AFTER = (
    REPOSITORY_ROOT / "tests/protocol/fixtures/cache/states/cross-process/after"
)


def fixture_object() -> CachedObject:
    cached = DiskCache(VALID_STATE, touch_on_read=False).get_object(FIXTURE_DIGEST)
    if cached is None:
        raise AssertionError("checked-in cache object is missing")
    return cached


def make_skill_object(label: str, accessed_at: datetime) -> CachedObject:
    artifact = (
        f"---\nname: {label}\ndescription: eviction fixture\n---\n\n# {label}\n"
    ).encode()
    return CachedObject(
        digest=f"sha256:{hashlib.sha256(artifact).hexdigest()}",
        artifact_type="skill-md",
        archive_format=None,
        artifact=artifact,
        files={"SKILL.md": artifact},
        media_types={"SKILL.md": "text/markdown"},
        verified_at=accessed_at,
        accessed_at=accessed_at,
    )


def make_archive_object(label: str, accessed_at: datetime) -> CachedObject:
    artifact = f"archive fixture: {label}".encode()
    skill = f"---\nname: {label}\ndescription: archive fixture\n---\n".encode()
    return CachedObject(
        digest=f"sha256:{hashlib.sha256(artifact).hexdigest()}",
        artifact_type="archive",
        archive_format="zip",
        artifact=artifact,
        files={"SKILL.md": skill, "references/details.txt": b"details"},
        media_types={
            "SKILL.md": "text/markdown",
            "references/details.txt": "text/plain",
        },
        verified_at=accessed_at,
        accessed_at=accessed_at,
    )


def windows_directory_without_descriptor(
    path: Path,
    parent_descriptor: int | None = None,
) -> None:
    del parent_descriptor
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode):
        raise ValueError("directory")
    return None


@contextmanager
def mocked_windows_directory_handles(
    handles: list[int],
    identities: list[tuple[int, int, int]],
):
    closed: list[int] = []

    class Kernel32:
        @staticmethod
        def CloseHandle(handle: int) -> None:
            closed.append(handle)

    class Windll:
        kernel32 = Kernel32()

    with (
        patch.object(disk_cache_module.os, "name", "nt"),
        patch.object(ctypes, "windll", Windll(), create=True),
        patch(
            "remote_skills.cache.disk._windows_open_directory_handle",
            side_effect=handles,
        ),
        patch(
            "remote_skills.cache.disk._windows_handle_identity",
            side_effect=identities,
        ),
    ):
        yield closed


@contextmanager
def replaced_windows_chain_parent(target: Path, saved: Path):
    original_chain = disk_cache_module._windows_directory_chain
    state = {"swapped": False}

    @contextmanager
    def replacement(root: Path, parts: tuple[str, ...]):
        with original_chain(root, parts) as chain:
            if chain.path == target and not state["swapped"]:
                target.rename(saved)
                target.mkdir()
                state["swapped"] = True
            yield chain

    with patch("remote_skills.cache.disk._windows_directory_chain", replacement):
        yield state


class TemporaryCacheTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.cache_root = Path(self.temporary.name) / "remote-skills"


class SharedLayoutTest(unittest.TestCase):
    def test_python_package_manifest_uses_real_direct_gates(self) -> None:
        manifest = json.loads((PACKAGE_ROOT / "package.json").read_text(encoding="utf-8"))
        scripts = manifest["scripts"]
        self.assertIn("compileall", scripts["typecheck"])
        self.assertIn("src", scripts["typecheck"])
        self.assertIn("tests", scripts["typecheck"])
        self.assertIn("unittest discover", scripts["test"])
        self.assertIn("typecheck", scripts["check"])
        self.assertIn("test", scripts["check"])
        self.assertNotIn("run-package-gate", json.dumps(scripts))

    def test_origin_and_object_paths_match_cache_v1_contract(self) -> None:
        self.assertEqual(
            CACHE_COORDINATION_VERSION,
            "remote-skills-cache-coordination-v1",
        )
        self.assertEqual(origin_identifier(FIXTURE_ORIGIN), FIXTURE_ORIGIN_ID)

        cache = DiskCache(PACKAGE_ROOT / ".test-cache")
        self.assertEqual(cache.namespace.name, "cache-v1")
        self.assertEqual(
            cache.object_path(FIXTURE_DIGEST).relative_to(cache.namespace).as_posix(),
            "objects/sha256/e4/bb9c0cb022778c3e22703220eb387a5405b2025dad77b870291fc692c4e21d",
        )

    def test_process_registration_uses_shared_digest_scope_and_releases_final_record(self) -> None:
        root = Path(self.temporary.name) if hasattr(self, "temporary") else Path(tempfile.mkdtemp())
        self.addCleanup(lambda: shutil.rmtree(root, ignore_errors=True))
        cache = DiskCache(
            root,
            touch_on_read=False,
            process_identity=lambda _pid: "python-process-identity",
        )
        cache.publish_object(fixture_object())
        lease = cache.acquire_lease(
            FIXTURE_DIGEST,
            process_nonce="python-shared-registration",
            session_nonce="python-shared-session",
            pid=os.getpid(),
        )
        registration = (
            root
            / "cache-v1/tmp/coordination-v1/processes"
            / FIXTURE_DIGEST[7:]
            / "python-shared-registration.json"
        )
        self.assertTrue(registration.is_file())
        self.assertEqual(
            json.loads(registration.read_text(encoding="utf-8"))["schema"],
            "remote-skills-cache-process-registration-v1",
        )
        cache.release_lease(lease)
        self.assertFalse(registration.exists())

    def test_eviction_reclaims_the_digest_lease_generation_record(self) -> None:
        root = Path(tempfile.mkdtemp())
        self.addCleanup(lambda: shutil.rmtree(root, ignore_errors=True))
        cache = DiskCache(root, touch_on_read=False)
        cache.publish_object(fixture_object())
        lease = cache.acquire_lease(
            FIXTURE_DIGEST,
            process_nonce="python-bounded-generation",
            session_nonce="python-bounded-generation-session",
        )
        cache.release_lease(lease)
        generation = (
            root
            / "cache-v1/leases"
            / FIXTURE_DIGEST[7:]
            / ".lease-generation.json"
        )
        self.assertTrue(generation.is_file())

        result = cache.evict(max_bytes=0, max_age_seconds=0)

        self.assertEqual(result.removed_digests, (FIXTURE_DIGEST,))
        self.assertFalse(generation.exists())

    def test_cleanup_reclaims_cross_runtime_orphans_without_an_object(self) -> None:
        root = Path(tempfile.mkdtemp())
        self.addCleanup(lambda: shutil.rmtree(root, ignore_errors=True))
        digest = f"sha256:{hashlib.sha256(b'orphan-before-publication').hexdigest()}"
        node = shutil.which("node")
        self.assertIsNotNone(node, "Node.js 24 is required for mixed-runtime cache tests")
        helper = PACKAGE_ROOT / "tests/helpers/typescript_orphan_registration.ts"
        subprocess.run([node, str(helper), str(root), digest], check=True)
        registration = (
            root
            / "cache-v1/tmp/coordination-v1/processes"
            / digest[7:]
            / "typescript-orphan-before-publication.json"
        )
        generation = root / "cache-v1/leases" / digest[7:] / ".lease-generation.json"
        coordination = root / "cache-v1/tmp/coordination-v1"
        self.assertTrue(registration.is_file())
        generation.write_text(
            json.dumps(
                {
                    "schema": "remote-skills-cache-lease-generation-v1",
                    "coordination_version": CACHE_COORDINATION_VERSION,
                    "generation": "2020-01-01T00:00:00.000Z",
                }
            ),
            encoding="utf-8",
        )
        self.assertTrue(generation.is_file())

        cleaner = DiskCache(
            root,
            touch_on_read=False,
            clock=lambda: datetime(2040, 1, 1, tzinfo=timezone.utc),
            process_is_alive=lambda _pid, _nonce: False,
        )
        cleaner.cleanup_stale_temporaries(max_age_seconds=1)
        cleaner.cleanup_stale_leases(lease_expiry_seconds=1)
        cleaner.evict(max_bytes=0, max_age_seconds=0, lease_expiry_seconds=1)

        self.assertFalse(registration.exists())
        self.assertFalse(generation.exists())
        self.assertFalse(coordination.exists())

    def test_cleanup_preserves_live_registration_lease_and_generation(self) -> None:
        root = Path(tempfile.mkdtemp())
        self.addCleanup(lambda: shutil.rmtree(root, ignore_errors=True))
        now = datetime(2026, 8, 26, tzinfo=timezone.utc)
        cache = DiskCache(
            root,
            touch_on_read=False,
            clock=lambda: now,
            process_identity=lambda _pid: "live-process-generation",
        )
        lease = cache.acquire_lease(
            FIXTURE_DIGEST,
            process_nonce="live-process-generation",
            session_nonce="live-session-generation",
            pid=os.getpid(),
        )
        registration = (
            root
            / "cache-v1/tmp/coordination-v1/processes"
            / FIXTURE_DIGEST[7:]
            / "live-process-generation.json"
        )
        generation = root / "cache-v1/leases" / FIXTURE_DIGEST[7:] / ".lease-generation.json"
        cleaner = DiskCache(
            root,
            touch_on_read=False,
            clock=lambda: now + timedelta(hours=1),
            process_identity=lambda _pid: "live-process-generation",
        )

        self.assertEqual(cleaner.cleanup_stale_leases(lease_expiry_seconds=1), 0)
        cleaner.cleanup_stale_temporaries(max_age_seconds=1)
        self.assertTrue(registration.is_file())
        self.assertTrue(generation.is_file())
        self.assertTrue(cache.has_live_lease(FIXTURE_DIGEST, lease_expiry_seconds=1))
        cache.release_lease(lease)

    def test_generation_cleanup_does_not_let_a_stale_handle_match_its_successor(self) -> None:
        root = Path(tempfile.mkdtemp())
        self.addCleanup(lambda: shutil.rmtree(root, ignore_errors=True))
        frozen = datetime(2026, 8, 26, tzinfo=timezone.utc)
        original_cache = DiskCache(
            root,
            touch_on_read=False,
            clock=lambda: frozen,
            process_identity=lambda _pid: "stale-handle-process",
            process_is_alive=lambda _pid, _nonce: False,
        )
        original = original_cache.acquire_lease(
            FIXTURE_DIGEST,
            process_nonce="stale-handle-process",
            session_nonce="same-session",
            pid=999_999,
        )
        cleaner = DiskCache(
            root,
            touch_on_read=False,
            clock=lambda: frozen + timedelta(hours=1),
            process_identity=lambda _pid: "cleaner-process",
            process_is_alive=lambda _pid, _nonce: False,
        )
        self.assertEqual(cleaner.cleanup_stale_leases(lease_expiry_seconds=1), 1)
        generation = root / "cache-v1/leases" / FIXTURE_DIGEST[7:] / ".lease-generation.json"
        self.assertFalse(generation.exists())

        successor_cache = DiskCache(
            root,
            touch_on_read=False,
            clock=lambda: frozen,
            process_identity=lambda _pid: "stale-handle-process",
        )
        successor = successor_cache.acquire_lease(
            FIXTURE_DIGEST,
            process_nonce="stale-handle-process",
            session_nonce="same-session",
            pid=999_999,
        )
        with self.assertRaises(CacheCorruptError):
            original_cache.renew_lease(original)
        with self.assertRaises(CacheCorruptError):
            original_cache.release_lease(original)
        self.assertTrue(successor_cache.has_live_lease(FIXTURE_DIGEST))
        successor_cache.release_lease(successor)

    def test_coordination_cleanup_obeys_the_shared_scan_budget(self) -> None:
        root = Path(tempfile.mkdtemp())
        self.addCleanup(lambda: shutil.rmtree(root, ignore_errors=True))
        processes = root / "cache-v1/tmp/coordination-v1/processes"
        for index in range(4):
            digest = hashlib.sha256(f"bounded-{index}".encode()).hexdigest()
            directory = processes / digest
            directory.mkdir(parents=True)
            (directory / f"orphan-{index}.json").write_text(
                json.dumps(
                    {
                        "schema": "remote-skills-cache-process-registration-v1",
                        "pid": 999_999,
                        "process_nonce": f"orphan-{index}",
                        "renewed_at": "2020-01-01T00:00:00.000Z",
                    }
                ),
                encoding="utf-8",
            )
        cleaner = DiskCache(
            root,
            touch_on_read=False,
            max_scan_entries=2,
            clock=lambda: datetime(2040, 1, 1, tzinfo=timezone.utc),
            process_is_alive=lambda _pid, _nonce: False,
        )

        cleaner.cleanup_stale_temporaries(max_age_seconds=1)

        self.assertGreaterEqual(len(list(processes.glob("*/*.json"))), 2)

    def test_crashed_shared_mutation_gate_is_reclaimed_before_cold_acquisition(self) -> None:
        root = Path(tempfile.mkdtemp())
        self.addCleanup(lambda: shutil.rmtree(root, ignore_errors=True))
        digest = f"sha256:{hashlib.sha256(b'crashed-shared-gate').hexdigest()}"
        lock_directory = root / f"cache-v1/tmp/coordination-v1/locks/{digest[7:]}"
        lock_directory.mkdir(parents=True)
        lock = lock_directory / "0000000000000001-crashed-gate-owner.lock"
        lock.write_text(
            json.dumps(
                {
                    "schema": "remote-skills-cache-mutation-lock-v1",
                    "pid": 999_999,
                    "process_nonce": "crashed-gate-process",
                    "owner_nonce": "crashed-gate-owner",
                    "ticket": 1,
                    "created_at": "2020-01-01T00:00:00.000Z",
                    "operation": "mutation",
                    "contended_with_eviction": True,
                }
            ),
            encoding="utf-8",
        )
        cache = DiskCache(
            root,
            touch_on_read=False,
            clock=lambda: datetime(2040, 1, 1, tzinfo=timezone.utc),
            process_is_alive=lambda _pid, _nonce: False,
        )

        lease = cache.acquire_lease(
            digest,
            process_nonce="cold-after-crash",
            session_nonce="cold-after-crash-session",
        )

        self.assertFalse(lock.exists())
        self.assertEqual(lease.digest, digest)
        cache.release_lease(lease)

    def test_mutation_gate_release_cannot_unlink_a_final_window_successor(self) -> None:
        root = Path(tempfile.mkdtemp())
        self.addCleanup(lambda: shutil.rmtree(root, ignore_errors=True))
        digest = f"sha256:{hashlib.sha256(b'gate-final-window').hexdigest()}"
        cache = DiskCache(root, touch_on_read=False)
        gate = cache._acquire_mutation_gate(digest, operation="mutation")
        gate_path = gate.directory / gate.name
        gate_record = json.loads(gate_path.read_text(encoding="utf-8"))
        successor = json.dumps(
            {
                "schema": "remote-skills-cache-mutation-lock-v1",
                "pid": os.getpid(),
                "process_nonce": "successor-process",
                "owner_nonce": "successor-owner",
                "ticket": gate_record["ticket"] + 1,
                "created_at": "2040-01-01T00:00:00.000Z",
                "operation": "mutation",
            }
        ).encode()
        successor_path = cache._mutation_gate_path(
            digest,
            gate_record["ticket"] + 1,
            "successor-owner",
        )
        original_unlink = __import__(
            "remote_skills.cache.disk",
            fromlist=["_unlink_at"],
        )._unlink_at
        replaced = False

        def replace_before_unlink(
            descriptor: int | None,
            directory: Path,
            name: str,
        ) -> None:
            nonlocal replaced
            if name == gate.name and not replaced:
                replaced = True
                successor_path.write_bytes(successor)
            original_unlink(descriptor, directory, name)

        with patch("remote_skills.cache.disk._unlink_at", replace_before_unlink):
            cache._release_mutation_gate(gate)

        self.assertTrue(replaced)
        self.assertEqual(successor_path.read_bytes(), successor)

    def test_stale_malformed_known_schema_intent_is_reclaimed_but_unknown_is_preserved(self) -> None:
        root = Path(tempfile.mkdtemp())
        self.addCleanup(lambda: shutil.rmtree(root, ignore_errors=True))
        digest = f"sha256:{hashlib.sha256(b'gate-schema-cleanup').hexdigest()}"
        directory = root / f"cache-v1/tmp/coordination-v1/locks/{digest[7:]}"
        directory.mkdir(parents=True)
        malformed = directory / "malformed-owner.intent"
        invalid = directory / "invalid-owner.lock"
        unknown = directory / "unknown-owner.lock"
        malformed.write_text(
            '{"schema":"remote-skills-cache-mutation-intent-v1"}\n',
            encoding="utf-8",
        )
        invalid.write_text(
            json.dumps(
                {
                    "schema": "remote-skills-cache-mutation-lock-v1",
                    "pid": os.getpid(),
                    "process_nonce": "../invalid",
                    "owner_nonce": "invalid-owner",
                    "ticket": 1,
                    "created_at": "2050-01-01T00:00:00.000Z",
                }
            ),
            encoding="utf-8",
        )
        unknown.write_text('{"schema":"future-mutation-lock-v2"}\n', encoding="utf-8")
        old = datetime(2020, 1, 1, tzinfo=timezone.utc).timestamp()
        os.utime(malformed, (old, old))
        os.utime(invalid, (old, old))
        os.utime(unknown, (old, old))
        cache = DiskCache(
            root,
            touch_on_read=False,
            lease_expiry_seconds=1,
            clock=lambda: datetime(2040, 1, 1, tzinfo=timezone.utc),
        )

        self.assertTrue(cache._reclaim_mutation_gate_record(digest, malformed.name))
        self.assertTrue(cache._reclaim_mutation_gate_record(digest, invalid.name))
        self.assertFalse(cache._reclaim_mutation_gate_record(digest, unknown.name))
        self.assertFalse(malformed.exists())
        self.assertFalse(invalid.exists())
        self.assertTrue(unknown.exists())


class WindowsDirectoryChainTest(TemporaryCacheTestCase):
    def test_windows_chain_rejects_path_handle_generation_split(self) -> None:
        root = self.cache_root
        root.mkdir(parents=True)
        path_identity = disk_cache_module._identity(root.lstat())
        handle_identity = (path_identity[0], path_identity[1] + 1, stat.S_IFDIR)
        caught: Exception | None = None

        with mocked_windows_directory_handles(
            [101],
            [handle_identity, handle_identity],
        ) as closed:
            try:
                with disk_cache_module._windows_directory_chain(root, ()):
                    pass
            except Exception as error:
                caught = error

        self.assertEqual(closed, [101])
        self.assertIsInstance(caught, ValueError)

    def test_windows_chain_accepts_matching_path_and_handle_generations(self) -> None:
        root = self.cache_root
        child = root / "child"
        child.mkdir(parents=True)
        root_identity = disk_cache_module._identity(root.lstat())
        child_identity = disk_cache_module._identity(child.lstat())

        with mocked_windows_directory_handles(
            [101, 102],
            [root_identity, child_identity, root_identity, child_identity],
        ) as closed:
            with disk_cache_module._windows_directory_chain(root, ("child",)) as chain:
                self.assertEqual(chain.identities, (root_identity, child_identity))
                self.assertEqual(chain.handle_identities, (root_identity, child_identity))

        self.assertEqual(closed, [102, 101])

    def test_windows_chain_partial_mismatch_closes_every_owned_handle(self) -> None:
        root = self.cache_root
        child = root / "child"
        child.mkdir(parents=True)
        root_identity = disk_cache_module._identity(root.lstat())
        child_identity = disk_cache_module._identity(child.lstat())
        replacement_identity = (child_identity[0], child_identity[1] + 1, stat.S_IFDIR)
        caught: Exception | None = None

        with mocked_windows_directory_handles(
            [101, 102],
            [root_identity, replacement_identity, root_identity, replacement_identity],
        ) as closed:
            try:
                with disk_cache_module._windows_directory_chain(root, ("child",)):
                    pass
            except Exception as error:
                caught = error

        self.assertEqual(closed, [102, 101])
        self.assertIsInstance(caught, ValueError)


class MixedRuntimeLeaseTest(TemporaryCacheTestCase):
    def _wait_for_path_or_exit(
        self,
        path: Path,
        child: subprocess.Popen[str],
        *,
        timeout: float = 10,
    ) -> bool:
        deadline = time.monotonic() + timeout
        while not path.exists():
            if child.poll() is not None:
                stdout, stderr = child.communicate()
                self.fail(
                    f"subprocess exited before {path.name}: "
                    f"{stderr.strip() or stdout.strip() or 'no output'}"
                )
            if time.monotonic() >= deadline:
                return False
            time.sleep(0.005)
        return True

    def test_python_final_eviction_excludes_typescript_lease_acquisition(self) -> None:
        cache = DiskCache(self.cache_root, touch_on_read=False)
        cache.publish_object(fixture_object())
        signals = Path(self.temporary.name)
        paused = signals / "python-eviction-paused"
        resume = signals / "python-eviction-resume"
        result = signals / "python-eviction-result"
        ready = signals / "typescript-racing-ready"
        release = signals / "typescript-racing-release"
        acquisition_paused = signals / "typescript-acquisition-paused"
        acquisition_resume = signals / "typescript-acquisition-resume"
        node = shutil.which("node")
        self.assertIsNotNone(node, "Node.js 24 is required for mixed-runtime cache tests")
        evicter = subprocess.Popen(
            [
                sys.executable,
                str(PACKAGE_ROOT / "tests/helpers/python_eviction_pauser.py"),
                str(self.cache_root),
                str(paused),
                str(resume),
                str(result),
            ],
            cwd=REPOSITORY_ROOT,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        holder: subprocess.Popen[str] | None = None
        try:
            self.assertTrue(self._wait_for_path_or_exit(paused, evicter))
            holder = subprocess.Popen(
                [
                    node,
                    str(PACKAGE_ROOT / "tests/helpers/typescript_lease_holder.ts"),
                    str(self.cache_root),
                    FIXTURE_DIGEST,
                    str(ready),
                    str(release),
                    "turn",
                    str(acquisition_paused),
                    str(acquisition_resume),
                ],
                cwd=REPOSITORY_ROOT,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            self.assertTrue(self._wait_for_path_or_exit(acquisition_paused, holder))
            resume.write_text("resume", encoding="utf-8")
            evicter_stdout, evicter_stderr = evicter.communicate(timeout=10)
            self.assertEqual(evicter.returncode, 0, evicter_stderr or evicter_stdout)
            acquisition_resume.write_text("resume", encoding="utf-8")
            release.write_text("release", encoding="utf-8")
            holder_stdout, holder_stderr = holder.communicate(timeout=10)
            self.assertNotEqual(
                holder.returncode,
                0,
                "eviction-winning acquisition returned a handle to a removed object",
            )
            self.assertFalse(ready.exists(), holder_stderr or holder_stdout)
            self.assertEqual(json.loads(result.read_text(encoding="utf-8"))["removed"], [FIXTURE_DIGEST])
            self.assertIsNone(cache.get_object(FIXTURE_DIGEST))
        finally:
            resume.touch(exist_ok=True)
            release.touch(exist_ok=True)
            acquisition_resume.touch(exist_ok=True)
            for child in (holder, evicter):
                if child is not None and child.poll() is None:
                    child.kill()
                    child.communicate(timeout=5)

    def test_typescript_final_eviction_excludes_python_lease_acquisition(self) -> None:
        cache = DiskCache(self.cache_root, touch_on_read=False)
        cache.publish_object(fixture_object())
        signals = Path(self.temporary.name)
        paused = signals / "typescript-eviction-paused"
        resume = signals / "typescript-eviction-resume"
        result = signals / "typescript-eviction-result"
        ready = signals / "python-racing-ready"
        release = signals / "python-racing-release"
        acquisition_paused = signals / "python-acquisition-paused"
        acquisition_resume = signals / "python-acquisition-resume"
        node = shutil.which("node")
        self.assertIsNotNone(node, "Node.js 24 is required for mixed-runtime cache tests")
        evicter = subprocess.Popen(
            [
                node,
                str(REPOSITORY_ROOT / "packages/sdk-typescript/tests/cache/helpers/typescript-eviction-pauser.ts"),
                str(self.cache_root),
                str(paused),
                str(resume),
                str(result),
            ],
            cwd=REPOSITORY_ROOT,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        holder: subprocess.Popen[str] | None = None
        try:
            self.assertTrue(self._wait_for_path_or_exit(paused, evicter))
            holder = subprocess.Popen(
                [
                    sys.executable,
                    str(REPOSITORY_ROOT / "packages/sdk-typescript/tests/cache/helpers/python-lease-holder.py"),
                    str(self.cache_root),
                    FIXTURE_DIGEST,
                    str(ready),
                    str(release),
                    "turn",
                    str(acquisition_paused),
                    str(acquisition_resume),
                ],
                cwd=REPOSITORY_ROOT,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            self.assertTrue(self._wait_for_path_or_exit(acquisition_paused, holder))
            resume.write_text("resume", encoding="utf-8")
            evicter_stdout, evicter_stderr = evicter.communicate(timeout=10)
            self.assertEqual(evicter.returncode, 0, evicter_stderr or evicter_stdout)
            acquisition_resume.write_text("resume", encoding="utf-8")
            release.write_text("release", encoding="utf-8")
            holder_stdout, holder_stderr = holder.communicate(timeout=10)
            self.assertNotEqual(
                holder.returncode,
                0,
                "eviction-winning acquisition returned a handle to a removed object",
            )
            self.assertFalse(ready.exists(), holder_stderr or holder_stdout)
            self.assertEqual(json.loads(result.read_text(encoding="utf-8"))["removed"], [FIXTURE_DIGEST])
            self.assertIsNone(cache.get_object(FIXTURE_DIGEST))
        finally:
            resume.touch(exist_ok=True)
            release.touch(exist_ok=True)
            acquisition_resume.touch(exist_ok=True)
            for child in (holder, evicter):
                if child is not None and child.poll() is None:
                    child.kill()
                    child.communicate(timeout=5)

    def test_python_eviction_after_typescript_prepublication_scan_fails_acquisition(
        self,
    ) -> None:
        cache = DiskCache(self.cache_root, touch_on_read=False)
        cache.publish_object(fixture_object())
        signals = Path(self.temporary.name)
        paused = signals / "python-gap-eviction-paused"
        resume = signals / "python-gap-eviction-resume"
        result = signals / "python-gap-eviction-result"
        ready = signals / "typescript-gap-racing-ready"
        release = signals / "typescript-gap-racing-release"
        acquisition_paused = signals / "typescript-prepublication-paused"
        acquisition_resume = signals / "typescript-prepublication-resume"
        node = shutil.which("node")
        self.assertIsNotNone(node, "Node.js 24 is required for mixed-runtime cache tests")
        holder: subprocess.Popen[str] | None = None
        evicter: subprocess.Popen[str] | None = None
        try:
            holder = subprocess.Popen(
                [
                    node,
                    str(PACKAGE_ROOT / "tests/helpers/typescript_lease_holder.ts"),
                    str(self.cache_root),
                    FIXTURE_DIGEST,
                    str(ready),
                    str(release),
                    "prepublish",
                    str(acquisition_paused),
                    str(acquisition_resume),
                ],
                cwd=REPOSITORY_ROOT,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            self.assertTrue(self._wait_for_path_or_exit(acquisition_paused, holder))
            evicter = subprocess.Popen(
                [
                    sys.executable,
                    str(PACKAGE_ROOT / "tests/helpers/python_eviction_pauser.py"),
                    str(self.cache_root),
                    str(paused),
                    str(resume),
                    str(result),
                ],
                cwd=REPOSITORY_ROOT,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            self.assertTrue(self._wait_for_path_or_exit(paused, evicter))
            resume.write_text("resume", encoding="utf-8")
            evicter_stdout, evicter_stderr = evicter.communicate(timeout=10)
            self.assertEqual(evicter.returncode, 0, evicter_stderr or evicter_stdout)
            acquisition_resume.write_text("resume", encoding="utf-8")
            release.write_text("release", encoding="utf-8")
            holder_stdout, holder_stderr = holder.communicate(timeout=10)
            self.assertNotEqual(holder.returncode, 0, holder_stderr or holder_stdout)
            self.assertFalse(ready.exists(), holder_stderr or holder_stdout)
            self.assertEqual(json.loads(result.read_text(encoding="utf-8"))["removed"], [FIXTURE_DIGEST])
            self.assertIsNone(cache.get_object(FIXTURE_DIGEST))
        finally:
            resume.touch(exist_ok=True)
            acquisition_resume.touch(exist_ok=True)
            release.touch(exist_ok=True)
            for child in (holder, evicter):
                if child is not None and child.poll() is None:
                    child.kill()
                    child.communicate(timeout=5)

    def test_typescript_eviction_after_python_prepublication_scan_fails_acquisition(
        self,
    ) -> None:
        cache = DiskCache(self.cache_root, touch_on_read=False)
        cache.publish_object(fixture_object())
        signals = Path(self.temporary.name)
        paused = signals / "typescript-gap-eviction-paused"
        resume = signals / "typescript-gap-eviction-resume"
        result = signals / "typescript-gap-eviction-result"
        ready = signals / "python-gap-racing-ready"
        release = signals / "python-gap-racing-release"
        acquisition_paused = signals / "python-prepublication-paused"
        acquisition_resume = signals / "python-prepublication-resume"
        node = shutil.which("node")
        self.assertIsNotNone(node, "Node.js 24 is required for mixed-runtime cache tests")
        holder: subprocess.Popen[str] | None = None
        evicter: subprocess.Popen[str] | None = None
        try:
            holder = subprocess.Popen(
                [
                    sys.executable,
                    str(REPOSITORY_ROOT / "packages/sdk-typescript/tests/cache/helpers/python-lease-holder.py"),
                    str(self.cache_root),
                    FIXTURE_DIGEST,
                    str(ready),
                    str(release),
                    "prepublish",
                    str(acquisition_paused),
                    str(acquisition_resume),
                ],
                cwd=REPOSITORY_ROOT,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            self.assertTrue(self._wait_for_path_or_exit(acquisition_paused, holder))
            evicter = subprocess.Popen(
                [
                    node,
                    str(REPOSITORY_ROOT / "packages/sdk-typescript/tests/cache/helpers/typescript-eviction-pauser.ts"),
                    str(self.cache_root),
                    str(paused),
                    str(resume),
                    str(result),
                ],
                cwd=REPOSITORY_ROOT,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            self.assertTrue(self._wait_for_path_or_exit(paused, evicter))
            resume.write_text("resume", encoding="utf-8")
            evicter_stdout, evicter_stderr = evicter.communicate(timeout=10)
            self.assertEqual(evicter.returncode, 0, evicter_stderr or evicter_stdout)
            acquisition_resume.write_text("resume", encoding="utf-8")
            release.write_text("release", encoding="utf-8")
            holder_stdout, holder_stderr = holder.communicate(timeout=10)
            self.assertNotEqual(holder.returncode, 0, holder_stderr or holder_stdout)
            self.assertFalse(ready.exists(), holder_stderr or holder_stdout)
            self.assertEqual(json.loads(result.read_text(encoding="utf-8"))["removed"], [FIXTURE_DIGEST])
            self.assertIsNone(cache.get_object(FIXTURE_DIGEST))
        finally:
            resume.touch(exist_ok=True)
            acquisition_resume.touch(exist_ok=True)
            release.touch(exist_ok=True)
            for child in (holder, evicter):
                if child is not None and child.poll() is None:
                    child.kill()
                    child.communicate(timeout=5)

    def test_python_eviction_preserves_expired_typescript_lease_while_node_is_live(self) -> None:
        cache = DiskCache(self.cache_root, touch_on_read=False)
        cache.publish_object(fixture_object())
        ready = self.cache_root / "typescript-ready"
        release = self.cache_root / "typescript-release"
        helper = PACKAGE_ROOT / "tests/helpers/typescript_lease_holder.ts"
        node = shutil.which("node")
        self.assertIsNotNone(node, "Node.js 24 is required for mixed-runtime cache tests")
        child = subprocess.Popen(
            [node, str(helper), str(self.cache_root), FIXTURE_DIGEST, str(ready), str(release)],
            cwd=REPOSITORY_ROOT,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        try:
            deadline = time.monotonic() + 10
            while not ready.exists():
                if child.poll() is not None:
                    stdout, stderr = child.communicate()
                    self.fail(f"TypeScript lease holder exited early: {stderr or stdout}")
                if time.monotonic() >= deadline:
                    self.fail("TypeScript lease holder did not become ready")
                time.sleep(0.005)
            cleaner = DiskCache(
                self.cache_root,
                touch_on_read=False,
                clock=lambda: datetime(2040, 1, 1, tzinfo=timezone.utc),
            )
            result = cleaner.evict(
                max_bytes=0,
                max_age_seconds=0,
                lease_expiry_seconds=1,
            )
            self.assertEqual(result.retained_pinned, (FIXTURE_DIGEST,))
            self.assertIsNotNone(cleaner.get_object(FIXTURE_DIGEST))
            release.write_text("release", encoding="utf-8")
            stdout, stderr = child.communicate(timeout=10)
            self.assertEqual(child.returncode, 0, stderr or stdout)
        finally:
            if child.poll() is None:
                child.kill()
                child.wait(timeout=5)

    def test_python_cleanup_preserves_a_live_typescript_writer_and_reclaims_it_after_crash(self) -> None:
        ready = self.cache_root / "typescript-writer-ready"
        release = self.cache_root / "typescript-writer-release"
        helper = PACKAGE_ROOT / "tests/helpers/typescript_writer_holder.ts"
        node = shutil.which("node")
        self.assertIsNotNone(node, "Node.js 24 is required for mixed-runtime cache tests")
        child = subprocess.Popen(
            [
                node,
                str(helper),
                str(VALID_STATE),
                str(self.cache_root),
                FIXTURE_DIGEST,
                str(ready),
                str(release),
            ],
            cwd=REPOSITORY_ROOT,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        try:
            deadline = time.monotonic() + 10
            while not ready.exists():
                if child.poll() is not None:
                    stdout, stderr = child.communicate()
                    self.fail(f"TypeScript writer holder exited early: {stderr or stdout}")
                if time.monotonic() >= deadline:
                    self.fail("TypeScript writer holder did not become ready")
                time.sleep(0.005)
            temporary_root = self.cache_root / "cache-v1/tmp"
            stage = next(temporary_root.glob("writer-typescript-*"))
            os.utime(stage, (0, 0))
            cleaner = DiskCache(
                self.cache_root,
                touch_on_read=False,
                clock=lambda: datetime(2040, 1, 1, tzinfo=timezone.utc),
            )
            self.assertEqual(cleaner.cleanup_stale_temporaries(max_age_seconds=1), 0)
            self.assertTrue(stage.exists())

            child.kill()
            child.communicate(timeout=10)
            self.assertEqual(cleaner.cleanup_stale_temporaries(max_age_seconds=1), 1)
            self.assertFalse(stage.exists())
        finally:
            if child.poll() is None:
                child.kill()
            child.communicate(timeout=5)

    def test_os_default_cache_paths_are_deterministic(self) -> None:
        home = Path("/users/cache-test")
        self.assertEqual(
            default_cache_root(platform_name="darwin", environ={}, home=home),
            home / "Library/Caches/remote-skills",
        )
        self.assertEqual(
            default_cache_root(
                platform_name="linux",
                environ={"XDG_CACHE_HOME": "/var/cache/test-user"},
                home=home,
            ),
            Path("/var/cache/test-user/remote-skills"),
        )
        for invalid_xdg in ("", "relative/cache"):
            with self.subTest(xdg_cache_home=invalid_xdg):
                self.assertEqual(
                    default_cache_root(
                        platform_name="linux",
                        environ={"XDG_CACHE_HOME": invalid_xdg},
                        home=home,
                    ),
                    home / ".cache/remote-skills",
                )
        self.assertEqual(
            default_cache_root(
                platform_name="win32",
                environ={"LOCALAPPDATA": "C:/Users/cache/AppData/Local"},
                home=home,
            ).as_posix(),
            "C:/Users/cache/AppData/Local/remote-skills",
        )
        for invalid_local_app_data in ("", "relative/cache"):
            with self.subTest(local_app_data=invalid_local_app_data):
                self.assertEqual(
                    default_cache_root(
                        platform_name="win32",
                        environ={"LOCALAPPDATA": invalid_local_app_data},
                        home=home,
                    ),
                    home / "AppData/Local/remote-skills",
                )


class ObjectReuseTest(TemporaryCacheTestCase):
    def setUp(self) -> None:
        super().setUp()
        shutil.copytree(VALID_STATE / "cache-v1", self.cache_root / "cache-v1")

    def test_reads_checked_in_cache_object_without_transformation(self) -> None:
        cache = DiskCache(self.cache_root, touch_on_read=False)

        cached = cache.get_object(FIXTURE_DIGEST)

        self.assertEqual(cached, fixture_object())
        if cached is None:
            self.fail("checked-in cache object is missing")
        self.assertEqual(cached.digest, FIXTURE_DIGEST)
        self.assertEqual(cached.artifact_type, "skill-md")
        fixture_artifact = (
            VALID_STATE
            / cache.object_path(FIXTURE_DIGEST).relative_to(self.cache_root)
            / "artifact"
        ).read_bytes()
        self.assertEqual(cached.artifact, fixture_artifact)
        self.assertEqual(cached.files, {"SKILL.md": cached.artifact})

    def test_tampered_artifact_fails_with_stable_sanitized_error(self) -> None:
        cache = DiskCache(self.cache_root, touch_on_read=False)
        artifact = cache.object_path(FIXTURE_DIGEST) / "artifact"
        artifact.write_bytes(b"Bearer unmistakable-secret-canary")

        with self.assertRaises(CacheCorruptError) as raised:
            cache.get_object(FIXTURE_DIGEST)

        self.assertEqual(raised.exception.code, "cache_corrupt")
        self.assertEqual(
            raised.exception.context,
            {"expected_digest": FIXTURE_DIGEST, "layout_version": "cache-v1"},
        )
        self.assertNotIn("unmistakable-secret-canary", str(raised.exception))

    def test_unlisted_root_file_is_cache_corruption(self) -> None:
        cache = DiskCache(self.cache_root, touch_on_read=False)
        extra = cache.object_path(FIXTURE_DIGEST) / "root/unlisted.txt"
        extra.write_text("untrusted extra content", encoding="utf-8")

        with self.assertRaises(CacheCorruptError):
            cache.get_object(FIXTURE_DIGEST)

    def test_transient_writer_file_in_final_object_is_cache_corruption(self) -> None:
        cache = DiskCache(self.cache_root, touch_on_read=False)
        writer = cache.object_path(FIXTURE_DIGEST) / "writer.json"
        writer.write_text('{"complete":true}', encoding="utf-8")

        with self.assertRaises(CacheCorruptError):
            cache.get_object(FIXTURE_DIGEST)

    def test_same_size_skill_root_tampering_is_cache_corruption(self) -> None:
        cache = DiskCache(self.cache_root, touch_on_read=False)
        root_skill = cache.object_path(FIXTURE_DIGEST) / "root/SKILL.md"
        root_skill.write_bytes(b"X" * root_skill.stat().st_size)

        with self.assertRaises(CacheCorruptError):
            cache.get_object(FIXTURE_DIGEST)

    def test_symlinked_root_directory_is_cache_corruption(self) -> None:
        cache = DiskCache(self.cache_root, touch_on_read=False)
        object_root = cache.object_path(FIXTURE_DIGEST) / "root"
        external = Path(self.temporary.name) / "external"
        external.mkdir()
        (external / "SKILL.md").write_bytes(
            (cache.object_path(FIXTURE_DIGEST) / "artifact").read_bytes()
        )
        shutil.rmtree(object_root)
        try:
            object_root.symlink_to(external, target_is_directory=True)
        except OSError as error:
            self.skipTest(f"directory symlinks unavailable: {error}")

        with self.assertRaises(CacheCorruptError):
            cache.get_object(FIXTURE_DIGEST)

    def test_entry_swapped_to_symlink_after_lstat_is_cache_corruption(self) -> None:
        cache = DiskCache(self.cache_root, touch_on_read=False)
        artifact = cache.object_path(FIXTURE_DIGEST) / "artifact"
        saved_artifact = Path(self.temporary.name) / "saved-artifact"
        original_lstat = Path.lstat
        swapped = False

        def lstat_then_swap(path: Path, *args: object, **kwargs: object) -> os.stat_result:
            nonlocal swapped
            identity = original_lstat(path, *args, **kwargs)
            if path == artifact and not swapped:
                artifact.rename(saved_artifact)
                artifact.symlink_to(saved_artifact)
                swapped = True
            return identity

        with patch.object(Path, "lstat", lstat_then_swap):
            with self.assertRaises(CacheCorruptError):
                cache.get_object(FIXTURE_DIGEST)

        self.assertTrue(swapped)

    def test_concurrent_touch_replacement_is_a_valid_metadata_generation(self) -> None:
        first_now = datetime(2030, 1, 1, 0, 0, 2, tzinfo=timezone.utc)
        second_now = first_now - timedelta(seconds=1)
        first = DiskCache(
            self.cache_root,
            touch_on_read=True,
            clock=lambda: first_now,
        )
        second = DiskCache(
            self.cache_root,
            touch_on_read=True,
            clock=lambda: second_now,
        )
        original_open = os.open
        second_object: CachedObject | None = None
        touched_before_open = False

        def touch_then_open(
            path: str | bytes | os.PathLike[str] | os.PathLike[bytes],
            flags: int,
            mode: int = 0o777,
            *,
            dir_fd: int | None = None,
        ) -> int:
            nonlocal second_object, touched_before_open
            if Path(path).name == "object.json" and not touched_before_open:
                touched_before_open = True
                second_object = second.get_object(FIXTURE_DIGEST)
            if dir_fd is None:
                return original_open(path, flags, mode)
            return original_open(path, flags, mode, dir_fd=dir_fd)

        supports_dir_fd = set(os.supports_dir_fd)
        supports_dir_fd.add(touch_then_open)
        with (
            patch.object(disk_cache_module.os, "open", touch_then_open),
            patch.object(disk_cache_module.os, "supports_dir_fd", supports_dir_fd),
        ):
            first_object = first.get_object(FIXTURE_DIGEST)

        self.assertTrue(touched_before_open)
        self.assertIsNotNone(second_object)
        self.assertIsNotNone(first_object)
        self.assertEqual(first_object.accessed_at, first_now)
        persisted = DiskCache(self.cache_root, touch_on_read=False).get_object(
            FIXTURE_DIGEST
        )
        self.assertIsNotNone(persisted)
        self.assertEqual(persisted.accessed_at, first_now)

    def test_concurrent_touch_cannot_regress_persisted_access_time(self) -> None:
        first_now = datetime(2030, 1, 1, 0, 0, 1, tzinfo=timezone.utc)
        second_now = first_now + timedelta(seconds=1)
        first = DiskCache(
            self.cache_root,
            touch_on_read=True,
            clock=lambda: first_now,
        )
        second = DiskCache(
            self.cache_root,
            touch_on_read=True,
            clock=lambda: second_now,
        )
        original_try_acquire = DiskCache._try_acquire_eviction_claim
        second_object: CachedObject | None = None

        def commit_newer_reader_before_stale_reader_claims(
            cache: DiskCache,
            digest: str,
        ):
            nonlocal second_object
            if cache is first and second_object is None:
                second_object = second.get_object(digest)
            return original_try_acquire(cache, digest)

        with patch.object(
            DiskCache,
            "_try_acquire_eviction_claim",
            commit_newer_reader_before_stale_reader_claims,
        ):
            first_object = first.get_object(FIXTURE_DIGEST)

        self.assertIsNotNone(first_object)
        self.assertIsNotNone(second_object)
        persisted = DiskCache(self.cache_root, touch_on_read=False).get_object(
            FIXTURE_DIGEST
        )
        self.assertIsNotNone(persisted)
        self.assertEqual(persisted.accessed_at, second_now)

    def test_touch_is_best_effort_when_coordination_is_unavailable(self) -> None:
        before = DiskCache(self.cache_root, touch_on_read=False).get_object(
            FIXTURE_DIGEST
        )
        callbacks: tuple[Callable[[int], str | None], ...] = (
            lambda pid: None,
            lambda pid: (_ for _ in ()).throw(OverflowError("identity unavailable")),
        )
        for process_identity in callbacks:
            with self.subTest(callback=process_identity):
                cache = DiskCache(
                    self.cache_root,
                    touch_on_read=True,
                    clock=lambda: datetime(2030, 1, 1, tzinfo=timezone.utc),
                    process_identity=process_identity,
                )

                observed = cache.get_object(FIXTURE_DIGEST)

                self.assertEqual(observed, before)
                self.assertEqual(
                    DiskCache(self.cache_root, touch_on_read=False).get_object(
                        FIXTURE_DIGEST
                    ),
                    before,
                )

    def test_descriptorless_windows_touch_uses_validated_generation(self) -> None:
        now = datetime(2030, 1, 1, tzinfo=timezone.utc)
        cache = DiskCache(self.cache_root, touch_on_read=False, clock=lambda: now)
        observed = cache.get_object(FIXTURE_DIGEST)
        self.assertIsNotNone(observed)
        assert observed is not None

        touched = cache._touch_object_accessed_at(
            FIXTURE_DIGEST,
            None,
            cache.object_path(FIXTURE_DIGEST),
            observed,
        )

        self.assertEqual(touched.accessed_at, now)
        persisted = cache.get_object(FIXTURE_DIGEST)
        self.assertIsNotNone(persisted)
        self.assertEqual(persisted.accessed_at, now)

    def test_touch_on_read_does_not_follow_replaced_object_directory(self) -> None:
        cache = DiskCache(self.cache_root, touch_on_read=True)
        object_path = cache.object_path(FIXTURE_DIGEST)
        saved_object = Path(self.temporary.name) / "saved-object"
        external = Path(self.temporary.name) / "external-object"
        external.mkdir()
        external_metadata = external / "object.json"
        external_metadata.write_text("external", encoding="utf-8")
        original_read = DiskCache._read_object

        def move_after_read(
            selected_cache: DiskCache,
            descriptor: int | None,
            opened_path: Path,
            digest: str,
        ) -> CachedObject:
            cached = original_read(selected_cache, descriptor, opened_path, digest)
            object_path.rename(saved_object)
            object_path.symlink_to(external, target_is_directory=True)
            return cached

        with patch.object(DiskCache, "_read_object", move_after_read):
            self.assertIsNotNone(cache.get_object(FIXTURE_DIGEST))

        self.assertEqual(external_metadata.read_text(encoding="utf-8"), "external")


class ImmutablePublicationTest(TemporaryCacheTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.cached = fixture_object()
        self.cache = DiskCache(self.cache_root, touch_on_read=False)

    def test_publication_matches_checked_in_cross_process_winner(self) -> None:
        published = self.cache.publish_object(self.cached)

        self.assertEqual(published, self.cached)
        actual = self.cache.object_path(FIXTURE_DIGEST)
        expected = DiskCache(CROSS_PROCESS_AFTER, touch_on_read=False).object_path(FIXTURE_DIGEST)
        for relative in ("artifact", "object.json", "root/SKILL.md"):
            self.assertEqual((actual / relative).read_bytes(), (expected / relative).read_bytes())
        self.assertEqual(
            sorted(path.relative_to(actual).as_posix() for path in actual.rglob("*") if path.is_file()),
            ["artifact", "object.json", "root/SKILL.md"],
        )
        self.assertEqual(list((self.cache.namespace / "tmp").iterdir()), [])

    def test_windows_publication_reaches_the_private_staging_boundary(self) -> None:
        observations: list[tuple[Path, bool]] = []

        class ObservedDiskCache(DiskCache):
            def _after_private_object(self, private: Path, cached: CachedObject) -> None:
                observations.append((private, self.object_path(cached.digest).exists()))

        cache = ObservedDiskCache(self.cache_root, touch_on_read=False)
        with (
            patch("remote_skills.cache.disk._windows_mode", return_value=True),
            patch.object(
                cache, "_windows_release_object_writer", wraps=cache._windows_release_object_writer,
            ) as release,
        ):
            published = cache.publish_object(self.cached)

        self.assertEqual(published, self.cached)
        self.assertEqual(len(observations), 1)
        private, was_public = observations[0]
        self.assertFalse(was_public)
        self.assertFalse(private.exists())
        release.assert_called_once()
        self.assertEqual(release.call_args.args[:3], (private, True, FIXTURE_DIGEST))
        heartbeat = release.call_args.args[4]
        registration = release.call_args.args[5]
        self.assertTrue(heartbeat.stop.is_set())
        self.assertFalse(heartbeat.thread.is_alive())
        self.assertIsNone(registration.descriptor)
        self.assertFalse((registration.directory / registration.name).exists())

    def test_windows_writer_cleanup_releases_each_owned_resource_after_failure(self) -> None:
        for failure in ("private_os", "private_value", "heartbeat", "registration_os", "registration_value"):
            with self.subTest(failure=failure):
                cache = self.cache
                nonce = f"cleanup-{failure}"
                cache._register_process_identity(FIXTURE_DIGEST, os.getpid(), nonce)
                registration = cache._open_process_registration_handle(
                    FIXTURE_DIGEST, os.getpid(), nonce,
                )
                heartbeat = cache._start_process_registration_heartbeat(
                    FIXTURE_DIGEST, os.getpid(), nonce, renew=lambda: None,
                )
                private = self.cache_root / failure
                private.mkdir()
                events: list[str] = []
                original_stop = cache._stop_process_registration_heartbeat
                original_unused = cache._remove_process_registration_if_unused
                original_release = cache._remove_process_registration_handle

                def cleanup(path: Path) -> None:
                    events.append("private")
                    if failure == "private_os":
                        raise OSError("temporary cleanup unavailable")
                    if failure == "private_value":
                        raise ValueError("temporary cleanup unavailable")
                    path.rmdir()

                def stop(owned: disk_cache_module._ProcessRegistrationHeartbeat, digest: str) -> None:
                    events.append("heartbeat")
                    if failure == "heartbeat":
                        owned.errors.append(ValueError("synthetic renewal failure"))
                    original_stop(owned, digest)

                def unused(digest: str, pid: int, process_nonce: str) -> None:
                    events.append("unused")
                    if failure == "registration_os":
                        raise OSError("registration cleanup unavailable")
                    if failure == "registration_value":
                        raise ValueError("registration cleanup unavailable")
                    original_unused(digest, pid, process_nonce)

                def release(owned: disk_cache_module._ProcessRegistrationHandle) -> None:
                    events.append("handle")
                    original_release(owned)

                expected_error = (
                    OSError if failure == "registration_os"
                    else ValueError if failure == "registration_value"
                    else CacheCorruptError
                )
                try:
                    with (
                        patch.object(cache, "_windows_cleanup_private_directory", cleanup),
                        patch.object(cache, "_stop_process_registration_heartbeat", stop),
                        patch.object(cache, "_remove_process_registration_if_unused", unused),
                        patch.object(cache, "_remove_process_registration_handle", release),
                        self.assertRaises(expected_error),
                    ):
                        cache._windows_release_object_writer(
                            private, False, FIXTURE_DIGEST, nonce, heartbeat, registration,
                        )
                    self.assertEqual(events, ["private", "heartbeat", "unused", "handle"])
                    self.assertTrue(heartbeat.stop.is_set())
                    self.assertFalse(heartbeat.thread.is_alive())
                    self.assertIsNone(registration.descriptor)
                    self.assertFalse((registration.directory / registration.name).exists())
                finally:
                    heartbeat.stop.set()
                    heartbeat.thread.join(timeout=1)
                    if registration.descriptor is not None:
                        original_release(registration)
                    self.assertFalse(heartbeat.thread.is_alive())

    def test_windows_publication_rejects_replaced_object_parent(self) -> None:
        destination = self.cache.object_path(FIXTURE_DIGEST)
        destination_parent = destination.parent
        saved_parent = Path(self.temporary.name) / "saved-windows-object-prefix"

        with (
            patch("remote_skills.cache.disk._windows_mode", return_value=True),
            replaced_windows_chain_parent(destination_parent, saved_parent) as replacement,
        ):
            with self.assertRaises(CacheCorruptError):
                self.cache.publish_object(self.cached)

        self.assertTrue(replacement["swapped"])
        self.assertEqual(list(destination_parent.iterdir()), [])

    def test_existing_winner_is_never_replaced(self) -> None:
        winner = self.cache.publish_object(self.cached)
        losing_candidate = replace(
            self.cached,
            accessed_at=datetime(2035, 1, 1, tzinfo=timezone.utc),
        )

        observed = self.cache.publish_object(losing_candidate)

        self.assertEqual(observed, winner)
        self.assertEqual(self.cache.get_object(FIXTURE_DIGEST), winner)

    def test_two_processes_never_expose_partial_final_state(self) -> None:
        ready = Path(self.temporary.name) / "ready"
        worker = PACKAGE_ROOT / "tests/cache_publish_worker.py"
        arguments = [
            sys.executable,
            str(worker),
            str(SRC_ROOT),
            str(VALID_STATE),
            str(self.cache_root),
            str(ready),
        ]
        processes: list[subprocess.Popen[str]] = []
        try:
            for name in ("python-a", "python-b"):
                processes.append(
                    subprocess.Popen(
                        [*arguments, name],
                        stdout=subprocess.PIPE,
                        stderr=subprocess.PIPE,
                        text=True,
                    )
                )
            deadline = time.monotonic() + 15
            while any(process.poll() is None for process in processes):
                for process in processes:
                    self.assertIn(process.poll(), (None, 0), "publication worker exited early")
                self.assertLess(time.monotonic(), deadline, "publication workers timed out")
                if self.cache.object_path(FIXTURE_DIGEST).exists():
                    self.assertIsNotNone(self.cache.get_object(FIXTURE_DIGEST))
                time.sleep(0.002)
            outputs = [process.communicate(timeout=5) for process in processes]
        finally:
            for process in processes:
                if process.poll() is None:
                    process.kill()
            for process in processes:
                process.communicate(timeout=5)

        for process, (stdout, stderr) in zip(processes, outputs, strict=True):
            self.assertEqual(process.returncode, 0, stderr)
            self.assertEqual(stdout.strip(), FIXTURE_DIGEST)
        objects = list((self.cache.namespace / "objects").glob("sha256/*/*/object.json"))
        self.assertEqual(len(objects), 1)
        self.assertEqual(list((self.cache.namespace / "tmp").iterdir()), [])

    def test_symlinked_temporary_directory_cannot_redirect_publication(self) -> None:
        self.cache.namespace.mkdir(parents=True)
        external = Path(self.temporary.name) / "external-tmp"
        external.mkdir()
        try:
            (self.cache.namespace / "tmp").symlink_to(external, target_is_directory=True)
        except OSError as error:
            self.skipTest(f"directory symlinks unavailable: {error}")

        with self.assertRaises(CacheCorruptError):
            self.cache.publish_object(self.cached)

        self.assertEqual(list(external.iterdir()), [])
        self.assertFalse(self.cache.object_path(FIXTURE_DIGEST).exists())

    def test_publication_commit_remains_anchored_when_parent_is_replaced(self) -> None:
        destination = self.cache.object_path(FIXTURE_DIGEST)
        destination_parent = destination.parent
        saved_parent = Path(self.temporary.name) / "saved-object-prefix"
        external = Path(self.temporary.name) / "external-object-prefix"
        external.mkdir()
        original_rename = os.rename
        swapped = False

        if disk_cache_module._windows_mode():
            with replaced_windows_chain_parent(
                destination_parent,
                saved_parent,
            ) as replacement:
                with self.assertRaises(CacheCorruptError):
                    self.cache.publish_object(self.cached)

            self.assertTrue(replacement["swapped"])
            self.assertEqual(list(destination_parent.iterdir()), [])
            return

        def swap_parent_before_commit(
            source: str | bytes | os.PathLike[str] | os.PathLike[bytes],
            target: str | bytes | os.PathLike[str] | os.PathLike[bytes],
            *args: object,
            **kwargs: object,
        ) -> None:
            nonlocal swapped
            if Path(target).name == destination.name and not swapped:
                original_rename(destination_parent, saved_parent)
                destination_parent.symlink_to(external, target_is_directory=True)
                swapped = True
            original_rename(source, target, *args, **kwargs)

        with patch("remote_skills.cache.disk.os.rename", swap_parent_before_commit):
            with self.assertRaises(CacheCorruptError):
                self.cache.publish_object(self.cached)

        self.assertTrue(swapped)
        self.assertEqual(list(external.iterdir()), [])

    def test_publication_fails_closed_without_descriptor_mutation_support(self) -> None:
        if disk_cache_module._windows_mode():
            self.skipTest("Windows has no descriptor-relative mutation API")
        with patch("remote_skills.cache.disk.os.supports_dir_fd", set()):
            with self.assertRaises(CacheCorruptError):
                self.cache.publish_object(self.cached)

        self.assertFalse(self.cache.object_path(FIXTURE_DIGEST).exists())

    def test_publication_cleanup_does_not_follow_replaced_tmp_parent(self) -> None:
        if disk_cache_module._windows_mode():
            self.skipTest(
                "Windows has no descriptor-relative tmp cleanup; path-and-handle parent "
                "replacement is covered separately"
            )
        destination = self.cache.object_path(FIXTURE_DIGEST)
        temporary_root = self.cache.namespace / "tmp"
        saved_temporary_root = Path(self.temporary.name) / "saved-publication-tmp"
        external = Path(self.temporary.name) / "external-publication-tmp"
        external.mkdir()
        original_rename = os.rename
        sentinel: Path | None = None

        def swap_tmp_before_commit(
            source: str | bytes | os.PathLike[str] | os.PathLike[bytes],
            target: str | bytes | os.PathLike[str] | os.PathLike[bytes],
            *args: object,
            **kwargs: object,
        ) -> None:
            nonlocal sentinel
            if Path(target).name == destination.name and sentinel is None:
                original_rename(temporary_root, saved_temporary_root)
                external_private = external / Path(source).name
                external_private.mkdir()
                sentinel = external_private / "do-not-delete.txt"
                sentinel.write_text("external", encoding="utf-8")
                temporary_root.symlink_to(external, target_is_directory=True)
            original_rename(source, target, *args, **kwargs)

        with patch("remote_skills.cache.disk.os.rename", swap_tmp_before_commit):
            with self.assertRaises(CacheCorruptError):
                self.cache.publish_object(self.cached)

        if sentinel is None:
            self.fail("publication commit was not reached")
        self.assertEqual(sentinel.read_text(encoding="utf-8"), "external")

    def test_object_private_construction_stays_bound_to_anchored_tmp_generation(self) -> None:
        temporary_root = self.cache.namespace / "tmp"
        saved_temporary_root = Path(self.temporary.name) / "saved-object-construction-tmp"
        external = Path(self.temporary.name) / "external-object-construction-tmp"
        external.mkdir()
        original_mkdir = os.mkdir
        sentinel: Path | None = None

        def mkdir_then_swap(
            path: str | bytes | os.PathLike[str],
            mode: int = 0o777,
            *,
            dir_fd: int | None = None,
        ) -> None:
            nonlocal sentinel
            if dir_fd is None:
                original_mkdir(path, mode)
            else:
                original_mkdir(path, mode, dir_fd=dir_fd)
            name = Path(path).name
            absolute_parent = Path(path).parent if Path(path).is_absolute() else None
            descriptor_parent_matches = (
                dir_fd is not None
                and temporary_root.exists()
                and os.path.samestat(os.fstat(dir_fd), temporary_root.stat())
            )
            if (
                sentinel is None
                and name.startswith("writer-python-")
                and (absolute_parent == temporary_root or descriptor_parent_matches)
            ):
                temporary_root.rename(saved_temporary_root)
                external_private = external / name
                external_private.mkdir()
                sentinel = external_private / "do-not-delete.txt"
                sentinel.write_text("external", encoding="utf-8")
                temporary_root.symlink_to(external, target_is_directory=True)

        with patch("remote_skills.cache.disk.os.mkdir", mkdir_then_swap):
            with self.assertRaises(CacheCorruptError):
                self.cache.publish_object(self.cached)

        if sentinel is None:
            self.fail("private object directory creation was not reached")
        self.assertTrue(sentinel.is_file())
        self.assertEqual(
            sentinel.read_text(encoding="utf-8") if sentinel.is_file() else None,
            "external",
        )
        self.assertEqual(
            [path for path in saved_temporary_root.rglob("*") if path.is_file()],
            [],
        )
        self.assertFalse(self.cache.object_path(self.cached.digest).exists())

    def test_invalid_object_metadata_never_reaches_final_path(self) -> None:
        invalid = replace(self.cached, artifact_type=42)

        with self.assertRaises(CacheCorruptError):
            self.cache.publish_object(invalid)

        self.assertFalse(self.cache.object_path(FIXTURE_DIGEST).exists())

    def test_disk_archive_publication_requires_activation_verifier(self) -> None:
        cached = make_archive_object("disk-archive", datetime.now(timezone.utc))

        with self.assertRaises(CacheCorruptError):
            self.cache.publish_object(cached)

        self.assertFalse(self.cache.object_path(cached.digest).exists())

    def test_disk_archive_verifier_runs_on_publication_and_reuse(self) -> None:
        cached = make_archive_object(
            "verified-disk-archive",
            datetime(2026, 8, 25, 10, 0, tzinfo=timezone.utc),
        )
        verified: list[str] = []

        def verify(candidate: CachedObject) -> bool:
            verified.append(candidate.digest)
            return candidate.files == cached.files

        cache = DiskCache(
            self.cache_root,
            touch_on_read=False,
            archive_verifier=verify,
        )
        self.assertEqual(cache.publish_object(cached), cached)
        self.assertEqual(cache.get_object(cached.digest), cached)
        self.assertGreaterEqual(verified.count(cached.digest), 2)

        rejecting_reader = DiskCache(
            self.cache_root,
            touch_on_read=False,
            archive_verifier=lambda candidate: False,
        )
        with self.assertRaises(CacheCorruptError):
            rejecting_reader.get_object(cached.digest)

    def test_archive_file_table_is_sorted_by_utf8_path_bytes(self) -> None:
        cached = make_archive_object(
            "canonical-file-order",
            datetime(2026, 8, 25, 10, 0, tzinfo=timezone.utc),
        )
        reversed_files = dict(reversed(list(cached.files.items())))
        reversed_media_types = dict(reversed(list(cached.media_types.items())))
        cached = replace(
            cached,
            files=reversed_files,
            media_types=reversed_media_types,
        )
        cache = DiskCache(
            self.cache_root,
            touch_on_read=False,
            archive_verifier=lambda candidate: True,
        )

        cache.publish_object(cached)

        metadata = json.loads(
            (cache.object_path(cached.digest) / "object.json").read_text(encoding="utf-8")
        )
        paths = [entry["path"] for entry in metadata["files"]]
        self.assertEqual(paths, sorted(paths, key=lambda path: path.encode("utf-8")))

    def test_noncanonical_archive_file_table_order_is_corruption(self) -> None:
        cached = make_archive_object(
            "noncanonical-file-order",
            datetime(2026, 8, 25, 10, 0, tzinfo=timezone.utc),
        )
        cache = DiskCache(
            self.cache_root,
            touch_on_read=False,
            archive_verifier=lambda candidate: True,
        )
        cache.publish_object(cached)
        metadata_path = cache.object_path(cached.digest) / "object.json"
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        metadata["files"] = list(reversed(metadata["files"]))
        metadata_path.write_text(json.dumps(metadata), encoding="utf-8")

        with self.assertRaises(CacheCorruptError):
            cache.get_object(cached.digest)


class MemoryAndCustomCacheTest(unittest.TestCase):
    def test_portable_path_policy_rejects_c0_and_del_code_points(self) -> None:
        for point in [*range(0x20), 0x7F]:
            with self.subTest(point=point):
                self.assertFalse(
                    base_cache_module.is_portable_cache_path(
                        f"references/guide{chr(point)}.md"
                    )
                )
        for candidate in ("SKILL.md", "references/guide ~.md", "references/café.md"):
            with self.subTest(candidate=candidate):
                self.assertTrue(base_cache_module.is_portable_cache_path(candidate))

    def test_memory_archive_publication_requires_activation_verifier(self) -> None:
        cached = make_archive_object("memory-archive", datetime.now(timezone.utc))

        with self.assertRaises(CacheCorruptError):
            MemoryCache().publish_object(cached)

    def test_memory_archive_verifier_runs_on_publication_and_reuse(self) -> None:
        cached = make_archive_object("verified-memory-archive", datetime.now(timezone.utc))
        calls: list[str] = []

        def verify(candidate: CachedObject) -> bool:
            calls.append(candidate.digest)
            return True

        cache = MemoryCache(archive_verifier=verify)
        published = cache.publish_object(cached)

        self.assertEqual(cache.get_object(cached.digest), published)
        self.assertEqual(published.verified_at.microsecond % 1000, 0)
        self.assertEqual(calls, [cached.digest, cached.digest])

    def test_memory_cache_uses_the_same_immutable_object_semantics(self) -> None:
        source = fixture_object()
        cache = MemoryCache()

        winner = cache.publish_object(source)
        observed = cache.publish_object(
            replace(source, accessed_at=datetime(2035, 1, 1, tzinfo=timezone.utc))
        )

        self.assertEqual(winner, source)
        self.assertEqual(observed, source)
        self.assertEqual(cache.get_object(FIXTURE_DIGEST), source)
        self.assertFalse(hasattr(cache, "root"))

    def test_memory_cache_rejects_digest_mismatch(self) -> None:
        source = fixture_object()
        tampered = replace(
            source,
            artifact=b"unverified bytes",
            files={"SKILL.md": b"unverified bytes"},
        )

        with self.assertRaises(CacheCorruptError):
            MemoryCache().publish_object(tampered)

    def test_memory_cache_rejects_drive_prefixed_file_table_path(self) -> None:
        source = make_archive_object(
            "portable-path-policy",
            datetime(2026, 8, 25, 10, 0, tzinfo=timezone.utc),
        )
        verified: list[str] = []

        def verify(candidate: CachedObject) -> bool:
            # Synthetic bytes exercise cache policy without archive extraction.
            verified.append(candidate.digest)
            return True

        cache = MemoryCache(archive_verifier=verify)
        self.assertEqual(cache.publish_object(source), source)
        self.assertEqual(verified, [source.digest])

        rejected_path = "C:/escape.txt"
        drive_prefixed = replace(
            source,
            files={
                "SKILL.md": source.files["SKILL.md"],
                rejected_path: source.files["references/details.txt"],
            },
            media_types={
                "SKILL.md": source.media_types["SKILL.md"],
                rejected_path: source.media_types["references/details.txt"],
            },
        )
        policy_results: list[tuple[object, bool]] = []
        original_policy = base_cache_module.is_portable_cache_path

        def observe_policy(candidate: object) -> bool:
            accepted = original_policy(candidate)
            policy_results.append((candidate, accepted))
            return accepted

        with patch.object(
            base_cache_module, "is_portable_cache_path", observe_policy
        ):
            with self.assertRaises(CacheCorruptError):
                cache.publish_object(drive_prefixed)

        self.assertIn((rejected_path, False), policy_results)
        self.assertEqual(verified, [source.digest])

    def test_custom_backend_is_structurally_supported(self) -> None:
        class CustomCache:
            def get_catalog(
                self, canonical_url: str, *, confirmed_scope: str | None = None
            ) -> CachedCatalog | None:
                return None

            def get_catalog_state(
                self, canonical_url: str, *, confirmed_scope: str | None = None
            ) -> CatalogState:
                return CatalogState(
                    None,
                    CatalogGeneration(f"sha256:{'0' * 64}"),
                )

            def publish_catalog(self, catalog: CachedCatalog) -> CachedCatalog:
                return catalog

            def replace_catalog(
                self,
                catalog: CachedCatalog,
                *,
                expected_generation: CatalogGeneration,
            ) -> bool:
                return True

            def delete_catalog(
                self,
                canonical_url: str,
                *,
                confirmed_scope: str | None,
                expected_generation: CatalogGeneration,
            ) -> bool:
                return True

            def get_object(self, digest: str) -> CachedObject | None:
                return None

            def publish_object(self, cached: CachedObject) -> CachedObject:
                return cached

            def acquire_lease(
                self,
                digest: str,
                *,
                process_nonce: str,
                session_nonce: str,
                pid: int | None = None,
            ) -> CacheLease:
                now = datetime.now(timezone.utc)
                return CacheLease(digest, pid or 1, process_nonce, session_nonce, now, now)

            def renew_lease(self, lease: CacheLease) -> CacheLease:
                return lease

            def release_lease(self, lease: CacheLease) -> None:
                return None

            def has_live_lease(
                self,
                digest: str,
                *,
                lease_expiry_seconds: int = 120,
            ) -> bool:
                return False

        self.assertIsInstance(CustomCache(), CacheBackend)

    def test_memory_cache_covers_catalog_and_pin_lifecycle(self) -> None:
        catalog = DiskCache(VALID_STATE, touch_on_read=False).get_catalog(FIXTURE_ORIGIN)
        if catalog is None:
            self.fail("checked-in catalog is missing")
        cache = MemoryCache()
        self.assertTrue(hasattr(cache, "publish_catalog"))
        self.assertTrue(hasattr(cache, "acquire_lease"))

        cache.publish_catalog(catalog)
        lease = cache.acquire_lease(
            FIXTURE_DIGEST,
            process_nonce="memory-process",
            session_nonce="memory-session",
            pid=4242,
        )

        self.assertEqual(cache.get_catalog(FIXTURE_ORIGIN), catalog)
        self.assertTrue(cache.has_live_lease(FIXTURE_DIGEST))
        cache.release_lease(lease)
        self.assertFalse(cache.has_live_lease(FIXTURE_DIGEST))

    def test_memory_stale_lease_handle_cannot_release_renewed_generation(self) -> None:
        now = datetime(2026, 8, 25, 10, 0, tzinfo=timezone.utc)
        cache = MemoryCache(clock=lambda: now)
        lease = cache.acquire_lease(
            FIXTURE_DIGEST,
            process_nonce="memory-generation",
            session_nonce="release",
            pid=4242,
        )
        now += timedelta(seconds=1)
        renewed = cache.renew_lease(lease)

        with self.assertRaises(CacheCorruptError):
            cache.release_lease(lease)

        self.assertTrue(cache.has_live_lease(FIXTURE_DIGEST))
        cache.release_lease(renewed)
        self.assertFalse(cache.has_live_lease(FIXTURE_DIGEST))

    def test_memory_catalog_preserves_credential_exclusion(self) -> None:
        catalog = DiskCache(VALID_STATE, touch_on_read=False).get_catalog(FIXTURE_ORIGIN)
        if catalog is None:
            self.fail("checked-in catalog is missing")
        credential_bearing = replace(
            catalog,
            metadata=replace(
                catalog.metadata,
                canonical_url=f"{FIXTURE_ORIGIN}?token=unmistakable-secret-canary",
            ),
        )

        with self.assertRaises(CacheConfigurationError):
            MemoryCache().publish_catalog(credential_bearing)

    def test_object_only_custom_cache_is_not_semantically_complete(self) -> None:
        class ObjectOnlyCache:
            def get_object(self, digest: str) -> CachedObject | None:
                return None

            def publish_object(self, cached: CachedObject) -> CachedObject:
                return cached

        self.assertNotIsInstance(ObjectOnlyCache(), CacheBackend)


class CatalogCacheTest(TemporaryCacheTestCase):
    def test_reads_and_republishes_static_catalog_metadata(self) -> None:
        fixture_cache = DiskCache(VALID_STATE, touch_on_read=False)
        catalog = fixture_cache.get_catalog(FIXTURE_ORIGIN)
        if catalog is None:
            self.fail("checked-in catalog is missing")

        cache = DiskCache(self.cache_root, touch_on_read=False)
        cache.publish_catalog(catalog)

        self.assertEqual(cache.get_catalog(FIXTURE_ORIGIN), catalog)
        fixture_path = fixture_cache.catalog_path(FIXTURE_ORIGIN)
        actual_path = cache.catalog_path(FIXTURE_ORIGIN)
        self.assertEqual(
            (actual_path / "body.json").read_bytes(),
            (fixture_path / "body.json").read_bytes(),
        )
        self.assertEqual(
            (actual_path / "metadata.json").read_bytes(),
            (fixture_path / "metadata.json").read_bytes(),
        )

    def test_credential_bearing_url_is_rejected_without_storage(self) -> None:
        cache = DiskCache(self.cache_root, touch_on_read=False)
        canary = "unmistakable-secret-canary"
        metadata = CatalogMetadata(
            canonical_url=f"https://skills.example.test/.well-known/agent-skills/index.json?token={canary}",
            retrieved_at=datetime(2026, 8, 25, tzinfo=timezone.utc),
            validated_at=datetime(2026, 8, 25, tzinfo=timezone.utc),
        )

        with self.assertRaises(CacheConfigurationError) as raised:
            cache.publish_catalog(CachedCatalog(body=b"{}", metadata=metadata))

        self.assertEqual(raised.exception.code, "configuration_invalid")
        self.assertNotIn(canary, str(raised.exception))
        self.assertFalse(cache.namespace.exists())

    def test_credential_bearing_artifact_url_is_not_cached(self) -> None:
        cache = DiskCache(self.cache_root, touch_on_read=False)
        canary = "unmistakable-secret-canary"
        body = json.dumps(
            {
                "$schema": "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
                "skills": [
                    {
                        "name": "fixture",
                        "description": "fixture",
                        "type": "skill-md",
                        "url": f"artifacts/fixture.md?token={canary}",
                        "digest": FIXTURE_DIGEST,
                    }
                ],
            }
        ).encode()
        metadata = CatalogMetadata(
            canonical_url=FIXTURE_ORIGIN,
            retrieved_at=datetime(2026, 8, 25, tzinfo=timezone.utc),
            validated_at=datetime(2026, 8, 25, tzinfo=timezone.utc),
        )

        with self.assertRaises(CacheConfigurationError) as raised:
            cache.publish_catalog(CachedCatalog(body=body, metadata=metadata))

        self.assertEqual(raised.exception.context, {"field": "catalog_body"})
        self.assertNotIn(canary, str(raised.exception))
        self.assertFalse(cache.namespace.exists())

    def test_unknown_catalog_metadata_field_is_corruption(self) -> None:
        shutil.copytree(VALID_STATE / "cache-v1", self.cache_root / "cache-v1")
        cache = DiskCache(self.cache_root, touch_on_read=False)
        metadata_path = cache.catalog_path(FIXTURE_ORIGIN) / "metadata.json"
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        metadata["unexpected"] = True
        metadata_path.write_text(json.dumps(metadata), encoding="utf-8")

        with self.assertRaises(CacheCorruptError):
            cache.get_catalog(FIXTURE_ORIGIN)

    def test_invalid_catalog_metadata_is_rejected_without_storage(self) -> None:
        fixture = DiskCache(VALID_STATE, touch_on_read=False).get_catalog(FIXTURE_ORIGIN)
        if fixture is None:
            self.fail("checked-in catalog is missing")
        invalid = CachedCatalog(
            body=fixture.body,
            metadata=replace(fixture.metadata, etag=42),
        )
        cache = DiskCache(self.cache_root, touch_on_read=False)

        with self.assertRaises(CacheConfigurationError):
            cache.publish_catalog(invalid)

        self.assertFalse(cache.namespace.exists())

    def test_catalog_publication_exposes_only_complete_raw_generations(self) -> None:
        fixture = DiskCache(VALID_STATE, touch_on_read=False).get_catalog(FIXTURE_ORIGIN)
        if fixture is None:
            self.fail("checked-in catalog is missing")
        cache = DiskCache(self.cache_root, touch_on_read=False)
        cache.publish_catalog(fixture)
        updated = CachedCatalog(
            body=b'{"generation":"updated"}\n',
            metadata=replace(
                fixture.metadata,
                etag='"catalog-v2"',
                retrieved_at=fixture.metadata.retrieved_at + timedelta(minutes=1),
                validated_at=fixture.metadata.validated_at + timedelta(minutes=1),
            ),
        )
        control = Path(self.temporary.name) / "catalog-reader-control"
        control.mkdir()
        ready = control / "ready"
        stop = control / "stop"
        observations_path = control / "observations.jsonl"
        worker = Path(__file__).with_name("catalog_generation_reader.py")
        old_body_hash = hashlib.sha256(fixture.body).hexdigest()
        new_body_hash = hashlib.sha256(updated.body).hexdigest()
        exchange_reached = False
        original_exchange = disk_cache_module._atomic_exchange_directories
        original_windows_publish = DiskCache._windows_publish_catalog_directory

        reader = subprocess.Popen(
            [
                sys.executable,
                str(worker),
                str(SRC_ROOT),
                str(self.cache_root),
                str(ready),
                str(stop),
                str(observations_path),
                FIXTURE_ORIGIN,
                old_body_hash,
                fixture.metadata.etag or "",
                new_body_hash,
                updated.metadata.etag or "",
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )

        def wait_for(path: Path) -> None:
            deadline = time.monotonic() + 5
            while not path.exists():
                if reader.poll() is not None:
                    stdout, stderr = reader.communicate()
                    self.fail(
                        f"catalog reader exited early: {reader.returncode}: "
                        f"{stdout!r} {stderr!r}"
                    )
                if time.monotonic() >= deadline:
                    self.fail(f"catalog reader did not observe {path.name}")
                time.sleep(0.001)

        def exchange_while_reader_runs(
            source_descriptor: int,
            source_name: str,
            destination_descriptor: int,
            destination_name: str,
        ) -> None:
            nonlocal exchange_reached
            exchange_reached = True
            wait_for(control / "old")
            original_exchange(
                source_descriptor,
                source_name,
                destination_descriptor,
                destination_name,
            )
            wait_for(control / "new")

        def publish_while_reader_runs(
            selected_cache: DiskCache,
            private: Path,
            destination: Path,
        ) -> None:
            nonlocal exchange_reached
            exchange_reached = True
            wait_for(control / "old")
            original_windows_publish(selected_cache, private, destination)

        try:
            wait_for(ready)
            if disk_cache_module._windows_mode():
                with patch.object(
                    DiskCache,
                    "_windows_publish_catalog_directory",
                    publish_while_reader_runs,
                ):
                    cache.publish_catalog(updated)
                wait_for(control / "new")
            else:
                with patch(
                    "remote_skills.cache.disk._atomic_exchange_directories",
                    exchange_while_reader_runs,
                ):
                    cache.publish_catalog(updated)
        finally:
            stop.touch()
            try:
                stdout, stderr = reader.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                reader.kill()
                stdout, stderr = reader.communicate()
                self.fail(f"catalog reader did not stop: {stdout!r} {stderr!r}")

        observations = [
            json.loads(line)
            for line in observations_path.read_text(encoding="utf-8").splitlines()
        ]
        self.assertTrue(exchange_reached)
        self.assertEqual(reader.returncode, 0, (stdout, stderr))
        self.assertGreaterEqual(len(observations), 2)
        self.assertIn("old", observations)
        self.assertIn("new", observations)
        self.assertTrue(
            all(generation in {"old", "new"} for generation in observations),
            observations,
        )
        self.assertEqual(cache.get_catalog(FIXTURE_ORIGIN), updated)
        self.assertFalse((cache.namespace / "catalog-claims").exists())

    def test_catalog_reader_retries_reclaimed_exchanged_generation(self) -> None:
        fixture = DiskCache(VALID_STATE, touch_on_read=False).get_catalog(FIXTURE_ORIGIN)
        if fixture is None:
            self.fail("checked-in catalog is missing")
        cache = DiskCache(self.cache_root, touch_on_read=False)
        cache.publish_catalog(fixture)
        updated = CachedCatalog(
            body=b'{"generation":"updated-during-read"}\n',
            metadata=replace(
                fixture.metadata,
                etag='"catalog-v2"',
                retrieved_at=fixture.metadata.retrieved_at + timedelta(minutes=1),
                validated_at=fixture.metadata.validated_at + timedelta(minutes=1),
            ),
        )
        original_read = disk_cache_module._read_regular_file
        exchanged = False

        def publish_after_metadata(
            directory_descriptor: int | None,
            directory_path: Path,
            name: str,
            **kwargs,
        ) -> bytes:
            nonlocal exchanged
            content = original_read(
                directory_descriptor,
                directory_path,
                name,
                **kwargs,
            )
            if (
                not exchanged
                and name == "metadata.json"
                and kwargs.get("descriptor_anchored")
            ):
                exchanged = True
                cache.publish_catalog(updated)
            return content

        with patch(
            "remote_skills.cache.disk._read_regular_file",
            publish_after_metadata,
        ):
            observed = cache.get_catalog(FIXTURE_ORIGIN)

        self.assertTrue(exchanged)
        self.assertEqual(observed, updated)

    def test_catalog_reader_reports_availability_under_continuous_valid_churn(
        self,
    ) -> None:
        fixture = DiskCache(VALID_STATE, touch_on_read=False).get_catalog(FIXTURE_ORIGIN)
        if fixture is None:
            self.fail("checked-in catalog is missing")
        cache = DiskCache(self.cache_root, touch_on_read=False)
        cache.publish_catalog(fixture)
        updated = CachedCatalog(
            body=b'{"generation":"continuous-update"}\n',
            metadata=replace(
                fixture.metadata,
                etag='"catalog-continuous"',
                retrieved_at=fixture.metadata.retrieved_at + timedelta(minutes=1),
                validated_at=fixture.metadata.validated_at + timedelta(minutes=1),
            ),
        )
        original_read = disk_cache_module._read_regular_file
        exchanges = 0

        def publish_after_every_metadata_generation(
            directory_descriptor: int | None,
            directory_path: Path,
            name: str,
            **kwargs,
        ) -> bytes:
            nonlocal exchanges
            content = original_read(
                directory_descriptor,
                directory_path,
                name,
                **kwargs,
            )
            if name == "metadata.json" and kwargs.get("descriptor_anchored"):
                exchanges += 1
                cache.publish_catalog(updated)
            return content

        with patch(
            "remote_skills.cache.disk._read_regular_file",
            publish_after_every_metadata_generation,
        ):
            observed = cache.get_catalog(FIXTURE_ORIGIN)

        self.assertIsNone(observed)
        self.assertGreaterEqual(exchanges, 2)
        self.assertEqual(cache.get_catalog(FIXTURE_ORIGIN), updated)

    def test_zero_byte_bound_does_not_leave_reusable_catalog_state(self) -> None:
        catalog = DiskCache(VALID_STATE, touch_on_read=False).get_catalog(FIXTURE_ORIGIN)
        if catalog is None:
            self.fail("checked-in catalog is missing")
        cache = DiskCache(
            self.cache_root,
            touch_on_read=False,
            max_bytes=0,
            max_age_seconds=0,
        )

        cache.publish_catalog(catalog)

        self.assertIsNone(cache.get_catalog(FIXTURE_ORIGIN))

    def test_catalog_read_updates_lru_time_through_open_generation(self) -> None:
        catalog = DiskCache(VALID_STATE, touch_on_read=False).get_catalog(FIXTURE_ORIGIN)
        if catalog is None:
            self.fail("checked-in catalog is missing")
        now = datetime(2030, 1, 1, tzinfo=timezone.utc)
        cache = DiskCache(
            self.cache_root,
            touch_on_read=True,
            clock=lambda: now,
            max_age_seconds=10**9,
        )
        cache.publish_catalog(catalog)
        path = cache.catalog_path(FIXTURE_ORIGIN)
        old = datetime(2020, 1, 1, tzinfo=timezone.utc).timestamp()
        os.utime(path, (old, old))

        self.assertEqual(cache.get_catalog(FIXTURE_ORIGIN), catalog)

        self.assertEqual(path.stat().st_mtime_ns, int(now.timestamp() * 1_000_000_000))

    def test_windows_catalog_commit_rejects_replaced_public_parent(self) -> None:
        catalog = DiskCache(VALID_STATE, touch_on_read=False).get_catalog(FIXTURE_ORIGIN)
        if catalog is None:
            self.fail("checked-in catalog is missing")
        cache = DiskCache(self.cache_root, touch_on_read=False)
        destination_parent = cache.catalog_path(FIXTURE_ORIGIN).parent
        saved_parent = Path(self.temporary.name) / "saved-catalog-parent"

        with (
            patch("remote_skills.cache.disk._windows_mode", return_value=True),
            replaced_windows_chain_parent(destination_parent, saved_parent) as replacement,
        ):
            with self.assertRaises(CacheCorruptError):
                cache.publish_catalog(catalog)

        self.assertTrue(replacement["swapped"])
        self.assertEqual(list(destination_parent.iterdir()), [])

    def test_catalog_commit_cleanup_does_not_follow_replaced_tmp_parent(self) -> None:
        if disk_cache_module._windows_mode():
            self.skipTest(
                "Windows has no descriptor-relative catalog cleanup; path-and-handle parent "
                "replacement is covered separately"
            )
        catalog = DiskCache(VALID_STATE, touch_on_read=False).get_catalog(FIXTURE_ORIGIN)
        if catalog is None:
            self.fail("checked-in catalog is missing")
        cache = DiskCache(self.cache_root, touch_on_read=False)
        cache.publish_catalog(catalog)
        updated = replace(catalog, body=b'{"generation":"updated"}\n')
        temporary_root = cache.namespace / "tmp"
        saved_temporary_root = Path(self.temporary.name) / "saved-catalog-tmp"
        external = Path(self.temporary.name) / "external-catalog-tmp"
        external.mkdir()
        original_exchange = __import__(
            "remote_skills.cache.disk",
            fromlist=["_atomic_exchange_directories"],
        )._atomic_exchange_directories
        sentinel: Path | None = None

        def swap_tmp_before_exchange(
            source_descriptor: int,
            source_name: str,
            destination_descriptor: int,
            destination_name: str,
        ) -> None:
            nonlocal sentinel
            original_rename = os.rename
            original_rename(temporary_root, saved_temporary_root)
            external_private = external / source_name
            external_private.mkdir()
            sentinel = external_private / "do-not-delete.txt"
            sentinel.write_text("external", encoding="utf-8")
            temporary_root.symlink_to(external, target_is_directory=True)
            original_exchange(
                source_descriptor,
                source_name,
                destination_descriptor,
                destination_name,
            )

        with patch(
            "remote_skills.cache.disk._atomic_exchange_directories",
            swap_tmp_before_exchange,
        ):
            with self.assertRaises(CacheCorruptError):
                cache.publish_catalog(updated)

        if sentinel is None:
            self.fail("catalog generation exchange was not reached")
        self.assertEqual(sentinel.read_text(encoding="utf-8"), "external")

    def test_catalog_private_construction_stays_bound_to_anchored_tmp_generation(self) -> None:
        if disk_cache_module._windows_mode():
            self.skipTest(
                "Windows has no descriptor-relative catalog construction; path-and-handle "
                "parent replacement is covered separately"
            )
        fixture = DiskCache(VALID_STATE, touch_on_read=False).get_catalog(FIXTURE_ORIGIN)
        if fixture is None:
            self.fail("checked-in catalog is missing")
        cache = DiskCache(self.cache_root, touch_on_read=False)
        temporary_root = cache.namespace / "tmp"
        saved_temporary_root = Path(self.temporary.name) / "saved-catalog-construction-tmp"
        external = Path(self.temporary.name) / "external-catalog-construction-tmp"
        external.mkdir()
        original_mkdir = os.mkdir
        sentinel: Path | None = None

        def mkdir_then_swap(
            path: str | bytes | os.PathLike[str],
            mode: int = 0o777,
            *,
            dir_fd: int | None = None,
        ) -> None:
            nonlocal sentinel
            if dir_fd is None:
                original_mkdir(path, mode)
            else:
                original_mkdir(path, mode, dir_fd=dir_fd)
            name = Path(path).name
            absolute_parent = Path(path).parent if Path(path).is_absolute() else None
            descriptor_parent_matches = (
                dir_fd is not None
                and temporary_root.exists()
                and os.path.samestat(os.fstat(dir_fd), temporary_root.stat())
            )
            if (
                sentinel is None
                and name.startswith("catalog-python-")
                and (absolute_parent == temporary_root or descriptor_parent_matches)
            ):
                temporary_root.rename(saved_temporary_root)
                external_private = external / name
                external_private.mkdir()
                sentinel = external_private / "do-not-delete.txt"
                sentinel.write_text("external", encoding="utf-8")
                temporary_root.symlink_to(external, target_is_directory=True)

        with patch("remote_skills.cache.disk.os.mkdir", mkdir_then_swap):
            with self.assertRaises(CacheCorruptError):
                cache.publish_catalog(fixture)

        if sentinel is None:
            self.fail("private catalog directory creation was not reached")
        self.assertTrue(sentinel.is_file())
        self.assertEqual(
            sentinel.read_text(encoding="utf-8") if sentinel.is_file() else None,
            "external",
        )
        self.assertEqual(
            {path.name for path in saved_temporary_root.iterdir()},
            {"coordination-v1", "catalog-generations-v1"},
        )
        self.assertFalse(cache.catalog_path(FIXTURE_ORIGIN).exists())


class RecoveryAndEvictionTest(TemporaryCacheTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.now = datetime(2026, 8, 25, 10, 0, 45, tzinfo=timezone.utc)
        self.liveness: dict[int, bool] = {4242: True, 999999: False}

    def cache(self, *, touch_on_read: bool = False) -> DiskCache:
        return DiskCache(
            self.cache_root,
            touch_on_read=touch_on_read,
            clock=lambda: self.now,
            process_is_alive=lambda pid, process_nonce: self.liveness.get(pid, False),
        )

    def test_crashed_lease_is_reclaimed_without_deleting_object(self) -> None:
        shutil.copytree(CRASHED_LEASE_STATE / "cache-v1", self.cache_root / "cache-v1")
        cache = self.cache()

        removed = cache.cleanup_stale_leases(lease_expiry_seconds=120)

        self.assertEqual(removed, 1)
        self.assertTrue(cache.object_path(FIXTURE_DIGEST).is_dir())
        self.assertIsNotNone(cache.get_object(FIXTURE_DIGEST))

    def test_stale_cleanup_records_generation_before_clock_regression(self) -> None:
        frozen = datetime(2026, 8, 25, 10, 0, tzinfo=timezone.utc)
        current = frozen

        def cache() -> DiskCache:
            return DiskCache(
                self.cache_root,
                touch_on_read=False,
                clock=lambda: current,
                process_is_alive=lambda pid, process_nonce: False,
                process_identity=lambda pid: "cleanup-generation-process",
            )

        cleanup_cache = cache()
        original = cleanup_cache.acquire_lease(
            FIXTURE_DIGEST,
            process_nonce="cleanup-generation-process",
            session_nonce="same-session",
            pid=4242,
        )
        generation_path = (
            cleanup_cache._lease_directory(FIXTURE_DIGEST)
            / ".lease-generation.json"
        )
        generation_path.unlink()
        current += timedelta(hours=1)

        self.assertEqual(
            cleanup_cache.cleanup_stale_leases(lease_expiry_seconds=1),
            1,
        )

        current = frozen
        successor_cache = cache()
        successor = successor_cache.acquire_lease(
            FIXTURE_DIGEST,
            process_nonce="cleanup-generation-process",
            session_nonce="same-session",
            pid=4242,
        )
        self.assertNotEqual(successor.lease_nonce, original.lease_nonce)
        with self.assertRaises(CacheCorruptError):
            cleanup_cache.release_lease(original)
        self.assertTrue(successor_cache.has_live_lease(FIXTURE_DIGEST))
        successor_cache.release_lease(successor)

    def test_reused_pid_does_not_keep_an_expired_process_nonce_live(self) -> None:
        shutil.copytree(CRASHED_LEASE_STATE / "cache-v1", self.cache_root / "cache-v1")
        lease_path = next((self.cache_root / "cache-v1/leases").glob("*/*.json"))
        lease = json.loads(lease_path.read_text(encoding="utf-8"))
        lease["pid"] = 4242
        lease["process_nonce"] = "process-before-pid-reuse"
        lease_path.write_text(json.dumps(lease), encoding="utf-8")
        cache = self.cache()

        def identity_aware_liveness(pid: int, *process_nonces: str) -> bool:
            self.assertEqual(pid, 4242)
            return not process_nonces or process_nonces[0] == "process-after-pid-reuse"

        cache._injected_process_is_alive = identity_aware_liveness

        removed = cache.cleanup_stale_leases(lease_expiry_seconds=120)

        self.assertEqual(removed, 1)

    def test_registered_process_nonce_detects_process_start_replacement(self) -> None:
        cache = DiskCache(
            self.cache_root,
            touch_on_read=False,
            clock=lambda: self.now,
        )
        cache._process_identity = lambda pid: "process-start-one"
        lease = cache.acquire_lease(
            FIXTURE_DIGEST,
            process_nonce="registered-process",
            session_nonce="session-test",
            pid=os.getpid(),
        )
        self.now += timedelta(minutes=5)
        self.assertTrue(cache.has_live_lease(FIXTURE_DIGEST, lease_expiry_seconds=120))

        cache._process_identity = lambda pid: "process-start-two"

        self.assertFalse(cache.has_live_lease(FIXTURE_DIGEST, lease_expiry_seconds=120))
        cache.release_lease(lease)

    def test_registered_peer_liveness_is_conservative_only_when_indeterminate(
        self,
    ) -> None:
        peer_pid = 4242

        def prepare(
            label: str,
        ) -> tuple[DiskCache, CachedObject, Callable[[str | None], None]]:
            root = Path(self.temporary.name) / label
            peer_identity: str | None = "peer-process-start"

            def identity(pid: int) -> str | None:
                if pid == peer_pid:
                    return peer_identity
                return "cleanup-process-start"

            cache = DiskCache(
                root,
                touch_on_read=False,
                clock=lambda: self.now,
                process_identity=identity,
            )
            candidate = make_skill_object(label, self.now - timedelta(minutes=10))
            cache.publish_object(candidate)
            cache.acquire_lease(
                candidate.digest,
                process_nonce="registered-peer",
                session_nonce="pinned-session",
                pid=peer_pid,
            )
            self.now += timedelta(minutes=5)

            def set_peer_identity(value: str | None) -> None:
                nonlocal peer_identity
                peer_identity = value

            return cache, candidate, set_peer_identity

        uncertain, uncertain_object, set_uncertain_identity = prepare(
            "unreadable-peer-identity"
        )
        set_uncertain_identity(None)
        with patch("remote_skills.cache.disk.os.kill", return_value=None):
            self.assertTrue(
                uncertain.has_live_lease(
                    uncertain_object.digest,
                    lease_expiry_seconds=1,
                )
            )
            self.assertEqual(
                uncertain.cleanup_stale_leases(lease_expiry_seconds=1),
                0,
            )
            self.assertEqual(
                uncertain.evict(
                    max_bytes=0,
                    max_age_seconds=0,
                    lease_expiry_seconds=1,
                ).removed_digests,
                (),
            )
        self.assertIsNotNone(uncertain.get_object(uncertain_object.digest))

        reused, reused_object, set_reused_identity = prepare("confirmed-peer-reuse")
        set_reused_identity("replacement-process-start")
        with patch(
            "remote_skills.cache.disk.os.kill",
            side_effect=AssertionError("PID probe must not override definite reuse"),
        ):
            self.assertFalse(
                reused.has_live_lease(reused_object.digest, lease_expiry_seconds=1)
            )
            self.assertEqual(reused.cleanup_stale_leases(lease_expiry_seconds=1), 1)
            self.assertEqual(
                reused.evict(
                    max_bytes=0,
                    max_age_seconds=0,
                    lease_expiry_seconds=1,
                ).removed_digests,
                (reused_object.digest,),
            )

        dead, dead_object, set_dead_identity = prepare("confirmed-peer-death")
        set_dead_identity(None)
        with patch(
            "remote_skills.cache.disk.os.kill",
            side_effect=ProcessLookupError,
        ):
            self.assertFalse(dead.has_live_lease(dead_object.digest, lease_expiry_seconds=1))
            self.assertEqual(dead.cleanup_stale_leases(lease_expiry_seconds=1), 1)
            self.assertEqual(
                dead.evict(
                    max_bytes=0,
                    max_age_seconds=0,
                    lease_expiry_seconds=1,
                ).removed_digests,
                (dead_object.digest,),
            )

    def test_indeterminate_windows_peer_liveness_never_uses_os_kill(self) -> None:
        peer_identity: str | None = "windows-peer-start"
        cache = DiskCache(
            self.cache_root,
            touch_on_read=False,
            clock=lambda: self.now,
            process_identity=lambda pid: peer_identity,
        )
        cache.acquire_lease(
            FIXTURE_DIGEST,
            process_nonce="windows-registered-peer",
            session_nonce="windows-session",
            pid=4242,
        )
        peer_identity = None

        with (
            patch("remote_skills.cache.disk._windows_mode", return_value=True),
            patch(
                "remote_skills.cache.disk._windows_pid_is_alive",
                return_value=None,
                create=True,
            ) as windows_probe,
            patch("remote_skills.cache.disk.os.kill", return_value=None) as unsafe_kill,
        ):
            self.assertTrue(
                cache._registered_process_is_alive(
                    4242,
                    "windows-registered-peer",
                    FIXTURE_DIGEST,
                )
            )

        windows_probe.assert_called_once_with(4242)
        unsafe_kill.assert_not_called()

    def test_oversized_platform_pid_probe_failure_is_indeterminate(self) -> None:
        peer_pid = 2**53 - 1
        peer_identity: str | None = "large-pid-peer-start"
        cache = DiskCache(
            self.cache_root,
            touch_on_read=False,
            clock=lambda: self.now,
            process_identity=lambda pid: peer_identity,
        )
        cache.acquire_lease(
            FIXTURE_DIGEST,
            process_nonce="large-pid-registered-peer",
            session_nonce="large-pid-session",
            pid=peer_pid,
        )
        peer_identity = None

        with patch(
            "remote_skills.cache.disk.os.kill",
            side_effect=OverflowError("platform pid_t overflow"),
        ):
            self.assertTrue(
                cache._registered_process_is_alive(
                    peer_pid,
                    "large-pid-registered-peer",
                    FIXTURE_DIGEST,
                )
            )
        with (
            patch("remote_skills.cache.disk._windows_mode", return_value=True),
            patch(
                "remote_skills.cache.disk._windows_pid_is_alive",
                side_effect=OverflowError("Windows DWORD overflow"),
            ),
        ):
            self.assertTrue(disk_cache_module._pid_may_be_alive(peer_pid))

        def identity_probe_overflow(pid: int) -> str | None:
            raise OverflowError("platform identity probe overflow")

        cache._process_identity = identity_probe_overflow
        with patch("remote_skills.cache.disk.os.kill", return_value=None):
            self.assertTrue(
                cache._registered_process_is_alive(
                    peer_pid,
                    "large-pid-registered-peer",
                    FIXTURE_DIGEST,
                )
            )

    def test_stale_lease_generation_cannot_overwrite_current_renewal(self) -> None:
        cache = self.cache()
        lease = cache.acquire_lease(
            FIXTURE_DIGEST,
            process_nonce="renewal-process",
            session_nonce="renewal-session",
            pid=4242,
        )
        self.now += timedelta(seconds=1)
        renewed = cache.renew_lease(lease)
        self.now += timedelta(seconds=1)

        with self.assertRaises(CacheCorruptError):
            cache.renew_lease(lease)

        lease_path = cache._lease_path(renewed)
        persisted = json.loads(lease_path.read_text(encoding="utf-8"))
        self.assertEqual(
            datetime.fromisoformat(persisted["renewed_at"].replace("Z", "+00:00")),
            renewed.renewed_at,
        )

    def test_lease_generations_return_exact_persisted_millisecond_timestamps(self) -> None:
        current = datetime(2026, 8, 25, 10, 0, 0, 123456, tzinfo=timezone.utc)
        cache = DiskCache(
            self.cache_root,
            touch_on_read=False,
            clock=lambda: current,
            process_is_alive=lambda pid, process_nonce: True,
            process_identity=lambda pid: "lease-timestamp-process",
        )
        lease = cache.acquire_lease(
            FIXTURE_DIGEST,
            process_nonce="timestamp-process",
            session_nonce="timestamp-session",
            pid=4242,
        )
        current += timedelta(microseconds=1111)
        try:
            first = cache.renew_lease(lease)
            current += timedelta(microseconds=1111)
            second = cache.renew_lease(first)
            cache.release_lease(second)
        except CacheCorruptError as error:
            self.fail(f"persisted lease generation did not round-trip: {error}")

        self.assertEqual(lease.created_at.microsecond, 123000)
        self.assertEqual(lease.renewed_at.microsecond, 123000)
        self.assertEqual(first.renewed_at.microsecond, 124000)
        self.assertEqual(second.renewed_at.microsecond, 125000)
        self.assertFalse(cache.has_live_lease(FIXTURE_DIGEST))

    def test_concurrent_renewals_commit_only_one_lease_generation(self) -> None:
        base = self.now

        def clock() -> datetime:
            if threading.current_thread().name == "renew-one":
                return base + timedelta(seconds=1)
            if threading.current_thread().name == "renew-two":
                return base + timedelta(seconds=2)
            return base

        cache = DiskCache(
            self.cache_root,
            touch_on_read=False,
            clock=clock,
            process_is_alive=lambda pid, process_nonce: True,
        )
        lease = cache.acquire_lease(
            FIXTURE_DIGEST,
            process_nonce="concurrent-renewal",
            session_nonce="one-generation",
            pid=4242,
        )
        lease_path = cache._lease_path(lease)
        barrier = threading.Barrier(2)
        original_guard = DiskCache._platform_mutation_guard
        contenders: list[str] = []
        successes: list[CacheLease] = []
        failures: list[BaseException] = []

        @contextmanager
        def wait_before_acquiring_guard(backend: DiskCache):
            name = threading.current_thread().name
            if backend is cache and name in {"renew-one", "renew-two"} and name not in contenders:
                contenders.append(name)
                # Synchronize before the first lock: the platform guard itself
                # is exclusive on Windows, before the digest mutation gate.
                barrier.wait(timeout=2)
            with original_guard(backend):
                yield

        def renew() -> None:
            try:
                successes.append(cache.renew_lease(lease))
            except BaseException as error:
                failures.append(error)

        with patch.object(DiskCache, "_platform_mutation_guard", wait_before_acquiring_guard):
            workers = [
                threading.Thread(target=renew, name="renew-one"),
                threading.Thread(target=renew, name="renew-two"),
            ]
            try:
                for worker in workers:
                    worker.start()
                for worker in workers:
                    worker.join(timeout=3)
            finally:
                barrier.abort()
                for worker in workers:
                    if worker.ident is not None:
                        worker.join(timeout=3)

        self.assertTrue(all(not worker.is_alive() for worker in workers))
        self.assertCountEqual(contenders, ["renew-one", "renew-two"])
        self.assertEqual(len(successes), 1)
        self.assertEqual(len(failures), 1)
        self.assertIsInstance(failures[0], CacheCorruptError)
        persisted = json.loads(lease_path.read_text(encoding="utf-8"))
        self.assertEqual(persisted["lease_nonce"], lease.lease_nonce)
        self.assertEqual(
            datetime.fromisoformat(persisted["renewed_at"].replace("Z", "+00:00")),
            successes[0].renewed_at,
        )
        self.assertGreater(successes[0].renewed_at, lease.renewed_at)

    def test_renewal_waits_for_eviction_claim_and_cannot_recreate_orphan_pin(self) -> None:
        cache = self.cache()
        candidate = make_skill_object("renew-during-eviction", self.now - timedelta(minutes=10))
        cache.publish_object(candidate)
        lease = cache.acquire_lease(
            candidate.digest,
            process_nonce="renew-eviction",
            session_nonce="serialized",
            pid=4242,
        )
        self.now += timedelta(minutes=10)
        self.liveness[4242] = False
        original_remove_tree = __import__(
            "remote_skills.cache.disk",
            fromlist=["_remove_tree_at"],
        )._remove_tree_at
        removal_started = threading.Event()
        allow_removal = threading.Event()
        renewal_finished = threading.Event()
        renewal_results: list[CacheLease] = []
        renewal_errors: list[BaseException] = []
        eviction_errors: list[BaseException] = []

        def pause_removal(*args: object, **kwargs: object) -> None:
            removal_started.set()
            if not allow_removal.wait(timeout=2):
                raise AssertionError("eviction removal was not released")
            original_remove_tree(*args, **kwargs)

        def renew() -> None:
            try:
                renewal_results.append(cache.renew_lease(lease))
            except BaseException as error:
                renewal_errors.append(error)
            finally:
                renewal_finished.set()

        def evict() -> None:
            try:
                cache.evict(max_bytes=0, max_age_seconds=0)
            except BaseException as error:
                eviction_errors.append(error)

        with patch("remote_skills.cache.disk._remove_tree_at", pause_removal):
            eviction = threading.Thread(
                target=evict,
                name="eviction-owner",
            )
            eviction.start()
            self.assertTrue(removal_started.wait(timeout=2))
            renewal = threading.Thread(target=renew, name="renewal-contender")
            renewal.start()
            blocked_during_eviction = not renewal_finished.wait(timeout=0.1)
            allow_removal.set()
            eviction.join(timeout=3)
            renewal.join(timeout=3)

        self.assertFalse(eviction.is_alive())
        self.assertFalse(renewal.is_alive())
        self.assertEqual(eviction_errors, [])
        self.assertTrue(blocked_during_eviction)
        self.assertEqual(renewal_results, [])
        self.assertEqual(len(renewal_errors), 1)
        self.assertIsInstance(renewal_errors[0], CacheCorruptError)
        self.assertFalse(cache.object_path(candidate.digest).exists())
        self.assertFalse(cache.has_live_lease(candidate.digest))

    def test_stale_cleanup_never_deletes_a_successfully_renewed_generation(self) -> None:
        cache = self.cache()
        lease = cache.acquire_lease(
            FIXTURE_DIGEST,
            process_nonce="cleanup-renewal",
            session_nonce="serialized",
            pid=4242,
        )
        self.now += timedelta(minutes=10)
        self.liveness[4242] = False
        original_unlink = __import__(
            "remote_skills.cache.disk",
            fromlist=["_unlink_at"],
        )._unlink_at
        renewal_finished = threading.Event()
        renewal_results: list[CacheLease] = []
        renewal_errors: list[BaseException] = []
        blocked_during_cleanup: list[bool] = []
        worker: threading.Thread | None = None

        def renew() -> None:
            try:
                renewal_results.append(cache.renew_lease(lease))
            except BaseException as error:
                renewal_errors.append(error)
            finally:
                renewal_finished.set()

        def start_renewal_before_unlink(
            descriptor: int | None,
            directory: Path,
            name: str,
        ) -> None:
            nonlocal worker
            if name.startswith("cleanup-renewal-serialized-") and worker is None:
                worker = threading.Thread(target=renew, name="cleanup-renewal-contender")
                worker.start()
                blocked_during_cleanup.append(not renewal_finished.wait(timeout=0.1))
            original_unlink(descriptor, directory, name)

        with patch("remote_skills.cache.disk._unlink_at", start_renewal_before_unlink):
            removed = cache.cleanup_stale_leases(lease_expiry_seconds=120)

        if worker is None:
            self.fail("stale lease removal was not reached")
        worker.join(timeout=3)
        self.assertFalse(worker.is_alive())
        self.assertEqual(blocked_during_cleanup, [True])
        self.assertEqual(removed, 1)
        self.assertFalse(renewal_results)
        self.assertEqual(len(renewal_errors), 1)
        self.assertIsInstance(renewal_errors[0], CacheCorruptError)
        self.assertFalse(cache.has_live_lease(FIXTURE_DIGEST))

    def test_lease_is_published_only_after_complete_write(self) -> None:
        cache = self.cache()
        final_prefix = "atomic-process-atomic-session-"
        original_write = __import__(
            "remote_skills.cache.disk",
            fromlist=["_write_file_at"],
        )._write_file_at

        def crash_direct_lease_write(
            descriptor: int | None,
            directory: Path,
            name: str,
            content: bytes,
        ) -> None:
            if name.startswith(final_prefix):
                original_write(descriptor, directory, name, b'{"schema":')
                raise OSError("simulated lease writer crash")
            original_write(descriptor, directory, name, content)

        with patch(
            "remote_skills.cache.disk._write_file_at",
            crash_direct_lease_write,
        ):
            lease = cache.acquire_lease(
                FIXTURE_DIGEST,
                process_nonce="atomic-process",
                session_nonce="atomic-session",
                pid=4242,
            )

        self.assertEqual(lease.process_nonce, "atomic-process")
        lease_path = cache._lease_path(lease)
        self.assertEqual(json.loads(lease_path.read_bytes())["process_nonce"], "atomic-process")

    def test_windows_fallback_supports_lease_lifecycle(self) -> None:
        cache = self.cache()
        cache._process_identity = lambda pid: "windows-process-start"

        with (
            patch("remote_skills.cache.disk.sys.platform", "win32"),
            patch("remote_skills.cache.disk.os.supports_dir_fd", set()),
            patch("remote_skills.cache.disk.os.supports_fd", set()),
            patch(
                "remote_skills.cache.disk._open_directory",
                windows_directory_without_descriptor,
            ),
        ):
            lease = cache.acquire_lease(
                FIXTURE_DIGEST,
                process_nonce="windows-process",
                session_nonce="windows-session",
                pid=4242,
            )
            self.now += timedelta(seconds=1)
            renewed = cache.renew_lease(lease)
            self.assertTrue(cache.has_live_lease(FIXTURE_DIGEST))
            cache.release_lease(renewed)

        self.assertFalse(cache.has_live_lease(FIXTURE_DIGEST))

    def test_windows_fallback_supports_publication_catalog_and_eviction(self) -> None:
        cache = self.cache()
        cache._process_identity = lambda pid: "windows-process-start"
        candidate = make_skill_object("windows-fallback", self.now - timedelta(minutes=10))
        catalog = DiskCache(VALID_STATE, touch_on_read=False).get_catalog(FIXTURE_ORIGIN)
        if catalog is None:
            self.fail("checked-in catalog is missing")
        updated_catalog = replace(
            catalog,
            metadata=replace(
                catalog.metadata,
                retrieved_at=catalog.metadata.retrieved_at + timedelta(seconds=1),
                validated_at=catalog.metadata.validated_at + timedelta(seconds=1),
            ),
        )

        with (
            patch("remote_skills.cache.disk.sys.platform", "win32"),
            patch("remote_skills.cache.disk.os.supports_dir_fd", set()),
            patch("remote_skills.cache.disk.os.supports_fd", set()),
            patch(
                "remote_skills.cache.disk._open_directory",
                windows_directory_without_descriptor,
            ),
        ):
            self.assertEqual(cache.publish_object(candidate), candidate)
            self.assertEqual(cache.publish_catalog(catalog), catalog)
            self.assertEqual(cache.publish_catalog(updated_catalog), updated_catalog)
            self.assertEqual(cache.get_catalog(FIXTURE_ORIGIN), updated_catalog)
            result = cache.evict(max_bytes=0, max_age_seconds=0)

        self.assertEqual(result.removed_digests, (candidate.digest,))
        self.assertIsNone(cache.get_object(candidate.digest))
        self.assertIsNone(cache.get_catalog(FIXTURE_ORIGIN))

    def test_windows_fallback_reads_present_catalog_generation(self) -> None:
        catalog = DiskCache(VALID_STATE, touch_on_read=False).get_catalog(FIXTURE_ORIGIN)
        if catalog is None:
            self.fail("checked-in catalog is missing")
        cache = self.cache()
        cache._process_identity = lambda pid: "windows-process-start"
        cache.publish_catalog(catalog)

        with (
            patch("remote_skills.cache.disk.sys.platform", "win32"),
            patch("remote_skills.cache.disk.os.supports_dir_fd", set()),
            patch("remote_skills.cache.disk.os.supports_fd", set()),
            patch(
                "remote_skills.cache.disk._open_directory",
                windows_directory_without_descriptor,
            ),
        ):
            state = cache.get_catalog_state(FIXTURE_ORIGIN)

        self.assertEqual(state.catalog, catalog)
        self.assertRegex(state.generation.token, r"^sha256:[0-9a-f]{64}$")

    def test_stale_temporary_cleanup_ignores_unknown_layout(self) -> None:
        shutil.copytree(PARTIAL_WRITER_STATE / "cache-v1", self.cache_root / "cache-v1")
        shutil.copytree(UNKNOWN_LAYOUT_STATE / "cache-v2", self.cache_root / "cache-v2")
        stale = self.now - timedelta(hours=1)
        timestamp = stale.timestamp()
        for path in (self.cache_root / "cache-v1" / "tmp").rglob("*"):
            os.utime(path, (timestamp, timestamp))
        os.utime(self.cache_root / "cache-v1" / "tmp", (timestamp, timestamp))
        cache = self.cache()

        removed = cache.cleanup_stale_temporaries(max_age_seconds=120)

        self.assertEqual(removed, 1)
        self.assertEqual(list((cache.namespace / "tmp").iterdir()), [])
        self.assertEqual(
            (self.cache_root / "cache-v2/DO-NOT-TOUCH.txt").read_text(encoding="utf-8"),
            "Opaque future cache namespace. A cache-v1 client must leave these bytes untouched.\n",
        )

    def test_stale_temporary_cleanup_does_not_follow_replaced_parent(self) -> None:
        shutil.copytree(PARTIAL_WRITER_STATE / "cache-v1", self.cache_root / "cache-v1")
        cache = self.cache()
        temporary_root = cache.namespace / "tmp"
        stale = (self.now - timedelta(hours=1)).timestamp()
        for path in temporary_root.rglob("*"):
            os.utime(path, (stale, stale))
        saved_root = Path(self.temporary.name) / "saved-stale-tmp"
        external_root = Path(self.temporary.name) / "external-stale-tmp"
        candidate_name = next(temporary_root.iterdir()).name
        external_candidate = external_root / candidate_name
        external_candidate.mkdir(parents=True)
        sentinel = external_candidate / "do-not-delete.txt"
        sentinel.write_text("external", encoding="utf-8")
        os.utime(external_candidate, (stale, stale))
        original_iterdir = Path.iterdir
        original_listdir = os.listdir
        original_scandir = os.scandir
        swapped = False

        def swap_if_temporary_root(path: str | bytes | os.PathLike[str] | int) -> None:
            nonlocal swapped
            matches_temporary_root = path == temporary_root
            if isinstance(path, int):
                matches_temporary_root = os.path.samestat(
                    os.fstat(path),
                    temporary_root.stat(),
                )
            if matches_temporary_root and not swapped:
                temporary_root.rename(saved_root)
                temporary_root.symlink_to(external_root, target_is_directory=True)
                swapped = True

        def iterate_then_swap(path: Path):
            entries = list(original_iterdir(path))
            swap_if_temporary_root(path)
            return iter(entries)

        def list_then_swap(path: str | bytes | os.PathLike[str] | int) -> list[str]:
            names = original_listdir(path)
            swap_if_temporary_root(path)
            return names

        def scan_then_swap(path: str | bytes | os.PathLike[str] | int):
            entries = original_scandir(path)
            swap_if_temporary_root(path)
            return entries

        with (
            patch.object(Path, "iterdir", iterate_then_swap),
            patch("remote_skills.cache.disk.os.listdir", list_then_swap),
            patch("remote_skills.cache.disk.os.scandir", scan_then_swap),
        ):
            cache.cleanup_stale_temporaries(max_age_seconds=120)

        self.assertTrue(swapped)
        self.assertTrue(sentinel.is_file())
        self.assertEqual(
            sentinel.read_text(encoding="utf-8") if sentinel.is_file() else None,
            "external",
        )

    def test_reused_pid_does_not_preserve_stale_python_writer(self) -> None:
        shutil.copytree(PARTIAL_WRITER_STATE / "cache-v1", self.cache_root / "cache-v1")
        writer_path = next((self.cache_root / "cache-v1/tmp").glob("*/writer.json"))
        writer = json.loads(writer_path.read_text(encoding="utf-8"))
        writer["writer"] = "python"
        writer["pid"] = 4242
        writer_path.write_text(json.dumps(writer), encoding="utf-8")
        stale = (self.now - timedelta(hours=1)).timestamp()
        for path in (self.cache_root / "cache-v1/tmp").rglob("*"):
            os.utime(path, (stale, stale))
        process_identity = "process-start-before-pid-reuse"
        cache = DiskCache(
            self.cache_root,
            touch_on_read=False,
            clock=lambda: self.now,
            process_identity=lambda _pid: process_identity,
        )
        cache._register_process_identity(
            writer["expected_digest"], writer["pid"], writer["process_nonce"]
        )

        self.assertEqual(cache.cleanup_stale_temporaries(max_age_seconds=120), 0)
        self.assertEqual(json.loads(writer_path.read_text(encoding="utf-8")), writer)

        process_identity = "process-start-after-pid-reuse"

        removed = cache.cleanup_stale_temporaries(max_age_seconds=120)

        self.assertEqual(removed, 1)
        self.assertFalse(writer_path.parent.exists())

    def test_lru_eviction_skips_live_pin_then_removes_it_after_release(self) -> None:
        cache = self.cache()
        base_time = self.now - timedelta(minutes=10)

        oldest = make_skill_object("oldest", base_time)
        middle = make_skill_object("middle", base_time + timedelta(minutes=1))
        newest = make_skill_object("newest", base_time + timedelta(minutes=2))
        for cached in (oldest, middle, newest):
            cache.publish_object(cached)
        lease = cache.acquire_lease(
            oldest.digest,
            process_nonce="process-test",
            session_nonce="session-test",
            pid=4242,
        )
        retained_bytes = sum(
            path.stat().st_size
            for cached in (oldest, newest)
            for path in cache.object_path(cached.digest).rglob("*")
            if path.is_file()
        )

        result = cache.evict(max_bytes=retained_bytes, max_age_seconds=3600)

        self.assertEqual(result.removed_digests, (middle.digest,))
        self.assertEqual(result.retained_pinned, (oldest.digest,))
        self.assertIsNotNone(cache.get_object(oldest.digest))
        self.assertIsNotNone(cache.get_object(newest.digest))

        cache.release_lease(lease)
        final = cache.evict(max_bytes=0, max_age_seconds=0)
        self.assertEqual(set(final.removed_digests), {oldest.digest, newest.digest})
        self.assertIsNone(cache.get_object(oldest.digest))

    def test_publication_applies_configured_disk_bounds(self) -> None:
        cache = self.cache()
        cache.max_bytes = 0
        cache.max_age_seconds = 0
        candidate = make_skill_object("bounded-publication", self.now - timedelta(minutes=1))

        cache.publish_object(candidate)

        self.assertIsNone(cache.get_object(candidate.digest))

    def test_eviction_counts_object_metadata_bytes(self) -> None:
        cache = self.cache()
        candidate = make_skill_object("metadata-accounting", self.now)
        cache.publish_object(candidate)
        payload_bytes = len(candidate.artifact) + sum(len(value) for value in candidate.files.values())

        result = cache.evict(max_bytes=payload_bytes, max_age_seconds=3600)

        self.assertEqual(result.removed_digests, (candidate.digest,))
        self.assertGreater(result.bytes_before, payload_bytes)

    def test_operational_metadata_is_outside_reusable_byte_budget(self) -> None:
        cache = self.cache()
        candidate = make_skill_object("namespace-accounting", self.now)
        cache.publish_object(candidate)
        object_bytes = sum(
            path.stat().st_size
            for path in cache.object_path(candidate.digest).rglob("*")
            if path.is_file()
        )
        processes = cache.namespace / "processes"
        processes.mkdir(parents=True, exist_ok=True)
        (processes / "unreclaimable-operational-state.json").write_bytes(b"x" * 4096)

        result = cache.evict(max_bytes=object_bytes, max_age_seconds=3600)

        self.assertEqual(result.removed_digests, ())
        self.assertEqual(result.bytes_before, object_bytes)
        self.assertEqual(result.bytes_after, object_bytes)

    def test_eviction_commit_remains_anchored_when_tmp_parent_is_replaced(self) -> None:
        cache = self.cache()
        candidate = make_skill_object("anchored-eviction", self.now - timedelta(minutes=10))
        cache.publish_object(candidate)
        temporary_root = cache.namespace / "tmp"
        saved_temporary_root = Path(self.temporary.name) / "saved-tmp"
        external = Path(self.temporary.name) / "external-tmp"
        external.mkdir()
        original_rename = os.rename
        original_remove_tree = __import__(
            "remote_skills.cache.disk",
            fromlist=["_remove_tree_at"],
        )._remove_tree_at
        swapped = False
        external_touched = False

        def swap_tmp_before_commit(
            source: str | bytes | os.PathLike[str] | os.PathLike[bytes],
            target: str | bytes | os.PathLike[str] | os.PathLike[bytes],
            *args: object,
            **kwargs: object,
        ) -> None:
            nonlocal swapped
            if Path(target).name.startswith("evict-") and not swapped:
                original_rename(temporary_root, saved_temporary_root)
                temporary_root.symlink_to(external, target_is_directory=True)
                swapped = True
            original_rename(source, target, *args, **kwargs)

        def record_external_delete(
            descriptor: int,
            directory: Path,
            name: str,
            *args: object,
            **kwargs: object,
        ) -> None:
            nonlocal external_touched
            if (directory / name).resolve().parent == external.resolve():
                external_touched = True
            original_remove_tree(descriptor, directory, name, *args, **kwargs)

        with (
            patch("remote_skills.cache.disk.os.rename", swap_tmp_before_commit),
            patch("remote_skills.cache.disk._remove_tree_at", record_external_delete),
        ):
            with self.assertRaises(CacheCorruptError):
                cache.evict(max_bytes=0, max_age_seconds=0)

        self.assertTrue(swapped)
        self.assertFalse(external_touched)
        self.assertEqual(list(external.iterdir()), [])

    def test_lease_acquisition_waits_for_final_eviction_removal(self) -> None:
        if disk_cache_module._windows_mode():
            self._assert_windows_cross_instance_eviction_serialization()
            return
        cache = self.cache()
        candidate = make_skill_object("claim-race", self.now - timedelta(minutes=10))
        cache.publish_object(candidate)
        original_remove_tree = __import__(
            "remote_skills.cache.disk",
            fromlist=["_remove_tree_at"],
        )._remove_tree_at
        acquisition_started = threading.Event()
        lease_acquired = threading.Event()
        acquired_before_removal: list[bool] = []
        leases: list[CacheLease] = []
        worker_errors: list[BaseException] = []
        worker: threading.Thread | None = None

        def acquire() -> None:
            acquisition_started.set()
            try:
                leases.append(
                    cache.acquire_lease(
                        candidate.digest,
                        process_nonce="process-claim-race",
                        session_nonce="session-claim-race",
                        pid=os.getpid(),
                    )
                )
                lease_acquired.set()
            except BaseException as error:
                worker_errors.append(error)

        def remove_after_racing_lease(
            descriptor: int,
            directory: Path,
            name: str,
            *args: object,
            **kwargs: object,
        ) -> None:
            nonlocal worker
            if name.startswith("evict-"):
                worker = threading.Thread(target=acquire)
                worker.start()
                self.assertTrue(acquisition_started.wait(timeout=1))
                acquired_before_removal.append(lease_acquired.wait(timeout=0.25))
            original_remove_tree(descriptor, directory, name, *args, **kwargs)

        with patch("remote_skills.cache.disk._remove_tree_at", remove_after_racing_lease):
            cache.evict(max_bytes=0, max_age_seconds=0)

        if worker is None:
            self.fail("eviction never reached final removal")
        worker.join(timeout=2)
        self.assertFalse(worker.is_alive())
        self.assertEqual(len(worker_errors), 1)
        self.assertIsInstance(worker_errors[0], CacheCorruptError)
        self.assertEqual(acquired_before_removal, [False])
        self.assertEqual(leases, [])

    def test_windows_root_lock_serializes_cross_instance_eviction_and_lease(self) -> None:
        with patch("remote_skills.cache.disk._windows_mode", return_value=True):
            self._assert_windows_cross_instance_eviction_serialization()

    def _assert_windows_cross_instance_eviction_serialization(self) -> None:
        publisher = self.cache()
        candidate = make_skill_object(
            "windows-root-lock-race",
            self.now - timedelta(minutes=10),
        )
        publisher.publish_object(candidate)
        evictor = self.cache()
        acquirer = self.cache()
        original_remove = disk_cache_module._windows_remove_tree_path
        original_open_guard = acquirer._open_object_generation_guard
        eviction_paused = threading.Event()
        release_eviction = threading.Event()
        acquisition_entered = threading.Event()
        eviction_results: list[EvictionResult] = []
        acquisition_results: list[CacheLease] = []
        errors: list[BaseException] = []

        def pause_final_removal(path: Path, **kwargs: object) -> None:
            if path.name.startswith("evict-"):
                eviction_paused.set()
                if not release_eviction.wait(timeout=2):
                    raise TimeoutError("Windows eviction resume timed out")
            original_remove(path, **kwargs)

        def observe_acquisition_entry(digest: str) -> object:
            acquisition_entered.set()
            return original_open_guard(digest)

        acquirer._open_object_generation_guard = observe_acquisition_entry

        def evict() -> None:
            try:
                eviction_results.append(evictor.evict(max_bytes=0, max_age_seconds=0))
            except BaseException as error:
                errors.append(error)

        def acquire() -> None:
            try:
                acquisition_results.append(
                    acquirer.acquire_lease(
                        candidate.digest,
                        process_nonce="windows-cross-instance",
                        session_nonce="after-eviction",
                    )
                )
            except BaseException as error:
                errors.append(error)

        eviction_thread = threading.Thread(target=evict)
        acquisition_thread = threading.Thread(target=acquire)
        try:
            with patch(
                "remote_skills.cache.disk._windows_remove_tree_path",
                pause_final_removal,
            ):
                eviction_thread.start()
                self.assertTrue(eviction_paused.wait(timeout=1))
                acquisition_thread.start()
                self.assertFalse(acquisition_entered.wait(timeout=0.25))
                release_eviction.set()
                eviction_thread.join(timeout=2)
                acquisition_thread.join(timeout=2)
        finally:
            release_eviction.set()
            eviction_thread.join(timeout=2)
            acquisition_thread.join(timeout=2)

        self.assertFalse(eviction_thread.is_alive())
        self.assertFalse(acquisition_thread.is_alive())
        self.assertTrue(acquisition_entered.is_set())
        self.assertEqual(errors, [])
        self.assertEqual(eviction_results[0].removed_digests, (candidate.digest,))
        self.assertEqual(len(acquisition_results), 1)
        acquirer.release_lease(acquisition_results[0])

    def test_lease_acquisition_remembers_eviction_that_disappears_before_first_scan(
        self,
    ) -> None:
        if disk_cache_module._windows_mode():
            self.skipTest(
                "Windows root locking prevents eviction from disappearing before a concurrent "
                "first scan; cross-instance serialization is covered separately"
            )
        candidate = make_skill_object(
            "disappearing-eviction",
            self.now - timedelta(minutes=10),
        )
        publisher = self.cache()
        publisher.publish_object(candidate)
        evictor = self.cache()
        acquirer = self.cache()
        original_remove_tree = disk_cache_module._remove_tree_at
        original_turn_state = acquirer._mutation_turn_state
        eviction_paused = threading.Event()
        release_eviction = threading.Event()
        acquisition_paused = threading.Event()
        release_acquisition = threading.Event()
        eviction_results: list[EvictionResult] = []
        acquisition_results: list[CacheLease] = []
        eviction_errors: list[BaseException] = []
        acquisition_errors: list[BaseException] = []

        def pause_eviction_removal(*args: object, **kwargs: object) -> None:
            name = args[2]
            if isinstance(name, str) and name.startswith("evict-"):
                eviction_paused.set()
                if not release_eviction.wait(timeout=2):
                    raise TimeoutError("eviction removal resume timed out")
            original_remove_tree(*args, **kwargs)

        def pause_acquisition_turn(
            digest: str,
            **kwargs: object,
        ) -> tuple[bool, bool]:
            acquisition_paused.set()
            if not release_acquisition.wait(timeout=2):
                raise TimeoutError("acquisition turn resume timed out")
            return original_turn_state(digest, **kwargs)

        acquirer._mutation_turn_state = pause_acquisition_turn

        def evict() -> None:
            try:
                eviction_results.append(evictor.evict(max_bytes=0, max_age_seconds=0))
            except BaseException as error:
                eviction_errors.append(error)

        def acquire() -> None:
            try:
                acquisition_results.append(
                    acquirer.acquire_lease(
                        candidate.digest,
                        process_nonce="process-disappearing-eviction",
                        session_nonce="session-disappearing-eviction",
                    )
                )
            except BaseException as error:
                acquisition_errors.append(error)

        eviction_thread = threading.Thread(target=evict)
        acquisition_thread = threading.Thread(target=acquire)
        try:
            with patch("remote_skills.cache.disk._remove_tree_at", pause_eviction_removal):
                eviction_thread.start()
                self.assertTrue(eviction_paused.wait(timeout=1))
                acquisition_thread.start()
                self.assertTrue(acquisition_paused.wait(timeout=1))
                handoff_records: list[str] = []
                for path in acquirer._mutation_gate_digest_directory(
                    candidate.digest
                ).iterdir():
                    if path.suffix not in {".intent", ".lock"}:
                        continue
                    value = json.loads(path.read_text(encoding="utf-8"))
                    if value.get("contended_with_eviction") is True:
                        handoff_records.append(value["schema"])
                self.assertEqual(
                    handoff_records,
                    ["remote-skills-cache-mutation-lock-v1"],
                )
                release_eviction.set()
                eviction_thread.join(timeout=2)
                self.assertFalse(eviction_thread.is_alive())
                self.assertEqual(eviction_errors, [])
                self.assertEqual(eviction_results[0].removed_digests, (candidate.digest,))
                self.assertIsNone(publisher.get_object(candidate.digest))
                release_acquisition.set()
                acquisition_thread.join(timeout=2)
        finally:
            release_eviction.set()
            release_acquisition.set()
            eviction_thread.join(timeout=2)
            acquisition_thread.join(timeout=2)

        self.assertFalse(acquisition_thread.is_alive())
        self.assertEqual(acquisition_results, [])
        self.assertEqual(len(acquisition_errors), 1)
        self.assertIsInstance(acquisition_errors[0], CacheCorruptError)
        lease_directory = acquirer._lease_directory(candidate.digest)
        ordinary_leases = (
            [path for path in lease_directory.iterdir() if not path.name.startswith(".")]
            if lease_directory.exists()
            else []
        )
        self.assertEqual(ordinary_leases, [])

    def test_lease_acquisition_fails_when_eviction_starts_after_prepublication_scan(
        self,
    ) -> None:
        candidate = make_skill_object(
            "eviction-after-prepublication-scan",
            self.now - timedelta(minutes=10),
        )
        publisher = self.cache()
        publisher.publish_object(candidate)
        acquirer = self.cache()
        original_scan = acquirer._open_object_generation_guard
        scan_completed = threading.Event()
        release_acquisition = threading.Event()
        acquisition_results: list[CacheLease] = []
        acquisition_errors: list[BaseException] = []
        first_scan = True

        def pause_after_prepublication_scan(
            digest: str,
        ) -> object:
            nonlocal first_scan
            result = original_scan(digest)
            if first_scan:
                first_scan = False
                scan_completed.set()
                if not release_acquisition.wait(timeout=2):
                    raise TimeoutError("acquisition prepublication resume timed out")
            return result

        acquirer._open_object_generation_guard = pause_after_prepublication_scan

        def acquire() -> None:
            try:
                acquisition_results.append(
                    acquirer.acquire_lease(
                        candidate.digest,
                        process_nonce="process-eviction-after-scan",
                        session_nonce="session-eviction-after-scan",
                    )
                )
            except BaseException as error:
                acquisition_errors.append(error)

        acquisition_thread = threading.Thread(target=acquire)
        try:
            acquisition_thread.start()
            self.assertTrue(scan_completed.wait(timeout=1))
            eviction = self.cache().evict(max_bytes=0, max_age_seconds=0)
            self.assertEqual(eviction.removed_digests, (candidate.digest,))
            self.assertIsNone(publisher.get_object(candidate.digest))
            release_acquisition.set()
            acquisition_thread.join(timeout=2)
        finally:
            release_acquisition.set()
            acquisition_thread.join(timeout=2)

        self.assertFalse(acquisition_thread.is_alive())
        self.assertEqual(acquisition_results, [])
        self.assertEqual(len(acquisition_errors), 1)
        self.assertIsInstance(acquisition_errors[0], CacheCorruptError)
        lease_directory = acquirer._lease_directory(candidate.digest)
        ordinary_leases = (
            [path for path in lease_directory.iterdir() if not path.name.startswith(".")]
            if lease_directory.exists()
            else []
        )
        self.assertEqual(ordinary_leases, [])

    def test_lease_generation_rejects_stable_symlinked_object_ancestor(self) -> None:
        external_root = Path(self.temporary.name) / "external-object-cache"
        external_cache = DiskCache(external_root, touch_on_read=False)
        external_cache.publish_object(fixture_object())
        cache_root = Path(self.temporary.name) / "redirected-object-cache"
        namespace = cache_root / "cache-v1"
        namespace.mkdir(parents=True)
        try:
            (namespace / "objects").symlink_to(
                external_cache.namespace / "objects",
                target_is_directory=True,
            )
        except OSError as error:
            self.skipTest(f"directory symlinks unavailable: {error}")
        external_artifact = external_cache.object_path(FIXTURE_DIGEST) / "artifact"
        artifact_before = external_artifact.read_bytes()
        redirected = DiskCache(cache_root, touch_on_read=False)

        with self.assertRaises(CacheCorruptError):
            redirected.acquire_lease(
                FIXTURE_DIGEST,
                process_nonce="stable-object-ancestor-process",
                session_nonce="stable-object-ancestor-session",
            )

        self.assertEqual(external_artifact.read_bytes(), artifact_before)
        self.assertFalse((external_cache.namespace / "leases").exists())

    def test_lease_generation_recheck_rejects_object_ancestor_pivot(self) -> None:
        cache = self.cache()
        candidate = fixture_object()
        cache.publish_object(candidate)
        objects_directory = cache.namespace / "objects"
        parked_objects = Path(self.temporary.name) / "parked-objects"
        artifact_before = (cache.object_path(candidate.digest) / "artifact").read_bytes()
        original_validate = cache._validate_object_generation_guard
        pivoted = False

        def pivot_before_recheck(guard: object) -> None:
            nonlocal pivoted
            if not pivoted:
                pivoted = True
                objects_directory.rename(parked_objects)
                objects_directory.symlink_to(parked_objects, target_is_directory=True)
            original_validate(guard)

        cache._validate_object_generation_guard = pivot_before_recheck

        with self.assertRaises(CacheCorruptError):
            cache.acquire_lease(
                candidate.digest,
                process_nonce="object-ancestor-pivot-process",
                session_nonce="object-ancestor-pivot-session",
            )

        self.assertEqual(
            (
                parked_objects
                / "sha256"
                / candidate.digest[7:9]
                / candidate.digest[9:]
                / "artifact"
            ).read_bytes(),
            artifact_before,
        )
        lease_directory = cache._lease_directory(candidate.digest)
        ordinary_leases = (
            [path for path in lease_directory.iterdir() if not path.name.startswith(".")]
            if lease_directory.exists()
            else []
        )
        self.assertEqual(ordinary_leases, [])

    def test_lease_generation_guard_permits_legitimate_and_absent_paths(self) -> None:
        cache = self.cache()
        candidate = fixture_object()
        cache.publish_object(candidate)
        existing = cache.acquire_lease(
            candidate.digest,
            process_nonce="object-anchor-existing-process",
            session_nonce="object-anchor-existing-session",
        )
        cache.release_lease(existing)

        absent_digest = "sha256:" + hashlib.sha256(b"absent-object-anchor").hexdigest()
        absent = cache.acquire_lease(
            absent_digest,
            process_nonce="object-anchor-absent-process",
            session_nonce="object-anchor-absent-session",
        )
        cache.release_lease(absent)

    def test_eviction_claim_is_published_only_after_complete_write(self) -> None:
        cache = self.cache()
        candidate = make_skill_object("atomic-claim", self.now - timedelta(minutes=10))
        cache.publish_object(candidate)
        original_write = __import__(
            "remote_skills.cache.disk",
            fromlist=["_write_file_at"],
        )._write_file_at

        def crash_direct_claim_write(
            descriptor: int | None,
            directory: Path,
            name: str,
            content: bytes,
        ) -> None:
            if name == ".eviction-claim.json":
                original_write(descriptor, directory, name, b'{"schema":')
                raise OSError("simulated claim writer crash")
            original_write(descriptor, directory, name, content)

        with patch(
            "remote_skills.cache.disk._write_file_at",
            crash_direct_claim_write,
        ):
            result = cache.evict(max_bytes=0, max_age_seconds=0)

        self.assertEqual(result.removed_digests, (candidate.digest,))
        self.assertFalse((cache._claim_path(candidate.digest)).exists())

    def test_stale_malformed_eviction_claim_is_recoverable(self) -> None:
        cache = self.cache()
        candidate = make_skill_object("malformed-claim", self.now - timedelta(minutes=10))
        cache.publish_object(candidate)
        claim = cache._claim_path(candidate.digest)
        claim.parent.mkdir(parents=True, exist_ok=True)
        claim.write_bytes(b'{"schema":')
        stale = (self.now - timedelta(minutes=10)).timestamp()
        os.utime(claim, (stale, stale))

        with patch(
            "remote_skills.cache.disk.time.monotonic",
            side_effect=[0.0, 6.0],
        ):
            result = cache.evict(max_bytes=0, max_age_seconds=0)

        self.assertEqual(result.removed_digests, (candidate.digest,))
        self.assertFalse(claim.exists())

    def test_claim_release_does_not_unlink_successor_generation(self) -> None:
        cache = self.cache()
        claim = cache._acquire_eviction_claim(FIXTURE_DIGEST)
        claim_path = cache._claim_path(FIXTURE_DIGEST)
        successor = b'{"schema":"successor-generation"}\n'
        claim_path.unlink()
        claim_path.write_bytes(successor)

        cache._release_eviction_claim(claim)

        self.assertEqual(claim_path.read_bytes(), successor)

    def test_stale_claim_reclaim_does_not_unlink_successor_generation(self) -> None:
        cache = self.cache()
        cache._process_identity = lambda pid: "claim-owner-start"
        cache._acquire_eviction_claim(FIXTURE_DIGEST)
        cache._process_identity = lambda pid: "successor-process-start"
        claim_path = cache._claim_path(FIXTURE_DIGEST)
        successor = b'{"schema":"successor-generation"}\n'
        original_match = __import__(
            "remote_skills.cache.disk",
            fromlist=["_entry_matches_descriptor"],
        )._entry_matches_descriptor
        replaced = False

        def replace_before_identity_match(*args: object, **kwargs: object) -> bool:
            nonlocal replaced
            if not replaced:
                claim_path.unlink()
                claim_path.write_bytes(successor)
                replaced = True
            return original_match(*args, **kwargs)

        with patch(
            "remote_skills.cache.disk._entry_matches_descriptor",
            replace_before_identity_match,
        ):
            reclaimed = cache._reclaim_stale_eviction_claim(FIXTURE_DIGEST)

        self.assertTrue(replaced)
        self.assertFalse(reclaimed)
        self.assertEqual(claim_path.read_bytes(), successor)

    def test_closed_snapshot_claim_reclaim_does_not_unlink_successor_generation(self) -> None:
        cache = self.cache()
        cache._process_identity = lambda pid: "claim-owner-start"
        cache._acquire_eviction_claim(FIXTURE_DIGEST)
        cache._process_identity = lambda pid: "successor-process-start"
        claim_path = cache._claim_path(FIXTURE_DIGEST)
        successor = b'{"schema":"successor-generation"}\n'
        original_match = disk_cache_module._entry_matches_snapshot
        replaced = False

        def replace_before_identity_match(*args: object, **kwargs: object) -> bool:
            nonlocal replaced
            if not replaced:
                claim_path.unlink()
                claim_path.write_bytes(successor)
                replaced = True
            return original_match(*args, **kwargs)

        with (
            patch.object(
                disk_cache_module,
                "_requires_closed_mutation_snapshot",
                return_value=True,
            ),
            patch.object(
                disk_cache_module,
                "_entry_matches_snapshot",
                replace_before_identity_match,
            ),
        ):
            reclaimed = cache._reclaim_stale_eviction_claim(FIXTURE_DIGEST)

        self.assertTrue(replaced)
        self.assertFalse(reclaimed)
        self.assertEqual(claim_path.read_bytes(), successor)

    def test_eviction_claim_requires_process_start_identity(self) -> None:
        cache = DiskCache(
            self.cache_root,
            touch_on_read=False,
            clock=lambda: self.now,
            process_identity=lambda pid: None,
        )
        candidate = make_skill_object("claim-without-identity", self.now)
        cache.publish_object(candidate)

        with self.assertRaises(CacheConfigurationError):
            cache.evict(max_bytes=0, max_age_seconds=0)

    def test_unknown_auxiliary_lease_record_does_not_pin_object(self) -> None:
        cache = self.cache()
        candidate = make_skill_object("typescript-auxiliary", self.now - timedelta(minutes=10))
        cache.publish_object(candidate)
        lease_directory = cache._lease_directory(candidate.digest)
        lease_directory.mkdir(parents=True, exist_ok=True)
        (lease_directory / ".typescript-coordination-v1.json").write_text(
            '{"schema":"typescript-private-coordination"}\n',
            encoding="utf-8",
        )

        result = cache.evict(max_bytes=0, max_age_seconds=0)

        self.assertEqual(result.removed_digests, (candidate.digest,))

    def test_forged_lease_nonce_cannot_escape_lease_directory(self) -> None:
        cache = self.cache()
        forged = CacheLease(
            digest=FIXTURE_DIGEST,
            pid=4242,
            process_nonce="../../../../outside",
            session_nonce="session",
            created_at=self.now,
            renewed_at=self.now,
        )

        with self.assertRaises(CacheConfigurationError):
            cache.release_lease(forged)

    def test_lease_nonce_cannot_enter_auxiliary_record_namespace(self) -> None:
        cache = self.cache()

        with self.assertRaises(CacheConfigurationError):
            cache.acquire_lease(
                FIXTURE_DIGEST,
                process_nonce=".coordination-record",
                session_nonce="session",
                pid=4242,
            )

    def test_symlinked_lease_directory_cannot_delete_external_lease(self) -> None:
        cache = self.cache()
        lease = CacheLease(
            digest=FIXTURE_DIGEST,
            pid=4242,
            process_nonce="process-external",
            session_nonce="session-external",
            created_at=self.now,
            renewed_at=self.now,
        )
        external = Path(self.temporary.name) / "external-leases"
        external.mkdir()
        external_lease = external / "process-external-session-external.json"
        external_lease.write_text("external", encoding="utf-8")
        leases_root = cache.namespace / "leases"
        leases_root.mkdir(parents=True)
        try:
            (leases_root / FIXTURE_DIGEST[7:]).symlink_to(external, target_is_directory=True)
        except OSError as error:
            self.skipTest(f"directory symlinks unavailable: {error}")

        with self.assertRaises(CacheCorruptError):
            cache.release_lease(lease)

        self.assertEqual(external_lease.read_text(encoding="utf-8"), "external")

    def test_symlinked_lease_directory_cannot_replace_external_lease(self) -> None:
        cache = self.cache()
        lease = CacheLease(
            digest=FIXTURE_DIGEST,
            pid=4242,
            process_nonce="process-external",
            session_nonce="session-external",
            created_at=self.now,
            renewed_at=self.now,
        )
        external = Path(self.temporary.name) / "external-leases"
        external.mkdir()
        external_lease = external / "process-external-session-external.json"
        external_lease.write_text("external", encoding="utf-8")
        leases_root = cache.namespace / "leases"
        leases_root.mkdir(parents=True)
        try:
            (leases_root / FIXTURE_DIGEST[7:]).symlink_to(external, target_is_directory=True)
        except OSError as error:
            self.skipTest(f"directory symlinks unavailable: {error}")

        with self.assertRaises(CacheCorruptError):
            cache.renew_lease(lease)

        self.assertEqual(external_lease.read_text(encoding="utf-8"), "external")

    def test_symlinked_lease_directory_cannot_accept_new_lease(self) -> None:
        cache = self.cache()
        external = Path(self.temporary.name) / "external-leases"
        external.mkdir()
        leases_root = cache.namespace / "leases"
        leases_root.mkdir(parents=True)
        try:
            (leases_root / FIXTURE_DIGEST[7:]).symlink_to(
                external,
                target_is_directory=True,
            )
        except OSError as error:
            self.skipTest(f"directory symlinks unavailable: {error}")

        with (
            patch(
                "remote_skills.cache.disk.time.monotonic",
                side_effect=[0.0, 6.0],
            ),
            self.assertRaises(CacheCorruptError),
        ):
            cache.acquire_lease(
                FIXTURE_DIGEST,
                process_nonce="process-local",
                session_nonce="session-local",
            )

        self.assertEqual(list(external.iterdir()), [])

    def test_stale_cleanup_does_not_follow_lease_swapped_after_lstat(self) -> None:
        shutil.copytree(CRASHED_LEASE_STATE / "cache-v1", self.cache_root / "cache-v1")
        cache = self.cache()
        lease_path = next((cache.namespace / "leases").glob("*/*.json"))
        external_lease = Path(self.temporary.name) / "external-lease.json"
        original_lstat = Path.lstat
        swapped = False

        def lstat_then_swap(path: Path, *args: object, **kwargs: object) -> os.stat_result:
            nonlocal swapped
            identity = original_lstat(path, *args, **kwargs)
            if path == lease_path and not swapped:
                lease_path.rename(external_lease)
                lease_path.symlink_to(external_lease)
                swapped = True
            return identity

        with patch.object(Path, "lstat", lstat_then_swap):
            removed = cache.cleanup_stale_leases(lease_expiry_seconds=120)

        self.assertTrue(swapped)
        self.assertEqual(removed, 0)
        self.assertTrue(external_lease.is_file())


class FinalCacheReviewTest(TemporaryCacheTestCase):
    def test_directory_creation_does_not_follow_parent_replacement(self) -> None:
        if disk_cache_module._windows_mode():
            self.skipTest(
                "Windows has no descriptor-relative mkdir; path-and-handle parent replacement "
                "is covered separately"
            )
        cache = DiskCache(self.cache_root, touch_on_read=False)
        cache.namespace.mkdir(parents=True)
        saved_namespace = Path(self.temporary.name) / "saved-cache-v1"
        external = Path(self.temporary.name) / "external-cache-v1"
        external.mkdir()
        original_mkdir = os.mkdir
        swapped = False

        def swap_before_child_creation(
            path: str | bytes | os.PathLike[str],
            mode: int = 0o777,
            *,
            dir_fd: int | None = None,
        ) -> None:
            nonlocal swapped
            targets_child = Path(path) == cache.namespace / "tmp"
            if path == "tmp" and dir_fd is not None:
                targets_child = os.path.samestat(
                    os.fstat(dir_fd),
                    cache.namespace.stat(),
                )
            if not swapped and targets_child:
                cache.namespace.rename(saved_namespace)
                cache.namespace.symlink_to(external, target_is_directory=True)
                swapped = True
            if dir_fd is None:
                original_mkdir(path, mode)
            else:
                original_mkdir(path, mode, dir_fd=dir_fd)

        with (
            patch("remote_skills.cache.disk.os.mkdir", swap_before_child_creation),
            self.assertRaises(CacheCorruptError),
        ):
            cache._ensure_cache_directory("tmp")

        self.assertTrue(swapped)
        self.assertFalse((external / "tmp").exists())

    def test_recursive_removal_preserves_replacement_child_generation(self) -> None:
        if disk_cache_module._windows_mode():
            self._assert_windows_child_generation_replacement_is_preserved()
            return
        parent = Path(self.temporary.name) / "remove-parent"
        victim = parent / "victim"
        child = victim / "child"
        child.mkdir(parents=True)
        (child / "old").write_text("old", encoding="utf-8")
        replacement = Path(self.temporary.name) / "replacement-child"
        replacement.mkdir()
        sentinel = replacement / "sentinel"
        sentinel.write_text("replacement", encoding="utf-8")
        parent_descriptor = os.open(parent, os.O_RDONLY | os.O_DIRECTORY)
        original_stat = os.stat
        swapped = False

        def stat_then_replace(
            path: str | bytes | os.PathLike[str] | int,
            *args: object,
            **kwargs: object,
        ) -> os.stat_result:
            nonlocal swapped
            result = original_stat(path, *args, **kwargs)
            if path == "child" and kwargs.get("dir_fd") is not None and not swapped:
                directory_descriptor = kwargs["dir_fd"]
                os.rename(
                    "child",
                    ".displaced-child",
                    src_dir_fd=directory_descriptor,
                    dst_dir_fd=directory_descriptor,
                )
                replacement_parent = os.open(replacement.parent, os.O_RDONLY | os.O_DIRECTORY)
                try:
                    os.rename(
                        replacement.name,
                        "child",
                        src_dir_fd=replacement_parent,
                        dst_dir_fd=directory_descriptor,
                    )
                finally:
                    os.close(replacement_parent)
                swapped = True
            return result

        try:
            with (
                patch("remote_skills.cache.disk.os.stat", stat_then_replace),
                self.assertRaises(ValueError),
            ):
                disk_cache_module._remove_tree_at(
                    parent_descriptor,
                    parent,
                    "victim",
                    max_entries=10,
                    max_depth=4,
                )
        finally:
            os.close(parent_descriptor)

        self.assertTrue(swapped)
        self.assertEqual(list(parent.glob(".delete-*")), [])
        self.assertEqual(
            (parent / "victim" / "child" / "sentinel").read_text(encoding="utf-8"),
            "replacement",
        )

    def test_windows_recursive_removal_preserves_replacement_child_generation(
        self,
    ) -> None:
        self._assert_windows_child_generation_replacement_is_preserved()

    def _assert_windows_child_generation_replacement_is_preserved(self) -> None:
        parent = Path(self.temporary.name) / "windows-remove-parent"
        victim = parent / "victim"
        child = victim / "child"
        child.mkdir(parents=True)
        (child / "old").write_text("old", encoding="utf-8")
        replacement = Path(self.temporary.name) / "windows-replacement-child"
        replacement.mkdir()
        sentinel = replacement / "sentinel"
        sentinel.write_text("replacement", encoding="utf-8")
        expected_identity = disk_cache_module._identity(victim.lstat())
        original_lstat = Path.lstat
        child_observations = 0
        swapped = False

        def lstat_then_replace(path: Path, *args: object, **kwargs: object) -> os.stat_result:
            nonlocal child_observations, swapped
            result = original_lstat(path, *args, **kwargs)
            if path == child:
                child_observations += 1
                if child_observations == 3 and not swapped:
                    child.rename(victim / ".displaced-child")
                    replacement.rename(child)
                    swapped = True
            return result

        with (
            patch.object(Path, "lstat", lstat_then_replace),
            self.assertRaises(ValueError),
        ):
            disk_cache_module._windows_remove_tree_path(
                victim,
                expected_identity=expected_identity,
                max_entries=10,
                max_depth=4,
            )

        quarantines = list(parent.glob(".delete-*"))
        self.assertTrue(swapped)
        self.assertEqual(len(quarantines), 1)
        self.assertEqual(
            (quarantines[0] / "child" / "sentinel").read_text(encoding="utf-8"),
            "replacement",
        )

    def test_same_millisecond_renewal_advances_disk_and_memory_generations(self) -> None:
        frozen = datetime(2026, 8, 25, 10, 0, 0, 123456, tzinfo=timezone.utc)
        caches = (
            MemoryCache(clock=lambda: frozen),
            DiskCache(
                self.cache_root,
                touch_on_read=False,
                clock=lambda: frozen,
                process_identity=lambda pid: "frozen-process",
            ),
        )
        for cache in caches:
            with self.subTest(backend=type(cache).__name__):
                lease = cache.acquire_lease(
                    FIXTURE_DIGEST,
                    process_nonce=f"frozen-{type(cache).__name__.lower()}",
                    session_nonce="session",
                    pid=os.getpid(),
                )
                renewed = cache.renew_lease(lease)
                self.assertGreater(renewed.renewed_at, lease.renewed_at)
                with self.assertRaises(CacheCorruptError):
                    cache.release_lease(lease)
                cache.release_lease(renewed)

    def test_bounded_reader_detects_growth_without_requesting_past_limit(self) -> None:
        directory = Path(self.temporary.name) / "bounded-growth"
        directory.mkdir()
        path = directory / "payload"
        path.write_bytes(b"abcd")
        original_read = os.read
        requests: list[int] = []
        grew = False

        def grow_after_first_read(descriptor: int, size: int) -> bytes:
            nonlocal grew
            requests.append(size)
            chunk = original_read(descriptor, size)
            if chunk and not grew:
                with path.open("ab") as writer:
                    writer.write(b"e")
                    writer.flush()
                    os.fsync(writer.fileno())
                grew = True
            return chunk

        with (
            patch("remote_skills.cache.disk.os.read", grow_after_first_read),
            self.assertRaises(ValueError),
        ):
            disk_cache_module._read_regular_file_snapshot_at(
                None,
                directory,
                "payload",
                max_bytes=4,
            )

        self.assertEqual(requests, [4, 1])

    def test_lone_surrogates_are_rejected_but_replacement_character_is_portable(self) -> None:
        timestamp = datetime(2026, 8, 25, 10, 0, tzinfo=timezone.utc)

        def candidate(path: str) -> CachedObject:
            artifact = b"archive"
            return CachedObject(
                digest=f"sha256:{hashlib.sha256(artifact).hexdigest()}",
                artifact_type="archive",
                archive_format="zip",
                artifact=artifact,
                files={path: b"content"},
                media_types={path: "text/plain"},
                verified_at=timestamp,
                accessed_at=timestamp,
            )

        for backend in (
            MemoryCache(archive_verifier=lambda value: True),
            DiskCache(
                self.cache_root,
                touch_on_read=False,
                archive_verifier=lambda value: True,
            ),
        ):
            for invalid in ("references/\ud800.txt", "references/\udfff.txt"):
                with self.subTest(backend=type(backend).__name__, path=repr(invalid)):
                    with self.assertRaises(CacheCorruptError):
                        backend.publish_object(candidate(invalid))
            valid = candidate("references/\ufffd.txt")
            self.assertEqual(backend.publish_object(valid), valid)

    def test_x_api_key_is_rejected_case_insensitively_without_persistence(self) -> None:
        metadata = CatalogMetadata(
            canonical_url=FIXTURE_ORIGIN,
            retrieved_at=datetime(2026, 8, 25, tzinfo=timezone.utc),
            validated_at=datetime(2026, 8, 25, tzinfo=timezone.utc),
        )
        canary = "credential-canary-never-persist"
        for backend in (MemoryCache(), DiskCache(self.cache_root, touch_on_read=False)):
            with self.subTest(backend=type(backend).__name__):
                catalog = CachedCatalog(
                    body=json.dumps({"X-API-Key": canary}).encode(),
                    metadata=metadata,
                )
                with self.assertRaises(CacheConfigurationError):
                    backend.publish_catalog(catalog)
                if isinstance(backend, DiskCache):
                    persisted = [
                        path.read_bytes()
                        for path in self.cache_root.rglob("*")
                        if path.is_file()
                    ]
                    self.assertNotIn(canary.encode(), b"".join(persisted))

        disk = DiskCache(self.cache_root, touch_on_read=False)
        candidate = make_skill_object(
            "credential-free-object",
            datetime(2026, 8, 25, tzinfo=timezone.utc),
        )
        with patch.dict(os.environ, {"X_API_KEY": canary}):
            disk.publish_object(candidate)
        persisted_object = b"".join(
            path.read_bytes()
            for path in disk.object_path(candidate.digest).rglob("*")
            if path.is_file()
        )
        self.assertNotIn(canary.encode(), persisted_object)

    def test_catalog_parse_errors_do_not_retain_raw_bytes_in_exception_graph(self) -> None:
        canary = "raw-catalog-secret-canary"
        catalog = CachedCatalog(
            body=f'{{"broken":"{canary}"'.encode(),
            metadata=CatalogMetadata(
                canonical_url=FIXTURE_ORIGIN,
                retrieved_at=datetime(2026, 8, 25, tzinfo=timezone.utc),
                validated_at=datetime(2026, 8, 25, tzinfo=timezone.utc),
            ),
        )

        for backend in (MemoryCache(), DiskCache(self.cache_root, touch_on_read=False)):
            with self.subTest(backend=type(backend).__name__):
                with self.assertRaises(CacheCorruptError) as raised:
                    backend.publish_catalog(catalog)
                pending: list[BaseException] = [raised.exception]
                seen: set[int] = set()
                rendered: list[str] = []
                while pending:
                    error = pending.pop()
                    if id(error) in seen:
                        continue
                    seen.add(id(error))
                    rendered.extend((str(error), repr(error), repr(vars(error))))
                    for linked in (error.__cause__, error.__context__):
                        if linked is not None:
                            pending.append(linked)
                self.assertNotIn(canary, "\n".join(rendered))

    def test_expired_temporary_generations_with_bad_writer_metadata_are_reclaimed(self) -> None:
        temporary_root = self.cache_root / "cache-v1" / "tmp"
        cases = {
            "missing": None,
            "truncated": b'{"pid":',
            "malformed": b'{"pid":"not-an-integer"}',
        }
        for name, writer in cases.items():
            candidate = temporary_root / name
            candidate.mkdir(parents=True)
            (candidate / "sentinel").write_text("stale", encoding="utf-8")
            if writer is not None:
                (candidate / "writer.json").write_bytes(writer)
        stale = (datetime(2026, 8, 25, 8, 0, tzinfo=timezone.utc)).timestamp()
        for path in temporary_root.rglob("*"):
            os.utime(path, (stale, stale))
        os.utime(temporary_root, (stale, stale))
        cache = DiskCache(
            self.cache_root,
            touch_on_read=False,
            clock=lambda: datetime(2026, 8, 25, 10, 0, tzinfo=timezone.utc),
            process_is_alive=lambda pid, process_nonce: False,
            process_identity=lambda pid: "cleanup-process",
        )

        self.assertEqual(cache.cleanup_stale_temporaries(max_age_seconds=60), 3)
        self.assertEqual(list(temporary_root.iterdir()), [])

    def test_zero_scan_budget_fails_closed_for_maintenance_paths(self) -> None:
        cache = DiskCache(
            self.cache_root,
            touch_on_read=False,
            clock=lambda: datetime(2026, 8, 25, 10, 0, tzinfo=timezone.utc),
        )
        lease = cache.acquire_lease(
            FIXTURE_DIGEST,
            process_nonce="scan-budget",
            session_nonce="lease",
        )
        limited = DiskCache(
            self.cache_root,
            touch_on_read=False,
            clock=lambda: datetime(2026, 8, 25, 11, 0, tzinfo=timezone.utc),
            max_scan_entries=0,
        )

        self.assertTrue(limited.has_live_lease(FIXTURE_DIGEST))
        self.assertEqual(limited.cleanup_stale_leases(lease_expiry_seconds=1), 0)
        self.assertTrue(cache._lease_path(lease).is_file())

    def test_numeric_api_limits_reject_non_safe_integers_before_mutation(self) -> None:
        invalid = (True, False, 1.5, float("nan"), float("inf"), -1, 2**53)
        for index, value in enumerate(invalid):
            for operation in ("evict_bytes", "evict_age", "evict_lease", "lease", "tmp"):
                root = Path(self.temporary.name) / f"numeric-{index}-{operation}"
                cache = DiskCache(root, touch_on_read=False)
                with self.subTest(value=value, operation=operation):
                    with self.assertRaises(CacheConfigurationError):
                        if operation == "evict_bytes":
                            cache.evict(max_bytes=value, max_age_seconds=0)  # type: ignore[arg-type]
                        elif operation == "evict_age":
                            cache.evict(max_bytes=0, max_age_seconds=value)  # type: ignore[arg-type]
                        elif operation == "evict_lease":
                            cache.evict(
                                max_bytes=0,
                                max_age_seconds=0,
                                lease_expiry_seconds=value,  # type: ignore[arg-type]
                            )
                        elif operation == "lease":
                            cache.cleanup_stale_leases(
                                lease_expiry_seconds=value,  # type: ignore[arg-type]
                            )
                        else:
                            cache.cleanup_stale_temporaries(
                                max_age_seconds=value,  # type: ignore[arg-type]
                            )
                    self.assertFalse(root.exists())

    def test_windows_coordination_validates_maintenance_limits_before_mutation(self) -> None:
        root = Path(self.temporary.name) / "windows-invalid-maintenance"
        cache = DiskCache(root, touch_on_read=False)

        with (
            patch("remote_skills.cache.disk._windows_mode", return_value=True),
            self.assertRaises(CacheConfigurationError),
        ):
            cache.cleanup_stale_temporaries(max_age_seconds=-1)

        self.assertFalse(root.exists())

    def test_old_malformed_lease_is_reclaimed_but_recent_record_fails_closed(self) -> None:
        now = datetime(2026, 8, 25, 10, 0, tzinfo=timezone.utc)
        cache = DiskCache(
            self.cache_root,
            touch_on_read=False,
            clock=lambda: now,
            process_is_alive=lambda pid, process_nonce: False,
            process_identity=lambda pid: "cleanup-process",
        )
        lease_directory = cache.namespace / "leases" / FIXTURE_DIGEST[7:]
        lease_directory.mkdir(parents=True)
        old = lease_directory / "old-malformed.json"
        recent = lease_directory / "recent-malformed.json"
        old.write_bytes(b'{"broken":')
        recent.write_bytes(b'{"broken":')
        stale = (now - timedelta(hours=1)).timestamp()
        os.utime(old, (stale, stale))

        self.assertTrue(cache.has_live_lease(FIXTURE_DIGEST, lease_expiry_seconds=60))
        self.assertEqual(cache.cleanup_stale_leases(lease_expiry_seconds=60), 1)
        self.assertFalse(old.exists())
        self.assertTrue(recent.exists())
        self.assertTrue(cache.has_live_lease(FIXTURE_DIGEST, lease_expiry_seconds=60))

        recent.unlink()
        cached = make_skill_object("malformed-lease-eviction", now - timedelta(hours=2))
        cache.publish_object(cached)
        stale_record = cache.namespace / "leases" / cached.digest[7:] / "stale.json"
        stale_record.parent.mkdir(parents=True, exist_ok=True)
        stale_record.write_bytes(b"not-json")
        os.utime(stale_record, (stale, stale))
        result = cache.evict(max_bytes=0, max_age_seconds=0, lease_expiry_seconds=60)
        self.assertIn(cached.digest, result.removed_digests)
        self.assertFalse(stale_record.exists())

    def test_lease_mutations_close_verified_snapshots_before_replace_or_unlink(self) -> None:
        current = datetime(2026, 8, 25, 10, 0, tzinfo=timezone.utc)
        cache = DiskCache(
            self.cache_root,
            touch_on_read=False,
            clock=lambda: current,
            process_is_alive=lambda pid, process_nonce: False,
            process_identity=lambda pid: "no-delete-sharing-process",
        )
        lease = cache.acquire_lease(
            FIXTURE_DIGEST,
            process_nonce="no-delete-sharing",
            session_nonce="renew-release",
            pid=4242,
        )
        active_snapshots = 0
        original_locked = disk_cache_module._locked_regular_file_at
        original_replace = disk_cache_module._atomic_replace_file_at
        original_unlink = disk_cache_module._unlink_at

        @contextmanager
        def tracked_snapshot(*args: object, **kwargs: object):
            nonlocal active_snapshots
            with original_locked(*args, **kwargs) as snapshot:
                active_snapshots += 1
                try:
                    yield snapshot
                finally:
                    active_snapshots -= 1

        def replace_without_delete_sharing(*args: object, **kwargs: object) -> None:
            if active_snapshots:
                raise PermissionError("simulated Windows no-delete-sharing replace")
            original_replace(*args, **kwargs)

        def unlink_without_delete_sharing(*args: object, **kwargs: object) -> None:
            if active_snapshots:
                raise PermissionError("simulated Windows no-delete-sharing unlink")
            original_unlink(*args, **kwargs)

        with (
            patch.object(disk_cache_module, "_locked_regular_file_at", tracked_snapshot),
            patch.object(
                disk_cache_module,
                "_atomic_replace_file_at",
                replace_without_delete_sharing,
            ),
            patch.object(disk_cache_module, "_unlink_at", unlink_without_delete_sharing),
            patch.object(
                disk_cache_module,
                "_requires_closed_mutation_snapshot",
                return_value=True,
            ),
        ):
            current += timedelta(seconds=1)
            renewed = cache.renew_lease(lease)
            cache.release_lease(renewed)
            stale = cache.acquire_lease(
                FIXTURE_DIGEST,
                process_nonce="no-delete-sharing",
                session_nonce="stale-cleanup",
                pid=4242,
            )
            current += timedelta(hours=1)
            self.assertEqual(cache.cleanup_stale_leases(lease_expiry_seconds=1), 1)
            self.assertFalse(cache._lease_path(stale).exists())

    def test_object_catalog_and_lease_reads_reject_oversize_before_reading(self) -> None:
        cached = fixture_object()
        writer = DiskCache(self.cache_root, touch_on_read=False)
        writer.publish_object(cached)
        catalog = DiskCache(VALID_STATE, touch_on_read=False).get_catalog(FIXTURE_ORIGIN)
        if catalog is None:
            self.fail("checked-in catalog is missing")
        writer.publish_catalog(catalog)
        lease = writer.acquire_lease(
            cached.digest,
            process_nonce="bounded-read",
            session_nonce="lease",
        )
        object_metadata = writer.object_path(cached.digest) / "object.json"
        catalog_body = writer.catalog_path(FIXTURE_ORIGIN) / "body.json"
        lease_path = writer._lease_path(lease)

        readers = (
            (
                DiskCache(
                    self.cache_root,
                    touch_on_read=False,
                    max_object_metadata_bytes=object_metadata.stat().st_size - 1,
                ),
                lambda cache: cache.get_object(cached.digest),
            ),
            (
                DiskCache(
                    self.cache_root,
                    touch_on_read=False,
                    max_catalog_bytes=catalog_body.stat().st_size - 1,
                ),
                lambda cache: cache.get_catalog(FIXTURE_ORIGIN),
            ),
            (
                DiskCache(
                    self.cache_root,
                    touch_on_read=False,
                    max_lease_metadata_bytes=lease_path.stat().st_size - 1,
                ),
                lambda cache: cache.release_lease(lease),
            ),
        )
        original_read = os.read

        def guarded_read(descriptor: int, size: int) -> bytes:
            opened = Path(f"/dev/fd/{descriptor}")
            try:
                target = opened.resolve()
            except OSError:
                target = None
            if target in {object_metadata, catalog_body, lease_path}:
                self.fail("oversized managed file was read before its size bound")
            return original_read(descriptor, size)

        with patch("remote_skills.cache.disk.os.read", guarded_read):
            for cache, operation in readers:
                with self.subTest(operation=operation):
                    with self.assertRaises(CacheCorruptError):
                        operation(cache)

    def test_artifact_and_extracted_tree_limits_apply_to_candidates_and_disk_reads(self) -> None:
        timestamp = datetime(2026, 8, 25, 10, 0, tzinfo=timezone.utc)

        def archive(files: dict[str, bytes]) -> CachedObject:
            artifact = b"verified archive bytes"
            return CachedObject(
                digest=f"sha256:{hashlib.sha256(artifact).hexdigest()}",
                artifact_type="archive",
                archive_format="zip",
                artifact=artifact,
                files=files,
                media_types={path: "application/octet-stream" for path in files},
                verified_at=timestamp,
                accessed_at=timestamp,
            )

        cases = (
            ({"a.txt": b"a", "b.txt": b"b"}, {"max_files_per_object": 1}),
            ({"a/b.txt": b"a"}, {"max_path_depth": 1}),
            ({"a.txt": b"ab"}, {"max_file_bytes": 1}),
            ({"a.txt": b"a", "b.txt": b"b"}, {"max_extracted_bytes": 1}),
        )
        for files, limits in cases:
            with self.subTest(limits=limits):
                with self.assertRaises(CacheCorruptError):
                    DiskCache(
                        self.cache_root,
                        touch_on_read=False,
                        archive_verifier=lambda candidate: True,
                        **limits,
                    ).publish_object(archive(files))

        stored = archive({"SKILL.md": b"skill", "references/a.txt": b"a"})
        DiskCache(
            self.cache_root,
            touch_on_read=False,
            archive_verifier=lambda candidate: True,
        ).publish_object(stored)
        for limits in (
            {"max_artifact_bytes": len(stored.artifact) - 1},
            {"max_files_per_object": 1},
            {"max_path_depth": 1},
            {"max_file_bytes": 1},
            {"max_extracted_bytes": 1},
            {"max_scan_entries": 1},
        ):
            with self.subTest(stored_limits=limits):
                with self.assertRaises(CacheCorruptError):
                    DiskCache(
                        self.cache_root,
                        touch_on_read=False,
                        archive_verifier=lambda candidate: True,
                        **limits,
                    ).get_object(stored.digest)

    def test_eviction_scans_metadata_and_stats_without_materializing_objects(self) -> None:
        cache = DiskCache(self.cache_root, touch_on_read=False)
        cache.publish_object(fixture_object())

        with patch.object(
            cache,
            "_read_object",
            side_effect=AssertionError("eviction materialized an object"),
        ):
            result = cache.evict(
                max_bytes=2**53 - 1,
                max_age_seconds=2**31 - 1,
            )

        self.assertEqual(result.removed_digests, ())

    def test_portable_paths_use_nfc_colon_and_pinned_unicode_15_semantics(self) -> None:
        timestamp = datetime(2026, 8, 25, 10, 0, tzinfo=timezone.utc)

        def candidate(paths: tuple[str, ...]) -> CachedObject:
            artifact = ("portable archive\n" + "\n".join(paths)).encode("utf-8")
            return CachedObject(
                digest=f"sha256:{hashlib.sha256(artifact).hexdigest()}",
                artifact_type="archive",
                archive_format="zip",
                artifact=artifact,
                files={path: path.encode("utf-8") for path in paths},
                media_types={path: "text/plain" for path in paths},
                verified_at=timestamp,
                accessed_at=timestamp,
            )

        for invalid in ("references/e\u0301.txt", "references/file.txt:stream"):
            with self.subTest(candidate=invalid):
                with self.assertRaises(CacheCorruptError):
                    DiskCache(
                        self.cache_root,
                        touch_on_read=False,
                        archive_verifier=lambda value: True,
                    ).publish_object(candidate((invalid,)))

        pinned = candidate(("references/\u1c89.txt", "references/\u1c8a.txt"))
        self.assertEqual(
            MemoryCache(archive_verifier=lambda value: True).publish_object(pinned),
            pinned,
        )
        metadata_cache = DiskCache(
            self.cache_root,
            touch_on_read=False,
            archive_verifier=lambda value: True,
        )
        metadata_directory = Path(self.temporary.name) / "post-unicode-15-metadata"
        metadata_directory.mkdir()
        (metadata_directory / "object.json").write_bytes(
            metadata_cache._serialize_object(pinned)
        )
        _, expected_sizes = metadata_cache._read_object_metadata(
            None,
            metadata_directory,
            pinned.digest,
        )
        self.assertEqual(set(expected_sizes), set(pinned.files))
        self.assertEqual(pinned_unicode_15_casefold("\u1c89"), "\u1c89")
        table_digest = hashlib.sha256()
        for codepoint in range(0x110000):
            if 0xD800 <= codepoint <= 0xDFFF:
                continue
            table_digest.update(
                f"{codepoint:x};{pinned_unicode_15_casefold(chr(codepoint))}\n".encode()
            )
        self.assertEqual(
            table_digest.hexdigest(),
            "30cd34c5c42b505aaa96c4694785ad1fd6dbcd026243f34f1d71ee1f3ac80007",
        )

        for invalid in ("references/e\u0301.txt", "references/file.txt:stream"):
            with self.subTest(stored=invalid):
                isolated = Path(self.temporary.name) / hashlib.sha256(invalid.encode()).hexdigest()
                disk = DiskCache(
                    isolated,
                    touch_on_read=False,
                    archive_verifier=lambda value: True,
                )
                valid = candidate(("references/safe.txt",))
                disk.publish_object(valid)
                object_path = disk.object_path(valid.digest)
                metadata_path = object_path / "object.json"
                metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
                metadata["files"][0]["path"] = invalid
                metadata_path.write_text(json.dumps(metadata), encoding="utf-8")
                (object_path / "root/references/safe.txt").rename(
                    object_path / "root" / Path(*invalid.split("/"))
                )
                with self.assertRaises(CacheCorruptError):
                    disk.get_object(valid.digest)

    def test_persisted_timestamps_and_integers_require_canonical_shared_ranges(self) -> None:
        self.assertEqual(
            disk_cache_module._parse_timestamp("2026-08-25T10:00:00.123Z"),
            datetime(2026, 8, 25, 10, 0, 0, 123000, tzinfo=timezone.utc),
        )
        for invalid in (
            "2026-08-25T10:00:00Z",
            "2026-08-25T10:00:00.123456Z",
            "2026-02-30T10:00:00.000Z",
        ):
            with self.subTest(timestamp=invalid):
                with self.assertRaises(ValueError):
                    disk_cache_module._parse_timestamp(invalid)
        self.assertEqual(disk_cache_module._integer(2**53 - 1), 2**53 - 1)
        with self.assertRaises(ValueError):
            disk_cache_module._integer(2**53)

        cache = DiskCache(self.cache_root, touch_on_read=False)
        cache.publish_object(fixture_object())
        metadata_path = cache.object_path(FIXTURE_DIGEST) / "object.json"
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        metadata["verified_at"] = "2026-08-25T10:00:00Z"
        metadata_path.write_text(json.dumps(metadata), encoding="utf-8")
        with self.assertRaises(CacheCorruptError):
            cache.get_object(FIXTURE_DIGEST)


class CacheReviewRoundTwoTest(TemporaryCacheTestCase):
    def test_unicode_15_nfc_order_is_identical_for_memory_and_disk(self) -> None:
        timestamp = datetime(2026, 8, 25, 10, 0, tzinfo=timezone.utc)

        def candidate(path: str) -> CachedObject:
            artifact = b"unicode-15-normalization"
            return CachedObject(
                digest=f"sha256:{hashlib.sha256(artifact).hexdigest()}",
                artifact_type="archive",
                archive_format="zip",
                artifact=artifact,
                files={path: b"content"},
                media_types={path: "text/plain"},
                verified_at=timestamp,
                accessed_at=timestamp,
            )

        noncanonical = "references/\U0001e4ec\u0300.txt"
        canonical = "references/\u0300\U0001e4ec.txt"
        for backend in (
            MemoryCache(archive_verifier=lambda value: True),
            DiskCache(
                self.cache_root,
                touch_on_read=False,
                archive_verifier=lambda value: True,
            ),
        ):
            with self.subTest(backend=type(backend).__name__):
                with self.assertRaises(CacheCorruptError):
                    backend.publish_object(candidate(noncanonical))
                self.assertEqual(backend.publish_object(candidate(canonical)), candidate(canonical))

    def test_old_oversized_lease_is_recoverable_but_recent_one_pins(self) -> None:
        now = datetime(2026, 8, 25, 10, 0, tzinfo=timezone.utc)
        cache = DiskCache(
            self.cache_root,
            touch_on_read=False,
            clock=lambda: now,
            process_identity=lambda pid: "oversized-lease-cleaner",
            process_is_alive=lambda pid, nonce: False,
            max_lease_metadata_bytes=32,
        )
        paths: list[Path] = []
        for label in ("old", "recent"):
            digest = f"sha256:{hashlib.sha256(label.encode()).hexdigest()}"
            directory = cache.namespace / "leases" / digest[7:]
            directory.mkdir(parents=True)
            path = directory / f"{label}-oversized.json"
            path.write_bytes(b"{" + b"x" * 128 + b"}")
            paths.append(path)
        stale = (now - timedelta(hours=1)).timestamp()
        os.utime(paths[0], (stale, stale))

        self.assertFalse(
            cache.has_live_lease(
                f"sha256:{hashlib.sha256(b'old').hexdigest()}",
                lease_expiry_seconds=60,
            )
        )
        self.assertTrue(
            cache.has_live_lease(
                f"sha256:{hashlib.sha256(b'recent').hexdigest()}",
                lease_expiry_seconds=60,
            )
        )
        self.assertEqual(cache.cleanup_stale_leases(lease_expiry_seconds=60), 1)
        self.assertFalse(paths[0].exists())
        self.assertTrue(paths[1].exists())

    def test_old_oversized_claim_is_recoverable_but_recent_one_is_retained(self) -> None:
        now = datetime(2026, 8, 25, 10, 0, tzinfo=timezone.utc)
        cache = DiskCache(
            self.cache_root,
            touch_on_read=False,
            clock=lambda: now,
            process_identity=lambda pid: "oversized-claim-cleaner",
            process_is_alive=lambda pid, nonce: False,
            max_lease_metadata_bytes=32,
            lease_expiry_seconds=60,
        )
        claims: list[tuple[str, Path]] = []
        for label in ("old-claim", "recent-claim"):
            digest = f"sha256:{hashlib.sha256(label.encode()).hexdigest()}"
            directory = cache.namespace / "leases" / digest[7:]
            directory.mkdir(parents=True)
            claim = directory / ".eviction-claim.json"
            claim.write_bytes(b"{" + b"x" * 2048 + b"}")
            claims.append((digest, claim))
        stale = (now - timedelta(hours=1)).timestamp()
        os.utime(claims[0][1], (stale, stale))

        replacement = cache._acquire_eviction_claim(claims[0][0])
        self.assertLessEqual(
            claims[0][1].stat().st_size,
            cache._claim_metadata_limit(),
        )
        cache._release_eviction_claim(replacement)
        self.assertFalse(claims[0][1].exists())
        self.assertFalse(cache._reclaim_stale_eviction_claim(claims[1][0]))
        self.assertTrue(claims[1][1].exists())

    def test_cache_errors_retain_no_raw_digest_or_exception_canary(self) -> None:
        canary = "raw-cache-exception-canary"
        invalid = replace(fixture_object(), digest=f"sha256:{canary}")

        def verifier(value: CachedObject) -> bool:
            raise ValueError(canary, value.artifact)

        errors: list[BaseException] = []
        for operation in (
            lambda: MemoryCache().publish_object(invalid),
            lambda: MemoryCache(archive_verifier=verifier).publish_object(
                make_archive_object("sanitized-verifier", datetime.now(timezone.utc))
            ),
            lambda: DiskCache(self.cache_root, touch_on_read=False).get_object(canary),
        ):
            try:
                operation()
            except BaseException as error:
                errors.append(error)
            else:
                self.fail("invalid cache operation unexpectedly succeeded")

        rendered: list[str] = []
        pending = list(errors)
        seen: set[int] = set()
        while pending:
            error = pending.pop()
            if id(error) in seen:
                continue
            seen.add(id(error))
            rendered.extend((str(error), repr(error), repr(vars(error))))
            for linked in (error.__cause__, error.__context__):
                if linked is not None:
                    pending.append(linked)
        self.assertNotIn(canary, "\n".join(rendered))

    def test_lease_cleanup_uses_one_operation_wide_scan_budget(self) -> None:
        now = datetime(2026, 8, 25, 10, 0, tzinfo=timezone.utc)
        writer = DiskCache(self.cache_root, touch_on_read=False)
        records: list[Path] = []
        for label in ("one", "two"):
            digest = f"sha256:{hashlib.sha256(label.encode()).hexdigest()}"
            directory = writer.namespace / "leases" / digest[7:]
            directory.mkdir(parents=True)
            record = directory / f"{label}.json"
            record.write_bytes(b"not-json")
            records.append(record)
        stale = (now - timedelta(hours=1)).timestamp()
        for record in records:
            os.utime(record, (stale, stale))
        limited = DiskCache(
            self.cache_root,
            touch_on_read=False,
            clock=lambda: now,
            process_identity=lambda pid: "scan-budget-cleaner",
            process_is_alive=lambda pid, nonce: False,
            max_scan_entries=2,
        )

        self.assertEqual(limited.cleanup_stale_leases(lease_expiry_seconds=60), 0)
        self.assertTrue(all(record.exists() for record in records))

    def test_lease_cleanup_releases_resources_after_preflight_failure(self) -> None:
        for failure in ("scan_budget", "directory_open", "enumeration_io"):
            with self.subTest(failure=failure):
                cache = DiskCache(
                    self.cache_root / failure,
                    touch_on_read=False,
                    process_identity=lambda _pid: "cleanup-process",
                )
                lease = cache.acquire_lease(
                    FIXTURE_DIGEST,
                    process_nonce="cleanup-owner",
                    session_nonce="original",
                )
                self.addCleanup(cache.release_lease, lease)
                directory = cache._lease_path(lease).parent
                claims: list[disk_cache_module._EvictionClaim] = []
                descriptor: int | None = None
                descriptor_closed = False
                failed = False
                original_acquire = DiskCache._acquire_eviction_claim
                original_open = disk_cache_module._open_directory
                original_names = disk_cache_module._bounded_directory_names
                original_close = os.close

                def acquire(instance: DiskCache, digest: str) -> disk_cache_module._EvictionClaim:
                    claim = original_acquire(instance, digest)
                    claims.append(claim)
                    return claim

                def open_directory(
                    path: Path,
                    parent_descriptor: int | None = None,
                ) -> int | None:
                    nonlocal failed
                    if (
                        claims
                        and path == directory
                        and not failed
                        and failure == "directory_open"
                    ):
                        failed = True
                        raise OSError("directory unavailable")
                    return original_open(path, parent_descriptor)

                def names(
                    directory_descriptor: int | None,
                    directory_path: Path,
                    *,
                    max_entries: int,
                    scan_budget: disk_cache_module._ScanBudget | None = None,
                ) -> list[str]:
                    nonlocal descriptor, failed
                    if claims and directory_path == directory and not failed:
                        descriptor = directory_descriptor
                        failed = True
                        if failure == "enumeration_io":
                            raise OSError("directory enumeration unavailable")
                        self.assertIsNotNone(scan_budget)
                        scan_budget.limit = scan_budget.used
                    return original_names(
                        directory_descriptor,
                        directory_path,
                        max_entries=max_entries,
                        scan_budget=scan_budget,
                    )

                def close(value: int) -> None:
                    nonlocal descriptor_closed
                    original_close(value)
                    if descriptor is not None and value == descriptor:
                        descriptor_closed = True

                try:
                    with (
                        patch.object(DiskCache, "_acquire_eviction_claim", acquire),
                        patch.object(disk_cache_module, "_open_directory", open_directory),
                        patch.object(disk_cache_module, "_bounded_directory_names", names),
                        patch.object(disk_cache_module.os, "close", close),
                    ):
                        self.assertEqual(cache.cleanup_stale_leases(), 0)

                    self.assertTrue(failed)
                    self.assertEqual(len(claims), 1)
                    if descriptor is not None:
                        self.assertTrue(descriptor_closed)
                    self.assertFalse((directory / ".eviction-claim.json").exists())
                    gate = claims[0].gate
                    self.assertIsNotNone(gate)
                    self.assertTrue(gate.heartbeat.stop.is_set())
                    self.assertFalse(gate.heartbeat.thread.is_alive())
                    self.assertTrue(cache._lease_path(lease).is_file())
                    successor = cache.acquire_lease(
                        FIXTURE_DIGEST,
                        process_nonce="cleanup-owner",
                        session_nonce="subsequent",
                    )
                    cache.release_lease(successor)
                finally:
                    if descriptor is not None and not descriptor_closed:
                        original_close(descriptor)
                    for claim in claims:
                        if claim.gate is not None and claim.gate.heartbeat.thread.is_alive():
                            cache._release_eviction_claim(claim)

    def test_eviction_uses_one_operation_wide_object_tree_budget(self) -> None:
        writer = DiskCache(self.cache_root, touch_on_read=False)
        timestamp = datetime(2026, 8, 25, 10, 0, tzinfo=timezone.utc)
        writer.publish_object(make_skill_object("scan-one", timestamp))
        writer.publish_object(make_skill_object("scan-two", timestamp))
        limited = DiskCache(
            self.cache_root,
            touch_on_read=False,
            max_scan_entries=14,
        )

        with self.assertRaises(CacheCorruptError):
            limited.evict(max_bytes=0, max_age_seconds=0)

    def test_wide_catalog_extensions_fail_before_enqueuing_past_budget(self) -> None:
        body = json.dumps([{}] * 100_001).encode()
        catalog = CachedCatalog(
            body=body,
            metadata=CatalogMetadata(
                canonical_url=FIXTURE_ORIGIN,
                retrieved_at=datetime(2026, 8, 25, tzinfo=timezone.utc),
                validated_at=datetime(2026, 8, 25, tzinfo=timezone.utc),
            ),
        )
        for backend in (MemoryCache(), DiskCache(self.cache_root, touch_on_read=False)):
            with self.subTest(backend=type(backend).__name__):
                with self.assertRaises(CacheCorruptError):
                    backend.publish_catalog(catalog)

    def test_oversized_lease_in_place_successor_is_not_removed(self) -> None:
        now = datetime(2026, 8, 25, 10, 0, tzinfo=timezone.utc)
        cache = DiskCache(
            self.cache_root,
            touch_on_read=False,
            clock=lambda: now,
            process_identity=lambda pid: "generation-cleaner",
            process_is_alive=lambda pid, nonce: False,
            max_lease_metadata_bytes=32,
        )
        digest = f"sha256:{hashlib.sha256(b'lease-generation').hexdigest()}"
        directory = cache.namespace / "leases" / digest[7:]
        directory.mkdir(parents=True)
        record = directory / "oversized.json"
        record.write_bytes(b"{" + b"x" * 128 + b"}")
        stale = (now - timedelta(hours=1)).timestamp()
        os.utime(record, (stale, stale))
        matcher_name = (
            "_entry_matches_generation"
            if hasattr(disk_cache_module, "_entry_matches_generation")
            else "_entry_matches_identity"
        )
        original_match = getattr(disk_cache_module, matcher_name)
        replaced = False

        def replace_before_match(*args: object, **kwargs: object) -> bool:
            nonlocal replaced
            if not replaced:
                record.write_bytes(b"successor-generation")
                replaced = True
            return original_match(*args, **kwargs)

        with patch.object(
            disk_cache_module,
            matcher_name,
            replace_before_match,
        ):
            self.assertEqual(cache.cleanup_stale_leases(lease_expiry_seconds=60), 0)

        self.assertTrue(replaced)
        self.assertEqual(record.read_bytes(), b"successor-generation")

    def test_oversized_claim_in_place_successor_is_not_removed(self) -> None:
        now = datetime(2026, 8, 25, 10, 0, tzinfo=timezone.utc)
        cache = DiskCache(
            self.cache_root,
            touch_on_read=False,
            clock=lambda: now,
            process_identity=lambda pid: "generation-cleaner",
            process_is_alive=lambda pid, nonce: False,
            max_lease_metadata_bytes=32,
            lease_expiry_seconds=60,
        )
        digest = f"sha256:{hashlib.sha256(b'claim-generation').hexdigest()}"
        directory = cache.namespace / "leases" / digest[7:]
        directory.mkdir(parents=True)
        claim = directory / ".eviction-claim.json"
        claim.write_bytes(b"{" + b"x" * 2048 + b"}")
        stale = (now - timedelta(hours=1)).timestamp()
        os.utime(claim, (stale, stale))
        matcher_name = (
            "_entry_matches_generation"
            if disk_cache_module._requires_closed_mutation_snapshot()
            else "_entry_matches_descriptor"
        )
        original_match = getattr(disk_cache_module, matcher_name)
        replaced = False

        def replace_before_match(*args: object, **kwargs: object) -> bool:
            nonlocal replaced
            if not replaced and (
                matcher_name == "_entry_matches_generation"
                or kwargs.get("expected") is not None
            ):
                claim.write_bytes(b"successor-generation")
                replaced = True
            return original_match(*args, **kwargs)

        with patch.object(
            disk_cache_module,
            matcher_name,
            replace_before_match,
        ):
            self.assertFalse(cache._reclaim_stale_eviction_claim(digest))

        self.assertTrue(replaced)
        self.assertEqual(claim.read_bytes(), b"successor-generation")

    def test_deep_catalog_extensions_fail_with_stable_limit_not_recursion(self) -> None:
        depth = 550
        body = ("[" * depth + "{}" + "]" * depth).encode()
        catalog = CachedCatalog(
            body=body,
            metadata=CatalogMetadata(
                canonical_url=FIXTURE_ORIGIN,
                retrieved_at=datetime(2026, 8, 25, tzinfo=timezone.utc),
                validated_at=datetime(2026, 8, 25, tzinfo=timezone.utc),
            ),
        )
        for backend in (MemoryCache(), DiskCache(self.cache_root, touch_on_read=False)):
            with self.subTest(backend=type(backend).__name__):
                with self.assertRaises(CacheCorruptError):
                    backend.publish_catalog(catalog)

    def test_memory_validates_digest_pid_and_lease_values_like_disk(self) -> None:
        memory = MemoryCache()
        invalid_digests: tuple[object, ...] = (
            "not-a-digest",
            "sha256:" + "A" * 64,
            "sha256:" + "0" * 63,
            None,
            True,
        )
        for digest in invalid_digests:
            with self.subTest(digest=digest):
                with self.assertRaises(ValueError):
                    memory.get_object(digest)
                with self.assertRaises(ValueError):
                    memory.has_live_lease(digest)
                with self.assertRaises(ValueError):
                    memory.acquire_lease(
                        digest,
                        process_nonce="memory-validation",
                        session_nonce="digest",
                    )
        for pid in (True, 1.5, 0, -1, 2**53):
            with self.subTest(pid=pid):
                with self.assertRaises(CacheConfigurationError):
                    memory.acquire_lease(
                        FIXTURE_DIGEST,
                        process_nonce="memory-validation",
                        session_nonce=f"pid-{repr(pid)}".replace(".", "-"),
                        pid=pid,  # type: ignore[arg-type]
                    )
        forged = CacheLease(
            digest=FIXTURE_DIGEST,
            pid=2**53,
            process_nonce="memory-validation",
            session_nonce="forged",
            created_at=datetime(2026, 8, 25, tzinfo=timezone.utc),
            renewed_at=datetime(2026, 8, 25, tzinfo=timezone.utc),
        )
        with self.assertRaises(CacheConfigurationError):
            memory.renew_lease(forged)

    def test_oversized_candidate_is_rejected_before_artifact_hashing(self) -> None:
        candidate = make_skill_object(
            "prehash-bound",
            datetime(2026, 8, 25, tzinfo=timezone.utc),
        )
        cache = DiskCache(
            self.cache_root,
            touch_on_read=False,
            max_artifact_bytes=len(candidate.artifact) - 1,
        )
        with (
            patch(
                "remote_skills.cache.base.hashlib.sha256",
                side_effect=AssertionError("artifact hashed before size bound"),
            ),
            self.assertRaises(CacheCorruptError),
        ):
            cache.publish_object(candidate)

    def test_windows_catalog_read_refreshes_lru_without_directory_descriptor(self) -> None:
        catalog = DiskCache(VALID_STATE, touch_on_read=False).get_catalog(FIXTURE_ORIGIN)
        if catalog is None:
            self.fail("checked-in catalog missing")
        cache = DiskCache(self.cache_root, touch_on_read=True)
        cache.publish_catalog(catalog)
        catalog_path = cache.catalog_path(FIXTURE_ORIGIN)
        old = datetime(2020, 1, 1, tzinfo=timezone.utc).timestamp()
        os.utime(catalog_path, (old, old))

        with (
            patch("remote_skills.cache.disk.sys.platform", "win32"),
            patch("remote_skills.cache.disk.os.supports_dir_fd", set()),
            patch("remote_skills.cache.disk.os.supports_fd", set()),
            patch(
                "remote_skills.cache.disk._open_directory",
                windows_directory_without_descriptor,
            ),
        ):
            self.assertEqual(cache.get_catalog(FIXTURE_ORIGIN), catalog)

        self.assertGreater(catalog_path.stat().st_mtime, old)

    def test_windows_catalog_touch_uses_pinned_generation(self) -> None:
        root = self.cache_root
        root.mkdir()
        catalog = root / "catalog-generation"
        catalog.mkdir()
        saved = root / "saved-generation"
        external = root / "external-generation"
        external.mkdir()
        old = datetime(2020, 1, 1, tzinfo=timezone.utc).timestamp()
        os.utime(catalog, (old, old))
        os.utime(external, (old, old))
        expected = disk_cache_module._identity(catalog.lstat())
        original_utime = os.utime
        swapped = False

        def swap_path_before_touch(target: object, *args: object, **kwargs: object) -> None:
            nonlocal swapped
            self.assertIsInstance(target, int)
            if not swapped:
                catalog.rename(saved)
                catalog.symlink_to(external, target_is_directory=True)
                swapped = True
            original_utime(target, *args, **kwargs)

        timestamp_ns = int(datetime.now(timezone.utc).timestamp() * 1_000_000_000)
        if os.name == "nt":
            original_identity = disk_cache_module._windows_handle_identity

            def swap_path_after_open(handle: int) -> tuple[int, int, int]:
                nonlocal swapped
                identity = original_identity(handle)
                if not swapped:
                    catalog.rename(saved)
                    external.rename(catalog)
                    swapped = True
                return identity

            with patch(
                "remote_skills.cache.disk._windows_handle_identity",
                swap_path_after_open,
            ):
                disk_cache_module._windows_touch_directory(
                    catalog,
                    expected_identity=expected,
                    timestamp_ns=timestamp_ns,
                )
        else:
            with patch("remote_skills.cache.disk.os.utime", swap_path_before_touch):
                disk_cache_module._windows_touch_directory(
                    catalog,
                    expected_identity=expected,
                    timestamp_ns=timestamp_ns,
                )

        self.assertTrue(swapped)
        external_generation = catalog if os.name == "nt" else external
        self.assertEqual(external_generation.stat().st_mtime, old)
        self.assertGreater(saved.stat().st_mtime, old)


class CacheFinalReviewTest(TemporaryCacheTestCase):
    now = datetime(2026, 8, 25, 10, 0, tzinfo=timezone.utc)

    def _stale_tree(self, root: Path) -> None:
        stale = (self.now - timedelta(hours=1)).timestamp()
        for path in sorted(root.rglob("*"), reverse=True):
            os.utime(path, (stale, stale))
        os.utime(root, (stale, stale))

    def test_temporary_cleanup_shares_two_entry_budget_across_payload_directories(
        self,
    ) -> None:
        for windows in (False, True):
            with self.subTest(windows=windows):
                root = Path(self.temporary.name) / f"payloads-{windows}"
                temporary_root = root / "cache-v1/tmp"
                payloads: list[Path] = []
                for name in ("one", "two"):
                    payload = temporary_root / name / "payload"
                    payload.mkdir(parents=True)
                    payloads.append(payload)
                self._stale_tree(temporary_root)
                cache = DiskCache(
                    root,
                    touch_on_read=False,
                    clock=lambda: self.now,
                    process_identity=lambda pid: "temporary-cleaner",
                    max_scan_entries=2,
                )

                with patch(
                    "remote_skills.cache.disk.sys.platform",
                    "win32" if windows else "linux",
                ):
                    removed = cache.cleanup_stale_temporaries(max_age_seconds=60)

                self.assertEqual(removed, 0)
                self.assertEqual(len(list(temporary_root.rglob("payload"))), len(payloads))

    def test_temporary_cleanup_shares_two_entry_budget_with_nested_payloads(
        self,
    ) -> None:
        for windows in (False, True):
            with self.subTest(windows=windows):
                root = Path(self.temporary.name) / f"nested-{windows}"
                temporary_root = root / "cache-v1/tmp"
                payload = temporary_root / "generation/nested/payload"
                payload.mkdir(parents=True)
                self._stale_tree(temporary_root)
                cache = DiskCache(
                    root,
                    touch_on_read=False,
                    clock=lambda: self.now,
                    process_identity=lambda pid: "temporary-cleaner",
                    max_scan_entries=2,
                )

                with patch(
                    "remote_skills.cache.disk.sys.platform",
                    "win32" if windows else "linux",
                ):
                    removed = cache.cleanup_stale_temporaries(max_age_seconds=60)

                self.assertEqual(removed, 0)
                self.assertNotEqual(list(temporary_root.rglob("payload")), [])

    def test_malformed_file_table_types_are_sanitized_cache_corruption(self) -> None:
        canary = "malformed-file-table-canary"

        class UntrustedPath:
            def __hash__(self) -> int:
                return 1

            def __fspath__(self) -> str:
                raise AssertionError(canary)

            def __str__(self) -> str:
                raise AssertionError(canary)

        path = UntrustedPath()
        variants = (
            ({path: b"content"}, {path: "text/plain"}),
            ({"file.txt": object()}, {"file.txt": "text/plain"}),
            ({"file.txt": b"content"}, {"file.txt": object()}),
            ({"file.txt": b"content"}, {7: "text/plain"}),
        )
        artifact = b"malformed mapping candidate"
        digest = f"sha256:{hashlib.sha256(artifact).hexdigest()}"
        for backend in (
            MemoryCache(archive_verifier=lambda value: True),
            DiskCache(
                self.cache_root,
                touch_on_read=False,
                archive_verifier=lambda value: True,
            ),
        ):
            for files, media_types in variants:
                with self.subTest(
                    backend=type(backend).__name__,
                    files=tuple(type(key).__name__ for key in files),
                    media=tuple(type(value).__name__ for value in media_types.values()),
                ):
                    candidate = CachedObject(
                        digest=digest,
                        artifact_type="archive",
                        archive_format="zip",
                        artifact=artifact,
                        files=files,  # type: ignore[arg-type]
                        media_types=media_types,  # type: ignore[arg-type]
                        verified_at=self.now,
                        accessed_at=self.now,
                    )
                    with (
                        patch.object(
                            base_cache_module,
                            "PurePosixPath",
                            side_effect=AssertionError(canary),
                        ),
                        patch.object(
                            disk_cache_module,
                            "PurePosixPath",
                            side_effect=AssertionError(canary),
                        ),
                        self.assertRaises(CacheCorruptError) as raised,
                    ):
                        backend.publish_object(candidate)
                    rendered = "\n".join(
                        (
                            str(raised.exception),
                            repr(raised.exception),
                            repr(vars(raised.exception)),
                        )
                    )
                    self.assertNotIn(canary, rendered)

    def test_hostile_digest_subclass_is_not_retained_or_formatted(self) -> None:
        canary = "hostile-digest-format-canary"

        class HostileDigest(str):
            def __format__(self, format_spec: str) -> str:
                raise RuntimeError(canary)

            def __str__(self) -> str:
                raise RuntimeError(canary)

        candidate = replace(
            fixture_object(),
            digest=HostileDigest(FIXTURE_DIGEST),
            files={"SKILL.md": object()},  # type: ignore[dict-item]
        )
        for backend in (MemoryCache(), DiskCache(self.cache_root, touch_on_read=False)):
            with self.subTest(backend=type(backend).__name__):
                with self.assertRaises(CacheCorruptError) as raised:
                    backend.publish_object(candidate)
                self.assertEqual(
                    raised.exception.context,
                    {
                        "expected_digest": FIXTURE_DIGEST,
                        "layout_version": "cache-v1",
                    },
                )
                rendered = "\n".join(
                    (
                        str(raised.exception),
                        repr(raised.exception),
                        repr(vars(raised.exception)),
                    )
                )
                self.assertNotIn(canary, rendered)

    def test_artifact_type_and_format_contract_is_closed_before_verification(self) -> None:
        invalid = (
            replace(fixture_object(), archive_format="zip"),
            replace(make_archive_object("missing-format", self.now), archive_format=None),
            replace(make_archive_object("unknown-format", self.now), archive_format="rar"),
            replace(make_archive_object("unknown-type", self.now), artifact_type="skill-archive"),
        )
        for backend_name in ("memory", "disk"):
            for index, candidate in enumerate(invalid):
                verifier_calls: list[str] = []

                def verifier(value: CachedObject) -> bool:
                    verifier_calls.append(value.digest)
                    return True

                backend = (
                    MemoryCache(archive_verifier=verifier)
                    if backend_name == "memory"
                    else DiskCache(
                        Path(self.temporary.name) / f"closed-contract-{index}",
                        touch_on_read=False,
                        archive_verifier=verifier,
                    )
                )
                with self.subTest(
                    backend=backend_name,
                    artifact_type=candidate.artifact_type,
                    archive_format=candidate.archive_format,
                ):
                    with self.assertRaises(CacheCorruptError) as raised:
                        backend.publish_object(candidate)
                    self.assertEqual(raised.exception.code, "cache_corrupt")
                    self.assertEqual(verifier_calls, [])
                    self.assertIsNone(backend.get_object(candidate.digest))

        for archive_format in ("zip", "tar.gz"):
            candidate = replace(
                make_archive_object(f"valid-{archive_format}", self.now),
                archive_format=archive_format,
            )
            for backend in (
                MemoryCache(archive_verifier=lambda value: True),
                DiskCache(
                    Path(self.temporary.name) / f"valid-{archive_format}",
                    touch_on_read=False,
                    archive_verifier=lambda value: True,
                ),
            ):
                with self.subTest(
                    backend=type(backend).__name__,
                    archive_format=archive_format,
                ):
                    self.assertEqual(backend.publish_object(candidate), candidate)

    def test_complete_portable_path_rules_match_in_memory_and_on_disk(self) -> None:
        invalid_path_sets = (
            ("CON",),
            ("references/con.txt",),
            ("references/CONIN$.txt",),
            ("references/CONOUT$",),
            ("references/bad?.txt",),
            ('references/bad"name.txt',),
            ("references/less<than.txt",),
            ("references/control\x1f.txt",),
            ("references/trailing.",),
            ("references/trailing ",),
            ("references/e\u0301.txt",),
            ("references/Guide.md", "references/guide.md"),
            ("references/high-\ud800.txt",),
        )

        def candidate(paths: tuple[str, ...], label: str) -> CachedObject:
            artifact = f"portable path candidate {label}".encode()
            return CachedObject(
                digest=f"sha256:{hashlib.sha256(artifact).hexdigest()}",
                artifact_type="archive",
                archive_format="zip",
                artifact=artifact,
                files={path: b"content" for path in paths},
                media_types={path: "text/plain" for path in paths},
                verified_at=self.now,
                accessed_at=self.now,
            )

        for backend_name in ("memory", "disk"):
            for index, paths in enumerate(invalid_path_sets):
                backend = (
                    MemoryCache(archive_verifier=lambda value: True)
                    if backend_name == "memory"
                    else DiskCache(
                        Path(self.temporary.name) / f"portable-{index}",
                        touch_on_read=False,
                        archive_verifier=lambda value: True,
                    )
                )
                invalid = candidate(paths, f"{backend_name}-{index}")
                with self.subTest(backend=backend_name, paths=paths):
                    with self.assertRaises(CacheCorruptError) as raised:
                        backend.publish_object(invalid)
                    self.assertEqual(raised.exception.code, "cache_corrupt")
                    self.assertIsNone(backend.get_object(invalid.digest))

        valid_paths = (
            "CONSOLE.md",
            "references/COM10.txt",
            "references/LPT0",
            "references/COM\u2074.txt",
            "references/CONIN",
            "references/CONOUT.txt",
            "references/CONIN$value",
            "references/file..txt",
            "references/space .txt",
            "references/tilde-~.txt",
            "references/replacement-\ufffd.txt",
        )
        valid = candidate(valid_paths, "valid")
        for backend in (
            MemoryCache(archive_verifier=lambda value: True),
            DiskCache(
                Path(self.temporary.name) / "portable-valid",
                touch_on_read=False,
                archive_verifier=lambda value: True,
            ),
        ):
            with self.subTest(backend=type(backend).__name__, valid=True):
                self.assertEqual(backend.publish_object(valid), valid)

    def test_metadata_strings_require_unicode_scalars_before_storage(self) -> None:
        for backend_name in ("memory", "disk"):
            for index, surrogate in enumerate(("\ud800", "\udfff")):
                verifier_calls: list[str] = []

                def verifier(value: CachedObject) -> bool:
                    verifier_calls.append(value.digest)
                    return True

                object_backend = (
                    MemoryCache(archive_verifier=verifier)
                    if backend_name == "memory"
                    else DiskCache(
                        Path(self.temporary.name) / f"scalar-object-{index}",
                        touch_on_read=False,
                        archive_verifier=verifier,
                    )
                )
                invalid_object = replace(
                    make_archive_object(f"scalar-{backend_name}-{index}", self.now),
                    media_types={"SKILL.md": f"text/plain; note={surrogate}"},
                    files={"SKILL.md": b"content"},
                )
                with self.subTest(backend=backend_name, object_surrogate=hex(ord(surrogate))):
                    with self.assertRaises(CacheCorruptError) as raised:
                        object_backend.publish_object(invalid_object)
                    self.assertEqual(raised.exception.code, "cache_corrupt")
                    self.assertEqual(verifier_calls, [])
                    self.assertIsNone(object_backend.get_object(invalid_object.digest))

                for field in ("canonical_url", "etag", "last_modified", "cache_control"):
                    metadata = CatalogMetadata(
                        canonical_url=FIXTURE_ORIGIN,
                        retrieved_at=self.now,
                        validated_at=self.now,
                    )
                    metadata = replace(
                        metadata,
                        **{
                            field: (
                                f"https://skills.example.test/{surrogate}/index.json"
                                if field == "canonical_url"
                                else f"metadata-{surrogate}"
                            )
                        },
                    )
                    catalog_backend = (
                        MemoryCache()
                        if backend_name == "memory"
                        else DiskCache(
                            Path(self.temporary.name)
                            / f"scalar-catalog-{backend_name}-{index}-{field}",
                            touch_on_read=False,
                        )
                    )
                    with self.subTest(
                        backend=backend_name,
                        catalog_field=field,
                        surrogate=hex(ord(surrogate)),
                    ):
                        with self.assertRaises(CacheCorruptError) as raised:
                            catalog_backend.publish_catalog(
                                CachedCatalog(body=b"{}", metadata=metadata)
                            )
                        self.assertEqual(raised.exception.code, "cache_corrupt")

        replacement = "\ufffd"
        valid_object = replace(
            make_archive_object("valid-scalar", self.now),
            media_types={
                "SKILL.md": f"text/plain; note={replacement}",
                "references/details.txt": "text/plain",
            },
        )
        valid_catalog = CachedCatalog(
            body=b"{}",
            metadata=CatalogMetadata(
                canonical_url=FIXTURE_ORIGIN,
                retrieved_at=self.now,
                validated_at=self.now,
                etag=f'"{replacement}"',
                last_modified=replacement,
                cache_control=f"private, note={replacement}",
            ),
        )
        for backend in (
            MemoryCache(archive_verifier=lambda value: True),
            DiskCache(
                Path(self.temporary.name) / "valid-scalars",
                touch_on_read=False,
                archive_verifier=lambda value: True,
            ),
        ):
            with self.subTest(backend=type(backend).__name__, valid_scalar=True):
                self.assertEqual(backend.publish_object(valid_object), valid_object)
                self.assertEqual(backend.publish_catalog(valid_catalog), valid_catalog)

    def test_cleanup_budget_failure_is_non_destructive_on_both_platform_paths(self) -> None:
        for windows, max_entries in ((False, 2), (True, 4)):
            with self.subTest(windows=windows):
                root = Path(self.temporary.name) / f"preflight-{windows}"
                generation = root / "cache-v1/tmp/generation"
                generation.mkdir(parents=True)
                writer = generation / "writer.json"
                writer.write_text(
                    json.dumps(
                        {
                            "pid": 999_999,
                            "process_identity": "expired-writer",
                        }
                    ),
                    encoding="utf-8",
                )
                payload = generation / "payload/nested/content.txt"
                payload.parent.mkdir(parents=True)
                payload.write_text("complete payload", encoding="utf-8")
                self._stale_tree(generation)
                cache = DiskCache(
                    root,
                    touch_on_read=False,
                    clock=lambda: self.now,
                    process_identity=lambda pid: None,
                    max_scan_entries=max_entries,
                )

                with patch(
                    "remote_skills.cache.disk.sys.platform",
                    "win32" if windows else "linux",
                ):
                    removed = cache.cleanup_stale_temporaries(max_age_seconds=60)

                self.assertEqual(removed, 0)
                self.assertEqual(writer.read_text(encoding="utf-8").startswith("{"), True)
                self.assertEqual(payload.read_text(encoding="utf-8"), "complete payload")
                self.assertEqual(
                    [path.name for path in generation.parent.iterdir()],
                    ["generation"],
                )

    def test_pinned_normalization_is_bounded_before_work_and_not_quadratic(self) -> None:
        class CountingCombining(dict[int, int]):
            calls = 0

            def get(self, key: int, default: int = 0) -> int:
                self.calls += 1
                return super().get(key, default)

        high = "\u0301"
        low = "\u0316"
        combining = CountingCombining({ord(high): 230, ord(low): 220})
        candidate = (high + low) * 60
        with patch.object(
            unicode_normalization_module,
            "_normalization_tables",
            return_value=(combining, {}, {}),
        ):
            normalized = unicode_normalization_module.pinned_unicode_15_nfc(candidate)
        self.assertEqual(normalized, low * 60 + high * 60)
        self.assertLessEqual(combining.calls, len(candidate) * 6)

        invalid_paths = (
            "a" * 4097,
            "\U0001f600" * 1025,
            "a" * 256,
        )
        for backend_name in ("memory", "disk"):
            for index, path in enumerate(invalid_paths):
                artifact = f"bounded-normalization-{backend_name}-{index}".encode()
                cached = CachedObject(
                    digest=f"sha256:{hashlib.sha256(artifact).hexdigest()}",
                    artifact_type="archive",
                    archive_format="zip",
                    artifact=artifact,
                    files={path: b"content"},
                    media_types={path: "text/plain"},
                    verified_at=self.now,
                    accessed_at=self.now,
                )
                backend = (
                    MemoryCache(archive_verifier=lambda value: True)
                    if backend_name == "memory"
                    else DiskCache(
                        Path(self.temporary.name) / f"bounded-path-{index}",
                        touch_on_read=False,
                        archive_verifier=lambda value: True,
                    )
                )
                with (
                    self.subTest(backend=backend_name, index=index),
                    patch.object(
                        base_cache_module,
                        "pinned_unicode_15_nfc",
                        side_effect=AssertionError("normalization-bound-canary"),
                    ),
                    self.assertRaises(CacheCorruptError),
                ):
                    backend.publish_object(cached)

    def test_scalar_subclasses_are_snapshotted_before_keys_storage_and_callbacks(self) -> None:
        canary = "hostile-scalar-subclass-canary"

        class HostileString(str):
            def __hash__(self) -> int:
                raise RuntimeError(canary)

            def __eq__(self, other: object) -> bool:
                raise RuntimeError(canary)

            def __format__(self, format_spec: str) -> str:
                raise RuntimeError(canary)

            def __str__(self) -> str:
                raise RuntimeError(canary)

        class HostileInt(int):
            def __hash__(self) -> int:
                raise RuntimeError(canary)

            def __eq__(self, other: object) -> bool:
                raise RuntimeError(canary)

            def __lt__(self, other: object) -> bool:
                raise RuntimeError(canary)

            def __le__(self, other: object) -> bool:
                raise RuntimeError(canary)

            def __gt__(self, other: object) -> bool:
                raise RuntimeError(canary)

            def __format__(self, format_spec: str) -> str:
                raise RuntimeError(canary)

        class HostileBytes(bytes):
            def __bytes__(self) -> bytes:
                raise RuntimeError(canary)

            def __eq__(self, other: object) -> bool:
                raise RuntimeError(canary)

        class HostileDateTime(datetime):
            def isoformat(self, *args: object, **kwargs: object) -> str:
                raise RuntimeError(canary)

            def utcoffset(self) -> timedelta | None:
                raise RuntimeError(canary)

            def __eq__(self, other: object) -> bool:
                raise RuntimeError(canary)

        class HostileLease(CacheLease):
            def __getattribute__(self, name: str) -> object:
                if name == "process_nonce":
                    raise RuntimeError(canary)
                return super().__getattribute__(name)

        original = make_archive_object("hostile-snapshot", self.now)
        hostile_time = HostileDateTime(
            2026, 8, 25, 10, 0, 0, 123456, tzinfo=timezone.utc
        )
        hostile = CachedObject(
            digest=HostileString(original.digest),
            artifact_type=HostileString(original.artifact_type),
            archive_format=HostileString(original.archive_format or ""),
            artifact=HostileBytes(original.artifact),
            files={path: HostileBytes(content) for path, content in original.files.items()},
            media_types={
                path: HostileString(media_type)
                for path, media_type in original.media_types.items()
            },
            verified_at=hostile_time,
            accessed_at=hostile_time,
        )

        for backend_name in ("memory", "disk"):
            observed: list[CachedObject] = []
            observed_pids: list[int] = []

            def verifier(value: CachedObject) -> bool:
                observed.append(value)
                return all(
                    type(item) in {str, bytes, datetime}
                    for item in (
                        value.digest,
                        value.artifact_type,
                        value.archive_format,
                        value.artifact,
                        *value.files.values(),
                        *value.media_types.values(),
                        value.verified_at,
                        value.accessed_at,
                    )
                )

            backend = (
                MemoryCache(clock=lambda: hostile_time, archive_verifier=verifier)
                if backend_name == "memory"
                else DiskCache(
                    Path(self.temporary.name) / f"hostile-snapshot-{backend_name}",
                    touch_on_read=False,
                    clock=lambda: hostile_time,
                    process_identity=lambda pid: (
                        observed_pids.append(pid) or "hostile-snapshot-process-identity"
                    ),
                    archive_verifier=verifier,
                )
            )
            with self.subTest(backend=backend_name, kind="object"):
                published = backend.publish_object(hostile)
                self.assertGreaterEqual(len(observed), 1)
                self.assertIs(type(published.digest), str)
                self.assertIs(type(published.artifact), bytes)
                self.assertIs(type(published.verified_at), datetime)
                lease = backend.acquire_lease(
                    HostileString(original.digest),
                    process_nonce=HostileString("hostile-snapshot-process"),
                    session_nonce=HostileString(f"hostile-snapshot-{backend_name}"),
                    pid=HostileInt(4242),
                )
                self.assertTrue(
                    all(
                        type(value) in {str, int, datetime, type(None)}
                        for value in (
                            lease.digest,
                            lease.pid,
                            lease.process_nonce,
                            lease.session_nonce,
                            lease.created_at,
                            lease.renewed_at,
                            lease.lease_nonce,
                        )
                    )
                )
                self.assertEqual(lease.created_at.microsecond, 123000)
                broken = HostileLease(
                    digest=lease.digest,
                    pid=lease.pid,
                    process_nonce=lease.process_nonce,
                    session_nonce=lease.session_nonce,
                    created_at=lease.created_at,
                    renewed_at=lease.renewed_at,
                    lease_nonce=lease.lease_nonce,
                )
                with self.assertRaises(CacheCorruptError) as raised:
                    backend.renew_lease(broken)
                self.assertEqual(raised.exception.code, "cache_corrupt")
                self.assertIsNone(raised.exception.__cause__)
                self.assertIsNone(raised.exception.__context__)
                hostile_lease = CacheLease(
                    digest=HostileString(lease.digest),
                    pid=HostileInt(lease.pid),
                    process_nonce=HostileString(lease.process_nonce),
                    session_nonce=HostileString(lease.session_nonce),
                    created_at=HostileDateTime.fromisoformat(lease.created_at.isoformat()),
                    renewed_at=HostileDateTime.fromisoformat(lease.renewed_at.isoformat()),
                    lease_nonce=(
                        None
                        if lease.lease_nonce is None
                        else HostileString(lease.lease_nonce)
                    ),
                )
                renewed = backend.renew_lease(hostile_lease)
                self.assertTrue(
                    all(
                        type(value) in {str, int, datetime, type(None)}
                        for value in (
                            renewed.digest,
                            renewed.pid,
                            renewed.process_nonce,
                            renewed.session_nonce,
                            renewed.created_at,
                            renewed.renewed_at,
                            renewed.lease_nonce,
                        )
                    )
                )
                backend.release_lease(
                    CacheLease(
                        digest=HostileString(renewed.digest),
                        pid=HostileInt(renewed.pid),
                        process_nonce=HostileString(renewed.process_nonce),
                        session_nonce=HostileString(renewed.session_nonce),
                        created_at=HostileDateTime.fromisoformat(
                            renewed.created_at.isoformat()
                        ),
                        renewed_at=HostileDateTime.fromisoformat(
                            renewed.renewed_at.isoformat()
                        ),
                        lease_nonce=(
                            None
                            if renewed.lease_nonce is None
                            else HostileString(renewed.lease_nonce)
                        ),
                    )
                )
                self.assertTrue(all(type(pid) is int for pid in observed_pids))

            hostile_url = HostileString(FIXTURE_ORIGIN)
            hostile_catalog_time = HostileDateTime(
                2026, 8, 25, 10, 0, tzinfo=timezone.utc
            )
            hostile_catalog = CachedCatalog(
                body=HostileBytes(b"{}"),
                metadata=CatalogMetadata(
                    canonical_url=hostile_url,
                    retrieved_at=hostile_catalog_time,
                    validated_at=hostile_catalog_time,
                    etag=HostileString('"etag"'),
                    last_modified=HostileString("Tue, 25 Aug 2026 10:00:00 GMT"),
                    cache_control=HostileString("max-age=60"),
                ),
            )
            with self.subTest(backend=backend_name, kind="catalog"):
                published_catalog = backend.publish_catalog(hostile_catalog)
                observed_catalog = backend.get_catalog(HostileString(FIXTURE_ORIGIN))
                self.assertEqual(observed_catalog, published_catalog)
                self.assertIs(type(published_catalog.body), bytes)
                self.assertIs(type(published_catalog.metadata.canonical_url), str)
                self.assertIs(type(published_catalog.metadata.retrieved_at), datetime)
                self.assertIs(type(published_catalog.metadata.etag), str)

    def test_catalog_lookup_requires_the_same_canonical_credential_free_url(self) -> None:
        canary = "catalog-lookup-secret-canary"

        class HostileString(str):
            def __hash__(self) -> int:
                raise RuntimeError(canary)

            def __eq__(self, other: object) -> bool:
                raise RuntimeError(canary)

            def __str__(self) -> str:
                raise RuntimeError(canary)

        catalog = CachedCatalog(
            body=b"{}",
            metadata=CatalogMetadata(
                canonical_url=FIXTURE_ORIGIN,
                retrieved_at=self.now,
                validated_at=self.now,
            ),
        )
        invalid = (
            f"not-a-url-{canary}",
            f"https://skills.example.test:{canary}/index.json",
            f"{FIXTURE_ORIGIN}?token={canary}",
            f"{FIXTURE_ORIGIN}#{canary}",
            f"https://user:{canary}@skills.example.test/.well-known/agent-skills/index.json",
            "HTTPS://SKILLS.EXAMPLE.TEST:443/.well-known/agent-skills/index.json",
        )
        for backend_name in ("memory", "disk"):
            backend = (
                MemoryCache()
                if backend_name == "memory"
                else DiskCache(
                    Path(self.temporary.name) / f"catalog-lookup-{backend_name}",
                    touch_on_read=False,
                )
            )
            published = backend.publish_catalog(catalog)
            with self.subTest(backend=backend_name, valid=True):
                observed = backend.get_catalog(HostileString(FIXTURE_ORIGIN))
                self.assertEqual(observed, published)
            for candidate in invalid:
                with self.subTest(backend=backend_name, candidate=candidate.split(canary)[0]):
                    with self.assertRaises(CacheConfigurationError) as raised:
                        backend.get_catalog(candidate)
                    self.assertEqual(raised.exception.code, "configuration_invalid")
                    self.assertEqual(
                        dict(raised.exception.context),
                        {"field": "canonical_url"},
                    )
                    pending: list[BaseException] = [raised.exception]
                    while pending:
                        error = pending.pop()
                        self.assertNotIn(canary, repr(vars(error)))
                        self.assertNotIn(canary, str(error))
                        if error.__cause__ is not None:
                            pending.append(error.__cause__)
                        if error.__context__ is not None:
                            pending.append(error.__context__)

    def test_catalog_publication_requires_canonical_credential_free_url(self) -> None:
        canary = "catalog-publication-secret-canary"
        invalid = (
            "HTTPS://skills.example.test/.well-known/agent-skills/index.json",
            "https://SKILLS.EXAMPLE.TEST/.well-known/agent-skills/index.json",
            "https://skills.example.test:443/.well-known/agent-skills/index.json",
            f"https://skills.example.test:{canary}/index.json",
            f"{FIXTURE_ORIGIN}?token={canary}",
            f"{FIXTURE_ORIGIN}#{canary}",
        )
        for backend_name in ("memory", "disk"):
            for index, canonical_url in enumerate(invalid):
                backend = (
                    MemoryCache()
                    if backend_name == "memory"
                    else DiskCache(
                        Path(self.temporary.name)
                        / f"catalog-publication-{backend_name}-{index}",
                        touch_on_read=False,
                    )
                )
                catalog = CachedCatalog(
                    body=b"{}",
                    metadata=CatalogMetadata(
                        canonical_url=canonical_url,
                        retrieved_at=self.now,
                        validated_at=self.now,
                    ),
                )
                with self.subTest(backend=backend_name, index=index):
                    with self.assertRaises(CacheConfigurationError) as raised:
                        backend.publish_catalog(catalog)
                    self.assertEqual(
                        dict(raised.exception.context),
                        {"field": "canonical_url"},
                    )
                    pending: list[BaseException] = [raised.exception]
                    while pending:
                        error = pending.pop()
                        self.assertNotIn(canary, repr(vars(error)))
                        self.assertNotIn(canary, str(error))
                        if error.__cause__ is not None:
                            pending.append(error.__cause__)
                        if error.__context__ is not None:
                            pending.append(error.__context__)
                    if isinstance(backend, MemoryCache):
                        self.assertEqual(backend._catalogs, {})
                    else:
                        catalogs = backend.namespace / "catalogs"
                        self.assertFalse(catalogs.exists() and any(catalogs.iterdir()))

    def test_catalog_publication_rejects_duplicate_json_members_without_body_leak(
        self,
    ) -> None:
        canary = "duplicate-catalog-member-secret-canary"
        body = (
            '{"url":"https://skills.example.test/?token='
            + canary
            + '","url":"https://skills.example.test/safe"}'
        ).encode()
        catalog = CachedCatalog(
            body=body,
            metadata=CatalogMetadata(
                canonical_url=FIXTURE_ORIGIN,
                retrieved_at=self.now,
                validated_at=self.now,
            ),
        )
        for backend_name in ("memory", "disk"):
            backend = (
                MemoryCache()
                if backend_name == "memory"
                else DiskCache(
                    Path(self.temporary.name) / f"duplicate-catalog-{backend_name}",
                    touch_on_read=False,
                )
            )
            with self.subTest(backend=backend_name):
                with self.assertRaises(CacheCorruptError) as raised:
                    backend.publish_catalog(catalog)
                pending: list[BaseException] = [raised.exception]
                while pending:
                    error = pending.pop()
                    self.assertNotIn(canary, repr(vars(error)))
                    self.assertNotIn(canary, str(error))
                    if error.__cause__ is not None:
                        pending.append(error.__cause__)
                    if error.__context__ is not None:
                        pending.append(error.__context__)
                if isinstance(backend, MemoryCache):
                    self.assertEqual(backend._catalogs, {})
                else:
                    catalogs = backend.namespace / "catalogs"
                    self.assertFalse(catalogs.exists() and any(catalogs.iterdir()))

    def test_datetime_tzinfo_hooks_are_contained_for_catalogs_and_leases(self) -> None:
        canary = "hostile-tzinfo-secret-canary"

        class ExplodingTimezone(tzinfo):
            def utcoffset(self, value: datetime | None) -> timedelta:
                raise RuntimeError(canary)

            def dst(self, value: datetime | None) -> timedelta:
                raise RuntimeError(canary)

            def tzname(self, value: datetime | None) -> str:
                raise RuntimeError(canary)

        class FixedTimezone(tzinfo):
            def utcoffset(self, value: datetime | None) -> timedelta:
                return timedelta(hours=2)

            def dst(self, value: datetime | None) -> timedelta:
                return timedelta(0)

            def tzname(self, value: datetime | None) -> str:
                return "+02:00"

        hostile = datetime(2026, 8, 25, 10, 0, tzinfo=ExplodingTimezone())
        for backend_name in ("memory", "disk"):
            backend = (
                MemoryCache(clock=lambda: self.now)
                if backend_name == "memory"
                else DiskCache(
                    Path(self.temporary.name) / f"hostile-time-{backend_name}",
                    touch_on_read=False,
                    clock=lambda: self.now,
                    process_identity=lambda pid: "hostile-time-process",
                )
            )
            catalog = CachedCatalog(
                body=b"{}",
                metadata=CatalogMetadata(
                    canonical_url=FIXTURE_ORIGIN,
                    retrieved_at=hostile,
                    validated_at=self.now,
                ),
            )
            with self.subTest(backend=backend_name, operation="catalog"):
                with self.assertRaises(CacheCorruptError) as raised:
                    backend.publish_catalog(catalog)
                self.assertIsNone(raised.exception.__cause__)
                self.assertIsNone(raised.exception.__context__)
                self.assertNotIn(canary, repr(vars(raised.exception)))

            lease = backend.acquire_lease(
                FIXTURE_DIGEST,
                process_nonce=f"hostile-time-{backend_name}",
                session_nonce="session",
                pid=4242,
            )
            hostile_lease = replace(lease, renewed_at=hostile)
            with self.subTest(backend=backend_name, operation="lease"):
                with self.assertRaises(CacheCorruptError) as raised:
                    backend.renew_lease(hostile_lease)
                self.assertIsNone(raised.exception.__cause__)
                self.assertIsNone(raised.exception.__context__)
                self.assertNotIn(canary, repr(vars(raised.exception)))
            local_created = (lease.created_at + timedelta(hours=2)).replace(
                tzinfo=FixedTimezone()
            )
            safe_lease = replace(
                lease,
                created_at=local_created,
                renewed_at=local_created,
            )
            renewed = backend.renew_lease(safe_lease)
            self.assertIs(type(renewed.created_at), datetime)
            self.assertIs(renewed.created_at.tzinfo, timezone.utc)
            self.assertIs(type(renewed.renewed_at), datetime)
            self.assertIs(renewed.renewed_at.tzinfo, timezone.utc)
            backend.release_lease(renewed)

    def test_catalog_and_object_timestamps_are_canonical_millisecond_utc_values(
        self,
    ) -> None:
        class FixedOffset(tzinfo):
            def utcoffset(self, value: datetime | None) -> timedelta:
                return timedelta(hours=2)

            def dst(self, value: datetime | None) -> timedelta:
                return timedelta(0)

            def tzname(self, value: datetime | None) -> str:
                return "+02:00"

        supplied = datetime(
            2026, 8, 25, 12, 0, 0, 123456, tzinfo=FixedOffset()
        )
        expected = datetime(2026, 8, 25, 10, 0, 0, 123000, tzinfo=timezone.utc)
        candidate = replace(
            make_skill_object("canonical-timestamp", supplied),
            verified_at=supplied,
            accessed_at=supplied,
        )
        catalog = CachedCatalog(
            body=b"{}",
            metadata=CatalogMetadata(
                canonical_url=FIXTURE_ORIGIN,
                retrieved_at=supplied,
                validated_at=supplied,
            ),
        )
        for backend_name in ("memory", "disk"):
            backend = (
                MemoryCache()
                if backend_name == "memory"
                else DiskCache(
                    Path(self.temporary.name) / f"canonical-time-{backend_name}",
                    touch_on_read=False,
                )
            )
            with self.subTest(backend=backend_name):
                published_object = backend.publish_object(candidate)
                published_catalog = backend.publish_catalog(catalog)
                self.assertEqual(published_object.verified_at, expected)
                self.assertEqual(published_object.accessed_at, expected)
                self.assertIs(type(published_object.verified_at), datetime)
                self.assertIs(published_object.verified_at.tzinfo, timezone.utc)
                self.assertEqual(published_catalog.metadata.retrieved_at, expected)
                self.assertEqual(published_catalog.metadata.validated_at, expected)
                self.assertIs(type(published_catalog.metadata.retrieved_at), datetime)
                self.assertIs(
                    published_catalog.metadata.retrieved_at.tzinfo,
                    timezone.utc,
                )
                self.assertEqual(backend.get_object(candidate.digest), published_object)
                self.assertEqual(backend.get_catalog(FIXTURE_ORIGIN), published_catalog)

        current = datetime(2026, 8, 25, 10, 0, 10, 123900, tzinfo=timezone.utc)
        accessed = datetime(2026, 8, 25, 10, 0, 0, 123499, tzinfo=timezone.utc)
        bounded = DiskCache(
            Path(self.temporary.name) / "canonical-age-boundary",
            touch_on_read=False,
            clock=lambda: current,
        )
        boundary = make_skill_object("canonical-age-boundary", accessed)
        bounded.publish_object(boundary)
        retained = bounded.evict(max_bytes=2**53 - 1, max_age_seconds=10)
        self.assertNotIn(boundary.digest, retained.removed_digests)
        current += timedelta(milliseconds=1)
        removed = bounded.evict(max_bytes=2**53 - 1, max_age_seconds=10)
        self.assertIn(boundary.digest, removed.removed_digests)

    def test_release_lease_is_idempotent_without_releasing_a_successor(self) -> None:
        frozen = datetime(2026, 8, 25, 10, 0, tzinfo=timezone.utc)
        for backend_name in ("memory", "disk"):
            backend = (
                MemoryCache(clock=lambda: frozen)
                if backend_name == "memory"
                else DiskCache(
                    Path(self.temporary.name) / f"double-release-{backend_name}",
                    touch_on_read=False,
                    clock=lambda: frozen,
                    process_identity=lambda pid: "double-release-process",
                )
            )
            with self.subTest(backend=backend_name):
                lease = backend.acquire_lease(
                    FIXTURE_DIGEST,
                    process_nonce=f"double-release-{backend_name}",
                    session_nonce="session",
                    pid=4242,
                )
                backend.release_lease(lease)
                backend.release_lease(lease)
                self.assertFalse(backend.has_live_lease(FIXTURE_DIGEST))

    def test_untrusted_cache_json_rejects_duplicates_and_nonfinite_values(self) -> None:
        canary = "strict-cache-json-secret-canary"

        def assert_sanitized(error: BaseException) -> None:
            pending = [error]
            while pending:
                current = pending.pop()
                self.assertNotIn(canary, str(current))
                self.assertNotIn(canary, repr(vars(current)))
                if current.__cause__ is not None:
                    pending.append(current.__cause__)
                if current.__context__ is not None:
                    pending.append(current.__context__)

        for backend_name in ("memory", "disk"):
            for constant in ("NaN", "Infinity", "-Infinity"):
                backend = (
                    MemoryCache()
                    if backend_name == "memory"
                    else DiskCache(
                        Path(self.temporary.name)
                        / f"nonfinite-{backend_name}-{constant.replace('-', 'minus')}",
                        touch_on_read=False,
                    )
                )
                catalog = CachedCatalog(
                    body=f'{{"extension":{constant}}}'.encode(),
                    metadata=CatalogMetadata(
                        canonical_url=FIXTURE_ORIGIN,
                        retrieved_at=self.now,
                        validated_at=self.now,
                    ),
                )
                with self.subTest(backend=backend_name, constant=constant):
                    with self.assertRaises(CacheCorruptError) as raised:
                        backend.publish_catalog(catalog)
                    assert_sanitized(raised.exception)

        catalog_cache = DiskCache(
            Path(self.temporary.name) / "duplicate-catalog-metadata",
            touch_on_read=False,
        )
        catalog_cache.publish_catalog(
            CachedCatalog(
                body=b"{}",
                metadata=CatalogMetadata(
                    canonical_url=FIXTURE_ORIGIN,
                    retrieved_at=self.now,
                    validated_at=self.now,
                ),
            )
        )
        catalog_metadata = catalog_cache.catalog_path(FIXTURE_ORIGIN) / "metadata.json"
        original_catalog_metadata = catalog_metadata.read_bytes()
        catalog_metadata.write_bytes(
            b'{"canonical_url":"https://skills.example.test/?token='
            + canary.encode()
            + b'",'
            + original_catalog_metadata[1:]
        )
        with self.assertRaises(CacheCorruptError) as raised:
            catalog_cache.get_catalog(FIXTURE_ORIGIN)
        assert_sanitized(raised.exception)

        object_cache = DiskCache(
            Path(self.temporary.name) / "duplicate-object-metadata",
            touch_on_read=False,
        )
        candidate = make_skill_object("duplicate-object-metadata", self.now)
        object_cache.publish_object(candidate)
        object_metadata = object_cache.object_path(candidate.digest) / "object.json"
        original_object_metadata = object_metadata.read_bytes()
        object_metadata.write_bytes(
            b'{"digest":"'
            + canary.encode()
            + b'",'
            + original_object_metadata[1:]
        )
        with self.assertRaises(CacheCorruptError) as raised:
            object_cache.get_object(candidate.digest)
        assert_sanitized(raised.exception)

        lease_cache = DiskCache(
            Path(self.temporary.name) / "duplicate-lease-metadata",
            touch_on_read=False,
            clock=lambda: self.now,
            process_identity=lambda pid: "strict-json-process",
        )
        lease = lease_cache.acquire_lease(
            FIXTURE_DIGEST,
            process_nonce="strict-json-process",
            session_nonce="strict-json-session",
            pid=4242,
        )
        lease_path = lease_cache._lease_path(lease)
        original_lease = lease_path.read_bytes()
        lease_path.write_bytes(
            b'{"process_nonce":"'
            + canary.encode()
            + b'",'
            + original_lease[1:]
        )
        with self.assertRaises(CacheCorruptError) as raised:
            lease_cache.renew_lease(lease)
        assert_sanitized(raised.exception)

    def test_auxiliary_cache_json_rejects_duplicate_members(self) -> None:
        canary = "auxiliary-json-secret-canary"
        current = self.now
        cache = DiskCache(
            Path(self.temporary.name) / "duplicate-auxiliary-json",
            touch_on_read=False,
            clock=lambda: current,
            process_identity=lambda pid: canary,
            lease_expiry_seconds=60,
        )
        lease = cache.acquire_lease(
            FIXTURE_DIGEST,
            process_nonce="auxiliary-json-process",
            session_nonce="auxiliary-json-session",
            pid=4242,
        )
        process_path = cache._process_path(
            lease.digest,
            lease.pid,
            lease.process_nonce,
        )
        process_record = process_path.read_bytes()
        process_path.write_bytes(
            b'{"process_identity":"dead-process",' + process_record[1:]
        )
        current += timedelta(seconds=61)
        self.assertEqual(cache.cleanup_stale_leases(lease_expiry_seconds=60), 1)

        temporary_root = cache.namespace / "tmp"
        private = temporary_root / "writer-python-duplicate"
        private.mkdir(parents=True)
        (private / "payload").write_bytes(b"payload")
        writer = {
            "schema": "remote-skills-cache-writer-v1",
            "writer": "python",
            "pid": 4242,
            "process_nonce": "auxiliary-json-writer",
            "expected_digest": FIXTURE_DIGEST,
            "bytes_received": len(b"payload"),
            "complete": False,
        }
        writer_path = private / "writer.json"
        writer_record = json.dumps(writer).encode()
        writer_path.write_bytes(writer_record)
        cache._register_process_identity(
            writer["expected_digest"], writer["pid"], writer["process_nonce"]
        )
        old = (current - timedelta(seconds=61)).timestamp()
        os.utime(private, (old, old))
        self.assertEqual(cache.cleanup_stale_temporaries(max_age_seconds=60), 0)
        self.assertEqual(writer_path.read_bytes(), writer_record)
        self.assertEqual((private / "payload").read_bytes(), b"payload")

        duplicate_writer_record = b'{"pid":4242,' + writer_record[1:]
        self.assertEqual(json.loads(duplicate_writer_record), writer)
        with self.assertRaises(ValueError):
            disk_cache_module._parse_cache_json(duplicate_writer_record)
        writer_path.write_bytes(duplicate_writer_record)
        os.utime(private, (old, old))
        self.assertEqual(cache.cleanup_stale_temporaries(max_age_seconds=60), 1)
        self.assertFalse(private.exists())

        claim = cache._acquire_eviction_claim(FIXTURE_DIGEST)
        self.addCleanup(cache._release_eviction_claim, claim)
        claim_path = cache._claim_path(FIXTURE_DIGEST)
        # Cleanups run in reverse order: restore the owned bytes before release.
        self.addCleanup(claim_path.write_bytes, claim.content)
        claim_record = claim_path.read_bytes().replace(
            f'"process_identity":"{canary}"'.encode(),
            b'"process_identity":"dead-process"',
        )
        claim_path.write_bytes(
            f'{{"process_identity":"{canary}",'.encode() + claim_record[1:]
        )
        self.assertFalse(cache._reclaim_stale_eviction_claim(FIXTURE_DIGEST))
        self.assertTrue(claim_path.exists())

    def test_catalog_decoder_recursion_failures_are_sanitized(self) -> None:
        depth = 10_000
        deeply_nested = ("[" * depth + "0" + "]" * depth).encode()
        self.assertLess(len(deeply_nested), disk_cache_module.DEFAULT_MAX_CATALOG_BYTES)
        for backend_name in ("memory", "disk"):
            backend = (
                MemoryCache()
                if backend_name == "memory"
                else DiskCache(
                    Path(self.temporary.name) / f"recursive-json-{backend_name}",
                    touch_on_read=False,
                )
            )
            catalog = CachedCatalog(
                body=deeply_nested,
                metadata=CatalogMetadata(
                    canonical_url=FIXTURE_ORIGIN,
                    retrieved_at=self.now,
                    validated_at=self.now,
                ),
            )
            with self.subTest(backend=backend_name):
                with self.assertRaises(CacheCorruptError) as raised:
                    backend.publish_catalog(catalog)
                self.assertIsNone(raised.exception.__cause__)
                self.assertIsNone(raised.exception.__context__)

    def test_reacquired_lease_has_a_distinct_generation(self) -> None:
        frozen = datetime(2026, 8, 25, 10, 0, tzinfo=timezone.utc)
        for backend_name in ("memory", "disk"):
            backend = (
                MemoryCache(clock=lambda: frozen)
                if backend_name == "memory"
                else DiskCache(
                    Path(self.temporary.name) / f"reacquired-lease-{backend_name}",
                    touch_on_read=False,
                    clock=lambda: frozen,
                    process_identity=lambda pid: "reacquired-lease-process",
                )
            )
            with self.subTest(backend=backend_name):
                original = backend.acquire_lease(
                    FIXTURE_DIGEST,
                    process_nonce=f"reacquired-{backend_name}",
                    session_nonce="same-session",
                    pid=4242,
                )
                backend.release_lease(original)
                successor = backend.acquire_lease(
                    FIXTURE_DIGEST,
                    process_nonce=f"reacquired-{backend_name}",
                    session_nonce="same-session",
                    pid=4242,
                )
                self.assertGreater(successor.created_at, original.created_at)
                with self.assertRaises(CacheCorruptError):
                    backend.release_lease(original)
                self.assertTrue(backend.has_live_lease(FIXTURE_DIGEST))
                backend.release_lease(successor)
                backend.release_lease(successor)
                self.assertFalse(backend.has_live_lease(FIXTURE_DIGEST))

    def test_disk_reacquired_lease_generation_is_root_coordinated(self) -> None:
        frozen = datetime(2026, 8, 25, 10, 0, tzinfo=timezone.utc)
        root = Path(self.temporary.name) / "cross-instance-reacquired-lease"
        cache_a = DiskCache(
            root,
            touch_on_read=False,
            clock=lambda: frozen,
            process_identity=lambda pid: "cross-instance-process",
        )
        cache_b = DiskCache(
            root,
            touch_on_read=False,
            clock=lambda: frozen,
            process_identity=lambda pid: "cross-instance-process",
        )
        original = cache_a.acquire_lease(
            FIXTURE_DIGEST,
            process_nonce="cross-instance-process",
            session_nonce="same-session",
            pid=4242,
        )
        cache_a.release_lease(original)

        successor = cache_b.acquire_lease(
            FIXTURE_DIGEST,
            process_nonce="cross-instance-process",
            session_nonce="same-session",
            pid=4242,
        )

        self.assertGreater(successor.created_at, original.created_at)
        with self.assertRaises(CacheCorruptError):
            cache_a.release_lease(original)
        self.assertTrue(cache_b.has_live_lease(FIXTURE_DIGEST))
        cache_b.release_lease(successor)
        cache_b.release_lease(successor)
        self.assertFalse(cache_a.has_live_lease(FIXTURE_DIGEST))

    def test_disk_lease_generation_migrates_without_private_record(self) -> None:
        frozen = datetime(2026, 8, 25, 10, 0, tzinfo=timezone.utc)
        root = Path(self.temporary.name) / "migrated-lease-generation"

        def cache() -> DiskCache:
            return DiskCache(
                root,
                touch_on_read=False,
                clock=lambda: frozen,
                process_identity=lambda pid: "migrated-lease-process",
            )

        original_cache = cache()
        original = original_cache.acquire_lease(
            FIXTURE_DIGEST,
            process_nonce="migrated-lease-process",
            session_nonce="same-session",
            pid=4242,
        )
        generation_path = (
            original_cache._lease_directory(FIXTURE_DIGEST)
            / ".lease-generation.json"
        )
        generation_path.unlink()

        original_cache.release_lease(original)
        successor_cache = cache()
        successor = successor_cache.acquire_lease(
            FIXTURE_DIGEST,
            process_nonce="migrated-lease-process",
            session_nonce="same-session",
            pid=4242,
        )

        self.assertGreater(successor.created_at, original.created_at)
        with self.assertRaises(CacheCorruptError):
            original_cache.release_lease(original)
        self.assertTrue(successor_cache.has_live_lease(FIXTURE_DIGEST))
        successor_cache.release_lease(successor)

    def test_disk_lease_generation_migration_uses_maximum_matching_ordinary_lease(
        self,
    ) -> None:
        frozen = datetime(2026, 8, 25, 10, 0, tzinfo=timezone.utc)
        root = Path(self.temporary.name) / "migrated-maximum-lease-generation"

        def cache() -> DiskCache:
            return DiskCache(
                root,
                touch_on_read=False,
                clock=lambda: frozen,
                process_identity=lambda pid: "maximum-lease-process",
            )

        first_cache = cache()
        original = first_cache.acquire_lease(
            FIXTURE_DIGEST,
            process_nonce="maximum-lease-process",
            session_nonce="reused-session",
            pid=4242,
        )
        maximum_cache = cache()
        maximum = maximum_cache.acquire_lease(
            FIXTURE_DIGEST,
            process_nonce="maximum-lease-process",
            session_nonce="other-session",
            pid=4242,
        )
        far_future = datetime(2099, 1, 1, tzinfo=timezone.utc)
        mismatched = replace(
            maximum,
            session_nonce="future-session",
            created_at=far_future,
            renewed_at=far_future,
        )
        lease_directory = first_cache._lease_directory(FIXTURE_DIGEST)
        (lease_directory / "auxiliary-future.json").write_bytes(
            first_cache._serialize_lease(mismatched)
        )
        generation_path = (
            lease_directory / ".lease-generation.json"
        )
        generation_path.unlink()

        first_cache.release_lease(original)
        successor_cache = cache()
        successor = successor_cache.acquire_lease(
            FIXTURE_DIGEST,
            process_nonce="maximum-lease-process",
            session_nonce="reused-session",
            pid=4242,
        )

        self.assertEqual(
            successor.created_at,
            maximum.renewed_at + timedelta(milliseconds=1),
        )
        with self.assertRaises(CacheCorruptError):
            first_cache.release_lease(original)
        self.assertTrue(successor_cache.has_live_lease(FIXTURE_DIGEST))
        successor_cache.release_lease(successor)
        maximum_cache.release_lease(maximum)

    def test_disk_lease_generation_migration_ignores_malformed_auxiliary_record(
        self,
    ) -> None:
        frozen = datetime(2026, 8, 25, 10, 0, tzinfo=timezone.utc)
        root = Path(self.temporary.name) / "migrated-malformed-auxiliary"
        cache = DiskCache(
            root,
            touch_on_read=False,
            clock=lambda: frozen,
            process_identity=lambda pid: "malformed-auxiliary-process",
        )
        original = cache.acquire_lease(
            FIXTURE_DIGEST,
            process_nonce="malformed-auxiliary-process",
            session_nonce="same-session",
            pid=4242,
        )
        lease_directory = cache._lease_directory(FIXTURE_DIGEST)
        (lease_directory / ".lease-generation.json").unlink()
        (lease_directory / "typescript-auxiliary.json").write_text(
            json.dumps(
                {
                    "schema": "remote-skills-cache-lease-v1",
                    "digest": FIXTURE_DIGEST,
                    "pid": 4242,
                    "process_nonce": "../not-a-lease",
                    "session_nonce": "auxiliary",
                    "created_at": "2026-08-25T10:00:00.999Z",
                    "renewed_at": "2026-08-25T10:00:00.999Z",
                }
            ),
            encoding="utf-8",
        )

        cache.release_lease(original)
        successor = DiskCache(
            root,
            touch_on_read=False,
            clock=lambda: frozen,
            process_identity=lambda pid: "malformed-auxiliary-process",
        ).acquire_lease(
            FIXTURE_DIGEST,
            process_nonce="malformed-auxiliary-process",
            session_nonce="same-session",
            pid=4242,
        )

        self.assertGreater(successor.created_at, original.created_at)

    def test_catalog_unknown_extensions_reject_credential_bearing_uri_values(self) -> None:
        canary = "unknown-extension-credential-canary"
        bodies = (
            {
                "extensions": {
                    "mirrors": [
                        {
                            "mirror_url": (
                                f"https://reader:{canary}@mirror.example.test/skill.md"
                            )
                        }
                    ]
                }
            },
            {
                "extensions": {
                    "arbitrary": f"../skill.md?token={canary}",
                }
            },
        )
        for backend_name in ("memory", "disk"):
            for index, body_value in enumerate(bodies):
                root = Path(self.temporary.name) / f"extension-url-{backend_name}-{index}"
                backend = (
                    MemoryCache()
                    if backend_name == "memory"
                    else DiskCache(root, touch_on_read=False)
                )
                catalog = CachedCatalog(
                    body=json.dumps(body_value).encode(),
                    metadata=CatalogMetadata(
                        canonical_url=FIXTURE_ORIGIN,
                        retrieved_at=self.now,
                        validated_at=self.now,
                    ),
                )
                with self.subTest(backend=backend_name, case=index):
                    with self.assertRaises(CacheConfigurationError) as raised:
                        backend.publish_catalog(catalog)
                    self.assertEqual(
                        dict(raised.exception.context),
                        {"field": "catalog_body"},
                    )
                    pending: list[BaseException] = [raised.exception]
                    rendered: list[str] = []
                    while pending:
                        error = pending.pop()
                        rendered.extend((str(error), repr(error), repr(vars(error))))
                        if error.__cause__ is not None:
                            pending.append(error.__cause__)
                        if error.__context__ is not None:
                            pending.append(error.__context__)
                    self.assertNotIn(canary, "\n".join(rendered))
                    if backend_name == "memory":
                        self.assertEqual(backend._catalogs, {})
                    else:
                        persisted = b"".join(
                            path.read_bytes()
                            for path in root.rglob("*")
                            if path.is_file()
                        )
                        self.assertNotIn(canary.encode(), persisted)

    def test_catalog_unknown_extensions_reject_oauth_and_api_credential_keys(
        self,
    ) -> None:
        canary = "oauth-api-query-credential-canary"
        credential_uris = (
            f"../skill.md?ACCESS_TOKEN={canary}",
            f"../skill.md?access%5Ftoken={canary}",
            f"https://mirror.example.test/skill.md?api_key={canary}",
            f"https://mirror.example.test/skill.md#client_secret={canary}",
            f"../skill.md?oauth_signature={canary}",
            f"../skill.md#oauth%5Fverifier={canary}",
            f"https://mirror.example.test/skill.md?x-goog-api-key={canary}",
            f"../skill.md?credential={canary}",
            f"../skill.md#sig={canary}",
            f"https://mirror.example.test/skill.md?AWSAccessKeyId={canary}",
            f"../skill.md?accessToken={canary}",
            f"../skill.md?access%54oken={canary}",
        )
        for backend_name in ("memory", "disk"):
            for index, credential_uri in enumerate(credential_uris):
                root = Path(self.temporary.name) / f"oauth-uri-{backend_name}-{index}"
                backend = (
                    MemoryCache()
                    if backend_name == "memory"
                    else DiskCache(root, touch_on_read=False)
                )
                catalog = CachedCatalog(
                    body=json.dumps(
                        {
                            "extensions": {
                                "arbitrary": {
                                    "value": credential_uri,
                                }
                            }
                        }
                    ).encode(),
                    metadata=CatalogMetadata(
                        canonical_url=FIXTURE_ORIGIN,
                        retrieved_at=self.now,
                        validated_at=self.now,
                    ),
                )
                with self.subTest(backend=backend_name, case=index):
                    with self.assertRaises(CacheConfigurationError) as raised:
                        backend.publish_catalog(catalog)
                    self.assertEqual(
                        dict(raised.exception.context),
                        {"field": "catalog_body"},
                    )
                    pending: list[BaseException] = [raised.exception]
                    rendered: list[str] = []
                    while pending:
                        error = pending.pop()
                        rendered.extend((str(error), repr(error), repr(vars(error))))
                        if error.__cause__ is not None:
                            pending.append(error.__cause__)
                        if error.__context__ is not None:
                            pending.append(error.__context__)
                    self.assertNotIn(canary, "\n".join(rendered))
                    if backend_name == "memory":
                        self.assertEqual(backend._catalogs, {})
                    else:
                        persisted = b"".join(
                            path.read_bytes()
                            for path in root.rglob("*")
                            if path.is_file()
                        )
                        self.assertNotIn(canary.encode(), persisted)

    def test_catalog_unknown_extensions_tolerate_prose_and_safe_uri_values(self) -> None:
        body = json.dumps(
            {
                "extensions": {
                    "notes": "Ask user@example.test? This is ordinary prose.",
                    "mirror_url": "https://mirror.example.test/skill.md",
                    "relative": "../skill.md",
                    "safe_query": (
                        "../skill.md?access_token_hint=public&api_key_name=docs"
                    ),
                    "safe_oauth_query": (
                        "../skill.md?oauth_signature_method=HMAC-SHA256"
                        "&x-goog-api-key-name=docs"
                    ),
                    "safe_credential_query": (
                        "../skill.md?credential_hint=docs&sig_method=HMAC-SHA256"
                        "&AWSAccessKeyIdHint=docs&accessTokenHint=docs"
                    ),
                }
            }
        ).encode()
        catalog = CachedCatalog(
            body=body,
            metadata=CatalogMetadata(
                canonical_url=FIXTURE_ORIGIN,
                retrieved_at=self.now,
                validated_at=self.now,
            ),
        )
        for backend_name in ("memory", "disk"):
            backend = (
                MemoryCache()
                if backend_name == "memory"
                else DiskCache(
                    Path(self.temporary.name) / f"safe-extension-{backend_name}",
                    touch_on_read=False,
                )
            )
            with self.subTest(backend=backend_name):
                self.assertEqual(backend.publish_catalog(catalog), catalog)
                self.assertEqual(backend.get_catalog(FIXTURE_ORIGIN), catalog)

    def test_concurrent_cross_instance_reacquisition_orders_generations(self) -> None:
        frozen = datetime(2026, 8, 25, 10, 0, tzinfo=timezone.utc)
        root = Path(self.temporary.name) / "concurrent-reacquired-lease"

        def cache() -> DiskCache:
            return DiskCache(
                root,
                touch_on_read=False,
                clock=lambda: frozen,
                process_identity=lambda pid: "concurrent-reacquire-process",
            )

        initial_cache = cache()
        original = initial_cache.acquire_lease(
            FIXTURE_DIGEST,
            process_nonce="concurrent-reacquire-process",
            session_nonce="same-session",
            pid=4242,
        )
        initial_cache.release_lease(original)

        contenders = (cache(), cache())
        barrier = threading.Barrier(3)
        acquired: list[tuple[DiskCache, CacheLease]] = []
        rejected: list[tuple[DiskCache, CacheConfigurationError]] = []

        def contend(candidate: DiskCache) -> None:
            barrier.wait()
            try:
                lease = candidate.acquire_lease(
                    FIXTURE_DIGEST,
                    process_nonce="concurrent-reacquire-process",
                    session_nonce="same-session",
                    pid=4242,
                )
                acquired.append((candidate, lease))
            except CacheConfigurationError as error:
                rejected.append((candidate, error))

        threads = [threading.Thread(target=contend, args=(candidate,)) for candidate in contenders]
        for thread in threads:
            thread.start()
        barrier.wait()
        for thread in threads:
            thread.join(timeout=5)
            self.assertFalse(thread.is_alive())

        self.assertEqual(len(acquired), 1)
        self.assertEqual(len(rejected), 1)
        winner_cache, winner = acquired[0]
        retry_cache, rejection = rejected[0]
        self.assertEqual(rejection.code, "configuration_invalid")
        self.assertGreater(winner.created_at, original.created_at)

        winner_cache.release_lease(winner)
        successor = retry_cache.acquire_lease(
            FIXTURE_DIGEST,
            process_nonce="concurrent-reacquire-process",
            session_nonce="same-session",
            pid=4242,
        )
        self.assertGreater(successor.created_at, winner.created_at)
        with self.assertRaises(CacheCorruptError):
            winner_cache.release_lease(winner)
        self.assertTrue(retry_cache.has_live_lease(FIXTURE_DIGEST))
        retry_cache.release_lease(successor)

    def test_cache_error_contexts_are_immutable_and_serialize_stably(self) -> None:
        canary = "context-mutation-canary"
        cases = (
            (
                CacheCorruptError(FIXTURE_DIGEST),
                '{"expected_digest":"'
                + FIXTURE_DIGEST
                + '","layout_version":"cache-v1"}',
            ),
            (
                CacheConfigurationError("catalog_body"),
                '{"field":"catalog_body"}',
            ),
        )
        for error, expected in cases:
            with self.subTest(error=type(error).__name__):
                with self.assertRaises(TypeError):
                    error.context["credential"] = canary  # type: ignore[index]
                with self.assertRaises(TypeError):
                    del error.context[next(iter(error.context))]  # type: ignore[misc]
                with self.assertRaises(AttributeError):
                    error.context = {"credential": canary}  # type: ignore[assignment]
                serialized = json.dumps(
                    dict(error.context),
                    sort_keys=True,
                    separators=(",", ":"),
                )
                self.assertEqual(serialized, expected)
                pending: list[BaseException] = [error]
                rendered: list[str] = []
                while pending:
                    current = pending.pop()
                    rendered.extend((str(current), repr(current), repr(vars(current))))
                    for linked in (current.__cause__, current.__context__):
                        if linked is not None:
                            pending.append(linked)
                self.assertNotIn(canary, "\n".join(rendered))


class SharedCacheProtocolTest(unittest.TestCase):
    def test_cross_process_case_keeps_python_as_winner_under_serialized_startup(
        self,
    ) -> None:
        protocol_root = REPOSITORY_ROOT / "tests/protocol"
        fixtures = json.loads(
            (protocol_root / "fixtures/cache/cache-cases.json").read_text(encoding="utf-8")
        )
        expected = json.loads(
            (protocol_root / "expected-results/cache-results.json").read_text(encoding="utf-8")
        )
        fixture = next(
            case for case in fixtures["cases"] if case["id"] == "cache-v1-cross-process"
        )
        expected_case = next(
            case for case in expected["cases"] if case["id"] == "cache-v1-cross-process"
        )
        original_process = subprocess.Popen

        def start_process(
            arguments: list[str],
            *process_arguments: object,
            **process_options: object,
        ) -> subprocess.Popen[str]:
            if "--race-publisher" in arguments and arguments[-2] == "python":
                arguments = [
                    sys.executable,
                    "-c",
                    (
                        "import os, sys, time; time.sleep(0.5); "
                        "os.execv(sys.argv[1], sys.argv[1:])"
                    ),
                    *arguments,
                ]
            return original_process(arguments, *process_arguments, **process_options)

        with patch.object(subprocess, "Popen", start_process):
            actual = run_protocol_case(
                {
                    "contract_version": fixtures["contract_version"],
                    "suite": "cache",
                    "id": fixture["id"],
                    "fixture": fixture,
                    "protocol_root": str(protocol_root),
                }
            )

        self.assertEqual(actual, expected_case["result"])

    def test_serialized_publisher_may_finish_with_the_existing_winner(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            coordination = Path(temporary)
            process = subprocess.Popen(
                [
                    sys.executable,
                    "-c",
                    (
                        "from pathlib import Path; import sys; root = Path(sys.argv[1]); "
                        "(root / 'result-python').write_text('sha256:winner'); "
                        "(root / 'done-python').write_text('done'); "
                        "(root / 'winner').write_text('typescript')"
                    ),
                    str(coordination),
                ],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )

            _release_publishers_as_ready(coordination, {"python": process})

            self.assertEqual(process.wait(), 0)

    def test_failed_publisher_diagnostics_include_process_and_marker_state(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            coordination = Path(temporary)
            process = subprocess.Popen(
                [sys.executable, "-c", "raise SystemExit(7)"],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )

            with self.assertRaisesRegex(
                RuntimeError,
                r"exit_code=7.*command=.*stdout='' stderr=''.*markers=none",
            ):
                _release_publishers_as_ready(coordination, {"python": process})

    def test_cross_process_observer_ignores_only_mutable_access_time_drift(self) -> None:
        expected = fixture_object()
        accessed = replace(expected, accessed_at=expected.accessed_at + timedelta(seconds=1))
        changed = replace(expected, artifact=b"changed")

        self.assertTrue(_same_immutable_object(accessed, expected))
        self.assertFalse(_same_immutable_object(changed, expected))

    def test_read_only_protocol_cases_do_not_add_windows_coordination_files(self) -> None:
        protocol_root = REPOSITORY_ROOT / "tests/protocol"
        fixtures = json.loads(
            (protocol_root / "fixtures/cache/cache-cases.json").read_text(encoding="utf-8")
        )
        fixture = next(case for case in fixtures["cases"] if case["id"] == "cache-v1-valid")
        with tempfile.TemporaryDirectory() as temporary:
            isolated_protocol = Path(temporary)
            source = protocol_root / "fixtures/cache/states/valid"
            state = isolated_protocol / "fixtures/cache/states/valid"
            shutil.copytree(source, state)
            before = sorted(path.relative_to(state) for path in state.rglob("*") if path.is_file())

            with patch("remote_skills.cache.disk._windows_mode", return_value=True):
                run_protocol_case(
                    {
                        "contract_version": fixtures["contract_version"],
                        "suite": "cache",
                        "id": fixture["id"],
                        "fixture": fixture,
                        "protocol_root": str(isolated_protocol),
                    }
                )

            after = sorted(path.relative_to(state) for path in state.rglob("*") if path.is_file())
            self.assertEqual(after, before)

    def test_all_static_cache_cases_match_language_neutral_results(self) -> None:
        protocol_root = REPOSITORY_ROOT / "tests/protocol"
        fixtures = json.loads(
            (protocol_root / "fixtures/cache/cache-cases.json").read_text(encoding="utf-8")
        )
        expected = json.loads(
            (protocol_root / "expected-results/cache-results.json").read_text(encoding="utf-8")
        )

        for fixture, expected_case in zip(fixtures["cases"], expected["cases"], strict=True):
            with self.subTest(case=fixture["id"]):
                actual = run_protocol_case(
                    {
                        "contract_version": fixtures["contract_version"],
                        "suite": "cache",
                        "id": fixture["id"],
                        "fixture": fixture,
                        "protocol_root": str(protocol_root),
                    }
                )
                self.assertEqual(actual, expected_case["result"])

    def test_recovery_and_race_cases_execute_real_cache_operations(self) -> None:
        protocol_root = REPOSITORY_ROOT / "tests/protocol"
        fixtures = json.loads(
            (protocol_root / "fixtures/cache/cache-cases.json").read_text(encoding="utf-8")
        )
        selected = {
            fixture["id"]: fixture
            for fixture in fixtures["cases"]
            if fixture["id"]
            in {"cache-v1-partial-writer", "cache-v1-crashed-lease", "cache-v1-cross-process"}
        }
        calls = {"temporary": 0, "lease": 0, "process": 0}
        original_temporary = DiskCache.cleanup_stale_temporaries
        original_lease = DiskCache.cleanup_stale_leases
        original_process = subprocess.Popen

        def cleanup_temporary(cache: DiskCache, *, max_age_seconds: int) -> int:
            calls["temporary"] += 1
            return original_temporary(cache, max_age_seconds=max_age_seconds)

        def cleanup_lease(cache: DiskCache, *, lease_expiry_seconds: int = 120) -> int:
            calls["lease"] += 1
            return original_lease(cache, lease_expiry_seconds=lease_expiry_seconds)

        def start_process(*args: object, **kwargs: object) -> subprocess.Popen[str]:
            calls["process"] += 1
            return original_process(*args, **kwargs)

        with (
            patch.object(DiskCache, "cleanup_stale_temporaries", cleanup_temporary),
            patch.object(DiskCache, "cleanup_stale_leases", cleanup_lease),
            patch.object(subprocess, "Popen", start_process),
        ):
            for case_id, fixture in selected.items():
                run_protocol_case(
                    {
                        "contract_version": fixtures["contract_version"],
                        "suite": "cache",
                        "id": case_id,
                        "fixture": fixture,
                        "protocol_root": str(protocol_root),
                    }
                )

        self.assertGreaterEqual(calls["temporary"], 1)
        self.assertGreaterEqual(calls["lease"], 1)
        self.assertGreaterEqual(calls["process"], 3)


if __name__ == "__main__":
    unittest.main()

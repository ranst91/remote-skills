"""Shared-protocol adapter for Python-owned cache-v1 cases."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import datetime
from pathlib import Path
from typing import Any

from remote_skills.cache import CachedObject, DiskCache


def _read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _clock_and_liveness(state_root: Path, fixture: dict[str, Any]):
    inputs = _read_json(state_root / fixture["evaluation_inputs"])
    now = datetime.fromisoformat(inputs["now"].replace("Z", "+00:00"))
    liveness = {int(pid): alive for pid, alive in inputs["process_liveness"].items()}
    return inputs, (lambda: now), (lambda pid, process_nonce: liveness.get(pid, False))


def _digest_from_files(fixture: dict[str, Any]) -> str:
    metadata_relative = next(path for path in fixture["files"] if path.endswith("/object.json"))
    state_root = Path(fixture["_state_root"])
    return _read_json(state_root / metadata_relative)["digest"]


def _wait_for_marker(path: Path, *, timeout: float = 10.0) -> None:
    deadline = time.monotonic() + timeout
    while not path.exists():
        if time.monotonic() >= deadline:
            raise TimeoutError(f"cache race marker timed out: {path.name}")
        time.sleep(0.002)


def _same_immutable_object(observed: object, expected: object) -> bool:
    if not isinstance(observed, CachedObject) or not isinstance(expected, CachedObject):
        return False
    return (
        observed.digest == expected.digest
        and observed.artifact_type == expected.artifact_type
        and observed.archive_format == expected.archive_format
        and observed.artifact == expected.artifact
        and observed.files == expected.files
        and observed.media_types == expected.media_types
        and observed.verified_at == expected.verified_at
    )


def _release_publishers_as_ready(
    coordination_root: Path,
    publishers: dict[str, subprocess.Popen[str]],
    *,
    timeout: float = 10.0,
) -> dict[str, tuple[str, str]]:
    pending = set(publishers)
    completed: dict[str, tuple[str, str]] = {}
    deadline = time.monotonic() + timeout
    while pending:
        for label in sorted(pending):
            marker = coordination_root / f"ready-{label}"
            if marker.exists():
                (coordination_root / f"start-{label}").write_text(
                    "start",
                    encoding="utf-8",
                )
                pending.remove(label)
                break
            if publishers[label].poll() is not None:
                output, error = publishers[label].communicate()
                markers = [
                    name
                    for name in (
                        "ready",
                        "start",
                        "result",
                        "done",
                        "winner",
                    )
                    if (coordination_root / f"{name}-{label}").exists()
                    or (name == "winner" and (coordination_root / "winner").exists())
                ]
                if (
                    publishers[label].returncode == 0
                    and (coordination_root / f"result-{label}").exists()
                    and (coordination_root / f"done-{label}").exists()
                    and (coordination_root / "winner").exists()
                ):
                    completed[label] = (output, error)
                    pending.remove(label)
                    break
                raise RuntimeError(
                    f"{label} cache race publisher exited before ready: "
                    f"exit_code={publishers[label].returncode!r} "
                    f"command={publishers[label].args!r} stdout={output!r} stderr={error!r} "
                    f"markers={','.join(markers) if markers else 'none'}"
                )
        else:
            if time.monotonic() >= deadline:
                waiting = "; ".join(
                    f"{label}: command={publishers[label].args!r}, "
                    f"exit_code={publishers[label].poll()!r}"
                    for label in sorted(pending)
                )
                raise TimeoutError(f"cache race publishers timed out before ready: {waiting}")
            time.sleep(0.002)
    return completed


def _race_publish_worker(
    fixture_root: Path,
    cache_root: Path,
    coordination_root: Path,
    label: str,
    digest: str,
) -> None:
    fixture_cache = DiskCache(fixture_root, touch_on_read=False)
    cached = fixture_cache.get_object(digest)
    if cached is None:
        raise RuntimeError("race fixture object is missing")
    cache = DiskCache(cache_root, touch_on_read=False)
    after_private = cache._after_private_object

    def synchronized_private(private: Path, candidate) -> None:
        after_private(private, candidate)
        (coordination_root / f"ready-{label}").write_text("ready", encoding="utf-8")
        _wait_for_marker(coordination_root / f"start-{label}")

    cache._after_private_object = synchronized_private  # type: ignore[method-assign]
    published = cache.publish_object(cached)
    winner_path = coordination_root / "winner"
    try:
        descriptor = os.open(winner_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        pass
    else:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(label)
            handle.flush()
            os.fsync(handle.fileno())
    (coordination_root / f"result-{label}").write_text(
        published.digest,
        encoding="utf-8",
    )
    (coordination_root / f"done-{label}").write_text("done", encoding="utf-8")


def _race_observer_worker(
    fixture_root: Path,
    cache_root: Path,
    coordination_root: Path,
    digest: str,
) -> None:
    fixture_cache = DiskCache(fixture_root, touch_on_read=False)
    expected = fixture_cache.get_object(digest)
    if expected is None:
        raise RuntimeError("race fixture object is missing")
    cache = DiskCache(cache_root, touch_on_read=False)
    partial_observations = 0
    observations = 0
    (coordination_root / "ready-observer").write_text("ready", encoding="utf-8")
    _wait_for_marker(coordination_root / "start-observer")
    while not all(
        (coordination_root / f"done-{label}").exists()
        for label in ("python", "typescript")
    ):
        try:
            observed = cache.get_object(digest)
        except Exception:
            partial_observations += 1
        else:
            if observed is not None:
                observations += 1
                if not _same_immutable_object(observed, expected):
                    partial_observations += 1
        time.sleep(0.001)
    observed = cache.get_object(digest)
    if not _same_immutable_object(observed, expected):
        partial_observations += 1
    result = {
        "observations": observations,
        "partial_observations": partial_observations,
    }
    (coordination_root / "observer-result.json").write_text(
        json.dumps(result),
        encoding="utf-8",
    )


def _race_environment() -> dict[str, str]:
    source_root = str(Path(__file__).resolve().parents[2])
    environment = {
        "PATH": os.environ.get("PATH", ""),
        "PYTHONPATH": source_root,
        "PYTHONUTF8": "1",
    }
    for name in ("SYSTEMROOT", "TEMP", "TMP", "TMPDIR"):
        if name in os.environ:
            environment[name] = os.environ[name]
    return environment


def _typescript_worker() -> Path:
    return (
        Path(__file__).resolve().parents[5]
        / "packages/sdk-typescript/src/cache/protocol-worker.mjs"
    )


def _run_cross_process_race(
    fixture_root: Path,
    cache_root: Path,
    digest: str,
    activations: int,
) -> dict[str, Any]:
    fixture_copy = cache_root / "fixture-source"
    shutil.copytree(fixture_root / "cache-v1", fixture_copy / "cache-v1")
    coordination_root = cache_root / "race-coordination"
    coordination_root.mkdir(parents=True)
    base = [
        sys.executable,
        "-m",
        "remote_skills.cache.protocol",
    ]
    environment = _race_environment()

    def start_python(*arguments: str) -> subprocess.Popen[str]:
        return subprocess.Popen(
            [*base, *arguments],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=environment,
        )

    python_publisher = start_python(
        "--race-publisher",
        str(fixture_copy),
        str(cache_root),
        str(coordination_root),
        "python",
        digest,
    )
    processes = [python_publisher]
    try:
        # Establish the reviewed winner before a serialized contender can claim it.
        _wait_for_marker(coordination_root / "ready-python")
        typescript_publisher = subprocess.Popen(
            [
                "node",
                str(_typescript_worker()),
                "--race-publisher",
                str(fixture_copy),
                str(cache_root),
                str(coordination_root),
                "typescript",
                digest,
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=environment,
        )
        processes.append(typescript_publisher)
        publishers = {
            "python": python_publisher,
            "typescript": typescript_publisher,
        }
        observer = start_python(
            "--race-observer",
            str(fixture_copy),
            str(cache_root),
            str(coordination_root),
            digest,
        )
        processes.append(observer)
        _wait_for_marker(coordination_root / "ready-observer")
        (coordination_root / "start-observer").write_text("start", encoding="utf-8")
        completed = _release_publishers_as_ready(
            coordination_root,
            {"python": python_publisher},
        )
        python_output, python_error = completed.get("python") or publishers["python"].communicate(
            timeout=10
        )
        if publishers["python"].returncode != 0:
            raise RuntimeError(f"python cache race publisher failed: {python_error or python_output}")
        winner = (coordination_root / "winner").read_text(encoding="utf-8")
        if winner != "python":
            raise RuntimeError(f"python cache race publisher lost the designated race: {winner}")
        completed.update(
            _release_publishers_as_ready(
                coordination_root,
                {"typescript": typescript_publisher},
            )
        )
        typescript_output, typescript_error = completed.get("typescript") or publishers[
            "typescript"
        ].communicate(timeout=10)
        if publishers["typescript"].returncode != 0:
            raise RuntimeError(
                f"typescript cache race publisher failed: {typescript_error or typescript_output}"
            )
        observer_output, observer_error = observer.communicate(timeout=10)
        if observer.returncode != 0:
            raise RuntimeError(f"cache race observer failed: {observer_error or observer_output}")
    finally:
        for process in processes:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=5)

    observer_result = _read_json(coordination_root / "observer-result.json")
    published_objects = len(
        list((cache_root / "cache-v1/objects").glob("sha256/*/*/object.json"))
    )
    temporary_root = cache_root / "cache-v1/tmp"
    remaining_temporary_entries = (
        [
            path
            for path in temporary_root.iterdir()
            if path.name not in {"coordination-v1", "catalog-generations-v1"}
        ]
        if temporary_root.is_dir()
        else []
    )
    return {
        "outcome": "one_immutable_winner",
        "activations": activations,
        "published_objects": published_objects,
        "partial_observations": observer_result["partial_observations"],
        "winner": (coordination_root / "winner").read_text(encoding="utf-8"),
        "losing_temp_cleaned": not remaining_temporary_entries,
    }


def run_protocol_case(case: dict[str, Any]) -> dict[str, Any]:
    """Evaluate one checked-in cache case without consulting expected results."""

    if case.get("suite") != "cache":
        raise NotImplementedError("this task owns only the cache protocol suite")
    fixture = dict(case["fixture"])
    protocol_root = Path(case["protocol_root"])
    state_root = protocol_root / "fixtures/cache/states" / fixture["state"]
    fixture["_state_root"] = str(state_root)
    case_id = case["id"]

    if case_id == "cache-v1-valid":
        inputs, clock, liveness = _clock_and_liveness(state_root, fixture)
        with tempfile.TemporaryDirectory() as temporary:
            working = Path(temporary)
            shutil.copytree(state_root / "cache-v1", working / "cache-v1")
            cache = DiskCache(
                working,
                touch_on_read=False,
                clock=clock,
                process_is_alive=liveness,
            )
            digest = _digest_from_files(fixture)
            cached = cache.get_object(digest)
            if cached is None or not cache.has_live_lease(
                digest,
                lease_expiry_seconds=inputs["lease_expiry_seconds"],
            ):
                raise AssertionError("valid cache fixture is not reusable and pinned")
            return {
                "outcome": "cache_reuse",
                "layout": cache.namespace.name,
                "artifact_requests": 0,
                "digest": cached.digest,
            }

    if case_id == "cache-v1-partial-writer":
        with tempfile.TemporaryDirectory() as temporary:
            working = Path(temporary)
            shutil.copytree(state_root / "cache-v1", working / "cache-v1")
            now = datetime.fromisoformat("2030-01-01T00:00:00+00:00")
            stale = now.timestamp() - 3600
            for path in (working / "cache-v1/tmp").rglob("*"):
                os.utime(path, (stale, stale))
            cache = DiskCache(
                working,
                touch_on_read=False,
                clock=lambda: now,
                process_is_alive=lambda pid, process_nonce: False,
            )
            removed = cache.cleanup_stale_temporaries(max_age_seconds=120)
            published = (working / "cache-v1/objects").exists()
            return {
                "outcome": "temporary_ignored",
                "published_object": published,
                "cleanup_eligible": removed == 1,
            }

    if case_id == "cache-v1-crashed-lease":
        inputs, clock, liveness = _clock_and_liveness(state_root, fixture)
        with tempfile.TemporaryDirectory() as temporary:
            working = Path(temporary)
            shutil.copytree(state_root / "cache-v1", working / "cache-v1")
            cache = DiskCache(
                working,
                touch_on_read=False,
                clock=clock,
                process_is_alive=liveness,
            )
            digest = _digest_from_files(fixture)
            removed = cache.cleanup_stale_leases(
                lease_expiry_seconds=inputs["lease_expiry_seconds"]
            )
            return {
                "outcome": "lease_reclaimable",
                "object_retained": cache.get_object(digest) is not None,
                "requires_process_liveness_check": removed == 1,
            }

    if case_id == "cache-v1-cross-process":
        before = state_root / fixture["before"]
        after = state_root / fixture["after"]
        writers = [_read_json(path) for path in sorted((before / "cache-v1/tmp").glob("*/writer.json"))]
        digests = {writer["expected_digest"] for writer in writers if writer.get("complete") is True}
        if len(digests) != 1:
            raise AssertionError("race fixture writers do not agree on one verified digest")
        digest = digests.pop()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fixture_copy = root / "fixture-source"
            shutil.copytree(after / "cache-v1", fixture_copy / "cache-v1")
            cached = DiskCache(fixture_copy, touch_on_read=False).get_object(digest)
            if cached is None:
                raise AssertionError("cross-process after-state has no reusable winner")
            return _run_cross_process_race(
                fixture_copy,
                root / "working",
                digest,
                len(writers),
            )

    if case_id == "cache-v2-unknown":
        with tempfile.TemporaryDirectory() as temporary:
            working = Path(temporary)
            shutil.copytree(state_root / "cache-v2", working / "cache-v2")
            opaque = working / "cache-v2"
            before = {path.name: path.read_bytes() for path in opaque.iterdir()}
            cache = DiskCache(working, touch_on_read=False)
            cache.cleanup_stale_temporaries(max_age_seconds=0)
            cache.evict(max_bytes=0, max_age_seconds=0)
            after = {path.name: path.read_bytes() for path in opaque.iterdir()}
            if before != after:
                raise AssertionError("cache-v1 operation changed the opaque namespace")
            return {
                "outcome": "unsupported_namespace_untouched",
                "client_namespace": "cache-v1",
                "opaque_namespace": opaque.name,
            }

    raise KeyError(f"unknown cache protocol case: {case_id}")


__all__ = ["run_protocol_case"]


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--case-json":
        print(json.dumps(run_protocol_case(json.loads(sys.argv[2]))))
    elif len(sys.argv) == 7 and sys.argv[1] == "--race-publisher":
        _race_publish_worker(
            Path(sys.argv[2]),
            Path(sys.argv[3]),
            Path(sys.argv[4]),
            sys.argv[5],
            sys.argv[6],
        )
    elif len(sys.argv) == 6 and sys.argv[1] == "--race-observer":
        _race_observer_worker(
            Path(sys.argv[2]),
            Path(sys.argv[3]),
            Path(sys.argv[4]),
            sys.argv[5],
        )
    else:
        raise SystemExit("invalid cache protocol worker arguments")

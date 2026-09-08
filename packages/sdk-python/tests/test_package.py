from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import tomllib
import unittest
import zipfile


PACKAGE_ROOT = Path(__file__).resolve().parents[1]
LOCKED_DEPENDENCY_NAME = "uts46"
LOCKED_DEPENDENCY_VERSION = "0.2.0"
MATERIALIZE_LOCKED_DEPENDENCY = (
    PACKAGE_ROOT.parents[1] / "scripts/materialize-locked-python-dependency.py"
)
UV_VERSION_REQUIREMENT = ">=0.11.33,<0.12.0"


def resolve_compatible_uv_command() -> str:
    configured = os.environ.get("REMOTE_SKILLS_UV")
    if configured is not None:
        if not Path(configured).is_absolute():
            raise AssertionError(
                "REMOTE_SKILLS_UV must be one absolute executable path"
            )
        candidates = [configured]
    else:
        candidates = []
        for directory in os.get_exec_path():
            candidate = shutil.which("uv", path=directory)
            if candidate is not None and candidate not in candidates:
                candidates.append(candidate)
    rejected: list[str] = []
    for candidate in candidates:
        command = str(Path(candidate).resolve())
        try:
            result = subprocess.run(
                [command, "--version"],
                capture_output=True,
                check=False,
                env=os.environ,
                text=True,
            )
        except OSError as error:
            rejected.append(f"{command} ({error})")
            continue
        output = result.stdout.strip()
        match = re.fullmatch(r"uv (\d+)\.(\d+)\.(\d+)(?:\s.*)?", output)
        if match is not None:
            version = tuple(int(component) for component in match.groups())
            if version[0:2] == (0, 11) and version[2] >= 33:
                return command
        rejected.append(f"{command} ({output or f'status {result.returncode}'})")
    checked = ", ".join(rejected) if rejected else "no uv executables on PATH"
    raise AssertionError(
        f"remote-skills offline builds require uv {UV_VERSION_REQUIREMENT}; "
        f"checked: {checked}. Set REMOTE_SKILLS_UV to one compatible absolute "
        "executable path."
    )


UV_COMMAND = resolve_compatible_uv_command()


def run_checked(
    command: list[str], *, cwd: Path, environment: dict[str, str]
) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        command,
        capture_output=True,
        check=False,
        cwd=cwd,
        env=environment,
        text=True,
    )
    if result.returncode != 0:
        raise AssertionError(f"{result.stdout}\n{result.stderr}")
    return result


def materialize_locked_dependency_wheel(
    destination: Path, *, source_date_epoch: str | None = None
) -> Path:
    environment = dict(os.environ)
    if source_date_epoch is not None:
        environment["SOURCE_DATE_EPOCH"] = source_date_epoch
    completed = run_checked(
        [
            UV_COMMAND,
            "run",
            "--project",
            str(PACKAGE_ROOT),
            "--locked",
            "--no-sync",
            "--offline",
            "--no-python-downloads",
            "python",
            str(MATERIALIZE_LOCKED_DEPENDENCY),
            str(destination),
        ],
        cwd=PACKAGE_ROOT,
        environment=environment,
    )
    return Path(completed.stdout.strip())


def discover_uv_cache_directory(
    *, cwd: Path, environment: dict[str, str]
) -> Path:
    output = run_checked(
        [UV_COMMAND, "cache", "dir", "--color", "never", "--no-config"],
        cwd=cwd,
        environment=environment,
    ).stdout
    cache = output[:-1] if output.endswith("\n") else ""
    if (
        not cache
        or any(ord(character) <= 31 or ord(character) == 127 for character in cache)
        or not Path(cache).is_absolute()
    ):
        raise AssertionError("uv cache directory output was not one plain absolute path")
    return Path(cache)


class UvCacheDiscoveryTests(unittest.TestCase):
    def test_force_color_cannot_decorate_the_discovered_cache_path(self) -> None:
        environment = {**os.environ, "FORCE_COLOR": "0"}

        cache = discover_uv_cache_directory(
            cwd=PACKAGE_ROOT,
            environment=environment,
        )

        self.assertTrue(cache.is_absolute())
        self.assertNotIn("\x1b", str(cache))


@contextmanager
def built_distributions() -> Iterator[Path]:
    with tempfile.TemporaryDirectory(prefix="remote-skills-python-build-") as root:
        temporary_root = Path(root)
        environment = {
            **os.environ,
            "UV_CACHE_DIR": str(temporary_root / "uv-cache"),
            "UV_DEFAULT_INDEX": "http://127.0.0.1:9/simple",
            "UV_OFFLINE": "true",
            "UV_PYTHON_DOWNLOADS": "never",
        }
        run_checked(
            [
                UV_COMMAND,
                "build",
                "--offline",
                "--no-index",
                "--no-python-downloads",
                "--no-config",
                "--no-create-gitignore",
                "--out-dir",
                str(temporary_root / "dist"),
                str(PACKAGE_ROOT),
            ],
            cwd=PACKAGE_ROOT,
            environment=environment,
        )
        yield temporary_root / "dist"


class PackageMetadataTests(unittest.TestCase):
    def test_source_date_epoch_produces_reproducible_wheel_timestamps(self) -> None:
        cases = (
            ("0", (1980, 1, 1, 0, 0, 0)),
            ("946684800", (2000, 1, 1, 0, 0, 0)),
        )
        for source_date_epoch, expected_timestamp in cases:
            with self.subTest(source_date_epoch=source_date_epoch):
                with tempfile.TemporaryDirectory(
                    prefix="remote-skills-python-dependency-"
                ) as root:
                    temporary_root = Path(root)
                    first_directory = temporary_root / "first"
                    second_directory = temporary_root / "second"
                    first_directory.mkdir()
                    second_directory.mkdir()
                    first = materialize_locked_dependency_wheel(
                        first_directory,
                        source_date_epoch=source_date_epoch,
                    )
                    second = materialize_locked_dependency_wheel(
                        second_directory,
                        source_date_epoch=source_date_epoch,
                    )

                    with zipfile.ZipFile(first) as archive:
                        timestamps = {
                            member.date_time for member in archive.infolist()
                        }

                    self.assertEqual(timestamps, {expected_timestamp})
                    self.assertEqual(first.read_bytes(), second.read_bytes())

    def test_distribution_declares_the_public_v0_contract(self) -> None:
        configuration = tomllib.loads(
            (PACKAGE_ROOT / "pyproject.toml").read_text(encoding="utf-8")
        )

        project = configuration["project"]
        self.assertEqual(project["name"], "remote-skills")
        self.assertEqual(project["version"], "0.0.1")
        self.assertEqual(project["requires-python"], ">=3.11")
        self.assertEqual(project["license"], "Apache-2.0")
        self.assertEqual(project["readme"], "README.md")
        self.assertEqual(
            project["dependencies"],
            [f"{LOCKED_DEPENDENCY_NAME}=={LOCKED_DEPENDENCY_VERSION}"],
        )

    def test_local_build_produces_wheel_and_source_distribution(self) -> None:
        with built_distributions() as distribution_root:
            self.assertEqual(
                sorted(path.name for path in distribution_root.iterdir()),
                [
                    "remote_skills-0.0.1-py3-none-any.whl",
                    "remote_skills-0.0.1.tar.gz",
                ],
            )

    def test_artifacts_contain_only_runtime_and_distribution_sources(self) -> None:
        with built_distributions() as distribution_root:
            wheel = distribution_root / "remote_skills-0.0.1-py3-none-any.whl"
            source = distribution_root / "remote_skills-0.0.1.tar.gz"
            with zipfile.ZipFile(wheel) as archive:
                wheel_paths = archive.namelist()
            with tarfile.open(source, mode="r:gz") as archive:
                source_paths = archive.getnames()

        self.assertIn("remote_skills/__init__.py", wheel_paths)
        for workspace_only in (
            "remote_skills/protocol_adapter.py",
            "remote_skills/cache/protocol.py",
        ):
            self.assertNotIn(workspace_only, wheel_paths)
        self.assertIn(
            "remote_skills-0.0.1.dist-info/licenses/LICENSE",
            wheel_paths,
        )
        for required in (
            "remote_skills-0.0.1/LICENSE",
            "remote_skills-0.0.1/README.md",
            "remote_skills-0.0.1/pyproject.toml",
            "remote_skills-0.0.1/src/remote_skills/__init__.py",
        ):
            self.assertIn(required, source_paths)
        for workspace_only in (
            "remote_skills-0.0.1/src/remote_skills/protocol_adapter.py",
            "remote_skills-0.0.1/src/remote_skills/cache/protocol.py",
        ):
            self.assertNotIn(workspace_only, source_paths)
        for path in (*wheel_paths, *source_paths):
            segments = Path(path).parts
            self.assertFalse(
                {"tests", "fixtures", "__pycache__"}.intersection(segments), path
            )
            self.assertNotEqual(Path(path).suffix, ".pyc", path)
            self.assertNotIn(Path(path).name, {"package.json", "turbo.json", ".gitkeep"})

    def test_distributions_install_offline_and_run_the_async_quickstart(self) -> None:
        with built_distributions() as distribution_root:
            dependency = materialize_locked_dependency_wheel(distribution_root)
            distributions = [
                distribution_root / "remote_skills-0.0.1-py3-none-any.whl",
                distribution_root / "remote_skills-0.0.1.tar.gz",
            ]
            for distribution in distributions:
                with self.subTest(distribution=distribution.name):
                    with tempfile.TemporaryDirectory(
                        prefix="remote-skills-python-install-"
                    ) as root:
                        clean_project = Path(root)
                        virtual_environment = clean_project / ".venv"
                        smoke = clean_project / "smoke.py"
                        smoke.write_text(INSTALLED_ARTIFACT_SMOKE, encoding="utf-8")
                        environment = {
                            key: value
                            for key, value in os.environ.items()
                            if key
                            not in {"PYTHONPATH", "UV_PROJECT_ENVIRONMENT", "VIRTUAL_ENV"}
                        }
                        uv_cache = discover_uv_cache_directory(
                            cwd=clean_project,
                            environment=environment,
                        )
                        environment.update(
                            {
                                "PYTHONNOUSERSITE": "1",
                                "UV_CACHE_DIR": str(uv_cache),
                                "UV_DEFAULT_INDEX": "http://127.0.0.1:9/simple",
                                "UV_OFFLINE": "true",
                                "UV_PYTHON_DOWNLOADS": "never",
                            }
                        )
                        run_checked(
                            [
                                UV_COMMAND,
                                "venv",
                                "--python",
                                sys.executable,
                                "--no-python-downloads",
                                "--no-config",
                                str(virtual_environment),
                            ],
                            cwd=clean_project,
                            environment=environment,
                        )
                        installed_python = virtual_environment / "bin" / "python"
                        if sys.platform == "win32":
                            installed_python = virtual_environment / "Scripts" / "python.exe"
                        run_checked(
                            [
                                UV_COMMAND,
                                "pip",
                                "install",
                                "--python",
                                str(installed_python),
                                "--offline",
                                "--no-index",
                                "--no-deps",
                                "--no-config",
                                str(dependency),
                            ],
                            cwd=clean_project,
                            environment=environment,
                        )
                        run_checked(
                            [
                                UV_COMMAND,
                                "pip",
                                "install",
                                "--python",
                                str(installed_python),
                                "--offline",
                                "--no-index",
                                "--no-deps",
                                "--no-config",
                                str(distribution),
                            ],
                            cwd=clean_project,
                            environment=environment,
                        )
                        result = run_checked(
                            [str(installed_python), "-I", str(smoke)],
                            cwd=clean_project,
                            environment=environment,
                        )

                    self.assertEqual(
                        result.stdout,
                        "remote-skills 0.0.1 async smoke passed\n",
                    )


INSTALLED_ARTIFACT_SMOKE = r'''from __future__ import annotations

import asyncio
import hashlib
from importlib.metadata import PackageNotFoundError, version
import json
from pathlib import Path
import sys

import remote_skills
from remote_skills import Origin, RemoteSkills
from remote_skills.cache import MemoryCache
import uts46


ARTIFACT = b"---\nname: code-review\ndescription: Review safely.\n---\n# Review\n"
DIGEST = hashlib.sha256(ARTIFACT).hexdigest()
CATALOG = json.dumps(
    {
        "$schema": "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
        "skills": [
            {
                "name": "code-review",
                "description": "Review safely.",
                "type": "skill-md",
                "url": f"artifacts/sha256-{DIGEST}.md",
                "digest": f"sha256:{DIGEST}",
            }
        ],
    },
    separators=(",", ":"),
).encode()
REQUEST_PATHS: list[bytes] = []


async def handle_request(
    reader: asyncio.StreamReader, writer: asyncio.StreamWriter
) -> None:
    request_line = await reader.readline()
    while await reader.readline() not in {b"\r\n", b""}:
        pass
    path = request_line.split(b" ", 2)[1]
    REQUEST_PATHS.append(path)
    if path == b"/.well-known/agent-skills/index.json":
        body = CATALOG
        content_type = "application/json"
    else:
        assert path == f"/.well-known/agent-skills/artifacts/sha256-{DIGEST}.md".encode()
        body = ARTIFACT
        content_type = "text/markdown"
    writer.write(
        (
            "HTTP/1.1 200 OK\r\n"
            f"Content-Type: {content_type}\r\n"
            f"Content-Length: {len(body)}\r\n"
            "Connection: close\r\n\r\n"
        ).encode()
        + body
    )
    await writer.drain()
    writer.close()
    await writer.wait_closed()


async def main() -> None:
    environment = Path(sys.prefix).resolve()
    assert Path(remote_skills.__file__).resolve().is_relative_to(environment)
    assert Path(uts46.__file__).resolve().is_relative_to(environment)
    server = await asyncio.start_server(handle_request, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    client = RemoteSkills(
        origins={
            "acme": Origin(
                url=f"http://127.0.0.1:{port}",
                allow_loopback_http=True,
                retries=0,
            )
        },
        cache=MemoryCache(),
    )
    try:
        async with client.session("acme") as session:
            entries = await session.catalog()
            skill = await session.activate("code-review")
            assert [entry.name for entry in entries] == ["code-review"]
            assert skill.instructions == "# Review\n"
            assert await skill.read("SKILL.md") == ARTIFACT.decode()
    finally:
        server.close()
        await server.wait_closed()
    assert REQUEST_PATHS == [
        b"/.well-known/agent-skills/index.json",
        f"/.well-known/agent-skills/artifacts/sha256-{DIGEST}.md".encode(),
    ]
    assert version("remote-skills") == "0.0.1"
    try:
        version("uv-build")
    except PackageNotFoundError:
        pass
    else:
        raise AssertionError("build backend leaked into the runtime environment")
    print("remote-skills 0.0.1 async smoke passed")


asyncio.run(main())
'''


if __name__ == "__main__":
    unittest.main()

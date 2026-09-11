"""Inspect release distributions without importing or extracting their code."""

from __future__ import annotations

from email.parser import BytesParser
import json
from pathlib import Path, PurePosixPath
import re
import stat
import sys
import tarfile
import tomllib
import zipfile

from packaging.requirements import Requirement
from packaging.specifiers import SpecifierSet


def safe_paths(paths: list[str], artifact: Path) -> list[str]:
    normalized = sorted(paths)
    seen: set[str] = set()
    for value in normalized:
        path = PurePosixPath(value)
        canonical = value.rstrip("/")
        if (
            not canonical
            or path.is_absolute()
            or any(part in {"", ".", ".."} for part in canonical.split("/"))
            or "\\" in value
            or canonical in seen
        ):
            raise RuntimeError(f"unsafe or duplicate distribution path in {artifact.name}")
        seen.add(canonical)
        if {"tests", "examples", "fixtures", "__pycache__", ".git"}.intersection(path.parts):
            raise RuntimeError(f"workspace-only content in {artifact.name}")
        if path.suffix == ".pyc" or path.name in {"package.json", "turbo.json", "uv.lock"}:
            raise RuntimeError(f"workspace-only content in {artifact.name}")
    return normalized


def metadata_fields(raw: bytes) -> dict[str, object]:
    message = BytesParser().parsebytes(raw)
    result: dict[str, object] = {}
    for name in ("License-Expression", "Name", "Requires-Python", "Version"):
        values = message.get_all(name, [])
        if len(values) != 1:
            raise RuntimeError(f"distribution must declare exactly one {name}")
        result[name] = values[0]
    result["Requires-Dist"] = message.get_all("Requires-Dist", [])
    return result


def expected_metadata(project: dict[str, object]) -> dict[str, object]:
    return {
        "Name": project["name"],
        "Version": project["version"],
        "License-Expression": project["license"],
        "Requires-Python": project["requires-python"],
        "Requires-Dist": project.get("dependencies", []),
    }


def validate_metadata(actual: dict[str, object], expected: dict[str, object]) -> None:
    for name in ("Name", "Version", "License-Expression"):
        if actual.get(name) != expected[name]:
            raise RuntimeError(f"unexpected distribution {name}")
    if SpecifierSet(str(actual["Requires-Python"])) != SpecifierSet(str(expected["Requires-Python"])):
        raise RuntimeError("unexpected distribution Requires-Python")
    actual_requirements = [Requirement(value) for value in actual["Requires-Dist"]]
    expected_requirements = [Requirement(value) for value in expected["Requires-Dist"]]
    if any(requirement.url for requirement in (*actual_requirements, *expected_requirements)):
        raise RuntimeError("distribution dependencies must not contain direct URLs or local paths")
    if len(set(actual_requirements)) != len(actual_requirements) or set(actual_requirements) != set(expected_requirements):
        raise RuntimeError("unexpected distribution Requires-Dist")


def inspect_wheel(path: Path, descriptor: dict[str, str], project: dict[str, object]) -> dict[str, object]:
    with zipfile.ZipFile(path) as archive:
        paths = safe_paths(archive.namelist(), path)
        if any(stat.S_ISLNK(member.external_attr >> 16) for member in archive.infolist()):
            raise RuntimeError("wheel must not contain symbolic links")
        metadata_paths = [value for value in paths if value.endswith(".dist-info/METADATA")]
        if len(metadata_paths) != 1:
            raise RuntimeError(f"{path.name} must contain exactly one METADATA file")
        metadata = metadata_fields(archive.read(metadata_paths[0]))
    validate_metadata(metadata, expected_metadata(project))
    module = descriptor["importName"].replace(".", "/")
    dist_info = metadata_paths[0].split("/", 1)[0]
    if any(value.split("/", 1)[0] not in {module.split("/", 1)[0], dist_info} for value in paths):
        raise RuntimeError("wheel contains an unexpected top-level package")
    return {
        "archive": "wheel",
        "entries": len(paths),
        "metadata": metadata,
        "requiredFiles": {
            "license": f"{dist_info}/licenses/LICENSE" in paths,
            "module": f"{module}/__init__.py" in paths,
        },
    }


def inspect_sdist(path: Path, descriptor: dict[str, str], project: dict[str, object]) -> dict[str, object]:
    prefix = f"{descriptor['name'].replace('-', '_')}-{descriptor['version']}/"
    with tarfile.open(path, mode="r:gz") as archive:
        members = archive.getmembers()
        paths = safe_paths([member.name for member in members], path)
        if any(not (member.isfile() or member.isdir()) for member in members):
            raise RuntimeError("source distribution must not contain links or special files")
        if any(not value.startswith(prefix) and value != prefix.rstrip("/") for value in paths):
            raise RuntimeError("source distribution contains an unexpected root")

        def read_file(name: str) -> bytes:
            member = archive.getmember(prefix + name)
            if not member.isfile():
                raise RuntimeError("source distribution metadata must be regular files")
            handle = archive.extractfile(member)
            if handle is None:
                raise RuntimeError("source distribution is missing metadata")
            return handle.read()

        metadata = metadata_fields(read_file("PKG-INFO"))
        archived_project = tomllib.loads(read_file("pyproject.toml").decode("utf-8"))["project"]
    validate_metadata(metadata, expected_metadata(project))
    validate_metadata(expected_metadata(archived_project), expected_metadata(project))
    module = descriptor["importName"].replace(".", "/")
    return {
        "archive": "sdist",
        "entries": len(paths),
        "metadata": metadata,
        "requiredFiles": {
            "license": f"{prefix}LICENSE" in paths,
            "module": f"{prefix}src/{module}/__init__.py" in paths,
            "readme": f"{prefix}{project['readme']}" in paths,
        },
    }


def main() -> None:
    args = sys.argv[1:]
    if len(args) == 4 and args[0] == "--descriptor":
        descriptor = json.loads(Path(args[1]).read_text())
        args = args[2:]
    elif len(args) == 2:
        manifest = Path(__file__).resolve().parents[1] / "packages/sdk-python/pyproject.toml"
        project = tomllib.loads(manifest.read_text())["project"]
        descriptor = {"name": "remote-skills", "version": project["version"], "manifestPath": str(manifest), "importName": "remote_skills"}
    else:
        raise RuntimeError("usage: inspect-python-distributions.py [--descriptor <json-file>] <wheel> <source-distribution>")
    if not isinstance(descriptor, dict) or any(not isinstance(descriptor.get(name), str) or not descriptor[name] for name in ("name", "version", "manifestPath", "importName")):
        raise RuntimeError("invalid Python artifact descriptor")
    if not re.fullmatch(r"[A-Za-z_][A-Za-z_0-9]*(?:\.[A-Za-z_][A-Za-z_0-9]*)*", descriptor["importName"]):
        raise RuntimeError("invalid Python module descriptor")
    project = tomllib.loads(Path(descriptor["manifestPath"]).read_text())["project"]
    if project["name"] != descriptor["name"] or project["version"] != descriptor["version"] or project["license"] != "Apache-2.0":
        raise RuntimeError("Python artifact descriptor differs from project metadata")
    wheel, source = (Path(value).resolve(strict=True) for value in args)
    result = [inspect_wheel(wheel, descriptor, project), inspect_sdist(source, descriptor, project)]
    for artifact in result:
        if not all(artifact["requiredFiles"].values()):
            raise RuntimeError("distribution is missing required files")
    # These two SDK entrypoints exist only to run shared protocol fixtures.
    if descriptor["name"] == "remote-skills":
        forbidden = {"remote_skills/cache/protocol.py", "remote_skills/protocol_adapter.py"}
        with zipfile.ZipFile(wheel) as archive:
            if forbidden.intersection(archive.namelist()):
                raise RuntimeError("SDK wheel contains workspace-only protocol adapters")
        with tarfile.open(source, "r:gz") as archive:
            if any(any(name.endswith("/src/" + item) for item in forbidden) for name in archive.getnames()):
                raise RuntimeError("SDK source distribution contains workspace-only protocol adapters")
    print(json.dumps(result, separators=(",", ":")))


if __name__ == "__main__":
    main()

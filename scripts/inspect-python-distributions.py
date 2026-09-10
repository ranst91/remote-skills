from __future__ import annotations

import json
from pathlib import Path, PurePosixPath
import sys
import tarfile
import tomllib
import zipfile


def safe_paths(paths: list[str], artifact: Path) -> list[str]:
    normalized = sorted(paths)
    for value in normalized:
        path = PurePosixPath(value)
        if path.is_absolute() or ".." in path.parts or "\\" in value:
            raise RuntimeError(f"unsafe distribution path in {artifact.name}: {value}")
    return normalized


def metadata_fields(raw: str) -> dict[str, str]:
    fields: dict[str, str] = {}
    for line in raw.splitlines():
        if ": " not in line:
            continue
        name, value = line.split(": ", 1)
        if name in {"License-Expression", "Name", "Requires-Python", "Version"}:
            fields[name] = value
    return fields


def inspect_wheel(path: Path) -> dict[str, object]:
    with zipfile.ZipFile(path) as archive:
        paths = safe_paths(archive.namelist(), path)
        metadata_paths = [value for value in paths if value.endswith(".dist-info/METADATA")]
        if len(metadata_paths) != 1:
            raise RuntimeError(f"{path.name} must contain exactly one METADATA file")
        metadata = metadata_fields(archive.read(metadata_paths[0]).decode("utf-8"))
    return {
        "archive": "wheel",
        "entries": len(paths),
        "metadata": metadata,
        "requiredFiles": {
            "license": any(".dist-info/licenses/LICENSE" in value for value in paths),
            "module": "remote_skills/__init__.py" in paths,
        },
    }


def inspect_sdist(path: Path) -> dict[str, object]:
    with tarfile.open(path, mode="r:gz") as archive:
        members = archive.getmembers()
        paths = safe_paths([member.name for member in members], path)
        project_members = [member for member in members if member.name.endswith("/pyproject.toml")]
        if len(project_members) != 1:
            raise RuntimeError(f"{path.name} must contain exactly one pyproject.toml")
        project_file = archive.extractfile(project_members[0])
        if project_file is None:
            raise RuntimeError(f"{path.name} pyproject.toml is not a regular file")
        project = tomllib.loads(project_file.read().decode("utf-8"))["project"]
    prefix = f"{project['name'].replace('-', '_')}-{project['version']}/"
    return {
        "archive": "sdist",
        "entries": len(paths),
        "metadata": {
            "License-Expression": project["license"],
            "Name": project["name"],
            "Requires-Python": project["requires-python"],
            "Version": project["version"],
        },
        "requiredFiles": {
            "license": f"{prefix}LICENSE" in paths,
            "module": f"{prefix}src/remote_skills/__init__.py" in paths,
            "readme": f"{prefix}README.md" in paths,
        },
    }


def main() -> None:
    expected_version = tomllib.loads((Path(__file__).resolve().parents[1] / "packages/sdk-python/pyproject.toml").read_text())["project"]["version"]
    if len(sys.argv) != 3:
        raise RuntimeError(
            "usage: inspect-python-distributions.py <wheel> <source-distribution>"
        )
    wheel, source = (Path(value).resolve(strict=True) for value in sys.argv[1:])
    result = [inspect_wheel(wheel), inspect_sdist(source)]
    for artifact in result:
        if not all(artifact["requiredFiles"].values()):
            raise RuntimeError(f"distribution is missing required files: {artifact}")
        metadata = artifact["metadata"]
        if (
            metadata.get("Name") != "remote-skills"
            or metadata.get("Version") != expected_version
            or metadata.get("License-Expression") != "Apache-2.0"
            or metadata.get("Requires-Python") != ">=3.11"
        ):
            raise RuntimeError(f"unexpected distribution metadata: {metadata}")
    print(json.dumps(result, separators=(",", ":")))


if __name__ == "__main__":
    main()

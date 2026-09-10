"""Author reviewed publisher golden inputs; never imported by production code or tests."""

from __future__ import annotations

import gzip
import hashlib
import io
import json
import stat
import tarfile
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
PUBLISHER = ROOT / "fixtures" / "publisher"
SOURCE = PUBLISHER / "source" / "skills"
GOLDENS = PUBLISHER / "goldens"
SCHEMA = "https://schemas.agentskills.io/discovery/0.2.0/schema.json"


def digest(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def source_entries(skill: str) -> list[tuple[str, bytes]]:
    root = SOURCE / skill
    return sorted(
        ((path.relative_to(root).as_posix(), path.read_bytes()) for path in root.rglob("*") if path.is_file()),
        key=lambda entry: entry[0].encode("utf-8"),
    )


def make_tar_gzip(entries: list[tuple[str, bytes]]) -> bytes:
    tar_buffer = io.BytesIO()
    with tarfile.open(fileobj=tar_buffer, mode="w", format=tarfile.USTAR_FORMAT) as archive:
        for name, payload in entries:
            info = tarfile.TarInfo(name)
            info.mode = 0o644
            info.uid = 0
            info.gid = 0
            info.uname = ""
            info.gname = ""
            info.mtime = 0
            info.size = len(payload)
            archive.addfile(info, io.BytesIO(payload))
    compressed = io.BytesIO()
    with gzip.GzipFile(fileobj=compressed, mode="wb", filename="", compresslevel=9, mtime=0) as output:
        output.write(tar_buffer.getvalue())
    return compressed.getvalue()


def make_zip(entries: list[tuple[str, bytes]]) -> bytes:
    output = io.BytesIO()
    with zipfile.ZipFile(output, mode="w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        archive.comment = b""
        for name, payload in entries:
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = (stat.S_IFREG | 0o644) << 16
            info.extra = b""
            info.comment = b""
            archive.writestr(info, payload, compresslevel=9)
    return output.getvalue()


def write_format(format_name: str, extension: str, archive: bytes) -> None:
    index_root = GOLDENS / format_name / ".well-known" / "agent-skills"
    artifacts = index_root / "artifacts"
    artifacts.mkdir(parents=True, exist_ok=True)

    markdown = (SOURCE / "code-review" / "SKILL.md").read_bytes()
    markdown_digest = digest(markdown)
    archive_digest = digest(archive)
    markdown_name = f"sha256-{markdown_digest}.md"
    archive_name = f"sha256-{archive_digest}.{extension}"
    (artifacts / markdown_name).write_bytes(markdown)
    (artifacts / archive_name).write_bytes(archive)

    index = {
        "$schema": SCHEMA,
        "skills": [
            {
                "name": "code-review",
                "description": "Review changes with a concise security checklist.",
                "type": "skill-md",
                "url": f"artifacts/{markdown_name}",
                "digest": f"sha256:{markdown_digest}",
            },
            {
                "name": "release-notes",
                "description": "Draft release notes from verified project inputs.",
                "type": "archive",
                "url": f"artifacts/{archive_name}",
                "digest": f"sha256:{archive_digest}",
            },
        ],
    }
    (index_root / "index.json").write_text(
        json.dumps(index, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n"
    )


def main() -> None:
    entries = source_entries("release-notes")
    write_format("tar-gzip", "tar.gz", make_tar_gzip(entries))
    write_format("zip", "zip", make_zip(entries))
    print("authored 2 publisher golden formats")


if __name__ == "__main__":
    main()

from __future__ import annotations

import base64
import csv
from datetime import datetime, timezone
import hashlib
from importlib.metadata import distribution
import io
import os
from pathlib import Path, PurePosixPath
import sys
import zipfile


LOCKED_DEPENDENCY_NAME = "uts46"
LOCKED_DEPENDENCY_VERSION = "0.2.0"
ZIP_MINIMUM_EPOCH = 315532800


def source_date_epoch_zip_timestamp() -> tuple[int, int, int, int, int, int] | None:
    source_date_epoch = os.environ.get("SOURCE_DATE_EPOCH")
    if not source_date_epoch:
        return None
    instant = datetime.fromtimestamp(
        max(int(source_date_epoch), ZIP_MINIMUM_EPOCH), timezone.utc
    )
    return (
        instant.year,
        instant.month,
        instant.day,
        instant.hour,
        instant.minute,
        instant.second,
    )


def write_wheel_member(
    archive: zipfile.ZipFile,
    path: str,
    content: bytes,
    timestamp: tuple[int, int, int, int, int, int] | None,
) -> None:
    member: str | zipfile.ZipInfo = path
    if timestamp is not None:
        member = zipfile.ZipInfo(path, date_time=timestamp)
    archive.writestr(member, content, compress_type=zipfile.ZIP_DEFLATED)


def materialize_locked_dependency_wheel(destination: Path) -> Path:
    accepted = distribution(LOCKED_DEPENDENCY_NAME)
    if accepted.version != LOCKED_DEPENDENCY_VERSION:
        raise RuntimeError("synced dependency version does not match the locked package input")
    installed_root = Path(accepted.locate_file(""))
    wheel = destination / (
        f"{LOCKED_DEPENDENCY_NAME}-{LOCKED_DEPENDENCY_VERSION}-py3-none-any.whl"
    )
    record_path = (
        f"{LOCKED_DEPENDENCY_NAME}-{LOCKED_DEPENDENCY_VERSION}.dist-info/RECORD"
    )
    records: list[tuple[str, str, str]] = []
    archived: set[str] = set()
    timestamp = source_date_epoch_zip_timestamp()
    with zipfile.ZipFile(wheel, mode="x", compression=zipfile.ZIP_DEFLATED) as archive:
        for accepted_file in accepted.files or ():
            path = PurePosixPath(str(accepted_file))
            if path.is_absolute() or not path.parts or any(
                part in {"", ".", ".."} for part in path.parts
            ):
                raise RuntimeError("synced dependency exposed an unsafe installed path")
            archived_path = path.as_posix()
            if archived_path == record_path:
                continue
            source = installed_root.joinpath(*path.parts)
            if not source.is_file():
                raise RuntimeError(f"synced dependency file is missing: {archived_path}")
            content = source.read_bytes()
            digest = base64.urlsafe_b64encode(
                hashlib.sha256(content).digest()
            ).rstrip(b"=")
            accepted_hash = accepted_file.hash
            if (
                accepted_hash is None
                or accepted_hash.mode != "sha256"
                or accepted_hash.value != digest.decode("ascii")
            ):
                raise RuntimeError(
                    f"synced dependency file failed RECORD verification: {archived_path}"
                )
            if accepted_file.size != len(content):
                raise RuntimeError(
                    f"synced dependency file has the wrong size: {archived_path}"
                )
            write_wheel_member(archive, archived_path, content, timestamp)
            records.append(
                (
                    archived_path,
                    f"sha256={digest.decode('ascii')}",
                    str(len(content)),
                )
            )
            archived.add(archived_path)
        records.append((record_path, "", ""))
        output = io.StringIO(newline="")
        csv.writer(output, lineterminator="\n").writerows(records)
        write_wheel_member(
            archive, record_path, output.getvalue().encode("utf-8"), timestamp
        )

    required = {
        f"{LOCKED_DEPENDENCY_NAME}-{LOCKED_DEPENDENCY_VERSION}.dist-info/METADATA",
        f"{LOCKED_DEPENDENCY_NAME}-{LOCKED_DEPENDENCY_VERSION}.dist-info/WHEEL",
        f"{LOCKED_DEPENDENCY_NAME}/__init__.py",
    }
    if not required.issubset(archived):
        raise RuntimeError("synced dependency does not contain its required wheel files")
    return wheel


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: materialize-locked-python-dependency.py DESTINATION")
    destination = Path(sys.argv[1]).resolve(strict=True)
    if not destination.is_dir():
        raise SystemExit("locked dependency destination must be a directory")
    print(materialize_locked_dependency_wheel(destination))


if __name__ == "__main__":
    main()

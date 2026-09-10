"""Independently unpack and manually repack deterministic publisher archives."""

from __future__ import annotations

import binascii
import gzip
import hashlib
import json
import stat
import struct
import tarfile
import tempfile
import zlib
import zipfile
from pathlib import Path, PurePosixPath


ROOT = Path(__file__).resolve().parent.parent
EXPECTED = json.loads(
    (ROOT / "expected-results/publisher-results.json").read_text(encoding="utf-8")
)


def octal_field(value: int, width: int) -> bytes:
    return f"{value:0{width - 1}o}\0".encode("ascii")


def tar_header(name: str, size: int) -> bytes:
    encoded_name = name.encode("utf-8")
    assert len(encoded_name) <= 100
    header = bytearray(512)
    header[0 : len(encoded_name)] = encoded_name
    header[100:108] = octal_field(0o644, 8)
    header[108:116] = octal_field(0, 8)
    header[116:124] = octal_field(0, 8)
    header[124:136] = octal_field(size, 12)
    header[136:148] = octal_field(0, 12)
    header[148:156] = b"        "
    header[156:157] = b"0"
    header[257:263] = b"ustar\0"
    header[263:265] = b"00"
    checksum = sum(header)
    header[148:156] = f"{checksum:06o}\0 ".encode("ascii")
    return bytes(header)


def manual_tar_gzip(entries: list[tuple[str, bytes]]) -> bytes:
    raw = bytearray()
    for name, payload in entries:
        raw.extend(tar_header(name, len(payload)))
        raw.extend(payload)
        raw.extend(bytes((-len(payload)) % 512))
    raw.extend(bytes(1024))
    raw.extend(bytes((-len(raw)) % 10240))

    compressor = zlib.compressobj(9, zlib.DEFLATED, -15)
    compressed = compressor.compress(raw) + compressor.flush()
    header = b"\x1f\x8b\x08\x00" + struct.pack("<I", 0) + b"\x02\xff"
    trailer = struct.pack("<II", binascii.crc32(raw) & 0xFFFFFFFF, len(raw) & 0xFFFFFFFF)
    return header + compressed + trailer


def manual_zip(entries: list[tuple[str, bytes]]) -> bytes:
    local = bytearray()
    central = bytearray()
    records = []
    for name, payload in entries:
        encoded_name = name.encode("utf-8")
        checksum = binascii.crc32(payload) & 0xFFFFFFFF
        compressor = zlib.compressobj(9, zlib.DEFLATED, -15)
        compressed = compressor.compress(payload) + compressor.flush()
        offset = len(local)
        local.extend(
            struct.pack(
                "<IHHHHHIIIHH",
                0x04034B50,
                20,
                0,
                8,
                0,
                0x21,
                checksum,
                len(compressed),
                len(payload),
                len(encoded_name),
                0,
            )
        )
        local.extend(encoded_name)
        local.extend(compressed)
        records.append((encoded_name, checksum, compressed, payload, offset))

    for encoded_name, checksum, compressed, payload, offset in records:
        central.extend(
            struct.pack(
                "<IHHHHHHIIIHHHHHII",
                0x02014B50,
                0x0314,
                20,
                0,
                8,
                0,
                0x21,
                checksum,
                len(compressed),
                len(payload),
                len(encoded_name),
                0,
                0,
                0,
                0,
                (stat.S_IFREG | 0o644) << 16,
                offset,
            )
        )
        central.extend(encoded_name)

    end = struct.pack(
        "<IHHHHIIH",
        0x06054B50,
        0,
        0,
        len(records),
        len(records),
        len(central),
        len(local),
        0,
    )
    return bytes(local + central + end)


def safe_target(root: Path, name: str) -> Path:
    pure = PurePosixPath(name)
    assert not pure.is_absolute() and ".." not in pure.parts
    target = root.joinpath(*pure.parts)
    target.parent.mkdir(parents=True, exist_ok=True)
    return target


def unpack_tar(path: Path, destination: Path) -> None:
    with tarfile.open(path, mode="r:gz") as archive:
        for member in archive.getmembers():
            assert member.isfile()
            stream = archive.extractfile(member)
            assert stream is not None
            safe_target(destination, member.name).write_bytes(stream.read())


def unpack_zip(path: Path, destination: Path) -> None:
    with zipfile.ZipFile(path) as archive:
        for member in archive.infolist():
            assert stat.S_ISREG(member.external_attr >> 16)
            safe_target(destination, member.filename).write_bytes(archive.read(member))


def directory_entries(root: Path) -> list[tuple[str, bytes]]:
    return sorted(
        ((path.relative_to(root).as_posix(), path.read_bytes()) for path in root.rglob("*") if path.is_file()),
        key=lambda entry: entry[0].encode("utf-8"),
    )


def validate_tar_metadata(path: Path, expected: dict[str, object]) -> None:
    payload = path.read_bytes()
    assert expected["compression_level"] == 9
    assert struct.unpack_from("<I", payload, 4)[0] == expected["gzip_mtime"]
    assert payload[9] == expected["gzip_os"]
    with tarfile.open(path, mode="r:gz") as archive:
        members = archive.getmembers()
        assert [member.name for member in members] == expected["entry_order"]
        assert expected["directory_entries"] == "omitted"
        assert all(member.isfile() for member in members)
        assert all(member.mode == int(expected["file_mode"], 8) for member in members)
        assert all(member.uid == expected["uid"] for member in members)
        assert all(member.gid == expected["gid"] for member in members)
        assert all(member.uname == expected["owner"] for member in members)
        assert all(member.gname == expected["group"] for member in members)
        assert all(member.mtime == expected["mtime"] for member in members)


def validate_zip_metadata(path: Path, expected: dict[str, object]) -> None:
    date, time = str(expected["timestamp"]).split("T")
    expected_timestamp = tuple(int(part) for part in (*date.split("-"), *time.split(":")))
    assert expected["compression_level"] == 9
    with zipfile.ZipFile(path) as archive:
        members = archive.infolist()
        assert [member.filename for member in members] == expected["entry_order"]
        assert expected["directory_entries"] == "omitted"
        assert all(not member.is_dir() for member in members)
        assert all(member.date_time == expected_timestamp for member in members)
        expected_utf8_flag = 0x0800 if expected["utf8_flag_for_ascii_paths"] else 0
        assert all(member.flag_bits & 0x0800 == expected_utf8_flag for member in members)
        assert all(member.create_system == 3 for member in members)
        assert all((member.external_attr >> 16) == stat.S_IFREG | int(expected["file_mode"], 8) for member in members)
        assert expected["comments"] == expected["extras"] == ""
        assert all(member.extra == member.comment == b"" for member in members)
        assert [member.compress_size for member in members] == [
            file["compressed_size"] for file in expected["files"]
        ]


def main() -> None:
    verified = 0
    canonical_files = 0
    for format_name, encoder, unpacker, validator in [
        ("tar.gz", manual_tar_gzip, unpack_tar, validate_tar_metadata),
        ("zip", manual_zip, unpack_zip, validate_zip_metadata),
    ]:
        format_contract = EXPECTED["formats"][format_name]
        archive_contract = next(
            artifact for artifact in format_contract["artifacts"] if artifact["type"] == "archive"
        )
        path = ROOT / archive_contract["path"]
        validator(path, format_contract["normalized_archive"])
        direct_contract = next(
            artifact for artifact in format_contract["artifacts"] if artifact["type"] == "skill-md"
        )
        direct_source = ROOT / "fixtures/publisher/source/skills/code-review/SKILL.md"
        direct_bytes = (ROOT / direct_contract["path"]).read_bytes()
        assert direct_bytes == direct_source.read_bytes()
        assert len(direct_bytes) == direct_contract["bytes"]
        assert hashlib.sha256(direct_bytes).hexdigest() == direct_contract["sha256"]
        canonical_files += 1
        with tempfile.TemporaryDirectory(prefix="remote-skills-repack-") as temporary:
            unpacked = Path(temporary) / "unpacked"
            unpacked.mkdir()
            unpacker(path, unpacked)
            unpacked_entries = directory_entries(unpacked)
            source_entries = directory_entries(
                ROOT / "fixtures/publisher/source/skills/release-notes"
            )
            assert unpacked_entries == source_entries
            expected_files = format_contract["normalized_archive"]["files"]
            assert [name for name, _ in unpacked_entries] == [item["path"] for item in expected_files]
            for (name, payload), expected_file in zip(
                unpacked_entries, expected_files, strict=True
            ):
                assert name == expected_file["path"]
                assert len(payload) == expected_file["size"]
                assert hashlib.sha256(payload).hexdigest() == expected_file["sha256"]
            canonical_files += len(unpacked_entries)
            repacked = encoder(unpacked_entries)
        assert hashlib.sha256(repacked).hexdigest() == archive_contract["sha256"]
        assert repacked == path.read_bytes()
        verified += 1
    print(
        f"repacked {verified} publisher archives byte-identically; "
        f"verified {canonical_files} canonical source files"
    )


if __name__ == "__main__":
    main()

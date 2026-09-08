"""Independent metadata-only inspection for bounded archive fixtures."""

from __future__ import annotations

import gzip
import json
import stat
import struct
import tarfile
import zipfile
import zlib
from collections import Counter
from pathlib import Path, PurePosixPath
from unicodedata import normalize


ROOT = Path(__file__).resolve().parent.parent
REGISTRY = json.loads((ROOT / "fixtures/archive/archive-cases.json").read_text(encoding="utf-8"))
EXPECTED = {
    case["id"]: case["result"]
    for case in json.loads(
        (ROOT / "expected-results/archive-results.json").read_text(encoding="utf-8")
    )["cases"]
}


def raw_zip_names(payload: bytes) -> list[bytes]:
    names: list[bytes] = []
    cursor = 0
    while True:
        cursor = payload.find(b"PK\x01\x02", cursor)
        if cursor < 0:
            return names
        name_length, extra_length, comment_length = struct.unpack_from("<HHH", payload, cursor + 28)
        name_start = cursor + 46
        names.append(payload[name_start : name_start + name_length])
        cursor = name_start + name_length + extra_length + comment_length


def raw_tar_names(payload: bytes) -> list[bytes]:
    names: list[bytes] = []
    archive = gzip.decompress(payload)
    cursor = 0
    while cursor + 512 <= len(archive):
        header = archive[cursor : cursor + 512]
        if header == bytes(512):
            return names
        name = header[:100].split(b"\0", 1)[0]
        names.append(name)
        size_field = header[124:136].rstrip(b"\0 ") or b"0"
        size = int(size_field, 8)
        cursor += 512 + ((size + 511) // 512) * 512
    raise AssertionError("unterminated tar archive")


def inspect_names(category: str, names: list[str]) -> None:
    if category == "traversal":
        assert any(".." in PurePosixPath(name).parts for name in names)
    elif category == "duplicate_path":
        assert any(count > 1 for count in Counter(names).values())
    elif category == "case_collision":
        assert any(count > 1 for count in Counter(name.casefold() for name in names).values())
    elif category == "absolute_path":
        assert any(name.startswith("/") for name in names)
    elif category == "drive_prefixed_path":
        assert any(len(name) >= 3 and name[1:3] == ":/" for name in names)
    elif category == "windows_drive_backslash":
        assert any(len(name) >= 3 and name[1] == ":" and name[2] == "\\" for name in names)
    elif category == "root_backslash":
        assert any(name.startswith("\\") and not name.startswith("\\\\") for name in names)
    elif category == "unc_path":
        assert any(name.startswith("\\\\") for name in names)
    elif category == "mixed_separator_traversal":
        assert any("\\../" in name for name in names)
    elif category == "unicode_normalization_collision":
        assert any(
            count > 1 for count in Counter(normalize("NFC", name).casefold() for name in names).values()
        )
    elif category == "dot_segment":
        assert any("/./" in name or name.startswith("./") for name in names)
    elif category == "dot_dot_segment":
        assert any(".." in PurePosixPath(name).parts for name in names)
    elif category == "missing_root_skill":
        assert "SKILL.md" not in names


def inspect_tar(path: Path, case: dict[str, object]) -> None:
    payload = path.read_bytes()
    category = case["category"]
    raw_names = raw_tar_names(payload)
    if category == "archive_byte_limit":
        assert len(payload) > int(case["limits"]["archive_bytes"])
    if category == "invalid_utf8_path":
        raw = gzip.decompress(payload)
        assert b"bad-\xffame.txt" in raw
        return
    if category == "nul_path":
        raw = gzip.decompress(payload)
        assert b"nul\0path.txt" in raw
        return
    if category == "windows_drive_backslash":
        assert b"C:\\escape.txt" in raw_names
    elif category == "root_backslash":
        assert b"\\escape.txt" in raw_names
    elif category == "unc_path":
        assert b"\\\\server\\share\\escape.txt" in raw_names
    elif category == "mixed_separator_traversal":
        assert b"references\\../escape.txt" in raw_names
    elif category == "unicode_normalization_collision":
        assert "references/caf\u00e9.txt".encode() in raw_names
        assert "references/cafe\u0301.txt".encode() in raw_names
    with tarfile.open(path, mode="r:gz") as archive:
        members = archive.getmembers()
    names = [name.decode("utf-8") for name in raw_names]
    inspect_names(str(category), names)
    if category == "valid":
        assert names == ["SKILL.md", "assets/template.bin", "references/security.md"]
        assert all(member.uid == member.gid == member.mtime == 0 for member in members)
        assert all(member.mode == 0o644 and member.isfile() for member in members)
        assert [member.size for member in members] == [
            file["size"] for file in EXPECTED[case["id"]]["files"]
        ]
    elif category == "symlink":
        assert any(member.issym() for member in members)
    elif category == "hard_link":
        assert any(member.islnk() for member in members)
    elif category == "special_file":
        assert any(member.isfifo() for member in members)
    elif category == "device":
        assert any(member.ischr() for member in members)
    elif category == "non_regular_root_skill":
        assert any(member.name == "SKILL.md" and not member.isfile() for member in members)
    elif category == "count_limit":
        assert len(members) > int(case["limits"]["files"])
    elif category == "size_limit":
        assert max(member.size for member in members) > int(case["limits"]["file_bytes"])
    elif category == "decompression_limit":
        assert sum(member.size for member in members) > int(case["limits"]["extracted_bytes"])
        assert len(payload) < sum(member.size for member in members)


def inspect_zip(path: Path, case: dict[str, object]) -> None:
    payload = path.read_bytes()
    category = case["category"]
    raw_names = raw_zip_names(payload)
    if category == "archive_byte_limit":
        assert len(payload) > int(case["limits"]["archive_bytes"])
    if category in ("invalid_utf8_path", "nul_path"):
        names = raw_zip_names(payload)
        marker = b"bad-\xffame.txt" if category == "invalid_utf8_path" else b"nul\0path.txt"
        assert marker in names
        try:
            zipfile.ZipFile(path).infolist()
        except (UnicodeDecodeError, ValueError):
            return
        if category == "invalid_utf8_path":
            raise AssertionError("invalid UTF-8 ZIP filename was decoded")
        return
    if category == "windows_drive_backslash":
        assert b"C:\\escape.txt" in raw_names
    elif category == "root_backslash":
        assert b"\\escape.txt" in raw_names
    elif category == "unc_path":
        assert b"\\\\server\\share\\escape.txt" in raw_names
    elif category == "mixed_separator_traversal":
        assert b"references\\../escape.txt" in raw_names
    elif category == "unicode_normalization_collision":
        assert "references/caf\u00e9.txt".encode() in raw_names
        assert "references/cafe\u0301.txt".encode() in raw_names
    with zipfile.ZipFile(path) as archive:
        members = archive.infolist()
    names = [name.decode("utf-8") for name in raw_names]
    inspect_names(str(category), names)
    if category == "valid":
        assert names == ["SKILL.md", "assets/template.bin", "references/security.md"]
        assert all(member.date_time == (1980, 1, 1, 0, 0, 0) for member in members)
        assert all(member.extra == member.comment == b"" for member in members)
        assert [member.file_size for member in members] == [
            file["size"] for file in EXPECTED[case["id"]]["files"]
        ]
    elif category == "symlink":
        assert any(stat.S_ISLNK(member.external_attr >> 16) for member in members)
    elif category == "special_file":
        assert any(stat.S_ISFIFO(member.external_attr >> 16) for member in members)
    elif category == "socket":
        assert any(stat.S_ISSOCK(member.external_attr >> 16) for member in members)
    elif category == "non_regular_root_skill":
        assert any(
            member.filename == "SKILL.md" and not stat.S_ISREG(member.external_attr >> 16)
            for member in members
        )
    elif category == "count_limit":
        assert len(members) > int(case["limits"]["files"])
    elif category == "size_limit":
        assert max(member.file_size for member in members) > int(case["limits"]["file_bytes"])
    elif category == "decompression_limit":
        assert sum(member.file_size for member in members) > int(case["limits"]["extracted_bytes"])
        assert len(payload) < sum(member.file_size for member in members)
    elif category == "streamed_size_mismatch":
        member = next(member for member in members if member.filename == "assets/large.bin")
        offset = member.header_offset
        compressed_size = struct.unpack_from("<I", payload, offset + 18)[0]
        name_length, extra_length = struct.unpack_from("<HH", payload, offset + 26)
        data_start = offset + 30 + name_length + extra_length
        expanded = zlib.decompress(payload[data_start : data_start + compressed_size], -15)
        assert member.file_size == 16
        assert len(expanded) == 2048
        assert len(expanded) > int(case["limits"]["file_bytes"])


def main() -> None:
    inspected = 0
    for case in REGISTRY["cases"]:
        path = ROOT / "fixtures/archive" / case["path"]
        assert path.is_file() and path.stat().st_size > 0
        if case.get("format") == "tar.gz":
            inspect_tar(path, case)
        elif case.get("format") == "zip":
            inspect_zip(path, case)
        elif case["artifact_type"] == "skill-md":
            payload = path.read_bytes()
            if case["category"] == "valid":
                payload.decode("utf-8")
                assert len(payload) == EXPECTED[case["id"]]["files"][0]["size"]
            elif case["category"] == "invalid_utf8_content":
                try:
                    payload.decode("utf-8")
                except UnicodeDecodeError:
                    pass
                else:
                    raise AssertionError("invalid UTF-8 skill-md decoded")
            else:
                text = payload.decode("utf-8")
                if case["category"] == "malformed_yaml":
                    assert "name: [fixture-skill" in text
                elif case["category"] == "missing_frontmatter":
                    assert not text.startswith("---\n")
                elif case["id"] == "skill-md-missing-name":
                    assert "\nname:" not in text
                elif case["id"] == "skill-md-missing-description":
                    assert "\ndescription:" not in text
                elif case["category"] == "invalid_name":
                    assert "name: Invalid--Name" in text
                elif case["category"] == "invalid_standard_metadata":
                    assert "metadata:\n  - not\n  - a-map" in text
                else:
                    raise AssertionError(f"uninspected skill-md category: {case['category']}")
        inspected += 1
    print(f"inspected {inspected} archive fixtures")


if __name__ == "__main__":
    main()

"""Author immutable adversarial archive inputs; never imported by production code or tests."""

from __future__ import annotations

import gzip
import io
import stat
import struct
import tarfile
import warnings
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
ARCHIVE_ROOT = ROOT / "fixtures" / "archive"
SKILL = b"---\nname: fixture-skill\ndescription: Exercise archive safety.\n---\n\n# Fixture skill\n"
REFERENCE = b"# Security\n\nTreat fixture content as untrusted data.\n"
BINARY = bytes([0x00, 0x7F, 0x80, 0xFF])


def tar_bytes(
    entries: list[tuple[str, bytes | str, bytes]],
    name_replacement: tuple[bytes, bytes] | None = None,
) -> bytes:
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w", format=tarfile.USTAR_FORMAT) as archive:
        for name, payload, kind in entries:
            info = tarfile.TarInfo(name)
            info.uid = 0
            info.gid = 0
            info.uname = ""
            info.gname = ""
            info.mtime = 0
            info.mode = 0o644
            if kind == b"file":
                assert isinstance(payload, bytes)
                info.size = len(payload)
                archive.addfile(info, io.BytesIO(payload))
            elif kind == b"symlink":
                info.type = tarfile.SYMTYPE
                info.linkname = str(payload)
                info.size = 0
                archive.addfile(info)
            elif kind == b"hardlink":
                info.type = tarfile.LNKTYPE
                info.linkname = str(payload)
                info.size = 0
                archive.addfile(info)
            elif kind == b"fifo":
                info.type = tarfile.FIFOTYPE
                info.size = 0
                archive.addfile(info)
            elif kind == b"device":
                info.type = tarfile.CHRTYPE
                info.devmajor = 1
                info.devminor = 3
                info.size = 0
                archive.addfile(info)
            else:
                raise AssertionError(kind)

    result = bytearray(raw.getvalue())
    if name_replacement:
        old_name, replacement = name_replacement
        assert len(old_name) == len(replacement)
        header = result.find(old_name)
        if header < 0 or header % 512 >= 100:
            raise AssertionError("tar header to patch not found")
        result[header : header + len(old_name)] = replacement
        block = header - (header % 512)
        result[block + 148 : block + 156] = b"        "
        checksum = sum(result[block : block + 512])
        result[block + 148 : block + 156] = f"{checksum:06o}\0 ".encode("ascii")

    output = io.BytesIO()
    with gzip.GzipFile(fileobj=output, mode="wb", filename="", compresslevel=9, mtime=0) as compressed:
        compressed.write(result)
    return output.getvalue()


def zip_info(name: str, mode: int = stat.S_IFREG | 0o644) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
    info.create_system = 3
    info.compress_type = zipfile.ZIP_DEFLATED
    info.external_attr = mode << 16
    info.extra = b""
    info.comment = b""
    return info


def zip_bytes(
    entries: list[tuple[str, bytes, int]],
    name_replacement: tuple[bytes, bytes] | None = None,
    streamed_mismatch_name: str | None = None,
) -> bytes:
    raw = io.BytesIO()
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", UserWarning)
        with zipfile.ZipFile(raw, mode="w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            archive.comment = b""
            for name, payload, mode in entries:
                archive.writestr(zip_info(name, mode), payload, compresslevel=9)

    result = bytearray(raw.getvalue())
    if name_replacement:
        old_name, replacement = name_replacement
        assert len(old_name) == len(replacement)
        cursor = 0
        replacements = 0
        while True:
            offset = result.find(old_name, cursor)
            if offset < 0:
                break
            result[offset : offset + len(old_name)] = replacement
            signature = bytes(result[offset - 30 : offset - 26])
            if signature == b"PK\x03\x04":
                flags_offset = offset - 24
            else:
                signature = bytes(result[offset - 46 : offset - 42])
                if signature != b"PK\x01\x02":
                    raise AssertionError("ZIP filename record not found")
                flags_offset = offset - 38
            flags = struct.unpack_from("<H", result, flags_offset)[0] | 0x0800
            struct.pack_into("<H", result, flags_offset, flags)
            replacements += 1
            cursor = offset + len(replacement)
        if replacements != 2:
            raise AssertionError(f"expected two ZIP filename records, got {replacements}")
    if streamed_mismatch_name:
        encoded_name = streamed_mismatch_name.encode("ascii")
        cursor = 0
        patches = 0
        while True:
            offset = result.find(encoded_name, cursor)
            if offset < 0:
                break
            if bytes(result[offset - 30 : offset - 26]) == b"PK\x03\x04":
                struct.pack_into("<I", result, offset - 8, 16)
            elif bytes(result[offset - 46 : offset - 42]) == b"PK\x01\x02":
                struct.pack_into("<I", result, offset - 22, 16)
            else:
                raise AssertionError("ZIP size record not found")
            patches += 1
            cursor = offset + len(encoded_name)
        if patches != 2:
            raise AssertionError(f"expected two ZIP size records, got {patches}")
    return bytes(result)


def file_entries(*extra: tuple[str, bytes | str, bytes]) -> list[tuple[str, bytes | str, bytes]]:
    return [("SKILL.md", SKILL, b"file"), *extra]


def zip_entries(*extra: tuple[str, bytes, int]) -> list[tuple[str, bytes, int]]:
    return [("SKILL.md", SKILL, stat.S_IFREG | 0o644), *extra]


def write(path: str, payload: bytes) -> None:
    target = ARCHIVE_ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(payload)


def main() -> None:
    write("skill-md/valid.md", SKILL)
    write("skill-md/invalid-utf8.md", SKILL + b"\n" + bytes([0xFF, 0xFE]))
    write(
        "skill-md/malformed-yaml.md",
        b"---\nname: [fixture-skill\ndescription: Malformed YAML fixture.\n---\n# Malformed YAML\n",
    )
    write(
        "skill-md/missing-frontmatter.md",
        b"# Missing frontmatter\n\nThis file intentionally has no YAML frontmatter.\n",
    )
    write(
        "skill-md/missing-name.md",
        b"---\ndescription: Missing required name.\n---\n# Missing name\n",
    )
    write(
        "skill-md/missing-description.md",
        b"---\nname: fixture-skill\n---\n# Missing description\n",
    )
    write(
        "skill-md/invalid-name.md",
        b"---\nname: Invalid--Name\ndescription: Invalid canonical skill name.\n---\n# Invalid name\n",
    )
    write(
        "skill-md/invalid-metadata.md",
        b"---\nname: fixture-skill\ndescription: Invalid standard metadata.\nmetadata:\n  - not\n  - a-map\n---\n# Invalid metadata\n",
    )

    tar_cases = {
        "valid.tar.gz": file_entries(
            ("assets/template.bin", BINARY, b"file"),
            ("references/security.md", REFERENCE, b"file"),
        ),
        "traversal.tar.gz": file_entries(("../escape.txt", b"escape", b"file")),
        "duplicate.tar.gz": file_entries(
            ("references/dup.txt", b"first", b"file"),
            ("references/dup.txt", b"second", b"file"),
        ),
        "case-collision.tar.gz": file_entries(
            ("README.md", b"upper", b"file"),
            ("readme.md", b"lower", b"file"),
        ),
        "symlink.tar.gz": file_entries(("references/link", "../SKILL.md", b"symlink")),
        "hardlink.tar.gz": file_entries(("references/link", "SKILL.md", b"hardlink")),
        "fifo.tar.gz": file_entries(("scripts/pipe", b"", b"fifo")),
        "invalid-utf8-path.tar.gz": file_entries(("bad-name.txt", b"bad", b"file")),
        "decompression-limit.tar.gz": file_entries(("assets/zeros.bin", bytes(32768), b"file")),
        "count-limit.tar.gz": file_entries(
            ("one.txt", b"1", b"file"),
            ("two.txt", b"2", b"file"),
            ("three.txt", b"3", b"file"),
        ),
        "size-limit.tar.gz": file_entries(("assets/large.bin", b"x" * 2048, b"file")),
        "absolute-path.tar.gz": file_entries(("/absolute.txt", b"absolute", b"file")),
        "drive-prefix.tar.gz": file_entries(("C:/escape.txt", b"drive", b"file")),
        "windows-drive-backslash.tar.gz": file_entries(
            (r"C:\escape.txt", b"drive-backslash", b"file")
        ),
        "root-backslash.tar.gz": file_entries((r"\escape.txt", b"root-backslash", b"file")),
        "unc-path.tar.gz": file_entries(
            (r"\\server\share\escape.txt", b"unc", b"file")
        ),
        "mixed-separator-traversal.tar.gz": file_entries(
            (r"references\../escape.txt", b"mixed", b"file")
        ),
        "unicode-normalization-collision.tar.gz": file_entries(
            ("references/caf\u00e9.txt", b"composed", b"file"),
            ("references/cafe\u0301.txt", b"decomposed", b"file"),
        ),
        "nul-path.tar.gz": file_entries(("nulXpath.txt", b"nul", b"file")),
        "dot-segment.tar.gz": file_entries(("references/./dot.txt", b"dot", b"file")),
        "dot-dot-segment.tar.gz": file_entries(("references/../safe.txt", b"dot-dot", b"file")),
        "missing-skill.tar.gz": [("references/only.md", REFERENCE, b"file")],
        "nonregular-skill.tar.gz": [("SKILL.md", b"", b"fifo")],
        "device.tar.gz": file_entries(("devices/null", b"", b"device")),
        "download-limit.tar.gz": file_entries(("references/security.md", REFERENCE, b"file")),
    }
    for name, entries in tar_cases.items():
        replacement = None
        if name.startswith("invalid-utf8"):
            replacement = (b"bad-name.txt", b"bad-\xffame.txt")
        elif name.startswith("nul-path"):
            replacement = (b"nulXpath.txt", b"nul\0path.txt")
        write(f"tar-gzip/{name}", tar_bytes(entries, name_replacement=replacement))

    regular = stat.S_IFREG | 0o644
    zip_cases = {
        "valid.zip": zip_entries(
            ("assets/template.bin", BINARY, regular),
            ("references/security.md", REFERENCE, regular),
        ),
        "traversal.zip": zip_entries(("../escape.txt", b"escape", regular)),
        "duplicate.zip": zip_entries(
            ("references/dup.txt", b"first", regular),
            ("references/dup.txt", b"second", regular),
        ),
        "case-collision.zip": zip_entries(
            ("README.md", b"upper", regular),
            ("readme.md", b"lower", regular),
        ),
        "symlink.zip": zip_entries(("references/link", b"../SKILL.md", stat.S_IFLNK | 0o777)),
        "fifo.zip": zip_entries(("scripts/pipe", b"", stat.S_IFIFO | 0o644)),
        "invalid-utf8-path.zip": zip_entries(("bad-name.txt", b"bad", regular)),
        "decompression-limit.zip": zip_entries(("assets/zeros.bin", bytes(32768), regular)),
        "count-limit.zip": zip_entries(
            ("one.txt", b"1", regular),
            ("two.txt", b"2", regular),
            ("three.txt", b"3", regular),
        ),
        "size-limit.zip": zip_entries(("assets/large.bin", b"x" * 2048, regular)),
        "absolute-path.zip": zip_entries(("/absolute.txt", b"absolute", regular)),
        "drive-prefix.zip": zip_entries(("C:/escape.txt", b"drive", regular)),
        "windows-drive-backslash.zip": zip_entries(
            (r"C:\escape.txt", b"drive-backslash", regular)
        ),
        "root-backslash.zip": zip_entries((r"\escape.txt", b"root-backslash", regular)),
        "unc-path.zip": zip_entries((r"\\server\share\escape.txt", b"unc", regular)),
        "mixed-separator-traversal.zip": zip_entries(
            (r"references\../escape.txt", b"mixed", regular)
        ),
        "unicode-normalization-collision.zip": zip_entries(
            ("references/caf\u00e9.txt", b"composed", regular),
            ("references/cafe\u0301.txt", b"decomposed", regular),
        ),
        "nul-path.zip": zip_entries(("nulXpath.txt", b"nul", regular)),
        "dot-segment.zip": zip_entries(("references/./dot.txt", b"dot", regular)),
        "dot-dot-segment.zip": zip_entries(("references/../safe.txt", b"dot-dot", regular)),
        "missing-skill.zip": [("references/only.md", REFERENCE, regular)],
        "nonregular-skill.zip": [("SKILL.md", b"target", stat.S_IFLNK | 0o777)],
        "socket.zip": zip_entries(("sockets/fixture.sock", b"", stat.S_IFSOCK | 0o644)),
        "download-limit.zip": zip_entries(("references/security.md", REFERENCE, regular)),
        "streamed-size-mismatch.zip": zip_entries(("assets/large.bin", b"x" * 2048, regular)),
    }
    for name, entries in zip_cases.items():
        replacement = None
        if name.startswith("invalid-utf8"):
            replacement = (b"bad-name.txt", b"bad-\xffame.txt")
        elif name.startswith("nul-path"):
            replacement = (b"nulXpath.txt", b"nul\0path.txt")
        write(
            f"zip/{name}",
            zip_bytes(
                entries,
                name_replacement=replacement,
                streamed_mismatch_name=(
                    "assets/large.bin" if name.startswith("streamed-size-mismatch") else None
                ),
            ),
        )

    print(f"authored {8 + len(tar_cases) + len(zip_cases)} archive fixtures")


if __name__ == "__main__":
    main()

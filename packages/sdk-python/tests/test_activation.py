from __future__ import annotations

import asyncio
from dataclasses import replace
import hashlib
import io
import json
from pathlib import Path
import stat
import tarfile
import tempfile
import traceback
from types import MappingProxyType
import unittest
from unittest.mock import patch
import zipfile
import zlib

from remote_skills.activation import (
    ActivatedSkill,
    ActivationLimits,
    ActivationPin,
    activate_artifact_bytes,
    activate_selected,
    verify_cached_archive,
)
from remote_skills.archive import (
    _next_tar_cursor,
    _tar_size,
    extract_tar_gzip,
    media_type_for_path,
)
from remote_skills.cache import MemoryCache
from remote_skills.catalog import (
    CatalogEntry,
    CatalogRelease,
    CatalogSnapshot,
    SelectedCatalogRelease,
    select_catalog_release,
)
from remote_skills.catalog_errors import CatalogError
from remote_skills.catalog_network import HttpResponse
from remote_skills.catalog_origin import Origin
from remote_skills.protocol_adapter import run_protocol_case


PROTOCOL_ROOT = Path(__file__).parents[3] / "tests" / "protocol"


def read_json(relative: str) -> dict[str, object]:
    with (PROTOCOL_ROOT / relative).open(encoding="utf-8") as handle:
        value = json.load(handle)
    if not isinstance(value, dict):
        raise TypeError("fixture document must be an object")
    return value


def selected_for(payload: bytes, *, artifact_type: str, url: str) -> SelectedCatalogRelease:
    return SelectedCatalogRelease(
        origin_alias="fixture",
        skill_name="fixture-skill",
        description="Exercise archive safety.",
        artifact_type=artifact_type,
        url=url,
        digest=f"sha256:{hashlib.sha256(payload).hexdigest()}",
        version="1.4.7",
        stale=False,
    )


def archive_with_files(
    archive_format: str, entries: list[tuple[str, bytes]]
) -> bytes:
    output = io.BytesIO()
    if archive_format == "tar.gz":
        with tarfile.open(fileobj=output, mode="w:gz") as archive:
            for path, content in entries:
                member = tarfile.TarInfo(path)
                member.mode = 0o644
                member.size = len(content)
                archive.addfile(member, io.BytesIO(content))
    elif archive_format == "zip":
        with zipfile.ZipFile(
            output, mode="w", compression=zipfile.ZIP_DEFLATED
        ) as archive:
            for path, content in entries:
                member = zipfile.ZipInfo(path)
                member.create_system = 3
                member.external_attr = (stat.S_IFREG | 0o644) << 16
                archive.writestr(member, content)
    else:  # pragma: no cover - helper contract
        raise ValueError(archive_format)
    return output.getvalue()


class PayloadTransport:
    def __init__(self, payload: bytes, content_type: str) -> None:
        self.payload = payload
        self.content_type = content_type
        self.calls = 0

    async def request(
        self,
        url: str,
        headers: dict[str, str],
        timeout: float,
        connect_address: str,
        max_bytes: int,
    ) -> HttpResponse:
        self.calls += 1
        return HttpResponse(200, {"content-type": self.content_type}, self.payload)


async def fixture_resolver(_host: str) -> tuple[str, ...]:
    return ("93.184.216.34",)


class TarCursorGuardTests(unittest.TestCase):
    def test_size_field_accepts_ordinary_octal_and_blank_zero(self) -> None:
        for field, expected in (
            (b"00000000000\0", 0),
            (b"00000001000\0", 512),
            (b"        777 ", 511),
            (b"777777777777", 0o777777777777),
            (b"\0" * 12, 0),
            (b" " * 12, 0),
        ):
            with self.subTest(field=field):
                self.assertEqual(_tar_size(field), expected)

    def test_size_field_rejects_unsupported_grammar(self) -> None:
        for field in (
            b"-1", b"+1", b"1_0", b"8", b"0o7", b"1\0 2", b"\t7", b"\x807",
        ):
            with self.subTest(field=field):
                with self.assertRaises(CatalogError) as raised:
                    _tar_size(field.ljust(12, b"\0"))
                self.assertEqual(raised.exception.code, "archive_unsafe")
                self.assertEqual(raised.exception.context, {})
                self.assertFalse(raised.exception.retryable)

    def test_size_field_requires_fixed_width(self) -> None:
        for field in (b"", b"0" * 11, b"0" * 13):
            with self.subTest(width=len(field)):
                with self.assertRaises(CatalogError):
                    _tar_size(field)

    def test_cursor_advances_over_header_and_complete_payload_blocks(self) -> None:
        for cursor, size, length, expected in (
            (0, 0, 512, 512),
            (512, 0, 1024, 1024),
            (0, 1, 1024, 1024),
            (0, 511, 1024, 1024),
            (0, 512, 1024, 1024),
            (512, 513, 2048, 2048),
        ):
            with self.subTest(cursor=cursor, size=size):
                actual = _next_tar_cursor(cursor, size, length)
                self.assertEqual(actual, expected)
                self.assertGreater(actual, cursor)
                self.assertLessEqual(actual, length)

    def test_cursor_rejects_negative_sizes_and_invalid_framing(self) -> None:
        for cursor, size, length in (
            (0, -1, 1024),
            (-512, 0, 1024),
            (1, 0, 1024),
            (512, 0, 512),
            (0, 1, 512),
            (0, 513, 1024),
            (0, 0, 513),
            (0, 0, -512),
            (0, 10**100, 1024),
        ):
            with self.subTest(cursor=cursor, size=size, length=length):
                with self.assertRaises(CatalogError) as raised:
                    _next_tar_cursor(cursor, size, length)
                self.assertEqual(raised.exception.code, "archive_unsafe")
                self.assertEqual(raised.exception.context, {})

    def test_ordinary_tar_keeps_zero_size_regular_resources(self) -> None:
        entries = [("SKILL.md", b"Ordinary instructions."), ("empty.txt", b"")]
        payload = archive_with_files("tar.gz", entries)
        self.assertEqual(
            extract_tar_gzip(payload, extracted_bytes=1024, files=2, file_bytes=1024),
            dict(entries),
        )


class GzipErrorBoundaryTests(unittest.TestCase):
    def test_decompressor_error_is_terminal_and_sanitized(self) -> None:
        entries = [("SKILL.md", b"Ordinary instructions.")]
        payload = archive_with_files("tar.gz", entries)
        marker = "synthetic decompressor detail"
        with patch(
            "remote_skills.archive.gzip.GzipFile.read",
            side_effect=zlib.error(marker),
        ):
            with self.assertRaises(CatalogError) as raised:
                extract_tar_gzip(
                    payload, extracted_bytes=1024, files=1, file_bytes=1024
                )

        error = raised.exception
        self.assertEqual(error.code, "archive_unsafe")
        self.assertFalse(error.retryable)
        self.assertEqual(error.context, {})
        self.assertIsNone(error.__cause__)
        self.assertTrue(error.__suppress_context__)
        self.assertNotIn(marker, str(error))
        self.assertNotIn(marker, repr(error))
        self.assertNotIn(marker, "".join(traceback.format_exception(error)))
        self.assertEqual(
            extract_tar_gzip(payload, extracted_bytes=1024, files=1, file_bytes=1024),
            dict(entries),
        )


class SharedActivationFixtureTests(unittest.TestCase):
    def test_resource_media_types_match_the_shared_consumer_mapping(self) -> None:
        expected = {
            "md": "text/markdown",
            "txt": "text/plain",
            "json": "application/json",
            "yaml": "application/yaml",
            "yml": "application/yaml",
            "html": "text/html",
            "css": "text/css",
            "js": "text/javascript",
            "mjs": "text/javascript",
            "ts": "text/typescript",
            "svg": "image/svg+xml",
            "png": "image/png",
            "jpg": "image/jpeg",
            "jpeg": "image/jpeg",
            "gif": "image/gif",
            "pdf": "application/pdf",
        }
        for extension, media_type in expected.items():
            for path in (f"assets/file.{extension}", f"assets/file.{extension.upper()}"):
                with self.subTest(path=path):
                    self.assertEqual(media_type_for_path(path), media_type)
        for path in (
            "assets/no-extension",
            "assets/file.bin",
            "assets/.png",
            "assets/.md",
            "assets.png/file",
        ):
            with self.subTest(path=path):
                self.assertEqual(media_type_for_path(path), "application/octet-stream")
        self.assertEqual(media_type_for_path("assets/..png"), "image/png")

    def test_zip_diagnostics_preserve_raw_backslashes_normalized_by_the_platform(self) -> None:
        payload = (
            PROTOCOL_ROOT / "fixtures/archive/zip/windows-drive-backslash.zip"
        ).read_bytes()
        selected = selected_for(
            payload,
            artifact_type="archive",
            url="https://skills.example.test/fixture.zip",
        )
        original = zipfile.ZipFile.infolist

        def platform_normalized(archive: zipfile.ZipFile) -> list[zipfile.ZipInfo]:
            members = original(archive)
            for member in members:
                member.filename = member.filename.replace("\\", "/")
            return members

        with patch.object(zipfile.ZipFile, "infolist", platform_normalized):
            with self.assertRaises(CatalogError) as raised:
                activate_artifact_bytes(selected, payload)

        self.assertEqual(raised.exception.code, "archive_unsafe")
        self.assertEqual(raised.exception.context, {"path": "C:\\escape.txt"})

    def test_every_shared_archive_case_matches_the_static_result(self) -> None:
        registry = read_json("fixtures/archive/archive-cases.json")
        expected = read_json("expected-results/archive-results.json")
        cases = registry["cases"]
        expected_cases = expected["cases"]
        self.assertIsInstance(cases, list)
        self.assertIsInstance(expected_cases, list)
        self.assertEqual(len(cases), len(expected_cases))
        for fixture, wanted in zip(cases, expected_cases, strict=True):
            with self.subTest(case=fixture["id"]):
                actual = run_protocol_case(
                    {
                        "contract_version": registry["contract_version"],
                        "suite": "archive",
                        "id": fixture["id"],
                        "fixture": fixture,
                        "protocol_root": str(PROTOCOL_ROOT),
                    }
                )
                self.assertEqual(actual, wanted["result"])

    def test_publisher_artifacts_match_shared_activation_results(self) -> None:
        registry = read_json("fixtures/publisher/consumer-cases.json")
        expected = read_json("expected-results/publisher-activation-results.json")
        for fixture, wanted in zip(registry["cases"], expected["cases"], strict=True):
            with self.subTest(case=fixture["id"]):
                actual = run_protocol_case(
                    {
                        "contract_version": registry["contract_version"],
                        "suite": "publisher_activation",
                        "id": fixture["id"],
                        "fixture": fixture,
                        "protocol_root": str(PROTOCOL_ROOT),
                    }
                )
                self.assertEqual(actual, wanted["result"])

    def test_authorized_range_activation_matches_the_scope_version_pin(self) -> None:
        registry = read_json("fixtures/network/scope-version-network-cases.json")
        expected = read_json("expected-results/scope-version-network-results.json")
        fixture = next(
            item for item in registry["cases"] if item["id"] == "authorized-range-activation"
        )
        wanted = next(
            item for item in expected["cases"] if item["id"] == fixture["id"]
        )
        actual = run_protocol_case(
            {
                "contract_version": registry["contract_version"],
                "suite": "network",
                "id": fixture["id"],
                "fixture": fixture,
                "protocol_root": str(PROTOCOL_ROOT),
            }
        )
        self.assertEqual(actual, wanted["result"])

    def test_digest_mismatch_is_terminal_and_never_published(self) -> None:
        registry = read_json("fixtures/network/network-cases.json")
        expected = read_json("expected-results/network-results.json")
        fixture = next(
            item for item in registry["cases"] if item["id"] == "retry-digest-mismatch"
        )
        wanted = next(
            item for item in expected["cases"] if item["id"] == fixture["id"]
        )
        actual = run_protocol_case(
            {
                "contract_version": registry["contract_version"],
                "suite": "network",
                "id": fixture["id"],
                "fixture": fixture,
                "protocol_root": str(PROTOCOL_ROOT),
            }
        )
        self.assertEqual(actual, wanted["result"])


class RetainedReleaseActivationTests(unittest.IsolatedAsyncioTestCase):
    async def test_each_release_keeps_its_description_on_cold_and_warm_activation(self) -> None:
        for artifact_type in ("skill-md", "archive"):
            releases: list[CatalogRelease] = []
            payloads: dict[str, bytes] = {}
            for version in ("1.0.0", "2.0.0"):
                markdown = (
                    f"---\nname: fixture-skill\ndescription: Release {version}.\n"
                    f"metadata:\n  version: {version}\n---\nInstructions for {version}.\n"
                ).encode()
                payload = (
                    markdown
                    if artifact_type == "skill-md"
                    else archive_with_files("zip", [("SKILL.md", markdown)])
                )
                suffix = "md" if artifact_type == "skill-md" else "zip"
                releases.append(
                    CatalogRelease(
                        version=version,
                        artifact_type=artifact_type,
                        url=f"https://skills.example.test/{version}.{suffix}",
                        digest=f"sha256:{hashlib.sha256(payload).hexdigest()}",
                    )
                )
                payloads[version] = payload

            def snapshot(current: CatalogRelease) -> CatalogSnapshot:
                return CatalogSnapshot(
                    origin_alias="fixture",
                    entries=(
                        CatalogEntry(
                            origin_alias="fixture",
                            name="fixture-skill",
                            description=f"Release {current.version}.",
                            artifact_type=current.artifact_type,
                            url=current.url,
                            digest=current.digest,
                            version=current.version,
                            releases=tuple(reversed(releases)),
                        ),
                    ),
                )

            for current in releases:
                for release in releases:
                    for warm in (False, True):
                        with self.subTest(
                            artifact_type=artifact_type,
                            current=current.version,
                            selected=release.version,
                            warm=warm,
                        ):
                            cache = MemoryCache(archive_verifier=verify_cached_archive)
                            transport = PayloadTransport(
                                payloads[release.version],
                                "text/markdown"
                                if artifact_type == "skill-md"
                                else "application/zip",
                            )

                            async def activate(view: CatalogSnapshot) -> ActivatedSkill:
                                return await activate_selected(
                                    select_catalog_release(
                                        view,
                                        skill_name="fixture-skill",
                                        requested_range=release.version,
                                    ),
                                    origin=Origin(url="https://skills.example.test"),
                                    transport=transport,
                                    resolver=fixture_resolver,
                                    cache=cache,
                                )

                            if warm:
                                seeded = await activate(snapshot(release))
                                await seeded._release_pin()
                            skill = await activate(snapshot(current))
                            try:
                                self.assertEqual(skill.description, f"Release {release.version}.")
                                self.assertEqual(skill.frontmatter["description"], skill.description)
                                self.assertEqual(skill.frontmatter["metadata"], {"version": release.version})
                                self.assertEqual(skill.instructions, f"Instructions for {release.version}.\n")
                                self.assertEqual(skill.version, release.version)
                                self.assertEqual(skill.digest, release.digest)
                                self.assertEqual(skill.url, release.url)
                                self.assertEqual(transport.calls, 1)
                            finally:
                                await skill._release_pin()

    async def test_current_description_mismatch_still_rejects_cold_and_warm(self) -> None:
        payload = b"---\nname: fixture-skill\ndescription: Exercise archive safety.\n---\n"
        selected = selected_for(
            payload,
            artifact_type="skill-md",
            url="https://skills.example.test/fixture.md",
        )
        for warm in (False, True):
            with self.subTest(warm=warm):
                cache = MemoryCache()
                transport = PayloadTransport(payload, "text/markdown")
                async def activate(selection: SelectedCatalogRelease) -> ActivatedSkill:
                    return await activate_selected(
                        selection,
                        origin=Origin(url="https://skills.example.test"),
                        transport=transport,
                        resolver=fixture_resolver,
                        cache=cache,
                    )

                if warm:
                    seeded = await activate(selected)
                    await seeded._release_pin()
                with self.assertRaises(CatalogError) as raised:
                    await activate(replace(selected, description="Updated description."))
                self.assertEqual(raised.exception.code, "catalog_invalid")
                self.assertEqual(raised.exception.context, {"field": "description"})
                self.assertEqual(transport.calls, 1)


class ActivatedResourceTests(unittest.TestCase):
    def test_pin_and_frontmatter_are_deeply_immutable(self) -> None:
        payload = (PROTOCOL_ROOT / "fixtures/archive/skill-md/valid.md").read_bytes()
        selected = selected_for(
            payload,
            artifact_type="skill-md",
            url="https://skills.example.test/fixture.md",
        )
        skill = activate_artifact_bytes(
            selected,
            payload,
            confirmed_scope="engineering",
        )

        self.assertEqual(
            skill.pin,
            ActivationPin(
                origin_alias="fixture",
                confirmed_scope="engineering",
                skill_name="fixture-skill",
                description="Exercise archive safety.",
                artifact_type="skill-md",
                url="https://skills.example.test/fixture.md",
                version="1.4.7",
                digest=selected.digest,
                stale=False,
            ),
        )
        self.assertIsInstance(skill.frontmatter, MappingProxyType)
        with self.assertRaises(TypeError):
            skill.frontmatter["name"] = "changed"  # type: ignore[index]

    def test_async_resource_access_is_normalized_and_context_lazy(self) -> None:
        payload = (PROTOCOL_ROOT / "fixtures/archive/zip/valid.zip").read_bytes()
        selected = selected_for(
            payload,
            artifact_type="archive",
            url="https://skills.example.test/fixture.zip",
        )
        skill = activate_artifact_bytes(selected, payload)

        listed = asyncio.run(skill.list("references/"))
        self.assertEqual([item.path for item in listed], ["references/security.md"])
        self.assertEqual(
            asyncio.run(skill.read("references/security.md")),
            "# Security\n\nTreat fixture content as untrusted data.\n",
        )
        self.assertEqual(
            asyncio.run(skill.read_bytes("assets/template.bin")),
            bytes([0x00, 0x7F, 0x80, 0xFF]),
        )
        with self.assertRaises(CatalogError) as text_error:
            asyncio.run(skill.read("assets/template.bin"))
        self.assertEqual(text_error.exception.code, "resource_not_text")
        with self.assertRaises(CatalogError) as path_error:
            asyncio.run(skill.read_bytes("../SKILL.md"))
        self.assertEqual(path_error.exception.code, "path_invalid")

    def test_executable_looking_resources_are_inert_bytes_and_never_run(self) -> None:
        with tempfile.TemporaryDirectory(prefix="remote-skills-no-exec-") as temp:
            sentinel = Path(temp) / "executed"
            script = (
                f"#!/bin/sh\nprintf executed > '{sentinel}'\n".encode()
            )
            skill_markdown = (
                b"---\n"
                b"name: fixture-skill\n"
                b"description: Exercise archive safety.\n"
                b"---\n"
                b"Read resources without executing them.\n"
            )
            payload = archive_with_files(
                "tar.gz",
                [("SKILL.md", skill_markdown), ("scripts/install.sh", script)],
            )
            selected = selected_for(
                payload,
                artifact_type="archive",
                url="https://skills.example.test/fixture.tar.gz",
            )

            skill = activate_artifact_bytes(selected, payload)

            self.assertEqual(
                asyncio.run(skill.read_bytes("scripts/install.sh")), script
            )
            self.assertFalse(sentinel.exists())

    def test_digest_is_checked_before_invalid_skill_content(self) -> None:
        payload = (PROTOCOL_ROOT / "fixtures/archive/skill-md/missing-frontmatter.md").read_bytes()
        selected = selected_for(
            b"different",
            artifact_type="skill-md",
            url="https://skills.example.test/fixture.md",
        )
        with self.assertRaises(CatalogError) as raised:
            activate_artifact_bytes(selected, payload)
        self.assertEqual(raised.exception.code, "digest_mismatch")

    def test_standard_frontmatter_accepts_quoted_and_block_string_forms(self) -> None:
        payload = (
            b"---\n"
            b"'name': fixture-skill\n"
            b'"description": |\n'
            b"  Exercise archive safety.\n"
            b"metadata:\n"
            b"  'fixture-key': \"canonical\"\n"
            b"---\n\n"
            b"# Fixture skill\n"
        )
        selected = SelectedCatalogRelease(
            origin_alias="fixture",
            skill_name="fixture-skill",
            description="Exercise archive safety.\n",
            artifact_type="skill-md",
            url="https://skills.example.test/fixture.md",
            digest=f"sha256:{hashlib.sha256(payload).hexdigest()}",
            version=None,
            stale=False,
        )
        skill = activate_artifact_bytes(selected, payload)
        self.assertEqual(skill.frontmatter["metadata"], {"fixture-key": "canonical"})
        self.assertEqual(skill.instructions, "# Fixture skill\n")

    def test_yaml_core_strings_match_accepted_publisher_forms(self) -> None:
        payload = (
            b"---\n"
            b"name: fixture-skill\n"
            b"description: !!str 0x2A\n"
            b'license: "Apache\\x2D2.0"\n'
            b'compatibility: "line\\nnext"\n'
            b"metadata: { answer: !!str 1_000, enabled: !!str true, "
            b"binary-like: 0b10, grouped: 1_000 }\n"
            b'allowed-tools: "Read\\tWrite"\n'
            b"---\n# Fixture skill\n"
        )
        selected = SelectedCatalogRelease(
            origin_alias="fixture",
            skill_name="fixture-skill",
            description="0x2A",
            artifact_type="skill-md",
            url="https://skills.example.test/fixture.md",
            digest=f"sha256:{hashlib.sha256(payload).hexdigest()}",
            version=None,
            stale=False,
        )

        skill = activate_artifact_bytes(selected, payload)

        self.assertEqual(skill.frontmatter["license"], "Apache-2.0")
        self.assertEqual(skill.frontmatter["compatibility"], "line\nnext")
        self.assertEqual(
            skill.frontmatter["metadata"],
            {
                "answer": "1_000",
                "binary-like": "0b10",
                "enabled": "true",
                "grouped": "1_000",
            },
        )
        self.assertEqual(skill.frontmatter["allowed-tools"], "Read\tWrite")

    def test_yaml_core_multiline_scalar_descriptions(self) -> None:
        cases = (
            ("plain", "Exercise\n  archive safety.", "Exercise archive safety."),
            ("plain-blank", "Exercise\n\n  archive safety.", "Exercise\narchive safety."),
            ("single", "'Exercise\n  archive safety.'", "Exercise archive safety."),
            ("single-blank", "'Exercise\n\n\n  archive safety.'", "Exercise\n\narchive safety."),
            ("single-quote", "'Exercise the author''s\n  archive.'", "Exercise the author's archive."),
            ("double", '"Exercise\n  archive safety."', "Exercise archive safety."),
            ("double-blank", '"Exercise\n\n  archive safety."', "Exercise\narchive safety."),
            ("double-quote", '"Exercise \\"quoted\\"\n  archives."', 'Exercise "quoted" archives.'),
            ("escaped-break", '"Exercise ar\\\n  chive safety."', "Exercise archive safety."),
            ("escaped-blank", '"Exercise\\\n\n  archives."', "Exercise archives."),
            ("escaped-two-blanks", '"Exercise\\\n\n\n  archives."', "Exercise\narchives."),
            ("spacing", '"Exercise  \n    archive safety."', "Exercise archive safety."),
            ("escaped-space", '"Exercise\\ \\\n  archives."', "Exercise archives."),
            ("tagged", "!!str Exercise\n  archive safety.", "Exercise archive safety."),
        )
        for case, source, expected in cases:
            for artifact_type in ("skill-md", "archive"):
                with self.subTest(case=case, artifact_type=artifact_type):
                    markdown = (
                        f"---\nname: fixture-skill\ndescription: {source}\n"
                        "metadata:\n  version: 1.4.7\n---\n# Fixture skill\n"
                    ).encode()
                    payload = (
                        markdown
                        if artifact_type == "skill-md"
                        else archive_with_files("zip", [("SKILL.md", markdown)])
                    )
                    selected = replace(
                        selected_for(
                            payload,
                            artifact_type=artifact_type,
                            url="https://skills.example.test/fixture.zip",
                        ),
                        description=expected,
                    )
                    skill = activate_artifact_bytes(selected, payload)
                    self.assertEqual(skill.description, expected)
                    self.assertEqual(skill.frontmatter["metadata"], {"version": "1.4.7"})
                    self.assertEqual(skill.instructions, "# Fixture skill\n")

    def test_yaml_core_signs_apply_only_to_decimal_numeric_forms(self) -> None:
        for description in (b"-0x2A", b"+0o52"):
            with self.subTest(description=description):
                payload = (
                    b"---\nname: fixture-skill\ndescription: "
                    + description
                    + b"\n---\n"
                )
                selected = SelectedCatalogRelease(
                    origin_alias="fixture",
                    skill_name="fixture-skill",
                    description=description.decode("ascii"),
                    artifact_type="skill-md",
                    url="https://skills.example.test/fixture.md",
                    digest=f"sha256:{hashlib.sha256(payload).hexdigest()}",
                    version=None,
                    stale=False,
                )
                self.assertEqual(
                    activate_artifact_bytes(selected, payload).description,
                    description.decode("ascii"),
                )

    def test_yaml_core_non_strings_and_node_budget_have_stable_errors(self) -> None:
        for description in (
            b"0x2A",
            b"0o52",
            b"!!int 0x2A",
            b"true",
            b"1.25e2",
            b'"escaped \\uD800"',
        ):
            with self.subTest(description=description):
                numeric = (
                    b"---\nname: fixture-skill\ndescription: "
                    + description
                    + b"\n---\n"
                )
                numeric_selection = selected_for(
                    numeric,
                    artifact_type="skill-md",
                    url="https://skills.example.test/numeric.md",
                )
                with self.assertRaises(CatalogError) as numeric_error:
                    activate_artifact_bytes(numeric_selection, numeric)
                self.assertEqual(numeric_error.exception.code, "catalog_invalid")
                self.assertEqual(
                    numeric_error.exception.context,
                    {"field": "description"},
                )

        sequence = b"\n".join([b"  - value"] * 100_001)
        wide = (
            b"---\nname: fixture-skill\n"
            b"description: Exercise archive safety.\nallowed-tools:\n"
            + sequence
            + b"\n---\n"
        )
        wide_selection = selected_for(
            wide,
            artifact_type="skill-md",
            url="https://skills.example.test/wide.md",
        )
        with self.assertRaises(CatalogError) as wide_error:
            activate_artifact_bytes(
                wide_selection,
                wide,
                limits=ActivationLimits(file_bytes=len(wide) + 1),
            )
        self.assertEqual(wide_error.exception.code, "limit_exceeded")
        self.assertEqual(
            wide_error.exception.context,
            {"limit": "frontmatterNodes"},
        )

    def test_archives_reject_implicit_file_directory_ancestor_collisions(self) -> None:
        skill_md = (PROTOCOL_ROOT / "fixtures/archive/skill-md/valid.md").read_bytes()
        for archive_format, suffix in (("tar.gz", "tar.gz"), ("zip", "zip")):
            for entries in (
                [("SKILL.md", skill_md), ("refs", b"file"), ("refs/item.md", b"child")],
                [("SKILL.md", skill_md), ("refs/item.md", b"child"), ("refs", b"file")],
                [
                    ("SKILL.md", skill_md),
                    ("\u00c9", b"file"),
                    ("\u00e9/item.md", b"child"),
                ],
                [
                    ("SKILL.md", skill_md),
                    ("caf\u00e9", b"file"),
                    ("cafe\u0301/item.md", b"child"),
                ],
            ):
                with self.subTest(
                    archive_format=archive_format,
                    paths=[item[0] for item in entries],
                ):
                    payload = archive_with_files(archive_format, entries)
                    selected = selected_for(
                        payload,
                        artifact_type="archive",
                        url=f"https://skills.example.test/fixture.{suffix}",
                    )
                    with self.assertRaises(CatalogError) as raised:
                        activate_artifact_bytes(selected, payload)
                    self.assertEqual(raised.exception.code, "archive_unsafe")

    def test_resource_missing_and_traversal_paths_are_typed(self) -> None:
        payload = (PROTOCOL_ROOT / "fixtures/archive/zip/valid.zip").read_bytes()
        selected = selected_for(
            payload,
            artifact_type="archive",
            url="https://skills.example.test/fixture.zip",
        )
        skill = activate_artifact_bytes(selected, payload)

        operations = (
            ("resource_not_found", lambda: skill.list("missing")),
            ("path_invalid", lambda: skill.list("../missing")),
            ("resource_not_found", lambda: skill.read("missing.md")),
            ("path_invalid", lambda: skill.read("../SKILL.md")),
            ("resource_not_found", lambda: skill.read_bytes("missing.bin")),
            ("path_invalid", lambda: skill.read_bytes("../SKILL.md")),
        )
        for expected, operation in operations:
            with self.subTest(expected=expected, operation=operation):
                with self.assertRaises(CatalogError) as raised:
                    asyncio.run(operation())
                self.assertEqual(raised.exception.code, expected)

    def test_limit_configuration_rejects_non_positive_or_boolean_values(self) -> None:
        for field in ("archive_bytes", "extracted_bytes", "files", "file_bytes"):
            with self.subTest(field=field):
                with self.assertRaises(CatalogError) as raised:
                    ActivationLimits(**{field: 0})
                self.assertEqual(raised.exception.code, "configuration_invalid")
                with self.assertRaises(CatalogError):
                    ActivationLimits(**{field: True})

    def test_network_activation_sends_format_accept_without_scope_and_reuses_cache(self) -> None:
        payload = (PROTOCOL_ROOT / "fixtures/archive/tar-gzip/valid.tar.gz").read_bytes()
        selected = selected_for(
            payload,
            artifact_type="archive",
            url="https://skills.example.test/fixture.tar.gz",
        )

        class Transport:
            def __init__(self) -> None:
                self.requests: list[dict[str, object]] = []

            async def request(
                self,
                url: str,
                headers: dict[str, str],
                timeout: float,
                connect_address: str,
                max_bytes: int,
            ) -> HttpResponse:
                self.requests.append(
                    {"url": url, "headers": dict(headers), "max_bytes": max_bytes}
                )
                return HttpResponse(200, {"content-type": "application/gzip"}, payload)

        async def resolver(_host: str) -> tuple[str, ...]:
            return ("93.184.216.34",)

        transport = Transport()
        cache = MemoryCache(archive_verifier=verify_cached_archive)
        origin = Origin(
            url="https://skills.example.test",
            scope="engineering",
            headers={"authorization": "runtime-only"},
            retries=0,
        )
        first = asyncio.run(
            activate_selected(
                selected,
                origin=origin,
                confirmed_scope="engineering",
                cache=cache,
                transport=transport,
                resolver=resolver,
                process_nonce="test-process",
                session_nonce="first-session",
            )
        )
        self.assertEqual(len(transport.requests), 1)
        self.assertEqual(transport.requests[0]["headers"]["accept"], "application/gzip")
        self.assertNotIn("remote-skills-scope", transport.requests[0]["headers"])
        self.assertEqual(transport.requests[0]["max_bytes"], 52_428_800)
        asyncio.run(first._release_pin())

        second = asyncio.run(
            activate_selected(
                selected,
                origin=origin,
                confirmed_scope="engineering",
                cache=cache,
                transport=transport,
                resolver=resolver,
                process_nonce="test-process",
                session_nonce="second-session",
            )
        )
        self.assertEqual(len(transport.requests), 1)
        self.assertEqual(second.digest, first.digest)
        asyncio.run(second._release_pin())

    def test_cache_hits_reapply_every_current_activation_limit(self) -> None:
        payload = (PROTOCOL_ROOT / "fixtures/archive/zip/valid.zip").read_bytes()
        selected = selected_for(
            payload,
            artifact_type="archive",
            url="https://skills.example.test/fixture.zip",
        )

        transport = PayloadTransport(payload, "application/zip")
        cache = MemoryCache(archive_verifier=verify_cached_archive)
        origin = Origin(url="https://skills.example.test", retries=0)
        initial = asyncio.run(
            activate_selected(
                selected,
                origin=origin,
                transport=transport,
                resolver=fixture_resolver,
                cache=cache,
                process_nonce="test-process",
                session_nonce="initial",
            )
        )
        asyncio.run(initial._release_pin())
        limits = (
            ("archive_bytes", ActivationLimits(archive_bytes=len(payload) - 1)),
            ("files", ActivationLimits(files=2)),
            ("file_bytes", ActivationLimits(file_bytes=3)),
            ("extracted_bytes", ActivationLimits(extracted_bytes=4)),
        )
        for expected, selected_limits in limits:
            with self.subTest(limit=expected):
                with self.assertRaises(CatalogError) as raised:
                    asyncio.run(
                        activate_selected(
                            selected,
                            origin=origin,
                            transport=transport,
                            resolver=fixture_resolver,
                            cache=cache,
                            limits=selected_limits,
                            process_nonce="test-process",
                            session_nonce=f"limited-{expected}",
                        )
                    )
                self.assertEqual(raised.exception.code, "limit_exceeded")
                self.assertEqual(raised.exception.context, {"limit": expected})
        self.assertEqual(transport.calls, 1)

    def test_explicit_larger_limits_publish_and_reuse_valid_cached_objects(self) -> None:
        large_content = b"x" * (10_485_760 + 1)
        skill_md = (PROTOCOL_ROOT / "fixtures/archive/skill-md/valid.md").read_bytes()
        payload = archive_with_files(
            "zip",
            [("SKILL.md", skill_md), ("assets/large.bin", large_content)],
        )
        selected = selected_for(
            payload,
            artifact_type="archive",
            url="https://skills.example.test/fixture.zip",
        )

        limits = ActivationLimits(
            file_bytes=len(large_content),
            extracted_bytes=len(large_content) + len(skill_md),
        )
        transport = PayloadTransport(payload, "application/zip")
        cache = MemoryCache(archive_verifier=verify_cached_archive)
        origin = Origin(url="https://skills.example.test", retries=0)
        for session in ("large-first", "large-second"):
            skill = asyncio.run(
                activate_selected(
                    selected,
                    origin=origin,
                    transport=transport,
                    resolver=fixture_resolver,
                    cache=cache,
                    limits=limits,
                    process_nonce="test-process",
                    session_nonce=session,
                )
            )
            self.assertEqual(
                len(asyncio.run(skill.read_bytes("assets/large.bin"))),
                len(large_content),
            )
            asyncio.run(skill._release_pin())
        self.assertEqual(transport.calls, 1)


if __name__ == "__main__":
    unittest.main()

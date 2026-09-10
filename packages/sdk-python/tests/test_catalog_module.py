import importlib.util
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from remote_skills import catalog
from remote_skills.catalog_errors import CatalogError


PROTOCOL_ROOT = Path(__file__).resolve().parents[3] / "tests" / "protocol"


def read_protocol_json(relative_path: str) -> dict[str, object]:
    with (PROTOCOL_ROOT / relative_path).open(encoding="utf-8") as handle:
        return json.load(handle)


def normalize_catalog_case(
    parser: object, fixture_path: Path, expected: dict[str, object]
) -> dict[str, object]:
    if not callable(parser):
        return {"parser_available": False}

    try:
        snapshot = parser(
            fixture_path.read_bytes(),
            origin_alias="acme",
            index_url="https://skills.example.test/.well-known/agent-skills/index.json",
        )
    except Exception as error:
        return {
            "outcome": "catalog_error",
            "error": {
                "code": getattr(error, "code", None),
                "retryable": getattr(error, "retryable", None),
                "context": getattr(error, "context", None),
            },
        }

    return {
        "outcome": "catalog_success",
        "origin_alias": snapshot.origin_alias,
        "stale": snapshot.stale,
        "entries": [
            {
                "origin_alias": entry.origin_alias,
                "name": entry.name,
                "description": entry.description,
                "artifact_type": entry.artifact_type,
                "url": entry.url,
                "digest": entry.digest,
            }
            for entry in snapshot.entries
        ],
        "requests": expected["requests"],
    }


class CatalogModuleTest(unittest.TestCase):
    def test_repeated_recognized_top_level_members_are_stable_errors(self) -> None:
        schema = json.dumps(catalog.DISCOVERY_SCHEMA_V0_2)
        for repeated_member in (
            f'"$schema":{schema}',
            f'"\\u0024schema":{schema}',
            '"skills":[]',
            '"\\u0073kills":[]',
        ):
            with self.subTest(repeated_member=repeated_member):
                body = (
                    f'{{"$schema":{schema},"skills":[],{repeated_member}}}'
                ).encode()
                with self.assertRaises(CatalogError) as raised:
                    catalog.parse_catalog(
                        body,
                        origin_alias="acme",
                        index_url="https://skills.example.test/.well-known/agent-skills/index.json",
                    )
                self.assertEqual(raised.exception.code, "catalog_invalid")
                self.assertFalse(raised.exception.retryable)
                self.assertEqual(
                    raised.exception.context,
                    {"origin_alias": "acme", "field": "$document"},
                )
                self.assertEqual(
                    str(raised.exception),
                    "Remote Skills request failed: catalog_invalid",
                )

    def test_single_recognized_and_repeated_ignored_top_level_members(self) -> None:
        schema = json.dumps(catalog.DISCOVERY_SCHEMA_V0_2)
        for members in (
            f'"$schema":{schema},"skills":[]',
            f'"\\u0024schema":{schema},"\\u0073kills":[]',
            f'"$schema":{schema},"note":"first","skills":[],"note":"second"',
            f'"$schema":{schema},"note":{{"skills":[]}},"skills":[],"\\u006eote":[]',
        ):
            with self.subTest(members=members):
                snapshot = catalog.parse_catalog(
                    f"{{{members}}}".encode(),
                    origin_alias="acme",
                    index_url="https://skills.example.test/.well-known/agent-skills/index.json",
                )
                self.assertEqual(snapshot.origin_alias, "acme")
                self.assertEqual(snapshot.entries, ())

    def test_catalog_module_is_available(self) -> None:
        try:
            catalog_module = importlib.util.find_spec("remote_skills.catalog")
        except ModuleNotFoundError:
            catalog_module = None

        self.assertIsNotNone(catalog_module)

    def test_checked_in_catalog_cases_match_static_expected_results(self) -> None:
        registry = read_protocol_json("fixtures/catalog/catalog-cases.json")
        expected_results = read_protocol_json("expected-results/catalog-results.json")
        parser = getattr(catalog, "parse_catalog", None)

        for fixture, expected_case in zip(
            registry["cases"], expected_results["cases"], strict=True
        ):
            with self.subTest(case=fixture["id"]):
                actual = normalize_catalog_case(
                    parser,
                    PROTOCOL_ROOT / "fixtures" / "catalog" / fixture["input"],
                    expected_case["result"],
                )
                self.assertEqual(actual, expected_case["result"])

    def test_malformed_artifact_url_is_a_stable_catalog_error(self) -> None:
        body = b"""{
          "$schema": "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
          "skills": [{
            "name": "unsafe",
            "description": "Malformed remote URL.",
            "type": "skill-md",
            "url": "https://[invalid-host/artifact.md",
            "digest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          }]
        }"""
        with self.assertRaises(CatalogError) as raised:
            catalog.parse_catalog(
                body,
                origin_alias="acme",
                index_url="https://skills.example.test/.well-known/agent-skills/index.json",
            )
        self.assertEqual(raised.exception.code, "catalog_invalid")
        self.assertEqual(
            raised.exception.context,
            {"origin_alias": "acme", "field": "skills[0].url"},
        )

    def test_utf8_bom_prefixed_catalog_matches_text_decoder_behavior(self) -> None:
        body = (
            PROTOCOL_ROOT / "fixtures/catalog/valid-v0.2-extension.json"
        ).read_bytes()

        snapshot = catalog.parse_catalog(
            b"\xef\xbb\xbf" + body,
            origin_alias="acme",
            index_url="https://skills.example.test/.well-known/agent-skills/index.json",
        )

        self.assertEqual(
            [entry.name for entry in snapshot.entries],
            ["code-review"],
        )


if __name__ == "__main__":
    unittest.main()

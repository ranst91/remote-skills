import importlib.util
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from remote_skills import catalog_origin


PROTOCOL_ROOT = Path(__file__).resolve().parents[3] / "tests" / "protocol"


def read_protocol_json(relative_path: str) -> dict[str, object]:
    with (PROTOCOL_ROOT / relative_path).open(encoding="utf-8") as handle:
        return json.load(handle)


class CatalogOriginModuleTest(unittest.TestCase):
    def test_catalog_origin_module_is_available(self) -> None:
        try:
            origin_module = importlib.util.find_spec("remote_skills.catalog_origin")
        except ModuleNotFoundError:
            origin_module = None

        self.assertIsNotNone(origin_module)

    def test_origin_defaults_build_only_the_well_known_catalog_url(self) -> None:
        origin_type = getattr(catalog_origin, "Origin", None)
        self.assertTrue(callable(origin_type))

        origin = origin_type(
            url="https://skills.example.test/base/path",
            headers={"Authorization": "runtime-secret", "X-Tenant": "acme"},
        )
        self.assertEqual(
            origin.catalog_url,
            "https://skills.example.test/.well-known/agent-skills/index.json",
        )
        self.assertEqual(origin.timeout, 30.0)
        self.assertEqual(origin.retries, 2)
        self.assertEqual(origin.headers_for("https://skills.example.test/next"), origin.headers)
        self.assertEqual(origin.headers_for("https://cdn.example.test/next"), {})

    def test_invalid_origin_configuration_uses_sanitized_stable_errors(self) -> None:
        origin_type = getattr(catalog_origin, "Origin", None)
        self.assertTrue(callable(origin_type))
        invalid_values = [
            ({"url": "http://skills.example.test"}, "url"),
            ({"url": "https://user:secret@skills.example.test"}, "url"),
            ({"url": "https://skills.example.test:not-a-port"}, "url"),
            ({"url": "https://skills.example.test?token=secret"}, "url"),
            ({"url": "https://skills.example.test", "timeout": 0}, "timeout"),
            ({"url": "https://skills.example.test", "retries": -1}, "retries"),
            (
                {"url": "https://skills.example.test", "headers": {"X-Test": "ok\r\nleak"}},
                "headers",
            ),
        ]

        for kwargs, field in invalid_values:
            with self.subTest(field=field):
                with self.assertRaises(Exception) as raised:
                    origin_type(**kwargs)
                self.assertEqual(raised.exception.code, "configuration_invalid")
                self.assertFalse(raised.exception.retryable)
                self.assertEqual(raised.exception.context, {"field": field})
                self.assertNotIn("secret", str(raised.exception))

    def test_checked_in_ip_policy_cases_match_static_expected_results(self) -> None:
        evaluator = getattr(catalog_origin, "evaluate_ip_address", None)
        self.assertTrue(callable(evaluator))
        registry = read_protocol_json("fixtures/network/network-cases.json")
        scenarios = read_protocol_json("fixtures/network/dns-ip-policy.json")
        expected = read_protocol_json("expected-results/network-results.json")
        expected_by_id = {case["id"]: case["result"] for case in expected["cases"]}

        for fixture in registry["cases"]:
            if fixture["category"] != "dns_ip_policy" or fixture["id"] == "ip-dns-rebinding":
                continue
            scenario = scenarios[fixture["scenario"].split("#", maxsplit=1)[1]]
            try:
                evaluator(scenario["address"], origin_alias="acme")
                actual = {"outcome": "policy_decision", "decision": "allow"}
            except Exception as error:
                actual = {
                    "outcome": "policy_decision",
                    "decision": "deny",
                    "error": {
                        "code": error.code,
                        "retryable": error.retryable,
                        "context": error.context,
                    },
                }
            with self.subTest(case=fixture["id"]):
                self.assertEqual(actual, expected_by_id[fixture["id"]])

    def test_headers_are_host_scoped_and_sensitive_values_are_not_represented(self) -> None:
        origin_type = getattr(catalog_origin, "Origin", None)
        self.assertTrue(callable(origin_type))
        try:
            origin = origin_type(
                url="https://skills.example.test",
                headers={"Authorization": "origin-secret"},
                artifact_headers={
                    "cdn.example.test": {"X-CDN-Token": "cdn-secret"}
                },
                artifact_sensitive_header_names={
                    "cdn.example.test": {"x-cdn-token"}
                },
            )
        except TypeError as error:
            self.fail(f"scoped artifact headers are unavailable: {error}")

        self.assertEqual(
            origin.headers_for("https://skills.example.test/catalog"),
            {"authorization": "origin-secret"},
        )
        self.assertEqual(
            origin.headers_for("https://cdn.example.test/artifact"),
            {"x-cdn-token": "cdn-secret"},
        )
        self.assertEqual(
            origin.headers_for("https://other.example.test/artifact"), {}
        )
        self.assertEqual(
            origin.sensitive_headers_for("https://cdn.example.test/artifact"),
            {"x-cdn-token"},
        )
        self.assertNotIn("origin-secret", repr(origin))
        self.assertNotIn("cdn-secret", repr(origin))


if __name__ == "__main__":
    unittest.main()

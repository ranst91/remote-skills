from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch


PACKAGE_ROOT = Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = PACKAGE_ROOT.parents[1]
ADAPTER = REPOSITORY_ROOT / "tests/protocol/adapters/python_protocol_adapter.py"
PROTOCOL_ROOT = REPOSITORY_ROOT / "tests/protocol"
sys.path.insert(0, str(PACKAGE_ROOT / "src"))

from remote_skills.catalog_origin import Origin
import remote_skills.protocol_adapter as protocol_adapter_module
from remote_skills.protocol_adapter import run_protocol_case


OWNED_SUITES = frozenset(
    {
        "archive",
        "cache",
        "catalog",
        "publisher_activation",
        "redaction",
        "request_transcripts",
    }
)
OWNED_NETWORK_CATEGORIES = frozenset(
    {
        "credential_forwarding",
        "dns_ip_policy",
        "http_validator",
        "offline",
        "removal",
        "redirect",
        "retry",
    }
)
DEFERRED_SUITES = frozenset()
DEFERRED_NETWORK_CATEGORIES = frozenset()
DEFERRED_NETWORK_CASES = frozenset()


def read_json(path: Path) -> dict[str, object]:
    with path.open(encoding="utf-8") as handle:
        value = json.load(handle)
    if not isinstance(value, dict):
        raise TypeError(f"{path} must contain a JSON object")
    return value


def owned_cases() -> tuple[tuple[str, str], ...]:
    contract = read_json(PROTOCOL_ROOT / "contracts/v0/sdk-adapters.json")
    selected: list[tuple[str, str]] = []
    for suite in contract["suites"]:
        suite_name = suite["name"]
        if suite_name in DEFERRED_SUITES:
            continue
        fixtures = read_json(PROTOCOL_ROOT / suite["fixtures"])
        for case in fixtures["cases"]:
            case_id = case["id"]
            if suite_name in OWNED_SUITES:
                selected.append((suite_name, case_id))
                continue
            if suite_name != "network":
                continue
            category = case["category"]
            if category in DEFERRED_NETWORK_CATEGORIES:
                continue
            if case_id in DEFERRED_NETWORK_CASES:
                continue
            if category in OWNED_NETWORK_CATEGORIES:
                selected.append((suite_name, case_id))
    return tuple(selected)


def supplemental_cases() -> tuple[tuple[str, str], ...]:
    contract = read_json(PROTOCOL_ROOT / "contracts/v0/sdk-adapters.json")
    selected: list[tuple[str, str]] = []
    for suite in contract["supplemental_suites"]:
        fixtures = read_json(PROTOCOL_ROOT / suite["fixtures"])
        selected.extend((suite["name"], case["id"]) for case in fixtures["cases"])
    return tuple(selected)


LATER_TASK_RED_SUPPLEMENTAL_CASES: frozenset[tuple[str, str]] = frozenset()


class ProtocolAdapterEntrypointTest(unittest.TestCase):
    def test_module_documentation_names_the_live_cache_adapter(self) -> None:
        documentation = protocol_adapter_module.__doc__ or ""
        self.assertIn("cache", documentation)
        self.assertNotIn("cache cases are deferred", documentation.lower())
        self.assertNotIn("returning ``none``", documentation.lower())

    def test_credential_case_observes_a_forced_header_scope_regression(self) -> None:
        fixtures = read_json(PROTOCOL_ROOT / "fixtures/network/network-cases.json")
        expected = read_json(PROTOCOL_ROOT / "expected-results/network-results.json")
        fixture = next(
            case
            for case in fixtures["cases"]
            if case["id"] == "credentials-cross-host-stripped"
        )
        wanted = next(
            case["result"]
            for case in expected["cases"]
            if case["id"] == "credentials-cross-host-stripped"
        )
        case = {
            "contract_version": fixtures["contract_version"],
            "suite": "network",
            "id": fixture["id"],
            "fixture": fixture,
            "protocol_root": str(PROTOCOL_ROOT),
        }

        with patch.object(
            Origin,
            "headers_for",
            return_value={"authorization": "forced-scope-regression"},
        ):
            actual = run_protocol_case(case)

        self.assertNotEqual(actual, wanted)

    def test_owned_shared_cases_execute_the_real_python_sdk(self) -> None:
        cases = owned_cases()
        self.assertEqual(len(cases), 119)
        self.assertEqual(
            {suite for suite, _case_id in cases},
            {
                "archive",
                "cache",
                "catalog",
                "network",
                "publisher_activation",
                "redaction",
                "request_transcripts",
            },
        )
        environment = {
            **os.environ,
            "PYTHONPATH": str(PACKAGE_ROOT / "src"),
        }
        for suite, case_id in cases:
            with self.subTest(suite=suite, case=case_id):
                completed = subprocess.run(
                    [sys.executable, str(ADAPTER), "--case", case_id],
                    cwd=REPOSITORY_ROOT,
                    env=environment,
                    capture_output=True,
                    text=True,
                    timeout=30,
                    check=False,
                )
                self.assertEqual(completed.returncode, 0, completed.stderr)
                self.assertIn("verified 1 shared cases", completed.stdout)

    def test_supplemental_cases_execute_the_real_python_sdk(self) -> None:
        cases = supplemental_cases()
        self.assertEqual(len(cases), 49)
        self.assertEqual(
            {suite for suite, _case_id in cases},
            {"catalog", "network", "request_transcripts"},
        )
        green_cases = tuple(
            case for case in cases if case not in LATER_TASK_RED_SUPPLEMENTAL_CASES
        )
        self.assertEqual(len(green_cases), 49)
        environment = {
            **os.environ,
            "PYTHONPATH": str(PACKAGE_ROOT / "src"),
        }
        for suite, case_id in green_cases:
            with self.subTest(suite=suite, case=case_id):
                completed = subprocess.run(
                    [sys.executable, str(ADAPTER), "--case", case_id],
                    cwd=REPOSITORY_ROOT,
                    env=environment,
                    capture_output=True,
                    text=True,
                    timeout=30,
                    check=False,
                )
                self.assertEqual(completed.returncode, 0, completed.stderr)
                self.assertIn("verified 1 shared cases", completed.stdout)

    def test_no_supplemental_session_cases_remain_deferred(self) -> None:
        cases = supplemental_cases()
        self.assertEqual(
            frozenset(
                case for case in cases if case in LATER_TASK_RED_SUPPLEMENTAL_CASES
            ),
            LATER_TASK_RED_SUPPLEMENTAL_CASES,
        )

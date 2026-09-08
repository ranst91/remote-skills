import asyncio
import importlib.util
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from remote_skills import catalog_network
from remote_skills.catalog_origin import Origin


PROTOCOL_ROOT = Path(__file__).resolve().parents[3] / "tests" / "protocol"
PUBLIC_ADDRESS = "93.184.216.34"


def read_protocol_json(relative_path: str) -> dict[str, object]:
    with (PROTOCOL_ROOT / relative_path).open(encoding="utf-8") as handle:
        return json.load(handle)


class ScriptedTransport:
    def __init__(self, steps: list[object]) -> None:
        self.steps = list(steps)
        self.requests: list[tuple[str, dict[str, str], float]] = []

    async def request(
        self,
        url: str,
        headers: dict[str, str],
        timeout: float,
        connect_address: str,
        max_bytes: int,
    ) -> object:
        self.asserted_policy = (connect_address, max_bytes)
        self.requests.append((url, dict(headers), timeout))
        step = self.steps.pop(0)
        if isinstance(step, BaseException):
            raise step
        return step


async def public_resolver(host: str) -> tuple[str, ...]:
    del host
    return (PUBLIC_ADDRESS,)


def normalized_request_result(
    result: object, transport: ScriptedTransport
) -> dict[str, object]:
    try:
        response = result.response
    except AttributeError:
        response = None
    if response is None:
        error = result.error
        return {
            "outcome": "request_error",
            "error": {
                "code": error.code,
                "retryable": error.retryable,
                "context": error.context,
            },
            "requests": len(transport.requests),
            "attempts": result.attempts,
        }
    normalized: dict[str, object] = {
        "outcome": "request_success",
        "requests": len(transport.requests),
        "attempts": result.attempts,
    }
    if result.delays_ms:
        normalized["delays_ms"] = list(result.delays_ms)
    if result.jitter_slots:
        normalized["jitter_slots"] = list(result.jitter_slots)
    return normalized


class CatalogNetworkModuleTest(unittest.TestCase):
    def test_catalog_network_module_is_available(self) -> None:
        try:
            network_module = importlib.util.find_spec("remote_skills.catalog_network")
        except ModuleNotFoundError:
            network_module = None

        self.assertIsNotNone(network_module)

    def test_checked_in_catalog_request_transcripts_are_exact_and_redacted(
        self,
    ) -> None:
        builder = getattr(catalog_network, "build_catalog_request", None)
        self.assertTrue(callable(builder))
        fixtures = read_protocol_json("fixtures/requests/catalog-transcripts.json")
        expected = read_protocol_json("expected-results/request-transcripts.json")
        expected_by_id = {case["id"]: case["requests"] for case in expected["cases"]}

        for fixture in fixtures["cases"]:
            configuration = fixture["configuration"]
            headers = {
                name: "RMS_SYNTHETIC_SECRET_CANARY_8F0D2A7C"
                if value == "$RUNTIME_SECRET_CANARY"
                else value
                for name, value in configuration.get("headers", {}).items()
            }
            origin = Origin(url=configuration["origin"], headers=headers)
            actual = builder(origin, validators=configuration.get("validators"))
            with self.subTest(case=fixture["id"]):
                self.assertEqual([actual.normalized()], expected_by_id[fixture["id"]])
                self.assertNotIn("RMS_SYNTHETIC_SECRET_CANARY_8F0D2A7C", repr(actual))


class CatalogNetworkRequestTest(unittest.IsolatedAsyncioTestCase):
    async def test_checked_in_redirect_cases_enforce_policy_and_header_scope(
        self,
    ) -> None:
        requester = getattr(catalog_network, "request_with_policy", None)
        response_type = getattr(catalog_network, "HttpResponse", None)
        self.assertTrue(callable(requester) and callable(response_type))
        scenarios = read_protocol_json("fixtures/network/redirects.json")
        expected = read_protocol_json("expected-results/network-results.json")
        expected_by_id = {case["id"]: case["result"] for case in expected["cases"]}
        origin = Origin(
            url="https://skills.example.test",
            headers={"Authorization": "runtime-secret"},
        )

        same = scenarios["same-host"]["chain"]
        cross = scenarios["cross-host"]["chain"]
        cases = [
            (
                "redirect-same-host",
                same[0],
                ScriptedTransport(
                    [
                        response_type(302, {"location": same[1]}, b""),
                        response_type(200, {}, b"ok"),
                    ]
                ),
            ),
            (
                "redirect-cross-host",
                cross[0],
                ScriptedTransport(
                    [
                        response_type(302, {"location": cross[1]}, b""),
                        response_type(200, {}, b"ok"),
                    ]
                ),
            ),
            (
                "redirect-private-address",
                scenarios["private"]["chain"][0],
                ScriptedTransport(
                    [
                        response_type(
                            302,
                            {"location": scenarios["private"]["chain"][1]},
                            b"",
                        )
                    ]
                ),
            ),
            (
                "redirect-overflow",
                "https://skills.example.test/redirect/0",
                ScriptedTransport(
                    [
                        response_type(
                            302,
                            {
                                "location": f"https://skills.example.test/redirect/{index + 1}"
                            },
                            b"",
                        )
                        for index in range(6)
                    ]
                ),
            ),
        ]

        async def resolver(host: str) -> tuple[str, ...]:
            if host == "127.0.0.1":
                return ("127.0.0.1",)
            return (PUBLIC_ADDRESS,)

        for case_id, url, transport in cases:
            result = await requester(
                origin_alias="acme",
                origin=origin,
                url=url,
                transport=transport,
                resolver=resolver,
            )
            if result.error is not None:
                actual = {
                    "outcome": "request_error",
                    "error": {
                        "code": result.error.code,
                        "retryable": result.error.retryable,
                        "context": result.error.context,
                    },
                    "requests": len(transport.requests),
                }
            else:
                header_hops = [
                    index
                    for index, (_, headers, _) in enumerate(transport.requests)
                    if "authorization" in headers
                ]
                actual = {
                    "outcome": "request_success",
                    "requests": len(transport.requests),
                    "origin_header_hops": header_hops,
                }
            with self.subTest(case=case_id):
                self.assertEqual(actual, expected_by_id[case_id])

    async def test_checked_in_retry_cases_match_static_expected_results(self) -> None:
        requester = getattr(catalog_network, "request_with_policy", None)
        response_type = getattr(catalog_network, "HttpResponse", None)
        self.assertTrue(callable(requester) and callable(response_type))
        expected = read_protocol_json("expected-results/network-results.json")
        expected_by_id = {case["id"]: case["result"] for case in expected["cases"]}
        recorded_delays: list[float] = []

        async def record_delay(delay: float) -> None:
            recorded_delays.append(delay)

        cases = [
            (
                "retry-408",
                [response_type(408, {}, b""), response_type(200, {}, b"ok")],
                2,
            ),
            (
                "retry-429",
                [
                    response_type(429, {"retry-after": "2"}, b""),
                    response_type(200, {}, b"ok"),
                ],
                2,
            ),
            (
                "retry-500",
                [
                    response_type(500, {}, b""),
                    response_type(503, {}, b""),
                    response_type(200, {}, b"ok"),
                ],
                2,
            ),
            ("retry-network-failure", [OSError("reset")] * 3, 2),
            ("retry-disabled-transient", [OSError("reset")], 0),
        ]

        for case_id, steps, retries in cases:
            recorded_delays.clear()
            transport = ScriptedTransport(steps)
            result = await requester(
                origin_alias="acme",
                origin=Origin(url="https://skills.example.test", retries=retries),
                url="https://skills.example.test/catalog",
                transport=transport,
                resolver=public_resolver,
                sleeper=record_delay,
                entropy=lambda: 0.0,
            )
            actual = normalized_request_result(result, transport)
            if case_id in {"retry-408", "retry-500"}:
                actual.pop("delays_ms", None)
            if case_id != "retry-500":
                actual.pop("jitter_slots", None)
            with self.subTest(case=case_id):
                self.assertEqual(actual, expected_by_id[case_id])

    async def test_timeout_uses_stable_request_timeout_code(self) -> None:
        requester = getattr(catalog_network, "request_with_policy", None)
        response_type = getattr(catalog_network, "HttpResponse", None)
        self.assertTrue(callable(requester) and callable(response_type))
        transport = ScriptedTransport([asyncio.TimeoutError()])
        result = await requester(
            origin_alias="acme",
            origin=Origin(url="https://skills.example.test", retries=0),
            url="https://skills.example.test/catalog",
            transport=transport,
            resolver=public_resolver,
        )
        self.assertEqual(result.error.code, "request_timeout")
        self.assertTrue(result.error.retryable)
        self.assertEqual(result.error.context, {"origin_alias": "acme"})

    async def test_dns_rebinding_is_rechecked_before_retry_connection(self) -> None:
        requester = getattr(catalog_network, "request_with_policy", None)
        self.assertTrue(callable(requester))
        answers = iter([(PUBLIC_ADDRESS,), ("127.0.0.1",)])
        resolutions: list[str] = []

        async def rebinding_resolver(host: str) -> tuple[str, ...]:
            del host
            answer = next(answers)
            resolutions.extend(answer)
            return answer

        async def no_delay(delay: float) -> None:
            del delay

        transport = ScriptedTransport([OSError("reset")])
        result = await requester(
            origin_alias="acme",
            origin=Origin(url="https://skills.example.test", retries=2),
            url="https://skills.example.test/catalog",
            transport=transport,
            resolver=rebinding_resolver,
            sleeper=no_delay,
        )
        actual = {
            "outcome": "policy_decision",
            "decision": "deny",
            "error": {
                "code": result.error.code,
                "retryable": result.error.retryable,
                "context": result.error.context,
            },
            "resolutions": resolutions,
            "connection_attempts": len(transport.requests),
        }
        expected = read_protocol_json("expected-results/network-results.json")
        wanted = next(
            case["result"]
            for case in expected["cases"]
            if case["id"] == "ip-dns-rebinding"
        )
        self.assertEqual(actual, wanted)

    async def test_checked_in_credential_forwarding_cases_use_only_scoped_headers(
        self,
    ) -> None:
        requester = getattr(catalog_network, "request_with_policy", None)
        response_type = getattr(catalog_network, "HttpResponse", None)
        self.assertTrue(callable(requester) and callable(response_type))
        try:
            origin = Origin(
                url="https://skills.example.test",
                headers={"Authorization": "origin-secret"},
                artifact_headers={"cdn.example.test": {"X-CDN-Token": "cdn-secret"}},
                artifact_sensitive_header_names={"cdn.example.test": {"x-cdn-token"}},
            )
        except TypeError as error:
            self.fail(f"scoped artifact headers are unavailable: {error}")
        expected = read_protocol_json("expected-results/network-results.json")
        expected_by_id = {case["id"]: case["result"] for case in expected["cases"]}
        cases = [
            (
                "credentials-same-host",
                "https://skills.example.test/artifact",
                ScriptedTransport([response_type(200, {}, b"ok")]),
            ),
            (
                "credentials-cross-host-stripped",
                "https://skills.example.test/artifact",
                ScriptedTransport(
                    [
                        response_type(
                            302,
                            {"location": "https://other.example.test/artifact"},
                            b"",
                        ),
                        response_type(200, {}, b"ok"),
                    ]
                ),
            ),
            (
                "credentials-explicit-cdn",
                "https://cdn.example.test/artifact",
                ScriptedTransport([response_type(200, {}, b"ok")]),
            ),
        ]

        for case_id, url, transport in cases:
            result = await requester(
                origin_alias="acme",
                origin=origin,
                url=url,
                transport=transport,
                resolver=public_resolver,
                purpose="artifact",
            )
            final_headers = transport.requests[-1][1]
            if case_id == "credentials-same-host":
                actual = {
                    "outcome": "request_success",
                    "requests": len(transport.requests),
                    "sensitive_header_names": ["authorization"],
                }
            elif case_id == "credentials-explicit-cdn":
                actual = {
                    "outcome": "request_success",
                    "requests": len(transport.requests),
                    "sensitive_header_names": ["x-cdn-token"],
                    "forbidden_header_names": ["authorization"],
                }
            else:
                actual = {
                    "outcome": "request_success",
                    "requests": len(transport.requests),
                    "sensitive_header_names": [],
                }
            with self.subTest(case=case_id):
                self.assertIsNone(result.error)
                self.assertEqual(actual, expected_by_id[case_id])
                if case_id == "credentials-explicit-cdn":
                    self.assertIn("x-cdn-token", final_headers)
                    self.assertNotIn("authorization", final_headers)
                if case_id == "credentials-cross-host-stripped":
                    self.assertNotIn("authorization", final_headers)

    async def test_malformed_request_port_is_denied_without_a_connection(self) -> None:
        requester = getattr(catalog_network, "request_with_policy", None)
        self.assertTrue(callable(requester))
        transport = ScriptedTransport([])
        result = await requester(
            origin_alias="acme",
            origin=Origin(url="https://skills.example.test", retries=0),
            url="https://skills.example.test:not-a-port/catalog",
            transport=transport,
            resolver=public_resolver,
        )
        self.assertEqual(result.error.code, "policy_denied")
        self.assertEqual(result.error.context, {"origin_alias": "acme"})
        self.assertEqual(transport.requests, [])

    async def test_checked_in_redaction_cases_match_sanitized_diagnostics(self) -> None:
        requester = getattr(catalog_network, "request_with_policy", None)
        self.assertTrue(callable(requester))
        fixtures = read_protocol_json("fixtures/requests/redaction-cases.json")
        expected = read_protocol_json("expected-results/redaction-results.json")
        expected_by_id = {case["id"]: case["diagnostic"] for case in expected["cases"]}

        for fixture in fixtures["cases"]:
            request_fixture = fixture["request"]
            configured_names = frozenset(
                request_fixture.get("configured_secret_header_names", [])
            )
            runtime_headers = {
                name: value.replace("$RUNTIME_", "RMS_SYNTHETIC_RUNTIME_")
                for name, value in request_fixture["headers"].items()
            }
            if fixture["boundary"] == "cdn":
                origin = Origin(
                    url="https://skills.example.test",
                    retries=0,
                    artifact_headers={"cdn.example.test": runtime_headers},
                    artifact_sensitive_header_names={
                        "cdn.example.test": configured_names
                    },
                )
                origin_alias = "cdn"
            else:
                origin = Origin(
                    url="https://skills.example.test",
                    retries=0,
                    headers=runtime_headers,
                    sensitive_header_names=configured_names,
                )
                origin_alias = "acme"
            transport = ScriptedTransport([asyncio.TimeoutError()])
            result = await requester(
                origin_alias=origin_alias,
                origin=origin,
                url=request_fixture["url"],
                transport=transport,
                resolver=public_resolver,
                purpose="artifact",
            )
            actual = {
                "code": result.error.code,
                "retryable": result.error.retryable,
                "context": result.error.context,
            }
            with self.subTest(case=fixture["id"]):
                self.assertEqual(actual, expected_by_id[fixture["id"]])
                diagnostic = repr(result.error)
                self.assertNotIn("RMS_SYNTHETIC_RUNTIME_", diagnostic)
                self.assertNotIn("access_token", diagnostic)


if __name__ == "__main__":
    unittest.main()

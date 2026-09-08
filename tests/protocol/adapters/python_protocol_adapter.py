import argparse
import importlib.util
import json
from pathlib import Path


PROTOCOL_ROOT = Path(__file__).resolve().parent.parent


def read_json(path: str) -> object:
    with (PROTOCOL_ROOT / path).open(encoding="utf-8") as handle:
        return json.load(handle)


def load_case_runner(implementation_path: str | None):
    if implementation_path is None:
        try:
            from remote_skills.protocol_adapter import run_protocol_case
        except ModuleNotFoundError as error:
            raise RuntimeError("RED: Python SDK protocol adapter is not implemented") from error
        return run_protocol_case

    path = Path(implementation_path).resolve()
    spec = importlib.util.spec_from_file_location("remote_skills_protocol_test_implementation", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load protocol implementation {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    runner = getattr(module, "run_protocol_case", None)
    if not callable(runner):
        raise TypeError("Python implementation must define run_protocol_case")
    return runner


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--implementation")
    parser.add_argument("--case")
    args = parser.parse_args()
    run_protocol_case = load_case_runner(args.implementation)
    contract = read_json("contracts/v0/sdk-adapters.json")
    checked = 0

    for suite in [*contract["suites"], *contract["supplemental_suites"]]:
        fixtures = read_json(suite["fixtures"])
        expected = read_json(suite["expected"])
        fixture_ids = [case["id"] for case in fixtures["cases"]]
        expected_ids = [case["id"] for case in expected["cases"]]
        if fixture_ids != expected_ids:
            raise AssertionError(f"{suite['name']} fixture and expected case IDs differ")

        for fixture, expected_case in zip(fixtures["cases"], expected["cases"], strict=True):
            if args.case is not None and fixture["id"] != args.case:
                continue
            actual = run_protocol_case(
                {
                    "contract_version": fixtures["contract_version"],
                    "suite": suite["name"],
                    "id": fixture["id"],
                    "fixture": fixture,
                    "protocol_root": str(PROTOCOL_ROOT),
                }
            )
            if actual is None:
                raise AssertionError(f"{suite['name']}/{fixture['id']} returned no result")
            wanted = expected_case[suite["expected_field"]]
            if actual != wanted:
                raise AssertionError(
                    f"{suite['name']}/{fixture['id']} normalized result differs:\n"
                    f"actual={actual!r}\nexpected={wanted!r}"
                )
            checked += 1

    if args.case is not None and checked == 0:
        raise RuntimeError(f"unknown protocol case: {args.case}")

    print(f"Python protocol adapter verified {checked} shared cases")


if __name__ == "__main__":
    main()

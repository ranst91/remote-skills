from __future__ import annotations

import json
from pathlib import Path
import sys
import unittest


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from remote_skills.catalog_errors import CatalogError
from remote_skills.catalog_client import AggregateCatalogError, OriginFailure


class CatalogErrorImmutabilityTest(unittest.TestCase):
    def test_diagnostics_are_defensively_frozen_and_serialize_stably(self) -> None:
        source = {
            "origin_alias": "acme",
            "details": {"attempts": [1, 2]},
        }
        error = CatalogError("origin_unavailable", retryable=True, context=source)
        source["origin_alias"] = "mutated"
        source["details"]["attempts"].append(3)

        with self.assertRaises(AttributeError):
            error.code = "policy_denied"
        with self.assertRaises(AttributeError):
            error.retryable = False
        with self.assertRaises(AttributeError):
            error.context = {}
        with self.assertRaises(AttributeError):
            error._code = "policy_denied"
        with self.assertRaises(AttributeError):
            error._retryable = False
        with self.assertRaises(AttributeError):
            error._context = {}
        with self.assertRaises(AttributeError):
            del error.code
        with self.assertRaises(AttributeError):
            del error._code
        with self.assertRaises(TypeError):
            error.context["origin_alias"] = "mutated"
        with self.assertRaises(TypeError):
            error.context["details"]["attempts"][0] = 9

        expected = {
            "code": "origin_unavailable",
            "retryable": True,
            "context": {
                "origin_alias": "acme",
                "details": {"attempts": [1, 2]},
            },
        }
        first = error.to_diagnostic()
        first["context"]["origin_alias"] = "caller mutation"
        second = error.to_diagnostic()
        self.assertEqual(second, expected)
        self.assertEqual(
            json.dumps(second, sort_keys=True, separators=(",", ":")),
            json.dumps(error.to_diagnostic(), sort_keys=True, separators=(",", ":")),
        )

    def test_internal_mutation_bypasses_cannot_change_retained_diagnostics(self) -> None:
        error = CatalogError(
            "origin_unavailable",
            retryable=True,
            context={"origin_alias": "acme", "token": "redacted"},
        )
        retained = AggregateCatalogError((OriginFailure("acme", error),))
        expected = error.to_diagnostic()

        with self.assertRaises((AttributeError, TypeError)):
            error._READ_ONLY_ATTRIBUTES = frozenset()
        with self.assertRaises(AttributeError):
            object.__setattr__(error, "_READ_ONLY_ATTRIBUTES", frozenset())
        with self.assertRaises((AttributeError, TypeError)):
            error.__dict__["_READ_ONLY_ATTRIBUTES"] = frozenset()
        with self.assertRaises((AttributeError, TypeError)):
            error.__dict__["_code"] = "policy_denied"
        with self.assertRaises((AttributeError, TypeError)):
            error.__dict__["_retryable"] = False
        with self.assertRaises((AttributeError, TypeError)):
            error.__dict__["_context"] = {"token": "runtime-canary"}

        for attribute, value in (
            ("_code", "policy_denied"),
            ("_retryable", False),
            ("_context", {"token": "runtime-canary"}),
        ):
            with self.subTest(attribute=attribute, operation="set"):
                with self.assertRaises(AttributeError):
                    setattr(error, attribute, value)
            with self.subTest(attribute=attribute, operation="delete"):
                with self.assertRaises(AttributeError):
                    delattr(error, attribute)

        with self.assertRaises(TypeError):
            error.context["token"] = "runtime-canary"
        self.assertEqual(error.to_diagnostic(), expected)
        self.assertEqual(retained.failures[0].error.to_diagnostic(), expected)
        self.assertNotIn("runtime-canary", repr(retained.failures))

    def test_standard_exception_args_are_read_only_and_stable(self) -> None:
        error = CatalogError(
            "origin_unavailable",
            retryable=False,
            context={"origin_alias": "acme", "status": 404},
        )
        expected_message = "Remote Skills request failed: origin_unavailable"
        expected_diagnostic = error.to_diagnostic()

        with self.assertRaises(AttributeError):
            error.args = ("runtime-canary",)
        with self.assertRaises(AttributeError):
            del error.args
        with self.assertRaises(AttributeError):
            object.__setattr__(error, "args", ("runtime-canary",))
        for attribute, value in (
            ("_code", "policy_denied"),
            ("_retryable", True),
            ("_context", {"token": "runtime-canary"}),
        ):
            with self.subTest(attribute=attribute):
                with self.assertRaises(AttributeError):
                    object.__setattr__(error, attribute, value)

        self.assertEqual(str(error), expected_message)
        self.assertNotIn("runtime-canary", repr(error))
        self.assertEqual(error.args, (expected_message,))
        self.assertEqual(error.to_diagnostic(), expected_diagnostic)

    def test_aggregate_failures_and_args_are_read_only_and_stable(self) -> None:
        error = CatalogError(
            "origin_unavailable",
            retryable=False,
            context={"origin_alias": "acme", "status": 404},
        )
        failure = OriginFailure("acme", error)
        aggregate = AggregateCatalogError((failure,))
        expected_message = "Remote Skills aggregate catalog failed"

        with self.assertRaises(AttributeError):
            aggregate.failures = ()
        with self.assertRaises(AttributeError):
            del aggregate.failures
        with self.assertRaises(AttributeError):
            aggregate.args = ("runtime-canary",)
        with self.assertRaises(AttributeError):
            del aggregate.args
        with self.assertRaises(AttributeError):
            object.__setattr__(aggregate, "_failures", ())
        with self.assertRaises(AttributeError):
            object.__setattr__(aggregate, "failures", ())
        with self.assertRaises(AttributeError):
            object.__setattr__(aggregate, "args", ("runtime-canary",))
        with self.assertRaises(TypeError):
            aggregate.failures[0] = failure

        self.assertEqual(str(aggregate), expected_message)
        self.assertNotIn("runtime-canary", repr(aggregate))
        self.assertEqual(aggregate.args, (expected_message,))
        self.assertEqual(aggregate.failures, (failure,))
        self.assertEqual(aggregate.failures[0].error.to_diagnostic(), error.to_diagnostic())
        self.assertNotIn("runtime-canary", repr(aggregate.failures))

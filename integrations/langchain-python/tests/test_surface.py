"""Importable public API contract, independent of live provider credentials."""

import importlib
import json
from pathlib import Path
import tomllib
import unittest

from packaging.requirements import Requirement
from packaging.utils import canonicalize_name
from packaging.version import Version


class SurfaceTests(unittest.TestCase):
    def test_integration_declares_one_exact_sdk_dependency_independent_of_workspace_version(self) -> None:
        root = Path(__file__).resolve().parents[3]
        integration = tomllib.loads((root / 'integrations/langchain-python/pyproject.toml').read_text())['project']
        sdk = tomllib.loads((root / 'packages/sdk-python/pyproject.toml').read_text())['project']
        requirements = [Requirement(value) for value in integration['dependencies']]
        dependencies = [value for value in requirements if canonicalize_name(value.name) == canonicalize_name(sdk['name'])]
        self.assertEqual(len(dependencies), 1)
        dependency = dependencies[0]
        self.assertIsNone(dependency.url)
        self.assertIsNone(dependency.marker)
        self.assertEqual(dependency.extras, set())
        pins = list(dependency.specifier)
        self.assertEqual(len(pins), 1)
        self.assertEqual(pins[0].operator, '==')
        self.assertEqual(str(Version(pins[0].version)), pins[0].version)

    def test_example_consumes_the_workspace_integration(self) -> None:
        root = Path(__file__).resolve().parents[3]
        example = tomllib.loads((root / 'examples/langchain/pyproject.toml').read_text())
        self.assertIn("remote-skills-langchain", example['project']['dependencies'])
        self.assertEqual(example['tool']['uv']['sources']['remote-skills-langchain'], {"workspace": True})

    def test_exports_native_backend_factory(self) -> None:
        integration = importlib.import_module('remote_skills_langchain')
        self.assertTrue(hasattr(integration, 'create_remote_skills_backend'))
        self.assertTrue(hasattr(integration, 'RemoteSkillsBackend'))
        self.assertTrue(hasattr(integration, 'RemoteSkillMetadata'))

    def test_error_codes_match_language_neutral_contract(self) -> None:
        from remote_skills import CatalogError
        from remote_skills_langchain.backend import _SAFE_ERRORS, _error_code
        contract = Path(__file__).resolve().parents[3] / 'tests/protocol/contracts/v0/error-codes.json'
        codes = {entry['code'] for entry in json.loads(contract.read_text())['errors']}
        self.assertEqual(_SAFE_ERRORS, codes)
        for code in codes:
            result = _error_code(CatalogError(code, retryable=False, context={'path': 'https://user:private@host/file'}))
            self.assertEqual(result, 'invalid_path' if code == 'path_invalid' else code)

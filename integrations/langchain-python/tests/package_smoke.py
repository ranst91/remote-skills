"""Build, inspect, and consume Python wheels and sdists outside the workspace."""

from __future__ import annotations

from email.parser import BytesParser
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import tomllib
import zipfile

from packaging.requirements import Requirement
from packaging.specifiers import SpecifierSet


CONSUMER = r'''
import asyncio
import hashlib
from importlib.metadata import PackageNotFoundError, distribution, version
import json
from pathlib import Path
import sys

import deepagents
import langchain
import langgraph.graph
import remote_skills
import remote_skills_langchain
from langchain.agents import create_agent
from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from remote_skills import Origin, RemoteSkills
from remote_skills.cache import MemoryCache
from remote_skills.catalog_network import HttpResponse
from remote_skills_langchain import create_remote_skills_backend

sdk_version, integration_version = sys.argv[1:]
environment = Path(sys.prefix).resolve()
for module in (remote_skills, remote_skills_langchain, deepagents, langchain, langgraph.graph):
    assert Path(module.__file__).resolve().is_relative_to(environment)
for name, expected in (("remote-skills", sdk_version), ("remote-skills-langchain", integration_version)):
    assert version(name) == expected
    direct = json.loads(distribution(name).read_text("direct_url.json"))
    assert not direct.get("dir_info", {}).get("editable", False)
try:
    version("uv-build")
except PackageNotFoundError:
    pass
else:
    raise AssertionError("build backend leaked into runtime environment")

body = b"---\nname: smoke\ndescription: Installed consumer check\n---\nVerified instructions.\n"
digest = "sha256:" + hashlib.sha256(body).hexdigest()
catalog = json.dumps({"$schema": "https://schemas.agentskills.io/discovery/0.2.0/schema.json", "skills": [{"name": "smoke", "description": "Installed consumer check", "type": "skill-md", "url": "artifact.md", "digest": digest}]}).encode()

class Transport:
    def __init__(self):
        self.catalogs = 0
        self.artifacts = 0
    async def request(self, url, headers, timeout, connect_address, max_bytes):
        if url.endswith("index.json"):
            self.catalogs += 1
            return HttpResponse(200, {}, catalog)
        self.artifacts += 1
        return HttpResponse(200, {}, body)

transport = Transport()

class NativeModel(BaseChatModel):
    @property
    def _llm_type(self):
        return "installed-native-smoke"
    def bind_tools(self, tools, **kwargs):
        assert {tool.name for tool in tools} == {"ls", "read_file"}
        return self
    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        replies = [message for message in messages if isinstance(message, ToolMessage)]
        if replies:
            assert len(replies) == 1
            assert replies[0].name == "read_file" and replies[0].status == "success"
            assert "Verified instructions." in replies[0].content
            response = AIMessage(content="Installed native consumer complete.")
        else:
            prompt = "\n".join(str(message.content) for message in messages)
            assert "Installed consumer check" in prompt
            assert "Verified instructions." not in prompt
            assert transport.artifacts == 0
            response = AIMessage(content="", tool_calls=[{"name": "read_file", "args": {"file_path": "/skills/smoke/SKILL.md"}, "id": "read-smoke", "type": "tool_call"}])
        return ChatResult(generations=[ChatGeneration(message=response)])

async def resolver(host):
    return ("93.184.216.34",)

async def main():
    client = RemoteSkills(origins={"test": Origin(url="https://example.test", retries=0)}, cache=MemoryCache(), transport=transport, resolver=resolver)
    async with client.session("test") as session:
        source = await create_remote_skills_backend(session)
        assert source.catalog[0].name == "smoke"
        assert transport.artifacts == 0
        agent = create_agent(model=NativeModel(), middleware=source.middleware())
        result = await agent.ainvoke({"messages": [{"role": "user", "content": "Use the smoke skill."}]})
        assert result["messages"][-1].content == "Installed native consumer complete."
        downloaded = await source.content.adownload_files(["/skills/smoke/SKILL.md"])
        assert downloaded[0].content == body
        assert (transport.catalogs, transport.artifacts) == (1, 1)
    assert (await source.content.aread("/skills/smoke/SKILL.md")).error == "session_closed"

asyncio.run(main())
print("Installed native Python consumer passed.")
'''


def inspect_distributions(artifacts: Path, package: dict[str, object]) -> tuple[Path, Path]:
    name = str(package['name']).replace('-', '_')
    version = str(package['version'])
    stem = f'{name}-{version}'
    wheel = artifacts / f'{stem}-py3-none-any.whl'
    source = artifacts / f'{stem}.tar.gz'
    with zipfile.ZipFile(wheel) as archive:
        wheel_paths = archive.namelist()
        wheel_metadata = BytesParser().parsebytes(archive.read(f'{stem}.dist-info/METADATA'))
    with tarfile.open(source, 'r:gz') as archive:
        source_paths = archive.getnames()
        metadata_file = archive.extractfile(f'{stem}/PKG-INFO')
        assert metadata_file is not None
        source_metadata = BytesParser().parsebytes(metadata_file.read())
    for metadata in (wheel_metadata, source_metadata):
        assert metadata['Name'] == package['name']
        assert metadata['Version'] == version
        assert SpecifierSet(metadata['Requires-Python']) == SpecifierSet(package['requires-python'])
        requirements = {Requirement(value) for value in metadata.get_all('Requires-Dist', [])}
        assert requirements == {Requirement(value) for value in package['dependencies']}
        assert metadata['License-Expression'] == 'Apache-2.0'
        assert all(requirement.url is None for requirement in requirements)
    assert f'{name}/__init__.py' in wheel_paths
    assert f'{stem}.dist-info/licenses/LICENSE' in wheel_paths
    for required in ('LICENSE', 'README.md', 'pyproject.toml', f'src/{name}/__init__.py'):
        assert f'{stem}/{required}' in source_paths
    for path in (*wheel_paths, *source_paths):
        segments = Path(path).parts
        assert not {'tests', 'examples', 'fixtures', '__pycache__', '.git'}.intersection(segments)
        assert Path(path).suffix != '.pyc'
        assert Path(path).name not in {'package.json', 'turbo.json', 'uv.lock'}
    return wheel, source


def main() -> None:
    root = Path(__file__).resolve().parents[3]
    wrapper = root / 'scripts/run-uv.ts'
    packages = [
        tomllib.loads((root / path / 'pyproject.toml').read_text())['project']
        for path in ('packages/sdk-python', 'integrations/langchain-python')
    ]
    environment = {key: value for key, value in os.environ.items() if key not in {
        'PYTHONPATH', 'PYTHONHOME', 'VIRTUAL_ENV', 'UV_PROJECT_ENVIRONMENT', 'PYTHONOPTIMIZE',
    }}
    environment.update({'PYTHONNOUSERSITE': '1', 'UV_OFFLINE': 'true', 'UV_PYTHON_DOWNLOADS': 'never'})
    with tempfile.TemporaryDirectory(prefix='remote-skills-langchain-package-') as directory:
        target = Path(directory)
        artifacts = target / 'artifacts'

        def uv(*args: str) -> None:
            subprocess.run(['node', str(wrapper), *args], cwd=target, env=environment, check=True)

        distributions: list[tuple[Path, Path]] = []
        for package in packages:
            uv('build', '--offline', '--no-python-downloads', '--project', str(root), '--package', package['name'], '--out-dir', str(artifacts))
            distributions.append(inspect_distributions(artifacts, package))
        for index, kind in enumerate(('wheel', 'sdist')):
            consumer = target / kind
            consumer.mkdir()
            virtual_environment = consumer / '.venv'
            uv('venv', '--offline', '--no-config', '--no-python-downloads', '--python', sys.executable, str(virtual_environment))
            python = virtual_environment / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')
            uv('pip', 'install', '--offline', '--no-config', '--python', str(python), *(str(pair[index]) for pair in distributions))
            uv('pip', 'check', '--offline', '--no-config', '--python', str(python))
            smoke = consumer / 'smoke.py'
            smoke.write_text(CONSUMER)
            subprocess.run([str(python), '-I', str(smoke), *(package['version'] for package in packages)], cwd=consumer, env=environment, check=True)
            print(f'{kind} metadata, isolated installation, and native execution passed.')


if __name__ == '__main__':
    main()

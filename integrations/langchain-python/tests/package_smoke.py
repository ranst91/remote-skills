"""Build and consume both Python wheels offline outside the workspace."""

from __future__ import annotations

import os
from pathlib import Path
import subprocess
import sys
import tempfile
import zipfile


CONSUMER = r'''
import asyncio
import hashlib
import json
from langgraph.runtime import Runtime
from remote_skills import Origin, RemoteSkills
from remote_skills.cache import MemoryCache
from remote_skills.catalog_network import HttpResponse
from remote_skills_langchain import create_remote_skills_backend

body = b"---\nname: smoke\ndescription: Installed consumer check\n---\nVerified instructions.\n"
digest = "sha256:" + hashlib.sha256(body).hexdigest()
catalog = json.dumps({"$schema": "https://schemas.agentskills.io/discovery/0.2.0/schema.json", "skills": [{"name": "smoke", "description": "Installed consumer check", "type": "skill-md", "url": "artifact.md", "digest": digest}]}).encode()

class Transport:
    def __init__(self):
        self.artifacts = 0
    async def request(self, url, headers, timeout, connect_address, max_bytes):
        if url.endswith("index.json"):
            return HttpResponse(200, {}, catalog)
        self.artifacts += 1
        return HttpResponse(200, {}, body)

async def resolver(host):
    return ("93.184.216.34",)

async def main():
    transport = Transport()
    client = RemoteSkills(origins={"test": Origin(url="https://example.test", retries=0)}, cache=MemoryCache(), transport=transport, resolver=resolver)
    async with client.session("test") as session:
        source = await create_remote_skills_backend(session)
        skills, filesystem = source.middleware()
        metadata = await skills.abefore_agent({"messages": []}, Runtime(), {})
        assert metadata["skills_metadata"][0]["name"] == "smoke"
        assert transport.artifacts == 0
        assert [tool.name for tool in filesystem.tools] == ["ls", "read_file"]
        result = await source.content.adownload_files(["/skills/smoke/SKILL.md"])
        assert result[0].content == body
        assert transport.artifacts == 1
    assert (await source.content.aread("/skills/smoke/SKILL.md")).error == "session_closed"
asyncio.run(main())
print("Installed native Python consumer passed.")
'''


def main() -> None:
    root = Path(__file__).resolve().parents[3]
    wrapper = root / 'scripts/run-uv.ts'
    environment = {key: value for key, value in os.environ.items() if key not in {'PYTHONPATH', 'PYTHONHOME', 'VIRTUAL_ENV', 'UV_PROJECT_ENVIRONMENT'}}
    with tempfile.TemporaryDirectory(prefix='remote-skills-langchain-package-') as directory:
        target = Path(directory)
        artifacts = target / 'artifacts'

        def uv(*args: str) -> None:
            subprocess.run(['node', str(wrapper), *args], cwd=target, env=environment, check=True)

        for package in ['remote-skills', 'remote-skills-langchain']:
            uv('build', '--offline', '--project', str(root), '--package', package, '--out-dir', str(artifacts))
        wheel = artifacts / 'remote_skills_langchain-0.0.1-py3-none-any.whl'
        with zipfile.ZipFile(wheel) as archive:
            paths = archive.namelist()
            assert any(path.endswith('/backend.py') for path in paths)
            assert not any('/tests/' in path or '/examples/' in path for path in paths)
        consumer = target / 'consumer'
        uv('venv', '--offline', '--python', sys.executable, str(consumer))
        python = consumer / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')
        uv('pip', 'install', '--offline', '--python', str(python), str(artifacts / 'remote_skills-0.0.1-py3-none-any.whl'), str(wheel))
        subprocess.run([str(python), '-c', CONSUMER], cwd=target, env=environment, check=True)


if __name__ == '__main__':
    main()

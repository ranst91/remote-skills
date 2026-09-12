"""Execute native skill middleware using only installed release artifacts."""

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

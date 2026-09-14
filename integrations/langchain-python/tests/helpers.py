"""Deterministic origin and model for the native integration tests."""

from __future__ import annotations

import asyncio
import hashlib
import io
import json
import stat
import zipfile
from collections.abc import Callable, Sequence
from typing import Any

from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage, BaseMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from pydantic import PrivateAttr
from remote_skills import ActivationLimits, Origin, RemoteSkills
from remote_skills.cache import MemoryCache
from remote_skills.activation import verify_cached_archive
from remote_skills.catalog_network import HttpResponse

MARKDOWN = b'---\nname: review\ndescription: Review a change\n---\nRead references/checklist.txt.\nUse the checklist to review the change.\n'
RESOURCE = b'Check behavior.\r\nCheck compatibility.\r\nKeep findings specific.\r\n'
SECRET = 'private-origin-canary'


def archive(markdown: bytes = MARKDOWN) -> bytes:
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, 'w') as output:
        for path, content in [('SKILL.md', markdown), ('references/checklist.txt', RESOURCE), ('assets/data.bin', b'\x00\xff\x81')]:
            entry = zipfile.ZipInfo(path, (1980, 1, 1, 0, 0, 0))
            entry.create_system = 3
            entry.external_attr = (stat.S_IFREG | 0o644) << 16
            output.writestr(entry, content)
    return stream.getvalue()


class OriginFixture:
    def __init__(self) -> None:
        self.artifacts: dict[str, bytes] = {}
        self.catalog_requests = 0
        self.artifact_requests = 0
        self.authorization_seen: list[bool] = []
        self.scope_seen: list[str | None] = []
        self.scope: str | None = None
        self.online = True
        self.status = 200
        self.block: asyncio.Event | None = None
        self.started = asyncio.Event()
        self.publish(archive())

    def descriptor(self, body: bytes, version: str) -> dict[str, str]:
        digest = hashlib.sha256(body).hexdigest()
        path = f'artifacts/{digest}.zip'
        self.artifacts[path] = body
        return {'type': 'archive', 'url': path, 'digest': f'sha256:{digest}', 'version': version}

    def publish(self, body: bytes, *, version: str = '1.0.0', older: tuple[bytes, str] | None = None) -> None:
        current = self.descriptor(body, version)
        releases = [current]
        if older is not None:
            releases.append(self.descriptor(*older))
        self.body = json.dumps({'$schema': 'https://schemas.agentskills.io/discovery/0.2.0/schema.json', 'skills': [{
            'name': 'review', 'description': 'Review a change',
            **{k: v for k, v in current.items() if k != 'version'},
            'x-remote-skills': {'version': version, 'releases': releases},
        }]}).encode()

    async def request(self, url: str, headers: dict[str, str], timeout: float, connect_address: str, max_bytes: int) -> HttpResponse:
        self.authorization_seen.append(next((value for name, value in headers.items() if name.lower() == 'authorization'), None) == SECRET)
        self.scope_seen.append(next((value for name, value in headers.items() if name.lower() == 'remote-skills-scope'), None))
        if not self.online:
            raise OSError(SECRET)
        if url.endswith('/index.json'):
            self.catalog_requests += 1
            response_headers = {'cache-control': 'max-age=0'}
            if self.scope is not None:
                response_headers['remote-skills-scope'] = self.scope
            return HttpResponse(200, response_headers, self.body)
        self.artifact_requests += 1
        self.started.set()
        if self.block is not None:
            await self.block.wait()
        path = 'artifacts/' + url.rsplit('/', 1)[-1]
        return HttpResponse(self.status, {'content-type': 'application/zip'}, self.artifacts[path])

    def client(self, cache: MemoryCache | None = None, *, limits: ActivationLimits | None = None, scope: str | None = None) -> RemoteSkills:
        async def resolver(_host: str) -> tuple[str, ...]:
            return ('93.184.216.34',)
        return RemoteSkills(
            origins={'acme': Origin(url='https://skills.example.test', headers={'Authorization': SECRET}, retries=0, scope=scope)},
            transport=self, resolver=resolver, cache=cache if cache is not None else MemoryCache(archive_verifier=verify_cached_archive),
            limits=limits,
        )


class ScriptModel(BaseChatModel):
    """A deterministic tool-calling model; the framework runs every tool itself."""

    _step: int = PrivateAttr(default=0)
    _seen: list[list[BaseMessage]] = PrivateAttr(default_factory=list)
    _first: Callable[[], None] = PrivateAttr()

    def __init__(self, first: Callable[[], None]) -> None:
        super().__init__()
        self._first = first

    @property
    def _llm_type(self) -> str:
        return 'remote-skills-scripted-test'

    def bind_tools(self, tools: Sequence[object], **kwargs: Any) -> ScriptModel:
        return self

    def _generate(self, messages: list[BaseMessage], stop: list[str] | None = None, run_manager: Any = None, **kwargs: Any) -> ChatResult:
        self._seen.append(messages)
        if self._step == 0:
            self._first()
        paths = ['/skills/review/SKILL.md', '/skills/review/references/checklist.txt']
        if self._step < len(paths):
            response = AIMessage(content='', tool_calls=[{'name': 'read_file', 'args': {'file_path': paths[self._step], 'limit': 1000}, 'id': f'read-{self._step}', 'type': 'tool_call'}])
        else:
            response = AIMessage(content='Review complete.')
        self._step += 1
        return ChatResult(generations=[ChatGeneration(message=response)])


class DelegatingModel(ScriptModel):
    def _generate(self, messages: list[BaseMessage], stop: list[str] | None = None, run_manager: Any = None, **kwargs: Any) -> ChatResult:
        if any(message.type == 'human' and message.content == 'Delegate review' for message in messages):
            self._seen.append(messages)
            if any(message.type == 'tool' for message in messages):
                response = AIMessage(content='Delegated review complete.')
            else:
                self._first()
                response = AIMessage(content='', tool_calls=[{'name': 'task', 'args': {'subagent_type': 'general-purpose', 'description': 'Review the change using the review skill and its checklist.'}, 'id': 'delegate', 'type': 'tool_call'}])
            return ChatResult(generations=[ChatGeneration(message=response)])
        return super()._generate(messages, stop, run_manager, **kwargs)

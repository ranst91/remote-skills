"""Read-only native backend views over one caller-owned async SDK session."""

from __future__ import annotations

import asyncio
import base64
import json
import re
from collections.abc import Mapping
from dataclasses import dataclass
from types import MappingProxyType
from typing import TypedDict

from deepagents.backends.protocol import (
    BackendProtocol, EditResult, FileDownloadResponse, FileInfo,
    FileUploadResponse, GlobResult, GrepResult, LsResult, ReadResult, WriteResult,
)
from deepagents.backends.utils import slice_read_response
from deepagents.middleware.filesystem import FilesystemMiddleware
from deepagents.middleware.skills import SkillsMiddleware
from remote_skills import ActivatedSkill, CatalogError, RemoteSkillsSession
from remote_skills.cache import CacheConfigurationError, CacheCorruptError


_ASYNC_REQUIRED = 'Remote Skills backends require async execution; use ainvoke or astream.'
_SAFE_ERRORS = frozenset({
    'archive_unsafe', 'artifact_unsupported', 'authentication_failed',
    'authorization_denied', 'cache_corrupt', 'catalog_invalid',
    'configuration_invalid', 'digest_mismatch', 'limit_exceeded',
    'origin_unavailable', 'path_invalid', 'policy_denied', 'request_timeout',
    'resource_not_found', 'resource_not_text', 'session_closed',
    'skill_not_found', 'unsupported_schema', 'version_unavailable',
})
_BINARY_SUFFIXES = frozenset({'.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf', '.ico', '.tiff', '.bmp'})


@dataclass(frozen=True, slots=True)
class RemoteSkillMetadata:
    """Catalog metadata safe to expose without artifact URLs or credentials."""

    name: str
    description: str
    digest: str
    version: str | None


class DeepAgentOptions(TypedDict):
    """Public DeepAgents constructor options that propagate native skills."""

    backend: BackendProtocol
    skills: list[str]
    middleware: list[SkillsMiddleware | FilesystemMiddleware]


class _BackendError(Exception):
    pass


def _error_code(error: Exception) -> str:
    if isinstance(error, _BackendError):
        return str(error)
    if isinstance(error, (CatalogError, CacheConfigurationError, CacheCorruptError)) and error.code in _SAFE_ERRORS:
        return 'invalid_path' if error.code == 'path_invalid' else error.code
    # Custom transports/caches may throw exceptions containing credentials.
    return 'remote_skills_error'


class _SessionState:
    def __init__(self, session: RemoteSkillsSession, root: str, catalog: tuple[RemoteSkillMetadata, ...], versions: Mapping[str, str]) -> None:
        self.session = session
        self.root = root
        self.catalog = {entry.name: entry for entry in catalog}
        self.versions = MappingProxyType(dict(versions))
        self.loop = asyncio.get_running_loop()

    def check(self) -> None:
        if self.session.closed:
            raise _BackendError('session_closed')
        if asyncio.get_running_loop() is not self.loop:
            raise _BackendError('async_context_mismatch')

    def path(self, path: str) -> tuple[str, str]:
        self.check()
        if (not isinstance(path, str) or not path.startswith('/')
            or any(c in path for c in '\\%?#:')
            or any(ord(c) < 32 or ord(c) == 127 for c in path)
            or any(part in {'', '.', '..'} for part in path.strip('/').split('/'))
            or path.startswith('//') or path.endswith('//')):
            raise _BackendError('invalid_path')
        if path.rstrip('/') == self.root.rstrip('/'):
            return '', ''
        if not path.startswith(self.root):
            raise _BackendError('invalid_path')
        relative = path[len(self.root):].rstrip('/')
        name, _, resource = relative.partition('/')
        if name not in self.catalog:
            raise _BackendError('file_not_found')
        return name, resource

    async def activate(self, name: str) -> ActivatedSkill:
        skill = await self.session.activate(name, self.versions.get(name))
        self.check()
        return skill

    def projection(self, name: str) -> bytes:
        entry = self.catalog[name]
        # JSON strings are YAML-compatible and prevent frontmatter injection.
        return ('---\nname: ' + json.dumps(entry.name, ensure_ascii=True)
            + '\ndescription: ' + json.dumps(entry.description, ensure_ascii=True)
            + '\n---\n').encode('utf-8')


class _RemoteView(BackendProtocol):
    """Same adapter protocol with explicit catalog or verified-content semantics."""

    def __init__(self, state: _SessionState, *, discovery: bool) -> None:
        self._state = state
        self._discovery = discovery

    def ls(self, path: str) -> LsResult:
        raise NotImplementedError(_ASYNC_REQUIRED)

    async def als(self, path: str) -> LsResult:
        try:
            name, resource = self._state.path(path)
            if not name:
                return LsResult(entries=[{'path': self._state.root + entry + '/', 'is_dir': True} for entry in self._state.catalog])
            prefix = self._state.root + name + '/'
            if self._discovery:
                if resource:
                    raise _BackendError('file_not_found')
                return LsResult(entries=[{'path': prefix + 'SKILL.md', 'is_dir': False}])
            active = await self._state.activate(name)
            files = await active.list()
            self._state.check()
            base = resource + '/' if resource else ''
            entries: dict[str, FileInfo] = {}
            for file in files:
                if not file.path.startswith(base):
                    continue
                tail = file.path[len(base):]
                leaf, separator, _ = tail.partition('/')
                target = prefix + base + leaf + ('/' if separator else '')
                info: FileInfo = {'path': target, 'is_dir': bool(separator)}
                if not separator:
                    info['size'] = file.size
                entries[target] = info
            if resource and not entries:
                raise _BackendError('file_not_found')
            return LsResult(entries=[entries[key] for key in sorted(entries)])
        except Exception as error:
            return LsResult(error=_error_code(error))

    async def _bytes(self, path: str) -> bytes:
        name, resource = self._state.path(path)
        if not name or not resource or path.endswith('/'):
            raise _BackendError('is_directory')
        if self._discovery:
            if resource != 'SKILL.md':
                raise _BackendError('file_not_found')
            return self._state.projection(name)
        skill = await self._state.activate(name)
        return await skill.read_bytes(resource)

    def read(self, file_path: str, offset: int = 0, limit: int = 2000) -> ReadResult:
        raise NotImplementedError(_ASYNC_REQUIRED)

    async def aread(self, file_path: str, offset: int = 0, limit: int = 2000) -> ReadResult:
        try:
            self._state.path(file_path)
            if type(offset) is not int or type(limit) is not int:
                raise _BackendError('invalid_read_bounds')
            if limit <= 0:
                return ReadResult(file_data={'content': '', 'encoding': 'utf-8'}, no_lines_requested=True)
            content = await self._bytes(file_path)
            suffix = '.' + file_path.rsplit('.', 1)[-1].lower() if '.' in file_path else ''
            try:
                text = content.decode('utf-8')
                binary = '\x00' in text or suffix in _BINARY_SUFFIXES
            except UnicodeDecodeError:
                binary = True
                text = ''
            if binary:
                return ReadResult(file_data={'content': base64.b64encode(content).decode('ascii'), 'encoding': 'base64'})
            return slice_read_response({'content': text, 'encoding': 'utf-8'}, offset, limit)
        except Exception as error:
            return ReadResult(error=_error_code(error))

    def download_files(self, paths: list[str]) -> list[FileDownloadResponse]:
        raise NotImplementedError(_ASYNC_REQUIRED)

    async def adownload_files(self, paths: list[str]) -> list[FileDownloadResponse]:
        results: list[FileDownloadResponse] = []
        for path in paths:
            try:
                content = await self._bytes(path)
                results.append(FileDownloadResponse(path=path, content=content))
            except Exception as error:
                # Invalid caller paths may be URLs containing credentials.
                code = _error_code(error)
                results.append(FileDownloadResponse(path='' if code == 'invalid_path' else path, error=code))
        return results

    def write(self, file_path: str, content: str) -> WriteResult:
        return WriteResult(error='permission_denied')

    async def awrite(self, file_path: str, content: str) -> WriteResult:
        return self.write(file_path, content)

    def edit(self, file_path: str, old_string: str, new_string: str, replace_all: bool = False) -> EditResult:
        return EditResult(error='permission_denied')

    async def aedit(self, file_path: str, old_string: str, new_string: str, replace_all: bool = False) -> EditResult:
        return self.edit(file_path, old_string, new_string, replace_all)

    def upload_files(self, files: list[tuple[str, bytes]]) -> list[FileUploadResponse]:
        return [FileUploadResponse(path='', error='permission_denied') for _ in files]

    async def aupload_files(self, files: list[tuple[str, bytes]]) -> list[FileUploadResponse]:
        return self.upload_files(files)

    def glob(self, pattern: str, path: str | None = None) -> GlobResult:
        return GlobResult(error='operation_not_supported')

    async def aglob(self, pattern: str, path: str | None = None) -> GlobResult:
        return self.glob(pattern, path)

    def grep(self, pattern: str, path: str | None = None, glob: str | None = None, *, max_count: int | None = None) -> GrepResult:
        return GrepResult(error='operation_not_supported')

    async def agrep(self, pattern: str, path: str | None = None, glob: str | None = None, *, max_count: int | None = None) -> GrepResult:
        return self.grep(pattern, path, glob, max_count=max_count)


@dataclass(frozen=True, slots=True)
class RemoteSkillsBackend:
    """Native discovery and content views sharing one caller-owned SDK session.

    Keep that session open on the same event loop for the entire agent invocation
    or stream. Create a new source and agent for a new authorization/session scope.
    """

    discovery: BackendProtocol
    content: BackendProtocol
    sources: tuple[str, ...]
    catalog: tuple[RemoteSkillMetadata, ...]

    def middleware(self) -> list[SkillsMiddleware | FilesystemMiddleware]:
        """Construct upstream middleware with native read-only filesystem tools."""
        return [
            SkillsMiddleware(backend=self.discovery, sources=self.sources),
            FilesystemMiddleware(
                backend=self.content, tools=['ls', 'read_file'],
                tool_token_limit_before_evict=None,
                human_message_token_limit_before_evict=None,
            ),
        ]

    def deep_agent_options(self) -> DeepAgentOptions:
        """Configure native root and default general-purpose subagent skills.

        Upstream creates skill slots from ``skills`` and replaces them by name
        with our native discovery middleware before either agent executes.
        Keep these three constructor options together.
        """
        return {'backend': self.content, 'skills': list(self.sources), 'middleware': self.middleware()}


async def create_remote_skills_backend(
    session: RemoteSkillsSession, *, root: str = '/skills/', versions: Mapping[str, str] | None = None,
) -> RemoteSkillsBackend:
    """Project a session catalog without activating any artifact.

    ``versions`` restricts activation by skill name; ranges are resolved by the
    SDK when selected. Discovery descriptions always describe current releases.
    The caller owns the session and remains responsible for closing it.
    """
    if not isinstance(root, str) or re.fullmatch(r'/(?:[A-Za-z0-9_-]+/)+', root) is None:
        raise ValueError('root must be an absolute directory prefix ending in a slash')
    entries = await session.catalog()
    catalog = tuple(RemoteSkillMetadata(e.name, e.description, e.digest, e.version) for e in entries)
    selected_versions = {} if versions is None else versions
    names = {e.name for e in catalog}
    if not isinstance(selected_versions, Mapping) or any(
        not isinstance(name, str) or name not in names or not isinstance(value, str) or not value.strip()
        for name, value in selected_versions.items()
    ):
        raise ValueError('versions must map catalog skill names to nonempty version ranges')
    state = _SessionState(session, root, catalog, selected_versions)
    return RemoteSkillsBackend(
        discovery=_RemoteView(state, discovery=True), content=_RemoteView(state, discovery=False),
        sources=(root,), catalog=catalog,
    )

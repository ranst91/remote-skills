from __future__ import annotations

import asyncio
import dataclasses
import importlib
import unittest

from deepagents import create_deep_agent
from deepagents.backends.protocol import BackendProtocol
from deepagents.middleware.skills import SkillsMiddleware
from langchain.agents import create_agent
from langchain_core.messages import ToolMessage
from langgraph.graph import END, START, MessagesState, StateGraph
from langgraph.runtime import Runtime
from remote_skills import CatalogError, StaleCatalog
from remote_skills.cache import MemoryCache
from remote_skills.activation import ActivationLimits, verify_cached_archive

from helpers import MARKDOWN, RESOURCE, SECRET, DelegatingModel, OriginFixture, ScriptModel, archive


class BackendTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.origin = OriginFixture()
        self.client = self.origin.client()
        self.session = await self.client.session('acme')
        integration = importlib.import_module('remote_skills_langchain')
        self.assertTrue(hasattr(integration, 'create_remote_skills_backend'), 'native backend factory must be implemented')
        self.create = integration.create_remote_skills_backend
        self.source = await self.create(self.session)

    async def asyncTearDown(self) -> None:
        await self.session.close()

    async def test_discovery_is_native_metadata_only(self) -> None:
        self.assertIsInstance(self.source.discovery, BackendProtocol)
        self.assertIsInstance(self.source.content, BackendProtocol)
        middleware = SkillsMiddleware(backend=self.source.discovery, sources=self.source.sources)
        state = await middleware.abefore_agent({'messages': []}, Runtime(), {})
        self.assertEqual([(s['name'], s['description'], s['path']) for s in state['skills_metadata']], [('review', 'Review a change', '/skills/review/SKILL.md')])
        self.assertEqual(self.origin.artifact_requests, 0)
        self.assertEqual(self.origin.catalog_requests, 1)
        self.assertNotIn('url', dataclasses.asdict(self.source.catalog[0]))
        projection = (await self.source.discovery.adownload_files(['/skills/review/SKILL.md']))[0]
        self.assertNotIn(b'checklist', projection.content)

    async def test_content_download_is_exact_and_resources_share_pin(self) -> None:
        self.assertEqual((await self.source.content.adownload_files(['/skills/review/SKILL.md']))[0].content, MARKDOWN)
        self.origin.online = False
        self.assertEqual((await self.source.content.adownload_files(['/skills/review/references/checklist.txt']))[0].content, RESOURCE)
        self.assertEqual((await self.source.content.adownload_files(['/skills/review/assets/data.bin']))[0].content, b'\x00\xff\x81')
        self.assertEqual(self.origin.artifact_requests, 1)

    async def test_content_directory_listing_activates_only_selected_skill(self) -> None:
        before = await self.source.content.als('/skills/')
        self.assertEqual(before.entries, [{'path': '/skills/review/', 'is_dir': True}])
        self.assertEqual(self.origin.artifact_requests, 0)
        listed = await self.source.content.als('/skills/review/references')
        self.assertEqual(listed.entries, [{'path': '/skills/review/references/checklist.txt', 'is_dir': False, 'size': len(RESOURCE)}])
        self.assertEqual(self.origin.artifact_requests, 1)

    async def test_pagination_is_native_and_zero_limit_does_not_activate(self) -> None:
        empty = await self.source.content.aread('/skills/review/SKILL.md', limit=0)
        self.assertTrue(empty.no_lines_requested)
        self.assertEqual(self.origin.artifact_requests, 0)
        read = await self.source.content.aread('/skills/review/references/checklist.txt', offset=1, limit=1)
        self.assertEqual(read.file_data['content'], 'Check compatibility.\n')
        self.assertEqual((read.start_line, read.end_line, read.next_offset, read.total_lines), (2, 2, 2, 3))
        negative = await self.source.content.aread('/skills/review/SKILL.md', offset=-2, limit=1)
        self.assertEqual(negative.file_data['content'], '---\n')
        self.assertEqual(negative.start_line, 1)
        self.assertIsNotNone((await self.source.content.aread('/skills/review/SKILL.md', offset=999)).error)

    async def test_concurrent_read_cancellation_does_not_duplicate_activation(self) -> None:
        self.origin.block = asyncio.Event()
        first = asyncio.create_task(self.source.content.aread('/skills/review/SKILL.md'))
        await self.origin.started.wait()
        second = asyncio.create_task(self.source.content.aread('/skills/review/references/checklist.txt'))
        first.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await first
        self.origin.block.set()
        self.assertIsNone((await second).error)
        self.assertEqual(self.origin.artifact_requests, 1)

    async def test_closed_borrowed_session_invalidates_both_views(self) -> None:
        await self.source.content.aread('/skills/review/SKILL.md')
        await self.session.close()
        self.assertEqual((await self.source.content.aread('/skills/review/SKILL.md')).error, 'session_closed')
        self.assertEqual((await self.source.discovery.als('/skills/')).error, 'session_closed')
        self.assertEqual((await self.source.discovery.adownload_files(['/skills/review/SKILL.md']))[0].error, 'session_closed')

    async def test_paths_and_mutations_fail_without_network(self) -> None:
        for path in ['/skills-other/review/SKILL.md', '/skills/../review/SKILL.md', '/skills/review/../SKILL.md', '/skills/review\\SKILL.md', '/skills/review/%2e%2e/SKILL.md', 'https://user:secret@host/skills', '/skills//review/SKILL.md', '/skills/review/SKILL.md?token=secret', 'review/SKILL.md']:
            with self.subTest(path=path):
                self.assertEqual((await self.source.content.aread(path)).error, 'invalid_path')
        self.assertEqual((await self.source.content.aread('/skills/missing/SKILL.md')).error, 'file_not_found')
        self.assertEqual((await self.source.content.awrite('/skills/review/SKILL.md', 'changed')).error, 'permission_denied')
        self.assertEqual((await self.source.content.aedit('/skills/review/SKILL.md', 'a', 'b')).error, 'permission_denied')
        self.assertEqual((await self.source.content.aupload_files([('/skills/review/SKILL.md', b'changed')]))[0].error, 'permission_denied')
        self.assertEqual(self.origin.artifact_requests, 0)
        with self.assertRaisesRegex(NotImplementedError, 'async'):
            self.source.content.read('/skills/review/SKILL.md')
        for root in ['/', 'skills/', '/skills/../', '/skills//', '/skills/?token=secret']:
            with self.assertRaises(ValueError):
                await self.create(self.session, root=root)

    async def test_auth_errors_are_sanitized_and_retryable_activation_can_recover(self) -> None:
        self.origin.status = 403
        failed = await self.source.content.aread('/skills/review/SKILL.md')
        self.assertEqual(failed.error, 'authorization_denied')
        self.assertNotIn(SECRET, repr(failed))
        self.origin.status = 200
        self.assertIsNone((await self.source.content.aread('/skills/review/SKILL.md')).error)
        self.assertTrue(all(self.origin.authorization_seen))

    async def test_digest_mismatch_releases_no_content(self) -> None:
        for key in self.origin.artifacts:
            self.origin.artifacts[key] = b'bad artifact ' + SECRET.encode()
        result = await self.source.content.aread('/skills/review/SKILL.md')
        self.assertEqual(result.error, 'digest_mismatch')
        self.assertIsNone(result.file_data)
        self.assertNotIn(SECRET, repr(result))

    async def test_versions_and_new_session_update_keep_old_pin(self) -> None:
        old = archive()
        new_markdown = MARKDOWN.replace(b'Use the checklist', b'Use the updated checklist')
        self.origin.publish(archive(new_markdown), version='2.0.0', older=(old, '1.0.0'))
        await self.client.refresh('acme')
        async with self.client.session('acme') as newer:
            limited = await self.create(newer, versions={'review': '^1.0.0'})
            self.assertEqual((await limited.content.adownload_files(['/skills/review/SKILL.md']))[0].content, MARKDOWN)
            self.assertEqual((await newer.activate('review')).version, '1.0.0')
        self.assertEqual((await self.source.content.adownload_files(['/skills/review/SKILL.md']))[0].content, MARKDOWN)
        async with self.client.session('acme') as latest:
            source = await self.create(latest)
            self.assertEqual((await source.content.adownload_files(['/skills/review/SKILL.md']))[0].content, new_markdown)

    async def test_unavailable_version_and_invalid_configuration(self) -> None:
        source = await self.create(self.session, versions={'review': '^9.0.0'})
        self.assertEqual((await source.content.aread('/skills/review/SKILL.md')).error, 'version_unavailable')
        self.assertEqual(self.origin.artifact_requests, 0)
        for versions in [{'unknown': '1.0.0'}, {'review': 1}, {'review': ''}]:
            with self.assertRaises(ValueError):
                await self.create(self.session, versions=versions)

    async def test_cache_reuses_verified_artifact_in_later_session(self) -> None:
        cache = MemoryCache(archive_verifier=verify_cached_archive)
        client = self.origin.client(cache)
        for _ in range(2):
            async with client.session('acme') as session:
                source = await self.create(session)
                content = await source.content.adownload_files(['/skills/review/SKILL.md'])
                self.assertEqual(content[0].content, MARKDOWN)
        self.assertEqual(self.origin.artifact_requests, 1)

    async def test_cache_errors_retain_sdk_code(self) -> None:
        # Archive caches must opt into verification; the SDK rejects this one.
        async with self.origin.client(MemoryCache()).session('acme') as session:
            source = await self.create(session)
            result = await source.content.aread('/skills/review/SKILL.md')
            self.assertEqual(result.error, 'cache_corrupt')
            self.assertIsNone(result.file_data)

    async def test_limits_and_explicit_stale_session_preserve_sdk_policy(self) -> None:
        async with self.origin.client(limits=ActivationLimits(file_bytes=10)).session('acme') as session:
            source = await self.create(session)
            result = await source.content.aread('/skills/review/SKILL.md')
            self.assertEqual(result.error, 'limit_exceeded')
            self.assertIsNone(result.file_data)
        await self.source.content.aread('/skills/review/SKILL.md')
        requests = self.origin.artifact_requests
        self.origin.online = False
        async with self.client.session('acme', stale=StaleCatalog(max_age_seconds=60)) as stale:
            self.assertTrue(stale.stale)
            source = await self.create(stale)
            self.assertEqual((await source.content.adownload_files(['/skills/review/SKILL.md']))[0].content, MARKDOWN)
        self.assertEqual(self.origin.artifact_requests, requests)

    async def test_confirmed_scope_is_kept_by_sdk_and_mismatch_fails(self) -> None:
        self.origin.scope = 'tenant-a'
        scoped_client = self.origin.client(scope='tenant-a')
        async with scoped_client.session('acme') as session:
            source = await self.create(session)
            self.assertEqual(session.metadata.confirmed_scope, 'tenant-a')
            self.assertIsNone((await source.content.aread('/skills/review/SKILL.md')).error)
            self.assertEqual(self.origin.scope_seen[-2:], ['tenant-a', None])
        self.origin.scope = 'tenant-b'
        with self.assertRaises(CatalogError) as caught:
            await scoped_client.session('acme')
        self.assertEqual(caught.exception.code, 'catalog_invalid')

    async def test_separate_event_loop_fails_before_access(self) -> None:
        result = await asyncio.to_thread(lambda: asyncio.run(self.source.content.aread('/skills/review/SKILL.md')))
        self.assertEqual(result.error, 'async_context_mismatch')
        self.assertEqual(self.origin.artifact_requests, 0)

    async def test_native_deepagents_general_purpose_subagent_uses_same_views(self) -> None:
        model = DelegatingModel(lambda: self.assertEqual(self.origin.artifact_requests, 0))
        agent = create_deep_agent(model=model, **self.source.deep_agent_options())
        result = await agent.ainvoke({'messages': [{'role': 'user', 'content': 'Delegate review'}]})
        self.assertEqual(result['messages'][-1].content, 'Delegated review complete.')
        self.assertEqual(self.origin.artifact_requests, 1)
        tool_messages = [message for turn in model._seen for message in turn if isinstance(message, ToolMessage)]
        self.assertTrue(any(message.name == 'read_file' and 'Keep findings specific.' in message.content for message in tool_messages))
        self.assertTrue(any(message.name == 'task' and message.status == 'success' for message in tool_messages))
        for turn in model._seen:
            system = '\n'.join(str(message.content) for message in turn if message.type == 'system')
            self.assertEqual(system.count('## Skills System'), 1)

    async def test_native_three_surface_matrix(self) -> None:
        for surface in ['deepagents', 'langchain', 'langgraph']:
            with self.subTest(surface=surface):
                origin = OriginFixture()
                async with origin.client().session('acme') as session:
                    source = await self.create(session)
                    model = ScriptModel(lambda: self.assertEqual(origin.artifact_requests, 0))
                    if surface == 'deepagents':
                        agent = create_deep_agent(model=model, **source.deep_agent_options())
                        self.assertEqual(sum('SkillsMiddleware.before_agent' in key for key in agent.get_graph().nodes), 1)
                    else:
                        agent = create_agent(model=model, middleware=source.middleware())
                        if surface == 'langgraph':
                            graph = StateGraph(MessagesState)
                            graph.add_node('reviewer', agent)
                            graph.add_edge(START, 'reviewer')
                            graph.add_edge('reviewer', END)
                            agent = graph.compile()
                    result = await agent.ainvoke({'messages': [{'role': 'user', 'content': 'Review this change using the review skill.'}]})
                    self.assertEqual(result['messages'][-1].content, 'Review complete.')
                    tools = [m for m in result['messages'] if isinstance(m, ToolMessage)]
                    self.assertEqual([m.name for m in tools], ['read_file', 'read_file'])
                    self.assertTrue(all(m.status == 'success' for m in tools))
                    self.assertIn('Use the checklist to review the change.', tools[0].content)
                    self.assertIn('Keep findings specific.', tools[1].content)
                    first_prompt = '\n'.join(str(m.content) for m in model._seen[0])
                    self.assertIn('Review a change', first_prompt)
                    self.assertNotIn('Use the checklist', first_prompt)
                    self.assertNotIn(SECRET, first_prompt)
                    self.assertEqual(first_prompt.count('## Skills System'), 1)
                    self.assertEqual(origin.artifact_requests, 1)


if __name__ == '__main__':
    unittest.main()

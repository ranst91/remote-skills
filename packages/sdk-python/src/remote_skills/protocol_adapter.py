"""Shared-fixture adapter for implemented Python discovery and activation cases.

Catalog, cache, archive, publisher activation, network, lifecycle, redaction,
and request-transcript cases execute the real Python SDK.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable, Mapping
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any
from urllib.parse import urlsplit

from .activation import (
    ActivationLimits,
    activate_artifact_bytes,
    activate_selected,
    verify_cached_archive,
)
from .catalog import (
    CatalogSnapshot,
    SelectedCatalogRelease,
    parse_catalog,
    select_catalog_release,
)
from .catalog_client import CatalogDiscovery
from .catalog_errors import CatalogError
from .catalog_network import HttpResponse, request_with_policy
from .catalog_origin import Origin, evaluate_ip_address
from .catalog_scope import SCOPE_HEADER
from .cache import CachedCatalog, CatalogMetadata, DiskCache, MemoryCache
from .cache.protocol import run_protocol_case as run_cache_protocol_case
from .lifecycle import RemoteSkills, StaleCatalog


_FIXTURE_INDEX_URL = "https://skills.example.test/.well-known/agent-skills/index.json"
_EMPTY_CATALOG = (
    b'{"$schema":"https://schemas.agentskills.io/discovery/0.2.0/schema.json",'
    b'"skills":[]}\n'
)
_PUBLIC_ADDRESS = "93.184.216.34"
_PINNED_CODE_REVIEW_DESCRIPTION = "Review safely."
_PINNED_CODE_REVIEW = (
    b"---\nname: code-review\ndescription: Review safely.\n---\n"
    b"# Review\n\nPinned content....\n"
)
_STANDARD_SENSITIVE = frozenset(
    {"authorization", "cookie", "proxy-authorization", "set-cookie", "x-api-key"}
)


class _MutableClock:
    def __init__(self, value: float) -> None:
        self.value = value

    def __call__(self) -> float:
        return self.value


class _FixtureTransport:
    def __init__(
        self,
        handler: Callable[[dict[str, object]], HttpResponse | Awaitable[HttpResponse]],
    ) -> None:
        self._handler = handler
        self.requests: list[dict[str, object]] = []

    async def request(
        self,
        url: str,
        headers: dict[str, str],
        timeout: float,
        connect_address: str,
        max_bytes: int,
    ) -> HttpResponse:
        request: dict[str, object] = {
            "url": url,
            "headers": dict(headers),
            "timeout": timeout,
            "connect_address": connect_address,
            "max_bytes": max_bytes,
        }
        self.requests.append(request)
        response = self._handler(request)
        if isinstance(response, HttpResponse):
            return response
        return await response


async def _public_resolver(_host: str) -> tuple[str, ...]:
    return (_PUBLIC_ADDRESS,)


async def _no_sleep(_delay: float) -> None:
    return None


def _read_json(path: Path) -> dict[str, Any]:
    with path.open(encoding="utf-8") as handle:
        value = json.load(handle)
    if not isinstance(value, dict):
        raise TypeError("protocol fixture must contain a JSON object")
    return value


def _normalized_error(error: CatalogError) -> dict[str, object]:
    return error.to_diagnostic()


def _thaw(value: object) -> object:
    if isinstance(value, Mapping):
        return {str(key): _thaw(item) for key, item in value.items()}
    if isinstance(value, tuple):
        return [_thaw(item) for item in value]
    return value


def _normalized_activation(skill: object, *, requests: int) -> dict[str, object]:
    files = asyncio.run(skill.list())
    return {
        "outcome": "activation_success",
        "origin_alias": skill.origin_alias,
        "name": skill.name,
        "digest": skill.digest,
        "instructions": skill.instructions,
        "frontmatter": _thaw(skill.frontmatter),
        "requests": requests,
        "files": [
            {
                "path": item.path,
                "size": item.size,
                "media_type": item.media_type,
            }
            for item in files
        ],
    }


def _run_archive_case(
    fixture: Mapping[str, object], protocol_root: Path
) -> dict[str, object]:
    relative = fixture.get("path")
    artifact_type = fixture.get("artifact_type")
    if not isinstance(relative, str) or not isinstance(artifact_type, str):
        raise TypeError("archive fixture is invalid")
    payload = (protocol_root / "fixtures/archive" / relative).read_bytes()
    archive_format = fixture.get("format")
    extension = (
        ".md"
        if artifact_type == "skill-md"
        else ".zip" if archive_format == "zip" else ".tar.gz"
    )
    selection = SelectedCatalogRelease(
        origin_alias="fixture",
        skill_name="fixture-skill",
        description="Exercise archive safety.",
        artifact_type=artifact_type,
        url=f"https://skills.example.test/artifacts/fixture{extension}",
        digest=f"sha256:{hashlib.sha256(payload).hexdigest()}",
        version=None,
        stale=False,
    )
    configured = fixture.get("limits", {})
    if not isinstance(configured, Mapping):
        raise TypeError("archive limits fixture is invalid")
    defaults = {
        "archive_bytes": 52_428_800,
        "extracted_bytes": 104_857_600,
        "files": 1_000,
        "file_bytes": 10_485_760,
    }
    defaults.update({str(name): int(value) for name, value in configured.items()})
    try:
        skill = activate_artifact_bytes(
            selection,
            payload,
            limits=ActivationLimits(**defaults),
        )
    except CatalogError as error:
        return {
            "outcome": "activation_error",
            "error": _normalized_error(error),
            "cache_object_published": False,
            "requests": 1,
        }
    return _normalized_activation(skill, requests=1)


def _run_publisher_activation_case(
    fixture: Mapping[str, object], protocol_root: Path
) -> dict[str, object]:
    index_relative = fixture.get("index")
    skill_name = fixture.get("skill_name")
    origin_alias = fixture.get("origin_alias")
    if not all(isinstance(value, str) for value in (index_relative, skill_name, origin_alias)):
        raise TypeError("publisher activation fixture is invalid")
    index_path = protocol_root / "fixtures/publisher" / index_relative
    snapshot = parse_catalog(
        index_path.read_bytes(),
        origin_alias=origin_alias,
        index_url="https://skills.example.test/.well-known/agent-skills/index.json",
    )
    selection = select_catalog_release(snapshot, skill_name=skill_name)
    artifact_name = urlsplit(selection.url).path.rsplit("/", 1)[-1]
    artifact = index_path.parent / "artifacts" / artifact_name
    skill = activate_artifact_bytes(selection, artifact.read_bytes())
    return _normalized_activation(skill, requests=2)


def _normalized_catalog(
    snapshot: CatalogSnapshot, *, requests: int = 1
) -> dict[str, object]:
    return {
        "outcome": "catalog_success",
        "origin_alias": snapshot.origin_alias,
        "stale": snapshot.stale,
        "entries": [
            {
                "origin_alias": entry.origin_alias,
                "name": entry.name,
                "description": entry.description,
                "artifact_type": entry.artifact_type,
                "url": entry.url,
                "digest": entry.digest,
            }
            for entry in snapshot.entries
        ],
        "requests": requests,
    }


def _load_scenario(
    fixture: Mapping[str, object], protocol_root: Path
) -> tuple[dict[str, Any], dict[str, Any]]:
    reference = fixture.get("scenario")
    if not isinstance(reference, str) or "#" not in reference:
        raise TypeError("network fixture scenario is invalid")
    filename, anchor = reference.split("#", 1)
    document = _read_json(protocol_root / "fixtures/network" / filename)
    scenario = document.get(anchor)
    if not isinstance(scenario, dict):
        raise TypeError("network fixture scenario is missing")
    return document, scenario


async def _run_validator_case(
    fixture: Mapping[str, object], protocol_root: Path
) -> dict[str, object]:
    document, scenario = _load_scenario(fixture, protocol_root)
    initial = document["initial"]
    initial_response = initial["response"]
    case_id = fixture["id"]
    phase = "verify" if case_id == "validator-initial-200" else "seed"
    clock = _MutableClock(0.0)
    recorded: list[dict[str, object]] = []
    body_transfers = 0

    def handle(_request: dict[str, object]) -> HttpResponse:
        nonlocal body_transfers
        if phase == "verify":
            recorded.append(_request)
        if phase == "seed" or case_id == "validator-initial-200":
            if phase == "verify":
                body_transfers += 1
            return HttpResponse(
                200,
                initial_response["headers"],
                _EMPTY_CATALOG,
            )
        response = scenario.get("response", {"status": 304})
        return HttpResponse(
            response.get("status", 304),
            response.get("headers", {}),
            b"",
        )

    transport = _FixtureTransport(handle)
    discovery = CatalogDiscovery(
        origins={"acme": Origin(url="https://skills.example.test")},
        transport=transport,
        resolver=_public_resolver,
        clock=clock,
    )
    if case_id == "validator-initial-200":
        snapshot = await discovery.catalog("acme")
    else:
        await discovery.catalog("acme")
        phase = "verify"
        clock.value = 299.999 if case_id == "validator-fresh-no-request" else 300.001
        snapshot = await discovery.catalog("acme")
    return {
        **_normalized_catalog(snapshot, requests=len(recorded)),
        "body_transfers": body_transfers,
    }


async def _run_redirect_case(
    fixture: Mapping[str, object], protocol_root: Path
) -> dict[str, object]:
    _document, scenario = _load_scenario(fixture, protocol_root)
    case_id = fixture["id"]
    chain = scenario.get("chain", [])
    origin = Origin(
        url="https://skills.example.test",
        headers={"authorization": "runtime-secret"},
    )

    def handle(_request: dict[str, object]) -> HttpResponse:
        count = len(transport.requests)
        if case_id == "redirect-overflow":
            return HttpResponse(302, {"location": f"/redirect/{count}"}, b"")
        next_url = chain[count] if count < len(chain) else None
        if next_url is not None:
            return HttpResponse(302, {"location": next_url}, b"")
        return HttpResponse(200, {}, b"")

    transport = _FixtureTransport(handle)
    start_url = chain[0] if chain else "https://skills.example.test/redirect/0"
    result = await request_with_policy(
        origin_alias="acme",
        origin=origin,
        url=start_url,
        purpose="skill-md",
        transport=transport,
        resolver=_public_resolver,
    )
    if result.error is not None:
        return {
            "outcome": "request_error",
            "error": _normalized_error(result.error),
            "requests": len(transport.requests),
        }
    return {
        "outcome": "request_success",
        "requests": len(transport.requests),
        "origin_header_hops": [
            index
            for index, request in enumerate(transport.requests)
            if "authorization" in request["headers"]
        ],
    }


async def _run_address_case(
    fixture: Mapping[str, object], protocol_root: Path
) -> dict[str, object]:
    _document, scenario = _load_scenario(fixture, protocol_root)
    if fixture["id"] != "ip-dns-rebinding":
        try:
            evaluate_ip_address(scenario["address"], origin_alias="acme")
        except CatalogError as error:
            return {
                "outcome": "policy_decision",
                "decision": "deny",
                "error": _normalized_error(error),
            }
        return {"outcome": "policy_decision", "decision": "allow"}

    resolutions: list[str] = []
    answers = iter(scenario["answers"])

    async def rebinding_resolver(_host: str) -> tuple[str, ...]:
        address = next(answers)
        resolutions.append(address)
        return (address,)

    transport = _FixtureTransport(
        lambda _request: HttpResponse(302, {"location": "/second"}, b"")
    )
    origin = Origin(url="https://skills.example.test", retries=0)
    result = await request_with_policy(
        origin_alias="acme",
        origin=origin,
        url=origin.catalog_url,
        purpose="catalog",
        transport=transport,
        resolver=rebinding_resolver,
    )
    if result.error is None:
        raise AssertionError("rebinding fixture unexpectedly succeeded")
    return {
        "outcome": "policy_decision",
        "decision": "deny",
        "error": _normalized_error(result.error),
        "resolutions": resolutions,
        "connection_attempts": len(transport.requests),
    }


async def _run_retry_case(
    fixture: Mapping[str, object], protocol_root: Path
) -> dict[str, object] | None:
    if fixture["id"] == "retry-digest-mismatch":
        payload = (protocol_root / "fixtures/archive/skill-md/valid.md").read_bytes()
        selection = SelectedCatalogRelease(
            origin_alias="acme",
            skill_name="fixture-skill",
            description="Exercise archive safety.",
            artifact_type="skill-md",
            url="https://skills.example.test/artifacts/fixture-skill.md",
            digest=f"sha256:{'a' * 64}",
            version=None,
            stale=False,
        )
        origin = Origin(url="https://skills.example.test")
        transport = _FixtureTransport(
            lambda _request: HttpResponse(200, {"content-type": "text/markdown"}, payload)
        )
        cache = MemoryCache(archive_verifier=verify_cached_archive)
        try:
            await activate_selected(
                selection,
                origin=origin,
                transport=transport,
                resolver=_public_resolver,
                sleeper=_no_sleep,
                cache=cache,
                process_nonce="fixture-process",
                session_nonce="digest-mismatch",
            )
        except CatalogError as error:
            return {
                "outcome": "activation_error",
                "error": _normalized_error(error),
                "cache_object_published": cache.get_object(selection.digest) is not None,
                "requests": len(transport.requests),
                "attempts": len(transport.requests),
            }
        raise AssertionError("digest mismatch fixture unexpectedly activated")
    _document, scenario = _load_scenario(fixture, protocol_root)
    retries = scenario.get("per_origin", {}).get("retries")
    origin = Origin(
        url="https://skills.example.test",
        retries=retries,
    )
    delays_ms: list[int] = []
    random_values = iter(scenario.get("jitter_slots", []))

    async def sleeper(delay: float) -> None:
        delays_ms.append(round(delay * 1000))

    def entropy() -> float:
        slot = next(random_values, 0)
        return 0.0 if slot == 0 else 0.5

    def handle(_request: dict[str, object]) -> HttpResponse:
        index = len(transport.requests) - 1
        failures = scenario.get("failures")
        if failures is not None:
            raise OSError(failures[index])
        status = scenario["statuses"][index]
        headers = (
            {"retry-after": scenario["retry_after"]}
            if index == 0 and "retry_after" in scenario
            else {}
        )
        return HttpResponse(status, headers, b"")

    transport = _FixtureTransport(handle)
    result = await request_with_policy(
        origin_alias="acme",
        origin=origin,
        url="https://skills.example.test/artifact",
        purpose="archive",
        transport=transport,
        resolver=_public_resolver,
        sleeper=sleeper,
        entropy=entropy,
        wall_clock=lambda: 0.0,
    )
    if result.error is not None:
        return {
            "outcome": "request_error",
            "error": _normalized_error(result.error),
            "requests": len(transport.requests),
            "attempts": result.attempts,
        }
    normalized: dict[str, object] = {
        "outcome": "request_success",
        "requests": len(transport.requests),
        "attempts": result.attempts,
    }
    if "delays_ms" in scenario:
        normalized["delays_ms"] = delays_ms
    if "jitter_slots" in scenario:
        normalized["jitter_slots"] = list(result.jitter_slots)
    return normalized


async def _run_credential_case(
    fixture: Mapping[str, object], protocol_root: Path
) -> dict[str, object]:
    _document, scenario = _load_scenario(fixture, protocol_root)
    case_id = fixture["id"]
    direct_cdn = case_id == "credentials-explicit-cdn"
    artifact_headers: dict[str, dict[str, str]] = {}
    if case_id == "credentials-explicit-cdn":
        artifact_headers["cdn.example.test"] = {"x-cdn-token": "cdn-secret"}
    origin = Origin(
        url="https://skills.example.test",
        headers={"authorization": "origin-secret"},
        artifact_headers=artifact_headers,
        artifact_sensitive_header_names=(
            {"cdn.example.test": frozenset({"x-cdn-token"})}
            if case_id == "credentials-explicit-cdn"
            else {}
        ),
    )
    cross_host = case_id == "credentials-cross-host-stripped"

    def handle(_request: dict[str, object]) -> HttpResponse:
        if cross_host and len(transport.requests) == 1:
            return HttpResponse(
                302,
                {"location": ("https://cdn.example.test/artifacts/fixture-skill.md")},
                b"",
            )
        return HttpResponse(200, {}, b"")

    transport = _FixtureTransport(handle)
    start_url = (
        "https://cdn.example.test/artifacts/fixture-skill.md"
        if direct_cdn
        else "https://skills.example.test/artifacts/fixture-skill.md"
    )
    result = await request_with_policy(
        origin_alias="acme",
        origin=origin,
        url=start_url,
        purpose="skill-md",
        transport=transport,
        resolver=_public_resolver,
    )
    if result.error is not None:
        raise result.error
    last_url = transport.requests[-1]["url"]
    last_headers = transport.requests[-1]["headers"]
    configured_sensitive = origin.sensitive_headers_for(last_url)
    normalized: dict[str, object] = {
        "outcome": "request_success",
        "requests": len(transport.requests),
        "sensitive_header_names": sorted(
            name
            for name in last_headers
            if name in _STANDARD_SENSITIVE or name in configured_sensitive
        ),
    }
    if "forbidden_header_names" in scenario:
        normalized["forbidden_header_names"] = [
            name
            for name in scenario["forbidden_header_names"]
            if name not in last_headers
        ]
    return normalized


async def _run_network_case(
    fixture: Mapping[str, object], protocol_root: Path
) -> dict[str, object] | None:
    category = fixture.get("category")
    if category == "http_validator":
        return await _run_validator_case(fixture, protocol_root)
    if category == "redirect":
        return await _run_redirect_case(fixture, protocol_root)
    if category == "dns_ip_policy":
        return await _run_address_case(fixture, protocol_root)
    if category == "retry":
        return await _run_retry_case(fixture, protocol_root)
    if category == "credential_forwarding":
        return await _run_credential_case(fixture, protocol_root)
    if category == "scope_authorization":
        return await _run_scope_authorization_case(fixture, protocol_root)
    if category == "offline":
        return await _run_offline_case(fixture, protocol_root)
    if category == "removal":
        case_id = fixture.get("id")
        if case_id == "version-removal-existing-session":
            return await _run_existing_version_removal_case(fixture, protocol_root)
        if case_id == "version-removal-future-online":
            return await _run_online_version_removal_case(fixture, protocol_root)
        if case_id == "version-removal-explicit-stale":
            return await _run_stale_version_removal_case(fixture, protocol_root)
        return await _run_skill_removal_case(fixture, protocol_root)
    return None


def _skill_catalog_body(payload: bytes) -> bytes:
    digest = hashlib.sha256(payload).hexdigest()
    return json.dumps(
        {
            "$schema": "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
            "skills": [
                {
                    "name": "fixture-skill",
                    "description": "Exercise archive safety.",
                    "type": "skill-md",
                    "url": f"artifacts/sha256-{digest}.md",
                    "digest": f"sha256:{digest}",
                }
            ],
        },
        separators=(",", ":"),
    ).encode()


def _real_versioned_catalog_body(versions: tuple[str, ...]) -> bytes:
    payloads = {
        "2.0.0": b"---\nname: code-review\ndescription: Review safely.\n---\n# 2.0.0\n",
        "1.5.1": b"---\nname: code-review\ndescription: Review safely.\n---\n# 1.5.1\n",
        "1.4.7": _PINNED_CODE_REVIEW,
    }
    releases = []
    for version in versions:
        payload = payloads[version]
        digest = hashlib.sha256(payload).hexdigest()
        releases.append(
            {
                "version": version,
                "type": "skill-md",
                "url": f"artifacts/sha256-{digest}.md",
                "digest": f"sha256:{digest}",
            }
        )
    current = releases[0]
    return json.dumps(
        {
            "$schema": "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
            "skills": [
                {
                    "name": "code-review",
                    "description": "Review safely.",
                    "type": current["type"],
                    "url": current["url"],
                    "digest": current["digest"],
                    "x-remote-skills": {
                        "version": current["version"],
                        "releases": releases,
                    },
                }
            ],
        },
        separators=(",", ":"),
    ).encode()


def _catalog_fixture_for_versions(
    protocol_root: Path, versions: tuple[str, ...]
) -> bytes:
    document = _read_json(
        protocol_root / "fixtures/catalog/valid-versioned-history.json"
    )
    entry = document["skills"][0]
    extension = entry["x-remote-skills"]
    extension["releases"] = [
        release
        for release in extension["releases"]
        if release["version"] in versions
    ]
    current = extension["releases"][0]
    extension["version"] = current["version"]
    entry["type"] = current["type"]
    entry["url"] = current["url"]
    entry["digest"] = current["digest"]
    return (json.dumps(document, separators=(",", ":")) + "\n").encode()


async def _run_offline_case(
    fixture: Mapping[str, object], protocol_root: Path
) -> dict[str, object]:
    _document, scenario = _load_scenario(fixture, protocol_root)
    case_id = str(fixture["id"])
    payload = (protocol_root / "fixtures/archive/skill-md/valid.md").read_bytes()
    clock = _MutableClock(1_777_000_000.0)
    online = True

    async def resolver(_host: str) -> tuple[str, ...]:
        if not online:
            raise OSError("fixture origin offline")
        return (_PUBLIC_ADDRESS,)

    def handle(request: dict[str, object]) -> HttpResponse:
        if str(request["url"]).endswith("index.json"):
            return HttpResponse(
                200,
                {"cache-control": "max-age=0"},
                _skill_catalog_body(payload) if case_id == "offline-active-session" else _EMPTY_CATALOG,
            )
        return HttpResponse(200, {"content-type": "text/markdown"}, payload)

    transport = _FixtureTransport(handle)
    client = RemoteSkills(
        origins={"acme": Origin(url="https://skills.example.test", retries=0)},
        cache=MemoryCache(),
        transport=transport,
        resolver=resolver,
        clock=clock,
    )
    seeded = await client.session("acme")
    active = (
        await seeded.activate("fixture-skill")
        if case_id == "offline-active-session"
        else None
    )
    online = False
    transport.requests.clear()
    if case_id == "offline-active-session":
        if active is None:
            raise AssertionError("offline active fixture omitted activation")
        resources = await active.list()
        resource = next(item for item in resources if item.path == "SKILL.md")
        await active.read("SKILL.md")
        result = {
            "outcome": "resource_success",
            "path": resource.path,
            "size": resource.size,
            "media_type": resource.media_type,
            "encoding": "utf-8",
            "requests": len(transport.requests),
        }
        await seeded.close()
        return result
    await seeded.close()
    clock.value += float(scenario["cached_catalog_age_seconds"])
    stale_policy = (
        StaleCatalog(max_age_seconds=float(scenario["maximum_age_seconds"]))
        if scenario.get("stale_enabled") is True
        else None
    )
    try:
        session = await client.session("acme", stale=stale_policy)
    except CatalogError as error:
        return {"outcome": "catalog_error", "error": _normalized_error(error)}
    try:
        return {
            "outcome": "catalog_success",
            "origin_alias": session.metadata.origin_alias,
            "stale": session.metadata.stale,
            "entries": [],
            "requests": len(transport.requests),
        }
    finally:
        await session.close()


async def _run_skill_removal_case(
    fixture: Mapping[str, object], protocol_root: Path
) -> dict[str, object]:
    payload = (protocol_root / "fixtures/archive/skill-md/valid.md").read_bytes()
    body = _skill_catalog_body(payload)

    def handle(request: dict[str, object]) -> HttpResponse:
        if str(request["url"]).endswith("index.json"):
            return HttpResponse(200, {"cache-control": "max-age=0"}, body)
        return HttpResponse(200, {"content-type": "text/markdown"}, payload)

    transport = _FixtureTransport(handle)
    client = RemoteSkills(
        origins={"acme": Origin(url="https://skills.example.test", retries=0)},
        cache=MemoryCache(),
        transport=transport,
        resolver=_public_resolver,
    )
    existing = await client.session("acme")
    activated = await existing.activate("fixture-skill")
    body = _EMPTY_CATALOG
    if fixture.get("id") == "removal-existing-session":
        await client.refresh("acme")
        transport.requests.clear()
        resources = await activated.list()
        resource = next(item for item in resources if item.path == "SKILL.md")
        await activated.read("SKILL.md")
        result = {
            "outcome": "resource_success",
            "path": resource.path,
            "size": resource.size,
            "media_type": resource.media_type,
            "encoding": "utf-8",
            "requests": len(transport.requests),
        }
        await existing.close()
        return result
    transport.requests.clear()
    future = await client.session("acme")
    try:
        await future.activate("fixture-skill")
    except CatalogError as error:
        result = {
            "outcome": "activation_error",
            "error": _normalized_error(error),
            "cache_object_published": False,
            "requests": len(transport.requests),
        }
        await existing.close()
        await future.close()
        return result
    raise AssertionError("removed skill unexpectedly activated")


async def _run_online_version_removal_case(
    fixture: Mapping[str, object], protocol_root: Path
) -> dict[str, object]:
    _document, scenario = _load_scenario(fixture, protocol_root)
    requested_range = str(scenario["requested_range"])
    advertised_versions = tuple(str(value) for value in scenario["advertised_versions"])
    cached_versions = tuple(str(value) for value in scenario["cached_versions"])
    body = _real_versioned_catalog_body(cached_versions)
    transport = _FixtureTransport(
        lambda _request: HttpResponse(200, {"cache-control": "max-age=0"}, body)
    )
    client = RemoteSkills(
        origins={"acme": Origin(url="https://skills.example.test", retries=0)},
        cache=MemoryCache(),
        transport=transport,
        resolver=_public_resolver,
    )
    cached = await client.session("acme")
    await cached.close()
    body = _real_versioned_catalog_body(advertised_versions)
    transport.requests.clear()
    future = await client.session("acme")
    try:
        await future.activate("code-review", requested_range)
    except CatalogError as error:
        await future.close()
        return {
            "outcome": "version_selection_error",
            "requested_range": requested_range,
            "error": _normalized_error(error),
            "requests": len(transport.requests),
        }
    raise AssertionError("current catalog resurrected a cached-only release")


async def _run_existing_version_removal_case(
    fixture: Mapping[str, object], protocol_root: Path
) -> dict[str, object]:
    _document, scenario = _load_scenario(fixture, protocol_root)
    requested_range = str(scenario["requested_range"])
    body = _real_versioned_catalog_body(("1.4.7",))
    payloads = {
        hashlib.sha256(_PINNED_CODE_REVIEW).hexdigest(): _PINNED_CODE_REVIEW,
    }

    def handle(request: dict[str, object]) -> HttpResponse:
        url = str(request["url"])
        if url.endswith("index.json"):
            return HttpResponse(200, {"cache-control": "max-age=0"}, body)
        digest = url.rsplit("sha256-", 1)[-1].removesuffix(".md")
        return HttpResponse(
            200, {"content-type": "text/markdown; charset=utf-8"}, payloads[digest]
        )

    transport = _FixtureTransport(handle)
    client = RemoteSkills(
        origins={"acme": Origin(url="https://skills.example.test", retries=0)},
        cache=MemoryCache(),
        transport=transport,
        resolver=_public_resolver,
    )
    existing = await client.session("acme")
    activated = await existing.activate("code-review", requested_range)
    body = _real_versioned_catalog_body(("2.0.0", "1.5.1"))
    await client.refresh("acme")
    transport.requests.clear()
    resources = await activated.list()
    resource = next(item for item in resources if item.path == "SKILL.md")
    await activated.read("SKILL.md")
    result = {
        "outcome": "resource_success",
        "path": resource.path,
        "size": resource.size,
        "media_type": resource.media_type,
        "encoding": "utf-8",
        "requests": len(transport.requests),
    }
    await existing.close()
    return result


async def _run_stale_version_removal_case(
    fixture: Mapping[str, object], protocol_root: Path
) -> dict[str, object]:
    _document, scenario = _load_scenario(fixture, protocol_root)
    requested_range = str(scenario["requested_range"])
    versions = tuple(str(value) for value in scenario["advertised_versions"])
    body = _catalog_fixture_for_versions(protocol_root, versions)
    clock = _MutableClock(1_777_000_000.0)
    online = True

    async def resolver(_host: str) -> tuple[str, ...]:
        if not online:
            raise OSError("fixture origin offline")
        return (_PUBLIC_ADDRESS,)

    transport = _FixtureTransport(
        lambda _request: HttpResponse(200, {"cache-control": "max-age=0"}, body)
    )
    client = RemoteSkills(
        origins={"acme": Origin(url="https://skills.example.test", retries=0)},
        cache=MemoryCache(),
        transport=transport,
        resolver=resolver,
        clock=clock,
    )
    seeded = await client.session("acme")
    await seeded.close()
    online = False
    transport.requests.clear()
    clock.value += float(scenario["cached_catalog_age_seconds"])
    stale = await client.session(
        "acme",
        stale=StaleCatalog(max_age_seconds=float(scenario["maximum_age_seconds"])),
    )
    entries = await stale.catalog()
    snapshot = CatalogSnapshot(
        origin_alias=stale.metadata.origin_alias,
        entries=entries,
        stale=stale.metadata.stale,
        confirmed_scope=stale.metadata.confirmed_scope,
        catalog_age_seconds=stale.metadata.catalog_age_seconds,
    )
    selection = select_catalog_release(
        snapshot,
        skill_name="code-review",
        requested_range=requested_range,
    )
    result = _normalized_version_selection(
        selection, requested_range, requests=len(transport.requests)
    )
    await stale.close()
    return result


def _fixture_headers(value: object) -> Mapping[str, str]:
    if isinstance(value, Mapping):
        return {str(name): str(header_value) for name, header_value in value.items()}
    if isinstance(value, list):
        normalized: dict[str, str] = {}
        for index, item in enumerate(value):
            if not isinstance(item, Mapping):
                raise TypeError("fixture response header is invalid")
            name = str(item["name"])
            if index:
                name = "-".join(part.capitalize() for part in name.split("-"))
            normalized[name] = str(item["value"])
        return normalized
    raise TypeError("fixture response headers are invalid")


def _runtime_headers(value: object) -> dict[str, str]:
    if not isinstance(value, Mapping):
        return {}
    return {
        str(name): (
            "runtime-secret"
            if str(header_value) == "$RUNTIME_SECRET_CANARY"
            else str(header_value)
        )
        for name, header_value in value.items()
    }


async def _run_scope_authorization_case(
    fixture: Mapping[str, object], protocol_root: Path
) -> dict[str, object]:
    _document, scenario = _load_scenario(fixture, protocol_root)
    case_id = str(fixture["id"])
    configuration = scenario["configuration"]
    if not isinstance(configuration, Mapping):
        raise TypeError("scope configuration is invalid")
    origin_url = str(configuration.get("origin", "https://skills.example.test"))
    origin_headers = _runtime_headers(configuration.get("headers", {}))

    if case_id == "scope-invalid-multiple-request-headers":
        try:
            Origin(
                url=origin_url,
                scope=str(configuration["scope"]),
                headers={SCOPE_HEADER: str(configuration["scope"])},
            )
        except CatalogError as error:
            return {
                "outcome": "request_error",
                "error": _normalized_error(error),
                "requests": 0,
            }
        raise AssertionError("reserved scope header unexpectedly accepted")

    try:
        origin = Origin(
            url=origin_url,
            scope=configuration.get("scope"),
            headers=origin_headers,
            retries=0,
        )
    except CatalogError as error:
        return {
            "outcome": "request_error",
            "error": _normalized_error(error),
            "requests": 0,
        }

    if case_id == "scope-artifact-denied":
        response = scenario["response"]
        transport = _FixtureTransport(
            lambda _request: HttpResponse(
                response["status"], _fixture_headers(response["headers"]), b""
            )
        )
        result = await request_with_policy(
            origin_alias="acme",
            origin=origin,
            url=str(configuration["artifact_url"]),
            purpose="skill-md",
            transport=transport,
            resolver=_public_resolver,
        )
        if result.error is None:
            raise AssertionError("denied artifact unexpectedly succeeded")
        sent_headers = transport.requests[0]["headers"]
        return {
            "outcome": "request_error",
            "error": _normalized_error(result.error),
            "requests": len(transport.requests),
            "sensitive_header_names": sorted(
                name for name in sent_headers if name in _STANDARD_SENSITIVE
            ),
            "forbidden_header_names": [
                name
                for name in scenario["artifact_request"]["forbidden_header_names"]
                if name not in sent_headers
            ],
        }

    if case_id == "authorized-range-activation":
        catalog_response = scenario["catalog_response"]
        catalog_fixture = catalog_response["fixture"]
        catalog_body = (protocol_root / "fixtures" / str(catalog_fixture)).read_bytes()
        artifact_response = scenario["artifact_response"]

        def activation_handler(request: dict[str, object]) -> HttpResponse:
            if str(request["url"]).endswith("/.well-known/agent-skills/index.json"):
                return HttpResponse(
                    int(catalog_response["status"]),
                    _fixture_headers(catalog_response["headers"]),
                    catalog_body,
                )
            if request["url"] != scenario["artifact_request"]["url"]:
                raise AssertionError("authorized activation requested the current descriptor")
            return HttpResponse(
                int(artifact_response["status"]),
                {"content-type": "text/markdown; charset=utf-8"},
                _PINNED_CODE_REVIEW,
            )

        transport = _FixtureTransport(activation_handler)
        discovery = CatalogDiscovery(
            origins={"acme": origin},
            cache=MemoryCache(),
            transport=transport,
            resolver=_public_resolver,
        )
        snapshot = await discovery.catalog("acme")
        catalog_selection = select_catalog_release(
            snapshot,
            skill_name=str(scenario["selection"]["skill_name"]),
            requested_range=str(configuration["requested_range"]),
        )
        expected_digest = f"sha256:{hashlib.sha256(_PINNED_CODE_REVIEW).hexdigest()}"
        if (
            catalog_selection.version != scenario["selection"]["selected_version"]
            or expected_digest != scenario["selection"]["digest"]
        ):
            raise AssertionError("authorized activation fixture selected an unexpected release")
        selected = SelectedCatalogRelease(
            origin_alias=catalog_selection.origin_alias,
            skill_name=catalog_selection.skill_name,
            description=_PINNED_CODE_REVIEW_DESCRIPTION,
            artifact_type="skill-md",
            url=str(scenario["artifact_request"]["url"]),
            digest=expected_digest,
            version=catalog_selection.version,
            stale=catalog_selection.stale,
        )
        activated = await activate_selected(
            selected,
            origin=origin,
            transport=transport,
            resolver=_public_resolver,
            confirmed_scope=snapshot.confirmed_scope,
            cache=MemoryCache(archive_verifier=verify_cached_archive),
            process_nonce="authorized-range-activation",
            session_nonce="authorized-range-activation",
            sleeper=_no_sleep,
        )
        try:
            if (
                activated.version != selected.version
                or activated.artifact_type != selected.artifact_type
                or activated.url != selected.url
                or activated.digest != selected.digest
                or activated.confirmed_scope != snapshot.confirmed_scope
            ):
                raise AssertionError("authorized activation did not preserve its actual pin")
            artifact_headers = transport.requests[-1]["headers"]
            sensitive_names = sorted(
                name
                for name in artifact_headers
                if name in _STANDARD_SENSITIVE
                or name in origin.sensitive_headers_for(activated.url)
            )
            forbidden = [
                name
                for name in scenario["artifact_request"]["forbidden_header_names"]
                if name not in artifact_headers
            ]
            return {
                "outcome": "authorized_version_activation",
                "origin_alias": activated.origin_alias,
                "requested_scope": origin.scope,
                "confirmed_scope": activated.confirmed_scope,
                "catalog_identifier": snapshot.catalog_identifier,
                "persistent": snapshot.persistent,
                "skill_name": activated.name,
                "requested_range": str(configuration["requested_range"]),
                "selected_version": activated.version,
                "artifact_type": activated.artifact_type,
                "url": activated.url,
                "digest": activated.digest,
                "pinned_digest": activated.digest,
                "stale": activated.stale,
                "requests": len(transport.requests),
                "catalog_requests": 1,
                "artifact_requests": 1,
                "artifact_sensitive_header_names": sensitive_names,
                "artifact_forbidden_header_names": forbidden,
            }
        finally:
            await activated._release_pin()

    response = scenario["response"]
    response_headers = _fixture_headers(response["headers"])
    phase = "seed" if response["status"] == 304 else "verify"
    recorded: list[dict[str, object]] = []
    body_transfers = 0

    def handle(request: dict[str, object]) -> HttpResponse:
        nonlocal body_transfers
        if phase == "seed":
            validators = configuration.get("validators", {})
            seed_headers = {
                "cache-control": "max-age=0",
                SCOPE_HEADER: origin.scope or "",
            }
            if isinstance(validators, Mapping) and "etag" in validators:
                seed_headers["etag"] = str(validators["etag"])
            body_transfers += 1
            return HttpResponse(200, seed_headers, _EMPTY_CATALOG)
        recorded.append(request)
        if response["status"] == 200:
            body_transfers += 1
        return HttpResponse(response["status"], response_headers, _EMPTY_CATALOG)

    transport = _FixtureTransport(handle)
    cache_timestamp = 1_777_000_000.0

    def cache_clock() -> datetime:
        return datetime.fromtimestamp(cache_timestamp, timezone.utc)

    with TemporaryDirectory(prefix="remote-skills-scope-adapter-") as cache_root:
        cache = DiskCache(cache_root, touch_on_read=False, clock=cache_clock)
        discovery = CatalogDiscovery(
            origins={"acme": origin},
            cache=cache,
            transport=transport,
            resolver=_public_resolver,
            clock=lambda: cache_timestamp,
        )
        try:
            if phase == "seed":
                await discovery.catalog("acme")
                phase = "verify"
                body_transfers = 0
                discovery = CatalogDiscovery(
                    origins={"acme": origin},
                    cache=cache,
                    transport=transport,
                    resolver=_public_resolver,
                    clock=lambda: cache_timestamp,
                )
            snapshot = await discovery.catalog("acme")
        except CatalogError as error:
            return {"outcome": "catalog_error", "error": _normalized_error(error)}
        _assert_catalog_cache_effect(
            cache=cache,
            origin=origin,
            snapshot=snapshot,
            validators=configuration.get("validators"),
        )
        normalized: dict[str, object] = {
            "outcome": "scope_catalog_success",
            "origin_alias": snapshot.origin_alias,
        }
        if origin.scope is not None:
            normalized["requested_scope"] = origin.scope
        if snapshot.confirmed_scope is not None:
            normalized["confirmed_scope"] = snapshot.confirmed_scope
        if snapshot.catalog_identifier is not None:
            normalized["catalog_identifier"] = snapshot.catalog_identifier
        normalized.update(
            {
                "persistent": snapshot.persistent,
                "stale": snapshot.stale,
                "requests": len(recorded),
                "body_transfers": body_transfers,
            }
        )
        return normalized


def _assert_catalog_cache_effect(
    *,
    cache: DiskCache,
    origin: Origin,
    snapshot: CatalogSnapshot,
    validators: object,
) -> None:
    cached = cache.get_catalog(
        origin.catalog_url,
        confirmed_scope=origin.scope,
    )
    if not snapshot.persistent:
        if cached is not None:
            raise AssertionError("memory-only catalog reached persistent cache")
        return
    if cached is None:
        raise AssertionError("persist-eligible catalog was not published")
    if cached.body != _EMPTY_CATALOG:
        raise AssertionError("persistent catalog body differs from network body")
    if cached.metadata.canonical_url != origin.catalog_url:
        raise AssertionError("persistent catalog URL identity differs")
    if cached.metadata.confirmed_scope != snapshot.confirmed_scope:
        raise AssertionError("persistent catalog scope metadata differs")
    if (
        snapshot.catalog_identifier
        != cache.catalog_path(
            origin.catalog_url,
            confirmed_scope=origin.scope,
        ).name
    ):
        raise AssertionError("persistent catalog path identity differs")
    if isinstance(validators, Mapping) and "etag" in validators:
        if cached.metadata.etag != validators["etag"]:
            raise AssertionError("persistent catalog validator differs")
    serialized = repr(cached.metadata).encode("utf-8") + cached.body
    for value in origin.headers.values():
        if value.encode("utf-8") in serialized:
            raise AssertionError("credential reached persistent catalog")
    for other_scope in ("engineering", "sales"):
        if (
            other_scope != origin.scope
            and cache.get_catalog(
                origin.catalog_url,
                confirmed_scope=other_scope,
            )
            is not None
        ):
            raise AssertionError("persistent catalogs crossed scope identities")


def _normalized_version_selection(
    selection: object, requested_range: str, *, requests: int
) -> dict[str, object]:
    return {
        "outcome": "version_selection_success",
        "origin_alias": selection.origin_alias,
        "skill_name": selection.skill_name,
        "requested_range": requested_range,
        "selected_version": selection.version,
        "artifact_type": selection.artifact_type,
        "url": selection.url,
        "digest": selection.digest,
        "stale": selection.stale,
        "requests": requests,
    }


async def _run_redaction_case(fixture: Mapping[str, object]) -> dict[str, object]:
    request = fixture["request"]
    request_url = request["url"]
    boundary = fixture["boundary"]
    alias = "cdn" if boundary == "cdn" else "acme"
    authority = request_url.split("/", 3)[:3]
    origin_url = "/".join(authority)
    configured_names = request.get("configured_secret_header_names", [])
    origin = Origin(
        url=origin_url,
        headers=request.get("headers", {}),
        sensitive_header_names=frozenset(configured_names),
        retries=0,
    )

    async def timeout_response(_request: dict[str, object]) -> HttpResponse:
        raise asyncio.TimeoutError

    result = await request_with_policy(
        origin_alias=alias,
        origin=origin,
        url=request_url,
        purpose="skill-md" if boundary == "cdn" else "catalog",
        transport=_FixtureTransport(timeout_response),
        resolver=_public_resolver,
    )
    if result.error is None:
        raise AssertionError("redaction fixture unexpectedly succeeded")
    return _normalized_error(result.error)


def _sanitized_request(
    origin: Origin, request: Mapping[str, object]
) -> dict[str, object]:
    url = request["url"]
    headers = request["headers"]
    configured = origin.sensitive_headers_for(url)
    sensitive = sorted(
        name for name in headers if name in _STANDARD_SENSITIVE or name in configured
    )
    return {
        "method": "GET",
        "url": url,
        "headers": {
            name: value for name, value in headers.items() if name not in sensitive
        },
        "sensitive_header_names": sensitive,
    }


async def _run_transcript_case(
    fixture: Mapping[str, object], protocol_root: Path
) -> list[dict[str, object]]:
    response = fixture["response"]
    fixture_name = response.get("fixture", "catalog/valid-v0.2.json")
    body = (protocol_root / "fixtures" / fixture_name).read_bytes()
    configuration = fixture["configuration"]
    origin = Origin(
        url=configuration["origin"],
        headers=_runtime_headers(configuration.get("headers", {})),
        scope=configuration.get("scope"),
    )
    phase = "seed" if str(fixture["id"]).endswith("conditional") else "verify"
    records: list[dict[str, object]] = []

    def handle(request: dict[str, object]) -> HttpResponse:
        if phase == "verify":
            records.append(request)
        if phase == "seed":
            validators = configuration["validators"]
            seed_headers = {
                "etag": validators["etag"],
                "cache-control": "max-age=0",
            }
            if "last_modified" in validators:
                seed_headers["last-modified"] = validators["last_modified"]
            if origin.scope is not None:
                seed_headers[SCOPE_HEADER] = origin.scope
            return HttpResponse(
                200,
                seed_headers,
                body,
            )
        return HttpResponse(
            response["status"],
            _fixture_headers(response.get("headers", {})),
            body,
        )

    transport = _FixtureTransport(handle)
    discovery = CatalogDiscovery(
        origins={"acme": origin},
        transport=transport,
        resolver=_public_resolver,
        clock=lambda: 0.0,
    )
    if phase == "seed":
        await discovery.catalog("acme")
        phase = "verify"
        await discovery.catalog("acme")
    else:
        await discovery.catalog("acme")
    return [_sanitized_request(origin, request) for request in records]


def _run_catalog_case(
    fixture: Mapping[str, object], protocol_root: Path
) -> dict[str, object]:
    input_name = fixture.get("input")
    if not isinstance(input_name, str):
        raise TypeError("catalog fixture input is invalid")
    body = (protocol_root / "fixtures/catalog" / input_name).read_bytes()
    try:
        snapshot = parse_catalog(
            body,
            origin_alias="acme",
            index_url=_FIXTURE_INDEX_URL,
        )
    except CatalogError as error:
        return {"outcome": "catalog_error", "error": _normalized_error(error)}
    if str(fixture.get("id", "")).startswith("version-"):
        requested_range = fixture.get("requested_range")
        skill_name = fixture.get("skill_name", "code-review")
        try:
            selection = select_catalog_release(
                snapshot,
                skill_name=skill_name,
                requested_range=requested_range,
            )
        except CatalogError as error:
            result: dict[str, object] = {
                "outcome": "version_selection_error",
            }
            if requested_range is not None:
                result["requested_range"] = requested_range
            result["error"] = _normalized_error(error)
            result["requests"] = 1
            return result
        result = {
            "outcome": "version_selection_success",
            "origin_alias": selection.origin_alias,
            "skill_name": selection.skill_name,
        }
        if requested_range is not None:
            result["requested_range"] = requested_range
        if selection.version is not None:
            result["selected_version"] = selection.version
        result.update(
            {
                "artifact_type": selection.artifact_type,
                "url": selection.url,
                "digest": selection.digest,
                "stale": selection.stale,
                "requests": 1,
            }
        )
        return result
    return _normalized_catalog(snapshot)


def run_protocol_case(case: Mapping[str, object]) -> object | None:
    """Execute one registered shared case against the task 6.1 SDK surface."""

    suite = case.get("suite")
    fixture = case.get("fixture")
    protocol_root_value = case.get("protocol_root")
    if not isinstance(fixture, Mapping) or not isinstance(protocol_root_value, str):
        raise TypeError("protocol case is invalid")
    protocol_root = Path(protocol_root_value)
    if suite == "archive":
        return _run_archive_case(fixture, protocol_root)
    if suite == "publisher_activation":
        return _run_publisher_activation_case(fixture, protocol_root)
    if suite == "catalog":
        return _run_catalog_case(fixture, protocol_root)
    if suite == "cache":
        return run_cache_protocol_case(dict(case))
    if suite == "network":
        return asyncio.run(_run_network_case(fixture, protocol_root))
    if suite == "redaction":
        return asyncio.run(_run_redaction_case(fixture))
    if suite == "request_transcripts":
        return asyncio.run(_run_transcript_case(fixture, protocol_root))
    return None

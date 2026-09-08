from __future__ import annotations

import asyncio
import hashlib
import json
from pathlib import Path
import re
import sys
from urllib.parse import quote, urljoin, urlsplit

from remote_skills import Origin, RemoteSkills, StaleCatalog
from remote_skills.cache import DiskCache, MemoryCache


if len(sys.argv) != 2:
    raise RuntimeError("usage: python-runtime-gate.py <cache-root>")
CACHE_ROOT = Path(sys.argv[1]).resolve()
SECRET = sys.stdin.read()
if not SECRET:
    raise RuntimeError("runtime credential is required on stdin")
REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
PROTOCOL_ROOT = REPOSITORY_ROOT / "tests" / "protocol"
SCHEMA = "https://schemas.agentskills.io/discovery/0.2.0/schema.json"
EVIDENCE = [
    "scope_request_not_grant",
    "authentication_401",
    "authorization_403",
    "artifact_authorization",
    "scope_and_credential_isolation",
    "non_persistence",
    "semver_parity",
    "immutable_mapping",
    "authoritative_removal",
    "bounded_stale",
    "session_pins",
    "v0_2_extension_ignored",
]


def artifact(version: str, label: str | None = None) -> dict[str, object]:
    selected = version if label is None else label
    body = (
        "---\nname: code-review\ndescription: code-review catalog\n"
        f"---\n# {selected}\n"
    ).encode()
    return {
        "version": version,
        "body": body,
        "digest": f"sha256:{hashlib.sha256(body).hexdigest()}",
        "url": f"artifacts/{quote(version, safe='')}.md",
        "type": "skill-md",
    }


def catalog(releases: list[dict[str, object]], name: str = "code-review") -> bytes:
    current = releases[0]
    descriptors = [
        {key: release[key] for key in ("version", "type", "url", "digest")}
        for release in releases
    ]
    return (
        json.dumps(
            {
                "$schema": SCHEMA,
                "skills": [
                    {
                        "name": name,
                        "description": f"{name} catalog",
                        "type": current["type"],
                        "url": current["url"],
                        "digest": current["digest"],
                        "x-remote-skills": {
                            "version": current["version"],
                            "releases": descriptors,
                        },
                    }
                ],
            },
            separators=(",", ":"),
        )
        + "\n"
    ).encode()


def plain_catalog(name: str) -> tuple[dict[str, object], bytes]:
    artifact_body = (
        f"---\nname: {name}\ndescription: {name} catalog\n---\n# {name}\n"
    ).encode()
    release = {
        "body": artifact_body,
        "digest": f"sha256:{hashlib.sha256(artifact_body).hexdigest()}",
        "url": f"artifacts/{name}.md",
        "type": "skill-md",
    }
    body = (
        json.dumps(
            {
                "$schema": SCHEMA,
                "skills": [
                    {
                        "name": name,
                        "description": f"{name} catalog",
                        "type": release["type"],
                        "url": release["url"],
                        "digest": release["digest"],
                    }
                ],
            },
            separators=(",", ":"),
        )
        + "\n"
    ).encode()
    return release, body


class LocalOrigin:
    def __init__(self, handler) -> None:
        self.handler = handler
        self.requests: list[dict[str, object]] = []
        self.server: asyncio.Server | None = None
        self.url = ""

    async def start(self) -> None:
        self.server = await asyncio.start_server(self._handle, "127.0.0.1", 0)
        assert self.server.sockets
        port = int(self.server.sockets[0].getsockname()[1])
        self.url = f"http://127.0.0.1:{port}"

    async def close(self) -> None:
        if self.server is not None:
            self.server.close()
            await self.server.wait_closed()

    async def _handle(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        try:
            request_line = await asyncio.wait_for(reader.readline(), timeout=2.0)
            if not request_line:
                return
            _method, target, _version = request_line.decode("latin-1").strip().split(" ")
            headers: dict[str, str] = {}
            while True:
                line = await asyncio.wait_for(reader.readline(), timeout=2.0)
                if line == b"\r\n":
                    break
                name, value = line.decode("latin-1").split(":", 1)
                headers[name.lower()] = value.strip()
            observed = {"path": urlsplit(target).path, "headers": headers}
            self.requests.append(observed)
            status, response_headers, body = self.handler(observed)
            reasons = {
                200: "OK",
                401: "Unauthorized",
                403: "Forbidden",
                404: "Not Found",
                500: "Internal Server Error",
                503: "Service Unavailable",
            }
            selected_headers = {
                "connection": "close",
                "content-length": str(len(body)),
                **response_headers,
            }
            lines = [f"HTTP/1.1 {status} {reasons[status]}"]
            lines.extend(f"{name}: {value}" for name, value in selected_headers.items())
            writer.write(("\r\n".join(lines) + "\r\n\r\n").encode("latin-1") + body)
            await writer.drain()
        finally:
            writer.close()
            try:
                await writer.wait_closed()
            except (ConnectionError, OSError):
                pass


def client(
    url: str,
    token: str,
    *,
    scope: str | None = None,
    cache=None,
    clock=None,
) -> RemoteSkills:
    return RemoteSkills(
        origins={
            "acme": Origin(
                url=url,
                headers={"authorization": token},
                scope=scope,
                allow_loopback_http=True,
                retries=0,
                timeout=1.0,
            )
        },
        cache=MemoryCache() if cache is None else cache,
        **({} if clock is None else {"clock": clock}),
    )


async def error_code(awaitable) -> str | None:
    try:
        await awaitable
        return None
    except Exception as error:
        return getattr(error, "code", "unexpected")


def persisted_cache_content(directory: Path) -> tuple[list[Path], bytes]:
    files = sorted(
        path for path in (directory / "cache-v1").rglob("*") if path.is_file()
    )
    return files, b"".join(path.read_bytes() for path in files)


def invalid_standard_descriptor() -> None:
    raise ValueError("invalid standard v0.2 current descriptor")


async def consume_standard_v02(document, catalog_url: str, fetch_bytes):
    if (
        not isinstance(document, dict)
        or document.get("$schema") != SCHEMA
        or not isinstance(document.get("skills"), list)
        or not document["skills"]
        or not callable(fetch_bytes)
    ):
        invalid_standard_descriptor()
    current = document["skills"][0]
    if (
        not isinstance(current, dict)
        or not isinstance(current.get("name"), str)
        or not isinstance(current.get("description"), str)
        or current.get("type") not in {"archive", "skill-md"}
        or not isinstance(current.get("url"), str)
        or not isinstance(current.get("digest"), str)
        or re.fullmatch(r"sha256:[0-9a-f]{64}", current["digest"]) is None
    ):
        invalid_standard_descriptor()
    try:
        artifact_url = urljoin(catalog_url, current["url"])
        parsed = urlsplit(artifact_url)
    except (TypeError, ValueError):
        invalid_standard_descriptor()
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        invalid_standard_descriptor()
    artifact_bytes = bytes(await fetch_bytes(artifact_url))
    observed_digest = f"sha256:{hashlib.sha256(artifact_bytes).hexdigest()}"
    if observed_digest != current["digest"]:
        invalid_standard_descriptor()
    return {
        "name": current["name"],
        "type": current["type"],
        "url": artifact_url,
        "digest": current["digest"],
        "bytes": artifact_bytes,
    }


async def standard_fetch_bytes(url: str) -> bytes:
    parsed = urlsplit(url)
    if parsed.scheme != "http" or parsed.hostname is None or parsed.port is None:
        invalid_standard_descriptor()
    reader, writer = await asyncio.open_connection(parsed.hostname, parsed.port)
    try:
        target = parsed.path or "/"
        if parsed.query:
            target = f"{target}?{parsed.query}"
        writer.write(
            (
                f"GET {target} HTTP/1.1\r\nHost: {parsed.netloc}\r\n"
                "Connection: close\r\n\r\n"
            ).encode("latin-1")
        )
        await writer.drain()
        status_line = await asyncio.wait_for(reader.readline(), timeout=2.0)
        parts = status_line.decode("latin-1").strip().split(" ", 2)
        if len(parts) < 2 or parts[1] != "200":
            raise ValueError("standard v0.2 fetch failed")
        content_length = None
        while True:
            line = await asyncio.wait_for(reader.readline(), timeout=2.0)
            if line == b"\r\n":
                break
            name, value = line.decode("latin-1").split(":", 1)
            if name.lower() == "content-length":
                content_length = int(value.strip())
        if content_length is None:
            raise ValueError("standard v0.2 response omitted content length")
        return await asyncio.wait_for(reader.readexactly(content_length), timeout=2.0)
    finally:
        writer.close()
        try:
            await writer.wait_closed()
        except (ConnectionError, OSError):
            pass


async def scope_evidence() -> dict[str, object]:
    engineering_release, engineering_body = plain_catalog("engineering-skill")
    sales_release, sales_body = plain_catalog("sales-skill")

    def handler(observed):
        path = observed["path"]
        headers = observed["headers"]
        token = headers.get("authorization")
        requested_scope = headers.get("remote-skills-scope")
        if path.endswith("index.json"):
            if token == f"{SECRET}:bad":
                return 401, {}, b""
            if token == f"{SECRET}:sales" and requested_scope == "engineering":
                return 403, {}, b""
            selected = sales_body if requested_scope == "sales" else engineering_body
            confirmed = (
                {} if requested_scope is None else {"remote-skills-scope": requested_scope}
            )
            cache_control = (
                "no-store" if token == f"{SECRET}:no-store" else "max-age=300"
            )
            return 200, {**confirmed, "cache-control": cache_control}, selected
        if token == f"{SECRET}:catalog-only":
            return 403, {}, b""
        selected = sales_release if token == f"{SECRET}:sales" else engineering_release
        return 200, {"content-type": "text/markdown"}, selected["body"]

    server = LocalOrigin(handler)
    await server.start()
    try:
        authentication = await error_code(
            client(server.url, f"{SECRET}:bad", scope="engineering").session("acme")
        )
        authorization = await error_code(
            client(server.url, f"{SECRET}:sales", scope="engineering").session("acme")
        )
        artifact_session = await client(
            server.url, f"{SECRET}:catalog-only", scope="engineering"
        ).session("acme")
        artifact_authorization = await error_code(
            artifact_session.activate("engineering-skill")
        )
        await artifact_session.close()

        shared = CACHE_ROOT / "scoped"
        engineering_session = await client(
            server.url,
            f"{SECRET}:engineering",
            scope="engineering",
            cache=DiskCache(shared),
        ).session("acme")
        sales_session = await client(
            server.url,
            f"{SECRET}:sales",
            scope="sales",
            cache=DiskCache(shared),
        ).session("acme")
        engineering_names = [entry.name for entry in await engineering_session.catalog()]
        sales_names = [entry.name for entry in await sales_session.catalog()]
        engineering_activation = await engineering_session.activate("engineering-skill")
        sales_activation = await sales_session.activate("sales-skill")
        await engineering_session.close()
        await sales_session.close()
        _scoped_files, scoped_bytes = persisted_cache_content(shared)

        no_store_root = CACHE_ROOT / "no-store"
        no_store_session = await client(
            server.url,
            f"{SECRET}:no-store",
            scope="engineering",
            cache=DiskCache(no_store_root),
        ).session("acme")
        await no_store_session.close()
        no_store_files, _ = persisted_cache_content(no_store_root)

        unconfirmed_root = CACHE_ROOT / "unconfirmed"
        unconfirmed_session = await client(
            server.url,
            f"{SECRET}:unconfirmed",
            cache=DiskCache(unconfirmed_root),
        ).session("acme")
        unconfirmed_names = [entry.name for entry in await unconfirmed_session.catalog()]
        await unconfirmed_session.close()
        unconfirmed_files, _ = persisted_cache_content(unconfirmed_root)
        artifact_request = next(
            request
            for request in server.requests
            if not str(request["path"]).endswith("index.json")
            and request["headers"].get("authorization") == f"{SECRET}:catalog-only"
        )
        return {
            "scope": {
                "authentication": authentication,
                "authorization": authorization,
                "self_grant": authorization is None,
                "artifact_authorization": artifact_authorization,
                "artifact_scope_forwarded": "remote-skills-scope"
                in artifact_request["headers"],
            },
            "isolation": {
                "engineering": engineering_names,
                "sales": sales_names,
                "engineering_pin": engineering_activation.confirmed_scope,
                "sales_pin": sales_activation.confirmed_scope,
                "cross_scope": "sales-skill" in engineering_names
                or "engineering-skill" in sales_names,
                "credential_occurrences": 1 if SECRET.encode() in scoped_bytes else 0,
            },
            "persistence": {
                "no_store_files": len(no_store_files),
                "unconfirmed_files": len(unconfirmed_files),
                "unconfirmed_catalog": unconfirmed_names,
            },
        }
    finally:
        await server.close()


async def version_evidence() -> dict[str, object]:
    large_fixture = json.loads(
        (PROTOCOL_ROOT / "fixtures/catalog/valid-versioned-large-numeric.json").read_text()
    )
    versions = [
        release["version"]
        for release in large_fixture["skills"][0]["x-remote-skills"]["releases"]
    ]
    state = {
        "releases": [artifact(version) for version in versions],
        "offline": False,
    }
    artifact_requests: list[str] = []

    def handler(observed):
        path = observed["path"]
        if state["offline"]:
            return 503, {}, b""
        if path.endswith("index.json"):
            return (
                200,
                {
                    "cache-control": "max-age=0",
                    "remote-skills-scope": "engineering",
                },
                catalog(state["releases"]),
            )
        artifact_requests.append(path)
        selected = next(
            (
                release
                for release in state["releases"]
                if path.endswith(str(release["url"]))
            ),
            None,
        )
        if selected is None:
            return 404, {}, b""
        return 200, {"content-type": "text/markdown"}, selected["body"]

    server = LocalOrigin(handler)
    await server.start()
    try:
        semver_client = client(server.url, f"{SECRET}:engineering", scope="engineering")
        large_session = await semver_client.session("acme")
        large = await large_session.activate("code-review", "*")
        await large_session.close()
        prerelease_session = await client(
            server.url, f"{SECRET}:engineering", scope="engineering"
        ).session("acme")
        prerelease = await prerelease_session.activate(
            "code-review", ">=1.0.0-9007199254740992 <1.0.0"
        )
        await prerelease_session.close()

        state["releases"] = [artifact("2.0.0"), artifact("1.4.7")]
        lifecycle = client(server.url, f"{SECRET}:engineering", scope="engineering")
        first_session = await lifecycle.session("acme")
        first = await first_session.activate("code-review", "1.4.x")
        state["releases"] = [artifact("2.0.0"), artifact("1.4.8")]
        await lifecycle.refresh("acme")
        future_session = await lifecycle.session("acme")
        future = await future_session.activate("code-review", "1.4.x")
        pinned_again = await first_session.activate("code-review", "*")
        state["releases"] = [artifact("2.0.0"), artifact("1.5.1")]
        await lifecycle.refresh("acme")
        removed_session = await lifecycle.session("acme")
        before_removal = len(artifact_requests)
        removal_code = await error_code(
            removed_session.activate("code-review", "1.4.x")
        )
        after_removal = len(artifact_requests)
        pinned_instructions = first.instructions
        await first_session.close()
        await future_session.close()
        await removed_session.close()

        clock_value = [10_000.0]
        state["releases"] = [artifact("1.4.7")]
        stale_client = client(
            server.url,
            f"{SECRET}:engineering",
            scope="engineering",
            clock=lambda: clock_value[0],
        )
        seeded = await stale_client.session("acme")
        await seeded.close()
        state["offline"] = True
        clock_value[0] += 300.0
        boundary = await stale_client.session(
            "acme", stale=StaleCatalog(max_age_seconds=300)
        )
        boundary_evidence = {
            "stale": boundary.stale,
            "age": int((boundary.metadata.catalog_age_seconds or 0) * 1000),
        }
        await boundary.close()
        clock_value[0] += 0.001
        expired = await error_code(
            stale_client.session("acme", stale=StaleCatalog(max_age_seconds=300))
        )
        return {
            "semver": {"large": large.version, "prerelease": prerelease.version},
            "removal": {
                "code": removal_code,
                "artifact_requests": after_removal - before_removal,
                "pinned_instructions": pinned_instructions.strip(),
            },
            "stale": {"boundary": boundary_evidence, "expired": expired},
            "pins": {
                "first": first.version,
                "future": future.version,
                "repeated": pinned_again.version,
                "scope": first.confirmed_scope,
                "digest_immutable": first.digest == pinned_again.digest,
            },
        }
    finally:
        await server.close()


async def immutable_evidence() -> str | None:
    body = (
        PROTOCOL_ROOT / "fixtures/catalog/invalid-version-current-mismatch.json"
    ).read_bytes()

    def handler(observed):
        if observed["path"].endswith("index.json"):
            return 200, {"cache-control": "no-store"}, body
        return 500, {}, b""

    server = LocalOrigin(handler)
    await server.start()
    try:
        return await error_code(
            client(server.url, f"{SECRET}:engineering").session("acme")
        )
    finally:
        await server.close()


async def standard_reader_evidence() -> dict[str, object]:
    release = artifact("3.0.0", "standard-v0.2")
    body = catalog([release])

    def handler(observed):
        path = observed["path"]
        if path.endswith("index.json"):
            return 200, {"content-type": "application/json"}, body
        if path.endswith(str(release["url"])):
            return 200, {"content-type": "text/markdown"}, release["body"]
        return 404, {}, b""

    server = LocalOrigin(handler)
    await server.start()
    try:
        catalog_url = f"{server.url}/.well-known/agent-skills/index.json"
        untouched = json.loads(await standard_fetch_bytes(catalog_url))
        consumed = await consume_standard_v02(
            untouched, catalog_url, standard_fetch_bytes
        )
        return {
            "count": len(untouched["skills"]),
            "name": consumed["name"],
            "source_extension": "x-remote-skills" in untouched["skills"][0],
            "extension_observed": "x-remote-skills" in consumed,
            "type": consumed["type"],
            "url": urlsplit(consumed["url"]).path,
            "digest_verified": consumed["digest"] == release["digest"],
            "usable": b"# standard-v0.2" in consumed["bytes"],
            "requests": len(server.requests),
        }
    finally:
        await server.close()


async def main() -> None:
    result = {
        "runtime": "python",
        "evidence": EVIDENCE,
        **(await scope_evidence()),
        **(await version_evidence()),
        "immutable_mapping": await immutable_evidence(),
        "v0_2": await standard_reader_evidence(),
    }
    sys.stdout.write(json.dumps(result, separators=(",", ":")) + "\n")


asyncio.run(main())

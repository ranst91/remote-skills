from __future__ import annotations

import asyncio
import base64
from dataclasses import asdict
import hashlib
import json
from pathlib import Path
import sys
from urllib.parse import urlsplit

from remote_skills import Origin, RemoteSkills
from remote_skills.cache.disk import DiskCache
from remote_skills.catalog_errors import CatalogError
from remote_skills.catalog_network import (
    HttpResponse,
    StdlibTransport,
    build_catalog_request,
    default_resolver,
    request_with_policy,
)


if len(sys.argv) not in {2, 3} or (len(sys.argv) == 3 and sys.argv[2] != "--probe-leak"):
    raise RuntimeError(
        "usage: python-runtime-gate.py <output-directory> [--probe-leak]"
    )

OUTPUT_DIRECTORY = Path(sys.argv[1])
PROBE_LEAK = len(sys.argv) == 3
SECRET = sys.stdin.read()
if not SECRET:
    raise RuntimeError("runtime secret is required on stdin")
PUBLIC_ADDRESS = "93.184.216.34"
SKILL = (
    b"---\nname: fixture-skill\ndescription: Fixture skill.\n---\n# Fixture\n"
)
DIGEST = f"sha256:{hashlib.sha256(SKILL).hexdigest()}"
SECRET_ENCODINGS = (
    SECRET.encode(),
    base64.b64encode(SECRET.encode()),
    SECRET.encode().hex().encode(),
)
ERROR_EVIDENCE: list[dict[str, object]] = []
OBSERVED_SINK_PAYLOADS: set[str] = set()
LIVE_TEMPORARY_FILES: dict[str, int] | None = None
LEAK_PROBE_DETECTED = False


def encoded_secret_occurrences(value: bytes | str) -> int:
    content = value.encode() if isinstance(value, str) else value
    return sum(content.count(encoding) for encoding in SECRET_ENCODINGS)


def reject_leak_probe() -> None:
    global LEAK_PROBE_DETECTED
    LEAK_PROBE_DETECTED = True
    raise RuntimeError("network leak probe detected")


def observe_sink(name: str, payload: object) -> object:
    serialized = json.dumps(payload, default=str, separators=(",", ":"))
    if encoded_secret_occurrences(serialized):
        reject_leak_probe()
    OBSERVED_SINK_PAYLOADS.add(name)
    return payload


def catalog_bytes(artifact_url: str = "/artifact.md") -> bytes:
    return (
        json.dumps(
            {
                "$schema": "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
                "skills": [
                    {
                        "name": "fixture-skill",
                        "description": "Fixture skill.",
                        "type": "skill-md",
                        "url": artifact_url,
                        "digest": DIGEST,
                    }
                ],
            },
            separators=(",", ":"),
        )
        + "\n"
    ).encode()


def credential_marker(headers: dict[str, str]) -> str:
    if headers.get("authorization") == SECRET:
        return "origin"
    if headers.get("x-cdn-token") == SECRET:
        return "cdn"
    return "none"


class LocalOrigin:
    def __init__(self, route: str) -> None:
        self.route = route
        self.requests: list[dict[str, str]] = []
        self.server: asyncio.Server | None = None
        self.port = 0

    async def start(self) -> None:
        self.server = await asyncio.start_server(self._handle, "127.0.0.1", 0)
        socket = self.server.sockets[0]
        self.port = int(socket.getsockname()[1])

    async def close(self) -> None:
        if self.server is None:
            return
        self.server.close()
        await self.server.wait_closed()

    async def _handle(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        try:
            request_line = await reader.readline()
            if not request_line:
                return
            _method, target, _version = request_line.decode("latin-1").strip().split(" ")
            headers: dict[str, str] = {}
            while True:
                line = await reader.readline()
                if line == b"\r\n":
                    break
                name, value = line.decode("latin-1").split(":", 1)
                headers[name.lower()] = value.strip()
            path = urlsplit(target).path
            self.requests.append(
                {"path": path, "credential": credential_marker(headers)}
            )
            if self.route == "proxy-origin":
                await self._proxy_origin(path, writer)
            elif self.route == "proxy-cdn":
                await self._respond(writer, 200, body=b"ok")
            else:
                await self._loopback(path, writer)
        finally:
            writer.close()
            try:
                await writer.wait_closed()
            except (ConnectionError, OSError):
                pass

    async def _proxy_origin(
        self, path: str, writer: asyncio.StreamWriter
    ) -> None:
        if path == "/same/0":
            await self._respond(writer, 302, {"location": "/same/1"})
        elif path == "/same/1":
            await self._respond(writer, 302, {"location": "/same/2"})
        elif path == "/cross/0":
            await self._respond(
                writer,
                302,
                {"location": "https://cdn.example.test/cross/1"},
            )
        elif path.startswith("/overflow/"):
            hop = int(path.rsplit("/", 1)[1])
            await self._respond(
                writer, 302, {"location": f"/overflow/{hop + 1}"}
            )
        elif path == "/rebind":
            return
        else:
            await self._respond(writer, 200, body=b"ok")

    async def _loopback(self, path: str, writer: asyncio.StreamWriter) -> None:
        if path == "/body":
            await self._respond(writer, 200, {"content-length": "4096"})
        elif path == "/timeout":
            await asyncio.sleep(0.08)
            await self._respond(writer, 200, body=b"late")
        elif path == "/retry":
            await self._respond(writer, 503)
        elif path == "/.well-known/agent-skills/index.json":
            await self._respond(
                writer,
                200,
                {
                    "cache-control": "max-age=300",
                    "content-type": "application/json",
                    "remote-skills-scope": "engineering",
                },
                catalog_bytes(),
            )
        elif path == "/artifact.md":
            await self._respond(
                writer, 200, {"content-type": "text/markdown"}, SKILL
            )
        else:
            await self._respond(writer, 200, body=b"ok")

    async def _respond(
        self,
        writer: asyncio.StreamWriter,
        status: int,
        headers: dict[str, str] | None = None,
        body: bytes = b"",
    ) -> None:
        reason = {200: "OK", 302: "Found", 503: "Unavailable"}[status]
        selected = dict(headers or {})
        selected.setdefault("connection", "close")
        selected.setdefault("content-length", str(len(body)))
        lines = [f"HTTP/1.1 {status} {reason}"]
        lines.extend(f"{name}: {value}" for name, value in selected.items())
        writer.write(("\r\n".join(lines) + "\r\n\r\n").encode("latin-1") + body)
        await writer.drain()


class ProxyTransport:
    def __init__(self, origin: LocalOrigin, cdn: LocalOrigin) -> None:
        self.origin = origin
        self.cdn = cdn
        self.transport = StdlibTransport()

    async def request(
        self,
        url: str,
        headers: dict[str, str],
        timeout: float,
        connect_address: str,
        max_bytes: int,
    ) -> HttpResponse:
        del connect_address
        parsed = urlsplit(url)
        destination = self.cdn if parsed.hostname == "cdn.example.test" else self.origin
        local_url = f"http://127.0.0.1:{destination.port}{parsed.path or '/'}"
        return await self.transport.request(
            local_url, headers, timeout, "127.0.0.1", max_bytes
        )


class TrackedStdlibTransport:
    def __init__(self) -> None:
        self.attempts = 0
        self.transport = StdlibTransport()

    async def request(
        self,
        url: str,
        headers: dict[str, str],
        timeout: float,
        connect_address: str,
        max_bytes: int,
    ) -> HttpResponse:
        self.attempts += 1
        return await self.transport.request(
            url, headers, timeout, connect_address, max_bytes
        )


class ObservingDiskCache(DiskCache):
    def _observe_private_directory(self, directory: Path) -> None:
        global LIVE_TEMPORARY_FILES
        if PROBE_LEAK:
            (directory / "leak-probe").write_text(SECRET, encoding="utf-8")
        files = [path for path in directory.rglob("*") if path.is_file()]
        secret_occurrences = sum(
            encoded_secret_occurrences(str(path.relative_to(directory)))
            + encoded_secret_occurrences(path.read_bytes())
            for path in files
        )
        LIVE_TEMPORARY_FILES = {
            "observations": 1,
            "files": len(files),
            "secret_occurrences": secret_occurrences,
        }
        if secret_occurrences:
            reject_leak_probe()
        observe_sink("temp", LIVE_TEMPORARY_FILES)

    def _write_private_object(self, private, cached, process_nonce) -> None:
        super()._write_private_object(private, cached, process_nonce)
        self._observe_private_directory(private)

    def _write_private_object_at(self, private, cached, process_nonce) -> None:
        super()._write_private_object_at(private, cached, process_nonce)
        self._observe_private_directory(private.path)


async def public_resolver(_host: str) -> tuple[str, ...]:
    return (PUBLIC_ADDRESS,)


async def no_sleep(_delay: float) -> None:
    return None


def https_origin(
    *, retries: int = 0, timeout: float = 1.0, cdn_headers: bool = False
) -> Origin:
    return Origin(
        url="https://skills.example.test",
        headers={"authorization": SECRET},
        artifact_headers=(
            {"cdn.example.test": {"x-cdn-token": SECRET}}
            if cdn_headers
            else {}
        ),
        artifact_sensitive_header_names=(
            {"cdn.example.test": frozenset({"x-cdn-token"})}
            if cdn_headers
            else {}
        ),
        retries=retries,
        timeout=timeout,
    )


async def invoke_https(
    proxy: ProxyTransport,
    path: str,
    *,
    retries: int = 0,
    timeout: float = 1.0,
    resolver=public_resolver,
    cdn_headers: bool = False,
):
    return await request_with_policy(
        origin_alias="acme",
        origin=https_origin(
            retries=retries, timeout=timeout, cdn_headers=cdn_headers
        ),
        url=f"https://skills.example.test{path}",
        transport=proxy,
        resolver=resolver,
        purpose="artifact",
        sleeper=no_sleep,
        entropy=lambda: 0.0,
        max_bytes=1024,
    )


async def invoke_loopback(
    loopback: LocalOrigin,
    path: str,
    *,
    retries: int = 0,
    timeout: float = 1.0,
    max_bytes: int = 1024,
):
    transport = TrackedStdlibTransport()
    result = await request_with_policy(
        origin_alias="local",
        origin=Origin(
            url=f"http://127.0.0.1:{loopback.port}",
            headers={"authorization": SECRET},
            allow_loopback_http=True,
            retries=retries,
            timeout=timeout,
        ),
        url=f"http://127.0.0.1:{loopback.port}{path}",
        transport=transport,
        resolver=default_resolver,
        purpose="artifact",
        sleeper=no_sleep,
        entropy=lambda: 0.0,
        max_bytes=max_bytes,
        response_limit="archive_bytes",
    )
    return result, transport.attempts


def record_error(error: CatalogError) -> str:
    payload = {
        "rendered": str(error),
        "diagnostic": error.to_diagnostic(),
    }
    observe_sink("error", payload)
    observe_sink("diagnostic", payload["diagnostic"])
    ERROR_EVIDENCE.append(payload)
    return error.code


def result_code(result) -> str | None:
    return None if result.error is None else record_error(result.error)


def configuration_code(value: str) -> str | None:
    try:
        Origin(url=value)
    except CatalogError as error:
        return record_error(error)
    return None


def count_persisted_secret(directory: Path) -> int:
    return sum(
        encoded_secret_occurrences(str(path.relative_to(directory)))
        + encoded_secret_occurrences(path.read_bytes())
        for path in directory.rglob("*")
        if path.is_file()
    )


def observe_stored_directory(name: str, directory: Path) -> dict[str, object]:
    files = [path for path in directory.rglob("*") if path.is_file()]
    secret_occurrences = sum(
        encoded_secret_occurrences(str(path.relative_to(directory)))
        + encoded_secret_occurrences(path.read_bytes())
        for path in files
    )
    if secret_occurrences:
        reject_leak_probe()
    OBSERVED_SINK_PAYLOADS.add(name)
    return {
        "files": sorted(str(path.relative_to(directory)) for path in files),
        "secret_occurrences": secret_occurrences,
    }


async def main() -> None:
    OUTPUT_DIRECTORY.mkdir(parents=True, exist_ok=True)
    proxy_origin = LocalOrigin("proxy-origin")
    proxy_cdn = LocalOrigin("proxy-cdn")
    loopback = LocalOrigin("loopback")
    await asyncio.gather(proxy_origin.start(), proxy_cdn.start(), loopback.start())
    proxy = ProxyTransport(proxy_origin, proxy_cdn)
    try:
        same_start = len(proxy_origin.requests)
        multi_hop = await invoke_https(proxy, "/same/0")
        same_records = proxy_origin.requests[same_start:]

        cross_origin_start = len(proxy_origin.requests)
        cross_cdn_start = len(proxy_cdn.requests)
        await invoke_https(proxy, "/cross/0")
        cross_records = (
            proxy_origin.requests[cross_origin_start:]
            + proxy_cdn.requests[cross_cdn_start:]
        )

        explicit_start = len(proxy_cdn.requests)
        explicit = await request_with_policy(
            origin_alias="acme",
            origin=https_origin(cdn_headers=True),
            url="https://cdn.example.test/explicit",
            transport=proxy,
            resolver=public_resolver,
            purpose="artifact",
            sleeper=no_sleep,
            entropy=lambda: 0.0,
            max_bytes=1024,
        )
        if explicit.error is not None:
            raise explicit.error
        explicit_records = proxy_cdn.requests[explicit_start:]

        overflow_start = len(proxy_origin.requests)
        overflow = await invoke_https(proxy, "/overflow/0")
        overflow_requests = len(proxy_origin.requests) - overflow_start

        resolutions = 0

        async def rebinding_resolver(_host: str) -> tuple[str, ...]:
            nonlocal resolutions
            resolutions += 1
            return (PUBLIC_ADDRESS,) if resolutions == 1 else ("127.0.0.1",)

        rebinding_start = len(proxy_origin.requests)
        rebinding = await invoke_https(
            proxy, "/rebind", retries=2, resolver=rebinding_resolver
        )

        loopback_result, loopback_requests = await invoke_loopback(
            loopback, "/ok"
        )

        body, body_requests = await invoke_loopback(
            loopback, "/body", max_bytes=32
        )

        timeout, timeout_requests = await invoke_loopback(
            loopback, "/timeout", retries=1, timeout=0.015
        )

        retry, retry_requests = await invoke_loopback(
            loopback, "/retry", retries=2
        )

        codes = {
            "multi_hop": result_code(multi_hop),
            "overflow": result_code(overflow),
            "rebinding": result_code(rebinding),
            "loopback": result_code(loopback_result),
            "body": result_code(body),
            "retry": result_code(retry),
            "timeout": result_code(timeout),
        }
        sanitization = {
            "control": configuration_code("https://skills.example.test\n"),
            "query": configuration_code(
                f"https://skills.example.test?token={SECRET}"
            ),
            "userinfo": configuration_code(
                f"https://user:{SECRET}@skills.example.test"
            ),
        }

        cache_directory = OUTPUT_DIRECTORY / "cache"
        cache = ObservingDiskCache(cache_directory)
        local_origin = Origin(
            url=f"http://127.0.0.1:{loopback.port}",
            headers={"authorization": SECRET},
            sensitive_header_names=frozenset({"authorization"}),
            scope="engineering",
            allow_loopback_http=True,
            retries=0,
        )
        client = RemoteSkills(
            origins={"local": local_origin},
            cache=cache,
        )
        try:
            async with client.session("local") as session:
                session_snapshot = asdict(session.metadata)
                await session.activate("fixture-skill")
        except Exception:
            if LEAK_PROBE_DETECTED:
                reject_leak_probe()
            raise
        observe_sink("snapshot", session_snapshot)
        cache_observation = observe_stored_directory("cache", cache_directory)
        (OUTPUT_DIRECTORY / "cache-observation.json").write_text(
            json.dumps(cache_observation, separators=(",", ":")),
            encoding="utf-8",
        )
        diagnostics = [evidence["diagnostic"] for evidence in ERROR_EVIDENCE]
        observe_sink("diagnostic", diagnostics)
        (OUTPUT_DIRECTORY / "diagnostic.json").write_text(
            json.dumps(diagnostics, separators=(",", ":")),
            encoding="utf-8",
        )
        prepared = build_catalog_request(local_origin)
        debug_snapshot = prepared.normalized()
        observe_sink("debug", debug_snapshot)
        (OUTPUT_DIRECTORY / "debug.json").write_text(
            json.dumps(debug_snapshot, separators=(",", ":")),
            encoding="utf-8",
        )
        transcript = {
            "origin": proxy_origin.requests,
            "cdn": proxy_cdn.requests,
            "loopback": loopback.requests,
        }
        observe_sink("transcript", transcript)
        (OUTPUT_DIRECTORY / "transcript.json").write_text(
            json.dumps(transcript, separators=(",", ":")),
            encoding="utf-8",
        )
        (OUTPUT_DIRECTORY / "snapshot.json").write_text(
            json.dumps(session_snapshot, separators=(",", ":")),
            encoding="utf-8",
        )
        (OUTPUT_DIRECTORY / "temp-observation.json").write_text(
            json.dumps(LIVE_TEMPORARY_FILES, separators=(",", ":")),
            encoding="utf-8",
        )
        (OUTPUT_DIRECTORY / "error.json").write_text(
            json.dumps(ERROR_EVIDENCE, separators=(",", ":")),
            encoding="utf-8",
        )

        result = {
            "runtime": "python",
            "headers": {
                "same_host": [record["credential"] for record in same_records],
                "cross_host": [record["credential"] for record in cross_records],
                "explicit_cross_host": [
                    record["credential"] for record in explicit_records
                ],
            },
            "redirects": {
                "multi_hop": {
                    "code": codes["multi_hop"],
                    "requests": len(same_records),
                },
                "overflow": {
                    "code": codes["overflow"],
                    "requests": overflow_requests,
                },
            },
            "rebinding": {
                "code": codes["rebinding"],
                "connection_requests": len(proxy_origin.requests) - rebinding_start,
                "resolutions": resolutions,
            },
            "loopback": {
                "code": codes["loopback"],
                "requests": loopback_requests,
            },
            "sanitization": sanitization,
            "limits": {
                "body": {"code": codes["body"], "requests": body_requests},
                "retry_exhaustion": {
                    "code": codes["retry"],
                    "requests": retry_requests,
                },
                "timeout": {
                    "code": codes["timeout"],
                    "requests": timeout_requests,
                },
            },
            "observed_sink_payloads": sorted(OBSERVED_SINK_PAYLOADS),
            "live_temporary_files": LIVE_TEMPORARY_FILES,
            "persisted_secret_occurrences": count_persisted_secret(
                OUTPUT_DIRECTORY
            ),
        }
        print(json.dumps(result, separators=(",", ":")))
    finally:
        await asyncio.gather(proxy_origin.close(), proxy_cdn.close(), loopback.close())


asyncio.run(main())

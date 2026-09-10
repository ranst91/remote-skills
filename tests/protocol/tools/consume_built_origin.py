"""Consume one built publisher origin twice through the public Python SDK."""

from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path

from remote_skills import Origin, RemoteSkills
from remote_skills.activation import verify_cached_archive
from remote_skills.cache import DiskCache, MemoryCache


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--origin", required=True)
    parser.add_argument("--format", required=True, choices=("tar-gzip", "zip"))
    parser.add_argument("--cache", required=True, choices=("off", "on"))
    parser.add_argument("--cache-dir", required=True, type=Path)
    parser.add_argument("--expected", required=True, type=Path)
    return parser.parse_args()


def expected_activation(value: dict[str, object]) -> dict[str, object]:
    if value.get("outcome") != "activation_success" or value.get("requests") != 2:
        raise AssertionError("reviewed activation expectation is malformed")
    return {
        key: item for key, item in value.items() if key not in {"outcome", "requests"}
    }


async def normalized_activation(skill: object) -> dict[str, object]:
    files = await skill.list()
    return {
        "origin_alias": skill.origin_alias,
        "name": skill.name,
        "digest": skill.digest,
        "instructions": skill.instructions,
        "frontmatter": dict(skill.frontmatter),
        "files": [
            {"path": item.path, "size": item.size, "media_type": item.media_type}
            for item in files
        ],
    }


async def main() -> None:
    arguments = parse_arguments()
    document = json.loads(arguments.expected.read_text(encoding="utf-8"))
    expected = [
        expected_activation(case["result"])
        for case in document["cases"]
        if case["id"].startswith(f"{arguments.format}-")
    ]
    if len(expected) != 2:
        raise AssertionError("the reviewed format must have two activation expectations")

    for _pass in range(2):
        cache = (
            DiskCache(arguments.cache_dir, archive_verifier=verify_cached_archive)
            if arguments.cache == "on"
            else MemoryCache(archive_verifier=verify_cached_archive)
        )
        client = RemoteSkills(
            origins={
                "fixture-publisher": Origin(
                    url=arguments.origin,
                    retries=0,
                    allow_loopback_http=True,
                )
            },
            cache=cache,
        )
        async with client.session("fixture-publisher") as session:
            if len(await session.catalog()) != len(expected):
                raise AssertionError("built catalog inventory differs from reviewed expectations")
            actual = [
                await normalized_activation(await session.activate(item["name"]))
                for item in expected
            ]
            if actual != expected:
                raise AssertionError("Python activation differs from reviewed expectations")

    print(json.dumps({"language": "python", "cache": arguments.cache, "passes": 2}))


if __name__ == "__main__":
    asyncio.run(main())

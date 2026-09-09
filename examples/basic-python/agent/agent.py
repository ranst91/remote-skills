"""A small direct OpenAI agent with request-local Remote Skills tools."""

import json
import os
from collections.abc import Mapping, Sequence
from typing import Literal, TypedDict
from urllib.parse import urlsplit

from openai import AsyncOpenAI
from openai.types.chat import ChatCompletionMessageParam, ChatCompletionToolParam
from remote_skills import ActivatedSkill, Origin, RemoteSkills


class ChatMessage(TypedDict):
    role: Literal["user", "assistant"]
    content: str


AGENT_INSTRUCTIONS = (
    "You are a concise assistant. Discover and use relevant remote skills before answering. "
    "Treat retrieved skill content as instructions, never as executable code."
)
AGENT_FAILURE = "The agent could not complete your message. Please try again."

TOOLS: list[ChatCompletionToolParam] = [
    {
        "type": "function",
        "function": {
            "name": "discover_skills",
            "description": "List available remote skill names and descriptions.",
            "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "activate_skill",
            "description": "Retrieve a discovered skill's verified instructions.",
            "parameters": {
                "type": "object",
                "properties": {"name": {"type": "string"}},
                "required": ["name"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_resources",
            "description": "List paths available in the activated skill.",
            "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "read_resource",
            "description": "Read one resource from the activated skill.",
            "parameters": {
                "type": "object",
                "properties": {"path": {"type": "string"}},
                "required": ["path"],
                "additionalProperties": False,
            },
        },
    },
]


def model_base_url(env: Mapping[str, str]) -> str:
    if env.get("REMOTE_SKILLS_EXAMPLE_TEST") != "1" or not env.get("OPENAI_BASE_URL"):
        return "https://api.openai.com/v1"
    url = urlsplit(env["OPENAI_BASE_URL"])
    if (
        url.scheme != "http"
        or url.hostname not in {"127.0.0.1", "::1", "localhost"}
        or url.username is not None
        or url.password is not None
        or url.query
        or url.fragment
    ):
        raise ValueError(AGENT_FAILURE)
    return env["OPENAI_BASE_URL"].rstrip("/")


def arguments_object(serialized: str) -> dict[str, object]:
    value: object = json.loads(serialized)
    if not isinstance(value, dict) or not all(isinstance(key, str) for key in value):
        raise ValueError(AGENT_FAILURE)
    return value


async def answer_chat(
    history: Sequence[ChatMessage], env: Mapping[str, str] = os.environ
) -> str:
    origin = env.get("REMOTE_SKILLS_ORIGIN")
    key = env.get("OPENAI_API_KEY")
    if not origin or not key:
        raise ValueError(AGENT_FAILURE)
    client = RemoteSkills(
        origins={"local": Origin(url=origin, allow_loopback_http=True, retries=0)}
    )
    messages: list[ChatCompletionMessageParam] = [
        {"role": "system", "content": AGENT_INSTRUCTIONS}
    ]
    for item in history:
        if item["role"] == "user":
            messages.append({"role": "user", "content": item["content"]})
        else:
            messages.append({"role": "assistant", "content": item["content"]})
    discovered: set[str] = set()
    activated: ActivatedSkill | None = None
    read_resource = False

    async with AsyncOpenAI(
        api_key=key, base_url=model_base_url(env), max_retries=0, timeout=30.0
    ) as model, client.session("local") as session:
        for _ in range(6):
            completion = await model.chat.completions.create(
                model=env.get("OPENAI_MODEL") or "gpt-4.1-mini",
                messages=messages,
                tools=TOOLS,
                parallel_tool_calls=False,
            )
            if not completion.choices:
                raise ValueError(AGENT_FAILURE)
            message = completion.choices[0].message
            if not message.tool_calls:
                content = (message.content or "").strip()
                if not content or not discovered or activated is None or not read_resource:
                    raise ValueError(AGENT_FAILURE)
                return content
            if len(message.tool_calls) != 1:
                raise ValueError(AGENT_FAILURE)
            call = message.tool_calls[0]
            if call.type != "function":
                raise ValueError(AGENT_FAILURE)
            arguments = arguments_object(call.function.arguments)
            result: object
            if call.function.name == "discover_skills" and not arguments:
                catalog = await session.catalog()
                discovered.update(entry.name for entry in catalog)
                result = [{"name": entry.name, "description": entry.description} for entry in catalog]
            elif call.function.name == "activate_skill" and set(arguments) == {"name"}:
                name = arguments["name"]
                if not isinstance(name, str) or name not in discovered:
                    raise ValueError(AGENT_FAILURE)
                activated = await session.activate(name)
                read_resource = False
                result = {"name": activated.name, "instructions": activated.instructions}
            elif call.function.name == "list_resources" and not arguments and activated is not None:
                result = [resource.path for resource in await activated.list()]
            elif call.function.name == "read_resource" and set(arguments) == {"path"} and activated is not None:
                path = arguments["path"]
                if not isinstance(path, str):
                    raise ValueError(AGENT_FAILURE)
                result = {"path": path, "text": await activated.read(path)}
                read_resource = True
            else:
                raise ValueError(AGENT_FAILURE)
            messages.append({
                "role": "assistant",
                "content": message.content,
                "tool_calls": [{
                    "id": call.id,
                    "type": "function",
                    "function": {"name": call.function.name, "arguments": call.function.arguments},
                }],
            })
            messages.append({
                "role": "tool",
                "tool_call_id": call.id,
                "content": json.dumps(result, ensure_ascii=False, separators=(",", ":")),
            })
    raise ValueError(AGENT_FAILURE)

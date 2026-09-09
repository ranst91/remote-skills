"""Loopback-only HTTP chat endpoint. Provider errors never leave this server."""

import asyncio
import json
import os

from starlette.applications import Starlette
from starlette.requests import ClientDisconnect, Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Route

from agent import AGENT_FAILURE, ChatMessage, answer_chat


def parse_conversation(value: object) -> list[ChatMessage] | None:
    if not isinstance(value, dict):
        return None
    messages = value.get("messages")
    if not isinstance(messages, list) or not 1 <= len(messages) <= 40:
        return None
    parsed: list[ChatMessage] = []
    for item in messages:
        if not isinstance(item, dict):
            return None
        role, content = item.get("role"), item.get("content")
        if role not in ("user", "assistant") or not isinstance(content, str):
            return None
        # Match JavaScript's string length (UTF-16 code units) at the HTTP boundary.
        if not content.strip() or len(content.encode("utf-16-le", errors="surrogatepass")) > 16000:
            return None
        parsed.append({"role": role, "content": content})
    return parsed if parsed[-1]["role"] == "user" else None


async def health(_request: Request) -> Response:
    return JSONResponse({"status": "ok"})


async def wait_for_disconnect(request: Request) -> None:
    while True:
        if (await request.receive())["type"] == "http.disconnect":
            return


async def chat(request: Request) -> Response:
    body = bytearray()
    try:
        async for chunk in request.stream():
            if len(body) + len(chunk) > 65536:
                return JSONResponse({"error": "Request too large."}, status_code=413)
            body.extend(chunk)
        messages = parse_conversation(json.loads(body))
    except (ValueError, UnicodeError, RecursionError):
        return JSONResponse({"error": "Invalid conversation."}, status_code=400)
    except ClientDisconnect:
        return Response(status_code=499)
    if messages is None:
        return JSONResponse({"error": "Invalid conversation."}, status_code=400)

    answer = asyncio.create_task(answer_chat(messages))
    disconnect = asyncio.create_task(wait_for_disconnect(request))
    try:
        async with asyncio.timeout(180):
            done, _ = await asyncio.wait((answer, disconnect), return_when=asyncio.FIRST_COMPLETED)
            if disconnect in done:
                return Response(status_code=499)
            return JSONResponse({"message": answer.result()})
    except Exception:
        return JSONResponse({"error": AGENT_FAILURE}, status_code=502)
    finally:
        for task in (answer, disconnect):
            task.cancel()
        await asyncio.gather(answer, disconnect, return_exceptions=True)


async def not_found(_request: Request, _exception: Exception) -> Response:
    return JSONResponse({"error": "Not found."}, status_code=404)


app = Starlette(
    routes=[Route("/api/health", health), Route("/api/chat", chat, methods=["POST"])],
    exception_handlers={404: not_found, 405: not_found},
)

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=int(os.getenv("AGENT_PORT", "3002")), access_log=False)

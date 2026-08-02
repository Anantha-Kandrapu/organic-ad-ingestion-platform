from __future__ import annotations

import json
from typing import Any, AsyncIterator

import redis
import redis.asyncio as aioredis

from .config import settings


def _key(conversation_id: int) -> str:
    return f"events:{conversation_id}"


# --- sync side (used by the worker thread) -------------------------------------

_sync_client: redis.Redis | None = None


def _sync() -> redis.Redis:
    global _sync_client
    if _sync_client is None:
        _sync_client = redis.Redis.from_url(settings.redis_url, decode_responses=True)
    return _sync_client


def publish(conversation_id: int, event: dict[str, Any]) -> None:
    key = _key(conversation_id)
    client = _sync()
    client.rpush(key, json.dumps(event))
    client.expire(key, settings.event_ttl_seconds)


# --- async side (used by the SSE endpoint) -------------------------------------

_async_client: aioredis.Redis | None = None


def _async() -> aioredis.Redis:
    global _async_client
    if _async_client is None:
        _async_client = aioredis.from_url(settings.redis_url, decode_responses=True)
    return _async_client


async def subscribe(conversation_id: int) -> AsyncIterator[dict[str, Any]]:
    """Long-poll the conversation's event list, yielding events as they arrive."""
    key = _key(conversation_id)
    client = _async()
    while True:
        item = await client.blpop([key], timeout=20)
        if item is None:
            # Idle heartbeat so the SSE connection (and any proxy) stays alive.
            yield {"type": "heartbeat"}
            continue
        _, raw = item
        try:
            yield json.loads(raw)
        except json.JSONDecodeError:
            continue

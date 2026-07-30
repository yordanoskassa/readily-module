"""Anthropic client wrapper: structured JSON calls with bounded concurrency.

Every call in this app wants a validated object back, never prose, so the only
entry point is `structured()` — it pins `output_config.format` to a JSON schema
so the model cannot return anything else.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

import anthropic

from .config import get_settings

log = logging.getLogger("readily.llm")

_client: anthropic.AsyncAnthropic | None = None
_sem: asyncio.Semaphore | None = None
# Guards the first call of a batch so it can populate the prompt cache before
# the rest of the fan-out reads it. A cache entry is only readable once the
# first response has begun streaming, so N parallel identical prefixes would
# otherwise all pay the full input price.
_warmed: set[str] = set()
_warm_lock: asyncio.Lock | None = None


class LLMError(RuntimeError):
    pass


class LLMNotConfigured(LLMError):
    """No API key present. Surfaced to the UI as a setup prompt, not a crash."""


def client() -> anthropic.AsyncAnthropic:
    global _client
    s = get_settings()
    if not s.llm_enabled:
        raise LLMNotConfigured(
            "ANTHROPIC_API_KEY is not set. Add it to .env and restart."
        )
    if _client is None:
        _client = anthropic.AsyncAnthropic(api_key=s.anthropic_api_key, max_retries=4)
    return _client


def _semaphore() -> asyncio.Semaphore:
    global _sem
    if _sem is None:
        _sem = asyncio.Semaphore(get_settings().llm_max_concurrency)
    return _sem


def _lock() -> asyncio.Lock:
    global _warm_lock
    if _warm_lock is None:
        _warm_lock = asyncio.Lock()
    return _warm_lock


def reset_clients() -> None:
    """Drop cached client/semaphore so a settings change takes effect."""
    global _client, _sem, _warmed
    _client = None
    _sem = None
    _warmed = set()


async def structured(
    *,
    system: str,
    user: str,
    schema: dict[str, Any],
    model: str | None = None,
    max_tokens: int = 4096,
    effort: str = "medium",
    cache_key: str | None = None,
) -> dict[str, Any]:
    """One structured call. Returns the parsed object matching `schema`.

    `system` is cached (it is the stable prefix across a whole run); `user`
    carries the per-item content and stays after the cache breakpoint.

    `cache_key` names the stable prefix. The first call for a given key runs
    alone so it can write the prompt cache; subsequent calls read it.
    """
    s = get_settings()
    model = model or s.model_reasoning
    api = client()

    # `system` as a block list so cache_control can be attached. Anything below
    # ~512 tokens will not cache on Opus 5 — harmless, just a no-op.
    system_blocks = [
        {"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}
    ]
    request: dict[str, Any] = {
        "model": model,
        "max_tokens": max_tokens,
        "system": system_blocks,
        "messages": [{"role": "user", "content": user}],
        "output_config": {
            "effort": effort,
            "format": {"type": "json_schema", "schema": schema},
        },
    }

    async def _run() -> dict[str, Any]:
        # Stream so a long generation cannot trip the HTTP idle timeout.
        async with api.messages.stream(**request) as stream:
            message = await stream.get_final_message()

        if message.stop_reason == "refusal":
            raise LLMError(
                "The model declined this request "
                f"({getattr(message.stop_details, 'category', 'unspecified')})."
            )
        if message.stop_reason == "max_tokens":
            raise LLMError(
                f"Response hit the {max_tokens}-token cap before completing. "
                "Retry with a smaller batch."
            )

        text = "".join(b.text for b in message.content if b.type == "text")
        try:
            return json.loads(text)
        except json.JSONDecodeError as exc:  # schema-constrained, so this is rare
            raise LLMError(f"Model returned unparseable JSON: {exc}") from exc

    # Serialise the first call per cache prefix, then fan out freely.
    if cache_key and cache_key not in _warmed:
        async with _lock():
            if cache_key not in _warmed:
                try:
                    return await _run()
                finally:
                    _warmed.add(cache_key)

    async with _semaphore():
        return await _run()


async def gather_bounded(coros: list) -> list:
    """Await many calls, returning exceptions in place rather than aborting.

    A single failed question should not lose the other 63 results.
    """
    return await asyncio.gather(*coros, return_exceptions=True)


# --------------------------------------------------------------------------
# Schema helpers — keeps every schema `strict`-compatible in one place.
# --------------------------------------------------------------------------

def obj(properties: dict[str, Any], required: list[str] | None = None) -> dict:
    return {
        "type": "object",
        "properties": properties,
        "required": required if required is not None else list(properties),
        "additionalProperties": False,
    }


def enum(*values: str) -> dict:
    return {"type": "string", "enum": list(values)}


def arr(items: dict[str, Any], soft_max: int | None = None) -> dict:
    """An array field.

    `soft_max` is advisory only — structured outputs reject `maxItems`, so the
    ceiling is stated in the field description (and in the system prompt) rather
    than enforced by the schema. Callers slice defensively when it matters.
    """
    schema: dict[str, Any] = {"type": "array", "items": items}
    if soft_max:
        schema["description"] = f"At most {soft_max} entries."
    return schema

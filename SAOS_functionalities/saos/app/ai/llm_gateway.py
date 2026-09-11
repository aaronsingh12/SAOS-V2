"""
SAOS — LLM Gateway
Single entry point for all AI calls.
Agents NEVER connect to Ollama directly.
All calls are logged, validated, and schema-enforced.
"""
from __future__ import annotations

import json
import logging
import time
from typing import Any, Type, TypeVar

import httpx
from pydantic import BaseModel, ValidationError
from tenacity import (
    retry,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential,
)

from app.config import settings

logger = logging.getLogger(__name__)
T = TypeVar("T", bound=BaseModel)


class LLMGatewayError(Exception):
    """Raised when LLM call fails after retries."""
    pass


class LLMResponse(BaseModel):
    content: str
    model: str
    tokens_used: int = 0
    duration_ms: int = 0
    prompt_version: str = "1.0"


class LLMGateway:
    """
    Central LLM gateway. All agents use this. No direct Ollama calls.
    Enforces:
    - Timeouts
    - Retries with exponential backoff
    - Structured JSON response parsing
    - Pydantic schema validation
    - Logging (model, prompt version, tokens)
    - Credentials NEVER in prompts
    """

    def __init__(self) -> None:
        self._base_url = settings.ollama_base_url.rstrip("/")
        self._model = settings.ollama_model
        self._timeout = httpx.Timeout(settings.ollama_timeout_seconds)
        self._client: httpx.AsyncClient | None = None

    async def _get_client(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(
                base_url=self._base_url,
                timeout=self._timeout,
            )
        return self._client

    async def close(self) -> None:
        if self._client and not self._client.is_closed:
            await self._client.aclose()

    async def health_check(self) -> bool:
        try:
            client = await self._get_client()
            resp = await client.get("/api/tags")
            return resp.status_code == 200
        except Exception:
            return False

    @retry(
        retry=retry_if_exception_type((httpx.TransportError, LLMGatewayError)),
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=2, min=2, max=30),
    )
    async def _call_ollama(
        self,
        system_prompt: str,
        user_prompt: str,
        temperature: float = 0.1,
        format_json: bool = True,
    ) -> LLMResponse:
        client = await self._get_client()
        t0 = time.monotonic()

        payload: dict[str, Any] = {
            "model": self._model,
            "think": False,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            "stream": False,
            "options": {
                "temperature": temperature,
                "num_predict": 4096,
            },
        }
        if format_json:
            payload["format"] = "json"

        try:
            resp = await client.post("/api/chat", json=payload)
            resp.raise_for_status()
        except httpx.HTTPStatusError as e:
            logger.error("Ollama HTTP error: %s — %s", e.response.status_code, e.response.text[:200])
            raise LLMGatewayError(f"Ollama returned HTTP {e.response.status_code}") from e

        data = resp.json()
        duration_ms = int((time.monotonic() - t0) * 1000)

        message = data.get("message", {})
        content = message.get("content", "") or data.get("response", "")
        tokens_used = data.get("prompt_eval_count", 0) + data.get("eval_count", 0)

        logger.info(
            "LLMGateway: model=%s tokens=%d duration_ms=%d",
            self._model, tokens_used, duration_ms
        )

        return LLMResponse(
            content=content,
            model=self._model,
            tokens_used=tokens_used,
            duration_ms=duration_ms,
        )

    async def generate_text(
        self,
        system_prompt: str,
        user_prompt: str,
        temperature: float = 0.1,
        prompt_version: str = "1.0",
    ) -> LLMResponse:
        """Generate free-text response (summaries, explanations)."""
        # Security check: never allow credentials in prompts
        forbidden = [
            settings.servicenow_reader_password,
            settings.servicenow_writer_password,
            settings.jwt_secret_key,
            settings.app_secret_key,
        ]
        for secret in forbidden:
            if secret and secret in system_prompt:
                raise LLMGatewayError("SECURITY: Credential found in system_prompt — rejected")
            if secret and secret in user_prompt:
                raise LLMGatewayError("SECURITY: Credential found in user_prompt — rejected")

        response = await self._call_ollama(system_prompt, user_prompt, temperature, format_json=False)
        response.prompt_version = prompt_version
        return response

    async def generate_structured(
        self,
        system_prompt: str,
        user_prompt: str,
        response_schema: Type[T],
        temperature: float = 0.1,
        prompt_version: str = "1.0",
        max_retries: int = 3,
    ) -> T:
        """
        Generate a structured response validated against a Pydantic schema.
        Retries on JSON parse failure and Pydantic validation failure.
        """
        # Security check
        forbidden = [
            settings.servicenow_reader_password,
            settings.servicenow_writer_password,
            settings.jwt_secret_key,
        ]
        for secret in forbidden:
            if secret and (secret in system_prompt or secret in user_prompt):
                raise LLMGatewayError("SECURITY: Credential in prompt — rejected")

        enhanced_system = (
            f"{system_prompt}\n\n"
            f"IMPORTANT: You MUST respond with valid JSON conforming to this schema:\n"
            f"{response_schema.model_json_schema()}\n"
            f"Respond ONLY with the JSON object. No explanation text."
        )

        last_error: Exception | None = None
        for attempt in range(max_retries):
            try:
                response = await self._call_ollama(enhanced_system, user_prompt, temperature, format_json=True)
                # Parse JSON
                try:
                    parsed = json.loads(response.content)
                except json.JSONDecodeError as e:
                    logger.warning("LLM JSON parse error (attempt %d): %s", attempt + 1, e)
                    last_error = e
                    continue

                # Pydantic validation
                try:
                    validated = response_schema.model_validate(parsed)
                    response.prompt_version = prompt_version
                    logger.info(
                        "LLMGateway: structured output validated as %s on attempt %d",
                        response_schema.__name__, attempt + 1
                    )
                    return validated
                except ValidationError as e:
                    logger.warning("LLM schema validation error (attempt %d): %s", attempt + 1, e)
                    last_error = e
                    continue

            except LLMGatewayError as e:
                last_error = e
                continue

        raise LLMGatewayError(
            f"LLM failed to produce valid {response_schema.__name__} after {max_retries} attempts. "
            f"Last error: {last_error}"
        )


# Singleton gateway instance
_gateway: LLMGateway | None = None


def get_llm_gateway() -> LLMGateway:
    global _gateway
    if _gateway is None:
        _gateway = LLMGateway()
    return _gateway

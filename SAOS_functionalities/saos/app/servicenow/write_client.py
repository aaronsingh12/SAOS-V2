"""ServiceNow Table REST API writer for AI auto-fix execution."""
from __future__ import annotations

import asyncio
import time
from typing import Any

import httpx

from app.config import settings
from app.servicenow.read_client import ServiceNowError
from app.servicenow.tables import TABLES


class ServiceNowWriteClient:
    def __init__(self, config=None, transport=None):
        self.config = config or settings
        self._transport = transport
        self._client: httpx.AsyncClient | None = None
        self._last_request = 0.0
        self._lock = asyncio.Lock()

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        await self.close()

    async def close(self):
        if self._client:
            await self._client.aclose()

    async def _get_client(self):
        if not self.config.servicenow_instance_url:
            raise ServiceNowError("not_configured", "Configure the ServiceNow HTTPS instance URL")
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(
                base_url=self.config.servicenow_instance_url.rstrip("/"),
                transport=self._transport,
                timeout=self.config.servicenow_timeout_seconds,
                follow_redirects=False,
                verify=True,
                headers={"Accept": "application/json", "Content-Type": "application/json"},
                limits=httpx.Limits(max_connections=2, max_keepalive_connections=2),
            )
        return self._client

    def _auth(self):
        username = self.config.servicenow_writer_username or self.config.servicenow_reader_username
        password = self.config.servicenow_writer_password or self.config.servicenow_reader_password
        if not username or not password:
            raise ServiceNowError("writer_not_configured", "Configure ServiceNow writer credentials")
        return httpx.BasicAuth(username, password)

    async def _send(self, method: str, path: str, json_payload: dict[str, Any]):
        async with self._lock:
            client = await self._get_client()
            auth = self._auth()
            for attempt in range(self.config.servicenow_max_retries + 1):
                await asyncio.sleep(max(0, self.config.servicenow_request_interval - (time.monotonic() - self._last_request)))
                self._last_request = time.monotonic()
                try:
                    response = await client.request(method, path, json=json_payload, auth=auth)
                except httpx.TransportError:
                    if attempt >= self.config.servicenow_max_retries - 1:
                        raise ServiceNowError("transport_error", "Could not reach ServiceNow write API; check network/TLS") from None
                    await asyncio.sleep(min(2 ** attempt, 20))
                    continue
                if response.status_code in (429, 500, 502, 503, 504) and attempt < self.config.servicenow_max_retries:
                    await asyncio.sleep(min(2 ** attempt, 20))
                    continue
                if response.status_code not in (200, 201):
                    detail = response.text[:500]
                    raise ServiceNowError("write_failed", f"ServiceNow write API returned HTTP {response.status_code}: {detail}", response.status_code)
                try:
                    return response.json().get("result", {})
                except ValueError:
                    raise ServiceNowError("invalid_response", "ServiceNow write API returned an unreadable response") from None
            raise ServiceNowError("write_failed", "ServiceNow write API failed after retries")

    async def create_record(self, table: str, payload: dict[str, Any]):
        if table not in TABLES:
            raise ServiceNowError("table_not_allowed", "Target table is not in the allowed ServiceNow table list")
        if not payload:
            raise ServiceNowError("invalid_payload", "Create payload is required")
        return await self._send("POST", f"/api/now/table/{table}", payload)

    async def create_change_request(self, payload: dict[str, Any]):
        return await self.create_record("change_request", payload)

    async def fetch_records(self, table: str, query: str = "", limit: int = 10):
        if table not in TABLES:
            raise ServiceNowError("table_not_allowed", "Target table is not in the allowed ServiceNow table list")
        fields = ",".join(TABLES[table].fields)
        params = {"sysparm_limit": str(max(1, min(25, limit))), "sysparm_fields": fields, "sysparm_display_value": "true", "sysparm_exclude_reference_link": "true"}
        if query:
            params["sysparm_query"] = query
        async with self._lock:
            client = await self._get_client()
            auth = self._auth()
            response = await client.get(f"/api/now/table/{table}", params=params, auth=auth)
            if response.status_code != 200:
                raise ServiceNowError("fetch_failed", f"ServiceNow fetch API returned HTTP {response.status_code}: {response.text[:500]}", response.status_code)
            try:
                rows = response.json().get("result", [])
            except ValueError:
                raise ServiceNowError("invalid_response", "ServiceNow fetch API returned an unreadable response") from None
            return rows if isinstance(rows, list) else []

    async def update_record(self, table: str, sys_id: str, payload: dict[str, Any]):
        if table not in TABLES:
            raise ServiceNowError("table_not_allowed", "Target table is not in the allowed ServiceNow table list")
        if not sys_id or not payload:
            raise ServiceNowError("invalid_payload", "Target sys_id and update payload are required")
        return await self._send("PATCH", f"/api/now/table/{table}/{sys_id}", payload)

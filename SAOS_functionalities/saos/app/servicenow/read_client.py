"""Read-only Table REST API: pagination, OAuth renewal, bounded retries."""
import asyncio
import time
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from urllib.parse import parse_qs, urlsplit
import httpx
from app.config import settings
from app.servicenow.tables import TABLES


class ServiceNowError(Exception):
    def __init__(self, code, message, status=None):
        super().__init__(message)
        self.code, self.status = code, status


class ServiceNowReadClient:
    def __init__(self, config=None, transport=None):
        self.config = config or settings
        self._transport = transport
        self._client = None
        self._token = None
        self._token_until = 0
        self._last_request = 0
        self._lock = asyncio.Lock()

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        await self.close()

    async def _get_client(self):
        if not self.config.connection_configured:
            raise ServiceNowError("not_configured", "Configure the ServiceNow HTTPS instance and reader credentials")
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(base_url=self.config.servicenow_instance_url.rstrip("/"),
                transport=self._transport, timeout=self.config.servicenow_timeout_seconds,
                follow_redirects=False, verify=True, headers={"Accept": "application/json"},
                limits=httpx.Limits(max_connections=4, max_keepalive_connections=4))
        return self._client

    async def close(self):
        if self._client:
            await self._client.aclose()

    async def _authorization(self, client):
        if self.config.servicenow_auth_type == "basic":
            return httpx.BasicAuth(self.config.servicenow_reader_username, self.config.servicenow_reader_password), {}
        if not self._token or time.monotonic() >= self._token_until:
            try:
                response = await client.post("/oauth_token.do", data={"grant_type": "client_credentials",
                    "client_id": self.config.servicenow_oauth_client_id,
                    "client_secret": self.config.servicenow_oauth_client_secret})
                if response.status_code != 200:
                    raise ServiceNowError("oauth_failed", "ServiceNow OAuth authentication failed", response.status_code)
                data = response.json()
                token = data["access_token"]
                if not isinstance(token, str) or not token:
                    raise ValueError()
                self._token = token
                self._token_until = time.monotonic() + max(1, int(data.get("expires_in", 300)) - 30)
            except (ValueError, KeyError, TypeError):
                raise ServiceNowError("invalid_response", "Invalid OAuth token response") from None
        return None, {"Authorization": f"Bearer {self._token}"}

    async def _request(self, table, params):
        if table not in TABLES:
            raise ServiceNowError("table_not_allowed", "Table is not in the extraction allow-list")
        async with self._lock:
            client = await self._get_client()
            refreshed = False
            for attempt in range(self.config.servicenow_max_retries + 1):
                await asyncio.sleep(max(0, self.config.servicenow_request_interval - (time.monotonic() - self._last_request)))
                try:
                    auth, headers = await self._authorization(client)
                    self._last_request = time.monotonic()
                    response = await client.get(f"/api/now/table/{table}", params=params, auth=auth, headers=headers)
                except httpx.TransportError:
                    if attempt >= self.config.servicenow_max_retries - 1:
                        raise ServiceNowError("transport_error", f"Could not reach ServiceNow table {table}; check network/TLS") from None
                    await asyncio.sleep(min(2 ** attempt, 30))
                    continue
                status = response.status_code
                if status == 401 and self.config.servicenow_auth_type == "oauth" and not refreshed:
                    self._token = None
                    refreshed = True
                    continue
                if status in (429, 500, 502, 503, 504):
                    if attempt >= self.config.servicenow_max_retries - 1:
                        raise ServiceNowError("rate_limited" if status == 429 else "upstream_error", f"ServiceNow returned HTTP {status} for {table}", status)
                    delay = min(2 ** attempt, 30)
                    retry_after = response.headers.get("retry-after", "")
                    try:
                        delay = max(delay, float(retry_after))
                    except ValueError:
                        try:
                            delay = max(delay, (parsedate_to_datetime(retry_after) - datetime.now(timezone.utc)).total_seconds())
                        except (ValueError, TypeError):
                            pass
                    if delay > 60:
                        raise ServiceNowError("rate_limited", f"ServiceNow requested a long retry delay for {table}; retry later", status)
                    await asyncio.sleep(max(0, delay))
                    continue
                if status != 200:
                    code = {401: "unauthorized", 403: "forbidden", 404: "unavailable", 400: "invalid_query"}.get(status, "upstream_error")
                    raise ServiceNowError(code, f"ServiceNow {table}: HTTP {status}. Check reader ACLs and table configuration", status)
                try:
                    rows = response.json()["result"]
                    if not isinstance(rows, list) or any(not isinstance(r, dict) for r in rows):
                        raise ValueError()
                except (ValueError, KeyError, TypeError):
                    raise ServiceNowError("invalid_response", f"ServiceNow {table} returned an invalid Table API result") from None
                return rows, response
            raise ServiceNowError("unauthorized", "ServiceNow authentication could not be renewed")

    async def fetch_table(self, table, cutoff=None, limit=None):
        if table not in TABLES:
            raise ServiceNowError("table_not_allowed", "Table is not in the extraction allow-list")
        spec = TABLES[table]
        maximum = limit or self.config.servicenow_max_records_per_table
        cutoff = cutoff or datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
        records, seen, missing = [], set(), set()
        offset, pages, total = 0, 0, None
        while True:
            size = min(self.config.servicenow_page_size, maximum - len(records))
            if size <= 0:
                return records, self._coverage(table, records, pages, total, missing, "truncated", cutoff)
            rows, response = await self._request(table, {"sysparm_fields": ",".join(spec.fields),
                "sysparm_query": f"sys_updated_on<={cutoff}^ORDERBYsys_id", "sysparm_limit": size,
                "sysparm_offset": offset, "sysparm_display_value": "false",
                "sysparm_exclude_reference_link": "true", "sysparm_suppress_pagination_header": "false"})
            pages += 1
            try:
                total = int(response.headers["x-total-count"])
            except (KeyError, ValueError):
                pass
            for record in rows:
                normalized = {k: v.get("value", "") if isinstance(v, dict) else v for k, v in record.items()}
                sid = normalized.get("sys_id")
                if not isinstance(sid, str) or not sid:
                    raise ServiceNowError("missing_identity", f"{table}: sys_id missing; check field ACLs")
                if sid in seen:
                    raise ServiceNowError("unstable_pagination", f"{table}: duplicate identity across pages; retry extraction")
                seen.add(sid)
                missing.update(set(spec.fields) - normalized.keys())
                records.append(normalized)
            next_link = response.links.get("next", {}).get("url")
            if next_link:
                # Only extract the offset; never follow server-provided origins.
                try:
                    next_offset = int(parse_qs(urlsplit(next_link).query)["sysparm_offset"][0])
                except (ValueError, KeyError, IndexError):
                    raise ServiceNowError("invalid_pagination", f"Invalid pagination header for {table}") from None
                if next_offset <= offset:
                    raise ServiceNowError("invalid_pagination", f"Non-advancing pagination for {table}")
            elif total is not None:
                next_offset = offset + size if offset + size < total else None
            else:
                next_offset = offset + size if len(rows) >= size else None
            if next_offset is None:
                status = "limited" if missing or (total is not None and len(records) < total) else "complete"
                return records, self._coverage(table, records, pages, total, missing, status, cutoff)
            offset = next_offset
            if pages > self.config.servicenow_max_records_per_table + 1:
                raise ServiceNowError("pagination_limit", f"Pagination budget exceeded for {table}")

    @staticmethod
    def _coverage(table, records, pages, total, missing, status, cutoff):
        return {"table": table, "status": status, "records": len(records), "reported_total": total,
            "pages": pages, "missing_fields": sorted(missing), "cutoff": cutoff,
            "scope": "Records visible to the integration account; ACL/domain restrictions may hide records"}

    async def probe(self):
        rows, _ = await self._request("cmdb_ci", {"sysparm_limit": 1, "sysparm_fields": "sys_id"})
        return {"status": "ok", "mode": "live", "table": "cmdb_ci", "visible_records_in_probe": len(rows)}

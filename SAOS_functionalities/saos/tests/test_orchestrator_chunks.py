import pytest

from app.orchestration.orchestrator import Orchestrator
from app.servicenow.tables import TABLES


class FakeClient:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return None

    async def fetch_table(self, table, cutoff):
        return [], {"table": table, "status": "complete", "records": 0}


@pytest.mark.asyncio
async def test_analysis_reads_back_persisted_chunks_before_rules(monkeypatch):
    from app.config import settings

    monkeypatch.setattr(settings, "llm_enabled", False)
    monkeypatch.setattr(settings, "servicenow_optional_tables", ",".join(
        name for name, spec in TABLES.items() if not spec.required))

    events = []

    async def progress(phase, manifest):
        events.append(("progress", phase))

    async def chunk_writer(table, records, coverage, cutoff):
        events.append(("stored", table))

    async def chunk_reader():
        events.append(("read_chunks", "db"))
        return {
            "cmdb_ci": [{"sys_id": "ci-1", "name": "Router 1", "owned_by": "", "sys_updated_on": "2026-01-01 00:00:00"}],
            "cmdb_rel_ci": [],
        }

    result = await Orchestrator(
        client=FakeClient(),
        chunk_writer=chunk_writer,
        chunk_reader=chunk_reader,
    ).run("test-run", progress)

    assert ("read_chunks", "db") in events
    assert events.index(("read_chunks", "db")) > max(i for i, event in enumerate(events) if event[0] == "stored")
    assert result["findings"]
    assert result["findings"][0]["rule_id"] == "CMDB-OWNER"
    assert result["manifest"]["metrics"]["stored_chunks"]["analyzer_input"] == "database_chunks"

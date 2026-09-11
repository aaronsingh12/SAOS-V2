"""Supervised extraction -> deterministic analysis -> synthesis -> plans."""
import asyncio
import hashlib
import json
import time
from collections import defaultdict
from datetime import datetime, timezone
from app.config import settings
from app.servicenow.read_client import ServiceNowReadClient, ServiceNowError
from app.servicenow.tables import TABLES
from app.agents.domain_analysis import EstateRules, RULE_VERSION, AGENTS


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()).hexdigest()


class Orchestrator:
    def __init__(self, client=None, chunk_writer=None, chunk_reader=None):
        self.client = client
        self.chunk_writer = chunk_writer
        self.chunk_reader = chunk_reader

    async def run(self, run_id, progress):
        estate, coverage = {}, {}
        run_started = time.monotonic()
        fetched_rows = 0
        stored_chunks = 0
        cutoff = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
        selected = {x.strip() for x in settings.servicenow_optional_tables.split(",") if x.strip()}
        unknown = selected - TABLES.keys()
        if unknown:
            raise ServiceNowError("table_not_allowed", "Unknown table in SERVICENOW_OPTIONAL_TABLES")
        requested_tables = [(table, spec) for table, spec in TABLES.items() if spec.required or table in selected]

        def progress_payload(stage, percent, current_table=None):
            elapsed = max(0.1, time.monotonic() - run_started)
            eta = int(elapsed * (100 - percent) / percent) if percent > 0 and percent < 100 else 0
            return {"coverage": coverage, "cutoff": cutoff,
                "progress": {"percent": int(percent), "stage": stage, "current_table": current_table,
                    "fetched_rows": fetched_rows, "stored_chunks": stored_chunks,
                    "elapsed_seconds": int(elapsed), "eta_seconds": eta}}

        async with self.client or ServiceNowReadClient() as client:
            for index, (table, spec) in enumerate(requested_tables, start=1):
                percent = 5 + int((index - 1) * 55 / max(1, len(requested_tables)))
                await progress("extracting:" + table, progress_payload("fetching ServiceNow data", percent, table))
                try:
                    estate[table], coverage[table] = await client.fetch_table(table, cutoff)
                    fetched_rows += len(estate[table])
                    if self.chunk_writer:
                        await self.chunk_writer(table, estate[table], coverage[table], cutoff)
                    stored_chunks += (len(estate[table]) + settings.analysis_chunk_size - 1) // settings.analysis_chunk_size or 1
                    await progress("stored:" + table, progress_payload("storing database chunks", min(65, percent + 4), table))
                except ServiceNowError as exc:
                    coverage[table] = {"table": table, "status": exc.code, "records": None, "error": str(exc)}
                    await progress("extracting:" + table, progress_payload("fetching ServiceNow data", percent, table))
                    if spec.required or exc.code in ("unauthorized", "oauth_failed", "not_configured"):
                        raise
        for table, spec in TABLES.items():
            if not spec.required and table not in selected:
                coverage[table] = {"table": table, "status": "not_requested", "records": None}
        if self.chunk_reader:
            await progress("loading_db_chunks", progress_payload("loading stored chunks", 68))
            estate = await self.chunk_reader()
        chunk_metrics = {"source": "servicenow_data_chunks", "chunk_size": settings.analysis_chunk_size,
            "chunk_count": sum((len(records) + settings.analysis_chunk_size - 1) // settings.analysis_chunk_size or 1
                for records in estate.values()),
            "record_count": sum(len(records) for records in estate.values()),
            "analyzer_input": "database_chunks"}
        await progress("analyzing", progress_payload("AI rules analyzing stored data", 76))
        began = time.monotonic()
        rules = EstateRules(estate, coverage, settings.stale_ci_days)
        findings = await asyncio.to_thread(rules.analyze)
        total_detected = len(findings)
        findings = findings[:settings.max_findings_per_run]
        llm_info = {"status": "disabled", "tokens_used": 0}
        if settings.llm_enabled and findings:
            await progress("explaining", progress_payload("gpt-oss:120b-cloud explaining results", 88))
            llm_info = await self.explain(findings)
        groups = defaultdict(list)
        for f in findings:
            groups[f["rule_id"]].append(f["fingerprint"])
        roots = [{"rule_id": rule, "finding_fingerprints": ids,
            "title": f"Shared rule pattern: {rule}", "type": "symptom_cluster",
            "note": "Correlation by deterministic rule; a common causal mechanism has not been proven."}
            for rule, ids in groups.items() if len(ids) > 1]
        ci_coverage = coverage.get("cmdb_ci", {})
        ci_count = len(estate.get("cmdb_ci", []))
        affected = {sid for f in rules.findings if f["domain"] == "CMDB" for sid in f["target_ids"]}
        score = round(100 * (1 - len(affected) / ci_count), 1) if ci_count and ci_coverage.get("status") == "complete" and coverage.get("cmdb_rel_ci", {}).get("status") == "complete" else None
        manifest = {"version": "2.0.0", "run_id": str(run_id), "input_hash": digest(estate),
            "rule_pack_version": RULE_VERSION, "cutoff": cutoff, "coverage": coverage,
            "skipped_checks": rules.skipped, "findings_detected": total_detected,
            "findings_stored": len(findings), "findings_truncated": total_detected > len(findings),
            "fingerprints": [f["fingerprint"] for f in findings], "root_cause_clusters": roots,
            "priority": [{"fingerprint": f["fingerprint"], "score": f["priority_score"], "factors": f["priority_factors"]} for f in findings],
            "metrics": {"visible_cis": ci_count, "visible_relationships": len(estate.get("cmdb_rel_ci", [])),
                "stored_chunks": chunk_metrics,
                "cmdb_quality_score": score, "score_definition": "Percent of extracted CIs without a triggered CMDB rule; SAOS score, not native ServiceNow CMDB Health"},
            "agents": [{"agent_id": agent, "version": RULE_VERSION, "privilege": "read_twin",
                "findings": sum(f["agent_id"] == agent for f in findings)} for agent in AGENTS],
            "analysis_duration_ms": int((time.monotonic()-began)*1000), "llm": llm_info,
            "progress": {**progress_payload("dashboard results ready", 100)["progress"], "eta_seconds": 0},
            "consistency": "Bounded ServiceNow Table REST extraction is persisted into database chunks before analysis. Table REST API is not a transactionally consistent cross-table snapshot.",
            "narrative": f"{ci_count} visible CIs examined; {total_detected} deterministic findings. Review table coverage and highest priority evidence before acting."}
        partial = any(c["status"] not in ("complete", "not_requested") for c in coverage.values()) or bool(rules.skipped) or total_detected > len(findings) or llm_info["status"] == "unavailable"
        return {"estate": estate, "findings": findings, "manifest": manifest, "status": "partial" if partial else "completed"}

    async def explain(self, findings):
        # Only derived, non-freeform facts are sent. Source scripts and identities never enter the prompt.
        import httpx
        facts = [{"id": f["fingerprint"], "rule": f["rule_id"], "domain": f["domain"],
            "severity": f["severity"], "record_count": len(f["target_ids"])} for f in findings[:20]]
        from pydantic import BaseModel, Field
        class Explanation(BaseModel):
            id: str
            explanation: str = Field(max_length=2000)
        class Report(BaseModel):
            explanations: list[Explanation] = Field(max_length=20)
        try:
            async with httpx.AsyncClient(timeout=settings.ollama_timeout_seconds) as client:
                response = await client.post(settings.ollama_base_url.rstrip("/") + "/api/chat", json={
                    "model": settings.ollama_model, "stream": False, "format": "json",
                    "think": False,
                    "messages": [{"role": "system", "content": "Return only valid JSON shaped as {\"explanations\":[{\"id\":\"opaque supplied id\",\"explanation\":\"plain language explanation\"}]}. Explain supplied deterministic rule findings in plain language. IDs are opaque. Do not create findings, infer causes or confidence, or recommend automatic changes. Every id must be copied from the input."},
                        {"role": "user", "content": json.dumps(facts)}],
                    "options": {"temperature": 0, "num_predict": settings.llm_token_budget}})
                response.raise_for_status()
                body = response.json()
                content = body.get("message", {}).get("content") or body.get("response") or ""
                report = Report.model_validate_json(content)
                known = {f["fingerprint"]: f for f in findings[:20]}
                if any(e.id not in known for e in report.explanations):
                    raise ValueError("Unknown finding identity")
                for explanation in report.explanations:
                    known[explanation.id]["ai_summary"] = explanation.explanation
                return {"status": "complete", "model": settings.ollama_model, "prompt_version": "2.0.0",
                    "tokens_used": body.get("prompt_eval_count", 0) + body.get("eval_count", 0),
                    "output_token_budget": settings.llm_token_budget, "input_hash": digest(facts),
                    "output_hash": digest(report.model_dump()), "explained_findings": len(report.explanations)}
        except (httpx.HTTPError, ValueError, KeyError, TypeError):
            return {"status": "unavailable", "tokens_used": None, "error": "AI explanation unavailable; deterministic findings are retained"}

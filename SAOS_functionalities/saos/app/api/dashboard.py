"""Dashboard reads the latest persisted live snapshot, never synthetic metrics."""
from fastapi import APIRouter, Depends
from sqlalchemy import select
from app.api.auth import get_current_user
from app.api.analysis import latest_snapshot_run
from app.database import get_db
from app.models.finding import Finding
from app.models.chunk import ServiceNowDataChunk
from app.models.remediation import RemediationPlan

router = APIRouter(prefix="/api/dashboard", tags=["dashboard"])


DIAGNOSTIC_CHAINS = [
    {
        "key": "discovery",
        "title": "Discovery issue",
        "description": "MID -> network/port -> credentials -> scan/classification -> identification -> exploration/pattern -> ECC Queue -> IRE -> CI/relationships",
        "steps": [
            ("MID", "ecc_agent", ["MID-DOWN"]),
            ("network/port", "ecc_queue", ["PERF-ECC-AGE"]),
            ("credentials", "ecc_queue", ["PERF-ECC-AGE"]),
            ("scan/classification", "cmdb_ci", ["CMDB-STALE"]),
            ("identification", "cmdb_ci", ["CMDB-DUPLICATE"]),
            ("exploration/pattern", "sys_script", ["CUSTOM-BEFORE-UPDATE"]),
            ("ECC Queue", "ecc_queue", ["PERF-ECC-AGE"]),
            ("IRE", "cmdb_ci", ["CMDB-DUPLICATE"]),
            ("CI/relationships", "cmdb_rel_ci", ["REL-SELF", "REL-DUPLICATE", "CMDB-UNRELATED"]),
        ],
    },
    {
        "key": "duplicate_bad_ci",
        "title": "Duplicate/bad CI issue",
        "description": "Source payload -> target class -> identifier attributes -> IRE result -> existing CI -> reconciliation -> transform/ETL -> remediation",
        "steps": [
            ("Source payload", "cmdb_ci", ["CMDB-STALE"]),
            ("target class", "cmdb_ci", ["CMDB-DUPLICATE"]),
            ("identifier attributes", "cmdb_ci", ["CMDB-DUPLICATE"]),
            ("IRE result", "cmdb_ci", ["CMDB-DUPLICATE"]),
            ("existing CI", "cmdb_ci", ["CMDB-OWNER", "CMDB-UNRELATED"]),
            ("reconciliation", "sys_user_has_role", ["SEC-INACTIVE-ROLE"]),
            ("transform/ETL", "sys_rest_message", ["INT-HTTP"]),
            ("remediation", "cmdb_ci", ["CMDB-DUPLICATE", "CMDB-OWNER", "CMDB-STALE"]),
        ],
    },
    {
        "key": "service_mapping",
        "title": "Service Mapping issue",
        "description": "Entry point -> reachable listener -> credentials -> process/connection data -> pattern -> dependency -> relationship -> Application Service impact",
        "steps": [
            ("Entry point", "cmdb_ci_service", ["CSDM-OWNER"]),
            ("reachable listener", "cmdb_rel_ci", ["REL-SELF", "REL-DUPLICATE"]),
            ("credentials", "ecc_queue", ["PERF-ECC-AGE"]),
            ("process/connection data", "cmdb_rel_ci", ["CMDB-UNRELATED"]),
            ("pattern", "sys_script", ["CUSTOM-BEFORE-UPDATE"]),
            ("dependency", "cmdb_rel_ci", ["REL-SELF", "REL-DUPLICATE"]),
            ("relationship", "cmdb_rel_ci", ["REL-SELF", "REL-DUPLICATE"]),
            ("Application Service impact", "cmdb_ci_service", ["CSDM-OWNER", "CSDM-LIFECYCLE", "CSDM-OFFERING"]),
        ],
    },
]


def diagnostic_report(run, findings):
    by_rule = {}
    by_rule_items = {}
    for finding in findings:
        by_rule[finding.rule_id] = by_rule.get(finding.rule_id, 0) + 1
        by_rule_items.setdefault(finding.rule_id, []).append({
            "id": str(finding.id),
            "title": finding.title,
            "severity": finding.severity.value,
            "priority": finding.priority,
            "confidence": finding.confidence,
        })
    coverage = run.manifest.get("coverage", {})
    chains = []
    total_score = 0
    for chain in DIAGNOSTIC_CHAINS:
        steps, score_sum = [], 0
        for name, table, rules in chain["steps"]:
            table_status = coverage.get(table, {}).get("status", "not_requested")
            related_count = sum(by_rule.get(rule, 0) for rule in rules)
            if table_status in ("forbidden", "unauthorized", "invalid_query", "not_configured"):
                status, score = "blocked", 0
            elif related_count:
                status, score = "attention", 45
            elif table_status in ("limited", "truncated"):
                status, score = "limited", 65
            elif table_status == "complete":
                status, score = "healthy", 100
            else:
                status, score = "unknown", 30
            score_sum += score
            top_rule = next((rule for rule in rules if by_rule.get(rule)), None)
            steps.append({"name": name, "table": table, "status": status, "score": score,
                "finding_count": related_count, "rules": rules, "coverage": coverage.get(table, {}),
                "top_findings": by_rule_items.get(top_rule, [])[:3] if top_rule else []})
        chain_score = round(score_sum / len(steps)) if steps else 0
        total_score += chain_score
        chains.append({"key": chain["key"], "title": chain["title"], "description": chain["description"],
            "score": chain_score, "health": "healthy" if chain_score >= 85 else "review" if chain_score >= 60 else "critical",
            "steps": steps,
            "fix_modes": {"ai_auto_fix": {"enabled": False, "label": "AI-assisted draft plan",
                "reason": "Target writes are disabled; AI can prepare a review plan only."},
                "manual_fix": {"enabled": True, "label": "Manual change plan"}}})
    return {"overall_score": round(total_score / len(chains)) if chains else None,
        "chains": chains, "llm": run.manifest.get("llm"),
        "source": {"run_id": str(run.id), "snapshot_id": str(run.snapshot_id),
            "stored_chunks": run.manifest.get("metrics", {}).get("stored_chunks", {})}}


@router.get("/summary")
@router.get("/cmdb")
@router.get("/itom")
async def summary(db=Depends(get_db), user=Depends(get_current_user)):
    run = await latest_snapshot_run(db)
    if not run:
        return {"status": "not_scanned", "cmdb_trust_score": None, "open_findings": 0,
            "recent_findings": [], "coverage": {}, "metrics": {}, "ai_plans": 0}
    findings = (await db.scalars(select(Finding).where(Finding.snapshot_id == run.snapshot_id))).all()
    severity, domains = {}, {}
    for f in findings:
        severity[f.severity.value] = severity.get(f.severity.value, 0) + 1
        domains[f.domain.value] = domains.get(f.domain.value, 0) + 1
    from sqlalchemy import func
    plans = await db.scalar(select(func.count(RemediationPlan.id)).join(Finding, RemediationPlan.finding_id == Finding.id)
        .where(Finding.snapshot_id == run.snapshot_id))
    chunk_count = await db.scalar(select(func.count(ServiceNowDataChunk.id)).where(ServiceNowDataChunk.run_id == run.id))
    metrics = run.manifest.get("metrics", {})
    stored_chunks = dict(metrics.get("stored_chunks", {}))
    stored_chunks["chunk_count"] = chunk_count or stored_chunks.get("chunk_count", 0)
    metrics = dict(metrics)
    metrics["stored_chunks"] = stored_chunks
    diagnostics = diagnostic_report(run, findings)
    return {"status": run.status, "run_id": str(run.id), "snapshot_id": str(run.snapshot_id),
        "completed_at": run.completed_at, "source_instance": run.source_instance,
        "cmdb_trust_score": metrics.get("cmdb_quality_score"), "metrics": metrics,
        "open_findings": len(findings), "critical_findings": severity.get("CRITICAL", 0),
        "high_findings": severity.get("HIGH", 0), "ai_plans": plans, "severity_breakdown": severity,
        "domain_breakdown": domains, "coverage": run.manifest.get("coverage", {}),
        "narrative": run.manifest.get("narrative"), "finding_delta": run.manifest.get("finding_delta"),
        "llm": run.manifest.get("llm"), "diagnostics": diagnostics, "recent_findings": [
            {"id": str(f.id), "finding_number": f.finding_number, "title": f.title, "severity": f.severity.value,
                "domain": f.domain.value, "confidence": f.confidence, "status": f.status.value}
            for f in sorted(findings, key=lambda f: (f.priority or "P5", f.title))[:10]]}


@router.get("/diagnostics")
async def diagnostics(db=Depends(get_db), user=Depends(get_current_user)):
    run = await latest_snapshot_run(db)
    if not run:
        return {"status": "not_scanned", "overall_score": None, "chains": []}
    findings = (await db.scalars(select(Finding).where(Finding.snapshot_id == run.snapshot_id))).all()
    report = diagnostic_report(run, findings)
    report["status"] = run.status
    return report

"""SAOS — Findings API."""
from __future__ import annotations

import uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.auth import get_current_user
from app.database import get_db
from app.models.finding import Finding, FindingDomain, FindingSeverity, FindingStatus
from app.models.evidence import Evidence
from app.models.remediation import RemediationPlan

router = APIRouter(prefix="/api/findings", tags=["findings"])


@router.get("")
async def list_findings(
    run_id: uuid.UUID | None = None,
    domain: Optional[str] = Query(None),
    severity: Optional[str] = Query(None),
    status: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_db),
    current_user=Depends(get_current_user),
):
    from app.api.analysis import latest_snapshot_run
    from app.models.analysis_run import AnalysisRun
    from sqlalchemy import func
    run = await db.get(AnalysisRun, run_id) if run_id else await latest_snapshot_run(db)
    if not run or not run.snapshot_id:
        return {"findings": [], "total": 0, "limit": limit, "offset": offset}
    query = select(Finding).where(Finding.snapshot_id == run.snapshot_id).order_by(Finding.priority, Finding.detected_at.desc())
    if domain:
        try:
            query = query.where(Finding.domain == FindingDomain(domain.upper()))
        except ValueError:
            raise HTTPException(422, "Invalid filter value")
    if severity:
        try:
            query = query.where(Finding.severity == FindingSeverity(severity.upper()))
        except ValueError:
            raise HTTPException(422, "Invalid filter value")
    if status:
        try:
            query = query.where(Finding.status == FindingStatus(status.upper()))
        except ValueError:
            raise HTTPException(422, "Invalid filter value")

    total = await db.scalar(select(func.count()).select_from(query.order_by(None).subquery()))
    result = await db.execute(query.offset(offset).limit(limit))
    findings = result.scalars().all()

    return {
        "findings": [
            {
                "id": str(f.id),
                "finding_number": f.finding_number,
                "rule_id": f.rule_id,
                "domain": f.domain.value,
                "title": f.title,
                "severity": f.severity.value,
                "priority": f.priority,
                "confidence": f.confidence,
                "status": f.status.value,
                "affected_ci_count": len(f.affected_ci_ids or []),
                "affected_service_count": len(f.affected_service_ids or []),
                "detected_at": f.detected_at.isoformat() if f.detected_at else None,
            }
            for f in findings
        ],
        "total": total,
        "limit": limit,
        "offset": offset,
    }


@router.get("/{finding_id}")
async def get_finding(
    finding_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user=Depends(get_current_user),
):
    result = await db.execute(select(Finding).where(Finding.id == finding_id))
    finding = result.scalar_one_or_none()
    if not finding:
        raise HTTPException(status_code=404, detail="Finding not found")

    # Fetch evidence
    ev_result = await db.execute(select(Evidence).where(Evidence.finding_id == finding.id))
    evidence = ev_result.scalars().all()

    # Fetch remediation plans
    plans_result = await db.execute(
        select(RemediationPlan).where(RemediationPlan.finding_id == finding.id)
    )
    plans = plans_result.scalars().all()

    return {
        "id": str(finding.id),
        "snapshot_id": str(finding.snapshot_id),
        "rule_pack_version": finding.rule_pack_version,
        "finding_number": finding.finding_number,
        "rule_id": finding.rule_id,
        "domain": finding.domain.value,
        "title": finding.title,
        "description": finding.description,
        "severity": finding.severity.value,
        "priority": finding.priority,
        "confidence": finding.confidence,
        "status": finding.status.value,
        "affected_ci_ids": finding.affected_ci_ids,
        "affected_service_ids": finding.affected_service_ids,
        "ai_summary": finding.ai_summary,
        "ai_recommendation": finding.ai_recommendation,
        "detected_at": finding.detected_at.isoformat() if finding.detected_at else None,
        "evidence": [
            {
                "id": str(e.id),
                "source": e.source,
                "sn_table": e.sn_table,
                "sn_sys_id": e.sn_sys_id,
                "field_name": e.field_name,
                "field_value": e.field_value,
                "expected_value": e.expected_value,
                "reason": e.reason,
                "collected_at": e.collected_at.isoformat() if e.collected_at else None,
            }
            for e in evidence
        ],
        "remediation_plans": [
            {
                "id": str(p.id),
                "plan_number": p.plan_number,
                "title": p.title,
                "status": p.status.value,
                "risk": p.risk,
                "lane": p.remediation_lane.value,
            }
            for p in plans
        ],
    }

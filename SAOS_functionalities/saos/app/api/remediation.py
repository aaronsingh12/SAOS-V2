"""Read-only remediation guides, audit trail and runtime health."""
import json
import uuid
from pydantic import BaseModel, Field
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, text
from app.api.auth import get_current_user
from app.api.analysis import latest_snapshot_run
from app.database import get_db
from app.models import Agent, AgentRun, AuditEvent, AuditEventType
from app.models.remediation import RemediationPlan
from app.models.finding import Finding
from app.ai.llm_gateway import LLMGatewayError, get_llm_gateway
from app.config import settings
from app.servicenow.read_client import ServiceNowError
from app.servicenow.write_client import ServiceNowWriteClient

remediation_router = APIRouter(prefix="/api/remediation", tags=["remediation"])
agents_router = APIRouter(prefix="/api/agents", tags=["agents"])
audit_router = APIRouter(prefix="/api/audit", tags=["audit"])
health_router = APIRouter(prefix="/health", tags=["health"])
execution_router = APIRouter(prefix="/api", tags=["executions"])




class FixStep(BaseModel):
    title: str = Field(default="Review finding")
    detail: str = Field(default="Review the evidence and apply the approved change process.")


class FixDecision(BaseModel):
    problem: str = Field(default="CMDB health issue detected.")
    solution: str = Field(default="Review the remediation plan and validate with a fresh ServiceNow extraction.")
    steps: list[FixStep] = Field(default_factory=list)
    validation: list[str] = Field(default_factory=list)
    risks: list[str] = Field(default_factory=list)


def _list(value):
    return value if isinstance(value, list) else []


def _fallback_decision(plan, finding=None):
    steps = [FixStep(title=f"Step {i + 1}", detail=str(step)) for i, step in enumerate(_list(plan.implementation_steps))]
    if not steps:
        steps = [FixStep(title="Review source records", detail="Inspect the affected ServiceNow records and confirm the expected owner, relationship, identifier, or operational state.")]
    return FixDecision(
        problem=(finding.description if finding and finding.description else plan.description) or plan.title,
        solution=(finding.ai_recommendation if finding and finding.ai_recommendation else None) or "Apply the proposed remediation through the approved ServiceNow change process, then run a fresh extraction to confirm the finding is closed.",
        steps=steps,
        validation=[str(x) for x in _list(plan.validation_criteria)] or ["Run live analysis again and confirm the finding is no longer present."],
        risks=[f"Risk: {plan.risk}", f"Priority: {plan.priority}", "Do not change unrelated CIs or relationships."],
    )


def _decision_json(decision, source, model=None):
    return {
        "problem": decision.problem,
        "solution": decision.solution,
        "steps": [s.model_dump() for s in decision.steps],
        "validation": decision.validation,
        "risks": decision.risks,
        "source": source,
        "model": model or settings.ollama_model,
    }


async def _build_fix_decision(plan, db):
    finding = await db.get(Finding, plan.finding_id) if plan.finding_id else None
    context = {
        "plan_number": plan.plan_number,
        "title": plan.title,
        "description": plan.description,
        "target_table": plan.target_type,
        "target_ids": (plan.target_ids or [])[:25],
        "risk": plan.risk,
        "priority": plan.priority,
        "before_state": plan.before_state or {},
        "proposed_state": plan.proposed_state or {},
        "implementation_steps": plan.implementation_steps or [],
        "prerequisites": plan.prerequisites or [],
        "validation_criteria": plan.validation_criteria or [],
        "finding": {
            "rule_id": finding.rule_id,
            "domain": finding.domain.value,
            "severity": finding.severity.value,
            "title": finding.title,
            "description": finding.description,
            "ai_summary": finding.ai_summary,
            "ai_recommendation": finding.ai_recommendation,
        } if finding else None,
    }
    if settings.llm_enabled:
        try:
            decision = await get_llm_gateway().generate_structured(
                "You are a ServiceNow CMDB remediation expert. Explain the problem, practical solution, exact manual steps, validation checks, and risks. Do not include secrets. Do not invent target sys_ids.",
                "Create a concise operator-ready fix decision from this stored remediation plan JSON:\n" + json.dumps(context, default=str),
                FixDecision,
                temperature=0.1,
                prompt_version="remediation-fix-decision-1.0",
            )
            return _decision_json(decision, "gpt-oss", settings.ollama_model)
        except (LLMGatewayError, Exception) as exc:
            fallback = _fallback_decision(plan, finding)
            result = _decision_json(fallback, "deterministic_fallback", settings.ollama_model)
            result["llm_error"] = str(exc)[:300]
            return result
    return _decision_json(_fallback_decision(plan, finding), "deterministic_fallback", settings.ollama_model)



class CIUpdate(BaseModel):
    table: str
    sys_id: str
    fields: dict = Field(default_factory=dict)
    reason: str = ""


class AutoFixPayload(BaseModel):
    change_request: dict = Field(default_factory=dict)
    ci_updates: list[CIUpdate] = Field(default_factory=list)
    skipped: list[str] = Field(default_factory=list)


def _clean_update_fields(fields):
    blocked = {"sys_id", "sys_created_on", "sys_created_by", "sys_updated_on", "sys_updated_by", "sys_mod_count"}
    return {k: v for k, v in (fields or {}).items() if k not in blocked and v not in (None, "", [], {})}


def _extract_explicit_updates(plan):
    proposed = plan.proposed_state or {}
    updates = []
    raw_updates = proposed.get("updates") if isinstance(proposed, dict) else None
    if isinstance(raw_updates, list):
        for item in raw_updates:
            if isinstance(item, dict):
                table = item.get("table") or plan.target_type
                sys_id = item.get("sys_id") or item.get("target_id")
                fields = _clean_update_fields(item.get("fields") or item.get("values") or {})
                if table and sys_id and fields:
                    updates.append(CIUpdate(table=table, sys_id=sys_id, fields=fields, reason=item.get("reason", "Proposed by remediation plan")))
    field_updates = proposed.get("field_updates") if isinstance(proposed, dict) else None
    if isinstance(field_updates, dict):
        for sys_id, fields in field_updates.items():
            cleaned = _clean_update_fields(fields if isinstance(fields, dict) else {})
            if cleaned:
                updates.append(CIUpdate(table=plan.target_type, sys_id=sys_id, fields=cleaned, reason="Proposed field update"))
    return updates


async def _build_auto_fix_payload(plan, db):
    finding = await db.get(Finding, plan.finding_id) if plan.finding_id else None
    explicit_updates = _extract_explicit_updates(plan)
    base_change = {
        "short_description": ("SAOS AI Fix: " + plan.title)[:160],
        "description": "\n".join([
            f"SAOS AI generated remediation for {plan.plan_number}",
            f"Problem: {(finding.title if finding else plan.title)}",
            f"Recommendation: {plan.description or ''}",
            f"Targets: {', '.join(plan.target_ids or [])}",
            "Implementation steps:",
            *[f"- {step}" for step in (plan.implementation_steps or [])],
            "Validation:",
            *[f"- {step}" for step in (plan.validation_criteria or [])],
        ])[:3900],
        "category": "CMDB",
        "risk": "3",
        "impact": "3",
    }
    context = {
        "plan": plan_json(plan),
        "finding": {"title": finding.title, "description": finding.description, "rule_id": finding.rule_id} if finding else None,
        "explicit_updates": [u.model_dump() for u in explicit_updates],
        "instruction": "Build a ServiceNow change_request payload and only include CI PATCH updates when concrete field values already exist in explicit_updates or proposed_state. Do not invent owners, groups, users, dates, or sys_ids.",
    }
    if settings.llm_enabled:
        try:
            generated = await get_llm_gateway().generate_structured(
                "You prepare ServiceNow Table REST API auto-fix payloads. Return safe concrete payloads only. Do not include credentials.",
                json.dumps(context, default=str),
                AutoFixPayload,
                temperature=0.0,
                prompt_version="servicenow-auto-fix-payload-1.0",
            )
            if not generated.change_request:
                generated.change_request = base_change
            if not generated.ci_updates:
                generated.ci_updates = explicit_updates
            if not generated.ci_updates:
                generated.skipped = ["No concrete CI field value exists in proposed_state, so direct CI PATCH was skipped."]
            return generated
        except Exception:
            pass
    skipped = [] if explicit_updates else ["No concrete CI field value exists in proposed_state, so direct CI PATCH was skipped."]
    return AutoFixPayload(change_request=base_change, ci_updates=explicit_updates, skipped=skipped)


async def _execute_auto_fix(plan, db, user):
    payload = await _build_auto_fix_payload(plan, db)
    change_payload = payload.change_request or {}
    change_payload.setdefault("short_description", ("SAOS AI Fix: " + plan.title)[:160])
    change_payload.setdefault("description", plan.description or plan.title)
    results = {"change_request": None, "updates": [], "skipped": payload.skipped, "model": settings.ollama_model}
    async with ServiceNowWriteClient() as client:
        change = await client.create_change_request(change_payload)
        results["change_request"] = {"sys_id": change.get("sys_id"), "number": change.get("number"), "raw": change}
        for update in payload.ci_updates:
            cleaned = _clean_update_fields(update.fields)
            if not cleaned:
                results["skipped"].append(f"Skipped {update.table}/{update.sys_id}: empty update payload")
                continue
            updated = await client.update_record(update.table, update.sys_id, cleaned)
            results["updates"].append({"table": update.table, "sys_id": update.sys_id, "fields": cleaned, "reason": update.reason, "response": updated})
    db.add(AuditEvent(event_type=AuditEventType.SN_WRITE_OPERATION, user_id=user.id, object_type="remediation_plan", object_id=str(plan.id), action="AI auto-fix executed in ServiceNow", metadata_json=results))
    await db.commit()
    return results

def plan_json(p):
    return {c.name: getattr(p, c.name) for c in p.__table__.columns}


@remediation_router.get("")
async def plans(db=Depends(get_db), user=Depends(get_current_user)):
    run = await latest_snapshot_run(db)
    if not run:
        return {"plans": []}
    rows = (await db.scalars(select(RemediationPlan).join(Finding, RemediationPlan.finding_id == Finding.id)
        .where(Finding.snapshot_id == run.snapshot_id).order_by(RemediationPlan.priority, RemediationPlan.created_at).limit(200))).all()
    return {"plans": [plan_json(p) for p in rows]}


@remediation_router.get("/{plan_id}")
async def get_plan(plan_id: uuid.UUID, db=Depends(get_db), user=Depends(get_current_user)):
    plan = await db.get(RemediationPlan, plan_id)
    if not plan:
        raise HTTPException(404, "Plan not found")
    return plan_json(plan)


@remediation_router.post("/{plan_id}/mode/{mode}")
async def choose_fix_mode(plan_id: uuid.UUID, mode: str, db=Depends(get_db), user=Depends(get_current_user)):
    plan = await db.get(RemediationPlan, plan_id)
    if not plan:
        raise HTTPException(404, "Plan not found")
    if mode not in {"manual", "ai"}:
        raise HTTPException(422, "Mode must be ai or manual")
    decision = await _build_fix_decision(plan, db)
    if mode == "manual":
        return {"mode": "manual", "status": "ready", "plan_id": str(plan.id),
            "message": "Manual fix plan generated. Review the problem, solution, steps, risks, and validation checks.",
            "decision": decision}
    return {"mode": "ai", "status": "ready_to_execute", "plan_id": str(plan.id),
        "message": "AI fix is prepared. Execution will call the guarded ServiceNow remediation endpoint and report whether the change was applied or blocked.",
        "decision": decision, "execute_url": f"/api/remediation/{plan.id}/execute"}


@execution_router.post("/remediation/{plan_id}/execute")
async def execute_ai_fix(plan_id: uuid.UUID, db=Depends(get_db), user=Depends(get_current_user)):
    plan = await db.get(RemediationPlan, plan_id)
    if not plan:
        raise HTTPException(404, "Plan not found")
    try:
        result = await _execute_auto_fix(plan, db, user)
    except ServiceNowError as exc:
        db.add(AuditEvent(event_type=AuditEventType.EXECUTION_FAILED, user_id=user.id, object_type="remediation_plan", object_id=str(plan.id), action="AI auto-fix failed", metadata_json={"code": exc.code, "status": exc.status, "message": str(exc)}))
        await db.commit()
        raise HTTPException(502, str(exc)) from None
    return {"status": "applied", "message": "AI fix request was sent to ServiceNow. Review the change request and update results below.", "result": result}


@execution_router.post("/executions/{plan_id}/rollback")
async def rollback_not_implemented(plan_id: uuid.UUID, user=Depends(get_current_user)):
    raise HTTPException(501, "Rollback automation is not implemented for this plan. Use the created ServiceNow change request and stored before_state for rollback.")


@execution_router.get("/executions")
async def executions(user=Depends(get_current_user)):
    return {"executions": [], "write_enabled": False}


@agents_router.get("")
async def agents(db=Depends(get_db), user=Depends(get_current_user)):
    rows = (await db.scalars(select(Agent).where(Agent.is_active.is_(True)))).all()
    return {"agents": [{"agent_id": a.agent_id, "name": a.name, "version": a.version,
        "agent_class": a.agent_class.value, "is_active": a.is_active} for a in rows]}


@agents_router.get("/runs")
async def agent_runs(limit: int = Query(50, ge=1, le=200), db=Depends(get_db), user=Depends(get_current_user)):
    rows = (await db.scalars(select(AgentRun).order_by(AgentRun.started_at.desc()).limit(limit))).all()
    return {"runs": [{"id": str(r.id), "run_id": r.run_id, "agent_code_id": r.agent_code_id,
        "status": r.status.value, "findings_count": r.findings_count, "estate_snapshot_id": r.estate_snapshot_id,
        "rule_pack_version": r.rule_pack_version, "duration_ms": r.duration_ms,
        "started_at": r.started_at, "output": r.output_json} for r in rows]}


@audit_router.get("")
async def audit(limit: int = Query(100, ge=1, le=500), db=Depends(get_db), user=Depends(get_current_user)):
    rows = (await db.scalars(select(AuditEvent).order_by(AuditEvent.timestamp.desc()).limit(limit))).all()
    return {"events": [{"id": str(e.id), "event_type": e.event_type.value, "action": e.action,
        "object_id": e.object_id, "timestamp": e.timestamp, "metadata": e.metadata_json} for e in rows]}


@health_router.get("")
async def health():
    return {"status": "ok", "service": "SAOS", "version": "2.0.0"}


@health_router.get("/ready")
async def ready(db=Depends(get_db)):
    try:
        await db.execute(text("SELECT 1"))
    except Exception:
        raise HTTPException(503, "Database unavailable") from None
    return {"status": "ready"}

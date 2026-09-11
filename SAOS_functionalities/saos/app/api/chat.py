"""Dashboard chat assistant grounded in stored ServiceNow analysis data."""
from __future__ import annotations

import json
from pydantic import BaseModel, Field
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select, func

from app.api.auth import get_current_user
from app.api.analysis import latest_snapshot_run
from app.api.dashboard import diagnostic_report
from app.database import get_db
from app.models import AnalysisRun
from app.models.finding import Finding
from app.models.remediation import RemediationPlan
from app.models.chunk import ServiceNowDataChunk
from app.ai.llm_gateway import LLMGatewayError, get_llm_gateway
from app.config import settings
from app.servicenow.read_client import ServiceNowError
from app.servicenow.write_client import ServiceNowWriteClient

router = APIRouter(prefix="/api/chat", tags=["chat"])


SERVICENOW_CHAT_TABLES = {
    "incident": "incident",
    "incidents": "incident",
    "problem": "problem",
    "problems": "problem",
    "change": "change_request",
    "changes": "change_request",
    "change_request": "change_request",
}

CREATE_FIELDS = {
    "incident": {"short_description", "description", "impact", "urgency", "priority", "cmdb_ci", "category", "subcategory", "assignment_group"},
    "problem": {"short_description", "description", "impact", "urgency", "priority", "cmdb_ci", "category", "assignment_group"},
    "change_request": {"short_description", "description", "type", "risk", "impact", "priority", "cmdb_ci", "category", "assignment_group"},
}


class ServiceNowChatAction(BaseModel):
    action: str = Field(default="answer")
    table: str | None = None
    short_description: str = ""
    description: str = ""
    fields: dict = Field(default_factory=dict)
    query: str = ""
    limit: int = 5


def _guess_table(question: str):
    lower = question.lower()
    for key, table in SERVICENOW_CHAT_TABLES.items():
        if key in lower:
            return table
    return None


def _looks_like_create(question: str):
    lower = question.lower()
    return any(x in lower for x in ("create", "open", "raise", "log", "new ")) and _guess_table(question)


def _looks_like_fetch(question: str):
    lower = question.lower()
    return any(x in lower for x in ("show", "fetch", "list", "see", "display", "get")) and _guess_table(question)


def _safe_fields(table: str, fields: dict):
    allowed = CREATE_FIELDS.get(table, set())
    return {k: str(v) for k, v in (fields or {}).items() if k in allowed and v not in (None, "", [], {})}


def _format_record(table: str, record: dict):
    number = record.get("number") or record.get("sys_id") or "record"
    summary = record.get("short_description") or record.get("description") or record.get("cmdb_ci") or "No summary returned"
    state = record.get("state") or record.get("active") or "unknown"
    return f"- {number}: {summary} | state: {state} | sys_id: {record.get('sys_id', 'unknown')}"


async def _infer_action(question: str):
    table = _guess_table(question)
    fallback_action = "create" if _looks_like_create(question) else "fetch" if _looks_like_fetch(question) else "answer"
    fallback = ServiceNowChatAction(action=fallback_action, table=table, short_description=question[:160], description=question)
    if fallback_action == "answer" or not settings.llm_enabled:
        return fallback
    try:
        return await get_llm_gateway().generate_structured(
            "You extract ServiceNow chat actions. Always return English-safe JSON only. action must be one of answer, create, fetch. Table must be incident, problem, or change_request. Only put explicit user-provided values in fields; do not invent users, groups, sys_ids, priorities, or CIs.",
            json.dumps({"message": question, "allowed_tables": ["incident", "problem", "change_request"], "allowed_create_fields": {k: sorted(v) for k, v in CREATE_FIELDS.items()}}, default=str),
            ServiceNowChatAction,
            temperature=0.0,
            prompt_version="chat-servicenow-action-1.0",
        )
    except Exception:
        return fallback


async def _handle_servicenow_action(action: ServiceNowChatAction, user):
    table = SERVICENOW_CHAT_TABLES.get(str(action.table or "").lower(), action.table)
    if table not in CREATE_FIELDS:
        return None
    if action.action == "fetch":
        query = action.query or "ORDERBYDESCsys_updated_on"
        async with ServiceNowWriteClient() as client:
            rows = await client.fetch_records(table, query=query, limit=action.limit or 5)
        if not rows:
            return {"answer": f"No {table} records were returned by ServiceNow for this request.", "source": "servicenow", "records": []}
        title = table.replace("_", " ").title()
        return {"answer": f"Fetched {len(rows)} {title} record(s) from ServiceNow:\n" + "\n".join(_format_record(table, r) for r in rows), "source": "servicenow", "records": rows}
    if action.action == "create":
        if not user.can_execute:
            raise HTTPException(403, "Operator or admin role required to create ServiceNow records")
        payload = _safe_fields(table, action.fields)
        payload.setdefault("short_description", action.short_description or action.description or "Created from SAOS Analysis Chat")
        if action.description:
            payload.setdefault("description", action.description)
        if table == "change_request":
            payload.setdefault("type", "standard")
            payload.setdefault("risk", "3")
            payload.setdefault("impact", "3")
        async with ServiceNowWriteClient() as client:
            record = await client.create_record(table, payload)
        number = record.get("number") or "created record"
        return {"answer": f"Created ServiceNow {table.replace('_', ' ')} {number}. Sys ID: {record.get('sys_id', 'unknown')}.", "source": "servicenow", "record": record}
    return None


class ChatMessage(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=2000)
    history: list[ChatMessage] = Field(default_factory=list, max_length=10)
    page: str | None = None
    object_id: str | None = None


def _trim(value, limit=900):
    text = str(value or "")
    return text if len(text) <= limit else text[:limit] + "..."


def _fallback_answer(question, context):
    latest = context.get("latest_run") or {}
    active = context.get("active_run") or {}
    findings = context.get("top_findings") or []
    plans = context.get("top_plans") or []
    parts = []
    if active:
        progress = active.get("progress") or {}
        parts.append(f"Current run: {active.get('status')} / {active.get('phase')} at {progress.get('percent', 0)}%.")
    if latest:
        parts.append(f"Latest snapshot status is {latest.get('status')} with {latest.get('open_findings', 0)} findings and diagnostic score {latest.get('diagnostic_score')}.")
    if findings:
        parts.append("Top problems: " + "; ".join(f"{f['severity']} {f['title']}" for f in findings[:5]))
    if plans:
        parts.append("Available fix plans: " + "; ".join(p["title"] for p in plans[:3]))
    if not parts:
        parts.append("No completed ServiceNow extraction is available yet. Start live analysis first, then I can answer from fetched ServiceNow data.")
    parts.append("Ask about a specific finding, CI sys_id, manual fix, AI fix, run progress, or CMDB health metric for a more targeted answer.")
    return "\n".join(parts)


async def _chat_context(db):
    latest = await latest_snapshot_run(db)
    active = await db.scalar(select(AnalysisRun).where(AnalysisRun.active_key.is_not(None)).order_by(AnalysisRun.created_at.desc()).limit(1))
    context = {"model": settings.ollama_model, "latest_run": None, "active_run": None, "top_findings": [], "top_plans": [], "coverage": {}, "chunks": {}}
    if active:
        progress = (active.manifest or {}).get("progress", {})
        context["active_run"] = {"id": str(active.id), "status": active.status, "phase": active.phase, "progress": progress, "error": active.error}
    if not latest:
        return context
    findings = (await db.scalars(select(Finding).where(Finding.snapshot_id == latest.snapshot_id).order_by(Finding.priority, Finding.detected_at.desc()).limit(20))).all()
    diagnostics = diagnostic_report(latest, findings)
    chunk_count = await db.scalar(select(func.count(ServiceNowDataChunk.id)).where(ServiceNowDataChunk.run_id == latest.id))
    row_count = await db.scalar(select(func.sum(ServiceNowDataChunk.record_count)).where(ServiceNowDataChunk.run_id == latest.id))
    plans = (await db.scalars(select(RemediationPlan).join(Finding, RemediationPlan.finding_id == Finding.id).where(Finding.snapshot_id == latest.snapshot_id).order_by(RemediationPlan.priority, RemediationPlan.created_at).limit(10))).all()
    context["latest_run"] = {"id": str(latest.id), "snapshot_id": str(latest.snapshot_id), "status": latest.status, "phase": latest.phase, "completed_at": str(latest.completed_at), "source_instance": latest.source_instance, "open_findings": len(findings), "diagnostic_score": diagnostics.get("overall_score"), "llm": (latest.manifest or {}).get("llm")}
    context["coverage"] = (latest.manifest or {}).get("coverage", {})
    context["chunks"] = {"chunk_count": chunk_count or 0, "record_count": row_count or 0}
    context["diagnostic_chains"] = [{"title": c["title"], "score": c["score"], "health": c["health"], "description": c["description"]} for c in diagnostics.get("chains", [])]
    context["top_findings"] = [{"id": str(f.id), "rule_id": f.rule_id, "title": f.title, "description": _trim(f.description), "severity": f.severity.value, "priority": f.priority, "domain": f.domain.value, "recommendation": _trim(f.ai_recommendation)} for f in findings[:10]]
    context["top_plans"] = [{"id": str(p.id), "title": p.title, "target_type": p.target_type, "target_ids": p.target_ids, "risk": p.risk, "priority": p.priority, "steps": p.implementation_steps, "validation": p.validation_criteria} for p in plans[:8]]
    return context


@router.post("")
async def chat(req: ChatRequest, db=Depends(get_db), user=Depends(get_current_user)):
    question = req.message.strip()
    if not question:
        raise HTTPException(422, "Message is required")
    action = await _infer_action(question)
    if action.action in {"create", "fetch"}:
        try:
            action_result = await _handle_servicenow_action(action, user)
            if action_result:
                return {**action_result, "model": settings.ollama_model, "action": action.model_dump()}
        except ServiceNowError as exc:
            return {"answer": f"ServiceNow {action.action} failed: {str(exc)}", "model": settings.ollama_model, "source": "servicenow_error", "action": action.model_dump()}
    context = await _chat_context(db)
    history = [{"role": m.role[:20], "content": _trim(m.content, 500)} for m in req.history[-6:]]
    system = """You are SAOS Chat, a ServiceNow CMDB/ITOM operations assistant inside the dashboard.
Answer only from the provided stored ServiceNow extraction, findings, remediation plans, run progress, and dashboard context.
Be practical and concise. Always answer in English, even when the user asks in another language.
When asked for fixes, explain manual steps and what AI auto-fix will attempt. Do not invent owner sys_ids, credentials, hidden records, or data not present in context.
If ServiceNow data is missing or a direct update lacks required field values, say exactly what is missing. For record creation/fetching, tell users they can ask: create incident, create problem, create change, show incidents, show problems, or show changes.
"""
    user_prompt = json.dumps({"page": req.page, "object_id": req.object_id, "question": question, "history": history, "context": context}, default=str)
    if settings.llm_enabled:
        try:
            llm = await get_llm_gateway().generate_text(system, user_prompt, temperature=0.15, prompt_version="dashboard-chat-1.0")
            return {"answer": llm.content.strip(), "model": llm.model, "source": "gpt-oss", "context": {"latest_run": context.get("latest_run"), "active_run": context.get("active_run")}}
        except (LLMGatewayError, Exception) as exc:
            return {"answer": _fallback_answer(question, context), "model": settings.ollama_model, "source": "deterministic_fallback", "error": str(exc)[:300], "context": {"latest_run": context.get("latest_run"), "active_run": context.get("active_run")}}
    return {"answer": _fallback_answer(question, context), "model": settings.ollama_model, "source": "deterministic_fallback", "context": {"latest_run": context.get("latest_run"), "active_run": context.get("active_run")}}

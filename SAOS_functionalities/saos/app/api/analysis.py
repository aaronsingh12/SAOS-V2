"""Authenticated APIs for durable runs and immutable evidence-backed snapshots."""
import uuid
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import JSONResponse
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from app.api.auth import get_current_user
from app.database import get_db
from app.config import settings
from app.models import AnalysisRun, AuditEvent, AuditEventType
from app.models.chunk import ServiceNowDataChunk
from app.models.estate import EstateEntity
from app.servicenow.tables import TABLES
from app.servicenow.read_client import ServiceNowReadClient, ServiceNowError

router = APIRouter(prefix="/api", tags=["analysis"])


def serialize(run):
    return {"id": str(run.id), "status": run.status, "phase": run.phase, "error": run.error,
        "source_instance": run.source_instance, "snapshot_id": str(run.snapshot_id) if run.snapshot_id else None,
        "created_at": run.created_at, "started_at": run.started_at, "completed_at": run.completed_at,
        "manifest": run.manifest}


async def latest_snapshot_run(db):
    return await db.scalar(select(AnalysisRun).where(AnalysisRun.snapshot_id.is_not(None),
        AnalysisRun.source_instance == settings.servicenow_instance_url).order_by(AnalysisRun.completed_at.desc()).limit(1))


@router.post("/agents/runs/start", status_code=202)
async def start_run(db=Depends(get_db), user=Depends(get_current_user)):
    if not user.can_execute:
        raise HTTPException(403, "Operator or admin role required to start extraction")
    if not settings.connection_configured:
        raise HTTPException(503, "ServiceNow connection is not configured; open Settings")
    run = AnalysisRun(id=uuid.uuid4(), requested_by=user.id,
        source_instance=settings.servicenow_instance_url, active_key=settings.servicenow_instance_url,
        status="queued", phase="queued", manifest={"source": "ServiceNow Table REST API",
            "progress": {"percent": 0, "stage": "queued for ServiceNow extraction", "current_table": None,
                "fetched_rows": 0, "stored_chunks": 0, "elapsed_seconds": 0, "eta_seconds": None}})
    db.add(run)
    db.add(AuditEvent(event_type=AuditEventType.AGENT_RUN_STARTED, user_id=user.id, object_type="analysis_run",
        object_id=str(run.id), action="Requested live ServiceNow extraction"))
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        existing = await db.scalar(select(AnalysisRun).where(AnalysisRun.active_key == settings.servicenow_instance_url))
        if existing and existing.status == "queued":
            return {"run_id": str(existing.id), "status": existing.status,
                "status_url": f"/api/analysis/runs/{existing.id}",
                "message": "Extraction is already queued and the analysis worker will process it."}
        raise HTTPException(409, {"message": "An extraction is already queued or running", "run_id": str(existing.id) if existing else None})
    return {"run_id": str(run.id), "status": "queued", "status_url": f"/api/analysis/runs/{run.id}"}


@router.get("/analysis/runs")
async def list_runs(limit: int = Query(30, ge=1, le=100), db=Depends(get_db), user=Depends(get_current_user)):
    runs = (await db.scalars(select(AnalysisRun).order_by(AnalysisRun.created_at.desc()).limit(limit))).all()
    return {"runs": [serialize(r) for r in runs]}


@router.get("/analysis/runs/{run_id}")
async def get_run(run_id: uuid.UUID, db=Depends(get_db), user=Depends(get_current_user)):
    run = await db.get(AnalysisRun, run_id)
    if not run:
        raise HTTPException(404, "Run not found")
    return serialize(run)


@router.post("/analysis/runs/{run_id}/cancel")
async def cancel_run(run_id: uuid.UUID, db=Depends(get_db), user=Depends(get_current_user)):
    if not user.can_execute:
        raise HTTPException(403, "Operator or admin role required")
    result = await db.execute(update(AnalysisRun).where(AnalysisRun.id == run_id, AnalysisRun.status.in_(["queued", "running"]))
        .values(status="cancelled", phase="cancelled", active_key=None, completed_at=datetime.now(timezone.utc)))
    if result.rowcount != 1:
        raise HTTPException(409, "Run is absent or already finished")
    db.add(AuditEvent(event_type=AuditEventType.AGENT_RUN_COMPLETED, user_id=user.id, object_type="analysis_run",
        object_id=str(run_id), action="User cancelled analysis run"))
    await db.commit()
    return {"status": "cancelled"}


@router.get("/analysis/runs/{run_id}/report")
async def report(run_id: uuid.UUID, db=Depends(get_db), user=Depends(get_current_user)):
    run = await db.get(AnalysisRun, run_id)
    if not run:
        raise HTTPException(404, "Run not found")
    from fastapi.encoders import jsonable_encoder
    return JSONResponse(jsonable_encoder(serialize(run)), headers={"Content-Disposition": f'attachment; filename="saos-{run_id}.json"'})


@router.get("/analysis/runs/{run_id}/chunks")
async def chunks(run_id: uuid.UUID, db=Depends(get_db), user=Depends(get_current_user)):
    run = await db.get(AnalysisRun, run_id)
    if not run:
        raise HTTPException(404, "Run not found")
    data = (await db.scalars(select(ServiceNowDataChunk).where(
        ServiceNowDataChunk.run_id == run_id).order_by(
        ServiceNowDataChunk.table_name, ServiceNowDataChunk.sequence))).all()
    return {"run_id": str(run_id), "chunks": [
        {"id": str(c.id), "table": c.table_name, "sequence": c.sequence,
            "record_count": c.record_count, "record_hash": c.record_hash,
            "coverage_status": c.coverage.get("status"), "created_at": c.created_at}
        for c in data]}


@router.get("/estate/records")
async def records(table: str = "cmdb_ci", run_id: uuid.UUID | None = None,
                  limit: int = Query(50, ge=1, le=200), offset: int = Query(0, ge=0),
                  db=Depends(get_db), user=Depends(get_current_user)):
    if table not in TABLES:
        raise HTTPException(422, "Unknown table")
    run = await db.get(AnalysisRun, run_id) if run_id else await latest_snapshot_run(db)
    if not run or not run.snapshot_id:
        return {"records": [], "coverage": None, "snapshot_id": None}
    if table == "cmdb_rel_ci":
        from app.models.estate import EstateRelationship
        data = (await db.scalars(select(EstateRelationship).where(EstateRelationship.snapshot_id == run.snapshot_id)
            .order_by(EstateRelationship.source_sys_id).offset(offset).limit(limit))).all()
    else:
        data = (await db.scalars(select(EstateEntity).where(EstateEntity.snapshot_id == run.snapshot_id,
            EstateEntity.source_table == table).order_by(EstateEntity.source_sys_id).offset(offset).limit(limit))).all()
    return {"records": [r.attributes for r in data], "snapshot_id": str(run.snapshot_id),
        "coverage": run.manifest.get("coverage", {}).get(table), "offset": offset, "limit": limit}


@router.get("/connection")
async def connection(user=Depends(get_current_user)):
    return {"mode": "live", "configured": settings.connection_configured, "instance": settings.servicenow_instance_url,
        "auth_type": settings.servicenow_auth_type, "write_enabled": False,
        "llm_enabled": settings.llm_enabled, "model": settings.ollama_model if settings.llm_enabled else None,
        "page_size": settings.servicenow_page_size, "max_records_per_table": settings.servicenow_max_records_per_table,
        "tables": [{"table": name, "fields": spec.fields, "required": spec.required,
            "enabled": spec.required or name in settings.servicenow_optional_tables.split(",")} for name, spec in TABLES.items()]}


@router.post("/connection/test")
async def test_connection(user=Depends(get_current_user)):
    if not user.can_execute:
        raise HTTPException(403, "Operator or admin role required")
    async with ServiceNowReadClient() as client:
        try:
            return await client.probe()
        except ServiceNowError as exc:
            raise HTTPException(502, {"code": exc.code, "message": str(exc)}) from None

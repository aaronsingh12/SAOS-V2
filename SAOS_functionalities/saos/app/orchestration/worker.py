"""Database-backed worker. Claims jobs atomically; leases expose interrupted runs."""
import asyncio
import contextlib
import logging
import uuid
from collections import defaultdict
from datetime import datetime, timedelta, timezone

from sqlalchemy import select, update, delete
from app.config import settings
from app.database import AsyncSessionLocal
from app.models import AnalysisRun, Agent, AgentClass, AgentRun, AgentRunStatus
from app.models.chunk import ServiceNowDataChunk
from app.models.estate import EstateSnapshot, EstateEntity, EstateRelationship
from app.models.finding import Finding, FindingDomain, FindingSeverity, FindingStatus
from app.models.evidence import Evidence
from app.models.remediation import RemediationPlan, RemediationLane, RemediationStatus
from app.models.root_cause import RootCause, RootCauseFinding
from app.models.audit import AuditEvent, AuditEventType
from app.agents.domain_analysis import AGENTS, RULE_VERSION
from app.orchestration.orchestrator import Orchestrator, digest
from app.servicenow.read_client import ServiceNowError

log = logging.getLogger(__name__)


def now():
    return datetime.now(timezone.utc)


async def register_agents(session):
    for agent_id, (_, name) in AGENTS.items():
        agent = await session.scalar(select(Agent).where(Agent.agent_id == agent_id))
        if not agent:
            session.add(Agent(agent_id=agent_id, name=name, agent_class=AgentClass.ANALYSIS,
                version=RULE_VERSION, is_active=True, allowed_tools=["read_twin"]))
        else:
            agent.version, agent.is_active, agent.allowed_tools = RULE_VERSION, True, ["read_twin"]
    for agent in (await session.scalars(select(Agent).where(Agent.agent_id.not_in(list(AGENTS))))).all():
        agent.is_active = False
    await session.commit()


async def claim_job(worker_id):
    async with AsyncSessionLocal() as session:
        # Never silently re-run an interrupted extraction against a different point in time.
        await session.execute(update(AnalysisRun).where(
            AnalysisRun.status == "running", AnalysisRun.lease_expires_at < now()).values(
            status="failed", phase="interrupted", error="Worker lease expired. Start a new extraction.",
            active_key=None, completed_at=now()))
        job_id = await session.scalar(select(AnalysisRun.id).where(AnalysisRun.status == "queued")
            .order_by(AnalysisRun.created_at).limit(1))
        if job_id is None:
            await session.commit()
            return None
        result = await session.execute(update(AnalysisRun).where(AnalysisRun.id == job_id, AnalysisRun.status == "queued")
            .values(status="running", phase="starting", worker_id=worker_id, started_at=now(),
                lease_expires_at=now() + timedelta(seconds=settings.worker_lease_seconds)))
        await session.commit()
        return job_id if result.rowcount == 1 else None


async def progress(job_id, worker_id, phase, manifest):
    async with AsyncSessionLocal() as session:
        result = await session.execute(update(AnalysisRun).where(AnalysisRun.id == job_id,
            AnalysisRun.status == "running", AnalysisRun.worker_id == worker_id).values(
            phase=phase, manifest=manifest, lease_expires_at=now()+timedelta(seconds=settings.worker_lease_seconds)))
        await session.commit()
        if result.rowcount != 1:
            raise asyncio.CancelledError()


async def heartbeat(job_id, worker_id, task):
    while not task.done():
        await asyncio.sleep(settings.worker_lease_seconds / 3)
        try:
            async with AsyncSessionLocal() as session:
                result = await session.execute(update(AnalysisRun).where(AnalysisRun.id == job_id,
                    AnalysisRun.status == "running", AnalysisRun.worker_id == worker_id).values(
                    lease_expires_at=now()+timedelta(seconds=settings.worker_lease_seconds)))
                await session.commit()
                if result.rowcount != 1:
                    task.cancel()
                    return
        except Exception:
            task.cancel()
            return


async def persist_result(job_id, worker_id, output):
    async with AsyncSessionLocal() as session:
        job = await session.scalar(select(AnalysisRun).where(AnalysisRun.id == job_id).with_for_update())
        if not job or job.status != "running" or job.worker_id != worker_id:
            raise asyncio.CancelledError()
        estate, findings, manifest = output["estate"], output["findings"], output["manifest"]
        previous = await session.scalar(select(AnalysisRun).where(AnalysisRun.source_instance == job.source_instance,
            AnalysisRun.id != job.id, AnalysisRun.snapshot_id.is_not(None)).order_by(AnalysisRun.completed_at.desc()).limit(1))
        prior_fingerprints = set(previous.manifest.get("fingerprints", [])) if previous else set()
        current_fingerprints = set(manifest["fingerprints"])
        manifest["finding_delta"] = {"previous_run_id": str(previous.id) if previous else None,
            "new": len(current_fingerprints-prior_fingerprints), "recurring": len(current_fingerprints & prior_fingerprints),
            "not_redetected": len(prior_fingerprints-current_fingerprints),
            "note": "Not redetected is not proof of resolution; compare scope, rule version and coverage."}
        snapshot = EstateSnapshot(id=uuid.uuid4(), source_instance=job.source_instance,
            version=str(job.id), ci_count=len(estate.get("cmdb_ci", [])),
            relationship_count=len(estate.get("cmdb_rel_ci", [])), notes=manifest["consistency"])
        session.add(snapshot)
        await session.flush()
        entity_ids = {}
        for table, records in estate.items():
            if table == "cmdb_rel_ci":
                continue
            for record in records:
                entity_id = uuid.uuid4()
                entity_ids[(table, record["sys_id"])] = entity_id
                session.add(EstateEntity(id=entity_id, snapshot_id=snapshot.id, source_table=table,
                    source_sys_id=record["sys_id"], entity_type=table, ci_class=record.get("sys_class_name"),
                    canonical_name=str(record.get("name") or record.get("number") or record["sys_id"])[:500],
                    attributes=record, source_metadata={"source_instance": job.source_instance,
                        "normalization_version": RULE_VERSION, "mapping_confidence": 1.0,
                        "record_hash": digest(record), "coverage_status": manifest["coverage"][table]["status"]},
                    extracted_at=datetime.fromisoformat(manifest["cutoff"]).replace(tzinfo=timezone.utc)))
        await session.flush()
        for r in estate.get("cmdb_rel_ci", []):
            session.add(EstateRelationship(snapshot_id=snapshot.id, source="cmdb_rel_ci", source_sys_id=r["sys_id"],
                parent_entity_id=entity_ids.get(("cmdb_ci", r.get("parent"))),
                child_entity_id=entity_ids.get(("cmdb_ci", r.get("child"))),
                relationship_type=str(r.get("type") or "unknown"), attributes=r))
        await session.flush()
        agent_records = {a.agent_id: a for a in (await session.scalars(select(Agent))).all()}
        for entry in manifest["agents"]:
            agent_id = entry["agent_id"]
            session.add(AgentRun(run_id=f"{job.id}:{agent_id}", agent_id=agent_records[agent_id].id,
                agent_code_id=agent_id, agent_version=RULE_VERSION, orchestration_run_id=str(job.id),
                status=AgentRunStatus.PARTIAL if output["status"] == "partial" else AgentRunStatus.SUCCESS,
                rule_pack_version=RULE_VERSION, estate_snapshot_id=str(snapshot.id),
                input_summary=manifest["input_hash"], output_json=entry, findings_count=entry["findings"],
                tokens_used=0, duration_ms=manifest["analysis_duration_ms"], started_at=job.started_at, completed_at=now()))
        finding_ids = {}
        touched = defaultdict(list)
        for f in findings:
            for sid in f["target_ids"]:
                touched[(f["table"], sid)].append(f["fingerprint"])
        for f in findings:
            fid = uuid.uuid4()
            finding_ids[f["fingerprint"]] = fid
            finding = Finding(id=fid, finding_number="SN-" + fid.hex[:24], rule_id=f["rule_id"],
                domain=FindingDomain(f["domain"]), title=f["title"][:500], description=f["description"],
                severity=FindingSeverity(f["severity"]), confidence=f["confidence"], priority=f["priority"],
                status=FindingStatus.PLAN_READY, affected_ci_ids=f["affected_ci_ids"],
                affected_service_ids=f["affected_service_ids"], ai_summary=f.get("ai_summary"),
                ai_recommendation=f["recommendation"], snapshot_id=snapshot.id, agent_run_id=str(job.id),
                rule_pack_version=RULE_VERSION, detected_at=now())
            session.add(finding)
            await session.flush()
            for ev in f["evidence"]:
                session.add(Evidence(finding_id=fid, source=ev["source"], sn_table=ev["sn_table"],
                    sn_sys_id=ev["sn_sys_id"], field_name=ev["field_name"], field_value=ev["field_value"],
                    reason=ev["reason"], collected_at=datetime.fromisoformat(manifest["cutoff"]).replace(tzinfo=timezone.utc),
                    raw_data={"snapshot_id": str(snapshot.id), "rule_version": RULE_VERSION, "fingerprint": f["fingerprint"]}))
            conflicts = sorted({other for sid in f["target_ids"] for other in touched[(f["table"], sid)] if other != f["fingerprint"]})
            before = {r["sys_id"]: r for r in estate[f["table"]] if r["sys_id"] in f["target_ids"]}
            pid = uuid.uuid4()
            plan = RemediationPlan(id=pid, plan_number="PLAN-" + pid.hex[:24], finding_id=fid,
                title=("Review: " + f["title"])[:500], description=f["recommendation"],
                remediation_lane=RemediationLane.LANE_3, target_type=f["table"], target_ids=f["target_ids"],
                before_state=before, proposed_state={"decision_required": True, "snapshot_id": str(snapshot.id),
                    "related_plan_fingerprints": conflicts}, mechanism="human_review",
                implementation_steps=[f["recommendation"], "Record the chosen change and use your ServiceNow change process."],
                prerequisites=["Confirm current target state against this snapshot.", "Reconcile other plans touching these records."] if conflicts else ["Confirm current target state against this snapshot."],
                validation_criteria=[f"After the approved customer change, run a fresh extraction and verify {f['rule_id']} against the same records and complete table coverage."],
                risk=f["severity"], priority=f["priority"], confidence=f["confidence"],
                business_impact=f["priority_factors"]["business_impact_proxy"],
                dependency_impact=f["priority_factors"]["dependency_criticality_proxy"],
                blast_radius_count=f["impact"]["reachable_nodes"],
                affected_ci_ids=f["affected_ci_ids"], affected_service_ids=f["affected_service_ids"],
                rollback_method="customer_change_process", rollback_steps=["Retain the original record snapshot and define rollback with the customer change owner."],
                estimated_effort="Owner assessment required", status=RemediationStatus.PROPOSED,
                approval_required=True, plan_version=1, created_by_agent="deterministic_planner")
            from app.servicenow.approval_guard import ApprovalGuard
            plan.plan_hash = ApprovalGuard.compute_plan_hash(plan)
            session.add(plan)
        await session.flush()
        for cluster in manifest["root_cause_clusters"]:
            root = RootCause(id=uuid.uuid4(), title=cluster["title"], summary=cluster["note"],
                confidence=0, agent_run_id=str(job.id), affected_domains=[], evidence=[])
            session.add(root)
            await session.flush()
            for fp in cluster["finding_fingerprints"]:
                session.add(RootCauseFinding(root_cause_id=root.id, finding_id=finding_ids[fp]))
        manifest["snapshot_id"] = str(snapshot.id)
        job.snapshot_id, job.manifest, job.status = snapshot.id, manifest, output["status"]
        job.phase, job.completed_at, job.active_key, job.lease_expires_at = "finished", now(), None, None
        session.add(AuditEvent(event_type=AuditEventType.AGENT_RUN_COMPLETED, user_id=job.requested_by,
            object_type="analysis_run", object_id=str(job.id), action="Live analysis completed",
            metadata_json={"status": job.status, "snapshot_id": str(snapshot.id), "input_hash": manifest["input_hash"],
                "findings": len(findings)}))
        await session.commit()


async def store_table_chunks(job_id, worker_id, table, records, coverage, cutoff):
    async with AsyncSessionLocal() as session:
        running = await session.scalar(select(AnalysisRun.id).where(
            AnalysisRun.id == job_id, AnalysisRun.status == "running", AnalysisRun.worker_id == worker_id))
        if not running:
            raise asyncio.CancelledError()
        await session.execute(delete(ServiceNowDataChunk).where(
            ServiceNowDataChunk.run_id == job_id, ServiceNowDataChunk.table_name == table))
        chunk_size = settings.analysis_chunk_size
        batches = [records[i:i + chunk_size] for i in range(0, len(records), chunk_size)] or [[]]
        source_instance = await session.scalar(select(AnalysisRun.source_instance).where(AnalysisRun.id == job_id))
        for sequence, batch in enumerate(batches):
            session.add(ServiceNowDataChunk(run_id=job_id, source_instance=source_instance,
                table_name=table, sequence=sequence, cutoff=cutoff, record_count=len(batch),
                record_hash=digest(batch), records=batch, coverage=coverage))
        await session.execute(update(AnalysisRun).where(
            AnalysisRun.id == job_id, AnalysisRun.status == "running", AnalysisRun.worker_id == worker_id).values(
            phase="stored:" + table, lease_expires_at=now()+timedelta(seconds=settings.worker_lease_seconds)))
        await session.commit()


async def load_estate_from_chunks(job_id):
    async with AsyncSessionLocal() as session:
        chunks = (await session.scalars(select(ServiceNowDataChunk).where(
            ServiceNowDataChunk.run_id == job_id).order_by(
            ServiceNowDataChunk.table_name, ServiceNowDataChunk.sequence))).all()
        estate = defaultdict(list)
        for chunk in chunks:
            estate[chunk.table_name].extend(chunk.records)
        return dict(estate)


async def execute_job(job_id, worker_id):
    async def work():
        async with asyncio.timeout(settings.analysis_timeout_seconds):
            output = await Orchestrator(
                chunk_writer=lambda table, records, coverage, cutoff: store_table_chunks(
                    job_id, worker_id, table, records, coverage, cutoff),
                chunk_reader=lambda: load_estate_from_chunks(job_id),
            ).run(job_id, lambda phase, manifest: progress(job_id, worker_id, phase, manifest))
            await persist_result(job_id, worker_id, output)
    task = asyncio.create_task(work())
    heart = asyncio.create_task(heartbeat(job_id, worker_id, task))
    try:
        await task
    except (Exception, asyncio.CancelledError) as exc:
        error = str(exc) if isinstance(exc, ServiceNowError) else (
            "Analysis deadline exceeded" if isinstance(exc, TimeoutError) else "Analysis interrupted or failed; inspect worker logs")
        if not isinstance(exc, (ServiceNowError, asyncio.CancelledError, TimeoutError)):
            log.exception("Analysis failed; run=%s", job_id)
        async with AsyncSessionLocal() as session:
            await session.execute(update(AnalysisRun).where(AnalysisRun.id == job_id, AnalysisRun.status == "running",
                AnalysisRun.worker_id == worker_id).values(status="failed", phase="failed", error=error,
                    completed_at=now(), active_key=None, lease_expires_at=None))
            await session.commit()
        if isinstance(exc, asyncio.CancelledError):
            raise
    finally:
        heart.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await heart


async def main():
    worker_id = str(uuid.uuid4())
    async with AsyncSessionLocal() as session:
        await register_agents(session)
    log.info("Analysis worker ready")
    while True:
        job_id = await claim_job(worker_id)
        if job_id:
            try:
                await execute_job(job_id, worker_id)
            except asyncio.CancelledError:
                # A user cancellation cancels a job; process cancellation stops the worker.
                if asyncio.current_task().cancelling():
                    raise
        else:
            await asyncio.sleep(settings.worker_poll_seconds)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    asyncio.run(main())

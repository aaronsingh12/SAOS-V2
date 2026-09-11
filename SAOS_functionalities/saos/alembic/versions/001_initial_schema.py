"""Initial SAOS schema migration.

Revision ID: 001
Revises:
Create Date: 2026-09-09
"""
from typing import Sequence, Union

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql
from alembic import op

revision: str = "001"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── users ─────────────────────────────────────────────────────────────────
    op.create_table(
        "users",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("email", sa.String(255), nullable=False),
        sa.Column("full_name", sa.String(255), nullable=False),
        sa.Column("hashed_password", sa.String(255), nullable=False),
        sa.Column("role", sa.Enum("admin", "operator", "approver", "viewer", name="userrole"), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default="true"),
        sa.Column("last_login_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id", name="pk_users"),
        sa.UniqueConstraint("email", name="uq_users_email"),
    )
    op.create_index("ix_users_email", "users", ["email"])

    # ── agents ────────────────────────────────────────────────────────────────
    op.create_table(
        "agents",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("agent_id", sa.String(100), nullable=False),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("version", sa.String(50), nullable=False, server_default="1.0.0"),
        sa.Column("agent_class", sa.Enum("SENSING", "ANALYSIS", "SYNTHESIS", "ACTION", name="agentclass"), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("timeout_seconds", sa.Integer(), server_default="300"),
        sa.Column("token_budget", sa.Integer(), server_default="4096"),
        sa.Column("allowed_tools", postgresql.JSONB(), server_default="[]"),
        sa.Column("input_schema", postgresql.JSONB(), server_default="{}"),
        sa.Column("output_schema", postgresql.JSONB(), server_default="{}"),
        sa.Column("is_active", sa.Boolean(), server_default="true"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id", name="pk_agents"),
        sa.UniqueConstraint("agent_id", name="uq_agents_agent_id"),
    )
    op.create_index("ix_agents_agent_id", "agents", ["agent_id"])

    # ── agent_runs ────────────────────────────────────────────────────────────
    op.create_table(
        "agent_runs",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("run_id", sa.String(100), nullable=False),
        sa.Column("agent_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("agent_code_id", sa.String(100), nullable=False),
        sa.Column("agent_version", sa.String(50), nullable=False),
        sa.Column("orchestration_run_id", sa.String(100), nullable=True),
        sa.Column("status", sa.Enum("pending","running","success","failed","partial","timeout", name="agentrunstatus"), nullable=False, server_default="pending"),
        sa.Column("model_name", sa.String(100), nullable=True),
        sa.Column("prompt_version", sa.String(50), nullable=True),
        sa.Column("rule_pack_version", sa.String(50), nullable=True),
        sa.Column("estate_snapshot_id", sa.String(100), nullable=True),
        sa.Column("input_summary", sa.Text(), nullable=True),
        sa.Column("output_json", postgresql.JSONB(), nullable=True),
        sa.Column("findings_count", sa.Integer(), server_default="0"),
        sa.Column("tokens_used", sa.Integer(), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("duration_ms", sa.Integer(), nullable=True),
        sa.ForeignKeyConstraint(["agent_id"], ["agents.id"], name="fk_agent_runs_agent_id_agents"),
        sa.PrimaryKeyConstraint("id", name="pk_agent_runs"),
        sa.UniqueConstraint("run_id", name="uq_agent_runs_run_id"),
    )
    op.create_index("ix_agent_runs_run_id", "agent_runs", ["run_id"])
    op.create_index("ix_agent_runs_orchestration_run_id", "agent_runs", ["orchestration_run_id"])

    # ── estate_snapshots ──────────────────────────────────────────────────────
    op.create_table(
        "estate_snapshots",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("source_instance", sa.String(255), nullable=False),
        sa.Column("version", sa.String(100), nullable=False),
        sa.Column("ci_count", sa.Integer(), server_default="0"),
        sa.Column("relationship_count", sa.Integer(), server_default="0"),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id", name="pk_estate_snapshots"),
    )

    # ── estate_entities ───────────────────────────────────────────────────────
    op.create_table(
        "estate_entities",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("snapshot_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("source_table", sa.String(100), nullable=False),
        sa.Column("source_sys_id", sa.String(100), nullable=False),
        sa.Column("entity_type", sa.String(100), nullable=False),
        sa.Column("ci_class", sa.String(100), nullable=True),
        sa.Column("canonical_name", sa.String(500), nullable=True),
        sa.Column("attributes", postgresql.JSONB(), server_default="{}"),
        sa.Column("source_metadata", postgresql.JSONB(), server_default="{}"),
        sa.Column("extracted_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["snapshot_id"], ["estate_snapshots.id"], name="fk_estate_entities_snapshot_id_estate_snapshots", ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id", name="pk_estate_entities"),
    )
    op.create_index("ix_estate_entities_snapshot_id", "estate_entities", ["snapshot_id"])
    op.create_index("ix_estate_entities_source_sys_id", "estate_entities", ["source_sys_id"])

    # ── estate_relationships ──────────────────────────────────────────────────
    op.create_table(
        "estate_relationships",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("snapshot_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("source", sa.String(100), nullable=False),
        sa.Column("source_sys_id", sa.String(100), nullable=False),
        sa.Column("parent_entity_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("child_entity_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("relationship_type", sa.String(100), nullable=False),
        sa.Column("attributes", postgresql.JSONB(), server_default="{}"),
        sa.ForeignKeyConstraint(["snapshot_id"], ["estate_snapshots.id"], name="fk_estate_relationships_snapshot_id_estate_snapshots", ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["parent_entity_id"], ["estate_entities.id"], name="fk_estate_relationships_parent_entity_id_estate_entities"),
        sa.ForeignKeyConstraint(["child_entity_id"], ["estate_entities.id"], name="fk_estate_relationships_child_entity_id_estate_entities"),
        sa.PrimaryKeyConstraint("id", name="pk_estate_relationships"),
    )
    op.create_index("ix_estate_relationships_snapshot_id", "estate_relationships", ["snapshot_id"])

    # ── findings ──────────────────────────────────────────────────────────────
    op.create_table(
        "findings",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("finding_number", sa.String(50), nullable=False),
        sa.Column("rule_id", sa.String(100), nullable=False),
        sa.Column("domain", sa.Enum("CMDB","MID_SERVER","DISCOVERY","SERVICE_MAPPING","EVENT_MANAGEMENT","METRIC_INTELLIGENCE","CLOUD_GOVERNANCE","IRE","RELATIONSHIP", name="findingdomain"), nullable=False),
        sa.Column("title", sa.String(500), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("severity", sa.Enum("CRITICAL","HIGH","MEDIUM","LOW","INFO", name="findingseverity"), nullable=False),
        sa.Column("priority", sa.String(10), nullable=True),
        sa.Column("confidence", sa.Float(), server_default="0"),
        sa.Column("status", sa.Enum("DETECTED","ANALYZING","PLAN_READY","AWAITING_APPROVAL","APPROVED","FIXING","VALIDATING","RESOLVED","FAILED","ROLLED_BACK","DISMISSED","FALSE_POSITIVE", name="findingstatus"), nullable=False, server_default="DETECTED"),
        sa.Column("affected_ci_ids", postgresql.JSONB(), server_default="[]"),
        sa.Column("affected_service_ids", postgresql.JSONB(), server_default="[]"),
        sa.Column("affected_business_service_ids", postgresql.JSONB(), server_default="[]"),
        sa.Column("ai_summary", sa.Text(), nullable=True),
        sa.Column("ai_recommendation", sa.Text(), nullable=True),
        sa.Column("snapshot_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("agent_run_id", sa.String(100), nullable=True),
        sa.Column("rule_pack_version", sa.String(50), nullable=True),
        sa.Column("detected_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["snapshot_id"], ["estate_snapshots.id"], name="fk_findings_snapshot_id_estate_snapshots"),
        sa.PrimaryKeyConstraint("id", name="pk_findings"),
        sa.UniqueConstraint("finding_number", name="uq_findings_finding_number"),
    )
    op.create_index("ix_findings_finding_number", "findings", ["finding_number"])
    op.create_index("ix_findings_rule_id", "findings", ["rule_id"])
    op.create_index("ix_findings_domain", "findings", ["domain"])
    op.create_index("ix_findings_severity", "findings", ["severity"])
    op.create_index("ix_findings_status", "findings", ["status"])
    op.create_index("ix_findings_agent_run_id", "findings", ["agent_run_id"])

    # ── finding_evidence ──────────────────────────────────────────────────────
    op.create_table(
        "finding_evidence",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("finding_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("source", sa.String(100), nullable=False),
        sa.Column("sn_table", sa.String(100), nullable=True),
        sa.Column("sn_sys_id", sa.String(100), nullable=True),
        sa.Column("field_name", sa.String(100), nullable=True),
        sa.Column("field_value", sa.Text(), nullable=True),
        sa.Column("expected_value", sa.Text(), nullable=True),
        sa.Column("reason", sa.Text(), nullable=True),
        sa.Column("evidence_type", sa.String(50), server_default="field_value"),
        sa.Column("raw_data", postgresql.JSONB(), nullable=True),
        sa.Column("collected_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["finding_id"], ["findings.id"], name="fk_finding_evidence_finding_id_findings", ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id", name="pk_finding_evidence"),
    )
    op.create_index("ix_finding_evidence_finding_id", "finding_evidence", ["finding_id"])

    # ── root_causes ───────────────────────────────────────────────────────────
    op.create_table(
        "root_causes",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("title", sa.String(500), nullable=False),
        sa.Column("summary", sa.Text(), nullable=True),
        sa.Column("confidence", sa.Float(), server_default="0"),
        sa.Column("primary_finding_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("affected_domains", postgresql.JSONB(), server_default="[]"),
        sa.Column("evidence", postgresql.JSONB(), server_default="[]"),
        sa.Column("ai_analysis", sa.Text(), nullable=True),
        sa.Column("agent_run_id", sa.String(100), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["primary_finding_id"], ["findings.id"], name="fk_root_causes_primary_finding_id_findings"),
        sa.PrimaryKeyConstraint("id", name="pk_root_causes"),
    )

    # ── root_cause_findings ───────────────────────────────────────────────────
    op.create_table(
        "root_cause_findings",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("root_cause_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("finding_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("relationship_type", sa.String(50), server_default="symptom"),
        sa.Column("order_index", sa.Integer(), server_default="0"),
        sa.ForeignKeyConstraint(["root_cause_id"], ["root_causes.id"], name="fk_root_cause_findings_root_cause_id_root_causes", ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["finding_id"], ["findings.id"], name="fk_root_cause_findings_finding_id_findings", ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id", name="pk_root_cause_findings"),
    )
    op.create_index("ix_root_cause_findings_root_cause_id", "root_cause_findings", ["root_cause_id"])
    op.create_index("ix_root_cause_findings_finding_id", "root_cause_findings", ["finding_id"])

    # ── impacts ───────────────────────────────────────────────────────────────
    op.create_table(
        "impacts",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("finding_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("root_cause_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("affected_ci_count", sa.Integer(), server_default="0"),
        sa.Column("affected_app_service_count", sa.Integer(), server_default="0"),
        sa.Column("affected_business_service_count", sa.Integer(), server_default="0"),
        sa.Column("affected_alert_count", sa.Integer(), server_default="0"),
        sa.Column("affected_ci_ids", postgresql.JSONB(), server_default="[]"),
        sa.Column("affected_app_service_ids", postgresql.JSONB(), server_default="[]"),
        sa.Column("affected_business_service_ids", postgresql.JSONB(), server_default="[]"),
        sa.Column("business_impact_score", sa.Float(), server_default="0"),
        sa.Column("operational_impact_score", sa.Float(), server_default="0"),
        sa.Column("impact_summary", sa.Text(), nullable=True),
        sa.Column("dependency_chain", postgresql.JSONB(), server_default="[]"),
        sa.Column("calculated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["finding_id"], ["findings.id"], name="fk_impacts_finding_id_findings", ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["root_cause_id"], ["root_causes.id"], name="fk_impacts_root_cause_id_root_causes"),
        sa.PrimaryKeyConstraint("id", name="pk_impacts"),
    )
    op.create_index("ix_impacts_finding_id", "impacts", ["finding_id"])

    # ── remediation_plans ─────────────────────────────────────────────────────
    op.create_table(
        "remediation_plans",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("plan_number", sa.String(50), nullable=False),
        sa.Column("finding_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("root_cause_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("title", sa.String(500), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("remediation_lane", sa.Enum("LANE_1","LANE_2","LANE_3", name="remediationlane"), nullable=False, server_default="LANE_1"),
        sa.Column("target_type", sa.String(100), nullable=True),
        sa.Column("target_ids", postgresql.JSONB(), server_default="[]"),
        sa.Column("before_state", postgresql.JSONB(), server_default="{}"),
        sa.Column("proposed_state", postgresql.JSONB(), server_default="{}"),
        sa.Column("implementation_steps", postgresql.JSONB(), server_default="[]"),
        sa.Column("mechanism", sa.String(100), nullable=True),
        sa.Column("risk", sa.String(20), server_default="MEDIUM"),
        sa.Column("priority", sa.String(10), server_default="P3"),
        sa.Column("confidence", sa.Float(), server_default="0"),
        sa.Column("business_impact", sa.Float(), server_default="0"),
        sa.Column("dependency_impact", sa.Float(), server_default="0"),
        sa.Column("blast_radius_count", sa.Integer(), server_default="0"),
        sa.Column("affected_ci_ids", postgresql.JSONB(), server_default="[]"),
        sa.Column("affected_service_ids", postgresql.JSONB(), server_default="[]"),
        sa.Column("prerequisites", postgresql.JSONB(), server_default="[]"),
        sa.Column("validation_criteria", postgresql.JSONB(), server_default="[]"),
        sa.Column("rollback_method", sa.String(100), nullable=True),
        sa.Column("rollback_steps", postgresql.JSONB(), server_default="[]"),
        sa.Column("estimated_effort", sa.String(50), nullable=True),
        sa.Column("approval_required", sa.Boolean(), server_default="true"),
        sa.Column("status", sa.Enum("PROPOSED","PREVIEWED","AWAITING_APPROVAL","APPROVED","QUEUED","EXECUTING","APPLIED","VALIDATING","VALIDATED","CLOSED","REJECTED","FAILED","VALIDATION_FAILED","ROLLING_BACK","ROLLED_BACK", name="remediationstatus"), nullable=False, server_default="PROPOSED"),
        sa.Column("plan_version", sa.Integer(), server_default="1"),
        sa.Column("plan_hash", sa.String(64), nullable=True),
        sa.Column("created_by_agent", sa.String(100), nullable=True),
        sa.Column("approved_by", sa.String(255), nullable=True),
        sa.Column("approved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["finding_id"], ["findings.id"], name="fk_remediation_plans_finding_id_findings"),
        sa.ForeignKeyConstraint(["root_cause_id"], ["root_causes.id"], name="fk_remediation_plans_root_cause_id_root_causes"),
        sa.PrimaryKeyConstraint("id", name="pk_remediation_plans"),
        sa.UniqueConstraint("plan_number", name="uq_remediation_plans_plan_number"),
    )
    op.create_index("ix_remediation_plans_plan_number", "remediation_plans", ["plan_number"])
    op.create_index("ix_remediation_plans_finding_id", "remediation_plans", ["finding_id"])
    op.create_index("ix_remediation_plans_status", "remediation_plans", ["status"])

    # ── remediation_steps ─────────────────────────────────────────────────────
    op.create_table(
        "remediation_steps",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("plan_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("step_order", sa.Integer(), nullable=False),
        sa.Column("title", sa.String(500), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("action_type", sa.String(100), nullable=False),
        sa.Column("action_params", postgresql.JSONB(), server_default="{}"),
        sa.Column("is_rollback_step", sa.Boolean(), server_default="false"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["plan_id"], ["remediation_plans.id"], name="fk_remediation_steps_plan_id_remediation_plans", ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id", name="pk_remediation_steps"),
    )
    op.create_index("ix_remediation_steps_plan_id", "remediation_steps", ["plan_id"])

    # ── remediation_snapshots ─────────────────────────────────────────────────
    op.create_table(
        "remediation_snapshots",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("plan_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("target_type", sa.String(100), nullable=False),
        sa.Column("target_id", sa.String(100), nullable=False),
        sa.Column("before_state", postgresql.JSONB(), server_default="{}"),
        sa.Column("captured_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("captured_by", sa.String(255), nullable=True),
        sa.ForeignKeyConstraint(["plan_id"], ["remediation_plans.id"], name="fk_remediation_snapshots_plan_id_remediation_plans", ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id", name="pk_remediation_snapshots"),
    )

    # ── approvals ─────────────────────────────────────────────────────────────
    op.create_table(
        "approvals",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("plan_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("approver_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("plan_version", sa.Integer(), nullable=False),
        sa.Column("plan_hash", sa.String(64), nullable=False),
        sa.Column("status", sa.Enum("PENDING","APPROVED","REJECTED","CHANGES_REQUESTED","EXPIRED","SUPERSEDED", name="approvalstatus"), nullable=False, server_default="PENDING"),
        sa.Column("comment", sa.Text(), nullable=True),
        sa.Column("requested_changes", sa.Text(), nullable=True),
        sa.Column("source_ip", sa.String(50), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("is_expired", sa.Boolean(), server_default="false"),
        sa.Column("approved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("rejected_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["plan_id"], ["remediation_plans.id"], name="fk_approvals_plan_id_remediation_plans"),
        sa.ForeignKeyConstraint(["approver_id"], ["users.id"], name="fk_approvals_approver_id_users"),
        sa.PrimaryKeyConstraint("id", name="pk_approvals"),
    )
    op.create_index("ix_approvals_plan_id", "approvals", ["plan_id"])

    # ── executions ────────────────────────────────────────────────────────────
    op.create_table(
        "executions",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("plan_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("approval_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("executed_by_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("plan_version_at_execution", sa.Integer(), nullable=False),
        sa.Column("plan_hash_at_execution", sa.String(64), nullable=False),
        sa.Column("status", sa.Enum("QUEUED","SNAPSHOT","EXECUTING","APPLIED","VALIDATING","VALIDATED","FAILED","ROLLING_BACK","ROLLED_BACK", name="executionstatus"), nullable=False, server_default="QUEUED"),
        sa.Column("sn_change_ref", sa.String(100), nullable=True),
        sa.Column("result_summary", sa.Text(), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("rollback_available", sa.Boolean(), server_default="true"),
        sa.Column("rollback_reason", sa.Text(), nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["plan_id"], ["remediation_plans.id"], name="fk_executions_plan_id_remediation_plans"),
        sa.ForeignKeyConstraint(["approval_id"], ["approvals.id"], name="fk_executions_approval_id_approvals"),
        sa.ForeignKeyConstraint(["executed_by_id"], ["users.id"], name="fk_executions_executed_by_id_users"),
        sa.PrimaryKeyConstraint("id", name="pk_executions"),
    )
    op.create_index("ix_executions_plan_id", "executions", ["plan_id"])
    op.create_index("ix_executions_status", "executions", ["status"])

    # ── execution_steps ───────────────────────────────────────────────────────
    op.create_table(
        "execution_steps",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("execution_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("step_order", sa.Integer(), nullable=False),
        sa.Column("description", sa.String(500), nullable=False),
        sa.Column("action_type", sa.String(100), nullable=False),
        sa.Column("status", sa.String(50), server_default="PENDING"),
        sa.Column("sn_response_ref", sa.String(200), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("response_data", postgresql.JSONB(), nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["execution_id"], ["executions.id"], name="fk_execution_steps_execution_id_executions", ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id", name="pk_execution_steps"),
    )
    op.create_index("ix_execution_steps_execution_id", "execution_steps", ["execution_id"])

    # ── validations ───────────────────────────────────────────────────────────
    op.create_table(
        "validations",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("execution_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("plan_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("status", sa.Enum("PENDING","RUNNING","PASSED","FAILED","ERROR", name="validationstatus"), nullable=False, server_default="PENDING"),
        sa.Column("passed", sa.Boolean(), server_default="false"),
        sa.Column("expected_result", postgresql.JSONB(), server_default="{}"),
        sa.Column("actual_result", postgresql.JSONB(), nullable=True),
        sa.Column("checks", postgresql.JSONB(), server_default="[]"),
        sa.Column("evidence", postgresql.JSONB(), server_default="[]"),
        sa.Column("failure_reason", sa.Text(), nullable=True),
        sa.Column("data_source", sa.String(50), server_default="servicenow_live"),
        sa.Column("validated_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["execution_id"], ["executions.id"], name="fk_validations_execution_id_executions"),
        sa.ForeignKeyConstraint(["plan_id"], ["remediation_plans.id"], name="fk_validations_plan_id_remediation_plans"),
        sa.PrimaryKeyConstraint("id", name="pk_validations"),
    )
    op.create_index("ix_validations_execution_id", "validations", ["execution_id"])

    # ── audit_events ──────────────────────────────────────────────────────────
    op.create_table(
        "audit_events",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("event_type", sa.Enum(
            "LOGIN","LOGOUT","LOGIN_FAILED","AGENT_RUN_STARTED","AGENT_RUN_COMPLETED",
            "FINDING_CREATED","FINDING_UPDATED","ROOT_CAUSE_CREATED","PLAN_CREATED",
            "PLAN_UPDATED","PLAN_SUBMITTED","APPROVAL_REQUESTED","PLAN_APPROVED",
            "PLAN_REJECTED","CHANGES_REQUESTED","EXECUTION_STARTED","EXECUTION_COMPLETED",
            "EXECUTION_FAILED","ROLLBACK_STARTED","ROLLBACK_COMPLETED","VALIDATION_STARTED",
            "VALIDATION_COMPLETED","SN_WRITE_OPERATION","UNAUTHORIZED_ATTEMPT",
            "SETTINGS_CHANGED","USER_CREATED","USER_UPDATED",
            name="auditeventtype"
        ), nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("agent_id", sa.String(100), nullable=True),
        sa.Column("object_type", sa.String(100), nullable=True),
        sa.Column("object_id", sa.String(100), nullable=True),
        sa.Column("action", sa.String(200), nullable=False),
        sa.Column("before_json", postgresql.JSONB(), nullable=True),
        sa.Column("after_json", postgresql.JSONB(), nullable=True),
        sa.Column("metadata_json", postgresql.JSONB(), nullable=True),
        sa.Column("source_ip", sa.String(50), nullable=True),
        sa.Column("timestamp", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], name="fk_audit_events_user_id_users"),
        sa.PrimaryKeyConstraint("id", name="pk_audit_events"),
    )
    op.create_index("ix_audit_events_event_type", "audit_events", ["event_type"])
    op.create_index("ix_audit_events_user_id", "audit_events", ["user_id"])
    op.create_index("ix_audit_events_object_id", "audit_events", ["object_id"])
    op.create_index("ix_audit_events_timestamp", "audit_events", ["timestamp"])


def downgrade() -> None:
    op.drop_table("audit_events")
    op.drop_table("validations")
    op.drop_table("execution_steps")
    op.drop_table("executions")
    op.drop_table("approvals")
    op.drop_table("remediation_snapshots")
    op.drop_table("remediation_steps")
    op.drop_table("remediation_plans")
    op.drop_table("impacts")
    op.drop_table("root_cause_findings")
    op.drop_table("root_causes")
    op.drop_table("finding_evidence")
    op.drop_table("findings")
    op.drop_table("estate_relationships")
    op.drop_table("estate_entities")
    op.drop_table("estate_snapshots")
    op.drop_table("agent_runs")
    op.drop_table("agents")
    op.drop_table("users")

    # Drop custom enums
    for enum_name in [
        "userrole", "agentclass", "agentrunstatus", "findingdomain",
        "findingseverity", "findingstatus", "remediationlane", "remediationstatus",
        "approvalstatus", "executionstatus", "validationstatus", "auditeventtype"
    ]:
        op.execute(f"DROP TYPE IF EXISTS {enum_name}")

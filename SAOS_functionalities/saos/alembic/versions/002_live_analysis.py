"""Durable analysis queue and domain coverage.
Revision ID: 002
Revises: 001
"""
from alembic import op
import sqlalchemy as sa

revision = "002"
down_revision = "001"
branch_labels = None
depends_on = None


def upgrade():
    if op.get_bind().dialect.name == "postgresql":
        # ORM enums persist member names, not lowercase enum values.
        for enum, values in (("userrole", ["admin", "operator", "approver", "viewer"]),
                             ("agentrunstatus", ["pending", "running", "success", "failed", "partial", "timeout"])):
            for value in values:
                op.execute(f"ALTER TYPE {enum} RENAME VALUE '{value}' TO '{value.upper()}'")
        for value in ("CSDM", "CUSTOMIZATION", "INTEGRATION", "PERFORMANCE", "UPGRADE", "SECURITY"):
            op.execute(f"ALTER TYPE findingdomain ADD VALUE IF NOT EXISTS '{value}'")
    op.create_table("analysis_runs",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("requested_by", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("source_instance", sa.String(255), nullable=False),
        sa.Column("active_key", sa.String(255), unique=True, nullable=True),
        sa.Column("status", sa.String(30), nullable=False),
        sa.Column("phase", sa.String(100), nullable=False),
        sa.Column("snapshot_id", sa.Uuid(), sa.ForeignKey("estate_snapshots.id"), nullable=True),
        sa.Column("manifest", sa.JSON(), nullable=False),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("worker_id", sa.String(100), nullable=True),
        sa.Column("lease_expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True))
    op.create_index("ix_analysis_runs_status", "analysis_runs", ["status"])


def downgrade():
    raise RuntimeError("Use a verified database backup to downgrade; live run history is retained")

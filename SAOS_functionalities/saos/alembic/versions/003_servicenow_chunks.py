"""Persist raw ServiceNow chunks before analysis.

Revision ID: 003
Revises: 002
"""
from alembic import op
import sqlalchemy as sa

revision = "003"
down_revision = "002"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table("servicenow_data_chunks",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("run_id", sa.Uuid(), sa.ForeignKey("analysis_runs.id", ondelete="CASCADE"), nullable=False),
        sa.Column("source_instance", sa.String(255), nullable=False),
        sa.Column("table_name", sa.String(100), nullable=False),
        sa.Column("sequence", sa.Integer(), nullable=False),
        sa.Column("cutoff", sa.String(30), nullable=False),
        sa.Column("record_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("record_hash", sa.String(64), nullable=False),
        sa.Column("records", sa.JSON(), nullable=False),
        sa.Column("coverage", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False))
    op.create_index("ix_servicenow_data_chunks_run_id", "servicenow_data_chunks", ["run_id"])
    op.create_index("ix_servicenow_data_chunks_table_name", "servicenow_data_chunks", ["table_name"])
    op.create_unique_constraint("uq_servicenow_data_chunks_run_table_sequence",
        "servicenow_data_chunks", ["run_id", "table_name", "sequence"])


def downgrade():
    op.drop_constraint("uq_servicenow_data_chunks_run_table_sequence", "servicenow_data_chunks", type_="unique")
    op.drop_index("ix_servicenow_data_chunks_table_name", table_name="servicenow_data_chunks")
    op.drop_index("ix_servicenow_data_chunks_run_id", table_name="servicenow_data_chunks")
    op.drop_table("servicenow_data_chunks")

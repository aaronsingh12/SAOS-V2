"""SAOS — Remediation Plan, Steps, and Snapshot Models."""
from __future__ import annotations

import enum
import uuid
from datetime import datetime

from sqlalchemy import DateTime, Enum, Float, ForeignKey, Integer, String, Text, func
from sqlalchemy import JSON as JSONB, Uuid as UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class RemediationStatus(str, enum.Enum):
    PROPOSED = "PROPOSED"
    PREVIEWED = "PREVIEWED"
    AWAITING_APPROVAL = "AWAITING_APPROVAL"
    APPROVED = "APPROVED"
    QUEUED = "QUEUED"
    EXECUTING = "EXECUTING"
    APPLIED = "APPLIED"
    VALIDATING = "VALIDATING"
    VALIDATED = "VALIDATED"
    CLOSED = "CLOSED"
    REJECTED = "REJECTED"
    FAILED = "FAILED"
    VALIDATION_FAILED = "VALIDATION_FAILED"
    ROLLING_BACK = "ROLLING_BACK"
    ROLLED_BACK = "ROLLED_BACK"


class RemediationLane(str, enum.Enum):
    LANE_1 = "LANE_1"  # Controlled Data Change
    LANE_2 = "LANE_2"  # Staged Change
    LANE_3 = "LANE_3"  # Guided Decision


class RemediationPlan(Base):
    __tablename__ = "remediation_plans"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    plan_number: Mapped[str] = mapped_column(String(50), unique=True, nullable=False, index=True)
    finding_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("findings.id"), nullable=True, index=True
    )
    root_cause_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("root_causes.id"), nullable=True
    )

    title: Mapped[str] = mapped_column(String(500), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=True)
    remediation_lane: Mapped[RemediationLane] = mapped_column(
        Enum(RemediationLane), nullable=False, default=RemediationLane.LANE_1
    )

    target_type: Mapped[str] = mapped_column(String(100), nullable=True)
    target_ids: Mapped[list] = mapped_column(JSONB, default=list)

    before_state: Mapped[dict] = mapped_column(JSONB, default=dict)
    proposed_state: Mapped[dict] = mapped_column(JSONB, default=dict)

    implementation_steps: Mapped[list] = mapped_column(JSONB, default=list)
    mechanism: Mapped[str | None] = mapped_column(String(100), nullable=True)

    risk: Mapped[str] = mapped_column(String(20), default="MEDIUM")
    priority: Mapped[str] = mapped_column(String(10), default="P3")
    confidence: Mapped[float] = mapped_column(Float, default=0.0)
    business_impact: Mapped[float] = mapped_column(Float, default=0.0)
    dependency_impact: Mapped[float] = mapped_column(Float, default=0.0)
    blast_radius_count: Mapped[int] = mapped_column(Integer, default=0)

    affected_ci_ids: Mapped[list] = mapped_column(JSONB, default=list)
    affected_service_ids: Mapped[list] = mapped_column(JSONB, default=list)

    prerequisites: Mapped[list] = mapped_column(JSONB, default=list)
    validation_criteria: Mapped[list] = mapped_column(JSONB, default=list)
    rollback_method: Mapped[str | None] = mapped_column(String(100), nullable=True)
    rollback_steps: Mapped[list] = mapped_column(JSONB, default=list)
    estimated_effort: Mapped[str | None] = mapped_column(String(50), nullable=True)

    approval_required: Mapped[bool] = mapped_column(default=True)
    status: Mapped[RemediationStatus] = mapped_column(
        Enum(RemediationStatus), nullable=False, default=RemediationStatus.PROPOSED, index=True
    )

    # Versioning / integrity
    plan_version: Mapped[int] = mapped_column(Integer, default=1)
    plan_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)  # SHA-256

    created_by_agent: Mapped[str | None] = mapped_column(String(100), nullable=True)
    approved_by: Mapped[str | None] = mapped_column(String(255), nullable=True)
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )

    # Relationships
    finding: Mapped["Finding | None"] = relationship("Finding", back_populates="remediation_plans")  # type: ignore[name-defined]
    root_cause: Mapped["RootCause | None"] = relationship("RootCause", back_populates="remediation_plans")  # type: ignore[name-defined]
    steps: Mapped[list["RemediationStep"]] = relationship(
        "RemediationStep", back_populates="plan", cascade="all, delete-orphan", order_by="RemediationStep.step_order"
    )
    approvals: Mapped[list["Approval"]] = relationship("Approval", back_populates="plan")  # type: ignore[name-defined]
    executions: Mapped[list["Execution"]] = relationship("Execution", back_populates="plan")  # type: ignore[name-defined]
    snapshots: Mapped[list["RemediationSnapshot"]] = relationship(
        "RemediationSnapshot", back_populates="plan", cascade="all, delete-orphan"
    )

    def __repr__(self) -> str:
        return f"<RemediationPlan {self.plan_number} v{self.plan_version} [{self.status}]>"


class RemediationStep(Base):
    __tablename__ = "remediation_steps"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    plan_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("remediation_plans.id", ondelete="CASCADE"), nullable=False, index=True
    )
    step_order: Mapped[int] = mapped_column(Integer, nullable=False)
    title: Mapped[str] = mapped_column(String(500), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=True)
    action_type: Mapped[str] = mapped_column(String(100), nullable=False)  # update_ci_field, create_relationship, etc.
    action_params: Mapped[dict] = mapped_column(JSONB, default=dict)
    is_rollback_step: Mapped[bool] = mapped_column(default=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    plan: Mapped["RemediationPlan"] = relationship("RemediationPlan", back_populates="steps")


class RemediationSnapshot(Base):
    """Before-state snapshot captured before execution."""
    __tablename__ = "remediation_snapshots"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    plan_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("remediation_plans.id", ondelete="CASCADE"), nullable=False, index=True
    )
    target_type: Mapped[str] = mapped_column(String(100), nullable=False)
    target_id: Mapped[str] = mapped_column(String(100), nullable=False)
    before_state: Mapped[dict] = mapped_column(JSONB, default=dict)
    captured_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    captured_by: Mapped[str | None] = mapped_column(String(255), nullable=True)

    plan: Mapped["RemediationPlan"] = relationship("RemediationPlan", back_populates="snapshots")

"""SAOS — Finding Model."""
from __future__ import annotations

import enum
import uuid
from datetime import datetime

from sqlalchemy import DateTime, Enum, Float, ForeignKey, Integer, String, Text, func
from sqlalchemy import JSON as JSONB, Uuid as UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class FindingSeverity(str, enum.Enum):
    CRITICAL = "CRITICAL"
    HIGH = "HIGH"
    MEDIUM = "MEDIUM"
    LOW = "LOW"
    INFO = "INFO"


class FindingDomain(str, enum.Enum):
    CSDM = "CSDM"
    CUSTOMIZATION = "CUSTOMIZATION"
    INTEGRATION = "INTEGRATION"
    PERFORMANCE = "PERFORMANCE"
    UPGRADE = "UPGRADE"
    SECURITY = "SECURITY"
    CMDB = "CMDB"
    MID_SERVER = "MID_SERVER"
    DISCOVERY = "DISCOVERY"
    SERVICE_MAPPING = "SERVICE_MAPPING"
    EVENT_MANAGEMENT = "EVENT_MANAGEMENT"
    METRIC_INTELLIGENCE = "METRIC_INTELLIGENCE"
    CLOUD_GOVERNANCE = "CLOUD_GOVERNANCE"
    IRE = "IRE"
    RELATIONSHIP = "RELATIONSHIP"


class FindingStatus(str, enum.Enum):
    DETECTED = "DETECTED"
    ANALYZING = "ANALYZING"
    PLAN_READY = "PLAN_READY"
    AWAITING_APPROVAL = "AWAITING_APPROVAL"
    APPROVED = "APPROVED"
    FIXING = "FIXING"
    VALIDATING = "VALIDATING"
    RESOLVED = "RESOLVED"
    FAILED = "FAILED"
    ROLLED_BACK = "ROLLED_BACK"
    DISMISSED = "DISMISSED"
    FALSE_POSITIVE = "FALSE_POSITIVE"


class Finding(Base):
    __tablename__ = "findings"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    finding_number: Mapped[str] = mapped_column(String(50), unique=True, nullable=False, index=True)
    rule_id: Mapped[str] = mapped_column(String(100), nullable=False, index=True)
    domain: Mapped[FindingDomain] = mapped_column(Enum(FindingDomain), nullable=False, index=True)
    title: Mapped[str] = mapped_column(String(500), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=True)
    severity: Mapped[FindingSeverity] = mapped_column(Enum(FindingSeverity), nullable=False, index=True)
    priority: Mapped[str] = mapped_column(String(10), nullable=True)  # P1-P5
    confidence: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    status: Mapped[FindingStatus] = mapped_column(
        Enum(FindingStatus), nullable=False, default=FindingStatus.DETECTED, index=True
    )

    # Affected items (stored as JSON arrays of sys_ids)
    affected_ci_ids: Mapped[list] = mapped_column(JSONB, default=list)
    affected_service_ids: Mapped[list] = mapped_column(JSONB, default=list)
    affected_business_service_ids: Mapped[list] = mapped_column(JSONB, default=list)

    # AI analysis
    ai_summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    ai_recommendation: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Metadata
    snapshot_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("estate_snapshots.id"), nullable=True
    )
    agent_run_id: Mapped[str | None] = mapped_column(String(100), nullable=True, index=True)
    rule_pack_version: Mapped[str | None] = mapped_column(String(50), nullable=True)
    detected_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )

    # Relationships
    evidence: Mapped[list["Evidence"]] = relationship("Evidence", back_populates="finding", cascade="all, delete-orphan")  # type: ignore[name-defined]
    remediation_plans: Mapped[list["RemediationPlan"]] = relationship("RemediationPlan", back_populates="finding")  # type: ignore[name-defined]
    root_cause_findings: Mapped[list["RootCauseFinding"]] = relationship("RootCauseFinding", back_populates="finding")  # type: ignore[name-defined]

    def __repr__(self) -> str:
        return f"<Finding {self.finding_number}: {self.title[:50]}>"

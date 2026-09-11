"""SAOS — Root Cause Models."""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, Float, ForeignKey, String, Text, func
from sqlalchemy import JSON as JSONB, Uuid as UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class RootCause(Base):
    __tablename__ = "root_causes"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    title: Mapped[str] = mapped_column(String(500), nullable=False)
    summary: Mapped[str] = mapped_column(Text, nullable=True)
    confidence: Mapped[float] = mapped_column(Float, default=0.0)
    primary_finding_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("findings.id"), nullable=True
    )
    affected_domains: Mapped[list] = mapped_column(JSONB, default=list)
    evidence: Mapped[list] = mapped_column(JSONB, default=list)
    ai_analysis: Mapped[str | None] = mapped_column(Text, nullable=True)
    agent_run_id: Mapped[str | None] = mapped_column(String(100), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )

    primary_finding: Mapped["Finding | None"] = relationship("Finding", foreign_keys=[primary_finding_id])  # type: ignore[name-defined]
    finding_links: Mapped[list["RootCauseFinding"]] = relationship(
        "RootCauseFinding", back_populates="root_cause", cascade="all, delete-orphan"
    )
    remediation_plans: Mapped[list["RemediationPlan"]] = relationship("RemediationPlan", back_populates="root_cause")  # type: ignore[name-defined]

    def __repr__(self) -> str:
        return f"<RootCause {self.title[:50]}>"


class RootCauseFinding(Base):
    """Association table linking root causes to their symptom findings."""
    __tablename__ = "root_cause_findings"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    root_cause_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("root_causes.id", ondelete="CASCADE"), nullable=False, index=True
    )
    finding_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("findings.id", ondelete="CASCADE"), nullable=False, index=True
    )
    relationship_type: Mapped[str] = mapped_column(String(50), default="symptom")  # symptom | cause | effect
    order_index: Mapped[int] = mapped_column(default=0)

    root_cause: Mapped["RootCause"] = relationship("RootCause", back_populates="finding_links")
    finding: Mapped["Finding"] = relationship("Finding", back_populates="root_cause_findings")  # type: ignore[name-defined]

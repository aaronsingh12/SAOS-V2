"""SAOS — Impact Model."""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, Float, ForeignKey, Integer, String, Text, func
from sqlalchemy import JSON as JSONB, Uuid as UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class Impact(Base):
    __tablename__ = "impacts"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    finding_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("findings.id", ondelete="CASCADE"), nullable=False, index=True
    )
    root_cause_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("root_causes.id"), nullable=True
    )

    # Counts (deterministic relationship traversal)
    affected_ci_count: Mapped[int] = mapped_column(Integer, default=0)
    affected_app_service_count: Mapped[int] = mapped_column(Integer, default=0)
    affected_business_service_count: Mapped[int] = mapped_column(Integer, default=0)
    affected_alert_count: Mapped[int] = mapped_column(Integer, default=0)

    # IDs
    affected_ci_ids: Mapped[list] = mapped_column(JSONB, default=list)
    affected_app_service_ids: Mapped[list] = mapped_column(JSONB, default=list)
    affected_business_service_ids: Mapped[list] = mapped_column(JSONB, default=list)

    # Scores
    business_impact_score: Mapped[float] = mapped_column(Float, default=0.0)
    operational_impact_score: Mapped[float] = mapped_column(Float, default=0.0)

    # Description
    impact_summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    dependency_chain: Mapped[list] = mapped_column(JSONB, default=list)

    calculated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    finding: Mapped["Finding"] = relationship("Finding")  # type: ignore[name-defined]

    def __repr__(self) -> str:
        return f"<Impact CIs={self.affected_ci_count} Services={self.affected_app_service_count}>"

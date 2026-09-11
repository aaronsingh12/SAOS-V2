"""SAOS — Evidence Model."""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, Text, func
from sqlalchemy import JSON as JSONB, Uuid as UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class Evidence(Base):
    __tablename__ = "finding_evidence"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    finding_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("findings.id", ondelete="CASCADE"), nullable=False, index=True
    )
    source: Mapped[str] = mapped_column(String(100), nullable=False)    # e.g. "Discovery", "IntegrationHub"
    sn_table: Mapped[str | None] = mapped_column(String(100), nullable=True)  # ServiceNow table
    sn_sys_id: Mapped[str | None] = mapped_column(String(100), nullable=True)
    field_name: Mapped[str | None] = mapped_column(String(100), nullable=True)
    field_value: Mapped[str | None] = mapped_column(Text, nullable=True)
    expected_value: Mapped[str | None] = mapped_column(Text, nullable=True)
    reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    evidence_type: Mapped[str] = mapped_column(String(50), default="field_value")  # field_value | relationship | metric | log
    raw_data: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    collected_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    finding: Mapped["Finding"] = relationship("Finding", back_populates="evidence")  # type: ignore[name-defined]

    def __repr__(self) -> str:
        return f"<Evidence {self.source}:{self.field_name}={self.field_value}>"

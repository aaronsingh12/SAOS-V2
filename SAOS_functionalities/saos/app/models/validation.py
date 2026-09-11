"""SAOS — Validation Model."""
from __future__ import annotations

import enum
import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, Enum, ForeignKey, String, Text, func
from sqlalchemy import JSON as JSONB, Uuid as UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class ValidationStatus(str, enum.Enum):
    PENDING = "PENDING"
    RUNNING = "RUNNING"
    PASSED = "PASSED"
    FAILED = "FAILED"
    ERROR = "ERROR"


class Validation(Base):
    __tablename__ = "validations"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    execution_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("executions.id"), nullable=False, index=True
    )
    plan_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("remediation_plans.id"), nullable=False
    )

    status: Mapped[ValidationStatus] = mapped_column(
        Enum(ValidationStatus), nullable=False, default=ValidationStatus.PENDING
    )
    passed: Mapped[bool] = mapped_column(Boolean, default=False)

    expected_result: Mapped[dict] = mapped_column(JSONB, default=dict)
    actual_result: Mapped[dict | None] = mapped_column(JSONB, nullable=True)

    checks: Mapped[list] = mapped_column(JSONB, default=list)  # list of {check, expected, actual, passed}
    evidence: Mapped[list] = mapped_column(JSONB, default=list)
    failure_reason: Mapped[str | None] = mapped_column(Text, nullable=True)

    # NOTE: Validation MUST use fresh ServiceNow reads, not cached estate
    data_source: Mapped[str] = mapped_column(String(50), default="servicenow_live")

    validated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    execution: Mapped["Execution"] = relationship("Execution", back_populates="validations")  # type: ignore[name-defined]

    def __repr__(self) -> str:
        return f"<Validation execution={self.execution_id} passed={self.passed}>"

"""SAOS — Audit Event Model — immutable audit trail."""
from __future__ import annotations

import enum
import uuid
from datetime import datetime

from sqlalchemy import DateTime, Enum, ForeignKey, String, func
from sqlalchemy import JSON as JSONB, Uuid as UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class AuditEventType(str, enum.Enum):
    LOGIN = "LOGIN"
    LOGOUT = "LOGOUT"
    LOGIN_FAILED = "LOGIN_FAILED"
    AGENT_RUN_STARTED = "AGENT_RUN_STARTED"
    AGENT_RUN_COMPLETED = "AGENT_RUN_COMPLETED"
    FINDING_CREATED = "FINDING_CREATED"
    FINDING_UPDATED = "FINDING_UPDATED"
    ROOT_CAUSE_CREATED = "ROOT_CAUSE_CREATED"
    PLAN_CREATED = "PLAN_CREATED"
    PLAN_UPDATED = "PLAN_UPDATED"
    PLAN_SUBMITTED = "PLAN_SUBMITTED"
    APPROVAL_REQUESTED = "APPROVAL_REQUESTED"
    PLAN_APPROVED = "PLAN_APPROVED"
    PLAN_REJECTED = "PLAN_REJECTED"
    CHANGES_REQUESTED = "CHANGES_REQUESTED"
    EXECUTION_STARTED = "EXECUTION_STARTED"
    EXECUTION_COMPLETED = "EXECUTION_COMPLETED"
    EXECUTION_FAILED = "EXECUTION_FAILED"
    ROLLBACK_STARTED = "ROLLBACK_STARTED"
    ROLLBACK_COMPLETED = "ROLLBACK_COMPLETED"
    VALIDATION_STARTED = "VALIDATION_STARTED"
    VALIDATION_COMPLETED = "VALIDATION_COMPLETED"
    SN_WRITE_OPERATION = "SN_WRITE_OPERATION"
    UNAUTHORIZED_ATTEMPT = "UNAUTHORIZED_ATTEMPT"
    SETTINGS_CHANGED = "SETTINGS_CHANGED"
    USER_CREATED = "USER_CREATED"
    USER_UPDATED = "USER_UPDATED"


class AuditEvent(Base):
    __tablename__ = "audit_events"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    event_type: Mapped[AuditEventType] = mapped_column(Enum(AuditEventType), nullable=False, index=True)
    user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=True, index=True
    )
    agent_id: Mapped[str | None] = mapped_column(String(100), nullable=True)
    object_type: Mapped[str | None] = mapped_column(String(100), nullable=True)
    object_id: Mapped[str | None] = mapped_column(String(100), nullable=True, index=True)
    action: Mapped[str] = mapped_column(String(200), nullable=False)
    before_json: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    after_json: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    metadata_json: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    source_ip: Mapped[str | None] = mapped_column(String(50), nullable=True)
    timestamp: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False, index=True
    )

    user: Mapped["User | None"] = relationship("User", back_populates="audit_events")  # type: ignore[name-defined]

    def __repr__(self) -> str:
        return f"<AuditEvent {self.event_type} [{self.timestamp}]>"

"""SAOS — User Model with RBAC roles."""
from __future__ import annotations

import enum
import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, Enum, String, func
from sqlalchemy import JSON as JSONB, Uuid as UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class UserRole(str, enum.Enum):
    ADMIN = "admin"
    OPERATOR = "operator"
    APPROVER = "approver"
    VIEWER = "viewer"


class User(Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    email: Mapped[str] = mapped_column(String(255), unique=True, nullable=False, index=True)
    full_name: Mapped[str] = mapped_column(String(255), nullable=False)
    hashed_password: Mapped[str] = mapped_column(String(255), nullable=False)
    role: Mapped[UserRole] = mapped_column(
        Enum(UserRole), nullable=False, default=UserRole.VIEWER
    )
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )

    # Relationships
    approvals: Mapped[list["Approval"]] = relationship("Approval", back_populates="approver")  # type: ignore[name-defined]
    audit_events: Mapped[list["AuditEvent"]] = relationship("AuditEvent", back_populates="user")  # type: ignore[name-defined]

    def __repr__(self) -> str:
        return f"<User {self.email} [{self.role}]>"

    @property
    def can_approve(self) -> bool:
        return self.role in (UserRole.APPROVER, UserRole.ADMIN)

    @property
    def can_execute(self) -> bool:
        return self.role in (UserRole.OPERATOR, UserRole.ADMIN)

    @property
    def can_admin(self) -> bool:
        return self.role == UserRole.ADMIN

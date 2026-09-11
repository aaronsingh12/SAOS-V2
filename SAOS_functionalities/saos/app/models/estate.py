"""SAOS — Estate Snapshot Models (versioned local CMDB mirror)."""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, Text, func
from sqlalchemy import JSON as JSONB, Uuid as UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class EstateSnapshot(Base):
    """Versioned point-in-time snapshot of the ServiceNow estate."""
    __tablename__ = "estate_snapshots"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    source_instance: Mapped[str] = mapped_column(String(255), nullable=False)
    version: Mapped[str] = mapped_column(String(100), nullable=False)
    ci_count: Mapped[int] = mapped_column(default=0)
    relationship_count: Mapped[int] = mapped_column(default=0)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    entities: Mapped[list["EstateEntity"]] = relationship(
        "EstateEntity", back_populates="snapshot", cascade="all, delete-orphan"
    )
    relationships: Mapped[list["EstateRelationship"]] = relationship(
        "EstateRelationship", back_populates="snapshot", cascade="all, delete-orphan"
    )

    def __repr__(self) -> str:
        return f"<EstateSnapshot {self.version} ({self.ci_count} CIs)>"


class EstateEntity(Base):
    """Individual CI/record within an estate snapshot."""
    __tablename__ = "estate_entities"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    snapshot_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("estate_snapshots.id", ondelete="CASCADE"), nullable=False, index=True
    )
    source_table: Mapped[str] = mapped_column(String(100), nullable=False)
    source_sys_id: Mapped[str] = mapped_column(String(100), nullable=False, index=True)
    entity_type: Mapped[str] = mapped_column(String(100), nullable=False)
    ci_class: Mapped[str | None] = mapped_column(String(100), nullable=True)
    canonical_name: Mapped[str | None] = mapped_column(String(500), nullable=True)
    attributes: Mapped[dict] = mapped_column(JSONB, default=dict, nullable=False)
    source_metadata: Mapped[dict] = mapped_column(JSONB, default=dict, nullable=False)
    extracted_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)

    snapshot: Mapped["EstateSnapshot"] = relationship("EstateSnapshot", back_populates="entities")

    def __repr__(self) -> str:
        return f"<EstateEntity {self.entity_type}:{self.canonical_name}>"


class EstateRelationship(Base):
    """Relationship between two entities in an estate snapshot."""
    __tablename__ = "estate_relationships"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    snapshot_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("estate_snapshots.id", ondelete="CASCADE"), nullable=False, index=True
    )
    source: Mapped[str] = mapped_column(String(100), nullable=False)
    source_sys_id: Mapped[str] = mapped_column(String(100), nullable=False)
    parent_entity_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("estate_entities.id"), nullable=True
    )
    child_entity_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("estate_entities.id"), nullable=True
    )
    relationship_type: Mapped[str] = mapped_column(String(100), nullable=False)
    attributes: Mapped[dict] = mapped_column(JSONB, default=dict, nullable=False)

    snapshot: Mapped["EstateSnapshot"] = relationship("EstateSnapshot", back_populates="relationships")

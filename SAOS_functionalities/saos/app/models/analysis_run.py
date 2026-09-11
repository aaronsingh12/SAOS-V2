"""Durable run queue and reproducible run manifests."""
import uuid
from datetime import datetime
from sqlalchemy import DateTime, ForeignKey, String, Text, JSON, Uuid, func
from sqlalchemy.orm import Mapped, mapped_column
from app.database import Base


class AnalysisRun(Base):
    __tablename__ = "analysis_runs"
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    requested_by: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("users.id"), nullable=False)
    source_instance: Mapped[str] = mapped_column(String(255), nullable=False)
    active_key: Mapped[str | None] = mapped_column(String(255), unique=True, nullable=True)
    status: Mapped[str] = mapped_column(String(30), default="queued", index=True)
    phase: Mapped[str] = mapped_column(String(100), default="queued")
    snapshot_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("estate_snapshots.id"), nullable=True)
    manifest: Mapped[dict] = mapped_column(JSON, default=dict)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    worker_id: Mapped[str | None] = mapped_column(String(100), nullable=True)
    lease_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

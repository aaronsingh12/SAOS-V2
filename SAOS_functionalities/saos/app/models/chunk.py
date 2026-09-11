"""Persisted ServiceNow extraction chunks used as the analysis input."""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, func
from sqlalchemy import JSON as JSONB, Uuid as UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class ServiceNowDataChunk(Base):
    """A bounded set of ServiceNow rows captured before analysis starts."""
    __tablename__ = "servicenow_data_chunks"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    run_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("analysis_runs.id", ondelete="CASCADE"), nullable=False, index=True
    )
    source_instance: Mapped[str] = mapped_column(String(255), nullable=False)
    table_name: Mapped[str] = mapped_column(String(100), nullable=False, index=True)
    sequence: Mapped[int] = mapped_column(Integer, nullable=False)
    cutoff: Mapped[str] = mapped_column(String(30), nullable=False)
    record_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    record_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    records: Mapped[list[dict]] = mapped_column(JSONB, default=list, nullable=False)
    coverage: Mapped[dict] = mapped_column(JSONB, default=dict, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)

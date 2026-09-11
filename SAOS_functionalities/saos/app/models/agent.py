"""SAOS — Agent Registry Model."""
from __future__ import annotations

import enum
import uuid
from datetime import datetime

from sqlalchemy import DateTime, Enum, Integer, String, Text, func
from sqlalchemy import JSON as JSONB, Uuid as UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class AgentClass(str, enum.Enum):
    SENSING = "SENSING"
    ANALYSIS = "ANALYSIS"
    SYNTHESIS = "SYNTHESIS"
    ACTION = "ACTION"


class Agent(Base):
    __tablename__ = "agents"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    agent_id: Mapped[str] = mapped_column(String(100), unique=True, nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    version: Mapped[str] = mapped_column(String(50), nullable=False, default="1.0.0")
    agent_class: Mapped[AgentClass] = mapped_column(Enum(AgentClass), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=True)
    timeout_seconds: Mapped[int] = mapped_column(Integer, default=300)
    token_budget: Mapped[int] = mapped_column(Integer, default=4096)
    allowed_tools: Mapped[list] = mapped_column(JSONB, default=list)
    input_schema: Mapped[dict] = mapped_column(JSONB, default=dict)
    output_schema: Mapped[dict] = mapped_column(JSONB, default=dict)
    is_active: Mapped[bool] = mapped_column(default=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )

    runs: Mapped[list["AgentRun"]] = relationship("AgentRun", back_populates="agent")  # type: ignore[name-defined]

    def __repr__(self) -> str:
        return f"<Agent {self.agent_id} v{self.version}>"

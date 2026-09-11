"""
SAOS — Database Configuration
Supports PostgreSQL (asyncpg) for production and SQLite (aiosqlite) for local dev.
The DATABASE_URL in .env controls which is used.
"""
from __future__ import annotations

from typing import AsyncGenerator

from sqlalchemy import MetaData, event
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.orm import DeclarativeBase

from app.config import settings

# ── Detect driver ─────────────────────────────────────────────────────────────
_db_url = settings.database_url
_is_sqlite = _db_url.startswith("sqlite")

# ── Engine ────────────────────────────────────────────────────────────────────
if _is_sqlite:
    # SQLite: no pool_size/max_overflow
    engine = create_async_engine(
        _db_url,
        echo=settings.app_debug,
        connect_args={"check_same_thread": False},
    )
else:
    # PostgreSQL: full pool settings
    engine = create_async_engine(
        _db_url,
        echo=settings.app_debug,
        pool_pre_ping=True,
        pool_size=10,
        max_overflow=20,
    )

# ── Session Factory ───────────────────────────────────────────────────────────
AsyncSessionLocal = async_sessionmaker(
    engine,
    class_=AsyncSession,
    expire_on_commit=False,
    autoflush=False,
    autocommit=False,
)

# ── Naming Convention (for Alembic) ──────────────────────────────────────────
NAMING_CONVENTION = {
    "ix": "ix_%(column_0_label)s",
    "uq": "uq_%(table_name)s_%(column_0_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}


class Base(DeclarativeBase):
    metadata = MetaData(naming_convention=NAMING_CONVENTION)


# ── Dependency ────────────────────────────────────────────────────────────────
async def get_db() -> AsyncGenerator[AsyncSession, None]:
    async with AsyncSessionLocal() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
        finally:
            await session.close()


async def init_db() -> None:
    """Create all tables directly (dev mode / SQLite). Production uses Alembic."""
    # Import all models to register them with Base.metadata
    import app.models  # noqa: F401
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)


async def drop_db() -> None:
    """Drop all tables (testing only)."""
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)

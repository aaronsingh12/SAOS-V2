-- SAOS PostgreSQL init script (runs on first container start)
-- The ORM + Alembic handle actual schema creation.
-- This script only ensures the DB and user exist.

-- (PostgreSQL already creates db from POSTGRES_DB env var)
-- Nothing else needed here; Alembic handles schema.

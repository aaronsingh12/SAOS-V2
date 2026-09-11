"""
SAOS — Application Configuration
All settings loaded from environment variables via pydantic-settings.
Secrets NEVER hard-coded here.
"""
from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # ── Application ──────────────────────────────────────────────────────────
    app_env: Literal["development", "staging", "production"] = "development"
    app_secret_key: str
    app_base_url: str = "http://localhost:8000"
    app_debug: bool = False
    app_log_level: str = "INFO"
    app_name: str = "SAOS"
    app_version: str = "1.0.0"

    # ── JWT ──────────────────────────────────────────────────────────────────
    jwt_secret_key: str
    jwt_algorithm: str = "HS256"
    jwt_expire_minutes: int = 480

    # ── Database ─────────────────────────────────────────────────────────────
    database_url: str
    postgres_host: str = "localhost"
    postgres_port: int = 5432
    postgres_db: str = "saos"
    postgres_user: str = "saos_user"
    postgres_password: str

    # ── Redis ────────────────────────────────────────────────────────────────
    redis_url: str = "redis://localhost:6379/0"

    # ── Ollama / LLM ─────────────────────────────────────────────────────────
    ollama_base_url: str = "http://localhost:11434"
    ollama_model: str = "gpt-oss:120b-cloud"
    ollama_timeout_seconds: int = 120
    ollama_max_retries: int = 3

    # ── ServiceNow ───────────────────────────────────────────────────────────
    servicenow_mode: Literal["live"] = "live"
    servicenow_instance_url: str = ""
    servicenow_reader_username: str = ""
    servicenow_reader_password: str = ""
    servicenow_writer_username: str = "saos_writer"
    servicenow_writer_password: str = ""
    servicenow_timeout_seconds: int = 30
    servicenow_max_retries: int = 3

    # ── Approval Policy ──────────────────────────────────────────────────────
    approval_expiry_hours: int = 48
    require_approval_comment_for: str = "HIGH,CRITICAL"

    # ── Dev Defaults (DEVELOPMENT ONLY) ─────────────────────────────────────
    dev_admin_email: str = "admin@example.com"
    dev_admin_password: str = ""

    # ── Run Config ──────────────────────────────────────────────────────────
    max_cis_per_run: int = 100000
    max_findings_per_run: int = 1000

    servicenow_auth_type: Literal["basic", "oauth"] = "basic"
    servicenow_oauth_client_id: str = ""
    servicenow_oauth_client_secret: str = Field("", repr=False)
    servicenow_page_size: int = Field(500, ge=1, le=1000)
    servicenow_max_records_per_table: int = Field(100000, ge=1, le=1000000)
    servicenow_request_interval: float = Field(0.1, ge=0, le=60)
    servicenow_optional_tables: str = "cmdb_ci_service,service_offering,ecc_agent,ecc_queue,em_alert,incident,change_request,problem,sys_script,sys_rest_message,sys_trigger,sys_upgrade_history_log,sys_user_has_role"
    analysis_timeout_seconds: int = Field(3600, ge=30, le=43200)
    worker_poll_seconds: float = Field(2, ge=0.1, le=60)
    worker_lease_seconds: int = Field(120, ge=30, le=600)
    analysis_worker_enabled: bool = True
    llm_enabled: bool = True
    llm_token_budget: int = Field(4096, ge=256, le=16384)
    stale_ci_days: int = Field(90, ge=1)
    analysis_chunk_size: int = Field(250, ge=1, le=5000)

    @model_validator(mode="after")
    def validate_configuration(self):
        from urllib.parse import urlsplit
        if self.servicenow_instance_url:
            url = urlsplit(self.servicenow_instance_url)
            if url.scheme != "https" or not url.hostname or url.username or url.password or url.query or url.fragment or url.path not in ("", "/"):
                raise ValueError("SERVICENOW_INSTANCE_URL must be an HTTPS origin without credentials or a path")
        if self.app_env != "development":
            for secret in (self.app_secret_key, self.jwt_secret_key):
                if len(secret) < 32 or any(x in secret.lower() for x in ("change_me", "changeme", "placeholder", "dev-secret")):
                    raise ValueError("Production secrets must be independently generated, at least 32 characters")
            if self.app_secret_key == self.jwt_secret_key:
                raise ValueError("APP_SECRET_KEY and JWT_SECRET_KEY must differ")
            if self.app_debug or not self.database_url.startswith("postgresql+asyncpg://"):
                raise ValueError("Staging/production requires PostgreSQL and APP_DEBUG=false")
            if not self.app_base_url.startswith("https://"):
                raise ValueError("Staging/production APP_BASE_URL must use HTTPS")
        return self

    @property
    def connection_configured(self):
        credentials = (self.servicenow_reader_username and self.servicenow_reader_password) if self.servicenow_auth_type == "basic" else (self.servicenow_oauth_client_id and self.servicenow_oauth_client_secret)
        return bool(self.servicenow_instance_url and credentials)

    @property
    def severities_requiring_comment(self) -> list[str]:
        return [s.strip() for s in self.require_approval_comment_for.split(",")]

    @property
    def is_mock_mode(self) -> bool:
        return False

    @property
    def is_production(self) -> bool:
        return self.app_env == "production"


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()


settings = get_settings()

"""SAOS live ServiceNow analysis service."""
import asyncio
import contextlib
import logging
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlsplit
from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, RedirectResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from app.config import settings
from app.database import AsyncSessionLocal, engine
from app.orchestration.worker import register_agents, main as worker_main

logging.basicConfig(level=settings.app_log_level, format="%(asctime)s %(levelname)s %(name)s %(message)s")
# HTTP request bodies/URLs can contain sensitive query data.
logging.getLogger("httpx").setLevel(logging.WARNING)


@asynccontextmanager
async def lifespan(app):
    worker_task = None
    if settings.app_env == "development":
        from app.database import init_db
        await init_db()
    async with AsyncSessionLocal() as db:
        await register_agents(db)
    if settings.analysis_worker_enabled:
        worker_task = asyncio.create_task(worker_main(), name="saos-analysis-worker")
    try:
        yield
    finally:
        if worker_task:
            worker_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await worker_task
        await engine.dispose()


app = FastAPI(title="SAOS", version="2.0.0", lifespan=lifespan,
    docs_url="/api/docs" if settings.app_debug else None, redoc_url=None, openapi_url="/api/openapi.json" if settings.app_debug else None)
hosts = [urlsplit(settings.app_base_url).hostname]
if settings.app_env == "development":
    hosts += ["localhost", "127.0.0.1", "testserver"]
app.add_middleware(TrustedHostMiddleware, allowed_hosts=[h for h in hosts if h])


@app.middleware("http")
async def security_headers(request: Request, call_next):
    if request.method in {"POST", "PUT", "PATCH", "DELETE"}:
        origin = request.headers.get("origin")
        allowed = {settings.app_base_url.rstrip("/")}
        if settings.app_env == "development":
            allowed.add(str(request.base_url).rstrip("/"))
        bearer = request.headers.get("authorization", "").startswith("Bearer ")
        if (origin and origin not in allowed) or (request.cookies.get("saos_session") and not origin and not bearer):
            return JSONResponse({"detail": "Request origin rejected"}, status_code=403)
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "same-origin"
    response.headers["Content-Security-Policy"] = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
    if request.url.path.startswith("/api"):
        response.headers["Cache-Control"] = "no-store"
    if settings.app_env != "development":
        response.headers["Strict-Transport-Security"] = "max-age=31536000"
    return response


from app.api.auth import router as auth_router
from app.api.analysis import router as analysis_router
from app.api.dashboard import router as dashboard_router
from app.api.findings import router as findings_router
from app.api.chat import router as chat_router
from app.api.remediation import remediation_router, agents_router, audit_router, health_router, execution_router
for router in (auth_router, analysis_router, dashboard_router, findings_router, chat_router, remediation_router,
               agents_router, audit_router, health_router, execution_router):
    app.include_router(router)

ROOT = Path(__file__).parent
app.mount("/static", StaticFiles(directory=ROOT / "static"), name="static")
templates = Jinja2Templates(directory=ROOT / "templates")


@app.get("/", include_in_schema=False)
async def root():
    return RedirectResponse("/dashboard")


@app.get("/login", response_class=HTMLResponse, include_in_schema=False)
async def login_page(request: Request):
    return templates.TemplateResponse(request=request, name="login.html")


@app.get("/{page}", response_class=HTMLResponse, include_in_schema=False)
async def page(request: Request, page: str):
    if page not in {"dashboard", "findings", "remediation", "agents", "audit", "cmdb", "itom", "settings", "estate", "executions"}:
        from fastapi import HTTPException
        raise HTTPException(404)
    return templates.TemplateResponse(request=request, name="workspace.html", context={"page": page})


@app.get("/findings/{finding_id}", response_class=HTMLResponse, include_in_schema=False)
async def finding_page(request: Request, finding_id: str):
    return templates.TemplateResponse(request=request, name="workspace.html", context={"page": "finding", "object_id": finding_id})


@app.get("/remediation/{plan_id}", response_class=HTMLResponse, include_in_schema=False)
async def plan_page(request: Request, plan_id: str):
    return templates.TemplateResponse(request=request, name="workspace.html", context={"page": "plan", "object_id": plan_id})

"""JWT authentication with HttpOnly cookies, RBAC and persisted login throttling."""
import hashlib
import uuid
from datetime import datetime, timedelta, timezone
import bcrypt
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.security import OAuth2PasswordRequestForm
from jose import JWTError, jwt
from sqlalchemy import select, func
from app.config import settings
from app.database import get_db
from app.models.user import User
from app.models.audit import AuditEvent, AuditEventType

router = APIRouter(prefix="/api/auth", tags=["auth"])


def hash_password(password):
    encoded = password.encode("utf-8")
    if len(encoded) < 12 or len(encoded) > 72:
        raise ValueError("Password must be 12?72 UTF-8 bytes")
    return bcrypt.hashpw(encoded, bcrypt.gensalt()).decode()


def verify_password(plain, hashed):
    if len(plain.encode("utf-8")) > 72:
        return False
    try:
        return bcrypt.checkpw(plain.encode("utf-8"), hashed.encode())
    except ValueError:
        return False


def create_access_token(data):
    return jwt.encode({**data, "iat": datetime.now(timezone.utc),
        "exp": datetime.now(timezone.utc)+timedelta(minutes=settings.jwt_expire_minutes)},
        settings.jwt_secret_key, algorithm="HS256")


async def get_current_user(request: Request, db=Depends(get_db)):
    authorization = request.headers.get("authorization", "")
    token = authorization[7:] if authorization.startswith("Bearer ") else request.cookies.get("saos_session")
    try:
        payload = jwt.decode(token or "", settings.jwt_secret_key, algorithms=["HS256"],
            options={"require_exp": True, "require_sub": True})
        uid = uuid.UUID(payload["sub"])
    except (JWTError, ValueError, TypeError, KeyError):
        raise HTTPException(401, "Sign in required") from None
    user = await db.get(User, uid)
    if not user or not user.is_active:
        raise HTTPException(401, "Sign in required")
    return user


def require_roles(*roles):
    async def check(user=Depends(get_current_user)):
        if user.role not in roles:
            raise HTTPException(403, "Insufficient role")
        return user
    return check


# Constant dummy hash equalizes the password-verification work for unknown users.
_DUMMY_HASH = bcrypt.hashpw(b"unused-password-value", bcrypt.gensalt()).decode()


@router.post("/token")
async def login(request: Request, response: Response, form: OAuth2PasswordRequestForm = Depends(), db=Depends(get_db)):
    email = form.username.strip().lower()
    key = hashlib.sha256(email.encode()).hexdigest()
    failures = await db.scalar(select(func.count(AuditEvent.id)).where(AuditEvent.event_type == AuditEventType.LOGIN_FAILED,
        AuditEvent.object_id == key, AuditEvent.timestamp >= datetime.now(timezone.utc)-timedelta(minutes=5)))
    if failures >= 10:
        raise HTTPException(429, "Too many login attempts; retry in five minutes", headers={"Retry-After": "300"})
    user = await db.scalar(select(User).where(func.lower(User.email) == email))
    import asyncio
    valid = await asyncio.to_thread(verify_password, form.password, user.hashed_password if user else _DUMMY_HASH)
    if not user or not valid or not user.is_active:
        db.add(AuditEvent(event_type=AuditEventType.LOGIN_FAILED, object_type="login", object_id=key, action="Login failed"))
        await db.commit()
        raise HTTPException(401, "Incorrect email or password")
    user.last_login_at = datetime.now(timezone.utc)
    db.add(AuditEvent(event_type=AuditEventType.LOGIN, user_id=user.id, action="User signed in"))
    await db.commit()
    token = create_access_token({"sub": str(user.id)})
    response.set_cookie("saos_session", token, httponly=True, secure=settings.app_env != "development",
        samesite="strict", max_age=settings.jwt_expire_minutes*60, path="/")
    response.headers["Cache-Control"] = "no-store"
    return {"access_token": token, "token_type": "bearer", "role": user.role.value, "full_name": user.full_name}


@router.post("/logout")
async def logout(response: Response):
    response.delete_cookie("saos_session", path="/")
    return {"status": "signed_out"}


@router.get("/me")
async def me(user=Depends(get_current_user)):
    return {"id": str(user.id), "email": user.email, "full_name": user.full_name,
        "role": user.role.value, "can_execute": user.can_execute, "can_admin": user.can_admin}

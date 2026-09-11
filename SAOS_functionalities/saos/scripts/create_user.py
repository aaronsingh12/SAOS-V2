"""Interactive user provisioning; no default credentials or sample accounts."""
import asyncio
import getpass
from sqlalchemy import select
from app.database import AsyncSessionLocal
from app.models.user import User, UserRole
from app.api.auth import hash_password

async def main():
    email = input("Email: ").strip().lower()
    name = input("Full name: ").strip()
    role = UserRole(input("Role (admin/operator/approver/viewer): ").strip())
    password = getpass.getpass("Password (12?72 UTF-8 bytes): ")
    if password != getpass.getpass("Confirm password: "):
        raise SystemExit("Passwords do not match")
    if "@" not in email or not name:
        raise SystemExit("Valid email and full name required")
    async with AsyncSessionLocal() as db:
        if await db.scalar(select(User).where(User.email == email)):
            raise SystemExit("User already exists; no changes made")
        db.add(User(email=email, full_name=name, role=role, is_active=True, hashed_password=hash_password(password)))
        await db.commit()
    print("User created")

if __name__ == "__main__":
    asyncio.run(main())

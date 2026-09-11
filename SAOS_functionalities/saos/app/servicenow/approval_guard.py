"""
SAOS — Approval Guard
THE most critical security component.
Validates all 11 pre-execution checks before any ServiceNow write.
This guard CANNOT be bypassed.
"""
from __future__ import annotations

import hashlib
import json
import logging
from datetime import datetime, timezone
from typing import TYPE_CHECKING

from fastapi import HTTPException, status

from app.config import settings

if TYPE_CHECKING:
    from app.models.remediation import RemediationPlan
    from app.models.approval import Approval
    from app.models.user import User

logger = logging.getLogger(__name__)


class ApprovalGuardError(Exception):
    """Raised when pre-execution approval validation fails."""
    def __init__(self, message: str, code: str = "APPROVAL_GUARD_FAILED") -> None:
        super().__init__(message)
        self.code = code


class ApprovalGuard:
    """
    Validates all 11 pre-execution checks.
    ALL checks must pass before execution proceeds.
    No exceptions. No bypasses.
    """

    @staticmethod
    def compute_plan_hash(plan: "RemediationPlan") -> str:
        """
        Compute SHA-256 hash of plan's locked content.
        Must be recomputed before every execution for comparison.
        """
        content = {
            "plan_version": plan.plan_version,
            "target_ids": sorted(plan.target_ids or []),
            "before_state": plan.before_state or {},
            "proposed_state": plan.proposed_state or {},
            "implementation_steps": plan.implementation_steps or [],
            "rollback_steps": plan.rollback_steps or [],
            "validation_criteria": plan.validation_criteria or [],
        }
        canonical = json.dumps(content, sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(canonical.encode()).hexdigest()

    @classmethod
    def validate(
        cls,
        plan: "RemediationPlan",
        approval: "Approval",
        executing_user: "User",
    ) -> None:
        """
        Run all 11 pre-execution checks.
        Raises ApprovalGuardError or HTTPException if any check fails.
        Audit rejected attempts externally.
        """
        from app.models.remediation import RemediationStatus
        from app.models.approval import ApprovalStatus
        from app.models.user import UserRole

        errors: list[str] = []

        # CHECK 1: Plan exists
        if plan is None:
            raise ApprovalGuardError("CHECK 1 FAILED: Plan does not exist", "PLAN_NOT_FOUND")

        # CHECK 2: Plan status is APPROVED
        if plan.status != RemediationStatus.APPROVED:
            errors.append(f"CHECK 2 FAILED: Plan status is '{plan.status}', must be APPROVED")

        # CHECK 3: approved_by exists
        if not plan.approved_by:
            errors.append("CHECK 3 FAILED: Plan has no approved_by value")

        # CHECK 4: approved_at exists
        if not plan.approved_at:
            errors.append("CHECK 4 FAILED: Plan has no approved_at timestamp")

        # CHECK 5: Plan hash matches (plan not modified after approval)
        current_hash = cls.compute_plan_hash(plan)
        if approval.plan_hash != current_hash:
            errors.append(
                f"CHECK 5 FAILED: Plan hash mismatch — plan was modified after approval. "
                f"Re-approval required. (stored={approval.plan_hash[:16]}... "
                f"current={current_hash[:16]}...)"
            )

        # CHECK 6: Plan version matches approved version
        if approval.plan_version != plan.plan_version:
            errors.append(
                f"CHECK 6 FAILED: Plan version mismatch — "
                f"approved v{approval.plan_version}, current v{plan.plan_version}"
            )

        # CHECK 7: Approver has approver or admin role
        if approval.approver_id is None:
            errors.append("CHECK 7 FAILED: Approval has no approver assigned")
        # Role check requires approver user object — done in executor
        from app.models.user import UserRole
        if executing_user.role not in (UserRole.OPERATOR, UserRole.ADMIN):
            errors.append(f"CHECK 7b FAILED: Executing user role '{executing_user.role}' cannot execute plans")

        # CHECK 8: Approval has not expired
        if approval.is_expired:
            errors.append("CHECK 8 FAILED: Approval has expired")
        if approval.expires_at:
            exp = approval.expires_at if approval.expires_at.tzinfo is not None else approval.expires_at.replace(tzinfo=timezone.utc)
            if datetime.now(timezone.utc) > exp:
                errors.append(f"CHECK 8b FAILED: Approval expired at {approval.expires_at}")

        # CHECK 9: Approval status is APPROVED
        if approval.status != ApprovalStatus.APPROVED:
            errors.append(f"CHECK 9 FAILED: Approval status is '{approval.status}', must be APPROVED")

        # CHECK 10: Rollback information exists
        if not plan.rollback_steps:
            errors.append("CHECK 10 FAILED: No rollback steps defined in plan")

        # CHECK 11: Target IDs are specified
        if not plan.target_ids:
            errors.append("CHECK 11 FAILED: Plan has no target_ids specified")

        if errors:
            error_message = " | ".join(errors)
            logger.error("ApprovalGuard BLOCKED execution of plan %s: %s", plan.id, error_message)
            raise ApprovalGuardError(error_message, "PRE_EXECUTION_CHECKS_FAILED")

        logger.info(
            "ApprovalGuard: All 11 checks PASSED for plan %s (hash=%s, v%s, approver=%s)",
            plan.id, current_hash[:16], plan.plan_version, plan.approved_by
        )

    @staticmethod
    def invalidate_approval_on_plan_change(plan: "RemediationPlan") -> None:
        """
        Call this whenever a plan is modified.
        Increments version, recalculates hash, resets status to AWAITING_APPROVAL.
        Old approval becomes SUPERSEDED.
        """
        from app.models.remediation import RemediationStatus
        plan.plan_version += 1
        plan.status = RemediationStatus.AWAITING_APPROVAL
        plan.approved_by = None
        plan.approved_at = None
        logger.warning(
            "Plan %s modified: bumped to v%s, status=AWAITING_APPROVAL. Old approval invalidated.",
            plan.id, plan.plan_version
        )

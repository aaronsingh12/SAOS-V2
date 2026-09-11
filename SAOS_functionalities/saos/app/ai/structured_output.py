"""
SAOS — Structured Output Schemas for LLM responses.
All LLM outputs are Pydantic-validated before use.
"""
from __future__ import annotations

from typing import Optional
from pydantic import BaseModel, Field


class LLMFindingAnalysis(BaseModel):
    """Structured LLM analysis of a single finding."""
    explanation: str = Field(description="Clear explanation of what the finding means")
    root_cause_hypothesis: str = Field(description="Most likely root cause")
    business_impact: str = Field(description="Business impact assessment")
    recommendation: str = Field(description="Specific actionable recommendation")
    confidence: float = Field(ge=0, le=1, description="Confidence in analysis (0-1)")
    urgency: str = Field(description="urgency level: immediate|high|medium|low")


class LLMRootCauseAnalysis(BaseModel):
    """Structured root cause clustering output."""
    root_cause_title: str
    summary: str
    confidence: float = Field(ge=0, le=100)
    affected_domains: list[str]
    causal_chain: list[str] = Field(description="Ordered list of cause -> effect steps")
    primary_finding_index: int = Field(description="Index into provided findings list (0-based)")
    related_finding_indices: list[int]


class LLMImpactAnalysis(BaseModel):
    """Structured impact analysis."""
    operational_impact: str
    business_impact: str
    end_user_impact: str
    priority_recommendation: str = Field(description="P1|P2|P3|P4|P5")
    estimated_affected_users: int = Field(default=0)
    service_degradation_percent: float = Field(default=0, ge=0, le=100)


class LLMRemediationPlan(BaseModel):
    """Structured remediation plan from LLM."""
    title: str
    description: str
    implementation_steps: list[str]
    rollback_steps: list[str]
    validation_criteria: list[str]
    prerequisites: list[str]
    estimated_effort: str = Field(description="e.g. '2 hours', '1 day'")
    risk_level: str = Field(description="LOW|MEDIUM|HIGH|CRITICAL")
    lane: str = Field(description="LANE_1|LANE_2|LANE_3")
    confidence: float = Field(ge=0, le=1)


class LLMNarrative(BaseModel):
    """Executive narrative for a set of findings."""
    executive_summary: str
    technical_summary: str
    key_risks: list[str]
    recommended_actions: list[str]
    priority: str


class LLMLiveEstateFinding(BaseModel):
    """A finding dynamically identified by the LLM from live ServiceNow data."""
    title: str = Field(description="Clear headline of the finding")
    domain: str = Field(default="CMDB", description="CMDB | INCIDENT | CHANGE | PROBLEM | RELATIONSHIP | ITOM")
    severity: str = Field(default="MEDIUM", description="CRITICAL | HIGH | MEDIUM | LOW | INFO")
    confidence: float = Field(default=0.9, ge=0, le=1, description="Confidence score between 0.0 and 1.0")
    description: str = Field(description="Detailed explanation of the issue found in the live data")
    affected_ci_ids: list[str] = Field(default_factory=list, description="Sys IDs or names of affected CIs")
    root_cause_hypothesis: str = Field(default="", description="Hypothesis for why this issue exists in ServiceNow")
    recommendation: str = Field(default="", description="Actionable remediation steps")


class LLMLiveEstateReport(BaseModel):
    """Comprehensive dynamic analysis report over live ServiceNow estate."""
    overall_health_assessment: str = Field(description="Summary of CMDB and IT operations health")
    trust_score: int = Field(default=75, ge=0, le=100, description="Estimated CMDB data trust score 0-100")
    findings: list[LLMLiveEstateFinding] = Field(default_factory=list)


class LLMAnalysisError(BaseModel):
    """Returned when LLM analysis fails gracefully."""
    error: str
    fallback_message: str
    partial_result: Optional[dict] = None

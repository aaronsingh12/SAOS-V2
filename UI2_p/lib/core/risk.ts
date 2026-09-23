import type { Risk, RiskAssessment, TwinObject } from "./types";

const text = (value: unknown) => String(value ?? "").trim();
const criticalityScore = (raw: string) => {
  const value = raw.toLowerCase();
  if (["critical", "1", "business-critical"].includes(value)) return 100;
  if (["high", "2"].includes(value)) return 75;
  if (["medium", "moderate", "3"].includes(value)) return 50;
  if (["low", "4"].includes(value)) return 25;
  return null;
};

export const SEVERITY_WEIGHTS: Record<Risk, number> = {
  Systemic: 100,
  Critical: 40,
  High: 15,
  Moderate: 5,
  Medium: 5,
  Low: 1,
};

export function applySeverityModifiers(
  baseSeverity: Risk,
  object: TwinObject,
  _evidence: Record<string, unknown>,
): { adjustedSeverity: Risk; modifierApplied: string | null; weight: number } {
  const env = text(object.data.environment).toLowerCase();
  const criticality = text(object.data.business_criticality).toLowerCase();
  const isProd = env.includes("prod") || env === "production";
  const isBusinessCritical =
    criticality.includes("critical") || criticality === "1" || criticality.includes("high");

  let current = baseSeverity;
  let modifier: string | null = null;

  if (isBusinessCritical || isProd) {
    if (current === "Low") {
      current = "Moderate";
      modifier = isBusinessCritical
        ? "Escalated to Moderate (Business Critical Service)"
        : "Escalated to Moderate (Production Environment)";
    } else if (current === "Moderate" || current === "Medium") {
      current = "High";
      modifier = isBusinessCritical
        ? "Escalated to High (Business Critical Service)"
        : "Escalated to High (Production Environment)";
    } else if (current === "High") {
      current = "Critical";
      modifier = isBusinessCritical
        ? "Escalated to Critical (Business Critical Service)"
        : "Escalated to Critical (Production Environment)";
    } else if (current === "Critical") {
      current = "Systemic";
      modifier = "Escalated to Systemic (Critical Infrastructure Defect)";
    }
  } else if (
    env.includes("dev") ||
    env.includes("test") ||
    env.includes("sandbox") ||
    env.includes("sub")
  ) {
    if (current === "Critical") {
      current = "High";
      modifier = "De-escalated to High (Non-Production Environment)";
    } else if (current === "High") {
      current = "Moderate";
      modifier = "De-escalated to Moderate (Non-Production Environment)";
    } else if (current === "Moderate" || current === "Medium") {
      current = "Low";
      modifier = "De-escalated to Low (Non-Production Environment)";
    }
  }

  return {
    adjustedSeverity: current,
    modifierApplied: modifier,
    weight: SEVERITY_WEIGHTS[current] ?? 5,
  };
}

export function assessRisk(
  risk: Risk,
  object: TwinObject,
  evidence: Record<string, unknown>,
  requiredEvidence: string[],
  now = new Date(),
): RiskAssessment {
  const missing = requiredEvidence.filter((key) => !text(evidence[key]));
  const evidenceScore = requiredEvidence.length
    ? Math.round(
        ((requiredEvidence.length - missing.length) / requiredEvidence.length) *
          100,
      )
    : Object.keys(evidence).length
      ? 100
      : 0;
  const observedAt =
    text(evidence.lastDiscovered) || text(object.data.sys_updated_on) || null;
  let freshnessScore: number | null = null;
  if (observedAt) {
    const parsed = Date.parse(
      observedAt.replace(" ", "T") + (observedAt.includes("Z") ? "" : "Z"),
    );
    if (Number.isFinite(parsed))
      freshnessScore = Math.max(
        0,
        Math.min(
          100,
          Math.round(100 - ((now.getTime() - parsed) / 86400000 / 365) * 100),
        ),
      );
  }
  const businessRaw =
    text(object.data.business_criticality) ||
    text(object.data.criticality) ||
    text(object.data.business_impact);
  const serviceRaw =
    text(object.data.service_criticality) ||
    text(object.data.service_impact) ||
    text(object.data.impact);
  const businessScore = criticalityScore(businessRaw);
  const serviceScore = criticalityScore(serviceRaw);
  const cautions: string[] = [];
  if (missing.length) cautions.push("Some evidence fields are missing.");
  if (freshnessScore === null) cautions.push("Source freshness is unknown.");
  if (businessScore === null)
    cautions.push(
      "Business criticality is unknown; risk is not business-weighted.",
    );
  if (serviceScore === null)
    cautions.push("Service impact is unknown; dependency graph is not loaded.");
  if (businessScore === null || serviceScore === null)
    cautions.push(
      "Overall risk score is withheld until impact evidence is available.",
    );

  const { adjustedSeverity, modifierApplied, weight } = applySeverityModifiers(
    risk,
    object,
    evidence,
  );

  return {
    severity: adjustedSeverity,
    confidence: {
      score: evidenceScore,
      basis:
        "Deterministic rule match; this is evidence strength, not remediation safety probability.",
    },
    evidenceCompleteness: {
      score: evidenceScore,
      missing,
      basis: missing.length
        ? "Some rule evidence fields are unavailable."
        : "All required rule evidence fields are present.",
    },
    dataFreshness: {
      score: freshnessScore,
      observedAt,
      basis: observedAt
        ? "Calculated from the source timestamp in the local snapshot."
        : "No source timestamp was available.",
    },
    businessCriticality: {
      score: businessScore,
      basis:
        businessScore === null
          ? "Unknown until a source criticality or service policy is loaded."
          : `Mapped from source value '${businessRaw}'.`,
    },
    blastRadius: {
      count: 1,
      basis:
        "One directly affected local twin object; graph-wide impact is not loaded.",
    },
    serviceImpact: {
      score: serviceScore,
      basis:
        serviceScore === null
          ? "Unknown until service mapping and dependency evidence are loaded."
          : `Mapped from source value '${serviceRaw}'.`,
    },
    overall:
      businessScore === null || serviceScore === null ? "Not scored" : "Scored",
    cautions,
    severityWeight: weight,
    severityModifier: modifierApplied ?? undefined,
  };
}


import { generateFixPlan } from "@/lib/ai/local";
import { buildFixPrompt } from "@/lib/ai/prompts";
import { appendAudit } from "@/lib/core/audit";
import { getDb } from "@/lib/core/db";
import { assertLocalMutation, errorResponse } from "@/lib/core/http";
import { getPlanForExplanation, previewPlan } from "@/lib/core/workflow";
import { getRuleKnowledge } from "@/lib/rules/rule-knowledge";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    assertLocalMutation(request);
    const plan = await getPlanForExplanation((await params).id);
    const db = await getDb();

    // Fetch target object payload
    let targetObj = await db.query<{
      payload: Record<string, unknown>;
      table_name: string;
      sys_id: string;
    }>("SELECT payload, table_name, sys_id FROM twin_objects WHERE id=$1 OR sys_id=$1 LIMIT 1", [
      plan.targetId,
    ]);
    if (targetObj.rows.length === 0 && plan.targetId.includes(":")) {
      const parts = plan.targetId.split(":");
      const possibleSysId = parts[1] || parts[0];
      targetObj = await db.query<{
        payload: Record<string, unknown>;
        table_name: string;
        sys_id: string;
      }>("SELECT payload, table_name, sys_id FROM twin_objects WHERE sys_id=$1 LIMIT 1", [
        possibleSysId,
      ]);
    }
    const targetData = targetObj.rows[0]?.payload;
    const upperRule = plan.ruleId.toUpperCase();
    let targetTable = targetObj.rows[0]?.table_name || (plan.evidence?.table as string | undefined);
    if (!targetTable) {
      if (upperRule.startsWith("ITSM-016") || upperRule.includes("INCIDENT")) {
        targetTable = "incident";
      } else if (upperRule.startsWith("ITSM-094") || upperRule.includes("CHANGE")) {
        targetTable = "change_request";
      } else if (upperRule.startsWith("ITSM-033") || upperRule.includes("SLA")) {
        targetTable = "task";
      } else if (upperRule.startsWith("ITSM-") || upperRule.startsWith("ITSM.") || plan.domain === "ITSM") {
        targetTable = "incident";
      } else if (upperRule.startsWith("CMDB-035") || upperRule.startsWith("CMDB-058") || upperRule.includes("REL")) {
        targetTable = "cmdb_rel_ci";
      } else {
        targetTable = "cmdb_ci";
      }
    }
    let targetSysId = targetObj.rows[0]?.sys_id || (plan.evidence?.sysId as string | undefined);
    if (!targetSysId) {
      if (plan.targetId.includes(":")) {
        const parts = plan.targetId.split(":");
        targetSysId = parts[1] || parts[0];
      } else {
        targetSysId = plan.targetId;
      }
    }

    let candidateCIs: { name: string; sysId: string; className: string }[] = [];
    if (plan.ruleId.includes("no_ci") || plan.ruleId.includes("missing_ci") || upperRule.includes("ITSM-016") || upperRule.includes("ITSM-094")) {
      const ciRows = await db.query<{ sys_id: string; payload: Record<string, unknown> }>(
        "SELECT sys_id, payload FROM twin_objects WHERE table_name='cmdb_ci' AND payload->>'name' IS NOT NULL LIMIT 8",
      );
      candidateCIs = ciRows.rows.map((r) => ({
        name: String(r.payload.name || "Business Service"),
        sysId: r.sys_id,
        className: String(r.payload.sys_class_name || "cmdb_ci_service"),
      }));
    }

    const ruleKnowledge = getRuleKnowledge(plan.ruleId, plan);

    const prompt = buildFixPrompt(
      plan.ruleId,
      plan.title,
      plan.explanation,
      plan.evidence,
      targetData,
      candidateCIs,
      ruleKnowledge,
      targetTable,
      targetSysId,
    );

    const result = await generateFixPlan(prompt, {
      ruleId: plan.ruleId,
      title: plan.title,
      explanation: plan.explanation,
      evidence: plan.evidence,
      table: targetTable,
      sysId: targetSysId,
      candidateCIs,
      code: ruleKnowledge.code,
      domain: ruleKnowledge.domain,
      standard: ruleKnowledge.standard,
      severity: ruleKnowledge.severity,
      weight: ruleKnowledge.weight,
      whatItMeans: ruleKnowledge.whatItMeans,
      whyItMatters: ruleKnowledge.whyItMatters,
      falsePositiveGuard: ruleKnowledge.falsePositiveGuard,
      crossDomainLink: ruleKnowledge.crossDomainLink,
    });

    if (result?.fixPlan?.fixActions) {
      const isItDomain = targetTable === "incident" || targetTable === "change_request" || targetTable === "problem" || targetTable === "task";
      result.fixPlan.fixActions = result.fixPlan.fixActions.map((a: any) => {
        const effectiveTable = isItDomain && a.table === "cmdb_ci" ? targetTable : (a.table || targetTable);
        return {
          ...a,
          table: effectiveTable,
          sysId: a.sysId || targetSysId,
        };
      });
    }

    // Save as previewed plan with AI suggestion
    const updatedPreview = await previewPlan(plan.id, result.fixPlan);

    await appendAudit("LOCAL_FIX_SUGGESTED", {
      planId: plan.id,
      model: result.model,
      ruleId: plan.ruleId,
      sourceTwinVersion: plan.twinVersion,
    });

    return Response.json({
      ...result,
      preview: updatedPreview,
      planId: plan.id,
      sourceTwinVersion: plan.twinVersion,
      notice:
        "AI fix plan generated and staged. Review before approval and apply.",
    });
  } catch (error) {
    return errorResponse(error);
  }
}

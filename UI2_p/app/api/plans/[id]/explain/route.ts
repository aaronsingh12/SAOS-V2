import { explainWithLocalModel } from "@/lib/ai/local";
import { appendAudit } from "@/lib/core/audit";
import { assertLocalMutation, errorResponse } from "@/lib/core/http";
import { getPlanForExplanation } from "@/lib/core/workflow";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    assertLocalMutation(request);
    const plan = await getPlanForExplanation((await params).id);
    const prompt = `You explain a deterministic ServiceNow rule result to an operator. Use only the facts below. In at most 90 words, say what was observed, why the operator might care, and what to verify next. Do not invent missing data, a risk score, or a production fix. If evidence is insufficient, say so.\n\nRule: ${plan.ruleId}\nTitle: ${plan.title}\nExplanation: ${plan.explanation}\nEvidence JSON: ${JSON.stringify(plan.evidence)}`;
    const result = await explainWithLocalModel(prompt);
    await appendAudit("LOCAL_EXPLANATION_GENERATED", {
      planId: plan.id,
      model: result.model,
      sourceTwinVersion: plan.twinVersion,
    });
    return Response.json({
      ...result,
      sourceTwinVersion: plan.twinVersion,
      notice:
        "AI wording is optional; source proof above remains authoritative.",
    });
  } catch (error) {
    return errorResponse(error);
  }
}

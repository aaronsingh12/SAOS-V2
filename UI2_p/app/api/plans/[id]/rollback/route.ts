import { z } from "zod";
import { assertLocalMutation, errorResponse } from "@/lib/core/http";
import { rollbackPlan } from "@/lib/core/workflow";

const bodySchema = z.object({
  actor: z.string().trim().min(2).max(100),
  confirm: z.literal("ROLLBACK"),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    assertLocalMutation(request);
    const body = bodySchema.parse(await request.json());
    return Response.json(await rollbackPlan((await params).id, body.actor));
  } catch (error) {
    return errorResponse(error);
  }
}

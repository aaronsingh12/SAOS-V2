import { z } from "zod";
import { assertLocalMutation, errorResponse } from "@/lib/core/http";
import { decidePlan } from "@/lib/core/workflow";

const bodySchema = z.object({
  decision: z.enum(["approve", "reject"]),
  actor: z.string().trim().min(2).max(100),
  reason: z.string().max(1000).optional(),
});
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    assertLocalMutation(request);
    const body = bodySchema.parse(await request.json());
    return Response.json(
      await decidePlan(
        (await params).id,
        body.decision,
        body.actor,
        body.reason,
      ),
    );
  } catch (error) {
    return errorResponse(error);
  }
}

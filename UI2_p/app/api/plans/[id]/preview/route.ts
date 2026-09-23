import { assertLocalMutation, errorResponse } from "@/lib/core/http";
import { previewPlan } from "@/lib/core/workflow";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    assertLocalMutation(request);
    return Response.json(await previewPlan((await params).id));
  } catch (error) {
    return errorResponse(error);
  }
}

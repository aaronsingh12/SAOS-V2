import { assertLocalMutation, errorResponse } from "@/lib/core/http";
import { startScanJob } from "@/lib/core/jobs";

export async function POST(request: Request) {
  try {
    assertLocalMutation(request);
    return Response.json(await startScanJob("sync"), { status: 202 });
  } catch (error) {
    return errorResponse(error);
  }
}

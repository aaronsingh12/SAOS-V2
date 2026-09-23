import { assertLocalMutation, errorResponse } from "@/lib/core/http";
import { testConnection } from "@/lib/core/servicenow";

export async function POST(request: Request) {
  try {
    assertLocalMutation(request);
    return Response.json(await testConnection());
  } catch (error) {
    return errorResponse(error);
  }
}

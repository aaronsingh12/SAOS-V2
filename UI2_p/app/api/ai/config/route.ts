import { z } from "zod";
import { appendAudit } from "@/lib/core/audit";
import { assertLocalMutation, errorResponse } from "@/lib/core/http";
import { saveSelectedModel } from "@/lib/ai/local";

const schema = z.object({
  provider: z.literal("ollama"),
  model: z.string().min(1).max(150),
});
export async function POST(request: Request) {
  try {
    assertLocalMutation(request);
    const input = schema.parse(await request.json());
    const saved = await saveSelectedModel(input.model);
    await appendAudit("LOCAL_MODEL_CHANGED", {
      provider: saved.provider,
      model: saved.model,
    });
    return Response.json(saved);
  } catch (error) {
    return errorResponse(error);
  }
}

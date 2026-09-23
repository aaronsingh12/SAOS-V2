import { assertLocalMutation, errorResponse } from "@/lib/core/http";
import { startScanJob } from "@/lib/core/jobs";
import { getAiProviderStatus } from "@/lib/ai/provider";

export async function POST(request: Request) {
  try {
    assertLocalMutation(request);
    const ai = await getAiProviderStatus();
    if (!ai.available || !ai.model) {
      return Response.json(
        {
          error: "LLM Consulting Engine is strictly required to scan. Please select and start an Ollama model in Settings.",
          ai,
        },
        { status: 400 },
      );
    }
    return Response.json(await startScanJob("scan"), { status: 202 });
  } catch (error) {
    return errorResponse(error);
  }
}


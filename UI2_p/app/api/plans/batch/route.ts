import { assertLocalMutation, errorResponse } from "@/lib/core/http";
import {
  verifyGroup,
  applyGroupFix,
  rollbackGroup,
} from "@/lib/core/workflow";

export async function POST(request: Request) {
  try {
    assertLocalMutation(request);
    const body = (await request.json()) as {
      action: "verify" | "apply" | "rollback";
      groupId: string;
      actor?: string;
    };

    if (!body.groupId) {
      throw new Error("groupId is required for batch operations");
    }

    const actor = (body.actor || "operator").trim();

    if (body.action === "verify") {
      const result = await verifyGroup(body.groupId, actor);
      return Response.json(result);
    }

    if (body.action === "apply") {
      if ((body as { stream?: boolean }).stream) {
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          async start(controller) {
            try {
              const result = await applyGroupFix(body.groupId, actor, (event) => {
                controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
              });
              controller.enqueue(
                encoder.encode(JSON.stringify({ type: "done", ...result }) + "\n"),
              );
              controller.close();
            } catch (err) {
              const errorMsg = err instanceof Error ? err.message : "Batch apply failed";
              controller.enqueue(
                encoder.encode(JSON.stringify({ type: "error", error: errorMsg }) + "\n"),
              );
              controller.close();
            }
          },
        });

        return new Response(stream, {
          headers: {
            "Content-Type": "application/x-ndjson; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
          },
        });
      }

      const result = await applyGroupFix(body.groupId, actor);
      return Response.json(result);
    }

    if (body.action === "rollback") {
      const result = await rollbackGroup(body.groupId, actor);
      return Response.json(result);
    }

    throw new Error(`Unsupported batch action: ${body.action}`);
  } catch (error) {
    return errorResponse(error);
  }
}

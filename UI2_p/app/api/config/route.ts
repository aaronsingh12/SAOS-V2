import { z } from "zod";
import { assertLocalMutation, errorResponse } from "@/lib/core/http";
import { connectionSummary, saveConnection } from "@/lib/core/connection";
import { appendAudit } from "@/lib/core/audit";

const bodySchema = z.object({
  instanceUrl: z.url(),
  username: z.string().trim().min(2).max(100),
  password: z.string().max(500).optional(),
  domainMode: z.enum(["separated", "global"]),
});
export const dynamic = "force-dynamic";
export async function GET() {
  return Response.json(await connectionSummary());
}
export async function POST(request: Request) {
  try {
    assertLocalMutation(request);
    const body = bodySchema.parse(await request.json());
    const saved = await saveConnection(body);
    await appendAudit("CONNECTION_CHANGED", {
      instanceHost: new URL(saved.instanceUrl).hostname,
      username: saved.username,
      domainMode: saved.domainMode,
      secretIncluded: Boolean(body.password),
    });
    return Response.json(saved);
  } catch (error) {
    return errorResponse(error);
  }
}

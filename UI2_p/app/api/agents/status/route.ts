import { getAgentRuntime } from "@/lib/agents/runtime";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(await getAgentRuntime());
}

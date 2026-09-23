import { latestAgentRuns } from "@/lib/agents/runner";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({ runs: await latestAgentRuns() });
}

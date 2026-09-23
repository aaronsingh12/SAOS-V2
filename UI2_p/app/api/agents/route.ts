import { getAgentCatalog } from "@/lib/agents/catalog";

export const dynamic = "force-static";

export async function GET() {
  const agents = getAgentCatalog();
  return Response.json({
    agents,
    totals: {
      all: agents.length,
      ready: agents.filter((agent) => agent.status === "ready").length,
      partial: agents.filter((agent) => agent.status === "partial").length,
      planned: agents.filter((agent) => agent.status === "planned").length,
    },
  });
}

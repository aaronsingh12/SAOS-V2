import {
  getAllMasterRules,
  getMasterCatalogMetadata,
  getMasterRule,
  getRulesByDomain,
  getRulesByLane,
  getRulesBySeverity,
  searchMasterRules,
  RuleDomain,
  RuleSeverity,
} from "@/lib/rules/catalog";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");
  const domain = searchParams.get("domain") as RuleDomain | null;
  const severity = searchParams.get("severity") as RuleSeverity | null;
  const laneStr = searchParams.get("lane");
  const query = searchParams.get("q");

  if (id) {
    const rule = getMasterRule(id);
    if (!rule) {
      return Response.json({ error: `Rule ${id} not found` }, { status: 404 });
    }
    return Response.json({ rule });
  }

  let rules = getAllMasterRules();

  if (query) {
    rules = searchMasterRules(query);
  }

  if (domain) {
    rules = rules.filter((r) => r.domain.toLowerCase() === domain.toLowerCase());
  }

  if (severity) {
    rules = rules.filter(
      (r) => r.baseSeverity.toLowerCase() === severity.toLowerCase(),
    );
  }

  if (laneStr) {
    const lane = parseInt(laneStr, 10);
    if (lane >= 1 && lane <= 3) {
      rules = rules.filter((r) => r.remediationLane === lane);
    }
  }

  const metadata = getMasterCatalogMetadata();

  return Response.json({
    metadata,
    total: rules.length,
    rules,
  });
}

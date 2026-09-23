import { getDb } from "@/lib/core/db";
import { generateServiceNowUpdateSetXml } from "@/lib/core/update-set-generator";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const db = await getDb();
  
  // Look up finding or plan by id (either plan-xxx, finding id xxx, or sysId)
  const row = await db.query<{
    id: string;
    finding_id: string;
    update_set_xml: string | null;
    rule_id: string;
    title: string;
    target_id: string;
    suggested_after: Record<string, unknown> | null;
    evidence: Record<string, unknown> | null;
  }>(
    `SELECT p.id, p.finding_id, p.update_set_xml, f.rule_id, f.title, f.target_id, f.suggested_after, f.evidence
     FROM findings f
     LEFT JOIN remediation_plans p ON p.finding_id = f.id
     WHERE f.id = $1 OR p.id = $1 OR p.finding_id = $1 OR f.rule_id = $1
     LIMIT 1`,
    [id],
  );

  if (!row.rows[0]) {
    return new Response("Remediation plan not found for ID: " + id, {
      status: 404,
      headers: { "Content-Type": "text/plain" },
    });
  }

  const r = row.rows[0];
  let xml = r.update_set_xml;

  if (!xml) {
    const table = r.target_id.includes(":")
      ? r.target_id.split(":")[0]
      : (r.evidence?.table as string) || "cmdb_ci";
    const sysId = r.target_id.includes(":")
      ? r.target_id.split(":")[1]
      : (r.evidence?.sysId as string) || r.target_id;
    const targetName =
      (r.evidence?.name as string) ||
      (r.evidence?.number as string) ||
      `${table} [${sysId.substring(0, 8)}]`;

    xml = generateServiceNowUpdateSetXml({
      ruleId: r.rule_id,
      ruleTitle: r.title,
      targetTable: table,
      targetSysId: sysId,
      targetName,
      fields: r.suggested_after,
    });

    // Cache generated XML in remediation_plans table if plan exists
    if (r.finding_id) {
      await db.query(
        `UPDATE remediation_plans SET update_set_xml = $1 WHERE finding_id = $2`,
        [xml, r.finding_id],
      );
    }
  }

  const cleanRule = r.rule_id.replace(/[^a-zA-Z0-9_-]/g, "_");
  const cleanId = id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 12);
  const safeFilename = `SAOS_UpdateSet_${cleanRule}_${cleanId}.xml`;

  return new Response(xml, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Content-Disposition": `attachment; filename="${safeFilename}"`,
      "Cache-Control": "no-cache, no-store, must-revalidate",
    },
  });
}


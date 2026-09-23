import { listAllAudit, verifyAudit } from "@/lib/core/audit";

export const dynamic = "force-dynamic";
export async function GET() {
  return Response.json({
    entries: await listAllAudit(),
    integrity: await verifyAudit(),
  });
}

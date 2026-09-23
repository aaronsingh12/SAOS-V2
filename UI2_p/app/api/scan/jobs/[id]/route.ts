import { getScanJob } from "@/lib/core/jobs";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const job = await getScanJob(id);
  if (!job)
    return Response.json({ error: "Scan job not found" }, { status: 404 });
  return Response.json(job);
}

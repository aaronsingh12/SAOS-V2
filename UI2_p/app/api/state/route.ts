import { getState } from "@/lib/core/workflow";

export const dynamic = "force-dynamic";
export async function GET() {
  return Response.json(await getState());
}

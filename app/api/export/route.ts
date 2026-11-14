import { ownerOnly, viewer } from "../../../lib/inventory/access";
import { exportCsv } from "../../../lib/inventory/data";
import { handle } from "../../../lib/roles/http";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  return handle(async () => {
    const kind = new URL(request.url).searchParams.get("kind") === "moves" ? "moves" : "items";
    if (kind === "items") await ownerOnly(request);
    else await viewer(request);
    return new Response(await exportCsv(kind), {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${kind}.csv"`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  });
}

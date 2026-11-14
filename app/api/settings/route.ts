import { ownerOnly } from "../../../lib/inventory/access";
import { snapshot } from "../../../lib/inventory/data";
import { handle, reply } from "../../../lib/roles/http";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  return handle(async () => {
    await ownerOnly(request);
    return reply(await snapshot());
  });
}

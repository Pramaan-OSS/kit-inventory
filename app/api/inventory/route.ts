import { randomUUID } from "node:crypto";
import { AccountError } from "../../../lib/accounts";
import { emailDoor } from "../../../lib/email";
import { ownerOnly, viewer } from "../../../lib/inventory/access";
import {
  addParty,
  adjust,
  completeOrder,
  createOrder,
  editList,
  forStaff,
  importItems,
  saveItem,
  sendNotice,
  snapshot,
  transaction,
} from "../../../lib/inventory/data";
import { createInvite } from "../../../lib/inventory/invites";
import { text } from "../../../lib/inventory/words";
import { handle, readBody, reply } from "../../../lib/roles/http";
import { database } from "../../../lib/runtime";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  return handle(async () => {
    const user = await viewer(request);
    const all = await snapshot();
    return reply(user.role === "owner" ? all : forStaff(all));
  });
}
export async function POST(request: Request) {
  return handle(async () => {
    const user = await viewer(request);
    const input = await readBody(request);
    if (input.action === "complete")
      return reply(await completeOrder(input.id, user.id, input.status_id));
    await ownerOnly(request);
    try {
      switch (input.action) {
        case "item":
          return reply(await transaction((tx) => saveItem(input, tx)), 201);
        case "order":
          return reply(await createOrder(input, user.id), 201);
        case "count":
          return reply(await adjust(input, user.id));
        case "list":
        case "remove-list":
          await editList(input);
          break;
        case "party":
          await addParty(input);
          break;
        case "location":
          await database().query("INSERT INTO inventory_locations VALUES($1,$2)", [
            randomUUID(),
            text(input.name, "a location", 120),
          ]);
          break;
        case "import":
          return reply(await importItems(input.csv));
        case "email-order":
        case "email-low":
          return reply(await sendNotice(input));
        case "invite":
          return reply(
            await createInvite(
              emailDoor,
              { email: input.email, role: "staff", invitedBy: user.id },
              process.env.APP_ORIGIN ?? new URL(request.url).origin,
              "Inventory and orders",
            ),
            201,
          );
        default:
          throw new AccountError(400, "Choose an inventory action.");
      }
    } catch (e) {
      if ((e as { code?: string }).code === "23505")
        throw new AccountError(409, "That SKU, reference or name already exists.");
      if ((e as { code?: string }).code === "23503")
        throw new AccountError(409, "This value is in use or no longer available.");
      throw e;
    }
    return reply({ message: "Saved." });
  });
}

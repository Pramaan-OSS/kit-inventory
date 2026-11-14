import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as exportRoute } from "../../app/api/export/route";
import { GET, POST } from "../../app/api/inventory/route";
import { GET as settings } from "../../app/api/settings/route";
import { AccountError } from "../accounts";
import { database } from "../runtime";
import {
  adjust,
  completeOrder,
  createOrder,
  editList,
  exportCsv,
  importItems,
  parseCsv,
  saveItem,
  sendNotice,
  transaction,
} from "./data";
import { acceptInvite, checkInvite, createInvite } from "./invites";

const db = () => database();
const owner = randomUUID(),
  staff = randomUUID(),
  stranger = randomUUID();
const secret = "inventory-tests-session-secret-at-least-32";
const tokens: Record<string, string> = {};
const general = "10000000-0000-4000-8000-000000000001",
  purchase = "10000000-0000-4000-8000-000000000002",
  received = "10000000-0000-4000-8000-000000000003",
  sales = "10000000-0000-4000-8000-000000000004",
  fulfilled = "10000000-0000-4000-8000-000000000005",
  location = "20000000-0000-4000-8000-000000000001";
let item: string, supplier: string, customer: string;
function request(user: string | undefined, input?: object) {
  return new Request("http://localhost:3450/api/inventory", {
    method: input ? "POST" : "GET",
    headers: {
      origin: "http://localhost:3450",
      "content-type": "application/json",
      ...(user ? { cookie: `app_session=${tokens[user]}` } : {}),
    },
    ...(input ? { body: JSON.stringify(input) } : {}),
  });
}
const fake = { send: async () => ({ status: "not-sent" as const }) };
beforeAll(async () => {
  if (!process.env.DATABASE_URL) throw Error("Tests require disposable Postgres.");
  process.env.SESSION_SECRET = secret;
  process.env.APP_COOKIE_SECURE = "false";
  process.env.APP_ORIGIN = "http://localhost:3450";
  await db().query(
    "TRUNCATE inventory_mail,inventory_moves,inventory_lines,inventory_orders,inventory_items,inventory_parties,inventory_invites,app_users CASCADE",
  );
  for (const [user, role] of [
    [owner, "owner"],
    [staff, "staff"],
    [stranger, "member"],
  ] as const) {
    await db().query("INSERT INTO app_users(id,email,password_hash,role) VALUES($1,$2,$3,$4)", [
      user,
      `${user}@test.invalid`,
      "unused",
      role,
    ]);
    const token = randomBytes(32).toString("hex");
    tokens[user] = token;
    await db().query("INSERT INTO app_sessions VALUES($1,$2,now()+interval '1 hour')", [
      createHmac("sha256", secret).update(token).digest("hex"),
      user,
    ]);
  }
  item = (
    await transaction((tx) =>
      saveItem(
        {
          name: "Brass bolt",
          sku: "BOLT",
          unit: "each",
          reorder_level: 3,
          cost: "1.25",
          sale_price: "2.50",
          category_id: general,
        },
        tx,
      ),
    )
  ).id;
  supplier = randomUUID();
  customer = randomUUID();
  await db().query(
    "INSERT INTO inventory_parties VALUES($1,'supplier','Foundry','foundry@example.test'),($2,'customer','Workshop','workshop@example.test')",
    [supplier, customer],
  );
});
afterAll(async () => {
  await db().end();
});
const order = async (kind = "sales", quantity = 4, extra: object = {}) =>
  createOrder(
    {
      kind,
      reference: randomUUID(),
      party_id: kind === "purchase" ? supplier : customer,
      location_id: location,
      status_id: kind === "purchase" ? purchase : sales,
      lines: [{ item_id: item, quantity }],
      ...extra,
    },
    owner,
  );
const balance = async () =>
  Number(
    (
      await db().query(
        "SELECT COALESCE(sum(quantity),0) AS n FROM inventory_moves WHERE item_id=$1",
        [item],
      )
    ).rows[0].n,
  );
describe("inventory on Postgres", () => {
  it("refuses signed-out and unassigned accounts before reading shop rows", async () => {
    expect((await GET(request(undefined))).status).toBe(401);
    expect((await GET(request(stranger))).status).toBe(403);
    expect((await GET(request(staff))).status).toBe(200);
  });
  it("staff cannot read settings or change prices, imports, counts, contacts or statuses", async () => {
    expect((await settings(request(staff))).status).toBe(403);
    for (const action of [
      "item",
      "list",
      "remove-list",
      "location",
      "party",
      "import",
      "count",
      "invite",
      "order",
      "email-low",
    ])
      expect((await POST(request(staff, { action, id: item, cost: "0.01" }))).status).toBe(403);
    expect(
      (await db().query("SELECT cost FROM inventory_items WHERE id=$1", [item])).rows[0].cost,
    ).toBe(125);
  });
  it("refuses cross-origin writes and browser-supplied quantity balances", async () => {
    const r = new Request("http://localhost:3450/api/inventory", {
      method: "POST",
      headers: {
        cookie: `app_session=${tokens[owner]}`,
        origin: "https://elsewhere.test",
        "content-type": "application/json",
      },
      body: '{"action":"count"}',
    });
    expect((await POST(r)).status).toBe(403);
    expect(
      (
        await POST(
          request(owner, {
            action: "item",
            name: "Negative",
            sku: "N",
            unit: "each",
            reorder_level: -1,
            cost: "1",
            sale_price: "2",
            category_id: general,
            on_hand: 999,
          }),
        )
      ).status,
    ).toBe(400);
  });
  it("takes order prices from the server and receives each order once", async () => {
    const p = await order("purchase", 10, {
      lines: [{ item_id: item, quantity: 10, unit_price: 0 }],
      completed_at: "now",
      on_hand: 999,
    });
    expect(
      (await db().query("SELECT unit_price FROM inventory_lines WHERE order_id=$1", [p.id])).rows[0]
        .unit_price,
    ).toBe(125);
    await completeOrder(p.id, staff, received);
    expect(await balance()).toBe(10);
    await expect(completeOrder(p.id, staff, received)).rejects.toMatchObject({ status: 409 });
    expect(await balance()).toBe(10);
  });
  it("staff never receive cost prices or purchase line prices", async () => {
    await order("sales", 1);
    type Seen = {
      items: Record<string, unknown>[];
      orders: { kind: string; lines: Record<string, unknown>[] }[];
    };
    const staffRaw = await (await GET(request(staff))).text();
    const seen = JSON.parse(staffRaw) as Seen;
    expect(staffRaw).not.toMatch(/"cost"/u);
    expect(seen.items[0]).not.toHaveProperty("cost");
    expect(seen.items[0]).toHaveProperty("sale_price", 250);
    const purchaseLines = seen.orders.filter((o) => o.kind === "purchase").flatMap((o) => o.lines);
    expect(purchaseLines.length).toBeGreaterThan(0);
    for (const line of purchaseLines) expect(line).not.toHaveProperty("unit_price");
    const salesLines = seen.orders.filter((o) => o.kind === "sales").flatMap((o) => o.lines);
    expect(salesLines[0]).toHaveProperty("unit_price", 250);
    const ownerSeen = (await (await GET(request(owner))).json()) as Seen;
    expect(ownerSeen.items[0]).toHaveProperty("cost", 125);
    const items = new Request("http://localhost:3450/api/export?kind=items", {
      headers: { cookie: `app_session=${tokens[staff]}` },
    });
    expect((await exportRoute(items)).status).toBe(403);
    const moves = new Request("http://localhost:3450/api/export?kind=moves", {
      headers: { cookie: `app_session=${tokens[staff]}` },
    });
    expect((await (await exportRoute(moves)).text()).split("\r\n")[0]).not.toMatch(/cost|price/u);
  });
  it("two simultaneous sales cannot oversell and one failed multi-line order rolls back", async () => {
    await adjust(
      { item_id: item, location_id: location, count: 5, reason: "Count before race" },
      owner,
    );
    const a = await order(),
      b = await order();
    const holder = await db().connect();
    await holder.query("BEGIN");
    await holder.query("SELECT id FROM inventory_items WHERE id=$1 FOR UPDATE", [item]);
    const racing = Promise.allSettled([
      completeOrder(a.id, staff, fulfilled),
      completeOrder(b.id, staff, fulfilled),
    ]);
    let waiters = 0;
    try {
      for (let attempt = 0; attempt < 100; attempt++) {
        await holder.query("SELECT pg_stat_clear_snapshot()");
        waiters = Number(
          (
            await holder.query(
              "SELECT count(*) AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%inventory_items%FOR UPDATE%'",
            )
          ).rows[0].n,
        );
        if (waiters === 2) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
    const results = await racing;
    expect(waiters).toBe(2);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({ reason: { status: 409 } });
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(await balance()).toBe(1);
    expect(
      Number(
        (
          await db().query(
            "SELECT count(*) AS n FROM inventory_moves WHERE order_id=ANY($1::uuid[])",
            [[a.id, b.id]],
          )
        ).rows[0].n,
      ),
    ).toBe(1);
    let empty = (
      await transaction((tx) =>
        saveItem(
          {
            name: "Empty",
            sku: "EMPTY",
            unit: "each",
            reorder_level: 0,
            cost: "1",
            sale_price: "2",
            category_id: general,
          },
          tx,
        ),
      )
    ).id;
    // Make the stocked line run first, so a failed second line must roll it back.
    const last = "ffffffff-ffff-4fff-bfff-ffffffffffff";
    await db().query("UPDATE inventory_items SET id=$2 WHERE id=$1", [empty, last]);
    empty = last;
    const multi = await order("sales", 1, {
      lines: [
        { item_id: item, quantity: 1 },
        { item_id: empty, quantity: 1 },
      ],
    });
    await expect(completeOrder(multi.id, staff, fulfilled)).rejects.toMatchObject({ status: 409 });
    expect(await balance()).toBe(1);
    expect(
      (await db().query("SELECT * FROM inventory_moves WHERE order_id=$1", [multi.id])).rowCount,
    ).toBe(0);
  });
  it("serializes repeated fulfilment of the same order", async () => {
    await adjust(
      { item_id: item, location_id: location, count: 10, reason: "Restock count" },
      owner,
    );
    const s = await order("sales", 2);
    const r = await Promise.allSettled([
      completeOrder(s.id, staff, fulfilled),
      completeOrder(s.id, staff, fulfilled),
    ]);
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(await balance()).toBe(8);
  });
  it("counts are ledger moves, scoped to a location, and never change another location", async () => {
    const other = randomUUID();
    await db().query("INSERT INTO inventory_locations VALUES($1,$2)", [other, `Reserve ${other}`]);
    await adjust({ item_id: item, location_id: other, count: 7, reason: "Reserve count" }, owner);
    expect(await balance()).toBe(15);
    await adjust({ item_id: item, location_id: location, count: 2, reason: "Shelf count" }, owner);
    expect(await balance()).toBe(9);
    const sale = await order("sales", 3);
    await expect(completeOrder(sale.id, staff, fulfilled)).rejects.toMatchObject({ status: 409 });
  });
  it("rejects removing categories and statuses in use and allows editable names", async () => {
    await expect(editList({ action: "remove-list", id: general })).rejects.toMatchObject({
      status: 409,
    });
    await expect(editList({ action: "remove-list", id: fulfilled })).rejects.toMatchObject({
      status: 409,
    });
    await editList({ action: "list", name: "Awaiting delivery", id: purchase });
    expect(
      (await db().query("SELECT name FROM inventory_lists WHERE id=$1", [purchase])).rows[0].name,
    ).toBe("Awaiting delivery");
    await editList({ action: "list", name: "Ordered", id: purchase });
  });
  it("imports quoted CSV atomically and exports safe formulas", async () => {
    const head = "name,sku,unit,reorder_level,cost,sale_price,category\n";
    await importItems(`${head}"Copper, small",COPPER,each,2,1.50,3.25,General`);
    await expect(
      importItems(`${head}Good,GOOD,each,2,1,2,General\nBad,BAD,each,-2,1,2,General`),
    ).rejects.toBeInstanceOf(AccountError);
    expect((await db().query("SELECT * FROM inventory_items WHERE sku='GOOD'")).rowCount).toBe(0);
    await transaction((tx) =>
      saveItem(
        {
          name: '=HYPERLINK("bad")',
          sku: "FORMULA",
          unit: "each",
          reorder_level: 0,
          cost: "1",
          sale_price: "2",
          category_id: general,
        },
        tx,
      ),
    );
    expect(await exportCsv("items")).toContain('"\'=HYPERLINK(""bad"")"');
    expect(await exportCsv("moves")).toContain("Shelf count");
    expect(() => parseCsv(`${head}"bad`)).toThrow();
  });
  it("uses one stable mail key with an immutable message and exposes module-off clearly", async () => {
    const p = await order("purchase", 2);
    const seen: { key: string; text: string }[] = [];
    const mailer = {
      send: async (m: { text: string }, key: string) => {
        seen.push({ key, text: m.text });
        return { status: "sent" as const };
      },
    };
    await sendNotice({ action: "email-order", id: p.id }, mailer);
    await sendNotice({ action: "email-order", id: p.id }, mailer);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual(seen[1]);
    expect(
      (await sendNotice({ action: "email-low", email: "owner@example.test" }, fake)).message,
    ).toContain("not sent");
  });
  it("staff invitations grant only staff, tokens are hashed, single-use and expire", async () => {
    const invite = await createInvite(
      fake,
      { email: "newstaff@example.test", role: "staff", invitedBy: owner },
      "http://localhost:3450",
      "Shop",
    );
    const token = invite.link?.split("#")[1];
    expect(await checkInvite(token)).toEqual({ email: "newstaff@example.test", role: "staff" });
    expect(
      (
        await db().query("SELECT token_hash FROM inventory_invites WHERE email=$1", [
          "newstaff@example.test",
        ])
      ).rows[0].token_hash,
    ).not.toBe(token);
    await acceptInvite(token, "Inventory-password-123", 12);
    await expect(checkInvite(token)).rejects.toMatchObject({ status: 410 });
    expect(
      (await db().query("SELECT role FROM app_users WHERE email=$1", ["newstaff@example.test"]))
        .rows[0].role,
    ).toBe("staff");
    const expired = await createInvite(
      fake,
      { email: "expired@example.test", role: "staff", invitedBy: owner },
      "http://localhost:3450",
      "Shop",
    );
    await db().query(
      "UPDATE inventory_invites SET expires_at=now()-interval '1 day' WHERE email='expired@example.test'",
    );
    await expect(checkInvite(expired.link?.split("#")[1])).rejects.toMatchObject({ status: 410 });
  });
});

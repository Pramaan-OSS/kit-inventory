import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { AccountError } from "../accounts";
import { emailDoor, type Mailer } from "../email";
import { database } from "../runtime";
import { csvCell, email, id, text } from "./words";
export const integer = (v: unknown, label: string, min = 0, max = 1000000) => {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max)
    throw new AccountError(400, `Enter ${label} from ${min} to ${max}.`);
  return v;
};
export function money(v: unknown) {
  const s = typeof v === "string" ? v : "";
  if (!/^\d{1,6}(\.\d{1,2})?$/u.test(s))
    throw new AccountError(400, "Enter a price with up to two decimal places.");
  return integer(Math.round(Number(s) * 100), "a price", 0, 100000000);
}
export async function transaction<T>(work: (tx: PoolClient) => Promise<T>) {
  const tx = await database().connect();
  try {
    await tx.query("BEGIN");
    const result = await work(tx);
    await tx.query("COMMIT");
    return result;
  } catch (e) {
    await tx.query("ROLLBACK");
    throw e;
  } finally {
    tx.release();
  }
}
export async function snapshot() {
  const db = database();
  const [items, locations, parties, lists, orders, moves] = await Promise.all([
    db.query(
      `SELECT i.*,COALESCE(sum(m.quantity),0)::int AS on_hand FROM inventory_items i LEFT JOIN inventory_moves m ON m.item_id=i.id GROUP BY i.id ORDER BY i.name`,
    ),
    db.query("SELECT * FROM inventory_locations ORDER BY name"),
    db.query("SELECT * FROM inventory_parties ORDER BY name"),
    db.query("SELECT * FROM inventory_lists ORDER BY kind,name"),
    db.query(
      `SELECT o.*,p.name AS party,l.name AS location,s.name AS status,COALESCE((SELECT json_agg(json_build_object('item',i.name,'quantity',x.quantity,'unit_price',x.unit_price)) FROM inventory_lines x JOIN inventory_items i ON i.id=x.item_id WHERE x.order_id=o.id),'[]') AS lines FROM inventory_orders o JOIN inventory_parties p ON p.id=o.party_id JOIN inventory_locations l ON l.id=o.location_id JOIN inventory_lists s ON s.id=o.status_id ORDER BY o.created_at DESC`,
    ),
    db.query(
      `SELECT m.*,i.name AS item,l.name AS location FROM inventory_moves m JOIN inventory_items i ON i.id=m.item_id JOIN inventory_locations l ON l.id=m.location_id ORDER BY m.created_at DESC LIMIT 500`,
    ),
  ]);
  return {
    items: items.rows,
    locations: locations.rows,
    parties: parties.rows,
    lists: lists.rows,
    orders: orders.rows,
    moves: moves.rows,
  };
}
/** What staff see: no cost price, and no prices on purchase lines (they are the item's cost). */
export function forStaff(s: Awaited<ReturnType<typeof snapshot>>) {
  return {
    ...s,
    items: s.items.map(({ cost: _cost, ...item }) => item),
    orders: s.orders.map((o) =>
      o.kind === "purchase"
        ? {
            ...o,
            lines: (o.lines as { item: string; quantity: number }[]).map(({ item, quantity }) => ({
              item,
              quantity,
            })),
          }
        : o,
    ),
  };
}
export async function saveItem(input: Record<string, unknown>, tx: PoolClient) {
  const values = [
    text(input.name, "an item name", 120),
    text(input.sku, "a SKU", 64),
    text(input.unit, "a unit", 40),
    integer(input.reorder_level, "a reorder level"),
    money(input.cost),
    money(input.sale_price),
    id(input.category_id),
  ];
  const category = await tx.query(
    "SELECT id FROM inventory_lists WHERE id=$1 AND kind='category' FOR KEY SHARE",
    [values[6]],
  );
  if (!category.rowCount) throw new AccountError(400, "Choose an item category.");
  if (input.id) {
    const changed = await tx.query(
      "UPDATE inventory_items SET name=$1,sku=$2,unit=$3,reorder_level=$4,cost=$5,sale_price=$6,category_id=$7 WHERE id=$8 RETURNING id",
      [...values, id(input.id)],
    );
    if (!changed.rowCount) throw new AccountError(404, "Item not found.");
    return changed.rows[0];
  }
  return (
    await tx.query(
      "INSERT INTO inventory_items(name,sku,unit,reorder_level,cost,sale_price,category_id,id) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id",
      [...values, randomUUID()],
    )
  ).rows[0];
}
export async function createOrder(input: Record<string, unknown>, user: string) {
  const kind = input.kind;
  if (kind !== "purchase" && kind !== "sales")
    throw new AccountError(400, "Choose a purchase or sales order.");
  if (!Array.isArray(input.lines) || !input.lines.length || input.lines.length > 20)
    throw new AccountError(400, "Add one to twenty order lines.");
  const lines = input.lines.map((line) => {
    if (!line || typeof line !== "object" || Array.isArray(line))
      throw new AccountError(400, "Check the order lines.");
    return { item: id(line.item_id), quantity: integer(line.quantity, "a quantity", 1) };
  });
  if (new Set(lines.map((l) => l.item)).size !== lines.length)
    throw new AccountError(400, "Combine repeated items into one line.");
  return transaction(async (tx) => {
    const status = await tx.query(
      "SELECT id FROM inventory_lists WHERE id=$1 AND kind=$2 AND phase='open' FOR KEY SHARE",
      [id(input.status_id), kind],
    );
    const party = await tx.query("SELECT id FROM inventory_parties WHERE id=$1 AND kind=$2", [
      id(input.party_id),
      kind === "purchase" ? "supplier" : "customer",
    ]);
    const location = await tx.query("SELECT id FROM inventory_locations WHERE id=$1", [
      id(input.location_id),
    ]);
    if (!status.rowCount || !party.rowCount || !location.rowCount)
      throw new AccountError(400, "Choose an open status, matching contact and location.");
    const orderId = randomUUID();
    const reference = text(input.reference, "an order reference", 80);
    await tx.query(
      "INSERT INTO inventory_orders(id,reference,kind,party_id,party_kind,location_id,status_id,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [
        orderId,
        reference,
        kind,
        input.party_id,
        kind === "purchase" ? "supplier" : "customer",
        input.location_id,
        input.status_id,
        user,
      ],
    );
    for (const line of [...lines].sort((a, b) => a.item.localeCompare(b.item))) {
      const item = (
        await tx.query("SELECT cost,sale_price FROM inventory_items WHERE id=$1 FOR SHARE", [
          line.item,
        ])
      ).rows[0];
      if (!item) throw new AccountError(404, "Item not found.");
      await tx.query("INSERT INTO inventory_lines VALUES($1,$2,$3,$4,$5)", [
        randomUUID(),
        orderId,
        line.item,
        line.quantity,
        kind === "purchase" ? item.cost : item.sale_price,
      ]);
    }
    return { id: orderId };
  });
}
export async function completeOrder(orderId: unknown, user: string, statusId: unknown) {
  return transaction(async (tx) => {
    const order = (
      await tx.query("SELECT * FROM inventory_orders WHERE id=$1 FOR UPDATE", [id(orderId)])
    ).rows[0];
    if (!order) throw new AccountError(404, "Order not found.");
    if (order.completed_at) throw new AccountError(409, "This order is already completed.");
    const status = await tx.query(
      "SELECT id FROM inventory_lists WHERE id=$1 AND kind=$2 AND phase='done' FOR KEY SHARE",
      [id(statusId), order.kind],
    );
    if (!status.rowCount) throw new AccountError(400, "Choose a completed status.");
    const lines = (
      await tx.query("SELECT * FROM inventory_lines WHERE order_id=$1 ORDER BY item_id", [order.id])
    ).rows;
    // Every writer locks items in the same order. The later balance query sees earlier committed moves.
    for (const line of lines) {
      await tx.query("SELECT id FROM inventory_items WHERE id=$1 FOR UPDATE", [line.item_id]);
      const quantity = order.kind === "purchase" ? line.quantity : -line.quantity;
      const balance = Number(
        (
          await tx.query(
            "SELECT COALESCE(sum(quantity),0) AS n FROM inventory_moves WHERE item_id=$1 AND location_id=$2",
            [line.item_id, order.location_id],
          )
        ).rows[0].n,
      );
      if (balance + quantity < 0) throw new AccountError(409, "Not enough stock at this location.");
      await tx.query(
        "INSERT INTO inventory_moves(id,item_id,location_id,quantity,reason,order_id,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [
          randomUUID(),
          line.item_id,
          order.location_id,
          quantity,
          order.kind === "purchase" ? "Purchase receipt" : "Sales fulfilment",
          order.id,
          user,
        ],
      );
    }
    await tx.query("UPDATE inventory_orders SET completed_at=now(),status_id=$2 WHERE id=$1", [
      order.id,
      statusId,
    ]);
    return { message: order.kind === "purchase" ? "Purchase received." : "Sales order fulfilled." };
  });
}
export async function adjust(input: Record<string, unknown>, user: string) {
  const item = id(input.item_id),
    location = id(input.location_id),
    count = integer(input.count, "a counted quantity"),
    reason = text(input.reason, "a count reason", 240);
  return transaction(async (tx) => {
    if (!(await tx.query("SELECT id FROM inventory_items WHERE id=$1 FOR UPDATE", [item])).rowCount)
      throw new AccountError(404, "Item not found.");
    if (!(await tx.query("SELECT id FROM inventory_locations WHERE id=$1", [location])).rowCount)
      throw new AccountError(404, "Location not found.");
    const balance = Number(
      (
        await tx.query(
          "SELECT COALESCE(sum(quantity),0) AS n FROM inventory_moves WHERE item_id=$1 AND location_id=$2",
          [item, location],
        )
      ).rows[0].n,
    );
    const delta = count - balance;
    if (Math.abs(delta) > 1000000) throw new AccountError(400, "Count change is too large.");
    if (delta)
      await tx.query(
        "INSERT INTO inventory_moves(id,item_id,location_id,quantity,reason,created_by) VALUES($1,$2,$3,$4,$5,$6)",
        [randomUUID(), item, location, delta, reason, user],
      );
    return { message: delta ? "Stock count recorded." : "Count matches stock; no change needed." };
  });
}
export async function editList(input: Record<string, unknown>) {
  return transaction(async (tx) => {
    if (input.action === "remove-list") {
      const target = id(input.id);
      const row = (await tx.query("SELECT * FROM inventory_lists WHERE id=$1 FOR UPDATE", [target]))
        .rows[0];
      if (!row) throw new AccountError(404, "Setting not found.");
      const used = await tx.query(
        "SELECT 1 FROM inventory_items WHERE category_id=$1 UNION ALL SELECT 1 FROM inventory_orders WHERE status_id=$1",
        [target],
      );
      if (used.rowCount) throw new AccountError(409, "This value is in use and cannot be removed.");
      await tx.query("DELETE FROM inventory_lists WHERE id=$1", [target]);
      return;
    }
    const name = text(input.name, "a name", 80);
    if (input.id) {
      await tx.query("UPDATE inventory_lists SET name=$2 WHERE id=$1", [id(input.id), name]);
      return;
    }
    const kind = input.kind,
      phase = kind === "category" ? "category" : input.phase;
    if (
      !["category", "purchase", "sales"].includes(String(kind)) ||
      !["category", "open", "done"].includes(String(phase)) ||
      (kind !== "category" && phase === "category")
    )
      throw new AccountError(400, "Choose a list and status purpose.");
    if (Number((await tx.query("SELECT count(*) FROM inventory_lists")).rows[0].count) >= 90)
      throw new AccountError(400, "At most ninety settings are allowed.");
    await tx.query("INSERT INTO inventory_lists VALUES($1,$2,$3,$4)", [
      randomUUID(),
      kind,
      name,
      phase,
    ]);
  });
}
export async function addParty(input: Record<string, unknown>) {
  if (input.kind !== "supplier" && input.kind !== "customer")
    throw new AccountError(400, "Choose a contact type.");
  await database().query("INSERT INTO inventory_parties VALUES($1,$2,$3,$4)", [
    randomUUID(),
    input.kind,
    text(input.name, "a contact name", 120),
    email(input.email),
  ]);
}
export function parseCsv(source: unknown) {
  if (typeof source !== "string" || source.length > 12000)
    throw new AccountError(400, "Import a CSV file up to 12,000 characters.");
  const rows: string[][] = [];
  let row: string[] = [],
    cell = "",
    quoted = false;
  for (let n = 0; n < source.length; n++) {
    const c = source[n];
    if (c === '"') {
      if (quoted && source[n + 1] === '"') {
        cell += '"';
        n++;
      } else if (!quoted && cell !== "") throw new AccountError(400, "Check CSV quotes.");
      else quoted = !quoted;
    } else if (!quoted && (c === "," || c === "\n")) {
      row.push(cell.replace(/\r$/u, ""));
      cell = "";
      if (c === "\n") {
        if (row.some(Boolean)) rows.push(row);
        row = [];
      }
    } else cell += c;
  }
  if (quoted) throw new AccountError(400, "Close the CSV quotes.");
  row.push(cell.replace(/\r$/u, ""));
  if (row.some(Boolean)) rows.push(row);
  const header = rows.shift();
  if (header?.join(",") !== "name,sku,unit,reorder_level,cost,sale_price,category")
    throw new AccountError(400, "Use the item CSV headers shown on this page.");
  if (!rows.length || rows.length > 50 || rows.some((r) => r.length !== 7))
    throw new AccountError(400, "Import one to fifty complete item rows.");
  return rows;
}
export async function importItems(source: unknown) {
  const rows = parseCsv(source);
  return transaction(async (tx) => {
    for (const [name, sku, unit, reorder, cost, sale, category] of rows) {
      const list = (
        await tx.query("SELECT id FROM inventory_lists WHERE kind='category' AND name=$1", [
          category,
        ])
      ).rows[0];
      if (!list) throw new AccountError(400, `Create the category ${category} in settings first.`);
      await saveItem(
        {
          name,
          sku,
          unit,
          reorder_level: Number(reorder),
          cost,
          sale_price: sale,
          category_id: list.id,
        },
        tx,
      );
    }
    return { message: `Imported ${rows.length} items.` };
  });
}
export async function exportCsv(kind: string) {
  const db = database();
  let headers: string[], rows: Record<string, unknown>[];
  if (kind === "moves") {
    headers = ["item", "sku", "location", "quantity", "reason", "created_at"];
    rows = (
      await db.query(
        "SELECT i.name AS item,i.sku,l.name AS location,m.quantity,m.reason,m.created_at FROM inventory_moves m JOIN inventory_items i ON i.id=m.item_id JOIN inventory_locations l ON l.id=m.location_id ORDER BY m.created_at",
      )
    ).rows;
  } else {
    headers = ["name", "sku", "unit", "reorder_level", "cost", "sale_price", "category"];
    rows = (
      await db.query(
        "SELECT i.name,i.sku,i.unit,i.reorder_level,(i.cost::numeric/100)::text AS cost,(i.sale_price::numeric/100)::text AS sale_price,c.name AS category FROM inventory_items i JOIN inventory_lists c ON c.id=i.category_id ORDER BY i.name",
      )
    ).rows;
  }
  return `${[
    headers.join(","),
    ...rows.map((row) =>
      headers
        .map((h) =>
          csvCell(row[h] instanceof Date ? (row[h] as Date).toISOString() : String(row[h])),
        )
        .join(","),
    ),
  ].join("\r\n")}\r\n`;
}
export async function sendNotice(input: Record<string, unknown>, mailer: Mailer = emailDoor) {
  let recipient: string, subject: string, body: string, dedupe: string;
  if (input.action === "email-order") {
    const order = (
      await database().query(
        "SELECT o.*,p.email,p.name FROM inventory_orders o JOIN inventory_parties p ON p.id=o.party_id WHERE o.id=$1 AND o.kind='purchase'",
        [id(input.id)],
      )
    ).rows[0];
    if (!order) throw new AccountError(404, "Purchase order not found.");
    const lines = (
      await database().query(
        "SELECT i.name,x.quantity,x.unit_price FROM inventory_lines x JOIN inventory_items i ON i.id=x.item_id WHERE x.order_id=$1 ORDER BY i.name",
        [order.id],
      )
    ).rows;
    recipient = order.email;
    subject = `Purchase order ${order.reference}`;
    body = lines
      .map((l) => `${l.name}: ${l.quantity} at ${(l.unit_price / 100).toFixed(2)}`)
      .join("\n");
    dedupe = `order:${order.id}`;
  } else {
    recipient = email(input.email);
    const items = (await snapshot()).items.filter((i) => i.on_hand <= i.reorder_level);
    subject = "Low stock notice";
    body = items.length
      ? items
          .map(
            (i) => `${i.name} (${i.sku}): ${i.on_hand} ${i.unit}; reorder level ${i.reorder_level}`,
          )
          .join("\n")
      : "No low-stock items.";
    dedupe = `low:${createHash("sha256")
      .update(recipient + body)
      .digest("hex")}`;
  }
  const saved = (
    await database().query(
      "INSERT INTO inventory_mail(id,dedupe,recipient,subject,body) VALUES($1,$2,$3,$4,$5) ON CONFLICT(dedupe) DO UPDATE SET dedupe=excluded.dedupe RETURNING *",
      [randomUUID(), dedupe, recipient, subject, body],
    )
  ).rows[0];
  const result = await mailer.send(
    { to: saved.recipient, subject: saved.subject, text: saved.body },
    `inventory-mail-${saved.id}`,
  );
  return {
    message:
      result.status === "sent"
        ? "Email sent."
        : result.status === "unknown"
          ? "Delivery is uncertain. Retry uses the same message key."
          : "Email is not set up or unavailable. This message was not sent.",
  };
}

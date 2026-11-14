"use client";
import type { FormEvent } from "react";
import { useState } from "react";
import { useResource } from "../../lib/pramaan/client";
import { send } from "../inventory-parts";
import type { User } from "../shell";
export type Item = {
  id: string;
  name: string;
  sku: string;
  unit: string;
  reorder_level: number;
  /** Owner only: staff never receive cost prices. */
  cost?: number;
  sale_price: number;
  category_id: string;
  on_hand: number;
};
export type List = { id: string; kind: string; name: string; phase: string };
export type Snapshot = {
  items: Item[];
  locations: { id: string; name: string }[];
  parties: { id: string; kind: string; name: string; email: string }[];
  lists: List[];
  orders: {
    id: string;
    reference: string;
    kind: string;
    party: string;
    location: string;
    status: string;
    completed_at: string | null;
    lines: { item: string; quantity: number; unit_price?: number }[];
  }[];
  moves: {
    id: string;
    item: string;
    location: string;
    quantity: number;
    reason: string;
    created_at: string;
  }[];
};
export default function Stock() {
  const { data, error, reload } = useResource<Snapshot>("/api/inventory");
  const session = useResource<{ user: User }>("/api/account/session");
  const owner = session.data?.user?.role === "owner";
  const [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [editing, setEditing] = useState<Item | null>(null),
    [kind, setKind] = useState("purchase"),
    [lineCount, setLineCount] = useState(1);
  const post = async (input: object) => {
    setBusy(true);
    setMessage("");
    try {
      const result = await send<{ message?: string }>("/api/inventory", input);
      setMessage(result.message ?? "Saved.");
      reload();
      return true;
    } catch (e) {
      setMessage((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const form =
    (action: string, convert?: (f: FormData) => object) =>
    async (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const el = e.currentTarget,
        f = new FormData(el);
      if (await post({ action, ...Object.fromEntries(f), ...convert?.(f) })) {
        el.reset();
        setEditing(null);
      }
    };
  if (!data)
    return (
      <main className="workspace">
        <h1>Stock and orders</h1>
        <p>{error?.message ?? "Loading…"}</p>
      </main>
    );
  const options = (rows: { id: string; name: string }[]) =>
    rows.map((row) => (
      <option key={row.id} value={row.id}>
        {row.name}
      </option>
    ));
  return (
    <main className="workspace">
      <p className="eyebrow">The shop ledger</p>
      <h1>Stock and orders</h1>
      <p className="muted">
        Stock comes from recorded receipts, fulfilments and counts. Choose the matching location
        when receiving or picking.
      </p>
      <p role="status">{message}</p>
      <section>
        <h2>Items</h2>
        <div className="links">
          {owner && <a href="/api/export?kind=items">Export items CSV</a>}
          <a href="/api/export?kind=moves">Export stock moves CSV</a>
        </div>
        <div className="scroll">
          <table>
            <thead>
              <tr>
                {[
                  "Item",
                  "SKU",
                  "Unit",
                  "On hand",
                  "Reorder at",
                  ...(owner ? ["Cost"] : []),
                  "Sale price",
                  ...(owner ? ["Edit"] : []),
                ].map((h) => (
                  <th key={h}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.items.map((i) => (
                <tr key={i.id}>
                  <td>{i.name}</td>
                  <td>{i.sku}</td>
                  <td>{i.unit}</td>
                  <td>{i.on_hand}</td>
                  <td>{i.reorder_level}</td>
                  {owner && <td>{((i.cost ?? 0) / 100).toFixed(2)}</td>}
                  <td>{(i.sale_price / 100).toFixed(2)}</td>
                  {owner && (
                    <td>
                      <button type="button" onClick={() => setEditing(i)}>
                        Edit {i.name}
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {owner && (
          <>
            <h2>{editing ? "Edit item" : "Add item"}</h2>
            <form
              key={editing?.id ?? "new"}
              onSubmit={form("item", (f) => ({
                id: editing?.id,
                reorder_level: Number(f.get("reorder_level")),
              }))}
            >
              <label>
                Item name
                <input name="name" defaultValue={editing?.name} required maxLength={120} />
              </label>
              <label>
                SKU
                <input name="sku" defaultValue={editing?.sku} required maxLength={64} />
              </label>
              <label>
                Unit
                <input name="unit" defaultValue={editing?.unit ?? "each"} required maxLength={40} />
              </label>
              <label>
                Reorder level
                <input
                  name="reorder_level"
                  type="number"
                  min="0"
                  max="1000000"
                  defaultValue={editing?.reorder_level ?? 0}
                  required
                />
              </label>
              <label>
                Cost
                <input
                  name="cost"
                  type="number"
                  min="0"
                  step="0.01"
                  defaultValue={((editing?.cost ?? 0) / 100).toFixed(2)}
                  required
                />
              </label>
              <label>
                Sale price
                <input
                  name="sale_price"
                  type="number"
                  min="0"
                  step="0.01"
                  defaultValue={((editing?.sale_price ?? 0) / 100).toFixed(2)}
                  required
                />
              </label>
              <label>
                Category
                <select
                  aria-label="Category"
                  name="category_id"
                  defaultValue={editing?.category_id}
                >
                  {options(data.lists.filter((l) => l.kind === "category"))}
                </select>
              </label>
              <button disabled={busy} type="submit">
                Save item
              </button>
              {editing && (
                <button type="button" onClick={() => setEditing(null)}>
                  Cancel edit
                </button>
              )}
            </form>
            <h2>Import items</h2>
            <p>
              Up to 50 new items per file. Category names must already exist in shop settings.
              Prices use two decimal places.
            </p>
            <p>Headers: name,sku,unit,reorder_level,cost,sale_price,category</p>
            <label>
              Items CSV
              <input
                type="file"
                accept=".csv,text/csv"
                disabled={busy}
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (f) {
                    if (f.size > 12000) {
                      setMessage("Choose a CSV file under 12,000 bytes.");
                      return;
                    }
                    await post({ action: "import", csv: await f.text() });
                  }
                  e.target.value = "";
                }}
              />
            </label>
          </>
        )}
      </section>
      <section>
        <h2>Low stock</h2>
        {data.items
          .filter((i) => i.on_hand <= i.reorder_level)
          .map((i) => (
            <p key={i.id}>
              {i.name}: {i.on_hand} {i.unit} on hand, reorder at {i.reorder_level}
            </p>
          ))}
        {!data.items.some((i) => i.on_hand <= i.reorder_level) && <p>No low-stock items.</p>}
        {owner && (
          <form onSubmit={form("email-low")}>
            <label>
              Notice email
              <input name="email" type="email" required />
            </label>
            <button disabled={busy} type="submit">
              Send low-stock notice
            </button>
          </form>
        )}
      </section>
      {owner && (
        <section>
          <h2>New order</h2>
          <form
            onSubmit={form("order", (f) => ({
              kind,
              lines: Array.from({ length: lineCount }, (_, n) => ({
                item_id: f.get(`item_${n}`),
                quantity: Number(f.get(`quantity_${n}`)),
              })),
            }))}
          >
            <label>
              Order type
              <select
                aria-label="Order type"
                value={kind}
                onChange={(e) => setKind(e.target.value)}
              >
                <option value="purchase">Purchase</option>
                <option value="sales">Sales</option>
              </select>
            </label>
            <label>
              Order reference
              <input name="reference" required maxLength={80} />
            </label>
            <label>
              Contact
              <select aria-label="Contact" name="party_id" required>
                {options(
                  data.parties.filter(
                    (p) => p.kind === (kind === "purchase" ? "supplier" : "customer"),
                  ),
                )}
              </select>
            </label>
            <label>
              Order location
              <select aria-label="Order location" name="location_id">
                {options(data.locations)}
              </select>
            </label>
            <label>
              Open status
              <select aria-label="Open status" name="status_id" required>
                {options(data.lists.filter((l) => l.kind === kind && l.phase === "open"))}
              </select>
            </label>
            {Array.from({ length: lineCount }, (_, n) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: lines are only appended or removed at the end.
              <div key={`line-${n}`}>
                <label>
                  Line {n + 1} item
                  <select aria-label={`Line ${n + 1} item`} name={`item_${n}`} required>
                    {options(data.items)}
                  </select>
                </label>
                <label>
                  Line {n + 1} quantity
                  <input
                    name={`quantity_${n}`}
                    type="number"
                    min="1"
                    max="1000000"
                    defaultValue="1"
                    required
                  />
                </label>
              </div>
            ))}
            <button
              type="button"
              disabled={lineCount >= 20}
              onClick={() => setLineCount((n) => n + 1)}
            >
              Add line
            </button>
            {lineCount > 1 && (
              <button type="button" onClick={() => setLineCount((n) => n - 1)}>
                Remove last line
              </button>
            )}
            <button type="submit" disabled={busy}>
              Create order
            </button>
          </form>
          <p>Line prices are copied from the item's current cost or sale price on the server.</p>
        </section>
      )}
      <section>
        <h2>Orders</h2>
        {data.orders.map((o) => (
          <article key={o.id}>
            <h3>
              {o.reference} — {o.kind === "purchase" ? "Purchase" : "Sales"}
            </h3>
            <p>
              {o.party} · {o.location} · {o.status}
            </p>
            <ul>
              {o.lines.map((l) => (
                <li key={l.item}>
                  {l.item}: {l.quantity}
                  {l.unit_price === undefined ? "" : ` at ${(l.unit_price / 100).toFixed(2)}`}
                </li>
              ))}
            </ul>
            {!o.completed_at && (
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  await post({
                    action: "complete",
                    id: o.id,
                    status_id: new FormData(e.currentTarget).get("status_id"),
                  });
                }}
              >
                <label>
                  Complete {o.reference} as
                  <select name="status_id" required>
                    {options(data.lists.filter((l) => l.kind === o.kind && l.phase === "done"))}
                  </select>
                </label>
                <button disabled={busy} type="submit">
                  {o.kind === "purchase" ? "Receive" : "Fulfil"} {o.reference}
                </button>
              </form>
            )}
            {owner && o.kind === "purchase" && (
              <button
                disabled={busy}
                type="button"
                onClick={() => void post({ action: "email-order", id: o.id })}
              >
                Email {o.reference}
              </button>
            )}
          </article>
        ))}
        {!data.orders.length && <p>No orders yet.</p>}
      </section>
      {owner && (
        <section>
          <h2>Stock count</h2>
          <p>
            Enter what you counted at one location. The server records the difference as a move.
          </p>
          <form onSubmit={form("count", (f) => ({ count: Number(f.get("count")) }))}>
            <label>
              Count item
              <select aria-label="Count item" name="item_id">
                {options(data.items)}
              </select>
            </label>
            <label>
              Count location<select name="location_id">{options(data.locations)}</select>
            </label>
            <label>
              Counted quantity
              <input name="count" type="number" min="0" max="1000000" required />
            </label>
            <label>
              Count reason
              <input name="reason" required maxLength={240} />
            </label>
            <button type="submit" disabled={busy}>
              Record count
            </button>
          </form>
        </section>
      )}
      <section>
        <h2>Stock moves</h2>
        <p>Latest 500 moves. The CSV export includes every move.</p>
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Item</th>
                <th>Location</th>
                <th>Change</th>
                <th>Reason</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {data.moves.map((m) => (
                <tr key={m.id}>
                  <td>{m.item}</td>
                  <td>{m.location}</td>
                  <td>{m.quantity}</td>
                  <td>{m.reason}</td>
                  <td>{new Date(m.created_at).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}

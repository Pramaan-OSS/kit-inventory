"use client";
import type { FormEvent } from "react";
import { useState } from "react";
import { useResource } from "../../lib/pramaan/client";
import { send } from "../inventory-parts";
import type { Snapshot } from "../stock/page";
export default function Settings() {
  const { data, error, reload } = useResource<Snapshot>("/api/settings");
  const [message, setMessage] = useState(""),
    [link, setLink] = useState(""),
    [busy, setBusy] = useState(false);
  async function post(input: object) {
    setBusy(true);
    setMessage("");
    setLink("");
    try {
      const result = await send<{ message?: string; link?: string; email?: string }>(
        "/api/inventory",
        input,
      );
      setMessage(result.message ?? (result.email ? `Invite ready for ${result.email}.` : "Saved."));
      setLink(result.link ?? "");
      reload();
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const form =
    (action: string, extra: object = {}) =>
    (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      void post({ action, ...Object.fromEntries(new FormData(e.currentTarget)), ...extra });
    };
  if (!data)
    return (
      <main className="workspace">
        <h1>Shop settings</h1>
        <p>{error?.message ?? "Loading…"}</p>
      </main>
    );
  return (
    <main className="workspace">
      <h1>Shop settings</h1>
      <p role="status">{message}</p>
      {link && (
        <p>
          Email is unavailable. Pass this one-time link to the invited person:{" "}
          <a href={link}>Open staff invite</a>
        </p>
      )}
      <section>
        <h2>Staff</h2>
        <p>
          Staff sign in, receive stock and fulfil sales orders. Only the owner edits items, prices,
          settings and creates orders.
        </p>
        <form onSubmit={form("invite")}>
          <label>
            Staff email
            <input name="email" type="email" required />
          </label>
          <button type="submit" disabled={busy}>
            Invite staff
          </button>
        </form>
      </section>
      <section>
        <h2>Locations</h2>
        {data.locations.map((l) => (
          <p key={l.id}>{l.name}</p>
        ))}
        <form onSubmit={form("location")}>
          <label>
            Location name
            <input name="name" required maxLength={120} />
          </label>
          <button type="submit" disabled={busy}>
            Add location
          </button>
        </form>
      </section>
      <section>
        <h2>Suppliers and customers</h2>
        {data.parties.map((p) => (
          <p key={p.id}>
            {p.name} · {p.kind} · {p.email}
          </p>
        ))}
        <form onSubmit={form("party")}>
          <label>
            Contact type
            <select aria-label="Contact type" name="kind">
              <option value="supplier">Supplier</option>
              <option value="customer">Customer</option>
            </select>
          </label>
          <label>
            Contact name
            <input name="name" required maxLength={120} />
          </label>
          <label>
            Contact email
            <input name="email" type="email" required />
          </label>
          <button type="submit" disabled={busy}>
            Add contact
          </button>
        </form>
      </section>
      <section>
        <h2>Categories and order statuses</h2>
        <p>
          Rename any value. A value in use cannot be removed. Status purpose decides whether an
          order is open or completed; changing its name never changes stock.
        </p>
        {data.lists.map((l) => (
          <form key={l.id} onSubmit={form("list", { id: l.id })}>
            <span>
              {l.kind} · {l.phase}
            </span>
            <label>
              Rename {l.name}
              <input name="name" defaultValue={l.name} required maxLength={80} />
            </label>
            <button disabled={busy} type="submit">
              Save {l.name}
            </button>
            <button
              disabled={busy}
              type="button"
              onClick={() => void post({ action: "remove-list", id: l.id })}
            >
              Remove {l.name}
            </button>
          </form>
        ))}
        <form onSubmit={form("list")}>
          <label>
            List
            <select name="kind">
              <option value="category">Category</option>
              <option value="purchase">Purchase status</option>
              <option value="sales">Sales status</option>
            </select>
          </label>
          <label>
            New value
            <input name="name" required maxLength={80} />
          </label>
          <label>
            Status purpose
            <select name="phase">
              <option value="open">Open</option>
              <option value="done">Completed</option>
            </select>
          </label>
          <button disabled={busy} type="submit">
            Add value
          </button>
        </form>
      </section>
    </main>
  );
}

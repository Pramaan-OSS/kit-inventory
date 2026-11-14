# Inventory and orders

## Where things live

One Next.js app for one shop. Owner and staff share the shop's records; unassigned accounts and signed-out visitors cannot read them.

- `lib/accounts.ts`: reviewed portal account module, unchanged. Sessions and owner passes belong to it. `lib/runtime.ts` creates the only database pool and disables public signup.
- `lib/inventory/access.ts`: every inventory read requires owner or staff; writes other than order completion require owner. Settings and item exports require owner. Never trust a browser-supplied role.
- `lib/inventory/data.ts`: parameterised row storage, order creation, ledger changes, CSV parsing and exports. Prices are integer minor units read from items when creating orders. No API sets on-hand stock directly. Every quantity change is a move row. Completion locks the order, then item rows in sorted order and reads balances after acquiring locks. Counts take the same item lock. Never add a move-writing path without that lock.
- `src/db/migrations/0100-inventory.sql`: item, location, contact, list, order, line, move, invite and mail rows. Starter migrations 0001–0004 are unchanged. Add new migrations from 0101; never change applied files.
- `lib/inventory/invites.ts`: staff tokens are random, hashed, expire after seven days and can be accepted once. Staff roles come only from the stored invite.
- `lib/email.ts`: the platform module HTTP client. `sendNotice` stores immutable payloads and stable retry keys; unknown outcomes never get a fresh key. No direct email service or live paid call.
- `lib/roles/http.ts`: same-origin, size-bounded JSON reader and plain errors. `lib/pramaan/client.ts`: browser's same-origin request helper. `lib/pramaan.ts`: starter capability door, unchanged.
- Pages: `/` sign-in; `/stock` items, order lines, receipt, fulfilment, counts and low-stock notices; `/settings` staff, contacts, locations and editable categories/statuses; `/owner` owner sign-in settings; `/invite` staff joins; password-reset pages inherit the starter flow.
- Routes: `/api/inventory` reads records and applies guarded actions; `/api/settings` is owner-only; `/api/export?kind=items|moves` downloads CSV; `/api/invites` accepts/checks tokens; `/api/account/[action]` is unchanged.
- `lib/inventory/inventory.pg.spec.ts`: real database race, rollback, permission, invitation, CSV and fake-email checks. `scripts/walk.mjs`: headless journeys and permission checks. Blocks and adaptations are in `blocks.lock.json`.

## Add a field

Add an additive SQL migration, validate the new input in data.ts and add it to the relevant form. For example, a shelf label on items: add a bounded text column, then save and show it in the item form. Keep quantities owned by the move ledger.

## Add a page

Add `app/<name>/page.tsx` and a feature manifest, then run `pnpm generate`. Start every route with viewer or ownerOnly; never return shop rows to another account role. Add the correct navigation link in shell.tsx.

## Add a role

Create a migration widening the role constraint, add a server-issued invitation role, and define its read/write scope in access.ts. Never accept a role from the invitation browser. Test both its allowed actions and its forbidden actions.

## Journeys that ship working

stock-overview, receive-purchase, fulfil-sale, stock-count, edit-settings, invite-staff, owner-settings, signed-out, password-reset-off.

Each checklist creates its own required item and contacts through visible forms, so it also works on an empty database. scripts/walk.mjs runs every checklist on a disposable database. It additionally imports a file, downloads CSV, signs staff in from an invite, fulfils as staff, checks stock isolation and validates owner-pass replay. Email send-purchase and low-stock-notice need the email module; the fake sender proves message shape and retry keys without live delivery. item-csv is not-testable by the platform checklist vocabulary, but is checked in the browser walk.

## Checks and limits

Tests and walk are destructive only to their disposable database. Imports are limited to 12,000 characters and fifty items, order lines to twenty, quantities to one million, list settings to ninety. Orders complete once, in full. Only status names are editable after creation; their completion purpose never grants a browser the ability to change stock. Values in use cannot be removed. Email and a live database must be enabled by the platform before their respective live journeys work.

Local measurements use native process RSS, not platform container readings. The combined install, typecheck, lint and build measurement uses `CIRCLE_NODE_TOTAL=2` to keep one build worker (1,100 MiB in 12 seconds); the unrestricted desktop build also passed but used 2,741 MiB. The official platform run must replace these measurements before registry publication.

full kit CI: runs in product-loop on pinning. Product-loop runs the full container checks and commits the green kit-ci.json in its pinning PR. The red local record is intentionally retained; all required local gates have passed.

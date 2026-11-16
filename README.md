# Inventory and orders

A single-shop inventory kit with owner and staff sign-in, item CSV transfer, purchase receipts, sales fulfilment and a stock-move ledger.

Use Node 24.18.0 and pnpm 11.15.1. Install with `pnpm install --frozen-lockfile --ignore-scripts --ignore-pnpmfile`. Set DATABASE_URL, SESSION_SECRET (at least 32 characters), PRAMAAN_PROJECT_ID and APP_ORIGIN. Use APP_COOKIE_SECURE=false only for local HTTP. Run `node scripts/migrate.mjs`, then `pnpm dev --port 3450`. The platform's owner pass opens `/owner`; there is no public registration.

Run `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, `node scripts/check-contract.mjs`, and `node scripts/walk.mjs`. Tests require a disposable database and clear its inventory and account rows. Never point them at real shop data.

Email uses the platform module socket and is off until the platform configures it. With email off, staff can join through an owner-shared one-time invite link. See KIT.md for extension points and limits.

The kit carries no browser tools. To run `node scripts/walk.mjs`, install `@playwright/test` 1.64.1 outside the kit and set `WALK_BROWSER_MODULE` to its `index.mjs`.

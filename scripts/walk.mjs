import { execFileSync, spawn } from "node:child_process";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// The kit carries the starter's package.json, which has no browser tools: point WALK_BROWSER_MODULE at an installed
// @playwright/test (its index.mjs) to run this walk.
const browserModule = process.env.WALK_BROWSER_MODULE;
const { chromium, expect } = await import(
  browserModule ? pathToFileURL(browserModule).href : "@playwright/test"
);

import { Pool } from "pg";

const origin = "http://127.0.0.1:3450",
  secret = randomBytes(32).toString("hex"),
  project = "inventory-walk";
if (!process.env.DATABASE_URL)
  throw Error("Use a disposable DATABASE_URL; the walk clears its records.");
const db = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
mkdirSync(".evidence", { recursive: true });
let app,
  browser,
  timer,
  peak = 0;
const results = [];
let debugPage;
function pass(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  const body = Buffer.from(
    JSON.stringify({
      v: 1,
      role: "owner",
      project,
      iat: now,
      exp: now + 60,
      nonce: randomBytes(18).toString("base64url"),
      ...overrides,
    }),
  ).toString("base64url");
  return `${body}.${createHmac("sha256", secret).update(`pramaan-owner-pass.v1.${body}`).digest("base64url")}`;
}
async function api(page, input) {
  return page.evaluate(async (input) => {
    const r = await fetch("/api/inventory", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    return { status: r.status, body: await r.json() };
  }, input);
}
try {
  await db.query(
    "TRUNCATE inventory_mail,inventory_moves,inventory_lines,inventory_orders,inventory_items,inventory_parties,inventory_invites,app_users,app_owner_passes CASCADE",
  );
  await db.query("DELETE FROM inventory_lists WHERE id::text NOT LIKE '10000000-0000-4000-8000-%'");
  await db.query(
    "DELETE FROM inventory_locations WHERE id<>'20000000-0000-4000-8000-000000000001'",
  );
  app = spawn(
    process.execPath,
    ["node_modules/next/dist/bin/next", "start", "-p", "3450", "-H", "127.0.0.1"],
    {
      env: {
        ...process.env,
        SESSION_SECRET: secret,
        PRAMAAN_PROJECT_ID: project,
        APP_ORIGIN: origin,
        APP_COOKIE_SECURE: "false",
        PRAMAAN_MODULES_DIR: `${process.cwd()}/.evidence/no-email`,
      },
      stdio: ["ignore", "ignore", "inherit"],
    },
  );
  timer = setInterval(() => {
    try {
      const rows = execFileSync("ps", ["-A", "-o", "pid=,ppid=,rss="], { encoding: "utf8" })
        .trim()
        .split("\n")
        .map((x) => x.trim().split(/\s+/u).map(Number));
      const pids = new Set([app.pid]);
      for (let old = -1; old !== pids.size; ) {
        old = pids.size;
        for (const [pid, ppid] of rows) if (pids.has(ppid)) pids.add(pid);
      }
      peak = Math.max(
        peak,
        Math.ceil(
          rows.filter(([pid]) => pids.has(pid)).reduce((sum, [, , rss]) => sum + rss, 0) / 1024,
        ),
      );
    } catch {}
  }, 150);
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${origin}/api/health`)).ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  if (!ready) throw Error("Server did not start.");
  browser = await chromium.launch({ headless: true });
  const ownerContext = await browser.newContext(),
    page = await ownerContext.newPage();
  debugPage = page;
  page.on("pageerror", (e) => console.error("Browser:", e.message));
  const token = pass();
  await page.goto(`${origin}/api/account/owner-pass?token=${encodeURIComponent(token)}`);
  await expect(page.getByRole("heading", { name: "Owner area" })).toBeVisible();
  const replay = await ownerContext.request.get(
    `${origin}/api/account/owner-pass?token=${encodeURIComponent(token)}`,
    { maxRedirects: 0 },
  );
  expect(replay.status()).toBeGreaterThanOrEqual(400);
  const wrong = await ownerContext.request.get(
    `${origin}/api/account/owner-pass?token=${encodeURIComponent(pass({ project: "another-shop" }))}`,
    { maxRedirects: 0 },
  );
  expect(wrong.status()).toBeGreaterThanOrEqual(400);
  await page.getByLabel("Owner email").fill("owner@inventory.test");
  await page.getByLabel("Password", { exact: true }).fill("Inventory-owner-123");
  await page.getByRole("button", { name: "Save sign-in" }).click();
  await expect(
    page.getByText("Saved. You can now sign in with this email and password."),
  ).toBeVisible();
  // CSV import goes through the actual browser file control.
  await page.goto(`${origin}/stock`);
  await page.getByLabel("Items CSV").setInputFiles({
    name: "items.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(
      "name,sku,unit,reorder_level,cost,sale_price,category\nCanvas bag,BAG,each,3,2.50,5.00,General\n",
    ),
  });
  await expect(page.getByRole("status")).toHaveText("Imported 1 items.");
  for (const kind of ["supplier", "customer"])
    expect(
      (
        await api(page, {
          action: "party",
          kind,
          name: kind === "supplier" ? "Weave Works" : "Market Stall",
          email: `${kind}@inventory.test`,
        })
      ).status,
    ).toBe(200);
  const manifest = JSON.parse(readFileSync("pramaan.kit.json", "utf8"));
  for (const journey of manifest.journeys.filter((j) => j.status === "ships-working")) {
    const checklist = JSON.parse(readFileSync(journey.checklist, "utf8"));
    console.log(`Journey ${journey.id}`);
    // As the gate does: enterAs opens a fresh browser at home (signed out; the owner's signs in with a pass), and an
    // enterAs with "as" returns to that named person's browser.
    const contexts = [await browser.newContext()],
      named = new Map();
    let p = await contexts[0].newPage();
    for (const item of checklist.items)
      for (const step of item.steps) {
        if (step.enterAs) {
          const key = `${step.enterAs}\u0000${step.as ?? ""}`;
          if (step.as && named.has(key)) p = named.get(key);
          else {
            contexts.push(await browser.newContext());
            p = await contexts.at(-1).newPage();
            await p.goto(
              step.enterAs === "owner"
                ? `${origin}/api/account/owner-pass?token=${encodeURIComponent(pass())}`
                : `${origin}/`,
            );
            if (step.as) named.set(key, p);
          }
        } else if (step.goto) await p.goto(origin + step.goto);
        else if (step.fill) await p.getByLabel(step.fill, { exact: true }).fill(step.value);
        else if (step.select)
          await p.getByLabel(step.select, { exact: true }).selectOption({ label: step.option });
        else if (step.click)
          await p
            .getByRole("button", { name: step.click, exact: true })
            .or(p.getByRole("link", { name: step.click, exact: true }))
            .click();
        else if (step.expectText)
          await expect(p.getByText(step.expectText, { exact: false }).first()).toBeVisible();
        else if (step.expectAbsent)
          await expect(p.getByLabel(step.expectAbsent, { exact: true })).toHaveCount(0);
        else throw Error(`Unknown checklist step ${JSON.stringify(step)}`);
      }
    results.push(journey.id);
    for (const context of contexts) await context.close();
  }
  // Accept and sign in with a real staff invitation, then fulfil through the staff screen.
  await page.goto(`${origin}/settings`);
  await page.getByLabel("Staff email").fill("staff@inventory.test");
  await page.getByRole("button", { name: "Invite staff", exact: true }).click();
  await expect(page.getByRole("link", { name: "Open staff invite" })).toBeVisible();
  const invite = await page.getByRole("link", { name: "Open staff invite" }).getAttribute("href");
  const staffContext = await browser.newContext(),
    staff = await staffContext.newPage();
  await staff.goto(invite);
  await staff.getByLabel("Choose a password", { exact: true }).fill("Inventory-staff-123");
  await staff.getByLabel("Type it again").fill("Inventory-staff-123");
  await staff.getByRole("button", { name: "Accept invite" }).click();
  await expect(staff.getByText("Signed in", { exact: false })).toBeVisible();
  const replayInvite = await staffContext.request.post(`${origin}/api/invites`, {
    headers: { origin },
    data: { action: "check", token: invite.split("#")[1] },
  });
  expect(replayInvite.status()).toBe(410);
  const item = (await db.query("SELECT id FROM inventory_items WHERE sku='BAG'")).rows[0].id,
    party = (await db.query("SELECT id FROM inventory_parties WHERE kind='customer'")).rows[0].id;
  expect(
    (
      await api(page, {
        action: "count",
        item_id: item,
        location_id: "20000000-0000-4000-8000-000000000001",
        count: 4,
        reason: "Staff pick opening count",
      })
    ).status,
  ).toBe(200);
  const sale = await api(page, {
    action: "order",
    kind: "sales",
    reference: "Staff pick",
    party_id: party,
    location_id: "20000000-0000-4000-8000-000000000001",
    status_id: "10000000-0000-4000-8000-000000000004",
    lines: [{ item_id: item, quantity: 1 }],
  });
  expect(sale.status).toBe(201);
  await staff.goto(`${origin}/stock`);
  await staff.getByRole("button", { name: "Fulfil Staff pick", exact: true }).click();
  await expect(staff.getByRole("status")).toHaveText("Sales order fulfilled.");
  expect((await staffContext.request.get(`${origin}/api/settings`)).status()).toBe(403);
  expect((await api(staff, { action: "item", id: item, cost: "0.01" })).status).toBe(403);
  await staff.goto(`${origin}/settings`);
  await expect(staff.getByText("Only the owner can do this.")).toBeVisible();
  await page.goto(`${origin}/stock`);
  await page.getByRole("button", { name: "Edit Canvas bag" }).click();
  await page.getByLabel("Sale price", { exact: true }).fill("6.25");
  await page.getByRole("button", { name: "Save item" }).click();
  await expect(page.getByRole("status")).toHaveText("Saved.");
  const csv = await ownerContext.request.get(`${origin}/api/export?kind=items`);
  expect(csv.status()).toBe(200);
  expect(await csv.text()).toContain("6.25");
  const moves = await staffContext.request.get(`${origin}/api/export?kind=moves`);
  expect(await moves.text()).toContain("Sales fulfilment");
  await page.getByLabel("Notice email").fill("owner@inventory.test");
  await page.getByRole("button", { name: "Send low-stock notice" }).click();
  await expect(page.getByRole("status")).toContainText("This message was not sent.");
  const purchase = (await db.query("SELECT id FROM inventory_orders WHERE kind='purchase' LIMIT 1"))
    .rows[0].id;
  expect((await api(page, { action: "email-order", id: purchase })).body.message).toContain(
    "not sent",
  );
  const outsider = await browser.newContext();
  expect((await outsider.request.get(`${origin}/api/inventory`)).status()).toBe(401);
  expect((await outsider.request.get(`${origin}/api/export?kind=moves`)).status()).toBe(401);
  const stranger = randomUUID(),
    strangerToken = randomBytes(32).toString("hex");
  await db.query(
    "INSERT INTO app_users(id,email,password_hash,role) VALUES($1,'stranger@inventory.test','unused','member')",
    [stranger],
  );
  await db.query("INSERT INTO app_sessions VALUES($1,$2,now()+interval '1 hour')", [
    createHmac("sha256", secret).update(strangerToken).digest("hex"),
    stranger,
  ]);
  await outsider.addCookies([{ name: "app_session", value: strangerToken, url: origin }]);
  expect((await outsider.request.get(`${origin}/api/inventory`)).status()).toBe(403);
  // Empty, populated and narrow layouts are captured for review.
  await page.goto(`${origin}/stock`);
  await expect(page.getByRole("heading", { name: "Stock moves", exact: true })).toBeVisible();
  await page.screenshot({ path: ".evidence/stock-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: ".evidence/stock-mobile.png", fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.goto(`${origin}/settings`);
  await expect(page.getByRole("heading", { name: "Staff", exact: true })).toBeVisible();
  await page.screenshot({ path: ".evidence/settings.png", fullPage: true });
  results.push(
    "csv-import-export",
    "staff-sign-in-and-fulfil",
    "staff-settings-and-price-403",
    "owner-pass-replay-and-project",
    "invite-replay",
    "unassigned-account-isolation",
    "email-off",
    "mobile-layout",
  );
  writeFileSync(
    ".evidence/walk.json",
    JSON.stringify({ passed: results, appPeakMiB: peak }, null, 2),
  );
  console.log(`Walk: ${results.length} checks passed; app peak ${peak} MiB`);
} catch (error) {
  if (debugPage) {
    console.error(await debugPage.locator("body").innerText());
    await debugPage.screenshot({ path: ".evidence/walk-failure.png", fullPage: true });
  }
  throw error;
} finally {
  clearInterval(timer);
  await browser?.close();
  if (app) {
    app.kill("SIGTERM");
    await new Promise((r) => app.once("exit", r));
  }
  await db.end();
}

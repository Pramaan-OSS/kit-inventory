// Staff invitations carry a random single-use token; only its hash is stored. The server grants the role.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { AccountError, hashPassword } from "../accounts";
import type { Mailer } from "../email";
import { database } from "../runtime";
import { email as checkEmail } from "./words";

const INVITE_DAYS = 7;
const TOKEN = /^[a-f0-9]{64}$/u;
const USED = "This invite link has expired or was already used. Ask for a new one.";
const hash = (token: string) => createHash("sha256").update(token).digest("hex");

export type InviteResult = {
  email: string;
  /** "sent" when the email went. Otherwise `link` is there for the inviter to pass on by hand. */
  delivery: "sent" | "not-sent" | "unknown";
  link?: string;
};

/** The address, when no account has it yet. */
export async function unclaimed(value: unknown) {
  const address = checkEmail(value);
  const taken = await database().query("SELECT 1 FROM app_users WHERE email=$1", [address]);
  if (taken.rowCount) throw new AccountError(409, "That email already has an account here.");
  return address;
}

export async function createInvite(
  mailer: Mailer,
  input: { email: unknown; role: "staff"; invitedBy: string },
  origin: string,
  business: string,
): Promise<InviteResult> {
  const address = await unclaimed(input.email);
  const db = database();
  const token = randomBytes(32).toString("hex");
  const inviteId = randomUUID();
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    // A new invite replaces any unused one for the same address, so only the newest link works.
    await client.query("DELETE FROM inventory_invites WHERE email=$1 AND used_at IS NULL", [
      address,
    ]);
    await client.query(
      `INSERT INTO inventory_invites(id,token_hash,email,role,invited_by,expires_at)
      VALUES($1,$2,$3,$4,$5,now()+$6*interval '1 day')`,
      [inviteId, hash(token), address, input.role, input.invitedBy, INVITE_DAYS],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  // The token rides in the fragment, which browsers never send to a server, so it stays out of logs and referrers.
  const link = `${origin}/invite#${token}`;
  const sent = await mailer.send(
    {
      to: address,
      subject: `You're invited to ${business}`,
      text: `You've been invited to ${business}.\n\nOpen this link to choose your password and sign in. It works once, for ${INVITE_DAYS} days:\n${link}\n\nIf you weren't expecting this, you can ignore this email.`,
    },
    `inventory-invite-${inviteId}`,
  );
  if (sent.status === "sent") {
    await db.query("UPDATE inventory_invites SET emailed=true WHERE id=$1", [inviteId]);
    return { email: address, delivery: "sent" };
  }
  return { email: address, delivery: sent.status, link };
}

type Invite = {
  id: string;
  email: string;
  role: "staff";

  emailed: boolean;
};

async function find(token: unknown): Promise<Invite> {
  if (typeof token !== "string" || !TOKEN.test(token)) throw new AccountError(410, USED);
  const row = await database().query<Invite>(
    "SELECT id,email,role,emailed FROM inventory_invites WHERE token_hash=$1 AND used_at IS NULL AND expires_at>now()",
    [hash(token)],
  );
  if (!row.rows[0]) throw new AccountError(410, USED);
  return row.rows[0];
}

/** What the invite page shows before a password is chosen. */
export async function checkInvite(token: unknown) {
  const invite = await find(token);
  return { email: invite.email, role: invite.role };
}

/**
 * Makes the invited account with the chosen password, once. The browser then signs in with it as usual. The address
 * counts as confirmed only when the invite reached it by email.
 */
export async function acceptInvite(token: unknown, password: unknown, minLength: number) {
  await find(token);
  const chosen = typeof password === "string" ? password : "";
  if (chosen.length < minLength || chosen.length > 1024)
    throw new AccountError(400, `Use ${minLength} to 1,024 characters for your password.`);
  const passwordHash = await hashPassword(chosen);
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    // Locked and checked again inside the transaction: two tabs accepting at once make one account.
    const locked = await client.query<Invite>(
      `SELECT id,email,role,emailed FROM inventory_invites
      WHERE token_hash=$1 AND used_at IS NULL AND expires_at>now() FOR UPDATE`,
      [hash(token as string)],
    );
    const invite = locked.rows[0];
    if (!invite) throw new AccountError(410, USED);
    const userId = randomUUID();
    const made = await client.query(
      `INSERT INTO app_users(id,email,password_hash,role,email_verified_at)
      VALUES($1,$2,$3,$4,CASE WHEN $5 THEN now() END) ON CONFLICT(email) DO NOTHING RETURNING id`,
      [userId, invite.email, passwordHash, invite.role, invite.emailed],
    );
    if (!made.rows[0])
      throw new AccountError(409, "That email already has an account here. Sign in.");
    await client.query("UPDATE inventory_invites SET used_at=now() WHERE id=$1", [invite.id]);
    await client.query("COMMIT");
    return { email: invite.email };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

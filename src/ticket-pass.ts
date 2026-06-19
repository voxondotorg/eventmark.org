import { getRegistration, getUserById, saveRegistration, type TicketIndexEntry } from "./db.js";
import { getTicket, saveTicket } from "./db.js";
import { nowIso } from "./db.js";
import { isLocalDevFlag } from "./env-guard.js";

const TICKET_SPENT_PREFIX = "ticket_spent:";

export function ticketPassSecretFromEnv(env: {
  INVITE_PASS_SECRET?: string;
  LOCAL_DEV?: string;
  ENVIRONMENT?: string;
}): string {
  const secret = (env.INVITE_PASS_SECRET || "").trim();
  if (secret) return secret;
  if (isLocalDevFlag(env.LOCAL_DEV)) return "eventmark-invite-local-only";
  throw new Error(
    "INVITE_PASS_SECRET is not configured. Set it via: wrangler secret put INVITE_PASS_SECRET"
  );
}

function b64url(bytes: Uint8Array): string {
  const bin = String.fromCharCode(...bytes);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function encodeJsonB64url(v: unknown): string {
  return b64url(new TextEncoder().encode(JSON.stringify(v)));
}

function decodeJsonB64url<T>(input: string): T | null {
  try {
    const pad = input.length % 4 === 0 ? "" : "=".repeat(4 - (input.length % 4));
    const b64 = input.replace(/-/g, "+").replace(/_/g, "/") + pad;
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    return null;
  }
}

async function sign(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return b64url(new Uint8Array(sig));
}

async function verify(payload: string, sig: string, secret: string): Promise<boolean> {
  const expected = await sign(payload, secret);
  return expected === sig;
}

export interface TicketPassPayload {
  v: 1;
  kind: "ticket";
  ticketCode: string;
  eventId: string;
  userId: string;
  registrationId: string;
  issuedAt: string;
}

export async function saveIssuedTicket(
  kv: KVNamespace,
  ticketCode: string,
  entry: Pick<TicketIndexEntry, "eventId" | "userId" | "registrationId">,
  secret: string
): Promise<TicketIndexEntry> {
  const token = await createTicketPassToken({ ticketCode, ...entry }, secret);
  const next: TicketIndexEntry = { ...entry, ticketToken: token, checkedInAt: null };
  await saveTicket(kv, ticketCode, next);
  return next;
}

export async function createTicketPassToken(
  args: Pick<TicketPassPayload, "ticketCode" | "eventId" | "userId" | "registrationId">,
  secret: string
): Promise<string> {
  const payload = encodeJsonB64url({
    v: 1,
    kind: "ticket",
    ticketCode: args.ticketCode,
    eventId: args.eventId,
    userId: args.userId,
    registrationId: args.registrationId,
    issuedAt: nowIso(),
  } satisfies TicketPassPayload);
  const sig = await sign(payload, secret);
  return `${payload}.${sig}`;
}

export async function verifyTicketPassToken(
  kv: KVNamespace,
  token: string,
  secret: string
): Promise<{ entry: TicketIndexEntry; payload: TicketPassPayload } | null> {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  const ok = await verify(payload, sig, secret);
  if (!ok) return null;
  const decoded = decodeJsonB64url<TicketPassPayload>(payload);
  if (!decoded || decoded.kind !== "ticket" || typeof decoded.ticketCode !== "string") return null;
  const entry = await getTicket(kv, decoded.ticketCode);
  if (!entry || entry.ticketToken !== token) return null;
  return { entry, payload: decoded };
}

export async function ensureTicketPassToken(
  kv: KVNamespace,
  ticketCode: string,
  secret: string
): Promise<{ entry: TicketIndexEntry; token: string } | null> {
  const entry = await getTicket(kv, ticketCode);
  if (!entry) return null;
  if (entry.ticketToken) return { entry, token: entry.ticketToken };
  const token = await createTicketPassToken(
    {
      ticketCode,
      eventId: entry.eventId,
      userId: entry.userId,
      registrationId: entry.registrationId,
    },
    secret
  );
  const next: TicketIndexEntry = { ...entry, ticketToken: token };
  await saveTicket(kv, ticketCode, next);
  return { entry: next, token };
}

export async function checkInByTicketPassToken(
  kv: KVNamespace,
  token: string,
  secret: string
): Promise<{
  ok: boolean;
  reason?: string;
  entry?: TicketIndexEntry;
  attendeeName?: string;
  attendeeEmail?: string;
}> {
  const verified = await verifyTicketPassToken(kv, token, secret);
  if (!verified) return { ok: false, reason: "invalid_pass" };
  if (verified.entry.checkedInAt) return { ok: false, reason: "already_used" };

  const spentKey = `${TICKET_SPENT_PREFIX}${token}`;
  const claimId = crypto.randomUUID();
  const existingSpent = await kv.get(spentKey);
  if (existingSpent) return { ok: false, reason: "already_used" };
  await kv.put(spentKey, claimId);
  const winner = await kv.get(spentKey);
  if (winner !== claimId) return { ok: false, reason: "already_used" };

  const now = nowIso();
  const nextEntry: TicketIndexEntry = { ...verified.entry, checkedInAt: now };
  await saveTicket(kv, verified.payload.ticketCode, nextEntry);

  const reg = await getRegistration(kv, verified.payload.eventId, verified.payload.userId);
  if (reg) {
    await saveRegistration(kv, { ...reg, checkedInAt: now });
  }

  const user = await getUserById(kv, verified.payload.userId);
  return {
    ok: true,
    entry: nextEntry,
    attendeeName: user?.name || user?.email?.split("@")[0] || "Guest",
    attendeeEmail: user?.email,
  };
}

export async function previewTicketPassToken(
  kv: KVNamespace,
  token: string,
  secret: string
): Promise<{
  valid: boolean;
  eventId?: string;
  ticketCode?: string;
  checkedIn?: boolean;
  checkedInAt?: string | null;
}> {
  const verified = await verifyTicketPassToken(kv, token, secret);
  if (!verified) return { valid: false };
  return {
    valid: true,
    eventId: verified.payload.eventId,
    ticketCode: verified.payload.ticketCode,
    checkedIn: !!verified.entry.checkedInAt,
    checkedInAt: verified.entry.checkedInAt ?? null,
  };
}

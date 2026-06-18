import { nowIso, randomId, type EventRecord, type UserRecord } from "./db.js";

export type InviteStatus = "invited" | "accepted" | "declined" | "waitlisted" | "checked_in";
export type InviteRole = "attendee" | "vip" | "speaker" | "staff";

export interface InviteRecord {
  id: string;
  eventId: string;
  email: string;
  name: string;
  role: InviteRole;
  status: InviteStatus;
  inviteToken: string;
  passToken: string | null;
  checkedInAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SpeakerPlacement {
  id: string;
  eventId: string;
  name: string;
  topic: string;
  stage: string;
  startsAt: string;
  endsAt: string;
  createdAt: string;
}

export interface BoothPlacement {
  id: string;
  eventId: string;
  boothCode: string;
  title: string;
  owner: string;
  locationHint: string;
  createdAt: string;
}

export interface SessionPlacement {
  id: string;
  eventId: string;
  title: string;
  room: string;
  startsAt: string;
  endsAt: string;
  capacity: number;
  createdAt: string;
}

export interface BrandingSettings {
  siteTitle: string;
  logoUrl: string | null;
  primaryColor: string;
  supportEmail: string | null;
  updatedAt: string;
  updatedBy: string;
}

const INVITE_PREFIX = "invite:";
const INVITE_EVENT_INDEX = "invite_event:";
const SPEAKER_PREFIX = "speaker_slot:";
const BOOTH_PREFIX = "booth_slot:";
const SESSION_PREFIX = "session_slot:";
const BRANDING_KEY = "branding:global";
const PASS_SPENT_PREFIX = "pass_spent:";

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
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

export async function listInvitesForEvent(kv: KVNamespace, eventId: string): Promise<InviteRecord[]> {
  const listed = await kv.list({ prefix: `${INVITE_EVENT_INDEX}${eventId}:` });
  const out: InviteRecord[] = [];
  for (const key of listed.keys) {
    const id = key.name.split(":").pop();
    if (!id) continue;
    const raw = await kv.get(`${INVITE_PREFIX}${id}`, "json");
    if (raw) out.push(raw as InviteRecord);
  }
  out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return out;
}

export async function importInvites(
  kv: KVNamespace,
  event: EventRecord,
  guests: Array<{ email: string; name?: string; role?: InviteRole }>
): Promise<InviteRecord[]> {
  const now = nowIso();
  const created: InviteRecord[] = [];
  const uniq = new Map<string, { email: string; name?: string; role?: InviteRole }>();
  for (const g of guests) {
    const email = normalizeEmail(g.email || "");
    if (!email) continue;
    uniq.set(email, { ...g, email });
  }
  for (const g of uniq.values()) {
    const id = randomId();
    const invite: InviteRecord = {
      id,
      eventId: event.id,
      email: g.email,
      name: (g.name || g.email.split("@")[0]).trim().slice(0, 140),
      role: g.role || "attendee",
      status: "invited",
      inviteToken: randomId(),
      passToken: null,
      checkedInAt: null,
      createdAt: now,
      updatedAt: now,
    };
    await kv.put(`${INVITE_PREFIX}${invite.id}`, JSON.stringify(invite));
    await kv.put(`${INVITE_EVENT_INDEX}${event.id}:${invite.id}`, "1");
    created.push(invite);
  }
  return created;
}

export async function getInvite(kv: KVNamespace, inviteId: string): Promise<InviteRecord | null> {
  const raw = await kv.get(`${INVITE_PREFIX}${inviteId}`, "json");
  return raw ? (raw as InviteRecord) : null;
}

export async function saveInvite(kv: KVNamespace, invite: InviteRecord): Promise<void> {
  await kv.put(`${INVITE_PREFIX}${invite.id}`, JSON.stringify(invite));
  await kv.put(`${INVITE_EVENT_INDEX}${invite.eventId}:${invite.id}`, "1");
}

export async function updateInviteRsvp(
  kv: KVNamespace,
  inviteId: string,
  status: Exclude<InviteStatus, "checked_in">,
  inviteToken?: string
): Promise<InviteRecord | null> {
  const invite = await getInvite(kv, inviteId);
  if (!invite) return null;
  if (!inviteToken || invite.inviteToken !== inviteToken) return null;
  const next: InviteRecord = {
    ...invite,
    status,
    updatedAt: nowIso(),
  };
  await saveInvite(kv, next);
  return next;
}

export async function issuePassForInvite(
  kv: KVNamespace,
  invite: InviteRecord,
  event: EventRecord,
  secret: string
): Promise<InviteRecord> {
  const payload = encodeJsonB64url({
    v: 1,
    inviteId: invite.id,
    eventId: event.id,
    email: invite.email,
    role: invite.role,
    issuedAt: nowIso(),
  });
  const sig = await sign(payload, secret);
  const passToken = `${payload}.${sig}`;
  const next: InviteRecord = {
    ...invite,
    passToken,
    updatedAt: nowIso(),
  };
  await saveInvite(kv, next);
  return next;
}

export async function verifyPassToken(
  kv: KVNamespace,
  token: string,
  secret: string
): Promise<{ invite: InviteRecord; payload: Record<string, unknown> } | null> {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  const ok = await verify(payload, sig, secret);
  if (!ok) return null;
  const decoded = decodeJsonB64url<Record<string, unknown>>(payload);
  if (!decoded || typeof decoded.inviteId !== "string") return null;
  const invite = await getInvite(kv, decoded.inviteId);
  if (!invite || invite.passToken !== token) return null;
  return { invite, payload: decoded };
}

export async function checkInByPassToken(
  kv: KVNamespace,
  token: string,
  secret: string
): Promise<{ ok: boolean; reason?: string; invite?: InviteRecord }> {
  const verified = await verifyPassToken(kv, token, secret);
  if (!verified) return { ok: false, reason: "invalid_pass" };
  const spentKey = `${PASS_SPENT_PREFIX}${token}`;
  const claimId = randomId();
  const existingSpent = await kv.get(spentKey);
  if (existingSpent) return { ok: false, reason: "already_used" };
  await kv.put(spentKey, claimId);
  const winner = await kv.get(spentKey);
  if (winner !== claimId) return { ok: false, reason: "already_used" };
  const now = nowIso();
  const next: InviteRecord = {
    ...verified.invite,
    status: "checked_in",
    checkedInAt: now,
    updatedAt: now,
  };
  await saveInvite(kv, next);
  return { ok: true, invite: next };
}

export async function listSpeakerSlots(kv: KVNamespace, eventId: string): Promise<SpeakerPlacement[]> {
  const listed = await kv.list({ prefix: `${SPEAKER_PREFIX}${eventId}:` });
  const out: SpeakerPlacement[] = [];
  for (const k of listed.keys) {
    const raw = await kv.get(k.name, "json");
    if (raw) out.push(raw as SpeakerPlacement);
  }
  return out.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}

export type PlacementAddError = "duplicate_topic" | "duplicate_title";

export type PlacementAddResult<T> =
  | { ok: true; item: T }
  | { ok: false; error: PlacementAddError };

function normLabel(value: string): string {
  return value.trim().toLowerCase();
}

export async function addSpeakerSlot(
  kv: KVNamespace,
  eventId: string,
  body: Pick<SpeakerPlacement, "name" | "topic" | "stage" | "startsAt" | "endsAt">
): Promise<PlacementAddResult<SpeakerPlacement>> {
  const topic = normLabel(body.topic);
  const existing = await listSpeakerSlots(kv, eventId);
  if (existing.some((s) => normLabel(s.topic) === topic)) {
    return { ok: false, error: "duplicate_topic" };
  }
  const row: SpeakerPlacement = {
    id: randomId(),
    eventId,
    name: body.name.trim().slice(0, 200),
    topic: body.topic.trim().slice(0, 240),
    stage: body.stage.trim().slice(0, 120),
    startsAt: body.startsAt,
    endsAt: body.endsAt,
    createdAt: nowIso(),
  };
  await kv.put(`${SPEAKER_PREFIX}${eventId}:${row.id}`, JSON.stringify(row));
  return { ok: true, item: row };
}

export async function listBooths(kv: KVNamespace, eventId: string): Promise<BoothPlacement[]> {
  const listed = await kv.list({ prefix: `${BOOTH_PREFIX}${eventId}:` });
  const out: BoothPlacement[] = [];
  for (const k of listed.keys) {
    const raw = await kv.get(k.name, "json");
    if (raw) out.push(raw as BoothPlacement);
  }
  return out.sort((a, b) => a.boothCode.localeCompare(b.boothCode));
}

export async function addBooth(
  kv: KVNamespace,
  eventId: string,
  body: Pick<BoothPlacement, "boothCode" | "title" | "owner" | "locationHint">
): Promise<PlacementAddResult<BoothPlacement>> {
  const title = normLabel(body.title);
  const existing = await listBooths(kv, eventId);
  if (existing.some((b) => normLabel(b.title) === title)) {
    return { ok: false, error: "duplicate_title" };
  }
  const row: BoothPlacement = {
    id: randomId(),
    eventId,
    boothCode: body.boothCode.trim().slice(0, 50),
    title: body.title.trim().slice(0, 180),
    owner: body.owner.trim().slice(0, 180),
    locationHint: body.locationHint.trim().slice(0, 300),
    createdAt: nowIso(),
  };
  await kv.put(`${BOOTH_PREFIX}${eventId}:${row.id}`, JSON.stringify(row));
  return { ok: true, item: row };
}

export async function listSessions(kv: KVNamespace, eventId: string): Promise<SessionPlacement[]> {
  const listed = await kv.list({ prefix: `${SESSION_PREFIX}${eventId}:` });
  const out: SessionPlacement[] = [];
  for (const k of listed.keys) {
    const raw = await kv.get(k.name, "json");
    if (raw) out.push(raw as SessionPlacement);
  }
  return out.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}

export async function addSession(
  kv: KVNamespace,
  eventId: string,
  body: Pick<SessionPlacement, "title" | "room" | "startsAt" | "endsAt" | "capacity">
): Promise<PlacementAddResult<SessionPlacement>> {
  const title = normLabel(body.title);
  const existing = await listSessions(kv, eventId);
  if (existing.some((s) => normLabel(s.title) === title)) {
    return { ok: false, error: "duplicate_title" };
  }
  const row: SessionPlacement = {
    id: randomId(),
    eventId,
    title: body.title.trim().slice(0, 180),
    room: body.room.trim().slice(0, 120),
    startsAt: body.startsAt,
    endsAt: body.endsAt,
    capacity: Math.max(1, Math.floor(Number(body.capacity) || 1)),
    createdAt: nowIso(),
  };
  await kv.put(`${SESSION_PREFIX}${eventId}:${row.id}`, JSON.stringify(row));
  return { ok: true, item: row };
}

const DEFAULT_BRANDING: BrandingSettings = {
  siteTitle: "EventMark",
  logoUrl: null,
  primaryColor: "#ffffff",
  supportEmail: null,
  updatedAt: "",
  updatedBy: "",
};

export async function getBranding(kv: KVNamespace): Promise<BrandingSettings> {
  const raw = await kv.get(BRANDING_KEY, "json");
  if (!raw) return { ...DEFAULT_BRANDING };
  return { ...DEFAULT_BRANDING, ...(raw as BrandingSettings) };
}

export async function saveBranding(
  kv: KVNamespace,
  body: Partial<BrandingSettings>,
  actor: UserRecord
): Promise<BrandingSettings> {
  const cur = await getBranding(kv);
  const next: BrandingSettings = {
    ...cur,
    siteTitle: typeof body.siteTitle === "string" ? body.siteTitle.slice(0, 80) : cur.siteTitle,
    logoUrl: typeof body.logoUrl === "string" ? body.logoUrl.slice(0, 500) : cur.logoUrl,
    primaryColor:
      typeof body.primaryColor === "string" ? body.primaryColor.slice(0, 30) : cur.primaryColor,
    supportEmail:
      typeof body.supportEmail === "string" ? body.supportEmail.slice(0, 180) : cur.supportEmail,
    updatedAt: nowIso(),
    updatedBy: actor.email,
  };
  await kv.put(BRANDING_KEY, JSON.stringify(next));
  return next;
}

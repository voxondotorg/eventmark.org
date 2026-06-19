/**
 * EventMark — KV data layer and strict domain types.
 * Key prefixes enable prefix scans for pagination at scale.
 */

import type { CalendarRegion } from "./calendar-helpers.js";
import { locationMatchesRegion, monthYmPrefixesBetween } from "./calendar-helpers.js";

export type UserRole = "visitor" | "user" | "organizer" | "admin";

export type ContributionRole =
  | "participant"
  | "speaker"
  | "volunteer"
  | "topic_proposer";

export type ContributionStatus =
  | "PENDING_APPROVAL"
  | "APPROVED"
  | "REJECTED"
  | "INFO_REQUESTED";

export type VettingStatus = "PENDING" | "APPROVED" | "REJECTED";

/** Org-request lifecycle: PENDING → INFO_REQUESTED ⇄ PENDING → APPROVED|REJECTED. */
export type OrgRequestStatus = "PENDING" | "INFO_REQUESTED" | "REJECTED" | "APPROVED";

/** Where the event happens. `hybrid` means both in-person + online channels. */
export type EventMode = "in_person" | "online" | "hybrid";

/** Event category per EventMark spec: Open Source vs Fun Source distinction. */
export type EventCategory = "open_source" | "fun_source" | "hybrid";

/** Visitors/listings only see "published"; organizers can edit drafts privately. */
export type EventStatus = "draft" | "published";

export type RegistrationType = "native" | "external_interest";

export interface DirectorLink {
  name: string;
  url: string;
  verified?: boolean;
}

export interface SpeakerSummary {
  name: string;
  link: string;
  org: string;
  orgLink: string;
}

export interface EventRecord {
  id: string;
  title: string;
  description: string;
  location: string;
  startsAt: string;
  endsAt: string;
  organizationId: string;
  is_external: boolean;
  external_url: string | null;
  createdAt: string;
  updatedAt: string;
  agenda: AgendaSlot[];
  /** Visibility flag; absent on legacy records → treated as "published". */
  status?: EventStatus;
  /** Where the event happens. Absent → treated as "in_person". */
  mode?: EventMode;
  /** Stream / meeting URL for online + hybrid. Empty string when not applicable. */
  online_url?: string | null;
  /** Official event website for landing pages, sponsors, or additional details. */
  website_url?: string | null;
  /** Inclusive lower / upper attendee bound. 0 means "no minimum / no cap". */
  min_seats?: number;
  max_seats?: number;
  /** Confirmed speakers shown on the public page (separate from the contributor pipeline). */
  speakers?: SpeakerSummary[];
  /** Event category per EventMark spec. Absent on legacy records → treated as "hybrid". */
  category?: EventCategory;
  /** View counter for analytics. Absent → treated as 0. */
  viewCount?: number;
  /** Interest counter for analytics. Absent → treated as 0. */
  interestedCount?: number;
  /** Registration counter for analytics. Absent → treated as 0. */
  registeredCount?: number;
  /** Set when an event is published; locks draft edits even after unpublish. */
  publishedOnce?: boolean;
  /** True when a 300×300 banner image is stored for this event. */
  hasBanner?: boolean;
}

/** Draft events are editable; published events must be moved back to draft first. */
export function isEventEditable(ev: EventRecord): boolean {
  return (ev.status ?? "published") === "draft";
}

export interface AgendaSlot {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
  speakerUserId: string | null;
  speakerName: string | null;
  abstract: string | null;
}

export interface OrganizationRecord {
  id: string;
  name: string;
  slug: string;
  website: string;
  description: string;
  verified: boolean;
  vettingStatus: VettingStatus;
  createdAt: string;
  ownerUserId: string;
}

export interface UserRecord {
  id: string;
  email: string;
  name?: string;
  bio?: string;
  website?: string;
  verificationRequestStatus?: "none" | "pending" | "approved" | "rejected";
  verificationRequestedAt?: string;
  verified?: boolean;
  roles: UserRole[];
  organizationIds: string[];
  /** Orgs where user may run door check-in without full organizer access. */
  checkinOrganizationIds?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface RegistrationRecord {
  id: string;
  eventId: string;
  userId: string;
  type: RegistrationType;
  createdAt: string;
  /** Short alphanumeric ticket emailed to attendee; absent on legacy rows. */
  ticketCode?: string;
}

export interface InterestRecord {
  id: string;
  eventId: string;
  userId: string;
  createdAt: string;
}

export type RsvpStatus = "going" | "maybe" | "not_going";

export interface RsvpRecord {
  id: string;
  eventId: string;
  userId: string;
  status: RsvpStatus;
  createdAt: string;
  updatedAt: string;
}

export interface WaitlistRecord {
  id: string;
  eventId: string;
  userId: string;
  createdAt: string;
}

export interface ContributionRecord {
  id: string;
  eventId: string;
  userId: string;
  role: ContributionRole;
  status: ContributionStatus;
  organizerNote: string | null;
  createdAt: string;
  updatedAt: string;
  payload: ContributionPayload;
}

export type ContributionPayload =
  | ParticipantPayload
  | SpeakerPayload
  | VolunteerPayload
  | TopicProposerPayload;

export interface ParticipantPayload {
  kind: "participant";
  email: string;
  fullName: string;
}

export interface SpeakerPayload {
  kind: "speaker";
  email: string;
  fullName: string;
  topicTitle: string;
  abstract: string;
  preferredSlot: string;
  bio: string;
}

export interface VolunteerPayload {
  kind: "volunteer";
  email: string;
  fullName: string;
  skills: string;
  availability: string;
}

export interface TopicProposerPayload {
  kind: "topic_proposer";
  email: string;
  fullName: string;
  topicTitle: string;
  description: string;
  format: string;
}

export interface OtpRecord {
  code: string;
  email: string;
  expiresAt: number;
  attempts: number;
}

/** Single decision entry in an OrgRequest's audit trail. */
export interface OrgRequestDecision {
  ts: string;
  status: OrgRequestStatus;
  note: string;
  /** Admin user id; "system" for automatic transitions. */
  byUserId: string;
}

/** Detailed organization request submitted by a logged-in user for admin review. */
export interface OrgRequestRecord {
  id: string;
  userId: string;
  contactEmail: string;
  organizationName: string;
  website: string;
  description: string;
  /** Multi-select labels: serving_people, opensource, funsource, profitable, non_profitable. */
  activities: string[];
  directors: DirectorLink[];
  eventMode: EventMode;
  motto: string;
  voxonAffiliated: boolean;
  status: OrgRequestStatus;
  /** Note shown to applicant for the latest decision (usually for INFO_REQUESTED / REJECTED). */
  latestNote: string;
  history: OrgRequestDecision[];
  /** Set when status === "APPROVED"; points to created org. */
  organizationId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RateLimitBucket {
  count: number;
  windowStart: number;
}

export interface PaginatedListResult<T> {
  items: T[];
  cursor: string | null;
  hasMore: boolean;
}

const EVENT_PREFIX = "event:";
const EVENT_INDEX_PREFIX = "event_index:";
const USER_PREFIX = "user:";
const USER_EMAIL_INDEX = "user_email:";
const SESSION_PREFIX = "session:";
const OTP_PREFIX = "otp:";
const ORG_PREFIX = "org:";
const REG_PREFIX = "registration:";
const REG_INDEX_PREFIX = "registration_index:";
const REG_USER_PREFIX = "registration_user:";
const INTEREST_PREFIX = "interest:";
const INTEREST_INDEX_PREFIX = "interest_index:";
const INTEREST_USER_PREFIX = "interest_user:";
const RSVP_PREFIX = "rsvp:";
const RSVP_EVENT_PREFIX = "rsvp_event:";
const RSVP_USER_PREFIX = "rsvp_user:";
const WAITLIST_PREFIX = "waitlist:";
const WAITLIST_EVENT_PREFIX = "waitlist_event:";
const WAITLIST_USER_PREFIX = "waitlist_user:";
const CONTRIBUTION_PREFIX = "contribution:";
const CONTRIBUTION_EVENT_INDEX = "contributions_event:";
const CONTRIBUTION_USER_INDEX = "contribution_user:";
const ORG_REQ_PREFIX = "org_req:";
const ORG_REQ_PENDING_INDEX = "org_req_pending:";
const USER_VERIFICATION_PENDING_INDEX = "user_verification_pending:";
const ORG_REQ_USER_INDEX = "org_req_user:";
const TICKET_PREFIX = "ticket:";
const SETTINGS_KEY = "settings:global";
const RATE_PREFIX = "rate:";
const SEARCH_PREFIX = "search:";
const EVENT_SEAT_PREFIX = "event_seat:";
const EVENT_BANNER_PREFIX = "event_banner:";

export function eventBannerKey(id: string): string {
  return `${EVENT_BANNER_PREFIX}${id}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function randomId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function emailKey(email: string): string {
  return email.trim().toLowerCase();
}

export function eventIndexKey(startsAt: string, id: string): string {
  return `${EVENT_INDEX_PREFIX}${startsAt}:${id}`;
}

/** Normalize text into search tokens (lowercase, remove punctuation, min 3 chars). */
export function normalizeSearchTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3)
    .filter((v, i, a) => a.indexOf(v) === i);
}

/** Generate search index keys for an event. */
export function searchIndexKeys(
  event: EventRecord,
  orgName?: string
): string[] {
  const tokens = new Set<string>();
  normalizeSearchTokens(event.title).forEach((t) => tokens.add(t));
  normalizeSearchTokens(event.description).forEach((t) => tokens.add(t));
  if (orgName) normalizeSearchTokens(orgName).forEach((t) => tokens.add(t));
  return Array.from(tokens).map((t) => `${SEARCH_PREFIX}${t}:${event.id}`);
}

export async function getEvent(
  kv: KVNamespace,
  id: string
): Promise<EventRecord | null> {
  const raw = await kv.get(`${EVENT_PREFIX}${id}`, "json");
  if (raw === null) return null;
  return raw as EventRecord;
}

export async function incrementEventViewCount(
  kv: KVNamespace,
  id: string
): Promise<{ ok: true; viewCount: number } | { ok: false }> {
  const ev = await getEvent(kv, id);
  if (!ev) return { ok: false };
  const viewCount = (ev.viewCount ?? 0) + 1;
  const next: EventRecord = { ...ev, viewCount };
  await saveEvent(kv, next);
  return { ok: true, viewCount };
}

export async function saveEvent(
  kv: KVNamespace,
  event: EventRecord,
  previousStartsAt?: string,
  orgName?: string
): Promise<void> {
  if (previousStartsAt && previousStartsAt !== event.startsAt) {
    await kv.delete(eventIndexKey(previousStartsAt, event.id));
  }
  await kv.put(`${EVENT_PREFIX}${event.id}`, JSON.stringify(event));
  await kv.put(eventIndexKey(event.startsAt, event.id), JSON.stringify({ id: event.id }));
  // Update search index
  const searchKeys = searchIndexKeys(event, orgName);
  for (const key of searchKeys) {
    await kv.put(key, JSON.stringify({ eventId: event.id }));
  }
}

export async function deleteEvent(
  kv: KVNamespace,
  event: EventRecord,
  orgName?: string
): Promise<void> {
  for (const key of searchIndexKeys(event, orgName)) {
    const raw = await kv.get(key, "json");
    if (raw && typeof raw === "object" && (raw as { eventId?: string }).eventId === event.id) {
      await kv.delete(key);
    }
  }
  let seatCursor: string | undefined;
  do {
    const listed = await kv.list({
      prefix: `${EVENT_SEAT_PREFIX}${event.id}:`,
      cursor: seatCursor,
      limit: 200,
    });
    for (const k of listed.keys) {
      await kv.delete(k.name);
    }
    seatCursor = listed.list_complete ? undefined : listed.cursor;
  } while (seatCursor);

  await kv.delete(`${EVENT_PREFIX}${event.id}`);
  await kv.delete(eventIndexKey(event.startsAt, event.id));
  await kv.delete(eventBannerKey(event.id));
}

function eventSeatKey(eventId: string, slot: number): string {
  return `${EVENT_SEAT_PREFIX}${eventId}:${slot}`;
}

/** Reserve one seat slot under concurrency (best-effort without Durable Objects). */
export async function tryReserveEventSeat(
  kv: KVNamespace,
  eventId: string,
  userId: string,
  maxSeats: number
): Promise<{ ok: true } | { ok: false; reason: "event_full" }> {
  if (maxSeats <= 0) return { ok: true };

  for (let slot = 1; slot <= maxSeats; slot++) {
    const key = eventSeatKey(eventId, slot);
    const holder = await kv.get(key);
    if (holder && holder.startsWith(`${userId}:`)) return { ok: true };
  }

  for (let slot = 1; slot <= maxSeats; slot++) {
    const key = eventSeatKey(eventId, slot);
    if (await kv.get(key)) continue;
    const claimId = `${userId}:${randomId()}`;
    await kv.put(key, claimId);
    const winner = await kv.get(key);
    if (winner === claimId) return { ok: true };
  }

  return { ok: false, reason: "event_full" };
}

export async function releaseEventSeatsForUser(
  kv: KVNamespace,
  eventId: string,
  userId: string,
  maxSeats = 0
): Promise<void> {
  if (maxSeats > 0) {
    for (let slot = 1; slot <= maxSeats; slot++) {
      const key = eventSeatKey(eventId, slot);
      const holder = await kv.get(key);
      if (holder && holder.startsWith(`${userId}:`)) {
        await kv.delete(key);
      }
    }
    return;
  }
  let cursor: string | undefined;
  do {
    const listed = await kv.list({
      prefix: `${EVENT_SEAT_PREFIX}${eventId}:`,
      cursor,
      limit: 200,
    });
    for (const k of listed.keys) {
      const holder = await kv.get(k.name);
      if (holder && holder.startsWith(`${userId}:`)) {
        await kv.delete(k.name);
      }
    }
    cursor = listed.list_complete ? undefined : listed.cursor;
  } while (cursor);
}

export async function getEventBannerMeta(
  kv: KVNamespace,
  id: string
): Promise<{ data: ArrayBuffer; contentType: string } | null> {
  const key = eventBannerKey(id);
  const meta = await kv.getWithMetadata<{ contentType?: string }>(key, "arrayBuffer");
  if (!meta.value) return null;
  return {
    data: meta.value,
    contentType: meta.metadata?.contentType || "image/webp",
  };
}

export async function saveEventBanner(
  kv: KVNamespace,
  id: string,
  data: ArrayBuffer,
  contentType: string
): Promise<void> {
  await kv.put(eventBannerKey(id), data, {
    metadata: { contentType, size: data.byteLength },
  });
}

export async function deleteEventBanner(kv: KVNamespace, id: string): Promise<void> {
  await kv.delete(eventBannerKey(id));
}

export async function listEventsForCalendar(
  kv: KVNamespace,
  fromIso: string,
  toIso: string,
  region: CalendarRegion
): Promise<EventRecord[]> {
  const prefixes = monthYmPrefixesBetween(fromIso, toIso);
  const byId = new Map<string, EventRecord>();
  for (const ym of prefixes) {
    const listed = await kv.list({ prefix: `${EVENT_INDEX_PREFIX}${ym}` });
    for (const k of listed.keys) {
      const id = k.name.split(":").pop();
      if (!id) continue;
      const ev = await getEvent(kv, id);
      if (!ev) continue;
      if (ev.startsAt < fromIso || ev.startsAt > toIso) continue;
      if (!locationMatchesRegion(ev.location, region)) continue;
      byId.set(ev.id, ev);
    }
  }
  return [...byId.values()].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}

/** Filters for listEvents. All fields optional - missing = no filter. */
export interface EventFilters {
  category?: EventCategory;
  mode?: EventMode;
  fromDate?: string; // ISO date
  toDate?: string; // ISO date
}

export async function listEvents(
  kv: KVNamespace,
  limit: number,
  cursor: string | null,
  includeDrafts = false,
  filters?: EventFilters
): Promise<PaginatedListResult<EventRecord>> {
  const listed = await kv.list({
    prefix: EVENT_INDEX_PREFIX,
    limit,
    cursor: cursor ?? undefined,
  });
  const events: EventRecord[] = [];
  for (const k of listed.keys) {
    const parts = k.name.slice(EVENT_INDEX_PREFIX.length).split(":");
    const id = parts[parts.length - 1];
    if (!id) continue;
    const ev = await getEvent(kv, id);
    if (!ev) continue;
    if (!includeDrafts && (ev.status ?? "published") !== "published") continue;
    // Apply filters
    if (filters) {
      if (filters.category && ev.category !== filters.category) continue;
      if (filters.mode && ev.mode !== filters.mode) continue;
      if (filters.fromDate && ev.startsAt < filters.fromDate) continue;
      if (filters.toDate && ev.endsAt > filters.toDate) continue;
    }
    events.push(ev);
  }
  events.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  return {
    items: events,
    cursor: listed.list_complete ? null : listed.cursor ?? null,
    hasMore: !listed.list_complete,
  };
}

function eventMatchesSearchQuery(ev: EventRecord, query: string): boolean {
  const q = query.toLowerCase();
  const hay = `${ev.title} ${ev.description} ${ev.location}`.toLowerCase();
  return hay.includes(q);
}

export async function searchEvents(
  kv: KVNamespace,
  query: string,
  limit: number
): Promise<PaginatedListResult<EventRecord>> {
  const trimmed = query.trim();
  if (trimmed.length < 2) {
    return { items: [], cursor: null, hasMore: false };
  }

  const tokens = normalizeSearchTokens(trimmed);
  let candidateIds: Set<string> | null = null;

  for (const token of tokens) {
    const listed = await kv.list({ prefix: `${SEARCH_PREFIX}${token}:` });
    const tokenIds = new Set<string>();
    for (const k of listed.keys) {
      const suffix = k.name.slice(SEARCH_PREFIX.length);
      const colon = suffix.indexOf(":");
      if (colon >= 0) tokenIds.add(suffix.slice(colon + 1));
    }
    if (candidateIds === null) {
      candidateIds = tokenIds;
    } else {
      const merged = new Set<string>();
      for (const id of candidateIds) {
        if (tokenIds.has(id)) merged.add(id);
      }
      candidateIds = merged;
    }
  }

  let events: EventRecord[] = [];
  if (candidateIds && candidateIds.size > 0) {
    for (const id of candidateIds) {
      const ev = await getEvent(kv, id);
      if (ev && (ev.status ?? "published") === "published") events.push(ev);
    }
  } else {
    const page = await listEvents(kv, 500, null);
    events = page.items.filter((ev) => eventMatchesSearchQuery(ev, trimmed));
  }

  events.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  return {
    items: events.slice(0, limit),
    cursor: null,
    hasMore: events.length > limit,
  };
}

export async function countEvents(kv: KVNamespace): Promise<number> {
  return countKvPrefix(kv, EVENT_PREFIX);
}

export async function countUsers(kv: KVNamespace): Promise<number> {
  return countKvPrefix(kv, USER_PREFIX);
}

export async function countOrganizations(kv: KVNamespace): Promise<number> {
  return countKvPrefix(kv, ORG_PREFIX);
}

async function countKvPrefix(kv: KVNamespace, prefix: string): Promise<number> {
  let total = 0;
  let cursor: string | undefined;
  do {
    const listed = await kv.list({
      prefix,
      cursor,
      limit: 1000,
    });
    total += listed.keys.length;
    cursor = listed.list_complete ? undefined : listed.cursor;
  } while (cursor);
  return total;
}

export async function getUserById(
  kv: KVNamespace,
  id: string
): Promise<UserRecord | null> {
  const raw = await kv.get(`${USER_PREFIX}${id}`, "json");
  if (raw === null) return null;
  return raw as UserRecord;
}

export async function getUserByEmail(
  kv: KVNamespace,
  email: string
): Promise<UserRecord | null> {
  const mapped = await kv.get(`${USER_EMAIL_INDEX}${emailKey(email)}`);
  if (!mapped) return null;
  return getUserById(kv, mapped);
}

export async function saveUser(kv: KVNamespace, user: UserRecord): Promise<void> {
  await kv.put(`${USER_PREFIX}${user.id}`, JSON.stringify(user));
  await kv.put(`${USER_EMAIL_INDEX}${emailKey(user.email)}`, user.id);
  if (user.verificationRequestStatus === "pending") {
    await kv.put(`${USER_VERIFICATION_PENDING_INDEX}${user.id}`, "1");
  } else {
    await kv.delete(`${USER_VERIFICATION_PENDING_INDEX}${user.id}`);
  }
}

export async function countPendingVerificationRequests(kv: KVNamespace): Promise<number> {
  const listed = await kv.list({ prefix: USER_VERIFICATION_PENDING_INDEX });
  return listed.keys.length;
}

export async function getOrg(
  kv: KVNamespace,
  id: string
): Promise<OrganizationRecord | null> {
  const raw = await kv.get(`${ORG_PREFIX}${id}`, "json");
  if (raw === null) return null;
  return raw as OrganizationRecord;
}

export async function saveOrg(kv: KVNamespace, org: OrganizationRecord): Promise<void> {
  await kv.put(`${ORG_PREFIX}${org.id}`, JSON.stringify(org));
}

export async function listOrgsForUser(
  kv: KVNamespace,
  userId: string
): Promise<OrganizationRecord[]> {
  const user = await getUserById(kv, userId);
  if (!user) return [];
  const out: OrganizationRecord[] = [];
  for (const oid of user.organizationIds) {
    const o = await getOrg(kv, oid);
    if (o) out.push(o);
  }
  return out;
}

export interface SessionData {
  userId: string;
  createdAt: number;
  expiresAt: number;
}

export async function putSession(
  kv: KVNamespace,
  token: string,
  data: SessionData,
  ttlSeconds: number
): Promise<void> {
  await kv.put(`${SESSION_PREFIX}${token}`, JSON.stringify(data), {
    expirationTtl: ttlSeconds,
  });
}

export async function getSession(
  kv: KVNamespace,
  token: string
): Promise<SessionData | null> {
  const raw = await kv.get(`${SESSION_PREFIX}${token}`, "json");
  if (raw === null) return null;
  return raw as SessionData;
}

export async function deleteSession(kv: KVNamespace, token: string): Promise<void> {
  await kv.delete(`${SESSION_PREFIX}${token}`);
}

export async function storeOtp(
  kv: KVNamespace,
  email: string,
  record: OtpRecord,
  ttlSeconds: number
): Promise<void> {
  await kv.put(`${OTP_PREFIX}${emailKey(email)}`, JSON.stringify(record), {
    expirationTtl: ttlSeconds,
  });
}

export async function getOtp(
  kv: KVNamespace,
  email: string
): Promise<OtpRecord | null> {
  const raw = await kv.get(`${OTP_PREFIX}${emailKey(email)}`, "json");
  if (raw === null) return null;
  return raw as OtpRecord;
}

export async function deleteOtp(kv: KVNamespace, email: string): Promise<void> {
  await kv.delete(`${OTP_PREFIX}${emailKey(email)}`);
}

export function registrationKey(eventId: string, userId: string): string {
  return `${REG_PREFIX}${eventId}:${userId}`;
}

export function registrationIndexKey(eventId: string, userId: string): string {
  return `${REG_INDEX_PREFIX}${eventId}:${userId}`;
}

export function registrationUserKey(userId: string, eventId: string): string {
  return `${REG_USER_PREFIX}${userId}:${eventId}`;
}

export async function saveRegistration(
  kv: KVNamespace,
  reg: RegistrationRecord
): Promise<void> {
  await kv.put(registrationKey(reg.eventId, reg.userId), JSON.stringify(reg));
  await kv.put(registrationIndexKey(reg.eventId, reg.userId), reg.id);
  await kv.put(registrationUserKey(reg.userId, reg.eventId), reg.id);
}

export async function getRegistration(
  kv: KVNamespace,
  eventId: string,
  userId: string
): Promise<RegistrationRecord | null> {
  const raw = await kv.get(registrationKey(eventId, userId), "json");
  if (raw === null) return null;
  return raw as RegistrationRecord;
}

export async function listRegistrationsForUser(
  kv: KVNamespace,
  userId: string
): Promise<RegistrationRecord[]> {
  const listed = await kv.list({ prefix: `${REG_USER_PREFIX}${userId}:` });
  const out: RegistrationRecord[] = [];
  for (const k of listed.keys) {
    const eventId = k.name.slice(`${REG_USER_PREFIX}${userId}:`.length);
    if (!eventId) continue;
    const r = await getRegistration(kv, eventId, userId);
    if (r) out.push(r);
  }
  return out;
}

export async function listRegistrationsForEvent(
  kv: KVNamespace,
  eventId: string
): Promise<RegistrationRecord[]> {
  const listed = await kv.list({ prefix: `${REG_INDEX_PREFIX}${eventId}:` });
  const out: RegistrationRecord[] = [];
  for (const k of listed.keys) {
    const userId = k.name.split(":").pop();
    if (!userId) continue;
    const r = await getRegistration(kv, eventId, userId);
    if (r) out.push(r);
  }
  return out;
}

export async function deleteRegistration(
  kv: KVNamespace,
  eventId: string,
  userId: string
): Promise<void> {
  await releaseEventSeatsForUser(kv, eventId, userId);
  await kv.delete(registrationKey(eventId, userId));
  await kv.delete(registrationIndexKey(eventId, userId));
  await kv.delete(registrationUserKey(userId, eventId));
}

export function interestKey(eventId: string, userId: string): string {
  return `${INTEREST_PREFIX}${eventId}:${userId}`;
}

export function interestIndexKey(eventId: string, userId: string): string {
  return `${INTEREST_INDEX_PREFIX}${eventId}:${userId}`;
}

export async function saveInterest(kv: KVNamespace, rec: InterestRecord): Promise<void> {
  await kv.put(interestKey(rec.eventId, rec.userId), JSON.stringify(rec));
  await kv.put(interestIndexKey(rec.eventId, rec.userId), rec.id);
  await kv.put(`${INTEREST_USER_PREFIX}${rec.userId}:${rec.eventId}`, rec.id);
}

export async function deleteInterest(
  kv: KVNamespace,
  eventId: string,
  userId: string
): Promise<void> {
  await kv.delete(interestKey(eventId, userId));
  await kv.delete(interestIndexKey(eventId, userId));
  await kv.delete(`${INTEREST_USER_PREFIX}${userId}:${eventId}`);
}

export async function getInterest(
  kv: KVNamespace,
  eventId: string,
  userId: string
): Promise<InterestRecord | null> {
  const raw = await kv.get(interestKey(eventId, userId), "json");
  if (raw === null) return null;
  return raw as InterestRecord;
}

export async function listInterestsForUser(
  kv: KVNamespace,
  userId: string
): Promise<InterestRecord[]> {
  const listed = await kv.list({ prefix: `${INTEREST_USER_PREFIX}${userId}:` });
  const out: InterestRecord[] = [];
  for (const k of listed.keys) {
    const eventId = k.name.slice(`${INTEREST_USER_PREFIX}${userId}:`.length);
    if (!eventId) continue;
    const rec = await getInterest(kv, eventId, userId);
    if (rec) out.push(rec);
  }
  return out;
}

export function rsvpKey(eventId: string, userId: string): string {
  return `${RSVP_PREFIX}${eventId}:${userId}`;
}

export function rsvpEventIndexKey(eventId: string, userId: string): string {
  return `${RSVP_EVENT_PREFIX}${eventId}:${userId}`;
}

export function rsvpUserIndexKey(userId: string, eventId: string): string {
  return `${RSVP_USER_PREFIX}${userId}:${eventId}`;
}

export async function saveRsvp(kv: KVNamespace, rec: RsvpRecord): Promise<void> {
  await kv.put(rsvpKey(rec.eventId, rec.userId), JSON.stringify(rec));
  await kv.put(rsvpEventIndexKey(rec.eventId, rec.userId), rec.id);
  await kv.put(rsvpUserIndexKey(rec.userId, rec.eventId), rec.id);
}

export async function getRsvp(
  kv: KVNamespace,
  eventId: string,
  userId: string
): Promise<RsvpRecord | null> {
  const raw = await kv.get(rsvpKey(eventId, userId), "json");
  if (!raw) return null;
  return raw as RsvpRecord;
}

export async function listRsvpsForEvent(
  kv: KVNamespace,
  eventId: string
): Promise<RsvpRecord[]> {
  const listed = await kv.list({ prefix: `${RSVP_EVENT_PREFIX}${eventId}:` });
  const out: RsvpRecord[] = [];
  for (const k of listed.keys) {
    const userId = k.name.split(":").pop();
    if (!userId) continue;
    const rec = await getRsvp(kv, eventId, userId);
    if (rec) out.push(rec);
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function listRsvpsForUser(
  kv: KVNamespace,
  userId: string
): Promise<RsvpRecord[]> {
  const listed = await kv.list({ prefix: `${RSVP_USER_PREFIX}${userId}:` });
  const out: RsvpRecord[] = [];
  for (const k of listed.keys) {
    const eventId = k.name.slice(`${RSVP_USER_PREFIX}${userId}:`.length);
    if (!eventId) continue;
    const rec = await getRsvp(kv, eventId, userId);
    if (rec) out.push(rec);
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function waitlistKey(eventId: string, userId: string): string {
  return `${WAITLIST_PREFIX}${eventId}:${userId}`;
}

export function waitlistEventIndexKey(eventId: string, createdAt: string, userId: string): string {
  return `${WAITLIST_EVENT_PREFIX}${eventId}:${createdAt}:${userId}`;
}

export function waitlistUserIndexKey(userId: string, eventId: string): string {
  return `${WAITLIST_USER_PREFIX}${userId}:${eventId}`;
}

export async function saveWaitlist(kv: KVNamespace, rec: WaitlistRecord): Promise<void> {
  await kv.put(waitlistKey(rec.eventId, rec.userId), JSON.stringify(rec));
  await kv.put(waitlistEventIndexKey(rec.eventId, rec.createdAt, rec.userId), rec.id);
  await kv.put(waitlistUserIndexKey(rec.userId, rec.eventId), rec.id);
}

export async function getWaitlist(
  kv: KVNamespace,
  eventId: string,
  userId: string
): Promise<WaitlistRecord | null> {
  const raw = await kv.get(waitlistKey(eventId, userId), "json");
  if (!raw) return null;
  return raw as WaitlistRecord;
}

export async function deleteWaitlist(
  kv: KVNamespace,
  eventId: string,
  userId: string,
  createdAt?: string
): Promise<void> {
  const existing = createdAt ? null : await getWaitlist(kv, eventId, userId);
  const ts = createdAt || existing?.createdAt || "";
  await kv.delete(waitlistKey(eventId, userId));
  await kv.delete(waitlistUserIndexKey(userId, eventId));
  if (ts) {
    await kv.delete(waitlistEventIndexKey(eventId, ts, userId));
  }
}

export async function listWaitlistForEvent(
  kv: KVNamespace,
  eventId: string
): Promise<WaitlistRecord[]> {
  const listed = await kv.list({ prefix: `${WAITLIST_EVENT_PREFIX}${eventId}:` });
  const out: WaitlistRecord[] = [];
  for (const k of listed.keys) {
    const rest = k.name.slice(`${WAITLIST_EVENT_PREFIX}${eventId}:`.length);
    const idx = rest.lastIndexOf(":");
    if (idx < 0) continue;
    const userId = rest.slice(idx + 1);
    if (!userId) continue;
    const rec = await getWaitlist(kv, eventId, userId);
    if (rec) out.push(rec);
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function listWaitlistForUser(
  kv: KVNamespace,
  userId: string
): Promise<WaitlistRecord[]> {
  const listed = await kv.list({ prefix: `${WAITLIST_USER_PREFIX}${userId}:` });
  const out: WaitlistRecord[] = [];
  for (const k of listed.keys) {
    const eventId = k.name.slice(`${WAITLIST_USER_PREFIX}${userId}:`.length);
    if (!eventId) continue;
    const rec = await getWaitlist(kv, eventId, userId);
    if (rec) out.push(rec);
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function contributionKey(id: string): string {
  return `${CONTRIBUTION_PREFIX}${id}`;
}

export function contributionEventIndexKey(eventId: string, contributionId: string): string {
  return `${CONTRIBUTION_EVENT_INDEX}${eventId}:${contributionId}`;
}

export async function submitContribution(
  kv: KVNamespace,
  input: Omit<ContributionRecord, "id" | "createdAt" | "updatedAt" | "status" | "organizerNote">
): Promise<ContributionRecord> {
  const id = randomId();
  const ts = nowIso();
  // Auto-approve participants; all other roles require organizer approval
  const status: ContributionStatus = input.role === "participant" ? "APPROVED" : "PENDING_APPROVAL";
  const rec: ContributionRecord = {
    ...input,
    id,
    status,
    organizerNote: null,
    createdAt: ts,
    updatedAt: ts,
  };
  await kv.put(contributionKey(id), JSON.stringify(rec));
  await kv.put(contributionEventIndexKey(input.eventId, id), id);
  await kv.put(`${CONTRIBUTION_USER_INDEX}${input.userId}:${id}`, id);
  return rec;
}

export async function getContribution(
  kv: KVNamespace,
  id: string
): Promise<ContributionRecord | null> {
  const raw = await kv.get(contributionKey(id), "json");
  if (raw === null) return null;
  return raw as ContributionRecord;
}

export async function listContributionsForUser(
  kv: KVNamespace,
  userId: string
): Promise<ContributionRecord[]> {
  const listed = await kv.list({ prefix: `${CONTRIBUTION_USER_INDEX}${userId}:` });
  const out: ContributionRecord[] = [];
  for (const k of listed.keys) {
    const cid = k.name.split(":").pop();
    if (!cid) continue;
    const c = await getContribution(kv, cid);
    if (c) out.push(c);
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function listContributionsForEvent(
  kv: KVNamespace,
  eventId: string
): Promise<ContributionRecord[]> {
  const prefix = `${CONTRIBUTION_EVENT_INDEX}${eventId}:`;
  const listed = await kv.list({ prefix });
  const out: ContributionRecord[] = [];
  for (const k of listed.keys) {
    const cid = k.name.split(":").pop();
    if (!cid) continue;
    const c = await getContribution(kv, cid);
    if (c) out.push(c);
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

// Diagnostic function to check contribution indexes
export async function diagnoseContributionsForEvent(
  kv: KVNamespace,
  eventId: string
): Promise<{ 
  prefix: string; 
  indexKeysFound: number; 
  indexKeyNames: string[]; 
  contributionsLoaded: number;
  contributionsWithWrongEventId: { id: string; actualEventId: string }[];
}> {
  const prefix = `${CONTRIBUTION_EVENT_INDEX}${eventId}:`;
  const listed = await kv.list({ prefix });
  const indexKeyNames = listed.keys.map(k => k.name);
  const contributionsWithWrongEventId: { id: string; actualEventId: string }[] = [];
  let contributionsLoaded = 0;
  
  for (const k of listed.keys) {
    const cid = k.name.split(":").pop();
    if (!cid) continue;
    const c = await getContribution(kv, cid);
    if (c) {
      contributionsLoaded++;
      if (c.eventId !== eventId) {
        contributionsWithWrongEventId.push({ id: c.id, actualEventId: c.eventId });
      }
    }
  }
  
  return {
    prefix,
    indexKeysFound: listed.keys.length,
    indexKeyNames,
    contributionsLoaded,
    contributionsWithWrongEventId
  };
}

export async function updateContribution(
  kv: KVNamespace,
  rec: ContributionRecord
): Promise<void> {
  rec.updatedAt = nowIso();
  await kv.put(contributionKey(rec.id), JSON.stringify(rec));
}

export async function reviewContribution(
  kv: KVNamespace,
  id: string,
  patch: {
    status: ContributionStatus;
    organizerNote: string | null;
    approvedSpeakerSlot?: AgendaSlot;
  }
): Promise<ContributionRecord | null> {
  const existing = await getContribution(kv, id);
  if (!existing) return null;
  existing.status = patch.status;
  existing.organizerNote = patch.organizerNote;
  if (
    patch.approvedSpeakerSlot &&
    existing.role === "speaker" &&
    patch.status === "APPROVED"
  ) {
    const ev = await getEvent(kv, existing.eventId);
    if (ev) {
      const agenda = [...ev.agenda, patch.approvedSpeakerSlot];
      ev.agenda = agenda;
      ev.updatedAt = nowIso();
      await saveEvent(kv, ev);
    }
  }
  await updateContribution(kv, existing);
  return existing;
}

/* --- OrgRequest --- */

export async function saveOrgRequest(
  kv: KVNamespace,
  req: OrgRequestRecord
): Promise<void> {
  await kv.put(`${ORG_REQ_PREFIX}${req.id}`, JSON.stringify(req));
  await kv.put(`${ORG_REQ_USER_INDEX}${req.userId}:${req.id}`, req.id);
  if (req.status === "PENDING" || req.status === "INFO_REQUESTED") {
    await kv.put(`${ORG_REQ_PENDING_INDEX}${req.id}`, "1");
  } else {
    await kv.delete(`${ORG_REQ_PENDING_INDEX}${req.id}`);
  }
}

export async function getOrgRequest(
  kv: KVNamespace,
  id: string
): Promise<OrgRequestRecord | null> {
  const raw = await kv.get(`${ORG_REQ_PREFIX}${id}`, "json");
  return raw ? (raw as OrgRequestRecord) : null;
}

export async function listPendingOrgRequests(
  kv: KVNamespace
): Promise<OrgRequestRecord[]> {
  const listed = await kv.list({ prefix: ORG_REQ_PENDING_INDEX });
  const out: OrgRequestRecord[] = [];
  for (const k of listed.keys) {
    const id = k.name.slice(ORG_REQ_PENDING_INDEX.length);
    const r = await getOrgRequest(kv, id);
    if (r) out.push(r);
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getLatestOrgRequestForUser(
  kv: KVNamespace,
  userId: string
): Promise<OrgRequestRecord | null> {
  const listed = await kv.list({ prefix: `${ORG_REQ_USER_INDEX}${userId}:` });
  let best: OrgRequestRecord | null = null;
  for (const k of listed.keys) {
    const id = k.name.split(":").pop();
    if (!id) continue;
    const r = await getOrgRequest(kv, id);
    if (!r) continue;
    if (!best || r.createdAt > best.createdAt) best = r;
  }
  return best;
}

/* --- Settings (per-environment, KV-backed; one row per deployed worker) --- */

export interface SocialLinksRecord {
  x: string;
  discord: string;
  telegram: string;
  linkedin: string;
  facebook: string;
}

const SOCIAL_LINK_KEYS = ["x", "discord", "telegram", "linkedin", "facebook"] as const;

/** Trim and keep only http(s) social profile URLs for site footer / admin settings. */
export function normalizeSocialLinks(
  links: Partial<SocialLinksRecord> | null | undefined
): SocialLinksRecord {
  const src = links && typeof links === "object" ? links : {};
  const out = {} as SocialLinksRecord;
  for (const key of SOCIAL_LINK_KEYS) {
    const raw = String(src[key] ?? "").trim().slice(0, 500);
    if (!raw) {
      out[key] = "";
      continue;
    }
    try {
      const u = new URL(raw);
      out[key] = u.protocol === "http:" || u.protocol === "https:" ? raw : "";
    } catch {
      out[key] = "";
    }
  }
  return out;
}

export interface SettingsRecord {
  /** Comma-separated bootstrap admin emails. Overrides the wrangler `ADMIN_EMAILS` var when set. */
  adminEmails: string;
  /** Short notice shown across the site (empty = hidden). */
  noticeBanner: string;
  /** When true, new org-request submissions are rejected at the API. */
  pauseOrgRequests: boolean;
  /** When true, new native registrations are rejected at the API. */
  pauseRegistrations: boolean;
  /** Official social profile links shown in the site footer. */
  socialLinks: SocialLinksRecord;
  updatedAt: string;
  updatedBy: string;
}

export const DEFAULT_SETTINGS: SettingsRecord = {
  adminEmails: "",
  noticeBanner: "",
  pauseOrgRequests: false,
  pauseRegistrations: false,
  socialLinks: normalizeSocialLinks({}),
  updatedAt: "",
  updatedBy: "",
};

export async function getSettings(kv: KVNamespace): Promise<SettingsRecord> {
  const raw = await kv.get(SETTINGS_KEY, "json");
  if (!raw) return DEFAULT_SETTINGS;
  const partial = raw as Partial<SettingsRecord>;
  return {
    ...DEFAULT_SETTINGS,
    ...partial,
    socialLinks: normalizeSocialLinks({
      ...DEFAULT_SETTINGS.socialLinks,
      ...partial.socialLinks,
    }),
  };
}

export async function saveSettings(
  kv: KVNamespace,
  next: SettingsRecord
): Promise<void> {
  await kv.put(
    SETTINGS_KEY,
    JSON.stringify({
      ...next,
      socialLinks: normalizeSocialLinks(next.socialLinks),
    })
  );
}

/* --- Tickets --- */

export interface TicketIndexEntry {
  eventId: string;
  userId: string;
  registrationId: string;
}

export async function deleteTicket(kv: KVNamespace, code: string): Promise<void> {
  await kv.delete(`${TICKET_PREFIX}${code}`);
}

export async function saveTicket(
  kv: KVNamespace,
  code: string,
  entry: TicketIndexEntry
): Promise<void> {
  await kv.put(`${TICKET_PREFIX}${code}`, JSON.stringify(entry));
}

export async function getTicket(
  kv: KVNamespace,
  code: string
): Promise<TicketIndexEntry | null> {
  const raw = await kv.get(`${TICKET_PREFIX}${code}`, "json");
  return raw ? (raw as TicketIndexEntry) : null;
}

/* --- Rate limits (existing) --- */

export async function getRateLimit(
  kv: KVNamespace,
  key: string
): Promise<RateLimitBucket | null> {
  const raw = await kv.get(`${RATE_PREFIX}${key}`, "json");
  if (raw === null) return null;
  return raw as RateLimitBucket;
}

export async function setRateLimit(
  kv: KVNamespace,
  key: string,
  bucket: RateLimitBucket,
  ttlSeconds: number
): Promise<void> {
  await kv.put(`${RATE_PREFIX}${key}`, JSON.stringify(bucket), {
    expirationTtl: ttlSeconds,
  });
}

/**
 * Door check-in staff: org-scoped attendance role (no full organizer access).
 */

import type { EventRecord, UserRecord } from "./db.js";
import { emailKey, getUserByEmail, getUserById, saveUser } from "./db.js";

export interface OrgCheckinStaffRecord {
  id: string;
  organizationId: string;
  email: string;
  userId: string | null;
  addedByUserId: string;
  createdAt: string;
  updatedAt: string;
}

const STAFF_PREFIX = "checkin_staff:";
const STAFF_ORG_INDEX = "checkin_staff_org:";
const STAFF_EMAIL_INDEX = "checkin_staff_by_email:";

function staffKey(id: string): string {
  return `${STAFF_PREFIX}${id}`;
}

function staffOrgIndexKey(orgId: string, staffId: string): string {
  return `${STAFF_ORG_INDEX}${orgId}:${staffId}`;
}

function staffEmailIndexKey(orgId: string, email: string): string {
  return `${STAFF_EMAIL_INDEX}${emailKey(email)}:${orgId}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

export function userHasOrgOrganizerAccess(user: UserRecord, orgId: string): boolean {
  if (user.roles.includes("admin")) return true;
  return (user.organizationIds || []).includes(orgId);
}

export function userHasEventCheckinAccess(user: UserRecord, event: EventRecord): boolean {
  if (user.roles.includes("admin")) return true;
  if ((user.organizationIds || []).includes(event.organizationId)) return true;
  return (user.checkinOrganizationIds || []).includes(event.organizationId);
}

export function userIsCheckinStaffOnly(user: UserRecord): boolean {
  const checkin = user.checkinOrganizationIds || [];
  if (checkin.length === 0) return false;
  if (user.roles.includes("admin")) return false;
  const orgIds = user.organizationIds || [];
  return orgIds.length === 0;
}

function normalizeStaffEmail(email: string): string {
  return email.trim().toLowerCase();
}

async function attachStaffToUser(
  kv: KVNamespace,
  staff: OrgCheckinStaffRecord
): Promise<OrgCheckinStaffRecord> {
  const user = await getUserByEmail(kv, staff.email);
  if (!user) return staff;
  const checkinIds = new Set(user.checkinOrganizationIds || []);
  checkinIds.add(staff.organizationId);
  const nextUser: UserRecord = {
    ...user,
    checkinOrganizationIds: Array.from(checkinIds),
    updatedAt: nowIso(),
  };
  await saveUser(kv, nextUser);
  if (staff.userId === user.id) return staff;
  const linked = { ...staff, userId: user.id, updatedAt: nowIso() };
  await kv.put(staffKey(staff.id), JSON.stringify(linked));
  return linked;
}

async function detachStaffFromUser(kv: KVNamespace, staff: OrgCheckinStaffRecord): Promise<void> {
  if (!staff.userId) {
    const user = await getUserByEmail(kv, staff.email);
    if (user) await removeOrgFromUserCheckinAccess(kv, user.id, staff.organizationId);
    return;
  }
  await removeOrgFromUserCheckinAccess(kv, staff.userId, staff.organizationId);
}

async function removeOrgFromUserCheckinAccess(
  kv: KVNamespace,
  userId: string,
  orgId: string
): Promise<void> {
  const user = await getUserById(kv, userId);
  if (!user) return;
  const remaining = (user.checkinOrganizationIds || []).filter((id) => id !== orgId);
  if (remaining.length === (user.checkinOrganizationIds || []).length) return;
  await saveUser(kv, {
    ...user,
    checkinOrganizationIds: remaining,
    updatedAt: nowIso(),
  });
}

export async function listOrgCheckinStaff(
  kv: KVNamespace,
  orgId: string
): Promise<OrgCheckinStaffRecord[]> {
  const listed = await kv.list({ prefix: `${STAFF_ORG_INDEX}${orgId}:` });
  const out: OrgCheckinStaffRecord[] = [];
  for (const key of listed.keys) {
    const id = key.name.slice(`${STAFF_ORG_INDEX}${orgId}:`.length);
    const raw = await kv.get(staffKey(id), "json");
    if (raw) out.push(raw as OrgCheckinStaffRecord);
  }
  out.sort((a, b) => a.email.localeCompare(b.email));
  return out;
}

export async function addOrgCheckinStaff(
  kv: KVNamespace,
  orgId: string,
  email: string,
  addedByUserId: string
): Promise<
  | { ok: true; staff: OrgCheckinStaffRecord }
  | { ok: false; error: string }
> {
  const normalized = normalizeStaffEmail(email);
  if (!normalized || !normalized.includes("@")) {
    return { ok: false, error: "invalid_email" };
  }
  const existingKey = staffEmailIndexKey(orgId, normalized);
  const existingId = await kv.get(existingKey);
  if (existingId) {
    return { ok: false, error: "already_assigned" };
  }
  const id = crypto.randomUUID();
  const ts = nowIso();
  let staff: OrgCheckinStaffRecord = {
    id,
    organizationId: orgId,
    email: normalized,
    userId: null,
    addedByUserId,
    createdAt: ts,
    updatedAt: ts,
  };
  await kv.put(staffKey(id), JSON.stringify(staff));
  await kv.put(staffOrgIndexKey(orgId, id), "1");
  await kv.put(existingKey, id);
  staff = await attachStaffToUser(kv, staff);
  return { ok: true, staff };
}

export async function removeOrgCheckinStaff(
  kv: KVNamespace,
  orgId: string,
  staffId: string
): Promise<boolean> {
  const raw = await kv.get(staffKey(staffId), "json");
  if (!raw) return false;
  const staff = raw as OrgCheckinStaffRecord;
  if (staff.organizationId !== orgId) return false;
  await detachStaffFromUser(kv, staff);
  await kv.delete(staffKey(staffId));
  await kv.delete(staffOrgIndexKey(orgId, staffId));
  await kv.delete(staffEmailIndexKey(orgId, staff.email));
  return true;
}

/** Link pending staff rows and refresh check-in org ids when a user signs in. */
export async function syncCheckinStaffForUser(
  kv: KVNamespace,
  user: UserRecord
): Promise<UserRecord> {
  const listed = await kv.list({ prefix: `${STAFF_EMAIL_INDEX}${emailKey(user.email)}:` });
  const orgIds = new Set(user.checkinOrganizationIds || []);
  let changed = false;
  for (const key of listed.keys) {
    const orgId = key.name.slice(`${STAFF_EMAIL_INDEX}${emailKey(user.email)}:`.length);
    const staffId = await kv.get(key.name);
    if (!staffId) continue;
    const raw = await kv.get(staffKey(staffId), "json");
    if (!raw) continue;
    const staff = raw as OrgCheckinStaffRecord;
    orgIds.add(orgId);
    if (staff.userId !== user.id) {
      const linked = { ...staff, userId: user.id, updatedAt: nowIso() };
      await kv.put(staffKey(staffId), JSON.stringify(linked));
      changed = true;
    }
  }
  const merged = Array.from(orgIds);
  const prev = user.checkinOrganizationIds || [];
  if (
    merged.length !== prev.length ||
    merged.some((id) => prev.indexOf(id) === -1)
  ) {
    changed = true;
  }
  if (!changed) return user;
  const next: UserRecord = {
    ...user,
    checkinOrganizationIds: merged,
    updatedAt: nowIso(),
  };
  await saveUser(kv, next);
  return next;
}

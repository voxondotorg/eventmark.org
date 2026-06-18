/**
 * Detailed organization application pipeline (admin-reviewed before publishing):
 *   submit → admin review (approve / reject / request more info) → on approve, link org to user.
 */

import type { AuthEnv } from "./auth.js";
import {
  sendOrgRequestAdminNotifyEmail,
  sendOrgRequestReceivedEmail,
  sendOrgRequestStatusEmail,
  sendUserVerificationAdminNotifyEmail,
} from "./auth.js";
import type {
  DirectorLink,
  EventMode,
  OrganizationRecord,
  OrgRequestDecision,
  OrgRequestRecord,
  OrgRequestStatus,
  UserRecord,
} from "./db.js";
import {
  getOrgRequest,
  getSettings,
  getUserByEmail,
  listPendingOrgRequests,
  nowIso,
  randomId,
  saveOrg,
  saveOrgRequest,
  saveUser,
} from "./db.js";

export const ORG_ACTIVITY_LABELS = [
  "serving_people",
  "opensource",
  "funsource",
  "profitable",
  "non_profitable",
] as const;

export type OrgActivity = (typeof ORG_ACTIVITY_LABELS)[number];

export interface OrgRequestSubmitBody {
  organizationName: string;
  website: string;
  description: string;
  contactEmail: string;
  activities: string[];
  directors: DirectorLink[];
  eventMode: EventMode;
  motto: string;
  voxonAffiliated: boolean;
}

export interface OrgRequestDecisionBody {
  status: Extract<OrgRequestStatus, "APPROVED" | "REJECTED" | "INFO_REQUESTED">;
  note?: string;
}

export interface OrgRequestMailUrls {
  siteUrl: string;
  adminPortalUrl: string;
}

function organizePageUrl(siteUrl: string): string {
  const base = siteUrl.replace(/\/$/, "");
  return `${base}/#/organize`;
}

export async function adminRecipientEmails(
  kv: KVNamespace,
  env: AuthEnv
): Promise<string[]> {
  const settings = await getSettings(kv);
  const raw = settings.adminEmails || env.ADMIN_EMAILS || "";
  return raw
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/** Admin alert when a user applies for profile verification. */
export async function notifyUserVerificationSubmitted(
  kv: KVNamespace,
  env: AuthEnv,
  user: { id: string; email: string; name?: string },
  urls: OrgRequestMailUrls
): Promise<void> {
  const admins = await adminRecipientEmails(kv, env);
  const reviewUrl = `${urls.adminPortalUrl.replace(/\/$/, "")}/users?verification=pending`;
  for (const admin of admins) {
    try {
      await sendUserVerificationAdminNotifyEmail(env, admin, {
        userName: user.name || "",
        userEmail: user.email,
        userId: user.id,
        reviewUrl,
      });
    } catch (err) {
      console.error("[EventMark] user verification admin notify email failed", {
        to: admin,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/** Applicant receipt + admin alert after a new org request is submitted. */
export async function notifyOrgRequestSubmitted(
  kv: KVNamespace,
  env: AuthEnv,
  request: OrgRequestRecord,
  urls: OrgRequestMailUrls
): Promise<void> {
  const organizeUrl = organizePageUrl(urls.siteUrl);
  try {
    await sendOrgRequestReceivedEmail(env, request.contactEmail, {
      organizationName: request.organizationName,
      submittedAt: request.createdAt,
      organizeUrl,
    });
  } catch (err) {
    console.error("[EventMark] org request received email failed", {
      message: err instanceof Error ? err.message : String(err),
    });
  }

  const admins = await adminRecipientEmails(kv, env);
  const reviewUrl = `${urls.adminPortalUrl.replace(/\/$/, "")}/org-requests`;
  for (const admin of admins) {
    try {
      await sendOrgRequestAdminNotifyEmail(env, admin, {
        kind: "new",
        organizationName: request.organizationName,
        contactEmail: request.contactEmail,
        website: request.website,
        requestId: request.id,
        reviewUrl,
      });
    } catch (err) {
      console.error("[EventMark] org request admin notify email failed", {
        to: admin,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/** Admin alert when applicant resubmits after INFO_REQUESTED. */
export async function notifyOrgRequestResubmitted(
  kv: KVNamespace,
  env: AuthEnv,
  request: OrgRequestRecord,
  urls: OrgRequestMailUrls
): Promise<void> {
  const admins = await adminRecipientEmails(kv, env);
  const reviewUrl = `${urls.adminPortalUrl.replace(/\/$/, "")}/org-requests`;
  for (const admin of admins) {
    try {
      await sendOrgRequestAdminNotifyEmail(env, admin, {
        kind: "resubmitted",
        organizationName: request.organizationName,
        contactEmail: request.contactEmail,
        website: request.website,
        requestId: request.id,
        reviewUrl,
      });
    } catch (err) {
      console.error("[EventMark] org request resubmit admin notify failed", {
        to: admin,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

function isValidUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function sanitizeStr(s: unknown, max = 2000): string {
  return String(s ?? "").trim().slice(0, max);
}

function wordCount(s: string): number {
  const t = String(s || "").trim();
  if (!t) return 0;
  return t.split(/\s+/).filter(Boolean).length;
}

export const ORG_DESCRIPTION_MIN_WORDS = 160;

function validateBody(body: OrgRequestSubmitBody): string | null {
  if (!sanitizeStr(body.organizationName, 200)) return "name_required";
  if (!isValidUrl(body.website)) return "website_invalid";
  const description = sanitizeStr(body.description, 4000);
  if (!description) return "description_required";
  if (wordCount(description) < ORG_DESCRIPTION_MIN_WORDS) return "description_min_words";
  if (!Array.isArray(body.activities) || body.activities.length === 0) {
    return "activities_required";
  }
  for (const a of body.activities) {
    if (!ORG_ACTIVITY_LABELS.includes(a as OrgActivity)) return "activities_invalid";
  }
  if (!Array.isArray(body.directors) || body.directors.length === 0) {
    return "directors_required";
  }
  for (const d of body.directors) {
    if (!sanitizeStr(d?.name, 200) || !isValidUrl(d?.url ?? "")) return "directors_invalid";
  }
  if (!["in_person", "online", "hybrid"].includes(body.eventMode)) return "event_mode_invalid";
  if (!sanitizeStr(body.motto, 500)) return "motto_required";
  if (typeof body.voxonAffiliated !== "boolean") return "voxon_invalid";
  return null;
}

export async function submitOrgRequest(
  kv: KVNamespace,
  user: UserRecord,
  body: OrgRequestSubmitBody
): Promise<{ ok: true; request: OrgRequestRecord } | { ok: false; error: string }> {
  const err = validateBody(body);
  if (err) return { ok: false, error: err };
  const ts = nowIso();
  const req: OrgRequestRecord = {
    id: randomId(),
    userId: user.id,
    contactEmail: sanitizeStr(body.contactEmail, 200).toLowerCase() || user.email,
    organizationName: sanitizeStr(body.organizationName, 200),
    website: sanitizeStr(body.website, 500),
    description: sanitizeStr(body.description, 4000),
    activities: body.activities.slice(),
    directors: body.directors.map((d) => ({
      name: sanitizeStr(d.name, 200),
      url: sanitizeStr(d.url, 500),
      verified: Boolean(d.verified),
    })),
    eventMode: body.eventMode,
    motto: sanitizeStr(body.motto, 500),
    voxonAffiliated: body.voxonAffiliated,
    status: "PENDING",
    latestNote: "",
    history: [{ ts, status: "PENDING", note: "Submitted by applicant.", byUserId: user.id }],
    organizationId: null,
    createdAt: ts,
    updatedAt: ts,
  };
  await saveOrgRequest(kv, req);
  return { ok: true, request: req };
}

export async function listAdminOrgRequests(
  kv: KVNamespace,
  user: UserRecord
): Promise<{ ok: true; items: OrgRequestRecord[] } | { ok: false; error: string }> {
  if (!user.roles.includes("admin")) return { ok: false, error: "forbidden" };
  const items = await listPendingOrgRequests(kv);
  return { ok: true, items };
}

export async function decideOrgRequest(
  kv: KVNamespace,
  env: AuthEnv,
  admin: UserRecord,
  id: string,
  body: OrgRequestDecisionBody,
  siteUrl: string
): Promise<
  | { ok: true; request: OrgRequestRecord; organization?: OrganizationRecord }
  | { ok: false; error: string }
> {
  if (!admin.roles.includes("admin")) return { ok: false, error: "forbidden" };
  const existing = await getOrgRequest(kv, id);
  if (!existing) return { ok: false, error: "not_found" };
  if (existing.status === "APPROVED" || existing.status === "REJECTED") {
    return { ok: false, error: "already_decided" };
  }
  const ts = nowIso();
  const note = sanitizeStr(body.note, 4000);
  const decision: OrgRequestDecision = {
    ts,
    status: body.status,
    note,
    byUserId: admin.id,
  };
  existing.status = body.status;
  existing.latestNote = note;
  existing.history.push(decision);
  existing.updatedAt = ts;

  if (body.status === "APPROVED") {
    const orgId = randomId();
    const slug = existing.organizationName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48);
    const org: OrganizationRecord = {
      id: orgId,
      name: existing.organizationName,
      slug: slug || `org-${orgId.slice(0, 8)}`,
      website: existing.website,
      description: existing.description,
      verified: true,
      vettingStatus: "APPROVED",
      createdAt: ts,
      ownerUserId: existing.userId,
    };
    await saveOrg(kv, org);
    existing.organizationId = orgId;
    await saveOrgRequest(kv, existing);

    // Promote applicant to organizer + link the new org id.
    const owner = await getUserByEmail(kv, existing.contactEmail);
    if (owner) {
      const next: UserRecord = {
        ...owner,
        roles: owner.roles.includes("organizer") ? owner.roles : [...owner.roles, "organizer"],
        organizationIds: owner.organizationIds.includes(orgId)
          ? owner.organizationIds
          : [...owner.organizationIds, orgId],
        updatedAt: ts,
      };
      await saveUser(kv, next);
    }

    // Send approval email notification
    try {
      await sendOrgRequestStatusEmail(env, existing.contactEmail, {
        organizationName: existing.organizationName,
        status: "APPROVED",
        note,
        organizeUrl: organizePageUrl(siteUrl),
      });
    } catch (err) {
      console.error("[EventMark] org request approval email failed", {
        message: err instanceof Error ? err.message : String(err),
      });
    }

    return { ok: true, request: existing, organization: org };
  }

  // Send email notification for REJECTED or INFO_REQUESTED
  if (body.status === "REJECTED" || body.status === "INFO_REQUESTED") {
    try {
      await sendOrgRequestStatusEmail(env, existing.contactEmail, {
        organizationName: existing.organizationName,
        status: body.status,
        note,
        organizeUrl: organizePageUrl(siteUrl),
      });
    } catch (err) {
      console.error("[EventMark] org request status email failed", {
        status: body.status,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  await saveOrgRequest(kv, existing);
  return { ok: true, request: existing };
}

/** User updates their org request after admin requests more info.
 * Only allowed when status is INFO_REQUESTED.
 */
export async function updateOrgRequest(
  kv: KVNamespace,
  env: AuthEnv,
  user: UserRecord,
  id: string,
  body: Partial<OrgRequestSubmitBody>,
  urls: OrgRequestMailUrls
): Promise<{ ok: true; request: OrgRequestRecord } | { ok: false; error: string }> {
  const existing = await getOrgRequest(kv, id);
  if (!existing) return { ok: false, error: "not_found" };
  if (existing.userId !== user.id) return { ok: false, error: "forbidden" };
  if (existing.status !== "INFO_REQUESTED") return { ok: false, error: "cannot_update" };

  const ts = nowIso();

  // Update allowed fields
  if (body.organizationName) existing.organizationName = sanitizeStr(body.organizationName, 200);
  if (body.website && isValidUrl(body.website)) existing.website = sanitizeStr(body.website, 500);
  if (body.description) {
    const desc = sanitizeStr(body.description, 4000);
    if (wordCount(desc) < ORG_DESCRIPTION_MIN_WORDS) return { ok: false, error: "description_min_words" };
    existing.description = desc;
  }
  if (body.contactEmail) existing.contactEmail = sanitizeStr(body.contactEmail, 200).toLowerCase();
  if (body.activities && Array.isArray(body.activities)) {
    for (const a of body.activities) {
      if (!ORG_ACTIVITY_LABELS.includes(a as OrgActivity)) return { ok: false, error: "activities_invalid" };
    }
    existing.activities = body.activities.slice();
  }
  if (body.directors && Array.isArray(body.directors)) {
    for (const d of body.directors) {
      if (!sanitizeStr(d?.name, 200) || !isValidUrl(d?.url ?? "")) return { ok: false, error: "directors_invalid" };
    }
    existing.directors = body.directors.map((d) => ({
      name: sanitizeStr(d.name, 200),
      url: sanitizeStr(d.url, 500),
      verified: Boolean(d.verified),
    }));
  }
  if (body.eventMode && ["in_person", "online", "hybrid"].includes(body.eventMode)) {
    existing.eventMode = body.eventMode;
  }
  if (body.motto) existing.motto = sanitizeStr(body.motto, 500);
  if (typeof body.voxonAffiliated === "boolean") existing.voxonAffiliated = body.voxonAffiliated;

  // Reset status to PENDING for re-review
  existing.status = "PENDING";
  existing.latestNote = "Resubmitted by applicant with additional information.";
  existing.history.push({
    ts,
    status: "PENDING",
    note: "Resubmitted by applicant with additional information.",
    byUserId: user.id,
  });
  existing.updatedAt = ts;

  await saveOrgRequest(kv, existing);
  await notifyOrgRequestResubmitted(kv, env, existing, urls);
  return { ok: true, request: existing };
}

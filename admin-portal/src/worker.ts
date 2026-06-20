/**
 * EventMark Admin Portal - Main Worker (Single File)
 * Comprehensive admin interface for user and organizer management
 */

import { type AuthEnv } from "../../src/auth.js";
import {
  getUserByEmail as dbGetUserByEmail,
  getUserById as dbGetUserById,
  saveUser as dbSaveUser,
  getSettings as dbGetSettings,
  saveSettings as dbSaveSettings,
  getOrgRequest as dbGetOrgRequest,
  countEvents as dbCountEvents,
  countUsers as dbCountUsers,
  countOrganizations as dbCountOrganizations,
  listPendingOrgRequests,
  normalizeSocialLinks,
  type SettingsRecord,
  type UserRecord as MainUserRecord,
} from "../../src/db.js";
import { decideOrgRequest } from "../../src/org-requests.js";

export type UserRole = "visitor" | "user" | "organizer" | "admin";

export interface UserRecord {
  id: string;
  email: string;
  name: string | null;
  bio?: string;
  website?: string;
  verificationRequestStatus?: "none" | "pending" | "approved" | "rejected";
  verificationRequestedAt?: string;
  verified?: boolean;
  roles: UserRole[];
  organizationIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface OrganizationRecord {
  id: string;
  name: string;
  website: string;
  description: string;
  activities: string[];
  directors: { name: string; link: string }[];
  eventMode: "in_person" | "online" | "hybrid";
  motto: string;
  voxonAffiliated: boolean;
  voxonApproved: boolean;
  vettingStatus: "PENDING" | "APPROVED" | "REJECTED";
  createdAt: string;
  updatedAt: string;
}

export interface EventRecord {
  id: string;
  organizationId: string;
  title: string;
  description: string | null;
  location: string | null;
  startsAt: string;
  endsAt: string;
  isExternal: boolean;
  externalUrl: string | null;
  mode: "in_person" | "online" | "hybrid";
  onlineUrl: string | null;
  minSeats: number | null;
  maxSeats: number | null;
  speakers: { name: string; bio: string | null; photo: string | null }[];
  agenda: { time: string; title: string; description: string | null }[];
  status: "draft" | "published" | "archived";
  createdAt: string;
  updatedAt: string;
}

export type OrgRequestStatus = "PENDING" | "INFO_REQUESTED" | "REJECTED" | "APPROVED";

export interface OrgRequestRecord {
  id: string;
  userId: string;
  contactEmail: string;
  organizationName: string;
  website: string;
  description: string;
  activities: string[];
  directors: { name: string; link: string }[];
  eventMode: "in_person" | "online" | "hybrid";
  motto: string;
  voxonAffiliated: boolean;
  status: OrgRequestStatus;
  latestNote: string;
  history: { status: OrgRequestStatus; note: string; byUserId: string; at: string }[];
  organizationId: string | null;
  createdAt: string;
  updatedAt: string;
}

export type { SettingsRecord } from "../../src/db.js";

export interface AuditLog {
  id: string;
  action: 
    | "user_created" | "user_updated" | "user_deleted" | "user_role_changed" | "user_verification_toggled"
    | "user_verification_decision"
    | "org_request_approved" | "org_request_rejected" | "org_request_info_requested"
    | "org_created" | "org_updated" | "org_deleted"
    | "event_created" | "event_updated" | "event_deleted" | "event_moderated"
    | "settings_updated" | "admin_login";
  actor: string;
  targetType: "user" | "organization" | "event" | "org_request" | "settings";
  targetId: string;
  targetName: string;
  details: string;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
}

export interface AuthContext {
  email: string;
  name: string | null;
  isAuthenticated: boolean;
}

export interface Env extends AuthEnv {
  SITE_TITLE: string;
  ALLOWED_ADMIN_EMAILS?: string;
  ADMIN_EMAILS?: string;
  LOCAL_DEV?: string;
  DEV_ADMIN_EMAIL?: string;
  /** Public app origin for applicant-facing email links. */
  PUBLIC_SITE_URL?: string;
}

// ==================== CONSTANTS ====================

const USER_PREFIX = "user:";
const USER_EMAIL_INDEX = "user_email:";
const USER_VERIFICATION_PENDING_INDEX = "user_verification_pending:";
const ORG_PREFIX = "org:";
const EVENT_PREFIX = "event:";
const ORG_REQUEST_PREFIX = "org_req:";
const AUDIT_LOG_PREFIX = "audit:";
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

import { assertSafeProductionConfig, isLocalDevFlag } from "../../src/env-guard.js";
import voxuiCss from "../../src/voxui.css";
import adminCss from "./admin.css";

// ==================== HELPERS ====================

function isLocalDev(env: Env): boolean {
  return isLocalDevFlag(env.LOCAL_DEV);
}

function emailKey(email: string): string {
  return email.trim().toLowerCase();
}

function nowIso(): string {
  return new Date().toISOString();
}

function randomId(): string {
  const arr = new Uint8Array(12);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

function json(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), { ...init, headers: { ...JSON_HEADERS, ...init?.headers } });
}

function html(content: string, init?: ResponseInit): Response {
  return new Response(content, { ...init, headers: { "content-type": "text/html; charset=utf-8", ...init?.headers } });
}

function css(content: string): Response {
  return new Response(content, { headers: { "content-type": "text/css; charset=utf-8" } });
}

function js(content: string): Response {
  return new Response(content, { headers: { "content-type": "application/javascript; charset=utf-8" } });
}

async function readJson<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}

// ==================== AUTH ====================

function parseCookie(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const [rawKey, ...rest] = part.trim().split("=");
    if (!rawKey) continue;
    out[rawKey] = decodeURIComponent(rest.join("="));
  }
  return out;
}

function extractAuth(request: Request, env: Env): AuthContext {
  const email = request.headers.get("CF-Access-Authenticated-User-Email");
  const name = request.headers.get("CF-Access-Authenticated-User-Name");

  if (email) {
    return {
      email: email.toLowerCase(),
      name: name || email.split("@")[0],
      isAuthenticated: true,
    };
  }

  if (isLocalDev(env)) {
    const cookieEmail = parseCookie(request.headers.get("Cookie") || "").em_admin_session;
    const devEmail = cookieEmail || env.DEV_ADMIN_EMAIL;
    if (devEmail) {
      const normalized = devEmail.toLowerCase();
      return {
        email: normalized,
        name: normalized.split("@")[0],
        isAuthenticated: true,
      };
    }
  }

  return { email: "", name: null, isAuthenticated: false };
}

async function isAuthorized(auth: AuthContext, env: Env, kv: KVNamespace): Promise<boolean> {
  if (!auth.isAuthenticated) return false;
  if (isLocalDev(env)) return true;

  const settings = await dbGetSettings(kv);
  const raw =
    settings.adminEmails ||
    env.ADMIN_EMAILS ||
    env.ALLOWED_ADMIN_EMAILS ||
    "";
  const allowedEmails = raw
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (allowedEmails.length === 0) return false;

  return allowedEmails.includes(auth.email.toLowerCase());
}

function renderDevLoginError(message: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Dev Login</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0d1117; color: #f0f6fc; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .container { width: 100%; max-width: 420px; padding: 2rem; }
    .error { color: #f85149; margin-bottom: 1rem; }
    a { color: #58a6ff; }
  </style>
</head>
<body>
  <div class="container">
    <p class="error">${escapeHtml(message)}</p>
    <a href="/">Try again</a>
  </div>
</body>
</html>`;
}

function renderUnauthenticatedPage(env: Env): Response {
  if (isLocalDev(env)) {
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Dev Login</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0d1117; color: #f0f6fc; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .container { width: 100%; max-width: 420px; padding: 2rem; }
    h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
    p { color: #8b949e; margin-bottom: 1.5rem; }
    label { display: block; margin-bottom: 0.5rem; font-size: 0.875rem; }
    input { width: 100%; padding: 0.75rem; border-radius: 6px; border: 1px solid #30363d; background: #161b22; color: #f0f6fc; margin-bottom: 1rem; }
    .btn { width: 100%; padding: 0.75rem 1.5rem; background: #58a6ff; color: white; border: none; border-radius: 6px; font-weight: 500; cursor: pointer; }
    .btn:hover { background: #79c0ff; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Dev Login</h1>
    <p>Cloudflare Access is not available locally. Sign in with an admin email to continue.</p>
    <form method="POST" action="/dev/login">
      <label for="email">Admin email</label>
      <input id="email" name="email" type="email" required placeholder="admin@example.com" autofocus>
      <button type="submit" class="btn">Continue</button>
    </form>
  </div>
</body>
</html>`;
    return new Response(html, { status: 401, headers: { "Content-Type": "text/html" } });
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Authentication Required</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0d1117; color: #f0f6fc; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .container { text-align: center; max-width: 400px; padding: 2rem; }
    h1 { font-size: 1.5rem; margin-bottom: 1rem; }
    p { color: #8b949e; margin-bottom: 2rem; }
    .btn { display: inline-block; padding: 0.75rem 1.5rem; background: #58a6ff; color: white; text-decoration: none; border-radius: 6px; font-weight: 500; }
    .btn:hover { background: #79c0ff; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Authentication Required</h1>
    <p>This admin portal is protected by Cloudflare Access. Please sign in to continue.</p>
    <a href="/cdn-cgi/access/login" class="btn">Sign In</a>
  </div>
</body>
</html>`;
  return new Response(html, { status: 401, headers: { "Content-Type": "text/html" } });
}

function renderUnauthorizedPage(): Response {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Access Denied</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0d1117; color: #f0f6fc; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .container { text-align: center; max-width: 400px; padding: 2rem; }
    h1 { font-size: 1.5rem; margin-bottom: 1rem; color: #f85149; }
    p { color: #8b949e; margin-bottom: 2rem; }
    .icon { font-size: 4rem; margin-bottom: 1rem; }
  </style>
</head>
<body>
  <div class="container">
    <div class="icon">🔒</div>
    <h1>Access Denied</h1>
    <p>You don't have permission to access this admin portal. Please contact your administrator.</p>
  </div>
</body>
</html>`;
  return new Response(html, { status: 403, headers: { "Content-Type": "text/html" } });
}

// ==================== DB HELPERS ====================

async function getUser(kv: KVNamespace, id: string): Promise<UserRecord | null> {
  const user = await dbGetUserById(kv, id);
  return user as UserRecord | null;
}

async function getUserByEmail(kv: KVNamespace, email: string): Promise<UserRecord | null> {
  const user = await dbGetUserByEmail(kv, email);
  return user as UserRecord | null;
}

async function saveUser(kv: KVNamespace, user: UserRecord): Promise<void> {
  await dbSaveUser(kv, user as MainUserRecord);
}

async function countPendingVerificationRequests(kv: KVNamespace): Promise<number> {
  const listed = await kv.list({ prefix: USER_VERIFICATION_PENDING_INDEX });
  return listed.keys.length;
}

async function deleteUser(kv: KVNamespace, user: UserRecord): Promise<void> {
  await kv.delete(`${USER_PREFIX}${user.id}`);
  await kv.delete(`${USER_EMAIL_INDEX}${emailKey(user.email)}`);
  await kv.delete(`${USER_VERIFICATION_PENDING_INDEX}${user.id}`);
}

async function getOrg(kv: KVNamespace, id: string): Promise<OrganizationRecord | null> {
  const val = await kv.get(`${ORG_PREFIX}${id}`);
  if (!val) return null;
  try {
    return JSON.parse(val) as OrganizationRecord;
  } catch {
    return null;
  }
}

async function saveOrg(kv: KVNamespace, org: OrganizationRecord): Promise<void> {
  await kv.put(`${ORG_PREFIX}${org.id}`, JSON.stringify(org));
}

async function deleteOrg(kv: KVNamespace, id: string): Promise<void> {
  await kv.delete(`${ORG_PREFIX}${id}`);
}

async function getEvent(kv: KVNamespace, id: string): Promise<EventRecord | null> {
  const val = await kv.get(`${EVENT_PREFIX}${id}`);
  if (!val) return null;
  try {
    return JSON.parse(val) as EventRecord;
  } catch {
    return null;
  }
}

async function saveEvent(kv: KVNamespace, event: EventRecord): Promise<void> {
  await kv.put(`${EVENT_PREFIX}${event.id}`, JSON.stringify(event));
}

async function deleteEvent(kv: KVNamespace, id: string): Promise<void> {
  await kv.delete(`${EVENT_PREFIX}${id}`);
}

async function getOrgRequest(kv: KVNamespace, id: string): Promise<OrgRequestRecord | null> {
  const req = await dbGetOrgRequest(kv, id);
  return req as OrgRequestRecord | null;
}

async function getSettings(kv: KVNamespace): Promise<SettingsRecord> {
  return dbGetSettings(kv);
}

async function saveSettings(kv: KVNamespace, settings: SettingsRecord): Promise<void> {
  await dbSaveSettings(kv, {
    ...settings,
    noticeBanner: settings.noticeBanner ?? "",
    socialLinks: normalizeSocialLinks(settings.socialLinks),
  });
}

async function createAuditLog(kv: KVNamespace, log: AuditLog): Promise<void> {
  await kv.put(`${AUDIT_LOG_PREFIX}${log.id}`, JSON.stringify(log));
  await kv.put(`${AUDIT_LOG_PREFIX}time:${log.createdAt}:${log.id}`, log.id);
}

async function listAuditLogs(
  kv: KVNamespace,
  opts: { limit?: number; cursor?: string; action?: string; actor?: string } = {}
): Promise<{ items: AuditLog[]; cursor: string | null }> {
  const limit = opts.limit ?? 50;
  const prefix = `${AUDIT_LOG_PREFIX}time:`;
  const list = await kv.list({ prefix, limit: limit + 1, cursor: opts.cursor || undefined });
  
  const items: AuditLog[] = [];
  for (const key of list.keys.slice(0, limit)) {
    const id = key.name.split(":").pop();
    if (!id) continue;
    const val = await kv.get(`${AUDIT_LOG_PREFIX}${id}`);
    if (val) {
      const log = JSON.parse(val) as AuditLog;
      if (opts.action && log.action !== opts.action) continue;
      if (opts.actor && log.actor !== opts.actor) continue;
      items.push(log);
    }
  }
  
  items.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  
  const cursor = list.keys.length > limit ? list.keys[limit - 1].name : null;
  return { items, cursor };
}

async function listUsers(kv: KVNamespace, opts: { limit?: number; cursor?: string } = {}): Promise<{ items: UserRecord[]; cursor: string | null; total: number }> {
  const limit = opts.limit ?? 50;
  const list = await kv.list({ prefix: USER_PREFIX, limit: limit + 1, cursor: opts.cursor || undefined });
  
  const items: UserRecord[] = [];
  for (const key of list.keys.slice(0, limit)) {
    const val = await kv.get(key.name);
    if (val) items.push(JSON.parse(val) as UserRecord);
  }
  
  const total = list.keys.length;
  const cursor = list.keys.length > limit ? list.keys[limit - 1].name : null;
  return { items, cursor, total };
}

async function listOrganizations(kv: KVNamespace, opts: { limit?: number; cursor?: string } = {}): Promise<{ items: OrganizationRecord[]; cursor: string | null }> {
  const limit = opts.limit ?? 50;
  const list = await kv.list({ prefix: ORG_PREFIX, limit: limit + 1, cursor: opts.cursor || undefined });
  
  const items: OrganizationRecord[] = [];
  for (const key of list.keys.slice(0, limit)) {
    const val = await kv.get(key.name);
    if (val) items.push(JSON.parse(val) as OrganizationRecord);
  }
  
  const cursor = list.keys.length > limit ? list.keys[limit - 1].name : null;
  return { items, cursor };
}

async function listEvents(kv: KVNamespace, opts: { limit?: number; cursor?: string; status?: string } = {}): Promise<{ items: EventRecord[]; cursor: string | null }> {
  const limit = opts.limit ?? 50;
  const list = await kv.list({ prefix: EVENT_PREFIX, limit: 100 });
  
  const items: EventRecord[] = [];
  for (const key of list.keys) {
    const val = await kv.get(key.name);
    if (val) {
      const event = JSON.parse(val) as EventRecord;
      if (opts.status && event.status !== opts.status) continue;
      items.push(event);
    }
  }
  
  items.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  
  const cursor = null;
  return { items: items.slice(0, limit), cursor };
}

async function listOrgRequests(kv: KVNamespace, opts: { limit?: number; cursor?: string; status?: OrgRequestStatus } = {}): Promise<{ items: OrgRequestRecord[]; cursor: string | null }> {
  const limit = opts.limit ?? 50;
  const list = await kv.list({ prefix: ORG_REQUEST_PREFIX, limit: 100 });

  const items: OrgRequestRecord[] = [];
  for (const key of list.keys) {
    const val = await kv.get(key.name);
    if (val) {
      const req = JSON.parse(val) as OrgRequestRecord;
      if (opts.status && req.status !== opts.status) continue;
      items.push(req);
    }
  }
  
  items.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  
  const cursor = null;
  return { items: items.slice(0, limit), cursor };
}

// ==================== AUDIT LOG HELPER ====================

async function logAction(
  kv: KVNamespace,
  auth: AuthContext,
  action: AuditLog["action"],
  targetType: AuditLog["targetType"],
  targetId: string,
  targetName: string,
  details: Record<string, unknown>
): Promise<void> {
  const log: AuditLog = {
    id: randomId(),
    action,
    actor: auth.email,
    targetType,
    targetId,
    targetName,
    details: JSON.stringify(details),
    ipAddress: null,
    userAgent: null,
    createdAt: nowIso(),
  };
  await createAuditLog(kv, log);
}

// ==================== MAIN HANDLER ====================

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    assertSafeProductionConfig(env);
    const url = new URL(request.url);
    const pathname = url.pathname;
    const method = request.method.toUpperCase();

    const auth = extractAuth(request, env);

    // Public assets don't require auth
    if (pathname === "/voxui.css") return css(voxuiCss);
    if (pathname === "/styles.css") return css(adminCss);
    if (pathname === "/app.js") return js(adminApp());
    if (pathname === "/favicon.ico") return new Response(null, { status: 204 });
    if (pathname === "/api/health") return json({ ok: true, service: "eventmark-admin", env: env.ENVIRONMENT });

    if (isLocalDev(env) && pathname === "/dev/login" && method === "POST") {
      const form = await request.formData();
      const email = String(form.get("email") || "").trim().toLowerCase();
      if (!email || !email.includes("@")) {
        return html(renderDevLoginError("Enter a valid email address."));
      }
      return new Response(null, {
        status: 303,
        headers: {
          Location: "/",
          "Set-Cookie": `em_admin_session=${encodeURIComponent(email)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`,
        },
      });
    }

    // Require auth for everything else
    if (!auth.isAuthenticated) {
      if (pathname.startsWith("/api/")) {
        return json({ error: "unauthenticated" }, { status: 401 });
      }
      return renderUnauthenticatedPage(env);
    }

    if (!(await isAuthorized(auth, env, env.KV))) {
      if (pathname.startsWith("/api/")) {
        return json({ error: "unauthorized" }, { status: 403 });
      }
      return renderUnauthorizedPage();
    }

    if (pathname.startsWith("/api/")) {
      return handleApi(request, env, pathname, method, auth);
    }

    return handleUi(request, env, pathname, auth);
  },
};

// ==================== API HANDLER ====================

async function handleApi(request: Request, env: Env, pathname: string, method: string, auth: AuthContext): Promise<Response> {
  const kv = env.KV;

  // Dashboard stats
  if (method === "GET" && pathname === "/api/stats") {
    const [totalUsers, totalOrganizations, totalEvents, pendingRequests, pendingVerifications] =
      await Promise.all([
        dbCountUsers(kv),
        dbCountOrganizations(kv),
        dbCountEvents(kv),
        listPendingOrgRequests(kv).then((items) => items.length),
        countPendingVerificationRequests(kv),
      ]);

    return json({
      totalUsers,
      totalOrganizations,
      totalEvents,
      pendingOrgRequests: pendingRequests,
      pendingVerificationRequests: pendingVerifications,
    });
  }

  // Users API
  if (pathname === "/api/users" || pathname === "/api/users/") {
    if (method === "GET") {
      const url = new URL(request.url);
      const limit = parseInt(url.searchParams.get("limit") || "50", 10);
      const cursor = url.searchParams.get("cursor") || undefined;
      const search = url.searchParams.get("search")?.toLowerCase();
      const role = url.searchParams.get("role") as UserRole | null;
      const verification = url.searchParams.get("verification");

      const result = await listUsers(kv, { limit, cursor });
      
      let items = result.items;
      if (search) {
        items = items.filter(u => 
          u.email.toLowerCase().includes(search) || 
          u.name?.toLowerCase().includes(search)
        );
      }
      if (role) {
        items = items.filter(u => u.roles.includes(role));
      }
      if (verification === "pending") {
        items = items.filter(u => u.verificationRequestStatus === "pending");
      }

      return json({ items, cursor: result.cursor, total: result.total });
    }

    if (method === "POST") {
      const body = await readJson<Partial<UserRecord>>(request);
      if (!body?.email) return json({ error: "email_required" }, { status: 400 });

      const existing = await getUserByEmail(kv, body.email);
      if (existing) return json({ error: "email_exists" }, { status: 409 });

      const user: UserRecord = {
        id: randomId(),
        email: body.email.toLowerCase(),
        name: body.name || null,
        roles: body.roles || ["user"],
        organizationIds: [],
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };

      await saveUser(kv, user);
      await logAction(kv, auth, "user_created", "user", user.id, user.email, { email: user.email });

      return json({ user }, { status: 201 });
    }
  }

  if (pathname.startsWith("/api/users/")) {
    const userId = pathname.split("/")[3];
    if (!userId) return json({ error: "not_found" }, { status: 404 });

    if (method === "GET") {
      const user = await getUser(kv, userId);
      if (!user) return json({ error: "not_found" }, { status: 404 });
      return json({ user });
    }

    if (method === "PUT") {
      const user = await getUser(kv, userId);
      if (!user) return json({ error: "not_found" }, { status: 404 });

      const body = await readJson<Partial<UserRecord>>(request);
      if (!body) return json({ error: "invalid_body" }, { status: 400 });

      const oldRoles = [...user.roles];
      const oldVerified = user.verified;
      const oldVerificationStatus = user.verificationRequestStatus;
      const updated: UserRecord = {
        ...user,
        name: body.name !== undefined ? body.name : user.name,
        bio: body.bio !== undefined ? body.bio : user.bio,
        website: body.website !== undefined ? body.website : user.website,
        verified: body.verified !== undefined ? body.verified : user.verified,
        roles: body.roles !== undefined ? body.roles : user.roles,
        organizationIds:
          body.organizationIds !== undefined ? body.organizationIds : user.organizationIds,
        verificationRequestStatus:
          body.verificationRequestStatus !== undefined
            ? body.verificationRequestStatus
            : user.verificationRequestStatus,
        verificationRequestedAt:
          body.verificationRequestedAt !== undefined
            ? body.verificationRequestedAt
            : user.verificationRequestedAt,
        id: user.id,
        email: user.email,
        createdAt: user.createdAt,
        updatedAt: nowIso(),
      };

      if (body.verified === true && user.verificationRequestStatus === "pending") {
        updated.verificationRequestStatus = "approved";
      } else if (body.verificationRequestStatus === "rejected") {
        updated.verificationRequestStatus = "rejected";
      }

      await saveUser(kv, updated);
      
      if (body.roles && JSON.stringify(oldRoles) !== JSON.stringify(body.roles)) {
        await logAction(kv, auth, "user_role_changed", "user", user.id, user.email, { oldRoles, newRoles: body.roles });
      } else if (body.verified !== undefined && body.verified !== oldVerified) {
        await logAction(kv, auth, "user_verification_toggled", "user", user.id, user.email, { verified: body.verified });
      } else if (body.verificationRequestStatus && body.verificationRequestStatus !== oldVerificationStatus) {
        await logAction(kv, auth, "user_verification_decision", "user", user.id, user.email, { status: body.verificationRequestStatus });
      } else {
        await logAction(kv, auth, "user_updated", "user", user.id, user.email, { email: user.email });
      }

      return json({ user: updated });
    }

    if (method === "DELETE") {
      const user = await getUser(kv, userId);
      if (!user) return json({ error: "not_found" }, { status: 404 });

      await deleteUser(kv, user);
      await logAction(kv, auth, "user_deleted", "user", userId, user.email, { email: user.email });

      return json({ success: true });
    }
  }

  // Organizations API
  if (pathname === "/api/organizations" || pathname === "/api/organizations/") {
    if (method === "GET") {
      const url = new URL(request.url);
      const limit = parseInt(url.searchParams.get("limit") || "50", 10);
      const cursor = url.searchParams.get("cursor") || undefined;
      
      const result = await listOrganizations(kv, { limit, cursor });
      const [users, events] = await Promise.all([
        listUsers(kv, { limit: 500 }),
        listEvents(kv, { limit: 500 }),
      ]);
      return json({
        ...result,
        items: result.items.map((org) => ({
          ...org,
          memberCount: users.items.filter((user) => user.organizationIds.includes(org.id)).length,
          eventCount: events.items.filter((event) => event.organizationId === org.id).length,
        })),
      });
    }
  }

  if (pathname.startsWith("/api/organizations/")) {
    const orgId = pathname.split("/")[3];
    if (!orgId) return json({ error: "not_found" }, { status: 404 });

    if (method === "GET") {
      const org = await getOrg(kv, orgId);
      if (!org) return json({ error: "not_found" }, { status: 404 });

      const users = await listUsers(kv, { limit: 100 });
      const members = users.items.filter(u => u.organizationIds.includes(orgId));

      const events = await listEvents(kv, { limit: 100 });
      const orgEvents = events.items.filter(e => e.organizationId === orgId);

      return json({ org, members, events: orgEvents });
    }

    if (method === "PUT") {
      const org = await getOrg(kv, orgId);
      if (!org) return json({ error: "not_found" }, { status: 404 });

      const body = await readJson<Partial<OrganizationRecord>>(request);
      if (!body) return json({ error: "invalid_body" }, { status: 400 });

      const updated: OrganizationRecord = {
        ...org,
        name: body.name !== undefined ? body.name : org.name,
        website: body.website !== undefined ? body.website : org.website,
        description: body.description !== undefined ? body.description : org.description,
        vettingStatus: body.vettingStatus !== undefined ? body.vettingStatus : org.vettingStatus,
        id: org.id,
        createdAt: org.createdAt,
        updatedAt: nowIso(),
      };

      await saveOrg(kv, updated);
      await logAction(kv, auth, "org_updated", "organization", orgId, org.name, { name: org.name });

      return json({ org: updated });
    }

    if (method === "DELETE") {
      const org = await getOrg(kv, orgId);
      if (!org) return json({ error: "not_found" }, { status: 404 });

      await deleteOrg(kv, orgId);
      await logAction(kv, auth, "org_deleted", "organization", orgId, org.name, { name: org.name });

      return json({ success: true });
    }
  }

  // Events API
  if (pathname === "/api/events" || pathname === "/api/events/") {
    if (method === "GET") {
      const url = new URL(request.url);
      const limit = parseInt(url.searchParams.get("limit") || "50", 10);
      const status = url.searchParams.get("status") as "draft" | "published" | "archived" | null;
      
      const result = await listEvents(kv, { limit, status: status || undefined });
      const orgIds = Array.from(new Set(result.items.map((event) => event.organizationId).filter(Boolean)));
      const organizations = await Promise.all(orgIds.map((orgId) => getOrg(kv, orgId)));
      const orgMap = new Map(organizations.filter(Boolean).map((org) => [org!.id, org!]));
      return json({
        ...result,
        items: result.items.map((event) => ({
          ...event,
          organizationName: orgMap.get(event.organizationId)?.name || "Unknown organization",
        })),
      });
    }
  }

  if (pathname.startsWith("/api/events/")) {
    const eventId = pathname.split("/")[3];
    if (!eventId) return json({ error: "not_found" }, { status: 404 });

    if (method === "GET") {
      const event = await getEvent(kv, eventId);
      if (!event) return json({ error: "not_found" }, { status: 404 });
      
      const org = await getOrg(kv, event.organizationId);
      return json({ event, org });
    }

    if (method === "PUT") {
      const event = await getEvent(kv, eventId);
      if (!event) return json({ error: "not_found" }, { status: 404 });

      const body = await readJson<Partial<EventRecord>>(request);
      if (!body) return json({ error: "invalid_body" }, { status: 400 });

      const updated: EventRecord = {
        ...event,
        title: body.title !== undefined ? body.title : event.title,
        description: body.description !== undefined ? body.description : event.description,
        location: body.location !== undefined ? body.location : event.location,
        startsAt: body.startsAt !== undefined ? body.startsAt : event.startsAt,
        endsAt: body.endsAt !== undefined ? body.endsAt : event.endsAt,
        status: body.status !== undefined ? body.status : event.status,
        mode: body.mode !== undefined ? body.mode : event.mode,
        isExternal: body.isExternal !== undefined ? body.isExternal : event.isExternal,
        externalUrl: body.externalUrl !== undefined ? body.externalUrl : event.externalUrl,
        onlineUrl: body.onlineUrl !== undefined ? body.onlineUrl : event.onlineUrl,
        minSeats: body.minSeats !== undefined ? body.minSeats : event.minSeats,
        maxSeats: body.maxSeats !== undefined ? body.maxSeats : event.maxSeats,
        id: event.id,
        organizationId: event.organizationId,
        createdAt: event.createdAt,
        updatedAt: nowIso(),
      };

      await saveEvent(kv, updated);
      await logAction(kv, auth, "event_updated", "event", eventId, event.title, { title: event.title });

      return json({ event: updated });
    }

    if (method === "DELETE") {
      const event = await getEvent(kv, eventId);
      if (!event) return json({ error: "not_found" }, { status: 404 });

      await deleteEvent(kv, eventId);
      await logAction(kv, auth, "event_deleted", "event", eventId, event.title, { title: event.title });

      return json({ success: true });
    }
  }

  // Org Requests API
  if (pathname === "/api/org-requests" || pathname === "/api/org-requests/") {
    if (method === "GET") {
      const url = new URL(request.url);
      const status = url.searchParams.get("status") as OrgRequestStatus | null;
      const limit = parseInt(url.searchParams.get("limit") || "50", 10);
      
      const result = await listOrgRequests(kv, { status: status || undefined, limit });
      return json(result);
    }
  }

  if (pathname.startsWith("/api/org-requests/") && pathname.endsWith("/decision")) {
    if (method === "PUT") {
      const requestId = pathname.split("/")[3];
      const orgReq = await getOrgRequest(kv, requestId);
      if (!orgReq) return json({ error: "not_found" }, { status: 404 });

      const body = await readJson<{ status: OrgRequestStatus; note?: string }>(request);
      if (
        !body?.status ||
        !["APPROVED", "REJECTED", "INFO_REQUESTED"].includes(body.status)
      ) {
        return json({ error: "status_required" }, { status: 400 });
      }

      let adminUser = await dbGetUserByEmail(kv, auth.email);
      if (!adminUser) {
        adminUser = {
          id: randomId(),
          email: auth.email,
          roles: ["admin"],
          organizationIds: [],
          createdAt: nowIso(),
          updatedAt: nowIso(),
        };
        await dbSaveUser(kv, adminUser);
      } else if (!adminUser.roles.includes("admin")) {
        adminUser = {
          ...adminUser,
          roles: [...adminUser.roles, "admin"],
          updatedAt: nowIso(),
        };
        await dbSaveUser(kv, adminUser);
      }

      const siteUrl =
        (env.PUBLIC_SITE_URL || "").trim() ||
        `${new URL(request.url).protocol}//${new URL(request.url).host}`.replace(".admin.", ".");
      const result = await decideOrgRequest(kv, env, adminUser, requestId, {
        status: body.status as "APPROVED" | "REJECTED" | "INFO_REQUESTED",
        note: body.note,
      }, siteUrl);

      if (!result.ok) {
        const status =
          result.error === "forbidden"
            ? 403
            : result.error === "already_decided"
              ? 409
              : 404;
        return json({ error: result.error }, { status });
      }

      if (body.status === "APPROVED") {
        await logAction(kv, auth, "org_request_approved", "org_request", requestId, orgReq.organizationName, {
          orgName: orgReq.organizationName,
          createdOrgId: result.organization?.id,
        });
      } else if (body.status === "REJECTED") {
        await logAction(kv, auth, "org_request_rejected", "org_request", requestId, orgReq.organizationName, {
          orgName: orgReq.organizationName,
          note: body.note,
        });
      } else if (body.status === "INFO_REQUESTED") {
        await logAction(kv, auth, "org_request_info_requested", "org_request", requestId, orgReq.organizationName, {
          orgName: orgReq.organizationName,
          note: body.note,
        });
      }

      return json({ request: result.request, organization: result.organization });
    }
  }

  // Audit Logs API
  if (pathname === "/api/audit-logs" || pathname === "/api/audit-logs/") {
    if (method === "GET") {
      const url = new URL(request.url);
      const limit = parseInt(url.searchParams.get("limit") || "50", 10);
      const cursor = url.searchParams.get("cursor") || undefined;
      const action = url.searchParams.get("action") || undefined;
      const actor = url.searchParams.get("actor") || undefined;

      const result = await listAuditLogs(kv, { limit, cursor, action, actor });
      return json(result);
    }
  }

  // Settings API
  if (pathname === "/api/settings" || pathname === "/api/settings/") {
    if (method === "GET") {
      const settings = await getSettings(kv);
      return json({ settings });
    }

    if (method === "PUT") {
      const body = await readJson<Partial<SettingsRecord>>(request);
      if (!body) return json({ error: "invalid_body" }, { status: 400 });

      const current = await getSettings(kv);
      const updated: SettingsRecord = {
        ...current,
        ...body,
        noticeBanner:
          typeof body.noticeBanner === "string" ? body.noticeBanner : current.noticeBanner,
        socialLinks:
          body.socialLinks && typeof body.socialLinks === "object"
            ? normalizeSocialLinks({ ...current.socialLinks, ...body.socialLinks })
            : current.socialLinks,
        updatedAt: nowIso(),
        updatedBy: auth.email,
      };

      await saveSettings(kv, updated);
      await logAction(kv, auth, "settings_updated", "settings", "settings", "Site Settings", { changes: Object.keys(body) });

      return json({ settings: updated });
    }
  }

  return json({ error: "not_found" }, { status: 404 });
}

// ==================== UI HANDLER ====================

async function handleUi(_request: Request, env: Env, pathname: string, auth: AuthContext): Promise<Response> {
  const title = env.SITE_TITLE;
  const user = auth;

  if (pathname === "/" || pathname === "") return html(renderDashboard(title, user));
  if (pathname === "/users" || pathname === "/users/") return html(renderUsersPage(title, user));
  if (pathname.startsWith("/users/")) return html(renderUserDetailPage(title, user, pathname.split("/")[2]));
  if (pathname === "/organizations" || pathname === "/organizations/") return html(renderOrganizationsPage(title, user));
  if (pathname.startsWith("/organizations/")) return html(renderOrganizationDetailPage(title, user, pathname.split("/")[2]));
  if (pathname === "/events" || pathname === "/events/") return html(renderEventsPage(title, user));
  if (pathname.startsWith("/events/")) return html(renderEventDetailPage(title, user, pathname.split("/")[2]));
  if (pathname === "/org-requests" || pathname === "/org-requests/") return html(renderOrgRequestsPage(title, user));
  if (pathname === "/audit-logs" || pathname === "/audit-logs/") return html(renderAuditLogsPage(title, user));
  if (pathname === "/settings" || pathname === "/settings/") return html(renderSettingsPage(title, user, env));

  return html(renderNotFoundPage(title, user), { status: 404 });
}

// ==================== UI COMPONENTS ====================

function renderBaseHtml(title: string, user: AuthContext, content: string, activeNav?: string): string {
  return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#0d0d0d">
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="/voxui.css">
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <div class="vox-explorer admin-layout">
    <aside class="vox-sidebar sidebar">
      <div class="sidebar-header">
        <p class="sidebar-kicker">EventMark</p>
        <h1>${escapeHtml(title)}</h1>
        <p class="sidebar-subtitle">Admin portal</p>
        <p class="user-info">${escapeHtml(user.email)}</p>
      </div>
      <nav class="sidebar-nav">
        <a href="/" class="vox-nav-item nav-item ${activeNav === "dashboard" ? "active" : ""}"><span class="nav-code">OV</span> Dashboard</a>
        <a href="/users" class="vox-nav-item nav-item ${activeNav === "users" ? "active" : ""}"><span class="nav-code">US</span> Users <span class="vox-badge badge" id="verification-badge" style="display:none">0</span></a>
        <a href="/organizations" class="vox-nav-item nav-item ${activeNav === "organizations" ? "active" : ""}"><span class="nav-code">OR</span> Organizations</a>
        <a href="/events" class="vox-nav-item nav-item ${activeNav === "events" ? "active" : ""}"><span class="nav-code">EV</span> Events</a>
        <a href="/org-requests" class="vox-nav-item nav-item ${activeNav === "org-requests" ? "active" : ""}"><span class="nav-code">RQ</span> Org Requests <span class="vox-badge badge" id="pending-badge" style="display:none">0</span></a>
        <a href="/audit-logs" class="vox-nav-item nav-item ${activeNav === "audit-logs" ? "active" : ""}"><span class="nav-code">LG</span> Audit Logs</a>
        <a href="/settings" class="vox-nav-item nav-item ${activeNav === "settings" ? "active" : ""}"><span class="nav-code">ST</span> Settings</a>
      </nav>
      <div class="sidebar-footer">
        <a href="/cdn-cgi/access/logout" class="vox-nav-item nav-item logout"><span class="nav-code">BY</span> Sign out</a>
      </div>
    </aside>
    <main class="vox-main main-content">${content}</main>
  </div>
  <script src="/app.js"></script>
</body>
</html>`;
}

function renderDashboard(title: string, user: AuthContext): string {
  return renderBaseHtml(title, user, `
    <div class="page-header"><h2 class="vox-heading">Dashboard</h2><p>Overview of your EventMark instance</p></div>
    <div class="stats-grid">
      <div class="vox-card stat-card"><div class="stat-value" id="stat-users">-</div><div class="stat-label">Total Users</div></div>
      <div class="vox-card stat-card"><div class="stat-value" id="stat-orgs">-</div><div class="stat-label">Organizations</div></div>
      <div class="vox-card stat-card"><div class="stat-value" id="stat-events">-</div><div class="stat-label">Events</div></div>
      <div class="vox-card stat-card"><div class="stat-value" id="stat-pending">-</div><div class="stat-label">Pending Org Requests</div></div>
      <div class="vox-card stat-card"><div class="stat-value" id="stat-verification-pending">-</div><div class="stat-label">Verification Requests</div></div>
    </div>
    <div class="quick-actions">
      <h3>Quick Actions</h3>
      <div class="action-buttons">
        <a href="/org-requests" class="vox-btn vox-btn-primary btn btn-primary">Review Org Requests</a>
        <a href="/users?verification=pending" class="vox-btn vox-btn-primary btn btn-primary">Review Verifications</a>
        <a href="/users" class="vox-btn btn btn-secondary">Manage Users</a>
        <a href="/events" class="vox-btn btn btn-secondary">Moderate Events</a>
      </div>
    </div>
    <div class="recent-activity">
      <h3>Recent Activity</h3>
      <div id="activity-list" class="vox-card activity-list"><p>Loading...</p></div>
    </div>
  `, "dashboard");
}

function renderUsersPage(title: string, user: AuthContext): string {
  return renderBaseHtml(title, user, `
    <div class="page-header"><h2 class="vox-heading">Users</h2><p>Manage EventMark users</p></div>
    <div class="filters">
      <input type="text" id="user-search" placeholder="Search by email or name..." class="vox-input search-input">
      <select id="user-role-filter" class="vox-select filter-select">
        <option value="">All Roles</option>
        <option value="visitor">Visitor</option>
        <option value="user">User</option>
        <option value="organizer">Organizer</option>
        <option value="admin">Admin</option>
      </select>
    </div>
    <div class="vox-table-wrapper table-container">
      <table class="vox-table data-table">
        <thead><tr><th>Email</th><th>Name</th><th>Roles</th><th>Verified</th><th>Organizations</th><th>Created</th><th>Actions</th></tr></thead>
        <tbody id="users-table-body"><tr><td colspan="7">Loading...</td></tr></tbody>
      </table>
    </div>
    <div class="pagination" id="users-pagination"></div>
  `, "users");
}

function renderUserDetailPage(title: string, user: AuthContext, userId: string): string {
  return renderBaseHtml(title, user, `
    <div class="page-header"><a href="/users" class="back-link">← Back to Users</a><h2 class="vox-heading">User Details</h2></div>
    <div id="user-detail-content"><p>Loading...</p></div>
  `, "users");
}

function renderOrganizationsPage(title: string, user: AuthContext): string {
  return renderBaseHtml(title, user, `
    <div class="page-header"><h2 class="vox-heading">Organizations</h2><p>Manage approved organizations</p></div>
    <div class="vox-table-wrapper table-container">
      <table class="vox-table data-table">
        <thead><tr><th>Name</th><th>Website</th><th>Status</th><th>Members</th><th>Created</th><th>Actions</th></tr></thead>
        <tbody id="orgs-table-body"><tr><td colspan="6">Loading...</td></tr></tbody>
      </table>
    </div>
  `, "organizations");
}

function renderOrganizationDetailPage(title: string, user: AuthContext, orgId: string): string {
  return renderBaseHtml(title, user, `
    <div class="page-header"><a href="/organizations" class="back-link">← Back to Organizations</a><h2 class="vox-heading">Organization Details</h2></div>
    <div id="org-detail-content"><p>Loading...</p></div>
  `, "organizations");
}

function renderEventsPage(title: string, user: AuthContext): string {
  return renderBaseHtml(title, user, `
    <div class="page-header"><h2 class="vox-heading">Events</h2><p>Moderate all events</p></div>
    <div class="filters">
      <select id="event-status-filter" class="vox-select filter-select">
        <option value="">All Status</option>
        <option value="draft">Draft</option>
        <option value="published">Published</option>
        <option value="archived">Archived</option>
      </select>
    </div>
    <div class="vox-table-wrapper table-container">
      <table class="vox-table data-table">
        <thead><tr><th>Title</th><th>Organization</th><th>Status</th><th>Date</th><th>Actions</th></tr></thead>
        <tbody id="events-table-body"><tr><td colspan="5">Loading...</td></tr></tbody>
      </table>
    </div>
  `, "events");
}

function renderEventDetailPage(title: string, user: AuthContext, eventId: string): string {
  return renderBaseHtml(title, user, `
    <div class="page-header"><a href="/events" class="back-link">← Back to Events</a><h2 class="vox-heading">Event Details</h2></div>
    <div id="event-detail-content"><p>Loading...</p></div>
  `, "events");
}

function renderOrgRequestsPage(title: string, user: AuthContext): string {
  return renderBaseHtml(title, user, `
    <div class="page-header"><h2 class="vox-heading">Organization Requests</h2><p>Review and approve organization applications</p></div>
    <div class="filters">
      <select id="request-status-filter" class="vox-select filter-select">
        <option value="PENDING">Pending</option>
        <option value="">All</option>
        <option value="APPROVED">Approved</option>
        <option value="REJECTED">Rejected</option>
      </select>
    </div>
    <div id="org-requests-list" class="requests-list"><p>Loading...</p></div>
  `, "org-requests");
}

function renderAuditLogsPage(title: string, user: AuthContext): string {
  return renderBaseHtml(title, user, `
    <div class="page-header"><h2 class="vox-heading">Audit Logs</h2><p>Track all admin actions</p></div>
    <div class="filters">
      <select id="audit-action-filter" class="vox-select filter-select">
        <option value="">All Actions</option>
        <option value="user_created">User Created</option>
        <option value="user_updated">User Updated</option>
        <option value="user_deleted">User Deleted</option>
        <option value="org_request_approved">Org Approved</option>
        <option value="org_request_rejected">Org Rejected</option>
      </select>
    </div>
    <div class="vox-table-wrapper table-container">
      <table class="vox-table data-table">
        <thead><tr><th>Time</th><th>Action</th><th>Actor</th><th>Target</th><th>Details</th></tr></thead>
        <tbody id="audit-table-body"><tr><td colspan="5">Loading...</td></tr></tbody>
      </table>
    </div>
  `, "audit-logs");
}

function renderSettingsPage(title: string, user: AuthContext, env: Env): string {
  const publicSite = (env.PUBLIC_SITE_URL || "https://your-site.example.com").replace(/\/$/, "");
  return renderBaseHtml(title, user, `
    <div class="page-header"><h2 class="vox-heading">Settings</h2><p>Configure site-wide settings for the public EventMark app</p></div>
    <form id="settings-form" class="settings-form">
      <div class="form-group vox-vbox">
        <label class="vox-label" for="admin-emails">Admin Emails (comma-separated)</label>
        <textarea class="vox-textarea" id="admin-emails" name="adminEmails" rows="3" placeholder="admin@example.com, super@example.com"></textarea>
        <p class="help-text">These emails will have admin access automatically</p>
      </div>
      <div class="form-group vox-vbox">
        <label class="vox-label" for="notice-banner">Site Notice Banner</label>
        <textarea class="vox-textarea" id="notice-banner" name="noticeBanner" rows="2" placeholder="Optional notice to display on all pages"></textarea>
      </div>
      <div class="form-group checkbox-group vox-vbox">
        <label class="vox-label"><input type="checkbox" class="vox-checkbox" id="pause-org-requests" name="pauseOrgRequests"> Pause new organization requests</label>
      </div>
      <div class="form-group checkbox-group vox-vbox">
        <label class="vox-label"><input type="checkbox" class="vox-checkbox" id="pause-registrations" name="pauseRegistrations"> Pause new event registrations</label>
      </div>
      <div class="settings-section">
        <h3 class="vox-heading">Footer social links</h3>
        <p class="help-text">Set a URL to enable each icon in the public site footer. Leave blank to keep it disabled.</p>
        <p class="help-text">Public read API: <code>${escapeHtml(publicSite)}/api/site/social-links</code></p>
        <div class="form-group vox-vbox"><label class="vox-label" for="social-x">X (Twitter)</label><input class="vox-input" id="social-x" type="url" placeholder="https://x.com/eventmark" /></div>
        <div class="form-group vox-vbox"><label class="vox-label" for="social-discord">Discord</label><input class="vox-input" id="social-discord" type="url" placeholder="https://discord.gg/…" /></div>
        <div class="form-group vox-vbox"><label class="vox-label" for="social-telegram">Telegram</label><input class="vox-input" id="social-telegram" type="url" placeholder="https://t.me/…" /></div>
        <div class="form-group vox-vbox"><label class="vox-label" for="social-linkedin">LinkedIn</label><input class="vox-input" id="social-linkedin" type="url" placeholder="https://linkedin.com/company/…" /></div>
        <div class="form-group vox-vbox"><label class="vox-label" for="social-facebook">Facebook</label><input class="vox-input" id="social-facebook" type="url" placeholder="https://facebook.com/…" /></div>
      </div>
      <div class="form-actions"><button type="submit" class="vox-btn vox-btn-primary btn btn-primary">Save Settings</button></div>
    </form>
  `, "settings");
}

function renderNotFoundPage(title: string, user: AuthContext): string {
  return renderBaseHtml(title, user, `
    <div class="error-page">
      <h1>404</h1>
      <p>Page not found</p>
      <div class="action-buttons" style="justify-content:center;">
        <a href="/" class="vox-btn vox-btn-primary btn btn-primary">Dashboard</a>
        <a href="/settings" class="vox-btn btn btn-secondary">Settings</a>
        <a href="/org-requests" class="vox-btn btn btn-secondary">Org requests</a>
      </div>
    </div>
  `);
}

// ==================== CLIENT JS ====================

function adminApp(): string {
  return `
async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', ...opts.headers } });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

function formatDate(d) { return new Date(d).toLocaleString(); }
function escapeHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function formatArray(items) { return items && items.length ? items.map(escapeHtml).join(', ') : '-'; }

async function loadNavBadges() {
  try {
    const stats = await api('/api/stats');
    const orgBadge = document.getElementById('pending-badge');
    if (orgBadge && stats.pendingOrgRequests > 0) {
      orgBadge.textContent = stats.pendingOrgRequests;
      orgBadge.style.display = 'inline-block';
    }
    const verBadge = document.getElementById('verification-badge');
    if (verBadge && stats.pendingVerificationRequests > 0) {
      verBadge.textContent = stats.pendingVerificationRequests;
      verBadge.style.display = 'inline-block';
    }
  } catch (e) { console.error('Failed to load nav badges:', e); }
}

async function loadDashboard() {
  try {
    const stats = await api('/api/stats');
    document.getElementById('stat-users').textContent = stats.totalUsers;
    document.getElementById('stat-orgs').textContent = stats.totalOrganizations;
    document.getElementById('stat-events').textContent = stats.totalEvents;
    document.getElementById('stat-pending').textContent = stats.pendingOrgRequests;
    const verStat = document.getElementById('stat-verification-pending');
    if (verStat) verStat.textContent = stats.pendingVerificationRequests;
    const badge = document.getElementById('pending-badge');
    if (badge && stats.pendingOrgRequests > 0) {
      badge.textContent = stats.pendingOrgRequests;
      badge.style.display = 'inline-block';
    }
    const verBadge = document.getElementById('verification-badge');
    if (verBadge && stats.pendingVerificationRequests > 0) {
      verBadge.textContent = stats.pendingVerificationRequests;
      verBadge.style.display = 'inline-block';
    }
  } catch (e) { console.error('Failed to load stats:', e); }
}

async function loadRecentActivity() {
  try {
    const logs = await api('/api/audit-logs?limit=10');
    const container = document.getElementById('activity-list');
    if (logs.items.length === 0) { container.innerHTML = '<p>No recent activity</p>'; return; }
    container.innerHTML = logs.items.map(log => \`<div class="activity-item"><span>\${formatDate(log.createdAt)}</span><span>\${log.action.replace(/_/g, ' ')}</span><span>by \${escapeHtml(log.actor)}</span></div>\`).join('');
  } catch (e) { console.error('Failed to load activity:', e); }
}

async function loadUsers() {
  const tbody = document.getElementById('users-table-body');
  if (!tbody) return;
  try {
    const search = document.getElementById('user-search')?.value || '';
    const role = document.getElementById('user-role-filter')?.value || '';
    const verification = new URLSearchParams(window.location.search).get('verification') || '';
    const url = \`/api/users?limit=50\${search ? '&search=' + encodeURIComponent(search) : ''}\${role ? '&role=' + role : ''}\${verification ? '&verification=' + encodeURIComponent(verification) : ''}\`;
    const data = await api(url);
    if (data.items.length === 0) { tbody.innerHTML = '<tr><td colspan="7">No users found</td></tr>'; return; }
    tbody.innerHTML = data.items.map(u => {
      const pendingVerification = u.verificationRequestStatus === 'pending';
      const rowClass = pendingVerification ? ' class="row-highlight"' : '';
      const verificationPill = pendingVerification ? ' <span class="vox-badge status-badge pending">Verification pending</span>' : '';
      return \`<tr\${rowClass}><td>\${escapeHtml(u.email)}\${verificationPill}</td><td>\${escapeHtml(u.name || '-')}</td><td>\${u.roles.map(r => \`<span class="vox-badge status-badge \${r}">\${r}</span>\`).join(' ')}</td><td>\${u.verified ? '<span class="vox-badge status-badge approved" title="Verified">✓ Verified</span>' : '<span class="vox-badge status-badge" style="background:var(--bg-elevated);color:var(--text-muted)">Unverified</span>'}</td><td>\${u.organizationIds.length}</td><td>\${formatDate(u.createdAt)}</td><td><a href="/users/\${u.id}" class="vox-btn btn btn-sm btn-secondary">View</a></td></tr>\`;
    }).join('');
  } catch (e) { tbody.innerHTML = \`<tr><td colspan="7">Error: \${e.message}</td></tr>\`; }
}

async function loadUserDetail(userId) {
  const container = document.getElementById('user-detail-content');
  if (!container) return;
  try {
    const { user } = await api(\`/api/users/\${userId}\`);
    const isVerified = !!user.verified;
    const verificationPending = user.verificationRequestStatus === 'pending';
    const verificationActions = verificationPending ? \`
        <div class="request-actions" style="margin-top:1rem">
          <button id="btn-approve-verification" class="vox-btn vox-btn-primary btn btn-primary" data-userid="\${escapeHtml(user.id)}">Approve verification</button>
          <button id="btn-reject-verification" class="vox-btn btn btn-secondary" data-userid="\${escapeHtml(user.id)}">Reject request</button>
        </div>\` : '';
    container.innerHTML = \`
      <div class="request-card\${verificationPending ? ' row-highlight' : ''}">
        <div class="request-header">
          <div>
            <div class="request-title">\${escapeHtml(user.email)}</div>
            <p style="color:var(--text-secondary)">\${escapeHtml(user.name || 'No name set')}</p>
          </div>
          \${verificationPending ? '<span class="vox-badge status-badge pending">Verification pending</span>' : isVerified
            ? '<span class="vox-badge status-badge approved">✓ Verified</span>'
            : '<span class="vox-badge status-badge" style="background:var(--bg-elevated);color:var(--text-muted)">Unverified</span>'}
        </div>
        <p><strong>ID:</strong> \${escapeHtml(user.id)}</p>
        <p><strong>Roles:</strong> \${user.roles.map(r => \`<span class="vox-badge status-badge \${r}">\${r}</span>\`).join(' ')}</p>
        <p><strong>Website:</strong> \${user.website ? '<a href="' + escapeHtml(user.website) + '" target="_blank" rel="noopener">' + escapeHtml(user.website) + '</a>' : '-'}</p>
        <p><strong>Bio:</strong> \${escapeHtml(user.bio || '-')}</p>
        <p><strong>Verification request:</strong> \${escapeHtml(user.verificationRequestStatus || 'none')}</p>
        <p><strong>Requested at:</strong> \${user.verificationRequestedAt ? formatDate(user.verificationRequestedAt) : '-'}</p>
        <p><strong>Organizations:</strong> \${user.organizationIds.length}</p>
        <p><strong>Created:</strong> \${formatDate(user.createdAt)}</p>
        <p><strong>Updated:</strong> \${formatDate(user.updatedAt)}</p>
        \${verificationActions}
        <div class="request-actions" style="margin-top:1.5rem">
          <button id="btn-toggle-verify" class="vox-btn btn \${isVerified ? 'btn-secondary' : 'vox-btn-primary btn-primary'}" data-verified="\${isVerified}" data-userid="\${escapeHtml(user.id)}">
            \${isVerified ? 'Unverify user' : 'Verify user'}
          </button>
          <a href="/users" class="vox-btn btn btn-secondary">Back to users</a>
        </div>
      </div>
    \`;
    document.getElementById('btn-approve-verification')?.addEventListener('click', async function() {
      const uid = this.dataset.userid;
      this.disabled = true;
      try {
        await api(\`/api/users/\${uid}\`, { method: 'PUT', body: JSON.stringify({ verified: true }) });
        loadUserDetail(uid);
        loadNavBadges();
      } catch (e) {
        alert('Error: ' + e.message);
        loadUserDetail(uid);
      }
    });
    document.getElementById('btn-reject-verification')?.addEventListener('click', async function() {
      const uid = this.dataset.userid;
      this.disabled = true;
      try {
        await api(\`/api/users/\${uid}\`, { method: 'PUT', body: JSON.stringify({ verificationRequestStatus: 'rejected' }) });
        loadUserDetail(uid);
        loadNavBadges();
      } catch (e) {
        alert('Error: ' + e.message);
        loadUserDetail(uid);
      }
    });
    document.getElementById('btn-toggle-verify')?.addEventListener('click', async function() {
      const uid = this.dataset.userid;
      const currently = this.dataset.verified === 'true';
      this.disabled = true;
      this.textContent = 'Saving…';
      try {
        await api(\`/api/users/\${uid}\`, { method: 'PUT', body: JSON.stringify({ verified: !currently }) });
        loadUserDetail(uid);
      } catch (e) {
        alert('Error: ' + e.message);
        loadUserDetail(uid);
      }
    });
  } catch (e) { container.innerHTML = \`<p style="color:var(--accent-danger)">Error: \${e.message}</p>\`; }
}

async function loadOrganizations() {
  const tbody = document.getElementById('orgs-table-body');
  if (!tbody) return;
  try {
    const data = await api('/api/organizations');
    if (data.items.length === 0) { tbody.innerHTML = '<tr><td colspan="6">No organizations found</td></tr>'; return; }
    tbody.innerHTML = data.items.map(o => \`<tr><td>\${escapeHtml(o.name)}</td><td><a href="\${escapeHtml(o.website)}" target="_blank">\${escapeHtml(o.website)}</a></td><td><span class="vox-badge status-badge \${o.vettingStatus.toLowerCase()}">\${o.vettingStatus}</span></td><td>\${o.memberCount || 0}</td><td>\${formatDate(o.createdAt)}</td><td><a href="/organizations/\${o.id}" class="vox-btn btn btn-sm btn-secondary">View</a></td></tr>\`).join('');
  } catch (e) { tbody.innerHTML = \`<tr><td colspan="6">Error: \${e.message}</td></tr>\`; }
}

async function loadOrganizationDetail(orgId) {
  const container = document.getElementById('org-detail-content');
  if (!container) return;
  try {
    const { org, members, events } = await api(\`/api/organizations/\${orgId}\`);
    const memberList = members.length
      ? members.map(member => \`<div class="mini-row"><strong>\${escapeHtml(member.name || member.email)}</strong><p>\${escapeHtml(member.email)}</p></div>\`).join('')
      : '<p class="help-text">No members found.</p>';
    const eventList = events.length
      ? events.map(event => \`<div class="mini-row"><strong>\${escapeHtml(event.title)}</strong><p>\${formatDate(event.startsAt)} · <span class="vox-badge status-badge \${event.status}">\${escapeHtml(event.status)}</span></p></div>\`).join('')
      : '<p class="help-text">No events found for this organization.</p>';
    container.innerHTML = \`
      <div class="detail-grid">
        <section class="request-card detail-stack">
          <div>
            <div class="request-title">\${escapeHtml(org.name)}</div>
            <p class="help-text">Organization profile and governance summary</p>
          </div>
          <div class="meta-list">
            <p><strong>Website:</strong> <a href="\${escapeHtml(org.website)}" target="_blank">\${escapeHtml(org.website)}</a></p>
            <p><strong>Status:</strong> <span class="vox-badge status-badge \${org.vettingStatus.toLowerCase()}">\${escapeHtml(org.vettingStatus)}</span></p>
            <p><strong>Event mode:</strong> \${escapeHtml(org.eventMode)}</p>
            <p><strong>Activities:</strong> \${formatArray(org.activities || [])}</p>
            <p><strong>Motto:</strong> \${escapeHtml(org.motto || '-')}</p>
            <p><strong>Voxon affiliated:</strong> \${org.voxonAffiliated ? 'Yes' : 'No'}</p>
            <p><strong>Created:</strong> \${formatDate(org.createdAt)}</p>
          </div>
          <div>
            <h3>Description</h3>
            <p>\${escapeHtml(org.description || 'No description provided.')}</p>
          </div>
        </section>
        <div class="detail-stack">
          <section class="vox-card request-card">
            <h3>Members</h3>
            <div class="mini-list">\${memberList}</div>
          </section>
          <section class="vox-card request-card">
            <h3>Events</h3>
            <div class="mini-list">\${eventList}</div>
          </section>
        </div>
      </div>\`;
  } catch (e) { container.innerHTML = \`<p style="color:var(--accent-danger)">Error: \${e.message}</p>\`; }
}

async function loadEvents() {
  const tbody = document.getElementById('events-table-body');
  if (!tbody) return;
  try {
    const status = document.getElementById('event-status-filter')?.value || '';
    const url = \`/api/events\${status ? '?status=' + status : ''}\`;
    const data = await api(url);
    if (data.items.length === 0) { tbody.innerHTML = '<tr><td colspan="5">No events found</td></tr>'; return; }
    tbody.innerHTML = data.items.map(e => \`<tr><td>\${escapeHtml(e.title)}</td><td>\${escapeHtml(e.organizationName || '-')}</td><td><span class="vox-badge status-badge \${e.status}">\${e.status}</span></td><td>\${formatDate(e.startsAt)}</td><td><a href="/events/\${e.id}" class="vox-btn btn btn-sm btn-secondary">View</a></td></tr>\`).join('');
  } catch (e) { tbody.innerHTML = \`<tr><td colspan="5">Error: \${e.message}</td></tr>\`; }
}

async function loadEventDetail(eventId) {
  const container = document.getElementById('event-detail-content');
  if (!container) return;
  try {
    const { event, org } = await api(\`/api/events/\${eventId}\`);
    const speakerList = event.speakers && event.speakers.length
      ? event.speakers.map(speaker => \`<div class="mini-row"><strong>\${escapeHtml(speaker.name)}</strong><p>\${escapeHtml(speaker.bio || 'No bio provided.')}</p></div>\`).join('')
      : '<p class="help-text">No speaker list configured.</p>';
    const agendaList = event.agenda && event.agenda.length
      ? event.agenda.map(item => \`<div class="mini-row"><strong>\${escapeHtml(item.time)} · \${escapeHtml(item.title)}</strong><p>\${escapeHtml(item.description || '')}</p></div>\`).join('')
      : '<p class="help-text">No agenda items configured.</p>';
    container.innerHTML = \`
      <div class="detail-grid">
        <section class="request-card detail-stack">
          <div>
            <div class="request-title">\${escapeHtml(event.title)}</div>
            <p class="help-text">Moderation view for event metadata and delivery details</p>
          </div>
          <div class="meta-list">
            <p><strong>Organization:</strong> \${escapeHtml((org && org.name) || 'Unknown organization')}</p>
            <p><strong>Status:</strong> <span class="vox-badge status-badge \${event.status}">\${escapeHtml(event.status)}</span></p>
            <p><strong>Mode:</strong> \${escapeHtml(event.mode)}</p>
            <p><strong>Starts:</strong> \${formatDate(event.startsAt)}</p>
            <p><strong>Ends:</strong> \${formatDate(event.endsAt)}</p>
            <p><strong>Location:</strong> \${escapeHtml(event.location || '-')}</p>
            <p><strong>Online URL:</strong> \${event.onlineUrl ? \`<a href="\${escapeHtml(event.onlineUrl)}" target="_blank">Open link</a>\` : '-'}</p>
            <p><strong>Capacity:</strong> \${event.minSeats || 0} - \${event.maxSeats || 0}</p>
          </div>
          <div>
            <h3>Description</h3>
            <p>\${escapeHtml(event.description || 'No description provided.')}</p>
          </div>
        </section>
        <div class="detail-stack">
          <section class="vox-card request-card">
            <h3>Speakers</h3>
            <div class="mini-list">\${speakerList}</div>
          </section>
          <section class="vox-card request-card">
            <h3>Agenda</h3>
            <div class="mini-list">\${agendaList}</div>
          </section>
        </div>
      </div>\`;
  } catch (e) { container.innerHTML = \`<p style="color:var(--accent-danger)">Error: \${e.message}</p>\`; }
}

async function loadOrgRequests() {
  const container = document.getElementById('org-requests-list');
  if (!container) return;
  try {
    const status = document.getElementById('request-status-filter')?.value || '';
    const url = \`/api/org-requests\${status ? '?status=' + status : ''}\`;
    const data = await api(url);
    if (data.items.length === 0) { container.innerHTML = '<p>No organization requests found</p>'; return; }
    container.innerHTML = data.items.map(r => \`<div class="vox-card request-card"><div class="request-header"><div><div class="request-title">\${escapeHtml(r.organizationName)}</div><p>\${escapeHtml(r.description.substring(0, 100))}...</p></div><span class="vox-badge status-badge \${r.status.toLowerCase()}">\${r.status}</span></div><p><strong>Contact:</strong> \${escapeHtml(r.contactEmail)}</p><p><strong>Website:</strong> <a href="\${escapeHtml(r.website)}" target="_blank">\${escapeHtml(r.website)}</a></p><p><strong>Activities:</strong> \${(r.activities || []).map(a => escapeHtml(a)).join(', ')}</p><p><strong>Motto:</strong> \${escapeHtml(r.motto)}</p><p><strong>Voxon Affiliated:</strong> \${r.voxonAffiliated ? 'Yes' : 'No'}</p>\${r.status === 'PENDING' || r.status === 'INFO_REQUESTED' ? \`<div class="request-actions"><button onclick="handleOrgDecision('\${r.id}', 'APPROVED')" class="vox-btn vox-btn-primary btn btn-primary">Approve</button><button onclick="handleOrgDecision('\${r.id}', 'REJECTED')" class="vox-btn btn btn-danger">Reject</button><button onclick="handleOrgDecision('\${r.id}', 'INFO_REQUESTED')" class="vox-btn btn btn-secondary">Request Info</button></div>\` : ''}\${r.latestNote ? \`<p><strong>Note:</strong> \${escapeHtml(r.latestNote)}</p>\` : ''}</div>\`).join('');
  } catch (e) { container.innerHTML = \`<p>Error: \${e.message}</p>\`; }
}

async function handleOrgDecision(requestId, status) {
  const note = prompt(status === 'INFO_REQUESTED' ? 'Enter information request details:' : 'Enter optional note:');
  if (status !== 'APPROVED' && note === null) return;
  try {
    await api(\`/api/org-requests/\${requestId}/decision\`, { method: 'PUT', body: JSON.stringify({ status, note }) });
    alert('Decision saved successfully');
    loadOrgRequests();
    loadDashboard();
  } catch (e) { alert('Error: ' + e.message); }
}

async function loadAuditLogs() {
  const tbody = document.getElementById('audit-table-body');
  if (!tbody) return;
  try {
    const action = document.getElementById('audit-action-filter')?.value || '';
    const url = \`/api/audit-logs\${action ? '?action=' + action : ''}\`;
    const data = await api(url);
    if (data.items.length === 0) { tbody.innerHTML = '<tr><td colspan="5">No audit logs found</td></tr>'; return; }
    tbody.innerHTML = data.items.map(log => \`<tr><td>\${formatDate(log.createdAt)}</td><td><span class="vox-badge status-badge">\${log.action.replace(/_/g, ' ')}</span></td><td>\${escapeHtml(log.actor)}</td><td>\${escapeHtml(log.targetName)}</td><td>\${log.details ? '<button onclick="alert(this.dataset.details)" data-details="\${escapeHtml(log.details)}" class="vox-btn btn btn-sm btn-secondary">View</button>' : '-'}</td></tr>\`).join('');
  } catch (e) { tbody.innerHTML = \`<tr><td colspan="5">Error: \${e.message}</td></tr>\`; }
}

async function loadSettings() {
  try {
    const { settings } = await api('/api/settings');
    document.getElementById('admin-emails').value = settings.adminEmails || '';
    document.getElementById('notice-banner').value = settings.noticeBanner || '';
    document.getElementById('pause-org-requests').checked = settings.pauseOrgRequests;
    document.getElementById('pause-registrations').checked = settings.pauseRegistrations;
    const social = settings.socialLinks || {};
    document.getElementById('social-x').value = social.x || '';
    document.getElementById('social-discord').value = social.discord || '';
    document.getElementById('social-telegram').value = social.telegram || '';
    document.getElementById('social-linkedin').value = social.linkedin || '';
    document.getElementById('social-facebook').value = social.facebook || '';
  } catch (e) { console.error('Failed to load settings:', e); }
}

async function saveSettings(e) {
  e.preventDefault();
  try {
    const settings = {
      adminEmails: document.getElementById('admin-emails').value,
      noticeBanner: document.getElementById('notice-banner').value,
      pauseOrgRequests: document.getElementById('pause-org-requests').checked,
      pauseRegistrations: document.getElementById('pause-registrations').checked,
      socialLinks: {
        x: document.getElementById('social-x').value.trim(),
        discord: document.getElementById('social-discord').value.trim(),
        telegram: document.getElementById('social-telegram').value.trim(),
        linkedin: document.getElementById('social-linkedin').value.trim(),
        facebook: document.getElementById('social-facebook').value.trim(),
      },
    };
    await api('/api/settings', { method: 'PUT', body: JSON.stringify(settings) });
    alert('Settings saved successfully');
  } catch (e) { alert('Error: ' + e.message); }
}

function applyVoxFormClasses(root) {
  const container = root || document;
  container.querySelectorAll('.form-group, .field').forEach((field) => {
    field.classList.add('vox-vbox');
    field.querySelectorAll(':scope > label:not(.vox-label)').forEach((label) => {
      if (!label.querySelector('input[type="checkbox"], input[type="radio"]') || label.classList.contains('vox-label')) {
        label.classList.add('vox-label');
      }
    });
  });
  container.querySelectorAll('label').forEach((label) => {
    const cb = label.querySelector('input[type="checkbox"]');
    const radio = label.querySelector('input[type="radio"]');
    if (cb || radio) label.classList.add('vox-label');
    if (cb) cb.classList.add('vox-checkbox');
    if (radio) radio.classList.add('vox-radio');
  });
  container.querySelectorAll('input:not([type="checkbox"]):not([type="radio"]):not([type="file"]), textarea, select').forEach((el) => {
    if (el.tagName === 'TEXTAREA') el.classList.add('vox-textarea');
    else if (el.tagName === 'SELECT') el.classList.add('vox-select');
    else if (el.tagName === 'INPUT') el.classList.add('vox-input');
  });
}

document.addEventListener('DOMContentLoaded', () => {
  applyVoxFormClasses(document);
  loadNavBadges();
  const path = window.location.pathname;
  if (path === '/' || path === '') { loadDashboard(); loadRecentActivity(); }
  else if (path === '/users' || path === '/users/') { loadUsers(); document.getElementById('user-search')?.addEventListener('input', debounce(loadUsers, 300)); document.getElementById('user-role-filter')?.addEventListener('change', loadUsers); }
  else if (path.startsWith('/users/') && path.split('/').length === 3) { const userId = path.split('/')[2]; if (userId) loadUserDetail(userId); }
  else if (path === '/organizations' || path === '/organizations/') { loadOrganizations(); }
  else if (path.startsWith('/organizations/') && path.split('/').length === 3) { const orgId = path.split('/')[2]; if (orgId) loadOrganizationDetail(orgId); }
  else if (path === '/events' || path === '/events/') { loadEvents(); document.getElementById('event-status-filter')?.addEventListener('change', loadEvents); }
  else if (path.startsWith('/events/') && path.split('/').length === 3) { const eventId = path.split('/')[2]; if (eventId) loadEventDetail(eventId); }
  else if (path === '/org-requests' || path === '/org-requests/') { loadOrgRequests(); document.getElementById('request-status-filter')?.addEventListener('change', loadOrgRequests); }
  else if (path === '/audit-logs' || path === '/audit-logs/') { loadAuditLogs(); document.getElementById('audit-action-filter')?.addEventListener('change', loadAuditLogs); }
  else if (path === '/settings' || path === '/settings/') { loadSettings(); document.getElementById('settings-form')?.addEventListener('submit', saveSettings); }
});

function debounce(fn, ms) {
  let timeout;
  return (...args) => { clearTimeout(timeout); timeout = setTimeout(() => fn(...args), ms); };
}
`;
}

function escapeHtml(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

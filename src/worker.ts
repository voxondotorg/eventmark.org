/**
 * EventMark Worker — routing, Turnstile, sessions, KV, email (Cloudflare Send Email).
 */

import indexHtml from "./index.html";
import stylesCss from "./styles.css";
// Classic browser script (IIFE); Wrangler inlines it as text. Excluded from `tsc` program (see tsconfig).
// @ts-expect-error TS7016 — excluded `src/app.js` cannot carry module typings without breaking the browser bundle
import appJs from "./app.js";
import logoWhiteSvg from "./assets/logo-white.svg";
import logoBlackSvg from "./assets/logo-black.svg";
import eventBannerDefaultJpg from "./assets/event-banner-default.jpg";
// @ts-expect-error TS7016 — vendored browser bundle served as static JS
import jsqrJs from "./assets/jsqr.js";
// @ts-expect-error TS7016 — country list for searchable event location picker
import countriesJs from "./assets/countries.js";
import mitLicenseText from "./legal/mit-license.txt";
import type { AuthEnv } from "./auth.js";
import {
  clearSessionCookieHeader,
  consumeOrgRequestVerification,
  issueOrgRequestOtp,
  issueOtp,
  logout,
  resolveSessionUser,
  sendRegistrationEmail,
  sendEventCampaignEmail,
  sessionCookieHeader,
  verifyOrgRequestOtp,
  verifyOtpAndCreateSession,
  verifyTurnstile,
} from "./auth.js";
import { generateTicketCode, isCode39Compatible, renderCode39Svg } from "./barcode.js";
import {
  decideOrgRequest,
  listAdminOrgRequests,
  notifyOrgRequestSubmitted,
  notifyUserVerificationSubmitted,
  submitOrgRequest,
  updateOrgRequest,
} from "./org-requests.js";
import type {
  OrgRequestDecisionBody,
  OrgRequestMailUrls,
  OrgRequestSubmitBody,
} from "./org-requests.js";
import type {
  ContributionReviewBody,
  ContributionSubmitBody,
  ContributionUpdateBody,
} from "./contributions.js";
import {
  handleContributionReview,
  handleContributionSubmit,
  handleContributionUpdateByUser,
  listContributionsForOrganizer,
} from "./contributions.js";
import type {
  EventRecord,
  InterestRecord,
  UserRecord,
  RegistrationRecord,
  RsvpStatus,
} from "./db.js";
import {
  clampCalendarRange,
  parseCalendarRegion,
  utcDateKeyFromIso,
} from "./calendar-helpers.js";
import {
  countEvents,
  DEFAULT_SETTINGS,
  deleteRegistration,
  deleteEvent,
  deleteInterest,
  deleteWaitlist,
  getEvent,
  getEventBannerMeta,
  incrementEventViewCount,
  isEventEditable,
  getLatestOrgRequestForUser,
  getOrg,
  getRegistration,
  getRsvp,
  getSettings,
  getTicket,
  getUserById,
  getWaitlist,
  listEvents,
  listEventsForCalendar,
  listInterestsForUser,
  listRsvpsForEvent,
  listRsvpsForUser,
  listWaitlistForEvent,
  listWaitlistForUser,
  listContributionsForUser,
  listRegistrationsForEvent,
  listRegistrationsForUser,
  listContributionsForEvent,
  getContribution,
  nowIso,
  randomId,
  saveRsvp,
  saveEvent,
  saveEventBanner,
  saveInterest,
  saveRegistration,
  saveSettings,
  saveTicket,
  saveUser,
  saveWaitlist,
  searchEvents,
  tryReserveEventSeat,
} from "./db.js";
import type {
  EventCategory,
  EventMode,
  EventStatus,
  SettingsRecord,
  SpeakerSummary,
} from "./db.js";
import { validateBannerImage } from "./banner-image.js";
import { applySecurityHeaders, securityProfileFor } from "./security-headers.js";
import {
  addBooth,
  addSession,
  addSpeakerSlot,
  checkInByPassToken,
  getBranding,
  getInvite,
  importInvites,
  issuePassForInvite,
  listBooths,
  listInvitesForEvent,
  listSessions,
  listSpeakerSlots,
  saveBranding,
  updateInviteRsvp,
  verifyPassToken,
  type InviteRole,
} from "./invitation-platform.js";

/** Omit placeholder / invalid keys so the client does not load Turnstile with a broken sitekey (avoids 400 / 400020 noise). */
function turnstileSiteKeyForClient(raw: string | undefined): string {
  const sk = (raw || "").trim();
  if (!sk || sk.toLowerCase().includes("replace")) return "";
  if (sk.length < 10) return "";
  return sk;
}

export interface Env extends AuthEnv {
  TURNSTILE_SITE_KEY: string;
  TURNSTILE_SECRET_KEY: string;
  /** Comma-separated bootstrap admin emails (optional) */
  ADMIN_EMAILS: string;
  /** Public app origin for links in transactional email (optional; falls back to request origin). */
  PUBLIC_SITE_URL?: string;
  /** Admin portal origin for review-queue links in email (optional). */
  ADMIN_PORTAL_URL?: string;
  /** Set to "1" only on Zero Trust protected admin host/app. */
  ADMIN_SURFACE_PUBLIC?: string;
  INVITE_PASS_SECRET?: string;
  /** Set to "1" or "true" in .dev.vars for local wrangler dev only. */
  LOCAL_DEV?: string;
}

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
} as const;

const recentCheckinTokenSeen = new Map<string, number>();

function adminSurfaceEnabled(env: Env): boolean {
  return String(env.ADMIN_SURFACE_PUBLIC || "").trim() === "1";
}

function json(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { ...JSON_HEADERS, ...init?.headers },
  });
}

async function parseAdminEmails(env: Env): Promise<Set<string>> {
  const settings = await getSettings(env.KV);
  // Settings (KV) wins over wrangler var so admins can edit live.
  const raw = settings.adminEmails || env.ADMIN_EMAILS || "";
  return new Set(
    raw
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean)
  );
}

async function applyAdminBootstrap(env: Env, user: UserRecord): Promise<UserRecord> {
  const admins = await parseAdminEmails(env);
  if (!admins.has(user.email.toLowerCase())) return user;
  if (user.roles.includes("admin")) return user;
  const next: UserRecord = {
    ...user,
    roles: [...user.roles, "admin"],
    updatedAt: nowIso(),
  };
  await saveUser(env.KV, next);
  return next;
}

function invitePassSecret(env: Env): string {
  const secret = (env.INVITE_PASS_SECRET || env.TURNSTILE_SECRET_KEY || "").trim();
  if (!secret && !isLocalDev(env)) {
    throw new Error("INVITE_PASS_SECRET is not configured");
  }
  return secret || "eventmark-invite-local-only";
}

function isHttpUrl(value: string | null | undefined): boolean {
  if (!value) return false;
  try {
    const u = new URL(String(value));
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function eventShareLinks(
  ev: EventRecord,
  baseUrl: URL
): {
  eventUrl: string;
  text: string;
  links: Record<string, string>;
} {
  const eventUrl = `${baseUrl.protocol}//${baseUrl.host}/#/event/${encodeURIComponent(ev.id)}`;
  const text = `${ev.title} on EventMark`;
  const details = `${ev.title}\n${ev.startsAt} - ${ev.endsAt}\n${eventUrl}`;
  return {
    eventUrl,
    text,
    links: {
      x: `https://x.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(eventUrl)}`,
      linkedin: `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(eventUrl)}`,
      facebook: `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(eventUrl)}`,
      whatsapp: `https://wa.me/?text=${encodeURIComponent(`${text} ${eventUrl}`)}`,
      email: `mailto:?subject=${encodeURIComponent(`Event invite: ${ev.title}`)}&body=${encodeURIComponent(details)}`,
    },
  };
}

function csvCell(v: unknown): string {
  const s = String(v ?? "");
  if (s.includes(",") || s.includes("\"") || s.includes("\n")) {
    return `"${s.replace(/\"/g, '""')}"`;
  }
  return s;
}

async function requireEventOrganizerOrAdmin(
  env: Env,
  request: Request,
  eventId: string
): Promise<{ ok: true; user: UserRecord; event: EventRecord } | { ok: false; response: Response }> {
  const sessionUser = await resolveSessionUser(env.KV, request.headers.get("Cookie"));
  if (!sessionUser) return { ok: false, response: json({ error: "unauthorized" }, { status: 401 }) };
  const user = await applyAdminBootstrap(env, sessionUser);
  const ev = await getEvent(env.KV, eventId);
  if (!ev) return { ok: false, response: json({ error: "not_found" }, { status: 404 }) };
  if (!user.organizationIds.includes(ev.organizationId) && !user.roles.includes("admin")) {
    return { ok: false, response: json({ error: "forbidden" }, { status: 403 }) };
  }
  return { ok: true, user, event: ev };
}

async function readJson<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}

function getUrl(request: Request): URL {
  return new URL(request.url);
}

function siteOrigin(url: URL): string {
  return `${url.protocol}//${url.host}`;
}

function orgRequestMailUrls(env: Env, requestUrl: URL): OrgRequestMailUrls {
  const siteUrl = (env.PUBLIC_SITE_URL || "").trim() || siteOrigin(requestUrl);
  const adminPortalUrl =
    (env.ADMIN_PORTAL_URL || "").trim() ||
    siteUrl.replace(/\/\/([^.]+)\./, "//$1.admin.");
  return { siteUrl, adminPortalUrl };
}

function isLocalDev(env: { LOCAL_DEV?: string; ENVIRONMENT?: string }): boolean {
  const flag = (env.LOCAL_DEV || "").trim().toLowerCase();
  return flag === "1" || flag === "true" || flag === "yes";
}

function pathParts(pathname: string): string[] {
  return pathname.split("/").filter(Boolean);
}

async function requireTurnstile(
  env: Env,
  _request: Request,
  token: string | undefined
): Promise<boolean> {
  const localDev = isLocalDev(env);
  if (!token) {
    if (localDev) {
      console.warn("[EventMark] Turnstile token missing; bypassing in local dev.");
      return true;
    }
    return false;
  }
  const ok = await verifyTurnstile(env.TURNSTILE_SECRET_KEY, token);
  if (!ok && localDev) {
    console.warn("[EventMark] Turnstile verification failed; bypassing in local dev.");
    return true;
  }
  return ok;
}

async function dispatch(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const url = getUrl(request);
  const { pathname } = url;
  const method = request.method.toUpperCase();
  const secure = url.protocol === "https:";

  if (method === "GET" && pathname === "/") {
    return new Response(indexHtml, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
  if (method === "GET" && pathname === "/styles.css") {
    return new Response(stylesCss, {
      headers: { "content-type": "text/css; charset=utf-8" },
    });
  }
  if (method === "GET" && pathname === "/app.js") {
    return new Response(appJs, {
      headers: {
        "content-type": "application/javascript; charset=utf-8",
        "cache-control": "no-cache",
      },
    });
  }
  if (method === "GET" && pathname === "/assets/logo-white.svg") {
    return new Response(logoWhiteSvg, {
      headers: { "content-type": "image/svg+xml; charset=utf-8" },
    });
  }
  if (method === "GET" && pathname === "/assets/logo-black.svg") {
    return new Response(logoBlackSvg, {
      headers: { "content-type": "image/svg+xml; charset=utf-8" },
    });
  }
  if (method === "GET" && pathname === "/assets/favicon.svg") {
    return new Response(logoWhiteSvg, {
      headers: { "content-type": "image/svg+xml; charset=utf-8" },
    });
  }
  if (method === "GET" && pathname === "/assets/event-banner-default.jpg") {
    return new Response(eventBannerDefaultJpg, {
      headers: {
        "content-type": "image/jpeg",
        "cache-control": "public, max-age=86400",
      },
    });
  }
  if (method === "GET" && pathname === "/assets/jsqr.js") {
    return new Response(jsqrJs, {
      headers: {
        "content-type": "application/javascript; charset=utf-8",
        "cache-control": "public, max-age=86400",
      },
    });
  }
  if (method === "GET" && pathname === "/assets/countries.js") {
    return new Response(countriesJs, {
      headers: {
        "content-type": "application/javascript; charset=utf-8",
        "cache-control": "public, max-age=86400",
      },
    });
  }
  if (method === "GET" && pathname === "/license") {
    return new Response(mitLicenseText, {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "public, max-age=86400",
      },
    });
  }

  if (pathname.startsWith("/api/")) {
    return handleApi(request, env, ctx, secure);
  }

  /* --- DEV-ONLY email smoke test: GET /__test-email?to=you@example.com --- */
  if (method === "GET" && pathname === "/__test-email") {
    if (!isLocalDev(env)) {
      return new Response("Not Found", { status: 404 });
    }
    const to = new URL(request.url).searchParams.get("to");
    if (!to) return new Response("Missing ?to= param", { status: 400 });
    try {
      const result = await (env as unknown as { EMAIL: { send(p: object): Promise<{ messageId: string }> } }).EMAIL.send({
        to,
        from: (env as unknown as { FROM_ADDRESS?: string }).FROM_ADDRESS || "noreply@example.com",
        subject: "EventMark email test",
        text: "If you see this, Cloudflare Email Service is working correctly for EventMark.",
        html: "<p>If you see this, <strong>Cloudflare Email Service</strong> is working correctly for EventMark.</p>",
      });
      return new Response(`Email sent OK. messageId: ${result.messageId}`, { status: 200 });
    } catch (err) {
      return new Response(`Send failed: ${err instanceof Error ? err.message : String(err)}`, { status: 502 });
    }
  }

  if (method === "GET") {
    return new Response(indexHtml, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  return new Response("Not Found", { status: 404 });
}

async function promoteNextWaitlistedAttendee(
  env: Env,
  event: EventRecord,
  baseUrl: URL
): Promise<{ promoted: boolean; userId?: string }> {
  const maxSeats = event.max_seats ?? 0;
  if (maxSeats > 0) {
    const regs = await listRegistrationsForEvent(env.KV, event.id);
    if (regs.length >= maxSeats) return { promoted: false };
  } else {
    return { promoted: false };
  }

  const queue = await listWaitlistForEvent(env.KV, event.id);
  if (!queue.length) return { promoted: false };

  const next = queue[0];
  const existingReg = await getRegistration(env.KV, event.id, next.userId);
  if (existingReg) {
    await deleteWaitlist(env.KV, event.id, next.userId, next.createdAt);
    return { promoted: false };
  }

  const reserved = await tryReserveEventSeat(env.KV, event.id, next.userId, maxSeats);
  if (!reserved.ok) return { promoted: false };

  const ticketCode = generateTicketCode();
  const reg: RegistrationRecord = {
    id: randomId(),
    eventId: event.id,
    userId: next.userId,
    type: "native",
    createdAt: nowIso(),
    ticketCode,
  };
  await saveRegistration(env.KV, reg);
  await saveTicket(env.KV, ticketCode, {
    eventId: event.id,
    userId: next.userId,
    registrationId: reg.id,
  });
  await deleteWaitlist(env.KV, event.id, next.userId, next.createdAt);

  const targetUser = await getUserById(env.KV, next.userId);
  if (targetUser) {
    try {
      const origin = `${baseUrl.protocol}//${baseUrl.host}`;
      await sendRegistrationEmail(env, targetUser.email, {
        eventTitle: event.title,
        eventStartsAt: event.startsAt,
        eventLocation: event.location,
        eventMode: event.mode ?? "in_person",
        onlineUrl: event.online_url ?? null,
        ticketCode,
        ticketUrl: `${origin}/api/tickets/${ticketCode}/barcode.svg`,
      });
    } catch {
      // Non-fatal: promotion succeeded even if mail delivery fails.
    }
  }

  return { promoted: true, userId: next.userId };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const isHttps = new URL(request.url).protocol === "https:";
    const res = await dispatch(request, env, ctx);
    return applySecurityHeaders(res, securityProfileFor(request), { isHttps });
  },
};

async function handleApi(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
  secure: boolean
): Promise<Response> {
  const url = getUrl(request);
  const parts = pathParts(url.pathname);
  const method = request.method.toUpperCase();

  if (parts[0] === "api" && parts[1] === "admin" && !adminSurfaceEnabled(env)) {
    return json({ error: "not_found" }, { status: 404 });
  }

  if (method === "GET" && parts[0] === "api" && parts[1] === "config") {
    const settings = await getSettings(env.KV);
    return json({
      turnstileSiteKey: turnstileSiteKeyForClient(env.TURNSTILE_SITE_KEY),
      environment: env.ENVIRONMENT,
      noticeBanner: settings.noticeBanner,
    });
  }

  if (method === "GET" && parts[0] === "api" && parts[1] === "health") {
    return json(
      {
        ok: true,
        service: "eventmark",
        environment: env.ENVIRONMENT,
      },
      {
        headers: {
          "cache-control": "no-store",
        },
      }
    );
  }

  if (method === "GET" && parts[0] === "api" && parts[1] === "me" && parts.length === 2) {
    const user = await resolveSessionUser(env.KV, request.headers.get("Cookie"));
    if (!user) return json({ user: null });
    const u = await applyAdminBootstrap(env, user);
    return json({ user: u });
  }

  if (method === "PATCH" && parts[0] === "api" && parts[1] === "me" && parts.length === 2) {
    const user = await resolveSessionUser(env.KV, request.headers.get("Cookie"));
    if (!user) return json({ error: "unauthorized" }, { status: 401 });
    const body = await readJson<{ name?: string; bio?: string; website?: string }>(request);
    if (!body) return json({ error: "invalid_body" }, { status: 400 });
    const hasAny = typeof body.name === "string" || typeof body.bio === "string" || typeof body.website === "string";
    if (!hasAny) return json({ error: "invalid_body" }, { status: 400 });
    const nextName = typeof body.name === "string" ? body.name.trim() : user.name || "";
    const nextBio = typeof body.bio === "string" ? body.bio.trim() : user.bio || "";
    const nextWebsite = typeof body.website === "string" ? body.website.trim() : user.website || "";
    if (!nextName) return json({ error: "name_required" }, { status: 400 });
    if (nextWebsite) {
      try {
        const u = new URL(nextWebsite);
        if (u.protocol !== "http:" && u.protocol !== "https:") {
          return json({ error: "invalid_url" }, { status: 400 });
        }
      } catch {
        return json({ error: "invalid_url" }, { status: 400 });
      }
    }
    const updated: UserRecord = {
      ...user,
      name: nextName,
      bio: nextBio || undefined,
      website: nextWebsite || undefined,
      updatedAt: new Date().toISOString(),
    };
    await saveUser(env.KV, updated);
    return json({ user: updated });
  }

  if (method === "POST" && parts[0] === "api" && parts[1] === "me" && parts[2] === "verification-apply") {
    const user = await resolveSessionUser(env.KV, request.headers.get("Cookie"));
    if (!user) return json({ error: "unauthorized" }, { status: 401 });
    if (user.verificationRequestStatus === "pending") {
      return json({ error: "already_pending" }, { status: 409 });
    }
    if (user.verified) {
      return json({ error: "already_verified" }, { status: 409 });
    }
    const body = await readJson<{ name?: string; bio?: string; website?: string }>(request);
    const nextName = typeof body?.name === "string" ? body.name.trim() : user.name || "";
    const nextBio = typeof body?.bio === "string" ? body.bio.trim() : user.bio || "";
    const nextWebsite = typeof body?.website === "string" ? body.website.trim() : user.website || "";
    if (!nextName) return json({ error: "name_required" }, { status: 400 });
    if (nextWebsite) {
      try {
        const u = new URL(nextWebsite);
        if (u.protocol !== "http:" && u.protocol !== "https:") {
          return json({ error: "invalid_url" }, { status: 400 });
        }
      } catch {
        return json({ error: "invalid_url" }, { status: 400 });
      }
    }
    const updated: UserRecord = {
      ...user,
      name: nextName,
      bio: nextBio || undefined,
      website: nextWebsite || undefined,
      verificationRequestStatus: "pending",
      verificationRequestedAt: nowIso(),
      updatedAt: nowIso(),
    };
    await saveUser(env.KV, updated);
    const mailUrls = orgRequestMailUrls(env, url);
    await notifyUserVerificationSubmitted(env.KV, env, updated, mailUrls);
    return json({ ok: true, user: updated });
  }

  if (method === "GET" && parts[0] === "api" && parts[1] === "calendar" && parts[2] === "stats") {
    const totalEvents = await countEvents(env.KV);
    return json({ totalEvents, generatedAt: nowIso() });
  }

  if (method === "GET" && parts[0] === "api" && parts[1] === "admin" && parts[2] === "branding") {
    const user = await resolveSessionUser(env.KV, request.headers.get("Cookie"));
    if (!user) return json({ error: "unauthorized" }, { status: 401 });
    const u = await applyAdminBootstrap(env, user);
    if (!u.roles.includes("admin")) return json({ error: "forbidden" }, { status: 403 });
    const branding = await getBranding(env.KV);
    return json({ branding });
  }

  if (method === "GET" && parts[0] === "api" && parts[1] === "branding" && parts.length === 2) {
    const branding = await getBranding(env.KV);
    return json({ branding });
  }

  if (method === "PUT" && parts[0] === "api" && parts[1] === "admin" && parts[2] === "branding") {
    const user = await resolveSessionUser(env.KV, request.headers.get("Cookie"));
    if (!user) return json({ error: "unauthorized" }, { status: 401 });
    const u = await applyAdminBootstrap(env, user);
    if (!u.roles.includes("admin")) return json({ error: "forbidden" }, { status: 403 });
    const body = await readJson<{
      siteTitle?: string;
      logoUrl?: string | null;
      primaryColor?: string;
      supportEmail?: string | null;
      turnstileToken?: string;
    }>(request);
    if (!body) return json({ error: "invalid_body" }, { status: 400 });
    const okTs = await requireTurnstile(env, request, body.turnstileToken);
    if (!okTs) return json({ error: "turnstile_failed" }, { status: 400 });
    const branding = await saveBranding(env.KV, body, u);
    return json({ branding });
  }

  if (method === "GET" && parts[0] === "api" && parts[1] === "calendar" && parts.length === 2) {
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    const region = parseCalendarRegion(url.searchParams.get("region"));
    if (!from || !to) return json({ error: "invalid_query" }, { status: 400 });
    const clamped = clampCalendarRange(from, to);
    if (!clamped) return json({ error: "invalid_range" }, { status: 400 });
    const items = await listEventsForCalendar(env.KV, clamped.from, clamped.to, region);
    return json({
      items: items
        .filter((e) => (e.status ?? "published") === "published")
        .map((e) => ({
          id: e.id,
          title: e.title,
          startsAt: e.startsAt,
          endsAt: e.endsAt,
          location: e.location,
          is_external: e.is_external,
          mode: e.mode ?? "in_person",
        })),
      from: clamped.from,
      to: clamped.to,
      region,
    });
  }

  if (method === "GET" && parts[0] === "api" && parts[1] === "me" && parts[2] === "calendar-badges") {
    const user = await resolveSessionUser(env.KV, request.headers.get("Cookie"));
    if (!user) return json({ error: "unauthorized" }, { status: 401 });
    const u = await applyAdminBootstrap(env, user);
    type DayBadge = { date: string; interested: boolean; participated: boolean };
    const map = new Map<string, DayBadge>();
    const upsert = (dateKey: string, patch: Partial<DayBadge>) => {
      const cur = map.get(dateKey) || { date: dateKey, interested: false, participated: false };
      map.set(dateKey, { ...cur, ...patch, date: dateKey });
    };
    for (const i of await listInterestsForUser(env.KV, u.id)) {
      const ev = await getEvent(env.KV, i.eventId);
      if (!ev) continue;
      upsert(utcDateKeyFromIso(ev.startsAt), { interested: true });
    }
    const regs = await listRegistrationsForUser(env.KV, u.id);
    for (const r of regs) {
      const ev = await getEvent(env.KV, r.eventId);
      if (!ev) continue;
      const dk = utcDateKeyFromIso(ev.startsAt);
      if (r.type === "native") upsert(dk, { participated: true });
      else upsert(dk, { interested: true });
    }
    const contribs = await listContributionsForUser(env.KV, u.id);
    for (const c of contribs) {
      if (c.status !== "APPROVED") continue;
      const ev = await getEvent(env.KV, c.eventId);
      if (!ev) continue;
      upsert(utcDateKeyFromIso(ev.startsAt), { participated: true });
    }
    const badges = [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
    return json({ badges });
  }

  if (method === "POST" && parts[0] === "api" && parts[1] === "auth" && parts[2] === "request-otp") {
    const body = await readJson<{ email?: string; turnstileToken?: string }>(request);
    if (!body?.email) return json({ error: "invalid_body" }, { status: 400 });
    const okTs = await requireTurnstile(env, request, body.turnstileToken);
    if (!okTs) return json({ error: "turnstile_failed" }, { status: 400 });
    try {
      const res = await issueOtp(env, body.email);
      if (!res.ok) {
        return json(
          { error: res.error, retryAfterSeconds: res.retryAfterSeconds },
          { status: 429 }
        );
      }
      return json({ ok: true, ttl: res.ttl });
    } catch (err) {
      /* Cloudflare Send Email fails when the recipient is not a verified Email Routing
       * destination. Surface a stable, actionable error code; the friendly text is shown
       * by the client via friendlyError(). */
      console.error("[EventMark] request-otp failed", {
        message: err instanceof Error ? err.message : String(err),
      });
      return json({ error: "email_send_failed" }, { status: 502 });
    }
  }

  /* --- Org-request OTP (separate from sign-in OTP, 9-digit) --- */

  if (method === "POST" && parts[0] === "api" && parts[1] === "org-requests" && parts[2] === "request-otp") {
    const user = await resolveSessionUser(env.KV, request.headers.get("Cookie"));
    if (!user) return json({ error: "unauthorized" }, { status: 401 });
    const body = await readJson<{ turnstileToken?: string }>(request);
    const okTs = await requireTurnstile(env, request, body?.turnstileToken);
    if (!okTs) return json({ error: "turnstile_failed" }, { status: 400 });
    const mailUrls = orgRequestMailUrls(env, url);
    const organizeUrl = `${mailUrls.siteUrl.replace(/\/$/, "")}/#/organize`;
    try {
      const res = await issueOrgRequestOtp(env, user.email, organizeUrl);
      if (!res.ok) {
        return json(
          { error: res.error, retryAfterSeconds: res.retryAfterSeconds },
          { status: 429 }
        );
      }
      return json({ ok: true, ttl: res.ttl });
    } catch (err) {
      console.error("[EventMark] org-request request-otp failed", {
        message: err instanceof Error ? err.message : String(err),
      });
      return json({ error: "email_send_failed" }, { status: 502 });
    }
  }

  if (method === "POST" && parts[0] === "api" && parts[1] === "org-requests" && parts[2] === "verify-otp") {
    const user = await resolveSessionUser(env.KV, request.headers.get("Cookie"));
    if (!user) return json({ error: "unauthorized" }, { status: 401 });
    const body = await readJson<{ code?: string; turnstileToken?: string }>(request);
    if (!body?.code) return json({ error: "invalid_body" }, { status: 400 });
    const okTs = await requireTurnstile(env, request, body.turnstileToken);
    if (!okTs) return json({ error: "turnstile_failed" }, { status: 400 });
    const res = await verifyOrgRequestOtp(env, user.email, body.code);
    if (!res.ok) return json({ error: res.error }, { status: 401 });
    return json({ ok: true });
  }

  if (method === "POST" && parts[0] === "api" && parts[1] === "org-requests" && parts.length === 2) {
    const user = await resolveSessionUser(env.KV, request.headers.get("Cookie"));
    if (!user) return json({ error: "unauthorized" }, { status: 401 });
    const settings = await getSettings(env.KV);
    if (settings.pauseOrgRequests) {
      return json({ error: "org_requests_paused" }, { status: 503 });
    }
    const body = await readJson<OrgRequestSubmitBody & { turnstileToken?: string }>(request);
    if (!body) return json({ error: "invalid_body" }, { status: 400 });
    const okTs = await requireTurnstile(env, request, body.turnstileToken);
    if (!okTs) return json({ error: "turnstile_failed" }, { status: 400 });
    const verified = await consumeOrgRequestVerification(env, user.email);
    if (!verified) return json({ error: "orgreq_not_verified" }, { status: 401 });
    const { turnstileToken: _t, ...rest } = body;
    const res = await submitOrgRequest(env.KV, user, rest);
    if (!res.ok) return json({ error: res.error }, { status: 400 });
    const mailUrls = orgRequestMailUrls(env, url);
    await notifyOrgRequestSubmitted(env.KV, env, res.request, mailUrls);
    return json({ request: res.request });
  }

  if (
    method === "PUT" &&
    parts[0] === "api" &&
    parts[1] === "org-requests" &&
    parts[2] &&
    parts.length === 3
  ) {
    const user = await resolveSessionUser(env.KV, request.headers.get("Cookie"));
    if (!user) return json({ error: "unauthorized" }, { status: 401 });
    const body = await readJson<Partial<OrgRequestSubmitBody> & { turnstileToken?: string }>(request);
    if (!body) return json({ error: "invalid_body" }, { status: 400 });
    const okTs = await requireTurnstile(env, request, body.turnstileToken);
    if (!okTs) return json({ error: "turnstile_failed" }, { status: 400 });
    const { turnstileToken: _t2, ...rest } = body;
    const mailUrls = orgRequestMailUrls(env, url);
    const res = await updateOrgRequest(env.KV, env, user, parts[2], rest, mailUrls);
    if (!res.ok) {
      const status =
        res.error === "forbidden" ? 403 : res.error === "not_found" ? 404 : 400;
      return json({ error: res.error }, { status });
    }
    return json({ request: res.request });
  }

  if (method === "GET" && parts[0] === "api" && parts[1] === "admin" && parts[2] === "settings") {
    const user = await resolveSessionUser(env.KV, request.headers.get("Cookie"));
    if (!user) return json({ error: "unauthorized" }, { status: 401 });
    const u = await applyAdminBootstrap(env, user);
    if (!u.roles.includes("admin")) return json({ error: "forbidden" }, { status: 403 });
    const settings = await getSettings(env.KV);
    return json({ settings, environment: env.ENVIRONMENT });
  }

  if (method === "PUT" && parts[0] === "api" && parts[1] === "admin" && parts[2] === "settings") {
    const user = await resolveSessionUser(env.KV, request.headers.get("Cookie"));
    if (!user) return json({ error: "unauthorized" }, { status: 401 });
    const u = await applyAdminBootstrap(env, user);
    if (!u.roles.includes("admin")) return json({ error: "forbidden" }, { status: 403 });
    const body = await readJson<Partial<SettingsRecord> & { turnstileToken?: string }>(request);
    if (!body) return json({ error: "invalid_body" }, { status: 400 });
    const okTs = await requireTurnstile(env, request, body.turnstileToken);
    if (!okTs) return json({ error: "turnstile_failed" }, { status: 400 });
    const current = await getSettings(env.KV);
    const next: SettingsRecord = {
      ...DEFAULT_SETTINGS,
      ...current,
      adminEmails: typeof body.adminEmails === "string" ? body.adminEmails : current.adminEmails,
      noticeBanner: typeof body.noticeBanner === "string" ? body.noticeBanner : current.noticeBanner,
      pauseOrgRequests:
        typeof body.pauseOrgRequests === "boolean" ? body.pauseOrgRequests : current.pauseOrgRequests,
      pauseRegistrations:
        typeof body.pauseRegistrations === "boolean"
          ? body.pauseRegistrations
          : current.pauseRegistrations,
      updatedAt: nowIso(),
      updatedBy: u.email,
    };
    await saveSettings(env.KV, next);
    return json({ settings: next, environment: env.ENVIRONMENT });
  }

  if (method === "GET" && parts[0] === "api" && parts[1] === "org-requests" && parts[2] === "me") {
    const user = await resolveSessionUser(env.KV, request.headers.get("Cookie"));
    if (!user) return json({ error: "unauthorized" }, { status: 401 });
    const req = await getLatestOrgRequestForUser(env.KV, user.id);
    return json({ request: req });
  }

  if (method === "GET" && parts[0] === "api" && parts[1] === "me" && parts[2] === "organizations") {
    const user = await resolveSessionUser(env.KV, request.headers.get("Cookie"));
    if (!user) return json({ error: "unauthorized" }, { status: 401 });
    const orgs = await Promise.all((user.organizationIds || []).map((id) => getOrg(env.KV, id)));
    const items = orgs.filter((o): o is NonNullable<typeof o> => Boolean(o));
    return json({ items });
  }

  if (method === "GET" && parts[0] === "api" && parts[1] === "organizer" && parts[2] === "events" && parts.length === 3) {
    const user = await resolveSessionUser(env.KV, request.headers.get("Cookie"));
    if (!user) return json({ error: "unauthorized" }, { status: 401 });
    const orgIds = new Set(user.organizationIds || []);
    if (orgIds.size === 0) return json({ items: [] });
    // Walk the catalog and keep events for any of the user's orgs (drafts included).
    const limit = 200;
    const all: EventRecord[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 5; i++) {
      const page = await listEvents(env.KV, limit, cursor, true /* includeDrafts */);
      all.push(...page.items);
      if (!page.hasMore || !page.cursor) break;
      cursor = page.cursor;
    }
    const mine = all.filter((e) => orgIds.has(e.organizationId));
    return json({ items: mine });
  }

  if (method === "GET" && parts[0] === "api" && parts[1] === "admin" && parts[2] === "org-requests") {
    const user = await resolveSessionUser(env.KV, request.headers.get("Cookie"));
    if (!user) return json({ error: "unauthorized" }, { status: 401 });
    const u = await applyAdminBootstrap(env, user);
    const res = await listAdminOrgRequests(env.KV, u);
    if (!res.ok) return json({ error: res.error }, { status: 403 });
    return json({ items: res.items });
  }

  if (
    method === "PUT" &&
    parts[0] === "api" &&
    parts[1] === "admin" &&
    parts[2] === "org-requests" &&
    parts[3] &&
    parts[4] === "decision"
  ) {
    const user = await resolveSessionUser(env.KV, request.headers.get("Cookie"));
    if (!user) return json({ error: "unauthorized" }, { status: 401 });
    const u = await applyAdminBootstrap(env, user);
    const body = await readJson<OrgRequestDecisionBody & { turnstileToken?: string }>(request);
    if (!body?.status) return json({ error: "invalid_body" }, { status: 400 });
    const okTs = await requireTurnstile(env, request, body.turnstileToken);
    if (!okTs) return json({ error: "turnstile_failed" }, { status: 400 });
    const { turnstileToken: _t, ...rest } = body;
    const siteUrl = orgRequestMailUrls(env, url).siteUrl;
    const res = await decideOrgRequest(env.KV, env, u, parts[3], rest, siteUrl);
    if (!res.ok) {
      return json({ error: res.error }, { status: res.error === "forbidden" ? 403 : 400 });
    }
    return json({ request: res.request, organization: res.organization ?? null });
  }

  if (method === "POST" && parts[0] === "api" && parts[1] === "auth" && parts[2] === "verify-otp") {
    const body = await readJson<{
      email?: string;
      code?: string;
      turnstileToken?: string;
    }>(request);
    if (!body?.email || !body.code) return json({ error: "invalid_body" }, { status: 400 });
    const okTs = await requireTurnstile(env, request, body.turnstileToken);
    if (!okTs) return json({ error: "turnstile_failed" }, { status: 400 });
    const res = await verifyOtpAndCreateSession(env, body.email, body.code);
    if (!res.ok) return json({ error: res.error }, { status: 401 });
    let user = res.user;
    user = await applyAdminBootstrap(env, user);
    const headers = new Headers();
    headers.append("Set-Cookie", sessionCookieHeader(res.token, secure));
    headers.set("content-type", JSON_HEADERS["content-type"]);
    return new Response(JSON.stringify({ ok: true, user, isNewUser: res.isNewUser }), { headers });
  }

  if (method === "POST" && parts[0] === "api" && parts[1] === "auth" && parts[2] === "logout") {
    await logout(env.KV, request.headers.get("Cookie"));
    const headers = new Headers();
    headers.append("Set-Cookie", clearSessionCookieHeader(secure));
    headers.set("content-type", JSON_HEADERS["content-type"]);
    return new Response(JSON.stringify({ ok: true }), { headers });
  }

  if (method === "GET" && parts[0] === "api" && parts[1] === "events") {
    if (parts.length === 2) {
      const limit = Math.min(Number(url.searchParams.get("limit") ?? "24") || 24, 100);
      const cursor = url.searchParams.get("cursor");
      const page = await listEvents(env.KV, limit, cursor);
      page.items = page.items.filter((e) => (e.status ?? "published") === "published");
      return json(page);
    }
    if (parts[2] === "search" && parts.length === 3) {
      const q = (url.searchParams.get("q") || "").trim();
      const limit = Math.min(Number(url.searchParams.get("limit") ?? "24") || 24, 100);
      if (q.length < 2) return json({ items: [], cursor: null, hasMore: false });
      const page = await searchEvents(env.KV, q, limit);
      return json(page);
    }
    const id = parts[2];
    if (!id) return json({ error: "not_found" }, { status: 404 });
    if (parts[3] === "banner" || parts[3] === "banner.webp" || parts[3] === "banner.jpg") {
      const ev = await getEvent(env.KV, id);
      if (!ev || !ev.hasBanner) return new Response("Not Found", { status: 404 });
      if ((ev.status ?? "published") !== "published") {
        const sessionUser = await resolveSessionUser(env.KV, request.headers.get("Cookie"));
        const u = sessionUser ? await applyAdminBootstrap(env, sessionUser) : null;
        const allowed =
          !!u && (u.organizationIds.includes(ev.organizationId) || u.roles.includes("admin"));
        if (!allowed) return new Response("Not Found", { status: 404 });
      }
      const banner = await getEventBannerMeta(env.KV, id);
      if (!banner) return new Response("Not Found", { status: 404 });
      return new Response(banner.data, {
        headers: {
          "content-type": banner.contentType,
          "cache-control": "public, max-age=3600",
        },
      });
    }
    if (parts[3] === "ics.ics" || parts[3] === "ics") {
      const ev = await getEvent(env.KV, id);
      if (!ev || (ev.status ?? "published") !== "published") {
        return new Response("Not Found", { status: 404 });
      }
      const ics = buildIcs(ev);
      return new Response(ics, {
        headers: { "content-type": "text/calendar; charset=utf-8" },
      });
    }
    if (parts[3] === "embed.html") {
      const ev = await getEvent(env.KV, id);
      if (!ev || (ev.status ?? "published") !== "published") {
        return new Response("Not Found", { status: 404 });
      }
      const html = buildEmbedHtml(ev);
      return new Response(html, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "public, max-age=300",
        },
      });
    }
    if (parts[3] === "share") {
      const ev = await getEvent(env.KV, id);
      if (!ev || (ev.status ?? "published") !== "published") {
        return json({ error: "not_found" }, { status: 404 });
      }
      const share = eventShareLinks(ev, url);
      return json({ eventId: ev.id, ...share });
    }
    // Only match /api/events/:id (without additional path segments)
    if (!parts[3]) {
      const ev = await getEvent(env.KV, id);
      if (!ev) return json({ error: "not_found" }, { status: 404 });
      if ((ev.status ?? "published") !== "published") {
        const sessionUser = await resolveSessionUser(env.KV, request.headers.get("Cookie"));
        const u = sessionUser ? await applyAdminBootstrap(env, sessionUser) : null;
        const allowed =
          !!u && (u.organizationIds.includes(ev.organizationId) || u.roles.includes("admin"));
        if (!allowed) return json({ error: "not_found" }, { status: 404 });
      }
      return json({
        event: ev,
        speakerSlots: await listSpeakerSlots(env.KV, ev.id),
        booths: await listBooths(env.KV, ev.id),
        sessions: await listSessions(env.KV, ev.id),
      });
    }
    // Unknown sub-resource under /api/events/:id - continue to 404
  }

  if (method === "POST" && parts[0] === "api" && parts[1] === "events" && parts[2] && parts[3] === "view") {
    const id = parts[2];
    const ev = await getEvent(env.KV, id);
    if (!ev || (ev.status ?? "published") !== "published") {
      return json({ error: "not_found" }, { status: 404 });
    }
    const result = await incrementEventViewCount(env.KV, id);
    if (!result.ok) return json({ error: "not_found" }, { status: 404 });
    return json({ ok: true, viewCount: result.viewCount });
  }

  if (
    method === "GET" &&
    parts[0] === "api" &&
    parts[1] === "events" &&
    parts[2] &&
    parts[3] === "invites"
  ) {
    const auth = await requireEventOrganizerOrAdmin(env, request, parts[2]);
    if (!auth.ok) return auth.response;
    const items = await listInvitesForEvent(env.KV, auth.event.id);
    return json({ items });
  }

  if (
    method === "POST" &&
    parts[0] === "api" &&
    parts[1] === "events" &&
    parts[2] &&
    parts[3] === "invites" &&
    parts[4] === "import"
  ) {
    const auth = await requireEventOrganizerOrAdmin(env, request, parts[2]);
    if (!auth.ok) return auth.response;
    const body = await readJson<{
      guests?: Array<{ email?: string; name?: string; role?: InviteRole }>;
      turnstileToken?: string;
    }>(request);
    if (!body?.guests || !Array.isArray(body.guests)) {
      return json({ error: "invalid_body" }, { status: 400 });
    }
    const okTs = await requireTurnstile(env, request, body.turnstileToken);
    if (!okTs) return json({ error: "turnstile_failed" }, { status: 400 });
    const guests = body.guests
      .map((g) => ({
        email: String(g.email || "").trim().toLowerCase(),
        name: String(g.name || "").trim(),
        role: (g.role || "attendee") as InviteRole,
      }))
      .filter((g) => g.email.includes("@"));
    const created = await importInvites(env.KV, auth.event, guests);
    return json({ items: created, imported: created.length });
  }

  if (
    method === "POST" &&
    parts[0] === "api" &&
    parts[1] === "events" &&
    parts[2] &&
    parts[3] === "campaign" &&
    parts[4] === "send"
  ) {
    const auth = await requireEventOrganizerOrAdmin(env, request, parts[2]);
    if (!auth.ok) return auth.response;
    const body = await readJson<{
      campaignType?: "invite" | "reminder" | "pass";
      audience?: "all" | "accepted" | "checked_in" | "not_checked_in" | "pending_pass";
      turnstileToken?: string;
    }>(request);
    const campaignType = body?.campaignType || "invite";
    const audience = body?.audience || "all";
    if (!["invite", "reminder", "pass"].includes(campaignType)) {
      return json({ error: "invalid_body" }, { status: 400 });
    }
    const okTs = await requireTurnstile(env, request, body?.turnstileToken);
    if (!okTs) return json({ error: "turnstile_failed" }, { status: 400 });

    const invites = await listInvitesForEvent(env.KV, auth.event.id);
    const scoped = invites.filter((i) => {
      if (audience === "accepted") return i.status === "accepted";
      if (audience === "checked_in") return i.status === "checked_in";
      if (audience === "not_checked_in") return i.status !== "checked_in";
      if (audience === "pending_pass") return i.status === "accepted" && !i.passToken;
      return true;
    });

    let sent = 0;
    let failed = 0;
    let skipped = 0;
    const eventUrl = `${url.protocol}//${url.host}/#/event/${encodeURIComponent(auth.event.id)}`;
    for (const invite of scoped) {
      if (!invite.email) {
        skipped += 1;
        continue;
      }
      try {
        let passToken = invite.passToken;
        if (campaignType === "pass" && !passToken) {
          const withPass = await issuePassForInvite(env.KV, invite, auth.event, invitePassSecret(env));
          passToken = withPass.passToken;
        }
        await sendEventCampaignEmail(env, invite.email, {
          eventTitle: auth.event.title,
          eventStartsAt: auth.event.startsAt,
          campaignType,
          eventUrl,
          passToken: passToken || null,
        });
        sent += 1;
      } catch {
        failed += 1;
      }
    }
    return json({
      ok: true,
      campaignType,
      audience,
      totalSelected: scoped.length,
      sent,
      failed,
      skipped,
    });
  }

  if (
    method === "GET" &&
    parts[0] === "api" &&
    parts[1] === "events" &&
    parts[2] &&
    parts[3] === "analytics"
  ) {
    const auth = await requireEventOrganizerOrAdmin(env, request, parts[2]);
    if (!auth.ok) return auth.response;
    const invites = await listInvitesForEvent(env.KV, auth.event.id);
    const regs = await listRegistrationsForEvent(env.KV, auth.event.id);
    const contribs = await listContributionsForEvent(env.KV, auth.event.id);
    const rsvps = await listRsvpsForEvent(env.KV, auth.event.id);
    const waitlist = await listWaitlistForEvent(env.KV, auth.event.id);

    const inviteByStatus = {
      invited: invites.filter((i) => i.status === "invited").length,
      accepted: invites.filter((i) => i.status === "accepted").length,
      declined: invites.filter((i) => i.status === "declined").length,
      waitlisted: invites.filter((i) => i.status === "waitlisted").length,
      checked_in: invites.filter((i) => i.status === "checked_in").length,
      pass_issued: invites.filter((i) => !!i.passToken).length,
    };
    const contribByStatus = {
      pending: contribs.filter((c) => c.status === "PENDING_APPROVAL").length,
      approved: contribs.filter((c) => c.status === "APPROVED").length,
      rejected_or_info: contribs.filter(
        (c) => c.status !== "PENDING_APPROVAL" && c.status !== "APPROVED"
      ).length,
    };
    const payload = {
      eventId: auth.event.id,
      eventTitle: auth.event.title,
      generatedAt: nowIso(),
      metrics: {
        views: auth.event.viewCount ?? 0,
        interested: auth.event.interestedCount ?? 0,
        registered: auth.event.registeredCount ?? regs.length,
        registrations_indexed: regs.length,
        rsvp_going: rsvps.filter((r) => r.status === "going").length,
        rsvp_maybe: rsvps.filter((r) => r.status === "maybe").length,
        rsvp_not_going: rsvps.filter((r) => r.status === "not_going").length,
        waitlist_total: waitlist.length,
        invites_total: invites.length,
        checkins_total: inviteByStatus.checked_in,
      },
      invites: inviteByStatus,
      contributions: contribByStatus,
    };

    if (url.searchParams.get("format") === "csv") {
      const lines: string[] = [];
      lines.push(["event_id", "event_title", "generated_at"].map(csvCell).join(","));
      lines.push([auth.event.id, auth.event.title, payload.generatedAt].map(csvCell).join(","));
      lines.push("");
      lines.push(["metric", "value"].join(","));
      Object.entries(payload.metrics).forEach(([k, v]) => {
        lines.push([csvCell(k), csvCell(v)].join(","));
      });
      lines.push("");
      lines.push(["invite_status", "count"].join(","));
      Object.entries(payload.invites).forEach(([k, v]) => {
        lines.push([csvCell(k), csvCell(v)].join(","));
      });
      lines.push("");
      lines.push(["contribution_status", "count"].join(","));
      Object.entries(payload.contributions).forEach(([k, v]) => {
        lines.push([csvCell(k), csvCell(v)].join(","));
      });
      return new Response(lines.join("\n"), {
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename=event-${auth.event.id}-analytics.csv`,
          "cache-control": "no-store",
        },
      });
    }

    return json(payload);
  }

  if (method === "POST" && parts[0] === "api" && parts[1] === "invites" && parts[2] && parts[3] === "rsvp") {
    const body = await readJson<{
      status?: "accepted" | "declined" | "waitlisted";
      inviteToken?: string;
      turnstileToken?: string;
    }>(request);
    if (!body?.status || !body.inviteToken) return json({ error: "invalid_body" }, { status: 400 });
    const okTs = await requireTurnstile(env, request, body.turnstileToken);
    if (!okTs) return json({ error: "turnstile_failed" }, { status: 400 });
    const updated = await updateInviteRsvp(env.KV, parts[2], body.status, body.inviteToken);
    if (!updated) return json({ error: "invalid_invite" }, { status: 404 });
    return json({ invite: updated });
  }

  if (
    method === "POST" &&
    parts[0] === "api" &&
    parts[1] === "invites" &&
    parts[2] &&
    parts[3] === "issue-pass"
  ) {
    const invite = await getInvite(env.KV, parts[2]);
    if (!invite) return json({ error: "not_found" }, { status: 404 });
    const auth = await requireEventOrganizerOrAdmin(env, request, invite.eventId);
    if (!auth.ok) return auth.response;
    const body = await readJson<{ turnstileToken?: string }>(request);
    const okTs = await requireTurnstile(env, request, body?.turnstileToken);
    if (!okTs) return json({ error: "turnstile_failed" }, { status: 400 });
    const next = await issuePassForInvite(env.KV, invite, auth.event, invitePassSecret(env));
    return json({
      invite: next,
      pass: {
        token: next.passToken,
        qrText: next.passToken,
      },
    });
  }

  if (method === "GET" && parts[0] === "api" && parts[1] === "invites" && parts[2] === "pass" && parts[3]) {
    const verified = await verifyPassToken(env.KV, parts[3], invitePassSecret(env));
    if (!verified) return json({ error: "invalid_pass" }, { status: 404 });
    return json({
      invite: {
        id: verified.invite.id,
        eventId: verified.invite.eventId,
        name: verified.invite.name,
        email: verified.invite.email,
        role: verified.invite.role,
        status: verified.invite.status,
      },
      payload: verified.payload,
    });
  }

  if (method === "POST" && parts[0] === "api" && parts[1] === "checkin" && parts[2] === "scan") {
    const body = await readJson<{ token?: string; eventId?: string; turnstileToken?: string }>(request);
    if (!body?.token || !body.eventId) return json({ error: "invalid_body" }, { status: 400 });
    const auth = await requireEventOrganizerOrAdmin(env, request, body.eventId);
    if (!auth.ok) return auth.response;
    const okTs = await requireTurnstile(env, request, body.turnstileToken);
    if (!okTs) return json({ error: "turnstile_failed" }, { status: 400 });
    const token = String(body.token).trim();
    const now = Date.now();
    const seenAt = recentCheckinTokenSeen.get(token) || 0;
    if (seenAt && now - seenAt < 2000) {
      return json({ error: "already_checked_recently" }, { status: 409 });
    }
    const res = await checkInByPassToken(env.KV, token, invitePassSecret(env));
    if (res.ok) {
      recentCheckinTokenSeen.set(token, now);
      if (recentCheckinTokenSeen.size > 2000) {
        recentCheckinTokenSeen.clear();
      }
    }
    if (!res.ok) return json({ error: res.reason || "checkin_failed" }, { status: 400 });
    if (res.invite && res.invite.eventId !== body.eventId) {
      return json({ error: "wrong_event" }, { status: 400 });
    }
    return json({ ok: true, invite: res.invite });
  }

  if (
    method === "GET" &&
    parts[0] === "api" &&
    parts[1] === "events" &&
    parts[2] &&
    parts[3] === "speakers"
  ) {
    const auth = await requireEventOrganizerOrAdmin(env, request, parts[2]);
    if (!auth.ok) return auth.response;
    const items = await listSpeakerSlots(env.KV, auth.event.id);
    return json({ items });
  }

  if (
    method === "POST" &&
    parts[0] === "api" &&
    parts[1] === "events" &&
    parts[2] &&
    parts[3] === "speakers"
  ) {
    const auth = await requireEventOrganizerOrAdmin(env, request, parts[2]);
    if (!auth.ok) return auth.response;
    const body = await readJson<{
      name?: string;
      topic?: string;
      stage?: string;
      startsAt?: string;
      endsAt?: string;
      turnstileToken?: string;
    }>(request);
    if (!body?.name || !body.topic || !body.stage || !body.startsAt || !body.endsAt) {
      return json({ error: "invalid_body" }, { status: 400 });
    }
    const okTs = await requireTurnstile(env, request, body.turnstileToken);
    if (!okTs) return json({ error: "turnstile_failed" }, { status: 400 });
    const res = await addSpeakerSlot(env.KV, auth.event.id, {
      name: body.name,
      topic: body.topic,
      stage: body.stage,
      startsAt: body.startsAt,
      endsAt: body.endsAt,
    });
    if (!res.ok) return json({ error: res.error }, { status: 409 });
    return json({ item: res.item });
  }

  if (
    method === "GET" &&
    parts[0] === "api" &&
    parts[1] === "events" &&
    parts[2] &&
    parts[3] === "booths"
  ) {
    const auth = await requireEventOrganizerOrAdmin(env, request, parts[2]);
    if (!auth.ok) return auth.response;
    const items = await listBooths(env.KV, auth.event.id);
    return json({ items });
  }

  if (
    method === "POST" &&
    parts[0] === "api" &&
    parts[1] === "events" &&
    parts[2] &&
    parts[3] === "booths"
  ) {
    const auth = await requireEventOrganizerOrAdmin(env, request, parts[2]);
    if (!auth.ok) return auth.response;
    const body = await readJson<{
      boothCode?: string;
      title?: string;
      owner?: string;
      locationHint?: string;
      turnstileToken?: string;
    }>(request);
    if (!body?.boothCode || !body.title || !body.owner) {
      return json({ error: "invalid_body" }, { status: 400 });
    }
    const okTs = await requireTurnstile(env, request, body.turnstileToken);
    if (!okTs) return json({ error: "turnstile_failed" }, { status: 400 });
    const res = await addBooth(env.KV, auth.event.id, {
      boothCode: body.boothCode,
      title: body.title,
      owner: body.owner,
      locationHint: body.locationHint || "",
    });
    if (!res.ok) return json({ error: res.error }, { status: 409 });
    return json({ item: res.item });
  }

  if (
    method === "GET" &&
    parts[0] === "api" &&
    parts[1] === "events" &&
    parts[2] &&
    parts[3] === "sessions"
  ) {
    const auth = await requireEventOrganizerOrAdmin(env, request, parts[2]);
    if (!auth.ok) return auth.response;
    const items = await listSessions(env.KV, auth.event.id);
    return json({ items });
  }

  if (
    method === "POST" &&
    parts[0] === "api" &&
    parts[1] === "events" &&
    parts[2] &&
    parts[3] === "sessions"
  ) {
    const auth = await requireEventOrganizerOrAdmin(env, request, parts[2]);
    if (!auth.ok) return auth.response;
    const body = await readJson<{
      title?: string;
      room?: string;
      startsAt?: string;
      endsAt?: string;
      capacity?: number;
      turnstileToken?: string;
    }>(request);
    if (!body?.title || !body.room || !body.startsAt || !body.endsAt) {
      return json({ error: "invalid_body" }, { status: 400 });
    }
    const okTs = await requireTurnstile(env, request, body.turnstileToken);
    if (!okTs) return json({ error: "turnstile_failed" }, { status: 400 });
    const res = await addSession(env.KV, auth.event.id, {
      title: body.title,
      room: body.room,
      startsAt: body.startsAt,
      endsAt: body.endsAt,
      capacity: body.capacity || 1,
    });
    if (!res.ok) return json({ error: res.error }, { status: 409 });
    return json({ item: res.item });
  }

  if (method === "GET" && parts[0] === "api" && parts[1] === "tickets" && parts[2]) {
    const code = parts[2];
    const isSvg = parts[3] === "barcode.svg";
    const entry = await getTicket(env.KV, code);
    if (!entry) return new Response("Not Found", { status: 404 });
    if (!isSvg) return json({ ticket: entry });
    if (!isCode39Compatible(code.toUpperCase())) {
      return new Response("Unsupported", { status: 400 });
    }
    const svg = renderCode39Svg(code);
    return new Response(svg, {
      headers: {
        "content-type": "image/svg+xml; charset=utf-8",
        "cache-control": "public, max-age=300",
      },
    });
  }

  if (method === "POST" && parts[0] === "api" && parts[1] === "events" && !parts[2]) {
    const user = await resolveSessionUser(env.KV, request.headers.get("Cookie"));
    if (!user) return json({ error: "unauthorized" }, { status: 401 });
    const u = await applyAdminBootstrap(env, user);
    if (!u.roles.includes("organizer") && !u.roles.includes("admin")) {
      return json({ error: "forbidden" }, { status: 403 });
    }
    const body = await readJson<{
      title?: string;
      description?: string;
      location?: string;
      startsAt?: string;
      endsAt?: string;
      organizationId?: string;
      is_external?: boolean;
      external_url?: string | null;
      mode?: EventMode;
      online_url?: string | null;
      website_url?: string | null;
      min_seats?: number;
      max_seats?: number;
      speakers?: SpeakerSummary[];
      status?: EventStatus;
      turnstileToken?: string;
    }>(request);
    if (!body?.title || !body.startsAt || !body.endsAt || !body.organizationId) {
      return json({ error: "invalid_body" }, { status: 400 });
    }
    const okTs = await requireTurnstile(env, request, body.turnstileToken);
    if (!okTs) return json({ error: "turnstile_failed" }, { status: 400 });
    const org = await getOrg(env.KV, body.organizationId);
    if (!org) return json({ error: "org_not_found" }, { status: 400 });
    if (!u.organizationIds.includes(org.id) && !u.roles.includes("admin")) {
      return json({ error: "forbidden" }, { status: 403 });
    }
    if (org.vettingStatus !== "APPROVED" && !u.roles.includes("admin")) {
      return json({ error: "org_not_approved" }, { status: 403 });
    }
    const id = randomId();
    const ts = nowIso();
    const isExternal = Boolean(body.is_external);
    const mode: EventMode =
      body.mode === "online" || body.mode === "hybrid" || body.mode === "in_person"
        ? body.mode
        : "in_person";
    if (body.website_url && !isHttpUrl(body.website_url)) {
      return json({ error: "invalid_url" }, { status: 400 });
    }
    const minSeats = Math.max(0, Math.floor(Number(body.min_seats ?? 0)) || 0);
    const maxSeats = Math.max(0, Math.floor(Number(body.max_seats ?? 0)) || 0);
    const speakers: SpeakerSummary[] = Array.isArray(body.speakers)
      ? body.speakers.slice(0, 50).map((s) => ({
          name: String(s?.name ?? "").trim().slice(0, 200),
          link: String(s?.link ?? "").trim().slice(0, 500),
          org: String(s?.org ?? "").trim().slice(0, 200),
          orgLink: String(s?.orgLink ?? "").trim().slice(0, 500),
        }))
      : [];
    const status: EventStatus = body.status === "published" ? "published" : "draft";
    const event: EventRecord = {
      id,
      title: body.title,
      description: body.description ?? "",
      location: body.location ?? "",
      startsAt: body.startsAt,
      endsAt: body.endsAt,
      organizationId: org.id,
      is_external: isExternal,
      external_url: isExternal ? body.external_url ?? null : null,
      createdAt: ts,
      updatedAt: ts,
      agenda: [],
      status,
      mode,
      online_url: mode !== "in_person" ? body.online_url ?? null : null,
      website_url: body.website_url ? String(body.website_url).trim() : null,
      min_seats: minSeats,
      max_seats: maxSeats,
      speakers,
    };
    await saveEvent(env.KV, event);
    return json({ event });
  }

  if (
    method === "POST" &&
    parts[0] === "api" &&
    parts[1] === "events" &&
    parts[2] &&
    parts[3] === "publish"
  ) {
    const user = await resolveSessionUser(env.KV, request.headers.get("Cookie"));
    if (!user) return json({ error: "unauthorized" }, { status: 401 });
    const u = await applyAdminBootstrap(env, user);
    const id = parts[2];
    const existing = await getEvent(env.KV, id);
    if (!existing) return json({ error: "not_found" }, { status: 404 });
    if (!u.organizationIds.includes(existing.organizationId) && !u.roles.includes("admin")) {
      return json({ error: "forbidden" }, { status: 403 });
    }
    const body = await readJson<{ status?: EventStatus; turnstileToken?: string }>(request);
    const okTs = await requireTurnstile(env, request, body?.turnstileToken);
    if (!okTs) return json({ error: "turnstile_failed" }, { status: 400 });
    const publishing = body?.status !== "draft";
    const next: EventRecord = {
      ...existing,
      status: publishing ? "published" : "draft",
      publishedOnce: publishing ? true : existing.publishedOnce,
      updatedAt: nowIso(),
    };
    await saveEvent(env.KV, next);
    return json({ event: next });
  }

  if (method === "PUT" && parts[0] === "api" && parts[1] === "events" && parts[2] && parts[3] === "banner") {
    const user = await resolveSessionUser(env.KV, request.headers.get("Cookie"));
    if (!user) return json({ error: "unauthorized" }, { status: 401 });
    const u = await applyAdminBootstrap(env, user);
    const id = parts[2];
    const existing = await getEvent(env.KV, id);
    if (!existing) return json({ error: "not_found" }, { status: 404 });
    const org = await getOrg(env.KV, existing.organizationId);
    if (!org) return json({ error: "org_not_found" }, { status: 400 });
    if (!u.organizationIds.includes(org.id) && !u.roles.includes("admin")) {
      return json({ error: "forbidden" }, { status: 403 });
    }
    if (!isEventEditable(existing)) {
      return json({ error: "event_not_editable" }, { status: 403 });
    }
    const turnstileToken = request.headers.get("X-Turnstile-Token") || "";
    const okTs = await requireTurnstile(env, request, turnstileToken);
    if (!okTs) return json({ error: "turnstile_failed" }, { status: 400 });
    const bytes = new Uint8Array(await request.arrayBuffer());
    const validated = validateBannerImage(bytes);
    if (!validated.ok) return json({ error: validated.error }, { status: 400 });
    await saveEventBanner(env.KV, id, bytes.buffer, validated.contentType);
    const next: EventRecord = {
      ...existing,
      hasBanner: true,
      updatedAt: nowIso(),
    };
    await saveEvent(env.KV, next);
    return json({ ok: true, event: next });
  }

  if (method === "PUT" && parts[0] === "api" && parts[1] === "events" && parts[2]) {
    const user = await resolveSessionUser(env.KV, request.headers.get("Cookie"));
    if (!user) return json({ error: "unauthorized" }, { status: 401 });
    const u = await applyAdminBootstrap(env, user);
    const id = parts[2];
    const existing = await getEvent(env.KV, id);
    if (!existing) return json({ error: "not_found" }, { status: 404 });
    const org = await getOrg(env.KV, existing.organizationId);
    if (!org) return json({ error: "org_not_found" }, { status: 400 });
    if (!u.organizationIds.includes(org.id) && !u.roles.includes("admin")) {
      return json({ error: "forbidden" }, { status: 403 });
    }
    if (!isEventEditable(existing)) {
      return json({ error: "event_not_editable" }, { status: 403 });
    }
    const body = await readJson<{
      title?: string;
      description?: string;
      location?: string;
      startsAt?: string;
      endsAt?: string;
      is_external?: boolean;
      external_url?: string | null;
      mode?: EventMode;
      online_url?: string | null;
      website_url?: string | null;
      min_seats?: number;
      max_seats?: number;
      speakers?: SpeakerSummary[];
      category?: EventCategory;
      turnstileToken?: string;
    }>(request);
    if (!body) return json({ error: "invalid_body" }, { status: 400 });
    if (body.website_url != null && body.website_url !== "" && !isHttpUrl(body.website_url)) {
      return json({ error: "invalid_url" }, { status: 400 });
    }
    const okTs = await requireTurnstile(env, request, body.turnstileToken);
    if (!okTs) return json({ error: "turnstile_failed" }, { status: 400 });
    const mode: EventMode =
      body.mode === "online" || body.mode === "hybrid" || body.mode === "in_person"
        ? body.mode
        : existing.mode ?? "in_person";
    const minSeats =
      body.min_seats === undefined
        ? existing.min_seats ?? 0
        : Math.max(0, Math.floor(Number(body.min_seats)) || 0);
    const maxSeats =
      body.max_seats === undefined
        ? existing.max_seats ?? 0
        : Math.max(0, Math.floor(Number(body.max_seats)) || 0);
    const speakers: SpeakerSummary[] | undefined = Array.isArray(body.speakers)
      ? body.speakers.slice(0, 50).map((s) => ({
          name: String(s?.name ?? "").trim().slice(0, 200),
          link: String(s?.link ?? "").trim().slice(0, 500),
          org: String(s?.org ?? "").trim().slice(0, 200),
          orgLink: String(s?.orgLink ?? "").trim().slice(0, 500),
        }))
      : undefined;
    const category: EventCategory | undefined =
      body.category === "open_source" || body.category === "fun_source" || body.category === "hybrid"
        ? body.category
        : undefined;
    const isExternal = body.is_external ?? existing.is_external;
    const prevStart = existing.startsAt;
    const next: EventRecord = {
      ...existing,
      title: body.title ?? existing.title,
      description: body.description ?? existing.description,
      location: body.location ?? existing.location,
      startsAt: body.startsAt ?? existing.startsAt,
      endsAt: body.endsAt ?? existing.endsAt,
      is_external: isExternal,
      external_url: isExternal ? body.external_url ?? existing.external_url : null,
      mode,
      online_url: mode !== "in_person" ? body.online_url ?? existing.online_url ?? null : null,
      website_url:
        body.website_url === undefined
          ? existing.website_url ?? null
          : body.website_url
            ? String(body.website_url).trim()
            : null,
      min_seats: minSeats,
      max_seats: maxSeats,
      speakers: speakers ?? existing.speakers ?? [],
      category: category ?? existing.category,
      status: "draft",
      updatedAt: nowIso(),
    };
    await saveEvent(env.KV, next, prevStart);
    return json({ event: next });
  }

  if (method === "DELETE" && parts[0] === "api" && parts[1] === "events" && parts[2]) {
    const user = await resolveSessionUser(env.KV, request.headers.get("Cookie"));
    if (!user) return json({ error: "unauthorized" }, { status: 401 });
    const u = await applyAdminBootstrap(env, user);
    const id = parts[2];
    const existing = await getEvent(env.KV, id);
    if (!existing) return json({ error: "not_found" }, { status: 404 });
    const org = await getOrg(env.KV, existing.organizationId);
    if (!org) return json({ error: "org_not_found" }, { status: 400 });
    if (!u.organizationIds.includes(org.id) && !u.roles.includes("admin")) {
      return json({ error: "forbidden" }, { status: 403 });
    }
    await deleteEvent(env.KV, existing, org?.name);
    return json({ ok: true });
  }

  if (method === "POST" && parts[0] === "api" && parts[1] === "registrations" && parts[2] === "native") {
    const user = await resolveSessionUser(env.KV, request.headers.get("Cookie"));
    if (!user) return json({ error: "unauthorized" }, { status: 401 });
    const body = await readJson<{ eventId?: string; turnstileToken?: string }>(request);
    if (!body?.eventId) return json({ error: "invalid_body" }, { status: 400 });
    const okTs = await requireTurnstile(env, request, body.turnstileToken);
    if (!okTs) return json({ error: "turnstile_failed" }, { status: 400 });
    const ev = await getEvent(env.KV, body.eventId);
    if (!ev) return json({ error: "not_found" }, { status: 404 });
    if (ev.is_external) return json({ error: "external_event" }, { status: 400 });
    if ((ev.status ?? "published") !== "published") {
      return json({ error: "not_published" }, { status: 400 });
    }
    const regSettings = await getSettings(env.KV);
    if (regSettings.pauseRegistrations) {
      return json({ error: "registrations_paused" }, { status: 503 });
    }
    const existingReg = await getRegistration(env.KV, ev.id, user.id);
    if (existingReg) {
      return json({ registration: existingReg, ticketCode: existingReg.ticketCode });
    }
    const maxSeats = ev.max_seats ?? 0;
    if (maxSeats > 0) {
      const reserved = await tryReserveEventSeat(env.KV, ev.id, user.id, maxSeats);
      if (!reserved.ok) {
        const existingWait = await getWaitlist(env.KV, ev.id, user.id);
        if (existingWait) {
          return json({ waitlist: existingWait, status: "waitlisted" }, { status: 202 });
        }
        const wait = {
          id: randomId(),
          eventId: ev.id,
          userId: user.id,
          createdAt: nowIso(),
        };
        await saveWaitlist(env.KV, wait);
        return json({ waitlist: wait, status: "waitlisted" }, { status: 202 });
      }
    }
    const ticketCode = generateTicketCode();
    const reg: RegistrationRecord = {
      id: randomId(),
      eventId: ev.id,
      userId: user.id,
      type: "native",
      createdAt: nowIso(),
      ticketCode,
    };
    await saveRegistration(env.KV, reg);
    await saveTicket(env.KV, ticketCode, {
      eventId: ev.id,
      userId: user.id,
      registrationId: reg.id,
    });
    const origin = `${url.protocol}//${url.host}`;
    try {
      await sendRegistrationEmail(env, user.email, {
        eventTitle: ev.title,
        eventStartsAt: ev.startsAt,
        eventLocation: ev.location,
        eventMode: ev.mode ?? "in_person",
        onlineUrl: ev.online_url ?? null,
        ticketCode,
        ticketUrl: `${origin}/api/tickets/${ticketCode}/barcode.svg`,
      });
    } catch (err) {
      // Non-fatal: registration is saved even if mail fails (admin can re-issue).
      console.error("[EventMark] registration email failed", {
        message: err instanceof Error ? err.message : String(err),
      });
    }
    return json({ registration: reg, ticketCode });
  }

  if (method === "DELETE" && parts[0] === "api" && parts[1] === "registrations" && parts[2]) {
    const user = await resolveSessionUser(env.KV, request.headers.get("Cookie"));
    if (!user) return json({ error: "unauthorized" }, { status: 401 });
    const eventId = parts[2];
    const reg = await listRegistrationsForUser(env.KV, user.id).then((rows) =>
      rows.find((r) => r.eventId === eventId)
    );
    if (!reg) return json({ error: "not_found" }, { status: 404 });
    const ev = await getEvent(env.KV, eventId);
    if (!ev) return json({ error: "not_found" }, { status: 404 });
    await deleteRegistration(env.KV, eventId, user.id);
    const promoted = await promoteNextWaitlistedAttendee(env, ev, url);
    return json({ ok: true, promoted });
  }

  if (method === "POST" && parts[0] === "api" && parts[1] === "events" && parts[2] && parts[3] === "rsvp") {
    const user = await resolveSessionUser(env.KV, request.headers.get("Cookie"));
    if (!user) return json({ error: "unauthorized" }, { status: 401 });
    const ev = await getEvent(env.KV, parts[2]);
    if (!ev || (ev.status ?? "published") !== "published") {
      return json({ error: "not_found" }, { status: 404 });
    }
    const body = await readJson<{ status?: RsvpStatus }>(request);
    if (!body?.status || !["going", "maybe", "not_going"].includes(body.status)) {
      return json({ error: "invalid_body" }, { status: 400 });
    }
    const now = nowIso();
    const existing = await getRsvp(env.KV, ev.id, user.id);
    const rec = {
      id: existing?.id || randomId(),
      eventId: ev.id,
      userId: user.id,
      status: body.status,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
    await saveRsvp(env.KV, rec);

    if (body.status === "going" && existing?.status !== "going") {
      try {
        const eventUrl = `${url.protocol}//${url.host}/#/event/${encodeURIComponent(ev.id)}`;
        await sendEventCampaignEmail(env, user.email, {
          eventTitle: ev.title,
          eventStartsAt: ev.startsAt,
          campaignType: "reminder",
          eventUrl,
          passToken: null,
        });
      } catch {
        // RSVP write should not fail when email delivery fails.
      }
    }
    return json({ rsvp: rec });
  }

  if (method === "GET" && parts[0] === "api" && parts[1] === "events" && parts[2] && parts[3] === "rsvp") {
    const ev = await getEvent(env.KV, parts[2]);
    if (!ev || (ev.status ?? "published") !== "published") {
      return json({ error: "not_found" }, { status: 404 });
    }
    const user = await resolveSessionUser(env.KV, request.headers.get("Cookie"));
    const mine = user ? await getRsvp(env.KV, ev.id, user.id) : null;
    const rows = await listRsvpsForEvent(env.KV, ev.id);
    const summary = {
      going: rows.filter((r) => r.status === "going").length,
      maybe: rows.filter((r) => r.status === "maybe").length,
      not_going: rows.filter((r) => r.status === "not_going").length,
      total: rows.length,
    };
    return json({ mine, summary });
  }

  if (
    method === "POST" &&
    parts[0] === "api" &&
    parts[1] === "events" &&
    parts[2] &&
    parts[3] === "rsvp" &&
    parts[4] === "reminders"
  ) {
    const auth = await requireEventOrganizerOrAdmin(env, request, parts[2]);
    if (!auth.ok) return auth.response;
    const body = await readJson<{ turnstileToken?: string }>(request);
    const okTs = await requireTurnstile(env, request, body?.turnstileToken);
    if (!okTs) return json({ error: "turnstile_failed" }, { status: 400 });
    const rows = await listRsvpsForEvent(env.KV, auth.event.id);
    const going = rows.filter((r) => r.status === "going");
    const eventUrl = `${url.protocol}//${url.host}/#/event/${encodeURIComponent(auth.event.id)}`;
    let sent = 0;
    let failed = 0;
    for (const row of going) {
      const u = await getUserById(env.KV, row.userId);
      if (!u) continue;
      try {
        await sendEventCampaignEmail(env, u.email, {
          eventTitle: auth.event.title,
          eventStartsAt: auth.event.startsAt,
          campaignType: "reminder",
          eventUrl,
          passToken: null,
        });
        sent += 1;
      } catch {
        failed += 1;
      }
    }
    return json({ ok: true, sent, failed, total: going.length });
  }

  if (method === "POST" && parts[0] === "api" && parts[1] === "interests") {
    const user = await resolveSessionUser(env.KV, request.headers.get("Cookie"));
    if (!user) return json({ error: "unauthorized" }, { status: 401 });
    const body = await readJson<{ eventId?: string; turnstileToken?: string }>(request);
    if (!body?.eventId) return json({ error: "invalid_body" }, { status: 400 });
    const okTs = await requireTurnstile(env, request, body.turnstileToken);
    if (!okTs) return json({ error: "turnstile_failed" }, { status: 400 });
    const ev = await getEvent(env.KV, body.eventId);
    if (!ev) return json({ error: "not_found" }, { status: 404 });
    const interest: InterestRecord = {
      id: randomId(),
      eventId: ev.id,
      userId: user.id,
      createdAt: nowIso(),
    };
    await saveInterest(env.KV, interest);
    return json({ interest });
  }

  if (method === "DELETE" && parts[0] === "api" && parts[1] === "interests" && parts[2]) {
    const user = await resolveSessionUser(env.KV, request.headers.get("Cookie"));
    if (!user) return json({ error: "unauthorized" }, { status: 401 });
    const ev = await getEvent(env.KV, parts[2]);
    if (!ev) return json({ error: "not_found" }, { status: 404 });
    await deleteInterest(env.KV, ev.id, user.id);
    return json({ ok: true });
  }

  if (method === "GET" && parts[0] === "api" && parts[1] === "me" && parts[2] === "dashboard") {
    const user = await resolveSessionUser(env.KV, request.headers.get("Cookie"));
    if (!user) return json({ error: "unauthorized" }, { status: 401 });
    const u = await applyAdminBootstrap(env, user);
    const interests = await listInterestsForUser(env.KV, u.id);
    const eventsForInterests = await Promise.all(
      interests.map((i) => getEvent(env.KV, i.eventId))
    );
    const interestedEvents = eventsForInterests.filter((e): e is EventRecord => Boolean(e));
    const registrations = await listRegistrationsForUser(env.KV, u.id);
    const regEvents = await Promise.all(
      registrations.map((r) => getEvent(env.KV, r.eventId))
    );
    const registeredEvents = regEvents.filter((e): e is EventRecord => Boolean(e));
    /** Pair every registration with its event so the dashboard can show ticket + join link. */
    const registrationsDetailed = registrations
      .map((r, idx) => ({ registration: r, event: regEvents[idx] }))
      .filter((p): p is { registration: typeof registrations[number]; event: EventRecord } =>
        Boolean(p.event)
      )
      .map((p) => ({
        ticketCode: p.registration.ticketCode ?? null,
        event: p.event,
      }));
    const contributions = await listContributionsForUser(env.KV, u.id);
    const contributionsDetailed = await Promise.all(
      contributions.map(async (c) => ({
        ...c,
        event: await getEvent(env.KV, c.eventId),
      }))
    );
    const rsvps = await listRsvpsForUser(env.KV, u.id);
    const waitlist = await listWaitlistForUser(env.KV, u.id);
    const rsvpDetailed = await Promise.all(
      rsvps.map(async (r) => ({
        event: await getEvent(env.KV, r.eventId),
        status: r.status,
        updatedAt: r.updatedAt,
      }))
    );
    const waitlistDetailed = await Promise.all(
      waitlist.map(async (w) => ({
        event: await getEvent(env.KV, w.eventId),
        createdAt: w.createdAt,
      }))
    );
    return json({
      user: u,
      interestedEvents,
      registeredEvents,
      registrations: registrationsDetailed,
      contributions: contributionsDetailed,
      rsvps: rsvpDetailed.filter((x) => x.event),
      waitlist: waitlistDetailed.filter((x) => x.event),
    });
  }

  if (method === "POST" && parts[0] === "api" && parts[1] === "contributions") {
    const user = await resolveSessionUser(env.KV, request.headers.get("Cookie"));
    if (!user) return json({ error: "unauthorized" }, { status: 401 });
    const body = await readJson<ContributionSubmitBody & { turnstileToken?: string }>(
      request
    );
    if (!body?.eventId || !body.role) return json({ error: "invalid_body" }, { status: 400 });
    const okTs = await requireTurnstile(env, request, body.turnstileToken);
    if (!okTs) return json({ error: "turnstile_failed" }, { status: 400 });
    const { turnstileToken: _t, ...rest } = body;
    const origin = `${url.protocol}//${url.host}`;
    const res = await handleContributionSubmit(env.KV, env, user, rest, origin);
    if (!res.ok) return json({ error: res.error }, { status: 400 });
    return json({ contribution: res.contribution });
  }

  if (
    method === "GET" &&
    parts[0] === "api" &&
    parts[1] === "events" &&
    parts[2] &&
    parts[3] === "contributions"
  ) {
    const user = await resolveSessionUser(env.KV, request.headers.get("Cookie"));
    if (!user) return json({ error: "unauthorized" }, { status: 401 });
    const u = await applyAdminBootstrap(env, user);
    const eventId = parts[2];
    const res = await listContributionsForOrganizer(env.KV, u, eventId);
    if (!res.ok) return json({ error: res.error }, { status: res.error === "forbidden" ? 403 : 404 });
    return json({ items: res.items });
  }

  if (method === "GET" && parts[0] === "api" && parts[1] === "contributions" && parts[2] && parts.length === 3) {
    const user = await resolveSessionUser(env.KV, request.headers.get("Cookie"));
    if (!user) return json({ error: "unauthorized" }, { status: 401 });
    const contribution = await getContribution(env.KV, parts[2]);
    if (!contribution) return json({ error: "not_found" }, { status: 404 });
    if (contribution.userId !== user.id) return json({ error: "forbidden" }, { status: 403 });
    const event = await getEvent(env.KV, contribution.eventId);
    return json({ contribution, event });
  }

  if (method === "PUT" && parts[0] === "api" && parts[1] === "contributions" && parts[2] && parts.length === 3) {
    const user = await resolveSessionUser(env.KV, request.headers.get("Cookie"));
    if (!user) return json({ error: "unauthorized" }, { status: 401 });
    const id = parts[2];
    const body = await readJson<ContributionUpdateBody & { turnstileToken?: string }>(request);
    if (!body) return json({ error: "invalid_body" }, { status: 400 });
    const okTs = await requireTurnstile(env, request, body.turnstileToken);
    if (!okTs) return json({ error: "turnstile_failed" }, { status: 400 });
    const { turnstileToken: _t, ...rest } = body;
    const res = await handleContributionUpdateByUser(env.KV, user, id, rest);
    if (!res.ok) {
      const status =
        res.error === "forbidden" ? 403 : res.error === "not_found" ? 404 : 400;
      return json({ error: res.error }, { status });
    }
    return json({ contribution: res.contribution });
  }

  if (method === "PUT" && parts[0] === "api" && parts[1] === "contributions" && parts[2] && parts[3] === "review") {
    const user = await resolveSessionUser(env.KV, request.headers.get("Cookie"));
    if (!user) return json({ error: "unauthorized" }, { status: 401 });
    const u = await applyAdminBootstrap(env, user);
    const id = parts[2];
    const body = await readJson<ContributionReviewBody & { turnstileToken?: string }>(
      request
    );
    if (!body?.status) return json({ error: "invalid_body" }, { status: 400 });
    const okTs = await requireTurnstile(env, request, body.turnstileToken);
    if (!okTs) return json({ error: "turnstile_failed" }, { status: 400 });
    const { turnstileToken: _t, ...rest } = body;
    const origin = `${url.protocol}//${url.host}`;
    const res = await handleContributionReview(env.KV, env, u, id, rest, origin);
    if (!res.ok) return json({ error: res.error }, { status: res.error === "forbidden" ? 403 : 404 });
    return json({ contribution: res.contribution });
  }

  if (
    method === "GET" &&
    parts[0] === "api" &&
    parts[1] === "organizer" &&
    parts[2] === "events" &&
    parts[3]
  ) {
    const user = await resolveSessionUser(env.KV, request.headers.get("Cookie"));
    if (!user) return json({ error: "unauthorized" }, { status: 401 });
    const u = await applyAdminBootstrap(env, user);
    const eventId = parts[3];
    const ev = await getEvent(env.KV, eventId);
    if (!ev) return json({ error: "not_found" }, { status: 404 });
    if (!u.organizationIds.includes(ev.organizationId) && !u.roles.includes("admin")) {
      return json({ error: "forbidden" }, { status: 403 });
    }
    const participants = await listRegistrationsForEvent(env.KV, eventId);
    return json({ event: ev, participants });
  }

  return json({ error: "not_found" }, { status: 404 });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Minimal embeddable card; meant for `<iframe src="…/embed.html">` on org websites. */
function buildEmbedHtml(ev: EventRecord): string {
  const title = escapeHtml(ev.title);
  const desc = escapeHtml(ev.description || "");
  const where =
    ev.mode === "online"
      ? "Online"
      : ev.mode === "hybrid"
        ? `Hybrid · ${escapeHtml(ev.location || "")}`
        : escapeHtml(ev.location || "");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>:root{color-scheme:dark light}body{margin:0;padding:1rem;font-family:system-ui,sans-serif;background:#0a0a0a;color:#fff;border:1px solid #2a2a2a;border-radius:10px}a{color:#7cfc00}h1{font-size:1.1rem;margin:0 0 .35rem}.muted{color:#9a9a9a;font-size:.85rem}p{margin:.4rem 0}.btn{display:inline-block;background:#7cfc00;color:#0a0a0a;padding:.5rem .8rem;border-radius:8px;text-decoration:none;font-weight:600;margin-top:.5rem}</style></head><body><h1>${title}</h1><p class="muted" id="ev-when" data-starts="${escapeHtml(ev.startsAt)}" data-ends="${escapeHtml(ev.endsAt)}"></p><p class="muted">${where}</p><p>${desc}</p><p><a class="btn" href="/#/event/${escapeHtml(ev.id)}" target="_blank" rel="noopener">View on EventMark</a></p><script>(function(){var el=document.getElementById("ev-when");if(!el)return;var s=new Date(el.dataset.starts),e=new Date(el.dataset.ends);if(isNaN(s))return;el.textContent=s.toLocaleString()+(isNaN(e)?"":" — "+e.toLocaleString());})();</script></body></html>`;
}

function escapeIcsText(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/;/g, "\\;").replace(/,/g, "\\,");
}

function buildIcs(ev: EventRecord): string {
  const uid = `${ev.id}@eventmark.local`;
  const dtStamp = nowIso().replace(/[-:]/g, "").split(".")[0] + "Z";
  const dtStart = ev.startsAt.replace(/[-:]/g, "").replace(/\.\d{3}Z?$/, "Z");
  const dtEnd = ev.endsAt.replace(/[-:]/g, "").replace(/\.\d{3}Z?$/, "Z");
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//EventMark//EN",
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${dtStamp}`,
    `DTSTART:${dtStart}`,
    `DTEND:${dtEnd}`,
    `SUMMARY:${escapeIcsText(ev.title)}`,
    `DESCRIPTION:${escapeIcsText(ev.description)}`,
    `LOCATION:${escapeIcsText(ev.location)}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.join("\r\n");
}

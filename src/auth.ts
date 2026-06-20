/**
 * Passwordless auth: OTP (6 digits, 5m TTL), HTTP-only session cookie (7d).
 * Email: Cloudflare Send Email binding in non-dev; console log in dev.
 */

import type { OtpRecord, SessionData, UserRecord } from "./db.js";
import {
  deleteOtp,
  deleteSession,
  getOtp,
  getRateLimit,
  getSession,
  getUserByEmail,
  getUserById,
  putSession,
  saveUser,
  setRateLimit,
  storeOtp,
} from "./db.js";
import { syncCheckinStaffForUser } from "./checkin-staff.js";

const OTP_TTL_SECONDS = 300;
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;
const OTP_RATE_MAX = 3;
const OTP_RATE_WINDOW_MS = 15 * 60 * 1000;
const OTP_RATE_KV_TTL = 16 * 60;

/* --- Org-request OTP (separate from sign-in OTP) --- */

const ORG_REQ_OTP_TTL_SECONDS = 300;
/** Once the user verifies the 9-digit code we mark their email as cleared for ~10m. */
const ORG_REQ_VERIFIED_TTL_SECONDS = 10 * 60;
const ORG_REQ_OTP_PREFIX = "orgreq_otp:";
const ORG_REQ_OTP_RATE_PREFIX = "orgreq_otp_req:";
const ORG_REQ_VERIFIED_PREFIX = "orgreq_verified:";

/** Default `From:` when `FROM_ADDRESS` is not set in Worker vars. Must match an onboarded Email Service domain. */
const DEFAULT_FROM_ADDRESS = "noreply@example.com";

export interface AuthEnv {
  KV: KVNamespace;
  ENVIRONMENT: string;
  EMAIL: {
    send(params: {
      to: string | { email: string; name?: string };
      from: string | { email: string; name?: string };
      subject: string;
      text?: string;
      html?: string;
    }): Promise<{ messageId: string }>;
  };
  /** "1" → log OTPs to console instead of sending. Set in `.dev.vars` only (local). */
  EMAIL_LOG_ONLY?: string;
  /** Optional override for Send Email `From:` address. Must match an onboarded Email Service domain. */
  FROM_ADDRESS?: string;
  /** Comma-separated admin emails (wrangler var); used for org-request admin notifications. */
  ADMIN_EMAILS?: string;
}

function fromAddress(env: AuthEnv): string {
  const v = (env.FROM_ADDRESS || "").trim();
  return v || DEFAULT_FROM_ADDRESS;
}

export interface TurnstileVerifyResult {
  success: boolean;
  "error-codes"?: string[];
}

export async function verifyTurnstile(
  secret: string,
  token: string,
  _remoteip?: string | undefined
): Promise<boolean> {
  if (!secret || !token) {
    console.error("[EventMark] Turnstile verify failed: missing secret or token");
    return false;
  }
  const body = new URLSearchParams();
  body.set("secret", secret);
  body.set("response", token);
  /* Do not send remoteip: CF-Connecting-IP vs Turnstile-bound IP often mismatches on
   * Workers + custom hostnames, causing false failures. */
  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    console.error("[EventMark] Turnstile verify HTTP error:", res.status);
    return false;
  }
  const json = (await res.json()) as TurnstileVerifyResult;
  if (!json.success) {
    console.error("[EventMark] Turnstile verify failed:", json["error-codes"] || "unknown error");
  }
  return json.success === true;
}

export async function checkOtpRateLimit(
  kv: KVNamespace,
  email: string
): Promise<{ allowed: boolean; retryAfterSeconds?: number }> {
  const key = `otp_req:${email.trim().toLowerCase()}`;
  const now = Date.now();
  const existing = await getRateLimit(kv, key);
  if (!existing) {
    await setRateLimit(
      kv,
      key,
      { count: 1, windowStart: now },
      OTP_RATE_KV_TTL
    );
    return { allowed: true };
  }
  if (now - existing.windowStart > OTP_RATE_WINDOW_MS) {
    await setRateLimit(
      kv,
      key,
      { count: 1, windowStart: now },
      OTP_RATE_KV_TTL
    );
    return { allowed: true };
  }
  if (existing.count >= OTP_RATE_MAX) {
    const retryAfterMs = OTP_RATE_WINDOW_MS - (now - existing.windowStart);
    return {
      allowed: false,
      retryAfterSeconds: Math.ceil(Math.max(retryAfterMs, 0) / 1000),
    };
  }
  existing.count += 1;
  await setRateLimit(kv, key, existing, OTP_RATE_KV_TTL);
  return { allowed: true };
}

function generateOtpCode(): string {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
  const code = (100000 + (n % 900000)).toString();
  return code;
}

/** 9-digit code for the org-request flow (intentionally different from the 6-digit sign-in code). */
function generateOrgRequestOtpCode(): string {
  // Two random uint32 → mix 9 decimal digits without bias drift.
  const a = crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
  const b = crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
  // Map to [100_000_000, 999_999_999] inclusive.
  const big = (BigInt(a) << 32n) | BigInt(b);
  const range = 900_000_000n;
  const code = (100_000_000n + (big % range)).toString();
  return code;
}

async function sendCodedEmail(
  env: AuthEnv,
  to: string,
  subject: string,
  text: string,
  context: string
): Promise<void> {
  if (env.EMAIL_LOG_ONLY === "1") {
    console.log(`[EventMark] ${context} email (log-only mode)`, { to, subject });
    return;
  }
  const from = fromAddress(env);
  try {
    await env.EMAIL.send({ to, from, subject, text });
  } catch (err) {
    console.error(`[EventMark] ${context} email send failed`, {
      to,
      env: env.ENVIRONMENT,
      message: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

export async function sendOtpEmail(
  env: AuthEnv,
  to: string,
  code: string
): Promise<void> {
  const subject = "Your EventMark sign-in code";
  const text = `Your EventMark one-time code is ${code}. It expires in 5 minutes.\r\n\r\nIf you did not request this, you can ignore this email.`;
  if (env.EMAIL_LOG_ONLY === "1") {
    console.log("[EventMark] OTP email (log-only mode)", { to, code, subject });
    return;
  }
  await sendCodedEmail(env, to, subject, text, "OTP");
}

/** Distinct subject + body so users can tell sign-in vs. org-request emails apart. */
export async function sendOrgRequestOtpEmail(
  env: AuthEnv,
  to: string,
  code: string,
  organizeUrl?: string
): Promise<void> {
  const subject = "Your EventMark organizer application code";
  const lines = [
    `Your EventMark organizer application one-time code is ${code}. It expires in 5 minutes.`,
    "",
    "Next steps:",
    organizeUrl
      ? `1. Open ${organizeUrl}`
      : "1. Sign in and open Organize → Become an organizer",
    "2. Enter this code to unlock the application form.",
    "",
    "If you did not request this, you can ignore this email.",
  ].join("\r\n");
  if (env.EMAIL_LOG_ONLY === "1") {
    console.log("[EventMark] OrgReq OTP email (log-only mode)", { to, code, subject });
    return;
  }
  await sendCodedEmail(env, to, subject, lines, "OrgReq OTP");
}

/** Confirmation to applicant after org request is submitted. */
export async function sendOrgRequestReceivedEmail(
  env: AuthEnv,
  to: string,
  args: {
    organizationName: string;
    submittedAt: string;
    organizeUrl: string;
  }
): Promise<void> {
  const subject = `We received your organizer application: ${args.organizationName}`;
  const lines = [
    `Organization: ${args.organizationName}`,
    `Submitted: ${args.submittedAt}`,
    "",
    "Thank you: your application is in the review queue.",
    "",
    "What happens next:",
    "- The EventMark admin team will review your application.",
    "- You will receive another email when a decision is made.",
    "",
    "No action is required while your status is Pending.",
    `Check status anytime: ${args.organizeUrl}`,
    "",
    "Please do not submit duplicate applications while a review is in progress.",
  ].join("\r\n");
  if (env.EMAIL_LOG_ONLY === "1") {
    console.log("[EventMark] Org request received email (log-only mode)", { to, subject });
    return;
  }
  await sendCodedEmail(env, to, subject, lines, "OrgRequestReceived");
}

/** Notify admins of a new or resubmitted org request. */
export async function sendOrgRequestAdminNotifyEmail(
  env: AuthEnv,
  to: string,
  args: {
    kind: "new" | "resubmitted";
    organizationName: string;
    contactEmail: string;
    website: string;
    requestId: string;
    reviewUrl: string;
  }
): Promise<void> {
  const subject =
    args.kind === "new"
      ? `[EventMark] New organizer application: ${args.organizationName}`
      : `[EventMark] Application resubmitted: ${args.organizationName}`;
  const lines = [
    args.kind === "new"
      ? "A new organizer application was submitted."
      : "An organizer application was resubmitted after a request for more information.",
    "",
    `Organization: ${args.organizationName}`,
    `Contact: ${args.contactEmail}`,
    `Website: ${args.website}`,
    `Request ID: ${args.requestId}`,
    "",
    "Next steps:",
    `1. Open the review queue: ${args.reviewUrl}`,
    "2. Approve, reject (with reason), or request more information.",
    "",
    "Please include a specific note when requesting more information.",
  ].join("\r\n");
  if (env.EMAIL_LOG_ONLY === "1") {
    console.log("[EventMark] Org request admin notify email (log-only mode)", {
      to,
      subject,
      kind: args.kind,
    });
    return;
  }
  await sendCodedEmail(env, to, subject, lines, "OrgRequestAdminNotify");
}

/** Notify admins when a user applies for profile verification. */
export async function sendUserVerificationAdminNotifyEmail(
  env: AuthEnv,
  to: string,
  args: {
    userName: string;
    userEmail: string;
    userId: string;
    reviewUrl: string;
  }
): Promise<void> {
  const subject = `[EventMark] Verification request: ${args.userName || args.userEmail}`;
  const lines = [
    "A user submitted a profile verification request.",
    "",
    `Name: ${args.userName || "(not set)"}`,
    `Email: ${args.userEmail}`,
    `User ID: ${args.userId}`,
    "",
    "Next steps:",
    `1. Open the review queue: ${args.reviewUrl}`,
    "2. Review their profile details and approve or reject verification.",
  ].join("\r\n");
  if (env.EMAIL_LOG_ONLY === "1") {
    console.log("[EventMark] User verification admin notify email (log-only mode)", { to, subject });
    return;
  }
  await sendCodedEmail(env, to, subject, lines, "UserVerificationAdminNotify");
}

/** Email contributor when organizer requests more information or makes a decision. */
export async function sendContributionStatusEmail(
  env: AuthEnv,
  to: string,
  args: {
    eventTitle: string;
    role: string;
    status: "APPROVED" | "REJECTED" | "INFO_REQUESTED";
    note?: string;
    resubmitUrl: string;
    dashboardUrl: string;
  }
): Promise<void> {
  const subject =
    args.status === "APPROVED"
      ? `Approved: your ${args.role.replace(/_/g, " ")} contribution for ${args.eventTitle}`
      : args.status === "REJECTED"
        ? `Update on your contribution for ${args.eventTitle}`
        : `Action required: more information for ${args.eventTitle}`;

  const statusMessage =
    args.status === "APPROVED"
      ? "Your contribution has been approved."
      : args.status === "REJECTED"
        ? "Your contribution was reviewed and could not be approved at this time."
        : "The organizer needs more information before they can review your contribution.";

  const actionLines =
    args.status === "INFO_REQUESTED"
      ? [
          "Next steps:",
          `1. Open the event registration form: ${args.resubmitUrl}`,
          `2. Or sign in and resubmit from your dashboard: ${args.dashboardUrl}`,
          "3. Review the organizer note below and update the requested fields.",
          "4. Your contribution returns to Pending until the organizer reviews again.",
        ]
      : args.status === "APPROVED"
        ? [`View the event: ${args.resubmitUrl.replace(/\/contribute\/.*$/, "")}`]
        : [
            "Next steps:",
            `1. Read the organizer note below.`,
            `2. You may submit a new contribution from the event page if appropriate.`,
          ];

  const lines = [
    `Event: ${args.eventTitle}`,
    `Role: ${args.role.replace(/_/g, " ")}`,
    "",
    statusMessage,
    "",
    args.note ? `Note from organizer: ${args.note}` : "",
    "",
    ...actionLines,
  ]
    .filter(Boolean)
    .join("\r\n");

  if (env.EMAIL_LOG_ONLY === "1") {
    console.log("[EventMark] Contribution status email (log-only mode)", { to, subject, status: args.status });
    return;
  }
  await sendCodedEmail(env, to, subject, lines, "ContributionStatus");
}

/** Email notification when org request status changes (approved/rejected/more info needed). */
export async function sendOrgRequestStatusEmail(
  env: AuthEnv,
  to: string,
  args: {
    organizationName: string;
    status: "APPROVED" | "REJECTED" | "INFO_REQUESTED";
    note?: string;
    organizeUrl: string;
  }
): Promise<void> {
  const subject =
    args.status === "APPROVED"
      ? `Approved: ${args.organizationName}: you can now create events`
      : args.status === "REJECTED"
        ? `Update on your organizer application: ${args.organizationName}`
        : `Action required: more information for ${args.organizationName}`;

  const statusMessage =
    args.status === "APPROVED"
      ? "Congratulations! Your organization has been approved. You can now create and publish events."
      : args.status === "REJECTED"
        ? "Your organization request has been reviewed and could not be approved at this time."
        : "We need more information to process your organization request. Please review the admin note below and resubmit.";

  const actionLines =
    args.status === "APPROVED"
      ? [
          "Next steps:",
          `1. Sign in and open: ${args.organizeUrl}`,
          "2. Create a draft event (title, date, location or online link, seats).",
          "3. Publish when ready: your event appears on the public calendar.",
          "4. In-person attendees receive a QR ticket by email after registration.",
        ]
      : args.status === "INFO_REQUESTED"
        ? [
            "Next steps:",
            `1. Sign in and open: ${args.organizeUrl}`,
            "2. Review the admin note below.",
            "3. Update the requested fields and click Resubmit.",
            "4. Your application returns to Pending until the admin reviews again.",
          ]
        : [
            "Next steps:",
            `1. Read the admin note below for the reason.`,
            `2. You may submit a new application: ${args.organizeUrl}`,
            "3. Address the feedback before reapplying.",
          ];

  const lines = [
    `Organization: ${args.organizationName}`,
    "",
    statusMessage,
    "",
    args.note ? `Note from admin: ${args.note}` : "",
    "",
    ...actionLines,
  ]
    .filter(Boolean)
    .join("\r\n");

  if (env.EMAIL_LOG_ONLY === "1") {
    console.log("[EventMark] Org request status email (log-only mode)", { to, subject, status: args.status });
    return;
  }
  await sendCodedEmail(env, to, subject, lines, "OrgRequestStatus");
}

/** Confirmation email for a native event registration; includes ticket code + QR link. */
export async function sendRegistrationEmail(
  env: AuthEnv,
  to: string,
  args: {
    eventTitle: string;
    eventStartsAt: string;
    eventLocation: string;
    eventMode: string;
    onlineUrl: string | null;
    ticketCode: string;
    ticketUrl: string;
  }
): Promise<void> {
  const subject = `Registered: ${args.eventTitle}`;
  const lines = [
    `You are registered for: ${args.eventTitle}`,
    `When: ${args.eventStartsAt}`,
    args.eventMode === "online"
      ? `Online: ${args.onlineUrl ?? "(link to be shared)"}`
      : args.eventMode === "hybrid"
        ? `In person: ${args.eventLocation}\r\nOnline: ${args.onlineUrl ?? "(link to be shared)"}`
        : `Where: ${args.eventLocation}`,
    "",
    `Ticket code: ${args.ticketCode}`,
    `Show at the door (scan QR): ${args.ticketUrl}`,
    "",
    "Reply if you have questions. See you soon!",
  ].join("\r\n");
  if (env.EMAIL_LOG_ONLY === "1") {
    console.log("[EventMark] Registration email (log-only mode)", { to, subject });
    return;
  }
  await sendCodedEmail(env, to, subject, lines, "Registration");
}

/** Email sent to attendee after successful QR check-in at the door. */
export async function sendCheckinConfirmationEmail(
  env: AuthEnv,
  to: string,
  args: {
    eventTitle: string;
    eventStartsAt: string;
    attendeeName?: string | null;
    checkedInAt: string;
    ticketCode?: string | null;
  }
): Promise<void> {
  const greeting = args.attendeeName?.trim() ? `Hi ${args.attendeeName.trim()},` : "Hi,";
  const subject = `Checked in: ${args.eventTitle}`;
  const lines = [
    greeting,
    "",
    `You are checked in for: ${args.eventTitle}`,
    `When: ${args.eventStartsAt}`,
    `Checked in at: ${args.checkedInAt}`,
    args.ticketCode ? `Ticket: ${args.ticketCode}` : "",
    "",
    "Enjoy the event!",
  ]
    .filter(Boolean)
    .join("\r\n");
  if (env.EMAIL_LOG_ONLY === "1") {
    console.log("[EventMark] Check-in email (log-only mode)", { to, subject });
    return;
  }
  await sendCodedEmail(env, to, subject, lines, "Check-in");
}

/** Organizer-triggered invite/reminder/pass campaign email. */
export async function sendEventCampaignEmail(
  env: AuthEnv,
  to: string,
  args: {
    eventTitle: string;
    eventStartsAt: string;
    campaignType: "invite" | "reminder" | "pass";
    eventUrl: string;
    passToken?: string | null;
  }
): Promise<void> {
  const label =
    args.campaignType === "invite"
      ? "Invitation"
      : args.campaignType === "reminder"
        ? "Reminder"
        : "Your Event Pass";
  const subject = `${label}: ${args.eventTitle}`;
  const lines = [
    `${label} for ${args.eventTitle}`,
    `When: ${args.eventStartsAt}`,
    `Event page: ${args.eventUrl}`,
    args.passToken ? `Pass token: ${args.passToken}` : "",
    "",
    "This email was sent by the event organizer through EventMark.",
  ]
    .filter(Boolean)
    .join("\r\n");

  if (env.EMAIL_LOG_ONLY === "1") {
    console.log("[EventMark] Campaign email (log-only mode)", {
      to,
      subject,
      type: args.campaignType,
    });
    return;
  }
  await sendCodedEmail(env, to, subject, lines, "Campaign");
}

/* --- Org-request OTP issue / verify --- */

async function checkOrgReqRateLimit(
  kv: KVNamespace,
  email: string
): Promise<{ allowed: boolean; retryAfterSeconds?: number }> {
  const now = Date.now();
  const key = `${ORG_REQ_OTP_RATE_PREFIX}${email.trim().toLowerCase()}`;
  const raw = await kv.get(key, "json");
  const existing = raw as { count: number; windowStart: number } | null;
  if (!existing || now - existing.windowStart > OTP_RATE_WINDOW_MS) {
    await kv.put(
      key,
      JSON.stringify({ count: 1, windowStart: now }),
      { expirationTtl: OTP_RATE_KV_TTL }
    );
    return { allowed: true };
  }
  if (existing.count >= OTP_RATE_MAX) {
    return {
      allowed: false,
      retryAfterSeconds: Math.ceil(
        Math.max(OTP_RATE_WINDOW_MS - (now - existing.windowStart), 0) / 1000
      ),
    };
  }
  await kv.put(
    key,
    JSON.stringify({ count: existing.count + 1, windowStart: existing.windowStart }),
    { expirationTtl: OTP_RATE_KV_TTL }
  );
  return { allowed: true };
}

export async function issueOrgRequestOtp(
  env: AuthEnv,
  email: string,
  organizeUrl?: string
): Promise<
  | { ok: true; ttl: number }
  | { ok: false; error: string; retryAfterSeconds?: number }
> {
  const rl = await checkOrgReqRateLimit(env.KV, email);
  if (!rl.allowed) {
    return { ok: false, error: "rate_limited", retryAfterSeconds: rl.retryAfterSeconds };
  }
  const code = generateOrgRequestOtpCode();
  const expiresAt = Date.now() + ORG_REQ_OTP_TTL_SECONDS * 1000;
  const record = { code, email: email.trim(), expiresAt, attempts: 0 };
  await env.KV.put(
    `${ORG_REQ_OTP_PREFIX}${email.trim().toLowerCase()}`,
    JSON.stringify(record),
    { expirationTtl: ORG_REQ_OTP_TTL_SECONDS }
  );
  await sendOrgRequestOtpEmail(env, email.trim(), code, organizeUrl);
  return { ok: true, ttl: ORG_REQ_OTP_TTL_SECONDS };
}

export async function verifyOrgRequestOtp(
  env: AuthEnv,
  email: string,
  code: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const key = `${ORG_REQ_OTP_PREFIX}${email.trim().toLowerCase()}`;
  const raw = await env.KV.get(key, "json");
  const stored = raw as { code: string; expiresAt: number; attempts: number } | null;
  if (!stored) return { ok: false, error: "otp_missing" };
  if (Date.now() > stored.expiresAt) {
    await env.KV.delete(key);
    return { ok: false, error: "otp_expired" };
  }
  if (stored.attempts >= 8) {
    await env.KV.delete(key);
    return { ok: false, error: "too_many_attempts" };
  }
  if (stored.code !== code.trim()) {
    stored.attempts += 1;
    await env.KV.put(key, JSON.stringify(stored), {
      expirationTtl: ORG_REQ_OTP_TTL_SECONDS,
    });
    return { ok: false, error: "invalid_code" };
  }
  await env.KV.delete(key);
  await env.KV.put(
    `${ORG_REQ_VERIFIED_PREFIX}${email.trim().toLowerCase()}`,
    "1",
    { expirationTtl: ORG_REQ_VERIFIED_TTL_SECONDS }
  );
  return { ok: true };
}

/** Pop-once: returns true if a verified flag exists, then deletes it. */
export async function consumeOrgRequestVerification(
  env: AuthEnv,
  email: string
): Promise<boolean> {
  const key = `${ORG_REQ_VERIFIED_PREFIX}${email.trim().toLowerCase()}`;
  const flag = await env.KV.get(key);
  if (!flag) return false;
  await env.KV.delete(key);
  return true;
}

export async function issueOtp(
  env: AuthEnv,
  email: string
): Promise<{ ok: true; ttl: number } | { ok: false; error: string; retryAfterSeconds?: number }> {
  const rl = await checkOtpRateLimit(env.KV, email);
  if (!rl.allowed) {
    return {
      ok: false,
      error: "rate_limited",
      retryAfterSeconds: rl.retryAfterSeconds,
    };
  }
  const code = generateOtpCode();
  const expiresAt = Date.now() + OTP_TTL_SECONDS * 1000;
  const record: OtpRecord = { code, email: email.trim(), expiresAt, attempts: 0 };
  await storeOtp(env.KV, email, record, OTP_TTL_SECONDS);
  await sendOtpEmail(env, email.trim(), code);
  return { ok: true, ttl: OTP_TTL_SECONDS };
}

export async function verifyOtpAndCreateSession(
  env: AuthEnv,
  email: string,
  code: string
): Promise<
  | { ok: true; token: string; user: UserRecord; isNewUser: boolean }
  | { ok: false; error: string }
> {
  const stored = await getOtp(env.KV, email);
  if (!stored) return { ok: false, error: "otp_missing" };
  if (Date.now() > stored.expiresAt) {
    await deleteOtp(env.KV, email);
    return { ok: false, error: "otp_expired" };
  }
  if (stored.attempts >= 8) {
    await deleteOtp(env.KV, email);
    return { ok: false, error: "too_many_attempts" };
  }
  if (stored.code !== code.trim()) {
    stored.attempts += 1;
    await storeOtp(env.KV, email, stored, OTP_TTL_SECONDS);
    return { ok: false, error: "invalid_code" };
  }
  await deleteOtp(env.KV, email);
  let user = await getUserByEmail(env.KV, email);
  const ts = new Date().toISOString();
  let isNewUser = false;
  if (!user) {
    isNewUser = true;
    const id = crypto.randomUUID();
    user = {
      id,
      email: email.trim().toLowerCase(),
      roles: ["user"],
      organizationIds: [],
      checkinOrganizationIds: [],
      createdAt: ts,
      updatedAt: ts,
    };
    await saveUser(env.KV, user);
  }
  user = await syncCheckinStaffForUser(env.KV, user);
  const tokenBytes = new Uint8Array(32);
  crypto.getRandomValues(tokenBytes);
  const token = Array.from(tokenBytes, (b) => b.toString(16).padStart(2, "0")).join("");
  const session: SessionData = {
    userId: user.id,
    createdAt: Date.now(),
    expiresAt: Date.now() + SESSION_TTL_SECONDS * 1000,
  };
  await putSession(env.KV, token, session, SESSION_TTL_SECONDS);
  return { ok: true, token, user, isNewUser };
}

export function sessionCookieHeader(token: string, secure: boolean): string {
  const parts = [
    `em_session=${token}`,
    "HttpOnly",
    "SameSite=Strict",
    "Path=/",
    `Max-Age=${SESSION_TTL_SECONDS}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearSessionCookieHeader(secure: boolean): string {
  const parts = ["em_session=", "HttpOnly", "SameSite=Strict", "Path=/", "Max-Age=0"];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function parseSessionCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  const parts = cookieHeader.split(";").map((p) => p.trim());
  for (const p of parts) {
    if (p.startsWith("em_session=")) {
      return p.slice("em_session=".length) || null;
    }
  }
  return null;
}

export async function resolveSessionUser(
  kv: KVNamespace,
  cookieHeader: string | null
): Promise<UserRecord | null> {
  const token = parseSessionCookie(cookieHeader);
  if (!token) return null;
  const sess = await getSession(kv, token);
  if (!sess) return null;
  if (Date.now() > sess.expiresAt) {
    await deleteSession(kv, token);
    return null;
  }
  return getUserById(kv, sess.userId);
}

export async function logout(kv: KVNamespace, cookieHeader: string | null): Promise<void> {
  const token = parseSessionCookie(cookieHeader);
  if (token) await deleteSession(kv, token);
}

export { OTP_TTL_SECONDS, SESSION_TTL_SECONDS };

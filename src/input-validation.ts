/** Shared input validation for events, organizations, and URLs. */

export const EVENT_TITLE_MAX = 26;
export const PERSON_NAME_MAX = 26;
export const EVENT_DESCRIPTION_MAX_WORDS = 500;

const SQL_INJECTION_PATTERN =
  /\b(union\s+select|insert\s+into|delete\s+from|drop\s+table|update\s+.+\s+set|;\s*--|or\s+1\s*=\s*1|exec\s+xp_|benchmark\s*\(|sleep\s*\()/i;

const EMOJI_PATTERN =
  /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}]/u;

const SPAM_URL_HOSTS = new Set([
  "bit.ly",
  "tinyurl.com",
  "t.co",
  "goo.gl",
  "ow.ly",
  "adf.ly",
  "is.gd",
  "buff.ly",
  "cutt.ly",
  "rb.gy",
]);

export function sanitizeText(s: unknown, maxLen: number): string {
  return String(s ?? "")
    .replace(/\0/g, "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .trim()
    .slice(0, maxLen);
}

export function wordCount(s: string): number {
  const t = String(s || "").trim();
  if (!t) return 0;
  return t.split(/\s+/).filter(Boolean).length;
}

export function containsEmoji(s: string): boolean {
  return EMOJI_PATTERN.test(String(s || ""));
}

export function hasSuspiciousSqlPattern(s: string): boolean {
  return SQL_INJECTION_PATTERN.test(String(s || ""));
}

export function rejectUnsafeText(s: string): string | null {
  if (hasSuspiciousSqlPattern(s)) return "invalid_input";
  if (containsEmoji(s)) return "emoji_not_allowed";
  return null;
}

export function isSafeHttpUrl(value: string | null | undefined): boolean {
  if (!value) return false;
  const raw = String(value).trim();
  if (raw.includes("@")) return false;
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    if (u.username || u.password) return false;
    const host = u.hostname.toLowerCase();
    if (!host || host.length > 253) return false;
    if (SPAM_URL_HOSTS.has(host)) return false;
    return true;
  } catch {
    return false;
  }
}

export interface SpeakerInput {
  name?: string;
  link?: string;
  org?: string;
  orgLink?: string;
}

export interface EventBodyInput {
  title?: string;
  description?: string;
  location?: string;
  startsAt?: string;
  endsAt?: string;
  online_url?: string | null;
  website_url?: string | null;
  external_url?: string | null;
  min_seats?: number;
  max_seats?: number;
  speakers?: SpeakerInput[];
  is_external?: boolean;
  mode?: string;
}

export interface SanitizedSpeaker {
  name: string;
  link: string;
  org: string;
  orgLink: string;
}

export interface SanitizedEventBody {
  title: string;
  description: string;
  location: string;
  startsAt: string;
  endsAt: string;
  online_url: string | null;
  website_url: string | null;
  external_url: string | null;
  min_seats: number;
  max_seats: number;
  speakers: SanitizedSpeaker[];
}

function parseIsoDate(s: string): number | null {
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

function validateSeats(minSeats: number, maxSeats: number): string | null {
  if (!Number.isFinite(minSeats) || !Number.isFinite(maxSeats)) return "seats_invalid";
  if (minSeats < 0 || maxSeats < 0) return "seats_invalid";
  if (maxSeats > 0 && minSeats > maxSeats) return "seats_invalid";
  return null;
}

function sanitizeSpeakers(speakers: SpeakerInput[] | undefined): SanitizedSpeaker[] | string {
  if (!Array.isArray(speakers)) return [];
  const out: SanitizedSpeaker[] = [];
  for (const s of speakers.slice(0, 50)) {
    const name = sanitizeText(s?.name, PERSON_NAME_MAX);
    if (!name) continue;
    if (name.length > PERSON_NAME_MAX) return "speaker_name_too_long";
    const unsafe = rejectUnsafeText(name);
    if (unsafe) return unsafe;
    const link = sanitizeText(s?.link, 500);
    const org = sanitizeText(s?.org, 200);
    const orgLink = sanitizeText(s?.orgLink, 500);
    for (const part of [org, link, orgLink]) {
      const u = rejectUnsafeText(part);
      if (u) return u;
    }
    if (link && !isSafeHttpUrl(link)) return "invalid_url";
    if (orgLink && !isSafeHttpUrl(orgLink)) return "invalid_url";
    out.push({ name, link, org, orgLink });
  }
  return out;
}

export function validateEventBody(
  body: EventBodyInput,
  opts: { requireCore?: boolean } = {}
): { ok: false; error: string; message?: string } | { ok: true; sanitized: SanitizedEventBody } {
  const requireCore = opts.requireCore !== false;

  const titleRaw = String(body.title ?? "").trim();
  const title = sanitizeText(titleRaw, EVENT_TITLE_MAX);
  if (requireCore && !title) return { ok: false, error: "title_required", message: "Title is required." };
  if (titleRaw.length > EVENT_TITLE_MAX) {
    return { ok: false, error: "title_too_long", message: `Title must be ${EVENT_TITLE_MAX} characters or fewer.` };
  }
  const titleUnsafe = rejectUnsafeText(title);
  if (title && titleUnsafe) return { ok: false, error: titleUnsafe };

  const descriptionRaw = String(body.description ?? "");
  const description = sanitizeText(descriptionRaw, 8000);
  if (wordCount(description) > EVENT_DESCRIPTION_MAX_WORDS) {
    return {
      ok: false,
      error: "description_too_long",
      message: `Description must be ${EVENT_DESCRIPTION_MAX_WORDS} words or fewer.`,
    };
  }
  const descUnsafe = rejectUnsafeText(description);
  if (descUnsafe) return { ok: false, error: descUnsafe };

  const location = sanitizeText(body.location, 500);
  const locUnsafe = rejectUnsafeText(location);
  if (locUnsafe) return { ok: false, error: locUnsafe };

  const startsAt = String(body.startsAt ?? "").trim();
  const endsAt = String(body.endsAt ?? "").trim();
  if (requireCore && (!startsAt || !endsAt)) {
    return { ok: false, error: "invalid_body", message: "Start and end date/time are required." };
  }
  const startMs = startsAt ? parseIsoDate(startsAt) : 0;
  const endMs = endsAt ? parseIsoDate(endsAt) : 0;
  if (startsAt && startMs === null) return { ok: false, error: "invalid_date", message: "Invalid start date." };
  if (endsAt && endMs === null) return { ok: false, error: "invalid_date", message: "Invalid end date." };
  if (startsAt && endsAt && startMs !== null && endMs !== null && endMs <= startMs) {
    return { ok: false, error: "end_before_start", message: "End date/time must be after the start." };
  }

  const minSeats = Math.max(0, Math.floor(Number(body.min_seats ?? 0)) || 0);
  const maxSeats = Math.max(0, Math.floor(Number(body.max_seats ?? 0)) || 0);
  const seatsErr = validateSeats(minSeats, maxSeats);
  if (seatsErr) {
    return {
      ok: false,
      error: seatsErr,
      message: "Seat counts must be zero or positive, and minimum cannot exceed maximum.",
    };
  }

  const mode = body.mode;
  const onlineUrlRaw = body.online_url ? String(body.online_url).trim() : "";
  if ((mode === "online" || mode === "hybrid") && !onlineUrlRaw) {
    return { ok: false, error: "online_url_required", message: "Online events need a join link." };
  }
  if (onlineUrlRaw && !isSafeHttpUrl(onlineUrlRaw)) {
    return { ok: false, error: "invalid_url", message: "Online link must be a valid http(s) URL." };
  }

  const websiteRaw = body.website_url ? String(body.website_url).trim() : "";
  if (websiteRaw && !isSafeHttpUrl(websiteRaw)) {
    return { ok: false, error: "invalid_url", message: "Website must be a valid http(s) URL." };
  }

  const isExternal = Boolean(body.is_external);
  const externalRaw = body.external_url ? String(body.external_url).trim() : "";
  if (isExternal && !externalRaw) {
    return { ok: false, error: "external_url_required", message: "Add the external registration URL." };
  }
  if (externalRaw && !isSafeHttpUrl(externalRaw)) {
    return { ok: false, error: "invalid_url", message: "Registration URL must be a valid http(s) URL." };
  }

  const speakersResult = sanitizeSpeakers(body.speakers);
  if (typeof speakersResult === "string") {
    const messages: Record<string, string> = {
      speaker_name_too_long: `Speaker names must be ${PERSON_NAME_MAX} characters or fewer.`,
      invalid_url: "Speaker links must be valid http(s) URLs.",
      invalid_input: "Input contains disallowed characters or patterns.",
      emoji_not_allowed: "Emojis are not allowed in event fields.",
    };
    return { ok: false, error: speakersResult, message: messages[speakersResult] || "Invalid speaker data." };
  }

  return {
    ok: true,
    sanitized: {
      title,
      description,
      location,
      startsAt,
      endsAt,
      online_url: mode !== "in_person" && onlineUrlRaw ? onlineUrlRaw : null,
      website_url: websiteRaw || null,
      external_url: isExternal && externalRaw ? externalRaw : null,
      min_seats: minSeats,
      max_seats: maxSeats,
      speakers: speakersResult,
    },
  };
}

export function validateOrgTextField(value: unknown, maxLen: number, required = false): string | null {
  const text = sanitizeText(value, maxLen);
  if (required && !text) return "required";
  if (!text) return null;
  return rejectUnsafeText(text);
}

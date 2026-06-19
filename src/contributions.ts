/**
 * Contribution submissions (Participant / Speaker / Volunteer / Topic Proposer)
 * and organizer review flows.
 */

import type {
  ContributionPayload,
  ContributionRecord,
  ContributionRole,
  ContributionStatus,
  EventRecord,
  SpeakerPayload,
  TopicProposerPayload,
  UserRecord,
  VolunteerPayload,
} from "./db.js";
import { userHasOrgOrganizerAccess } from "./checkin-staff.js";
import {
  getContribution,
  getEvent,
  getInterest,
  getRegistration,
  getSettings,
  getWaitlist,
  listContributionsForEvent,
  reviewContribution,
  saveEvent,
  saveInterest,
  saveRegistration,
  saveWaitlist,
  submitContribution,
  tryReserveEventSeat,
  updateContribution,
} from "./db.js";
import { generateTicketCode } from "./ticket-code.js";
import { ticketQrImageUrl } from "./qrcode.js";
import { saveIssuedTicket, ticketPassSecretFromEnv } from "./ticket-pass.js";
import type { AuthEnv } from "./auth.js";
import { sendContributionStatusEmail, sendRegistrationEmail } from "./auth.js";

export interface ContributionSubmitBody {
  eventId: string;
  role: ContributionRole;
  participant?: Record<string, never>;
  speaker?: Omit<SpeakerPayload, "kind">;
  volunteer?: Omit<VolunteerPayload, "kind">;
  topic_proposer?: Omit<TopicProposerPayload, "kind">;
  /** When true, also create an interest record for this event */
  createInterest?: boolean;
  /** When true, also create a native registration for this event */
  createRegistration?: boolean;
}

export interface ContributionUpdateBody {
  speaker?: Omit<SpeakerPayload, "kind">;
  volunteer?: Omit<VolunteerPayload, "kind">;
  topic_proposer?: Omit<TopicProposerPayload, "kind">;
}

function contributionResubmitUrl(origin: string, eventId: string, contributionId: string): string {
  const base = origin.replace(/\/$/, "");
  return `${base}/#/event/${eventId}/contribute/${contributionId}`;
}

function contributionDashboardUrl(origin: string, contributionId: string): string {
  const base = origin.replace(/\/$/, "");
  return `${base}/#/dashboard?contrib=${contributionId}`;
}

export interface ContributionReviewBody {
  status: Extract<ContributionStatus, "APPROVED" | "REJECTED" | "INFO_REQUESTED">;
  organizerNote?: string | null;
  /** ISO start for generated agenda slot when approving a speaker */
  slotStartsAt?: string;
  slotEndsAt?: string;
}

function buildPayload(body: ContributionSubmitBody, user: UserRecord): ContributionPayload | null {
  const email = user.email;
  const fullName = user.name || email.split("@")[0];

  switch (body.role) {
    case "participant":
      return { kind: "participant", email, fullName };
    case "speaker": {
      const s = body.speaker;
      if (!s?.topicTitle || !s.abstract || !s.preferredSlot || !s.bio) return null;
      return {
        kind: "speaker",
        email,
        fullName,
        topicTitle: s.topicTitle,
        abstract: s.abstract,
        preferredSlot: s.preferredSlot,
        bio: s.bio,
      };
    }
    case "volunteer": {
      const v = body.volunteer;
      if (!v?.skills || !v.availability) return null;
      return {
        kind: "volunteer",
        email,
        fullName,
        skills: v.skills,
        availability: v.availability,
      };
    }
    case "topic_proposer": {
      const t = body.topic_proposer;
      if (!t?.topicTitle || !t.description || !t.format) return null;
      return {
        kind: "topic_proposer",
        email,
        fullName,
        topicTitle: t.topicTitle,
        description: t.description,
        format: t.format,
      };
    }
    default:
      return null;
  }
}

function buildPayloadFromUpdate(
  role: ContributionRole,
  body: ContributionUpdateBody,
  user: UserRecord
): ContributionPayload | null {
  return buildPayload({ eventId: "", role, ...body } as ContributionSubmitBody, user);
}

export async function handleContributionSubmit(
  kv: KVNamespace,
  env: AuthEnv & { INVITE_PASS_SECRET?: string; LOCAL_DEV?: string; PUBLIC_SITE_URL?: string },
  user: UserRecord,
  body: ContributionSubmitBody,
  siteOrigin: string
): Promise<
  { ok: true; contribution: ContributionRecord } | { ok: false; error: string }
> {
  const event = await getEvent(kv, body.eventId);
  if (!event) return { ok: false, error: "event_not_found" };
  if ((event.status ?? "published") !== "published") {
    return { ok: false, error: "not_published" };
  }

  // Create interest if requested (single-call operation to avoid double Turnstile)
  if (body.createInterest) {
    const existingInterest = await getInterest(kv, event.id, user.id);
    if (!existingInterest) {
      const interest: import("./db.js").InterestRecord = {
        id: crypto.randomUUID(),
        eventId: event.id,
        userId: user.id,
        createdAt: new Date().toISOString(),
      };
      await saveInterest(kv, interest);
      event.interestedCount = (event.interestedCount ?? 0) + 1;
    }
  }

  // Create registration if requested (single-call operation to avoid double Turnstile)
  let ticketCode: string | undefined;
  if (body.createRegistration) {
    if (event.is_external) return { ok: false, error: "external_event" };
    const regSettings = await getSettings(kv);
    if (regSettings.pauseRegistrations) return { ok: false, error: "registrations_paused" };
    const existingReg = await getRegistration(kv, event.id, user.id);
    if (existingReg) {
      ticketCode = existingReg.ticketCode;
    } else {
      if ((event.max_seats ?? 0) > 0) {
        const maxSeats = event.max_seats ?? 0;
        const reserved = await tryReserveEventSeat(kv, event.id, user.id, maxSeats);
        if (!reserved.ok) {
          const existingWait = await getWaitlist(kv, event.id, user.id);
          if (!existingWait) {
            await saveWaitlist(kv, {
              id: crypto.randomUUID(),
              eventId: event.id,
              userId: user.id,
              createdAt: new Date().toISOString(),
            });
          }
          return { ok: false, error: "event_full" };
        }
      }
      ticketCode = generateTicketCode();
      const registration: import("./db.js").RegistrationRecord = {
        id: crypto.randomUUID(),
        eventId: event.id,
        userId: user.id,
        type: "native",
        ticketCode,
        createdAt: new Date().toISOString(),
      };
      await saveRegistration(kv, registration);
      await saveIssuedTicket(
        kv,
        ticketCode,
        { eventId: event.id, userId: user.id, registrationId: registration.id },
        ticketPassSecretFromEnv(env)
      );
      event.registeredCount = (event.registeredCount ?? 0) + 1;
      try {
        const publicSite = (env.PUBLIC_SITE_URL || "").trim() || siteOrigin;
        await sendRegistrationEmail(env, user.email, {
          eventTitle: event.title,
          eventStartsAt: event.startsAt,
          eventLocation: event.location,
          eventMode: event.mode ?? "in_person",
          onlineUrl: event.online_url ?? null,
          ticketCode,
          ticketUrl: ticketQrImageUrl(publicSite, ticketCode),
        });
      } catch (err) {
        console.error("[EventMark] contribution registration email failed", {
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // Persist event counter updates if interest or registration was created
  if (body.createInterest || body.createRegistration) {
    await saveEvent(kv, event);
  }

  const payload = buildPayload(body, user);
  if (!payload) return { ok: false, error: "invalid_payload" };
  const contribution = await submitContribution(kv, {
    eventId: event.id,
    userId: user.id,
    role: body.role,
    payload,
  });
  return { ok: true, contribution };
}

export async function assertOrganizerForEvent(
  _kv: KVNamespace,
  user: UserRecord,
  event: EventRecord
): Promise<boolean> {
  return userHasOrgOrganizerAccess(user, event.organizationId);
}

export async function handleContributionReview(
  kv: KVNamespace,
  env: AuthEnv,
  user: UserRecord,
  contributionId: string,
  body: ContributionReviewBody,
  origin: string
): Promise<
  | { ok: true; contribution: ContributionRecord }
  | { ok: false; error: string }
> {
  const existing = await getContribution(kv, contributionId);
  if (!existing) return { ok: false, error: "not_found" };
  const event = await getEvent(kv, existing.eventId);
  if (!event) return { ok: false, error: "event_not_found" };
  const allowed = await assertOrganizerForEvent(kv, user, event);
  if (!allowed) return { ok: false, error: "forbidden" };

  if (body.status === "APPROVED" && existing.role === "speaker") {
    const starts = body.slotStartsAt ?? event.startsAt;
    const ends = body.slotEndsAt ?? event.endsAt;
    const p = existing.payload;
    if (p.kind !== "speaker") return { ok: false, error: "invalid_contribution" };
    const slotId = `slot_${existing.id}`;
    const updated = await reviewContribution(kv, contributionId, {
      status: "APPROVED",
      organizerNote: body.organizerNote ?? null,
      approvedSpeakerSlot: {
        id: slotId,
        title: p.topicTitle,
        startsAt: starts,
        endsAt: ends,
        speakerUserId: existing.userId,
        speakerName: null,
        abstract: p.abstract,
      },
    });
    if (!updated) return { ok: false, error: "update_failed" };
    return { ok: true, contribution: updated };
  }

  existing.status = body.status;
  existing.organizerNote = body.organizerNote ?? null;
  await updateContribution(kv, existing);

  if (body.status === "INFO_REQUESTED" || body.status === "REJECTED" || body.status === "APPROVED") {
    const contributorEmail = existing.payload.email;
    if (contributorEmail) {
      try {
        await sendContributionStatusEmail(env, contributorEmail, {
          eventTitle: event.title,
          role: existing.role,
          status: body.status,
          note: body.organizerNote ?? undefined,
          resubmitUrl: contributionResubmitUrl(origin, event.id, existing.id),
          dashboardUrl: contributionDashboardUrl(origin, existing.id),
        });
      } catch (err) {
        console.error("[EventMark] contribution status email failed", {
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return { ok: true, contribution: existing };
}

export async function handleContributionUpdateByUser(
  kv: KVNamespace,
  user: UserRecord,
  contributionId: string,
  body: ContributionUpdateBody
): Promise<
  | { ok: true; contribution: ContributionRecord }
  | { ok: false; error: string }
> {
  const existing = await getContribution(kv, contributionId);
  if (!existing) return { ok: false, error: "not_found" };
  if (existing.userId !== user.id) return { ok: false, error: "forbidden" };
  if (existing.status !== "INFO_REQUESTED") return { ok: false, error: "not_info_requested" };
  if (existing.role === "participant") return { ok: false, error: "invalid_contribution" };

  const payload = buildPayloadFromUpdate(existing.role, body, user);
  if (!payload) return { ok: false, error: "invalid_payload" };

  existing.payload = payload;
  existing.status = "PENDING_APPROVAL";
  existing.updatedAt = new Date().toISOString();
  await updateContribution(kv, existing);
  return { ok: true, contribution: existing };
}

export async function listContributionsForOrganizer(
  kv: KVNamespace,
  user: UserRecord,
  eventId: string
): Promise<
  { ok: true; items: ContributionRecord[] } | { ok: false; error: string }
> {
  const event = await getEvent(kv, eventId);
  if (!event) {
    return { ok: false, error: "event_not_found" };
  }
  const allowed = await assertOrganizerForEvent(kv, user, event);
  if (!allowed) {
    return { ok: false, error: "forbidden" };
  }
  const items = await listContributionsForEvent(kv, eventId);
  return { ok: true, items };
}

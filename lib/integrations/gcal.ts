// Google Calendar: schedule an interview from an applicant's page. Free/busy is checked first; the event is created on
// the reviewer's calendar with a Google Meet link and an invitation to the candidate (and any interviewers).
// The event id is derived from the applicant and time, so a retried request can't create a second invitation.
import crypto from "node:crypto";
import { db, logEvent, type ApplicantRow, type JobRow, type Org } from "../db";
import { ApiError, authedJson, ctxFor, getConn, httpJson, log, toTokens, type Conn, type Ctx, type Tokens } from "./core";
import { form, type Provider } from "./provider";

export const GCAL = "gcal";
const CAL = "https://www.googleapis.com/calendar/v3";
const SCOPES = "openid email https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.freebusy";

db.exec(`
  CREATE TABLE IF NOT EXISTS interviews (
    id INTEGER PRIMARY KEY,
    org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    applicant_id INTEGER NOT NULL REFERENCES applicants(id) ON DELETE CASCADE,
    starts_at INTEGER NOT NULL,
    minutes INTEGER NOT NULL,
    event_id TEXT NOT NULL,
    html_link TEXT NOT NULL DEFAULT '',
    meet_link TEXT NOT NULL DEFAULT '',
    attendees TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'scheduled',
    created_at INTEGER NOT NULL
  );
`);
export type Interview = { id: number; org_id: number; applicant_id: number; starts_at: number; minutes: number; event_id: string; html_link: string; meet_link: string; attendees: string; status: "scheduled" | "cancelled"; created_at: number };

async function tokenRequest(ctx: Ctx, f: Record<string, string | undefined>, prev?: Tokens): Promise<Tokens> {
  const live = ctx.mode === "live";
  const r = await httpJson<{ access_token: string; refresh_token?: string; expires_in: number }>(ctx, "https://oauth2.googleapis.com/token", {
    method: "POST", idempotent: false, headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form({ client_id: live ? process.env.GOOGLE_CLIENT_ID : "sandbox", client_secret: live ? process.env.GOOGLE_CLIENT_SECRET : "sandbox", ...f }),
  });
  return toTokens(r, prev);
}
const refresher = (ctx: Ctx) => (t: Tokens) => tokenRequest(ctx, { grant_type: "refresh_token", refresh_token: t.refresh_token }, t);
const g = <T,>(c: Conn, ctx: Ctx, url: string, init: Parameters<typeof authedJson>[4] = {}) => authedJson<T>(ctx, c, refresher(ctx), url, init);

export const gcal: Provider = {
  id: GCAL,
  name: "Google Calendar",
  blurb: "Schedule interviews from an applicant's page: checks your calendar for conflicts, then sends the invitation with a Google Meet link.",
  env: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
  authorizeUrl: (state, challenge, redirectUri) =>
    `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID ?? "", redirect_uri: redirectUri, response_type: "code", scope: SCOPES, state,
      access_type: "offline", prompt: "consent", include_granted_scopes: "true", code_challenge: challenge, code_challenge_method: "S256",
    })}`,
  async exchange(ctx, code, redirectUri, verifier) {
    const secret = await tokenRequest(ctx, { grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: verifier });
    if (!secret.refresh_token) throw new Error("Google didn't return a refresh token; remove the app's access in your Google account and connect again");
    const me = await httpJson<{ email?: string }>(ctx, "https://openidconnect.googleapis.com/v1/userinfo", { headers: { Authorization: `Bearer ${secret.access_token}` } });
    return { account: me.email ?? "Google account", secret, settings: { email: me.email ?? "" } };
  },
};

// ---------- time ----------

const tzOffsetMs = (ms: number, tz: string) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(ms).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000;
};

/** A wall-clock date and time in a time zone → epoch ms (DST-aware). */
export function zonedToUtc(date: string, time: string, tz: string): number {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const first = guess - tzOffsetMs(guess, tz);
  return guess - tzOffsetMs(first, tz);
}

/** RFC 3339 local time without offset, as Google expects alongside a timeZone. */
export const wallTime = (ms: number, tz: string) => new Date(ms + tzOffsetMs(ms, tz)).toISOString().slice(0, 19);

/** Google event ids: 5–1024 characters from a–v and 0–9. A hex digest qualifies. */
export const eventIdFor = (orgId: number, applicantId: number, startMs: number) => `sl${crypto.createHash("sha256").update(`${orgId}:${applicantId}:${startMs}`).digest("hex").slice(0, 40)}`;

// ---------- scheduling ----------

export type Busy = { start: string; end: string };

export async function busyDuring(c: Conn, startMs: number, minutes: number, tz: string): Promise<Busy[]> {
  const ctx = ctxFor(c.owner_id, GCAL, c.mode);
  const r = await g<{ calendars: Record<string, { busy: Busy[]; errors?: unknown[] }> }>(c, ctx, `${CAL}/freeBusy`, {
    method: "POST", idempotent: true,
    json: { timeMin: new Date(startMs).toISOString(), timeMax: new Date(startMs + minutes * 60_000).toISOString(), timeZone: tz, items: [{ id: "primary" }] },
  });
  return r.calendars.primary?.busy ?? [];
}

type Event = { id: string; htmlLink: string; hangoutLink?: string; status: string };

export async function scheduleInterview(org: Org, a: ApplicantRow, job: JobRow, o: { startMs: number; minutes: number; interviewers: string[]; meet: boolean; note: string }): Promise<Interview> {
  const c = getConn(org.id, GCAL);
  if (!c) throw new Error("Connect Google Calendar first");
  const ctx = ctxFor(org.id, GCAL, c.mode);
  const id = eventIdFor(org.id, a.id, o.startMs);
  const attendees = [{ email: a.email, displayName: a.name }, ...o.interviewers.map((email) => ({ email }))];
  const body = {
    id,
    summary: `Interview: ${a.name}, ${job.title}`,
    description: [`Interview for ${job.title} at ${org.name}.`, o.note, "Scheduled from Shortlist."].filter(Boolean).join("\n\n"),
    start: { dateTime: wallTime(o.startMs, org.timezone), timeZone: org.timezone },
    end: { dateTime: wallTime(o.startMs + o.minutes * 60_000, org.timezone), timeZone: org.timezone },
    attendees,
    guestsCanSeeOtherGuests: false,
    reminders: { useDefault: true },
    ...(o.meet ? { conferenceData: { createRequest: { requestId: id, conferenceSolutionKey: { type: "hangoutsMeet" } } } } : {}),
  };
  let ev: Event;
  try {
    // A client-chosen id makes this insert idempotent: a repeat answers 409 instead of inviting everyone twice.
    ev = await g<Event>(c, ctx, `${CAL}/calendars/primary/events?sendUpdates=all&conferenceDataVersion=1`, { method: "POST", json: body, idempotent: true });
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 409)) throw err;
    ev = await g<Event>(c, ctx, `${CAL}/calendars/primary/events/${id}`);
    if (ev.status === "cancelled") throw new Error("An interview at this exact time was cancelled earlier. Pick another time.");
  }
  db.prepare("DELETE FROM interviews WHERE event_id = ?").run(id);
  const iid = Number(db.prepare("INSERT INTO interviews (org_id, applicant_id, starts_at, minutes, event_id, html_link, meet_link, attendees, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    org.id, a.id, o.startMs, o.minutes, ev.id, ev.htmlLink ?? "", ev.hangoutLink ?? "", JSON.stringify(attendees.map((x) => x.email)), Date.now(),
  ).lastInsertRowid);
  const local = (ms: number) => new Date(ms).toLocaleString("en-US", { timeZone: org.timezone, dateStyle: "medium", timeStyle: "short" });
  logEvent(org.id, a.id, job.id, "user", "interview-scheduled", `${local(o.startMs)} (${org.timezone}) for ${o.minutes} min; invitation sent to the candidate${o.interviewers.length ? ` and ${o.interviewers.length} interviewer${o.interviewers.length > 1 ? "s" : ""}` : ""}`);
  log(org.id, GCAL, "info", `Interview scheduled for applicant #${a.id}`);
  return db.prepare("SELECT * FROM interviews WHERE id = ?").get(iid) as Interview;
}

export async function cancelInterview(org: Org, iv: Interview, jobId: number) {
  const c = getConn(org.id, GCAL);
  if (c) {
    const ctx = ctxFor(org.id, GCAL, c.mode);
    try {
      await g(c, ctx, `${CAL}/calendars/primary/events/${iv.event_id}?sendUpdates=all`, { method: "DELETE" });
    } catch (err) {
      if (!(err instanceof ApiError && (err.status === 404 || err.status === 410))) throw err; // already gone
    }
  }
  db.prepare("UPDATE interviews SET status = 'cancelled' WHERE id = ?").run(iv.id);
  logEvent(org.id, iv.applicant_id, jobId, "user", "interview-cancelled", `${new Date(iv.starts_at).toLocaleString("en-US", { timeZone: org.timezone, dateStyle: "medium", timeStyle: "short" })}; cancellation sent`);
}

export const interviewsFor = (applicantId: number) => db.prepare("SELECT * FROM interviews WHERE applicant_id = ? ORDER BY starts_at DESC").all(applicantId) as Interview[];

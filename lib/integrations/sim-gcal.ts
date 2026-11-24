// Simulated Google OAuth + Calendar: token exchange (PKCE checked), userinfo, freeBusy, and events with Google's id
// rules, a 409 for a repeated id, Meet links, and DELETE → 410 once cancelled. The simulated calendar is busy every
// weekday 12:00–13:00 (lunch) in the requested time zone, plus whatever has been booked.
import { registerSimulator, sbAuthorized, sbGet, sbIssueTokens, sbList, sbPut, sbRefreshTokens, type SbRes } from "./sandbox";

const P = "gcal";
type Ev = { id: string; status: string; summary: string; htmlLink: string; hangoutLink?: string; start: { dateTime: string; timeZone: string }; end: { dateTime: string; timeZone: string }; attendees: { email: string }[]; startMs: number; endMs: number; sent: number };
const gerr = (status: number, reason: string, message: string): SbRes => ({ status, json: { error: { code: status, message, errors: [{ domain: "global", reason, message }] } } });

registerSimulator("oauth2.googleapis.com", (req, owner) => {
  const f = new URLSearchParams(req.body);
  if (f.get("grant_type") === "authorization_code") {
    if (!f.get("code")?.startsWith("sbx_code_") || !f.get("code_verifier")) return { status: 400, json: { error: "invalid_grant", error_description: "Bad Request" } };
    return { json: { ...sbIssueTokens(P, owner, 3599), scope: "openid email https://www.googleapis.com/auth/calendar.events", id_token: "sbx" } };
  }
  if (f.get("grant_type") === "refresh_token") {
    const t = sbRefreshTokens(P, owner, f.get("refresh_token") ?? "", false, 3599);
    return t ? { json: { access_token: t.access_token, expires_in: 3599, token_type: "Bearer" } } : { status: 400, json: { error: "invalid_grant", error_description: "Token has been expired or revoked." } };
  }
  return { status: 400, json: { error: "unsupported_grant_type" } };
});

registerSimulator("openidconnect.googleapis.com", (req, owner) =>
  sbAuthorized(req, P, owner) ? { json: { sub: "1100000000001", email: "recruiter@northwind-sandbox.test", email_verified: true } } : gerr(401, "authError", "Invalid Credentials"));

/** Wall-clock "YYYY-MM-DDTHH:mm:ss" in tz → epoch ms. */
function zoned(wall: string, tz: string): number {
  const guess = Date.parse(wall + "Z");
  const off = (ms: number) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(ms).map((x) => [x.type, x.value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000;
  };
  return guess - off(guess - off(guess));
}

registerSimulator("www.googleapis.com", (req, owner): SbRes => {
  if (!sbAuthorized(req, P, owner)) return gerr(401, "authError", "Request had invalid authentication credentials.");
  const path = req.url.pathname;
  if (path === "/calendar/v3/freeBusy" && req.method === "POST") {
    const b = req.json<{ timeMin: string; timeMax: string; timeZone?: string }>();
    const tz = b.timeZone ?? "UTC";
    const min = Date.parse(b.timeMin), max = Date.parse(b.timeMax);
    if (!(min < max)) return gerr(400, "timeRangeEmpty", "The specified time range is empty.");
    const busy: { start: string; end: string }[] = [];
    for (let d = min - 86_400_000; d < max + 86_400_000; d += 86_400_000) {
      const day = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" }).formatToParts(d);
      const part = (t: string) => day.find((x) => x.type === t)!.value;
      if (["Sat", "Sun"].includes(part("weekday"))) continue;
      const date = `${part("year")}-${part("month")}-${part("day")}`;
      const s = zoned(`${date}T12:00:00`, tz), e = zoned(`${date}T13:00:00`, tz);
      if (s < max && e > min) busy.push({ start: new Date(s).toISOString(), end: new Date(e).toISOString() });
    }
    for (const ev of sbList<Ev>(P, owner, "event")) if (ev.status !== "cancelled" && ev.startMs < max && ev.endMs > min) busy.push({ start: new Date(ev.startMs).toISOString(), end: new Date(ev.endMs).toISOString() });
    return { json: { kind: "calendar#freeBusy", timeMin: b.timeMin, timeMax: b.timeMax, calendars: { primary: { busy: [...new Map(busy.map((x) => [x.start, x])).values()] } } } };
  }
  const m = path.match(/^\/calendar\/v3\/calendars\/primary\/events(?:\/([^/]+))?$/);
  if (!m) return gerr(404, "notFound", "Not Found");
  if (req.method === "POST" && !m[1]) {
    const b = req.json<Ev & { conferenceData?: { createRequest?: { requestId: string } } }>();
    if (b.id && !/^[a-v0-9]{5,1024}$/.test(b.id)) return gerr(400, "invalid", "Invalid resource id value.");
    if (b.id && sbGet(P, owner, "event", b.id)) return gerr(409, "duplicate", "The requested identifier already exists.");
    if (!b.start?.dateTime || !b.end?.dateTime) return gerr(400, "required", "Missing start or end time.");
    const startMs = zoned(b.start.dateTime, b.start.timeZone), endMs = zoned(b.end.dateTime, b.end.timeZone);
    if (!(startMs < endMs)) return gerr(400, "timeRangeEmpty", "The specified time range is empty.");
    for (const a of b.attendees ?? []) if (!/^\S+@\S+\.\S+$/.test(a.email)) return gerr(400, "invalid", `Invalid attendee email: ${a.email}`);
    const id = b.id ?? crypto.randomUUID().replace(/-/g, "").slice(0, 26);
    const ev: Ev = {
      ...b, id, status: "confirmed", htmlLink: `https://calendar.google.com/calendar/event?eid=${Buffer.from(id).toString("base64url")}`,
      ...(b.conferenceData?.createRequest && req.url.searchParams.get("conferenceDataVersion") === "1" ? { hangoutLink: `https://meet.google.com/sbx-${id.slice(2, 6)}-${id.slice(6, 9)}` } : {}),
      startMs, endMs, sent: req.url.searchParams.get("sendUpdates") === "all" ? (b.attendees ?? []).length : 0,
    };
    sbPut(P, owner, "event", id, ev);
    return { json: ev };
  }
  const ev = m[1] ? sbGet<Ev>(P, owner, "event", m[1]) : undefined;
  if (!ev) return gerr(404, "notFound", "Not Found");
  if (req.method === "GET") return { json: ev };
  if (req.method === "DELETE") {
    if (ev.status === "cancelled") return gerr(410, "deleted", "Resource has been deleted");
    sbPut(P, owner, "event", ev.id, { ...ev, status: "cancelled" });
    return { status: 204 };
  }
  return gerr(405, "methodNotAllowed", "Method not allowed");
});

export const simEvents = (owner: number) => sbList<Ev>(P, owner, "event");

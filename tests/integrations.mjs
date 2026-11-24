// Greenhouse (Harvest v3) + Google Calendar tests against the built-in simulators. Run with `npm test`.
import assert from "node:assert/strict";
const { db } = await import("./lib/db.ts");
const core = await import("./lib/integrations/core.ts");
await import("./lib/integrations/index.ts");
const G = await import("./lib/integrations/greenhouse.ts");
const C = await import("./lib/integrations/gcal.ts");
const SG = await import("./lib/integrations/sim-greenhouse.ts");
const SC = await import("./lib/integrations/sim-gcal.ts");
const { pdfText } = await import("./lib/pdftext.ts");
const SB = await import("./lib/integrations/sandbox.ts");

let n = 0;
const ok = async (name, fn) => { await fn(); n++; console.log("✓", name); };
const now = Date.now();
db.prepare("INSERT INTO users (id, email, password_hash, created_at) VALUES (1, 'r@example.com', 'x', ?)").run(now);
db.prepare("INSERT INTO orgs (id, user_id, name, timezone, ai_enabled, created_at) VALUES (1, 1, 'Northwind', 'America/New_York', 0, ?)").run(now);
const criteria = JSON.stringify([{ id: "c1", text: "Experience with PostgreSQL", kind: "must" }, { id: "c2", text: "Mentored engineers", kind: "nice" }]);
const JOB = Number(db.prepare("INSERT INTO jobs (org_id, slug, title, criteria, blind, created_at) VALUES (1, 'abc', 'Senior Backend Engineer', ?, 0, ?)").run(criteria, now).lastInsertRowid);
const applicants = () => db.prepare("SELECT * FROM applicants WHERE job_id = ? ORDER BY id").all(JOB);
const job = (kind, ref) => core.jobFor(1, "greenhouse", kind, ref);

await ok("Link header parsing and the simulator's v3 rules: per_page bounds; a cursor must travel alone", async () => {
  assert.equal(G.nextLink('<https://harvest.greenhouse.io/v3/jobs?cursor=abc>; rel="next"'), "https://harvest.greenhouse.io/v3/jobs?cursor=abc");
  assert.equal(G.nextLink(null), null);
  assert.equal(G.nextLink('<https://x/y>; rel="prev"'), null);
  const c = await G.connectGreenhouse(1, "sandbox", { client_id: "sbx-client", client_secret: "sbx-client-secret" });
  const ctx = core.ctxFor(1, "greenhouse", "sandbox");
  const t = core.unseal(c.secret).access_token;
  const get = (u) => ctx.fetch(u, { headers: { Authorization: `Bearer ${t}` } });
  assert.equal((await get("https://harvest.greenhouse.io/v3/jobs?per_page=501")).status, 422);
  const first = await get("https://harvest.greenhouse.io/v3/applications?per_page=1");
  const next = G.nextLink(first.headers.get("link"));
  assert.ok(next);
  assert.equal((await get(`${next}&per_page=1`)).status, 422, "cursor plus another parameter is refused");
  assert.equal((await get(next)).status, 200);
});

await ok("connect: client-credentials token, open jobs listed (closed ones not)", () => {
  const c = core.getConn(1, "greenhouse");
  const s = core.settingsOf(c);
  assert.deepEqual(s.jobs.map((j) => j.name), ["Product Designer", "Senior Backend Engineer"]);
  assert.equal(core.unseal(c.secret).refresh_token, undefined, "client credentials have no refresh token");
});

await ok("import: applications with resumes (PDF and text) come in and are compared; prospects skipped; unsupported resume noted", async () => {
  const c = core.getConn(1, "greenhouse");
  G.linkJob(c, 4012001, JOB, true);
  G.importAll(1);
  await core.drain(1, { provider: "greenhouse" });
  assert.equal(job("import", "4012001").status, "done", job("import", "4012001").last_error ?? "");
  const rows = applicants();
  assert.deepEqual(rows.map((r) => r.name).sort(), ["Ines Moreau", "Maya Lindqvist", "Tomás Herrera"]);
  const maya = rows.find((r) => r.name === "Maya Lindqvist");
  assert.equal(maya.email, "maya.lindqvist@example.com");
  assert.equal(maya.resume_mime, "application/pdf");
  assert.match(maya.resume_text, /PostgreSQL schema design/);
  assert.equal(maya.source, "rules", "compared against the criteria (keyword mode here)");
  assert.equal(rows.find((r) => r.name === "Tomás Herrera").resume_mime, "text/plain");
  const ines = rows.find((r) => r.name === "Ines Moreau");
  assert.equal(ines.resume_text, "");
  assert.ok(db.prepare("SELECT 1 FROM events WHERE applicant_id = ? AND detail LIKE '%isn''t a PDF or text file%'").get(ines.id));
  assert.ok(db.prepare("SELECT 1 FROM events WHERE applicant_id = ? AND action = 'imported'").get(maya.id));
  assert.equal(core.settingsOf(core.getConn(1, "greenhouse")).links["4012001"].imported, 3);
});

await ok("import again: nothing duplicated; a new application arrives and only it is imported; same email as a form applicant links instead", async () => {
  G.importAll(1);
  await core.drain(1, { provider: "greenhouse" });
  assert.equal(applicants().length, 3);
  SG.simNewApplication(1, 4012001);
  const form = Number(db.prepare("INSERT INTO applicants (org_id, job_id, name, email, created_at) VALUES (1, ?, 'Hana Sato', 'applicant1@example.com', ?)").run(JOB, now).lastInsertRowid);
  SG.simNewApplication(1, 4012001); // applicant1@ (same person applied through the form)
  G.importAll(1);
  await core.drain(1, { provider: "greenhouse" });
  const rows = applicants();
  assert.equal(rows.length, 5);
  assert.ok(core.getLink(1, "greenhouse", "applicant", form), "linked to the existing application");
  assert.match(job("import", "4012001").result, /1 imported, 1 matched/);
});

await ok("a stage change by a person sends a private decision note to the candidate in Greenhouse", async () => {
  const maya = applicants().find((r) => r.name === "Maya Lindqvist");
  await G.stageChanged(1, maya.id, 999, "new", "interview", "");
  await core.drain(1, { provider: "greenhouse" });
  const notes = SG.simNotes(1);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].visibility, "admin_only_visible");
  assert.match(notes[0].body, /moved this application from "new" to "interview"/);
  assert.equal(notes[0].candidate_id, JSON.parse(core.getLink(1, "greenhouse", "applicant", maya.id).extra).candidate_id);
  const formOnly = Number(db.prepare("INSERT INTO applicants (org_id, job_id, name, email, created_at) VALUES (1, ?, 'Walk In', 'walk@example.com', ?)").run(JOB, now).lastInsertRowid);
  await G.stageChanged(1, formOnly, 1000, "new", "rejected", "Position filled");
  assert.equal(job("note", `${formOnly}:1000`), undefined, "not a Greenhouse application: nothing sent");
});

await ok("a server error on note creation isn't retried blindly (the note may exist); an expired token is renewed and the note sent", async () => {
  const maya = applicants().find((r) => r.name === "Maya Lindqvist");
  const host = "harvest.greenhouse.io";
  const real = SB.simulatorFor(host);
  SB.registerSimulator(host, (req, o) => (req.method === "POST" && req.url.pathname === "/v3/notes" ? { status: 503, json: { message: "unavailable" } } : real(req, o)));
  await G.stageChanged(1, maya.id, 1001, "interview", "offer", "");
  await core.drain(1, { provider: "greenhouse" });
  SB.registerSimulator(host, real);
  const failed = job("note", `${maya.id}:1001`);
  assert.equal(failed.status, "failed");
  assert.equal(failed.attempts, 1);
  assert.match(failed.last_error, /check the candidate's notes before retrying/);
  assert.equal(core.getConn(1, "greenhouse").status, "connected", "one bad call doesn't mark the connection broken");
  SB.sbExpireTokens("greenhouse", 1);
  core.retryFailed(1, "greenhouse");
  await core.drain(1, { provider: "greenhouse" });
  assert.equal(job("note", `${maya.id}:1001`).status, "done", "retried by a person → 401 → new token → sent");
  assert.equal(SG.simNotes(1).length, 2);
});

await ok("calendar: wall-clock → UTC across DST; event ids follow Google's alphabet", () => {
  assert.equal(new Date(C.zonedToUtc("2026-07-01", "10:00", "America/New_York")).toISOString(), "2026-07-01T14:00:00.000Z");
  assert.equal(new Date(C.zonedToUtc("2026-12-01", "10:00", "America/New_York")).toISOString(), "2026-12-01T15:00:00.000Z");
  assert.equal(new Date(C.zonedToUtc("2026-11-01", "01:30", "America/New_York")).toISOString().slice(11, 16), "05:30");
  assert.equal(C.wallTime(Date.parse("2026-12-01T15:00:00Z"), "America/New_York"), "2026-12-01T10:00:00");
  assert.match(C.eventIdFor(1, 2, 3), /^[a-v0-9]{5,1024}$/);
  assert.notEqual(C.eventIdFor(1, 2, 3), C.eventIdFor(1, 2, 4));
});

await ok("calendar: connect (PKCE), free/busy finds the lunch block, booking invites the candidate with a Meet link; a repeat doesn't double-invite", async () => {
  const ctx = core.ctxFor(1, "gcal", "sandbox");
  const { state, verifier } = core.newOAuthState(1, "gcal", "sandbox");
  core.takeOAuthState(state, 1, "gcal");
  const r = await C.gcal.exchange(ctx, "sbx_code_x", "http://localhost/cb", verifier, new URLSearchParams());
  const c = core.saveConn(1, "gcal", "sandbox", r.account, r.secret, r.settings);
  assert.equal(c.account, "recruiter@northwind-sandbox.test");
  // Next Tuesday at noon and at 10:00, New York time.
  const d = new Date(Date.now() + 86_400_000 * ((9 - new Date().getUTCDay()) % 7 || 7));
  const date = d.toISOString().slice(0, 10);
  const noon = C.zonedToUtc(date, "12:15", "America/New_York");
  assert.equal((await C.busyDuring(c, noon, 30, "America/New_York")).length, 1);
  const ten = C.zonedToUtc(date, "10:00", "America/New_York");
  assert.equal((await C.busyDuring(c, ten, 45, "America/New_York")).length, 0);
  const org = db.prepare("SELECT * FROM orgs WHERE id = 1").get();
  const a = applicants().find((x) => x.name === "Maya Lindqvist");
  const j = db.prepare("SELECT * FROM jobs WHERE id = ?").get(JOB);
  const iv = await C.scheduleInterview(org, a, j, { startMs: ten, minutes: 45, interviewers: ["lee@northwind.test"], meet: true, note: "" });
  const ev = SC.simEvents(1)[0];
  assert.deepEqual(ev.attendees.map((x) => x.email), ["maya.lindqvist@example.com", "lee@northwind.test"]);
  assert.equal(ev.sent, 2, "sendUpdates=all");
  assert.equal(ev.start.dateTime, `${date}T10:00:00`);
  assert.equal(ev.start.timeZone, "America/New_York");
  assert.match(iv.meet_link, /^https:\/\/meet\.google\.com\//);
  await C.scheduleInterview(org, a, j, { startMs: ten, minutes: 45, interviewers: ["lee@northwind.test"], meet: true, note: "" });
  assert.equal(SC.simEvents(1).length, 1, "same applicant + time → same event id → 409 → existing event reused");
  assert.equal(C.interviewsFor(a.id).length, 1);
  assert.equal((await C.busyDuring(c, ten, 30, "America/New_York")).length, 1, "the booked interview now shows as busy");
  await C.cancelInterview(org, C.interviewsFor(a.id)[0], JOB);
  assert.equal(SC.simEvents(1)[0].status, "cancelled");
  assert.equal(C.interviewsFor(a.id)[0].status, "cancelled");
  await C.cancelInterview(org, C.interviewsFor(a.id)[0], JOB); // already gone (410) is fine
  assert.ok(db.prepare("SELECT 1 FROM events WHERE applicant_id = ? AND action = 'interview-scheduled'").get(a.id));
});

await ok("the simulator's test PDF is real enough for the resume reader", () => {
  assert.match(pdfText(Buffer.from(SG.textPdf(["Hello (world)", "Line two"]), "latin1")), /Hello \(world\)[\s\S]*Line two/);
});

console.log(`\n${n} checks passed`);

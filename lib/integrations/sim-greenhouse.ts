// Simulated Greenhouse Harvest v3: client-credentials tokens, jobs, applications, candidates, attachments (with
// short-lived signed download links), and notes. It enforces v3's paging rules: per_page 1–500, opaque cursors in a
// Link header, and a 422 when a cursor is combined with any other parameter.
import crypto from "node:crypto";
import { registerSimulator, sbAuthorized, sbGet, sbIssueTokens, sbList, sbNextId, sbPut, type SbReq, type SbRes } from "./sandbox";

const P = "greenhouse";
const FILES = "files.greenhouse.test";
type Job = { id: number; name: string; status: string; created_at: string };
type App = { id: number; candidate_id: number; job_id: number; prospect: boolean; status: string; stage_name: string; created_at: string; updated_at: string };
type Cand = { id: number; first_name: string; last_name: string; preferred_name: string | null; email_addresses: { value: string; type: string }[]; phone_numbers: { value: string; type: string }[]; created_at: string };
type Att = { id: number; application_id: number; candidate_id: number; type: string; filename: string; content: string; mime: string; created_at: string };
type Note = { id: number; candidate_id: number; application_id: number | null; body: string; visibility: string; type: string; user_id: number | null; created_at: string };

const err = (status: number, message: string): SbRes => ({ status, json: { message, errors: [{ message }] } });

/** A small text PDF (uncompressed content stream), like a resume exported from a word processor. */
export function textPdf(lines: string[]): string {
  const esc = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`);
  const stream = `BT /F1 11 Tf 72 740 Td 14 TL ${lines.map((l) => `(${esc(l)}) Tj T*`).join(" ")} ET`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offs: number[] = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return out;
}

const SEED: { first: string; last: string; email: string; days: number; file: "pdf" | "txt" | "docx"; resume: string[] }[] = [
  { first: "Maya", last: "Lindqvist", email: "maya.lindqvist@example.com", days: 6, file: "pdf", resume: ["Maya Lindqvist", "Backend Engineer, Corvid Payments (2017-2025)", "- Python and Django services; PostgreSQL schema design and tuning", "- Mentored three engineers; led the on-call rotation", "- Deployed on AWS with Terraform"] },
  { first: "Tomás", last: "Herrera", email: "tomas.herrera@example.com", days: 4, file: "txt", resume: ["Tomás Herrera", "Software Engineer, Quill Analytics (2021-2025)", "- Go and Python microservices", "- Kubernetes operators; Prometheus monitoring", "- MySQL to PostgreSQL migration"] },
  { first: "Ines", last: "Moreau", email: "ines.moreau@example.com", days: 2, file: "docx", resume: ["(binary .docx)"] },
];

function seed(owner: number) {
  if (sbGet(P, owner, "_seeded", "1")) return;
  sbPut(P, owner, "_seeded", "1", true);
  const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString();
  sbPut(P, owner, "job", 4_012_001, { id: 4_012_001, name: "Senior Backend Engineer", status: "open", created_at: iso(40) } satisfies Job);
  sbPut(P, owner, "job", 4_012_002, { id: 4_012_002, name: "Product Designer", status: "open", created_at: iso(20) } satisfies Job);
  sbPut(P, owner, "job", 4_011_950, { id: 4_011_950, name: "Data Analyst (filled)", status: "closed", created_at: iso(90) } satisfies Job);
  for (const s of SEED) addApplication(owner, 4_012_001, s, iso(s.days));
  // A prospect (sourced, didn't apply): never imported.
  const cand = addCandidate(owner, "Pat", "Rowe", "pat.rowe@example.com", iso(3));
  const app: App = { id: sbNextId(P, owner, "app", 77_000_000), candidate_id: cand.id, job_id: 4_012_001, prospect: true, status: "active", stage_name: "Prospect", created_at: iso(3), updated_at: iso(3) };
  sbPut(P, owner, "app", app.id, app);
}

function addCandidate(owner: number, first: string, last: string, email: string, at: string): Cand {
  const c: Cand = { id: sbNextId(P, owner, "cand", 55_000_000), first_name: first, last_name: last, preferred_name: null, email_addresses: [{ value: email, type: "personal" }], phone_numbers: [{ value: "+1 555 0100", type: "mobile" }], created_at: at };
  sbPut(P, owner, "cand", c.id, c);
  return c;
}

export function addApplication(owner: number, jobId: number, s: (typeof SEED)[number], at = new Date().toISOString()): App {
  const cand = addCandidate(owner, s.first, s.last, s.email, at);
  const app: App = { id: sbNextId(P, owner, "app", 77_000_000), candidate_id: cand.id, job_id: jobId, prospect: false, status: "active", stage_name: "Application Review", created_at: at, updated_at: at };
  sbPut(P, owner, "app", app.id, app);
  const content = s.file === "pdf" ? textPdf(s.resume) : s.file === "txt" ? s.resume.join("\n") : "PK\u0003\u0004 (not really a docx)";
  const att: Att = { id: sbNextId(P, owner, "att", 91_000_000), application_id: app.id, candidate_id: cand.id, type: "resume", filename: `${s.first}_${s.last}_Resume.${s.file}`, content: Buffer.from(content, "latin1").toString("base64"), mime: s.file === "pdf" ? "application/pdf" : "text/plain", created_at: at };
  sbPut(P, owner, "att", att.id, att);
  return app;
}

/** Simulator control: a new application arrives for a job. */
export function simNewApplication(owner: number, jobId: number) {
  seed(owner);
  const n = sbNextId(P, owner, "_newcount", 0);
  return addApplication(owner, jobId, { first: ["Ravi", "Hana", "Leo", "Zara"][n % 4], last: ["Patel", "Sato", "Brandt", "Okoye"][n % 4], email: `applicant${n}@example.com`, days: 0, file: "pdf", resume: [`Applicant ${n}`, "Backend engineer, 6 years of Python", "- PostgreSQL, Redis, AWS", "- Mentored new hires"] });
}

const sign = (path: string, exp: number) => crypto.createHmac("sha256", "sbx-files").update(`${path}:${exp}`).digest("hex").slice(0, 32);

function page<T extends { id: number }>(req: SbReq, rows: T[]): SbRes {
  const params = req.url.searchParams;
  const cursor = params.get("cursor");
  if (cursor && [...params.keys()].some((k) => k !== "cursor")) return err(422, "When passing a cursor, do not include other query params.");
  let state: { offset: number; per: number; filter: string };
  if (cursor) {
    try {
      state = JSON.parse(Buffer.from(cursor, "base64url").toString());
    } catch {
      return err(422, "Invalid cursor");
    }
  } else {
    const per = Number(params.get("per_page") ?? 100);
    if (!Number.isInteger(per) || per < 1 || per > 500) return err(422, "per_page must be between 1 and 500");
    state = { offset: 0, per, filter: params.toString() };
  }
  const sorted = [...rows].sort((a, b) => b.id - a.id);
  const slice = sorted.slice(state.offset, state.offset + state.per);
  const headers: Record<string, string> = {};
  if (state.offset + state.per < sorted.length) {
    const next = Buffer.from(JSON.stringify({ ...state, offset: state.offset + state.per })).toString("base64url");
    headers.Link = `<https://harvest.greenhouse.io${req.url.pathname}?cursor=${next}>; rel="next"`;
  }
  return { json: slice, headers };
}

/** Filters of the first request travel inside the cursor, as with an opaque server-side cursor. */
const filtersOf = (req: SbReq) => {
  const c = req.url.searchParams.get("cursor");
  return c ? new URLSearchParams((JSON.parse(Buffer.from(c, "base64url").toString()) as { filter: string }).filter) : req.url.searchParams;
};
const idList = (v: string | null) => (v ? v.split(",").map(Number).filter(Boolean) : null);

registerSimulator("auth.greenhouse.io", (req, owner) => {
  if (req.url.pathname !== "/token" || req.method !== "POST") return err(404, "Not found");
  const auth = req.headers.get("authorization") ?? "";
  const [id, secret] = Buffer.from(auth.replace(/^Basic /, ""), "base64").toString().split(":");
  if (new URLSearchParams(req.body).get("grant_type") !== "client_credentials") return { status: 400, json: { error: "unsupported_grant_type" } };
  if (!id || !secret || secret.length < 8) return { status: 401, json: { error: "invalid_client", error_description: "Client authentication failed" } };
  seed(owner);
  return { json: sbIssueTokens(P, owner, 3600, false) };
});

registerSimulator("harvest.greenhouse.io", (req, owner) => {
  if (!sbAuthorized(req, P, owner)) return { status: 401, json: { message: "Invalid or expired token" } };
  seed(owner);
  const path = req.url.pathname;
  const f = filtersOf(req);
  if (req.method === "GET" && path === "/v3/jobs") {
    return page(req, sbList<Job>(P, owner, "job").filter((j) => !f.get("status") || j.status === f.get("status")));
  }
  if (req.method === "GET" && path === "/v3/applications") {
    const jobIds = idList(f.get("job_ids"));
    const gte = f.get("created_at[gte]");
    if (jobIds && jobIds.length > 50) return err(422, "job_ids accepts at most 50 ids");
    return page(req, sbList<App>(P, owner, "app").filter((a) => (!jobIds || jobIds.includes(a.job_id)) && (!gte || a.created_at >= gte)));
  }
  if (req.method === "GET" && path === "/v3/candidates") {
    const ids = idList(f.get("ids"));
    if (ids && ids.length > 50) return err(422, "ids accepts at most 50 ids");
    return page(req, sbList<Cand>(P, owner, "cand").filter((c) => !ids || ids.includes(c.id)));
  }
  if (req.method === "GET" && path === "/v3/attachments") {
    const ids = idList(f.get("application_ids"));
    const now = Date.now();
    return page(req, sbList<Att>(P, owner, "att").filter((a) => (!ids || ids.includes(a.application_id)) && (!f.get("type") || a.type === f.get("type"))).map(({ content: _c, mime: _m, ...a }) => {
      const exp = now + 7 * 86_400_000;
      const p = `/attachments/${a.id}/${encodeURIComponent(a.filename)}`;
      return { ...a, url: `https://${FILES}${p}?expires=${exp}&sig=${sign(p, exp)}` };
    }));
  }
  if (req.method === "POST" && path === "/v3/notes") {
    const b = req.json<{ candidate_id?: number; application_id?: number; body?: string; visibility?: string; note_type?: string; user_id?: number }>();
    if (!b.candidate_id || !sbGet(P, owner, "cand", b.candidate_id)) return err(422, "candidate_id is required and must exist");
    if (!b.body?.trim()) return err(422, "body is required");
    if (!["admin_only", "private", "public"].includes(b.visibility ?? "")) return err(422, "visibility must be one of admin_only, private, public");
    if (!["NOTE", "EMAIL", "ACTIVITY"].includes(b.note_type ?? "")) return err(422, "note_type must be one of NOTE, EMAIL, ACTIVITY");
    if (b.application_id && sbGet<App>(P, owner, "app", b.application_id)?.candidate_id !== b.candidate_id) return err(422, "application_id must belong to candidate_id");
    const note: Note = { id: sbNextId(P, owner, "note", 300_000), candidate_id: b.candidate_id, application_id: b.application_id ?? null, body: b.body, visibility: `${b.visibility === "admin_only" ? "admin_only" : b.visibility === "private" ? "privately" : "publicly"}_visible`, type: b.note_type!, user_id: b.user_id ?? null, created_at: new Date().toISOString() };
    sbPut(P, owner, "note", note.id, note);
    return { status: 201, json: note };
  }
  return err(404, `No route for ${req.method} ${path}`);
});

registerSimulator(FILES, (req, owner) => {
  const exp = Number(req.url.searchParams.get("expires"));
  if (!exp || exp < Date.now() || req.url.searchParams.get("sig") !== sign(req.url.pathname, exp)) return { status: 403, text: "Request has expired or the signature does not match" };
  const id = req.url.pathname.split("/")[2];
  const a = sbGet<Att>(P, owner, "att", id);
  return a ? { bytes: new Uint8Array(Buffer.from(a.content, "base64")), headers: { "Content-Type": a.mime } } : { status: 404, text: "Not found" };
});

export const simNotes = (owner: number) => sbList<Note>(P, owner, "note");
export const simJobs = (owner: number) => sbList<Job>(P, owner, "job");

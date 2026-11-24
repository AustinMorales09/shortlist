// Greenhouse Recruiting, Harvest API v3 (v1/v2 were retired in August 2026). Applications to linked Greenhouse jobs are
// imported into Shortlist (resume included) and compared with the job's criteria; when a person moves an imported
// applicant to another stage here, a private note with the decision goes back onto the Greenhouse candidate.
//
// Auth is OAuth 2.0 client credentials: the customer creates Harvest v3 credentials in Greenhouse and pastes them in.
// Lists page with an opaque cursor taken from the Link header; a request carrying a cursor must carry nothing else.
import { createApplication } from "../applications";
import { db, logEvent, type ApplicantRow, type JobRow } from "../db";
import { sniffResume } from "../files";
import { ApiError, accessToken, findByRemote, getConn, getLink, http, kick, log, registerJob, saveConn, setLink, settingsOf, toTokens, updateConn, enqueue, ctxFor, type Conn, type Ctx, type Mode, type Tokens } from "./core";
import { basic, form, type Provider } from "./provider";

export const GH = "greenhouse";
const TOKEN_URL = "https://auth.greenhouse.io/token";
const API = "https://harvest.greenhouse.io/v3";
const MAX_PER_RUN = 200;

export type GhJob = { id: number; name: string; status?: string };
export type GhLink = { jobId: number; assess: boolean; since: string; imported: number };
export type GhSettings = { userId: string; jobs: GhJob[]; links: Record<string, GhLink> };
type GhSecret = Tokens & { client_id: string; client_secret: string; sub?: string };

export const greenhouse: Provider = {
  id: GH,
  name: "Greenhouse Recruiting",
  blurb: "Applications to linked Greenhouse jobs come into Shortlist with their resumes. Decisions made here go back to the candidate in Greenhouse as private notes.",
  env: [],
};

async function token(ctx: Ctx, s: Pick<GhSecret, "client_id" | "client_secret" | "sub">, prev?: GhSecret): Promise<GhSecret> {
  const r = await http(ctx, TOKEN_URL, {
    method: "POST", idempotent: false,
    headers: { Authorization: basic(s.client_id, s.client_secret), "Content-Type": "application/x-www-form-urlencoded" },
    body: form({ grant_type: "client_credentials", sub: s.sub || undefined }),
  });
  const json = (await r.json()) as { access_token: string; expires_in: number };
  return { ...(prev ?? {}), ...toTokens(json), client_id: s.client_id, client_secret: s.client_secret, sub: s.sub } as GhSecret;
}

// Client credentials have no refresh token: "refreshing" is asking for a new token with the same credentials.
const refresher = (ctx: Ctx) => (t: Tokens) => token(ctx, t as GhSecret, t as GhSecret);

export const nextLink = (h: string | null): string | null => {
  if (!h) return null;
  for (const part of h.split(",")) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="?next"?/);
    if (m) return m[1];
  }
  return null;
};

/** One authenticated GET (or POST), with the next-page URL from the Link header. */
async function gh<T>(c: Conn, ctx: Ctx, url: string, init: Parameters<typeof http>[2] = {}): Promise<{ data: T; next: string | null }> {
  for (let i = 0; ; i++) {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${await accessToken(c, refresher(ctx), i > 0)}`);
    try {
      const res = await http(ctx, url, { ...init, headers });
      const text = await res.text();
      return { data: (text ? JSON.parse(text) : null) as T, next: nextLink(res.headers.get("link")) };
    } catch (err) {
      if (err instanceof ApiError && err.status === 401 && i === 0) continue;
      throw err;
    }
  }
}

/** v3 list responses: tolerate a bare array or an envelope. */
const items = <T,>(d: unknown): T[] => (Array.isArray(d) ? d : ((d as { data?: T[]; results?: T[] } | null)?.data ?? (d as { results?: T[] } | null)?.results ?? [])) as T[];

/** Every page of a list. Filters go on the first request only; later pages are the Link URL exactly as given. */
async function listAll<T>(c: Conn, ctx: Ctx, path: string, params: Record<string, string>, cap = 2000): Promise<T[]> {
  const out: T[] = [];
  let url: string | null = `${API}${path}?${new URLSearchParams(params)}`;
  while (url && out.length < cap) {
    const page: { data: unknown; next: string | null } = await gh<unknown>(c, ctx, url);
    out.push(...items<T>(page.data));
    url = page.next;
  }
  return out;
}

const chunks = <T,>(a: T[], n: number) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

// ---------- connecting ----------

export async function connectGreenhouse(ownerId: number, mode: Mode, creds: { client_id: string; client_secret: string; sub?: string }) {
  const ctx = ctxFor(ownerId, GH, mode);
  const secret = await token(ctx, creds);
  const c = saveConn(ownerId, GH, mode, mode === "sandbox" ? "Simulated Greenhouse (Northwind Talent)" : `Harvest v3 credentials …${creds.client_id.slice(-4)}`, secret, { userId: creds.sub ?? "", jobs: [], links: {} } satisfies GhSettings);
  await refreshJobs(c, ctx);
  return c;
}

export async function refreshJobs(c: Conn, ctx: Ctx) {
  const jobs = await listAll<GhJob>(c, ctx, "/jobs", { status: "open", per_page: "100" });
  const s = settingsOf<GhSettings>(c);
  updateConn(c, { settings: { ...s, jobs: jobs.map((j) => ({ id: j.id, name: j.name })).sort((a, b) => a.name.localeCompare(b.name)) } });
  log(c.owner_id, GH, "info", `Found ${jobs.length} open job${jobs.length === 1 ? "" : "s"} in Greenhouse`);
  return jobs.length;
}

export function linkJob(c: Conn, ghJobId: number, jobId: number | null, assess: boolean) {
  const s = settingsOf<GhSettings>(c);
  const links = { ...s.links };
  if (jobId === null) delete links[ghJobId];
  // Import applications from the last 30 days on the first run, then only new ones.
  else links[ghJobId] = { jobId, assess, since: links[ghJobId]?.since ?? new Date(Date.now() - 30 * 86_400_000).toISOString(), imported: links[ghJobId]?.imported ?? 0 };
  updateConn(c, { settings: { ...s, links } });
}

// ---------- importing ----------

type GhApp = { id: number; candidate_id: number; job_id: number; prospect?: boolean; status?: string; created_at: string };
type GhCandidate = { id: number; first_name?: string; last_name?: string; preferred_name?: string | null; email_addresses?: { value: string; type?: string }[]; phone_numbers?: { value: string }[] };
type GhAttachment = { id: number; application_id: number; candidate_id: number; type: string; filename: string; url: string; created_at: string };

registerJob(GH, "import", async (c, ctx, p) => {
  const ghJobId = String(p.ghJobId);
  const s = settingsOf<GhSettings>(c);
  const link = s.links[ghJobId];
  if (!link) return "skipped: job not linked";
  const job = db.prepare("SELECT * FROM jobs WHERE id = ? AND org_id = ?").get(link.jobId, c.owner_id) as JobRow | undefined;
  if (!job) return "skipped: the Shortlist job was deleted";
  // An hour of overlap: applications created around the last run aren't missed; ones already imported are skipped.
  const since = new Date(Date.parse(link.since) - 3_600_000).toISOString();
  const apps = (await listAll<GhApp>(c, ctx, "/applications", { job_ids: ghJobId, "created_at[gte]": since, per_page: "100" }))
    .filter((a) => !a.prospect && !findByRemote(c.owner_id, GH, "applicant", String(a.id)))
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .slice(0, MAX_PER_RUN);
  if (!apps.length) {
    setSince(c, ghJobId, new Date().toISOString());
    return "no new applications";
  }
  const cands = new Map<number, GhCandidate>();
  for (const ids of chunks([...new Set(apps.map((a) => a.candidate_id))], 50)) {
    for (const cd of await listAll<GhCandidate>(c, ctx, "/candidates", { ids: ids.join(","), per_page: "100" })) cands.set(cd.id, cd);
  }
  const resumes = new Map<number, GhAttachment>();
  for (const ids of chunks(apps.map((a) => a.id), 50)) {
    for (const at of await listAll<GhAttachment>(c, ctx, "/attachments", { application_ids: ids.join(","), type: "resume", per_page: "100" })) {
      const prev = resumes.get(at.application_id);
      if (!prev || prev.created_at < at.created_at) resumes.set(at.application_id, at);
    }
  }
  let added = 0, matched = 0;
  for (const a of apps) {
    const cd = cands.get(a.candidate_id);
    const email = (cd?.email_addresses?.find((e) => e.type === "personal") ?? cd?.email_addresses?.[0])?.value?.toLowerCase() ?? "";
    const name = [cd?.preferred_name || cd?.first_name, cd?.last_name].filter(Boolean).join(" ").trim() || `Greenhouse candidate ${a.candidate_id}`;
    // Applied both through Shortlist's own form and Greenhouse: link the two instead of creating a duplicate.
    const same = email ? (db.prepare("SELECT id FROM applicants WHERE job_id = ? AND lower(email) = ?").get(job.id, email) as { id: number } | undefined) : undefined;
    let id: number;
    if (same) {
      id = same.id;
      matched++;
    } else {
      const file = await downloadResume(ctx, resumes.get(a.id));
      id = await createApplication(job, {
        name, email, phone: cd?.phone_numbers?.[0]?.value ?? "", text: "", file: file ?? undefined, answers: {}, optout: false,
        source: `Greenhouse (application ${a.id})`, assess: link.assess,
      });
      if (!file) logEvent(job.org_id, id, job.id, "system", "note", resumes.get(a.id) ? "The resume isn't a PDF or text file; open it in Greenhouse" : "No resume attached in Greenhouse");
      added++;
    }
    setLink(c.owner_id, GH, "applicant", id, String(a.id), "", { candidate_id: a.candidate_id });
    setSince(c, ghJobId, a.created_at, 1);
  }
  updateConn(c, { last_sync_at: Date.now() });
  return `${added} imported${matched ? `, ${matched} matched to existing applications` : ""}${apps.length === MAX_PER_RUN ? " (more next run)" : ""}`;
});

function setSince(c: Conn, ghJobId: string, since: string, inc = 0) {
  const fresh = getConn(c.owner_id, GH);
  if (!fresh) return;
  const s = settingsOf<GhSettings>(fresh);
  const l = s.links[ghJobId];
  if (!l) return;
  s.links[ghJobId] = { ...l, since: since > l.since ? since : l.since, imported: l.imported + inc };
  updateConn(c, { settings: s });
}

/** Attachment URLs are short-lived signed links: fetched right away, never stored. No API token is sent to the file host. */
async function downloadResume(ctx: Ctx, at: GhAttachment | undefined): Promise<{ name: string; mime: string; bytes: Buffer } | null> {
  if (!at) return null;
  const res = await http(ctx, at.url, { headers: { Accept: "*/*" } });
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > 5 * 1024 * 1024) return null;
  const mime = sniffResume(at.filename, bytes);
  return mime ? { name: at.filename.replace(/[\\/\0\r\n"]/g, "_").slice(0, 120), mime, bytes } : null;
}

// ---------- decisions back to Greenhouse ----------

registerJob(GH, "note", async (c, ctx, p) => {
  const a = db.prepare("SELECT * FROM applicants WHERE id = ? AND org_id = ?").get(Number(p.applicantId), c.owner_id) as ApplicantRow | undefined;
  const link = a ? getLink(c.owner_id, GH, "applicant", a.id) : undefined;
  if (!a || !link) return "skipped: not a Greenhouse application";
  const { candidate_id } = JSON.parse(link.extra) as { candidate_id: number };
  const s = settingsOf<GhSettings>(c);
  try {
    const r = await gh<{ id: number }>(c, ctx, `${API}/notes`, {
      method: "POST",
      json: { candidate_id, application_id: Number(link.remote_id), body: String(p.body), visibility: "admin_only", note_type: "NOTE", ...(s.userId ? { user_id: Number(s.userId) } : {}) },
    });
    return `note ${r.data.id} on candidate ${candidate_id}`;
  } catch (err) {
    // Creating a note isn't idempotent and v3 offers no way to look it up afterwards, so a server error is not retried
    // automatically: the note may exist. A person checks the candidate in Greenhouse and retries if it's missing.
    if (err instanceof ApiError && err.status >= 500) throw new ApiError(422, `Greenhouse answered ${err.status}; check the candidate's notes before retrying (the note may have been saved)`, err.url);
    throw err;
  }
});

/** Called after a person changes an applicant's stage. */
export async function stageChanged(orgId: number, applicantId: number, eventId: number, from: string, to: string, reason: string) {
  if (!getConn(orgId, GH) || !getLink(orgId, GH, "applicant", applicantId)) return;
  const body = `Shortlist: a reviewer moved this application from "${from}" to "${to}".${reason ? ` Reason: ${reason}.` : ""} Decisions in Shortlist are made by people; its resume comparison shows evidence and doesn't score or rank.`;
  enqueue(orgId, GH, "note", `${applicantId}:${eventId}`, { applicantId, body });
  await kick(orgId, GH);
}

/** Imports for every linked job (button, or a page visit when the last import is older than 10 minutes). */
export async function importAll(orgId: number) {
  const c = getConn(orgId, GH);
  if (!c) return 0;
  const links = Object.keys(settingsOf<GhSettings>(c).links);
  for (const id of links) enqueue(orgId, GH, "import", id, { ghJobId: id });
  return links.length;
}

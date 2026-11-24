"use server";

import crypto from "node:crypto";
import { redirect } from "next/navigation";
import { myOrg, ownApplicant } from "./access";
import { db, logEvent, type JobRow } from "./db";
import { GCAL, GH, providerById } from "./integrations";
import { ctxFor, disconnect, drain, getConn, retryFailed } from "./integrations/core";
import { connectSimulator, startUrl } from "./integrations/connect";
import { busyDuring, cancelInterview, scheduleInterview, zonedToUtc, type Interview } from "./integrations/gcal";
import { connectGreenhouse, importAll, linkJob, refreshJobs } from "./integrations/greenhouse";
import { sbExpireTokens } from "./integrations/sandbox";
import { simNewApplication } from "./integrations/sim-greenhouse";
import { isDate, isTime } from "./time";

const q = (m: string) => encodeURIComponent(m);
const back = (extra = "") => `/integrations${extra ? `?${extra}` : ""}`;
const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const msg = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 240);
const isRedirect = (err: unknown) => !!err && typeof err === "object" && "digest" in err && String((err as { digest: unknown }).digest).startsWith("NEXT_REDIRECT");

async function target(form: FormData) {
  const org = await myOrg();
  const p = providerById(String(form.get("provider")));
  if (!p) redirect(back(`error=${q("Unknown integration")}`));
  return { org, p };
}

export async function connectProvider(form: FormData) {
  const { org, p } = await target(form);
  const mode = form.get("mode") === "live" ? "live" : "sandbox";
  if (p.id === GH) {
    // Greenhouse connects with API credentials; the simulator accepts any.
    const creds = mode === "sandbox" ? { client_id: "sbx-client", client_secret: "sbx-client-secret" } : { client_id: str(form, "client_id"), client_secret: str(form, "client_secret"), sub: str(form, "user_id") || undefined };
    if (!creds.client_id || !creds.client_secret) redirect(back(`error=${q("Enter the Harvest v3 client ID and secret")}#${GH}`));
    try {
      await connectGreenhouse(org.id, mode, creds);
    } catch (err) {
      redirect(back(`error=${q(`Couldn't connect to Greenhouse: ${msg(err)}`)}#${GH}`));
    }
    redirect(back(`done=${q("Connected Greenhouse. Link a Greenhouse job to a Shortlist job to start importing.")}#${GH}`));
  }
  if (mode === "sandbox") {
    const r = await connectSimulator(p, org.id);
    redirect(back("error" in r ? `error=${q(r.error)}#${p.id}` : `done=${q(`Connected ${p.name} (simulator)`)}#${p.id}`));
  }
  let url: string;
  try {
    url = await startUrl(p, org.id);
  } catch (err) {
    redirect(back(`error=${q(msg(err))}`));
  }
  redirect(url);
}

export async function disconnectProvider(form: FormData) {
  const { org, p } = await target(form);
  disconnect(org.id, p.id);
  redirect(back(`done=${q(`Disconnected ${p.name}`)}`));
}

export async function syncNow(form: FormData) {
  const { org, p } = await target(form);
  if (p.id === GH) importAll(org.id);
  const n = await drain(org.id, { provider: p.id });
  redirect(back(`done=${q(n ? `Ran ${n} job${n > 1 ? "s" : ""} for ${p.name}` : "Nothing was waiting")}#${p.id}`));
}

export async function retryFailedJobs(form: FormData) {
  const { org, p } = await target(form);
  retryFailed(org.id, p.id);
  const n = await drain(org.id, { provider: p.id });
  redirect(back(`done=${q(`${p.name}: retried, ${n} job${n === 1 ? "" : "s"} ran`)}#${p.id}`));
}

export async function expireSandboxToken(form: FormData) {
  const { org, p } = await target(form);
  if (getConn(org.id, p.id)?.mode === "sandbox") sbExpireTokens(p.id, org.id);
  redirect(back(`done=${q("Access token expired in the simulator. The next call will get a 401 and fetch a new one.")}#${p.id}`));
}

// ---------- Greenhouse ----------

export async function reloadGreenhouseJobs() {
  const org = await myOrg();
  const c = getConn(org.id, GH);
  if (!c) redirect(back());
  try {
    await refreshJobs(c, ctxFor(org.id, GH, c.mode));
  } catch (err) {
    redirect(back(`error=${q(msg(err))}#${GH}`));
  }
  redirect(back(`done=${q("Job list reloaded")}#${GH}`));
}

/** Links a Greenhouse job to a Shortlist job (an existing one, or a new one with the same title), then imports. */
export async function saveJobLink(form: FormData) {
  const org = await myOrg();
  const c = getConn(org.id, GH);
  if (!c) redirect(back());
  const ghJobId = Number(form.get("gh_job_id"));
  const choice = str(form, "job_id");
  let jobId: number | null = null;
  if (choice === "new") {
    const title = str(form, "gh_job_name").slice(0, 100) || "Imported job";
    jobId = Number(db.prepare("INSERT INTO jobs (org_id, slug, title, created_at) VALUES (?, ?, ?, ?)").run(org.id, crypto.randomBytes(9).toString("base64url"), title, Date.now()).lastInsertRowid);
    logEvent(org.id, null, jobId, "user", "job-created", `${title} (linked to Greenhouse job ${ghJobId})`);
  } else if (choice) {
    const job = db.prepare("SELECT * FROM jobs WHERE id = ? AND org_id = ?").get(Number(choice), org.id) as JobRow | undefined;
    if (!job) redirect(back(`error=${q("Choose one of your jobs")}#${GH}`));
    jobId = job.id;
  }
  linkJob(c, ghJobId, jobId, form.get("assess") === "on");
  if (jobId === null) redirect(back(`done=${q("Unlinked")}#${GH}`));
  importAll(org.id);
  await drain(org.id, { provider: GH });
  redirect(back(`done=${q(choice === "new" ? "Created the job and imported its applications. Add the job's criteria so resumes can be compared." : "Linked and imported")}#${GH}`));
}

export async function simApplication(form: FormData) {
  const org = await myOrg();
  if (getConn(org.id, GH)?.mode !== "sandbox") redirect(back());
  simNewApplication(org.id, Number(form.get("gh_job_id")));
  redirect(back(`done=${q("A new application arrived in the simulated Greenhouse. Run the queued jobs to import it.")}#${GH}`));
}

// ---------- Google Calendar ----------

/** Checks free/busy first; if the slot overlaps something, asks before booking (force books anyway). */
export async function bookInterview(form: FormData) {
  const { org, a, job } = await ownApplicant(Number(form.get("applicant_id")));
  const page = `/applicants/${a.id}`;
  const date = str(form, "date"), time = str(form, "time");
  const minutes = [30, 45, 60, 90].includes(Number(form.get("minutes"))) ? Number(form.get("minutes")) : 45;
  const interviewers = str(form, "interviewers").split(/[\s,;]+/).filter(Boolean).slice(0, 8);
  const keep = new URLSearchParams({ date, time, minutes: String(minutes), interviewers: interviewers.join(", "), meet: form.get("meet") === "on" ? "1" : "0" });
  if (!isDate(date) || !isTime(time)) redirect(`${page}?error=${q("Pick a date and time")}&${keep}#schedule`);
  if (interviewers.some((e) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))) redirect(`${page}?error=${q("An interviewer email doesn't look right")}&${keep}#schedule`);
  if (job.blind && !a.revealed) redirect(`${page}?error=${q("Reveal the candidate's identity first: the invitation goes to their email.")}#schedule`);
  const startMs = zonedToUtc(date, time, org.timezone);
  if (startMs < Date.now()) redirect(`${page}?error=${q("That time has already passed")}&${keep}#schedule`);
  const c = getConn(org.id, GCAL);
  if (!c) redirect(`/integrations#${GCAL}`);
  let done: Interview;
  try {
    // "Book anyway" only applies to the exact slot that was shown as busy; a changed time is checked again.
    if (str(form, "force") !== `${date} ${time} ${minutes}`) {
      const busy = await busyDuring(c, startMs, minutes, org.timezone);
      if (busy.length) redirect(`${page}?busy=${q(JSON.stringify(busy.slice(0, 5)))}&${keep}#schedule`);
    }
    done = await scheduleInterview(org, a, job, { startMs, minutes, interviewers, meet: form.get("meet") === "on", note: str(form, "note").slice(0, 1000) });
  } catch (err) {
    if (isRedirect(err)) throw err;
    redirect(`${page}?error=${q(`Google Calendar: ${msg(err)}`)}&${keep}#schedule`);
  }
  redirect(`${page}?scheduled=${done.id}#schedule`);
}

export async function cancelBooked(form: FormData) {
  const { org, a, job } = await ownApplicant(Number(form.get("applicant_id")));
  const iv = db.prepare("SELECT * FROM interviews WHERE id = ? AND applicant_id = ? AND status = 'scheduled'").get(Number(form.get("interview_id")), a.id) as Interview | undefined;
  if (iv) {
    try {
      await cancelInterview(org, iv, job.id);
    } catch (err) {
      redirect(`/applicants/${a.id}?error=${q(`Google Calendar: ${msg(err)}`)}#schedule`);
    }
  }
  redirect(`/applicants/${a.id}?cancelled=1#schedule`);
}

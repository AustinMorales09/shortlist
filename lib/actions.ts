"use server";

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { redirect } from "next/navigation";
import { db, filesDir, logEvent, STAGES, tx, type JobRow, type Question, type Stage } from "./db";
import { createSession, destroySession, hashPassword, verifyPassword } from "./auth";
import { MAX_RESUME, myOrg, ownApplicant, ownJob, sniffResume, storeFile } from "./access";
import { sendEmail, validEmail } from "./mail";
import { pdfText } from "./pdftext";
import { assessApplicant } from "./process";
import { parseCriteria, parseQuestions } from "./screen";

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const q = (m: string) => encodeURIComponent(m);
const validTz = (tz: string) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return !!tz;
  } catch {
    return false;
  }
};

// ---------- auth & settings ----------

export async function signup(form: FormData) {
  const email = str(form, "email").toLowerCase();
  const password = str(form, "password");
  const name = str(form, "name").slice(0, 80);
  const tz = validTz(str(form, "timezone")) ? str(form, "timezone") : "America/New_York";
  if (!name) redirect(`/signup?error=${q("Enter your company name")}`);
  if (!validEmail(email)) redirect(`/signup?error=${q("Enter a valid email")}`);
  if (password.length < 8) redirect(`/signup?error=${q("Password must be at least 8 characters")}`);
  if (db.prepare("SELECT 1 FROM users WHERE email = ?").get(email)) redirect(`/signup?error=${q("That email is already registered")}`);
  const uid = tx(() => {
    const id = Number(db.prepare("INSERT INTO users (email, password_hash, created_at) VALUES (?, ?, ?)").run(email, hashPassword(password), Date.now()).lastInsertRowid);
    db.prepare("INSERT INTO orgs (user_id, name, timezone, created_at) VALUES (?, ?, ?, ?)").run(id, name, tz, Date.now());
    return id;
  });
  await createSession(uid);
  redirect("/jobs?welcome=1");
}

export async function login(form: FormData) {
  const email = str(form, "email").toLowerCase();
  const user = db.prepare("SELECT id, password_hash FROM users WHERE email = ?").get(email) as { id: number; password_hash: string } | undefined;
  if (!user || !verifyPassword(str(form, "password"), user.password_hash)) redirect(`/login?error=${q("Wrong email or password")}`);
  await createSession(user.id);
  redirect("/jobs");
}

export async function logout() {
  await destroySession();
  redirect("/");
}

export async function saveSettings(form: FormData) {
  const org = await myOrg();
  const name = str(form, "name").slice(0, 80);
  const tz = str(form, "timezone");
  if (!name || !validTz(tz)) redirect(`/settings?error=${q("Enter a name and a valid time zone")}`);
  db.prepare("UPDATE orgs SET name = ?, timezone = ?, ai_enabled = ? WHERE id = ?").run(name, tz, form.get("ai_enabled") ? 1 : 0, org.id);
  redirect("/settings?saved=1");
}

// ---------- jobs ----------

export async function saveJob(form: FormData) {
  const org = await myOrg();
  const id = Number(form.get("job_id")) || null;
  const back = id ? `/jobs/${id}/edit` : "/jobs/new";
  const title = str(form, "title").slice(0, 100);
  const criteria = parseCriteria(String(form.get("must") ?? ""), String(form.get("nice") ?? ""));
  const questions = parseQuestions(String(form.get("questions") ?? ""));
  if (!title) redirect(`${back}?error=${q("Give the job a title")}`);
  if (!criteria.some((c) => c.kind === "must")) redirect(`${back}?error=${q("List at least one must-have criterion. Applications are compared against these, so make them specific and job-related.")}`);
  if ("error" in questions) redirect(`${back}?error=${q(questions.error)}`);
  const vals = [title, str(form, "location").slice(0, 80), str(form, "description").slice(0, 5000), JSON.stringify(criteria), JSON.stringify(questions.questions), form.get("blind") ? 1 : 0];
  let jid = id;
  let changed = false;
  if (id) {
    const { job } = await ownJob(id);
    changed = job.criteria !== vals[3] || job.blind !== vals[5];
    db.prepare("UPDATE jobs SET title = ?, location = ?, description = ?, criteria = ?, questions = ?, blind = ? WHERE id = ?").run(...vals, id);
    if (changed) logEvent(org.id, null, id, "user", "criteria-changed", `${criteria.length} criteria; blind review ${vals[5] ? "on" : "off"}`);
  } else {
    jid = Number(db.prepare("INSERT INTO jobs (title, location, description, criteria, questions, blind, org_id, slug, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(...vals, org.id, crypto.randomBytes(9).toString("base64url"), Date.now()).lastInsertRowid);
    logEvent(org.id, null, jid, "user", "job-created", title);
  }
  // Everyone is compared against the same, current criteria.
  if (changed) for (const r of db.prepare("SELECT id FROM applicants WHERE job_id = ? AND ai_optout = 0 ORDER BY id LIMIT 200").all(jid) as { id: number }[]) await assessApplicant(r.id);
  redirect(`/jobs/${jid}?saved=1`);
}

export async function setJobStatus(form: FormData) {
  const { org, job } = await ownJob(Number(form.get("job_id")));
  const status = str(form, "status") === "closed" ? "closed" : "open";
  db.prepare("UPDATE jobs SET status = ? WHERE id = ?").run(status, job.id);
  logEvent(org.id, null, job.id, "user", status === "closed" ? "job-closed" : "job-reopened");
  redirect(`/jobs/${job.id}`);
}

// ---------- applicants ----------

/** Every stage change is a person's decision. Rejecting requires a job-related reason, which is kept for audit. */
export async function moveStage(form: FormData) {
  const { org, a, job } = await ownApplicant(Number(form.get("applicant_id")));
  const stage = str(form, "stage") as Stage;
  const reason = [str(form, "reason"), str(form, "reason_text")].filter(Boolean).join(": ").slice(0, 300);
  if (!STAGES.includes(stage) || stage === a.stage) redirect(`/applicants/${a.id}`);
  if (stage === "rejected" && !reason) redirect(`/applicants/${a.id}?error=${q("Pick a reason for not moving forward. It's kept on record.")}`);
  db.prepare("UPDATE applicants SET stage = ?, decision_reason = ?, decided_at = ? WHERE id = ?").run(stage, stage === "rejected" ? reason : "", Date.now(), a.id);
  logEvent(org.id, a.id, job.id, "user", `stage:${stage}`, `from ${a.stage}${reason ? `; reason: ${reason}` : ""}`);
  if (stage === "rejected" && form.get("notify")) {
    await sendEmail({
      orgId: org.id, applicantId: a.id, to: a.email, subject: `Your application for ${job.title} at ${org.name}`,
      body: `Hi ${a.name.split(/\s+/)[0]},\n\nThank you for applying for ${job.title} and for the time you put into your application. After reviewing it, we won't be moving forward at this stage.\n\nYour application was reviewed by a member of our team. If you'd like to know more about how it was assessed, just reply to this email.\n\nWe wish you the best with your search.\n\n${org.name}`,
    });
    logEvent(org.id, a.id, job.id, "system", "emailed", "Decision email sent");
  }
  redirect(`/applicants/${a.id}?moved=${stage}`);
}

/** Shows the applicant's identity and unredacted resume. Logged, because it ends blind review for this person. */
export async function reveal(form: FormData) {
  const { org, a, job } = await ownApplicant(Number(form.get("applicant_id")));
  if (!a.revealed) {
    db.prepare("UPDATE applicants SET revealed = 1 WHERE id = ?").run(a.id);
    logEvent(org.id, a.id, job.id, "user", "identity-revealed", `at stage ${a.stage}`);
  }
  redirect(`/applicants/${a.id}`);
}

export async function reassess(form: FormData) {
  const { a } = await ownApplicant(Number(form.get("applicant_id")));
  await assessApplicant(a.id);
  redirect(`/applicants/${a.id}?assessed=${Date.now()}`);
}

/** Erases the application and resume file (for a deletion request). The audit log keeps only that it happened. */
export async function deleteApplicant(form: FormData) {
  const { org, a, job } = await ownApplicant(Number(form.get("applicant_id")));
  if (a.stored_as) fs.rmSync(path.join(filesDir, a.stored_as), { force: true });
  tx(() => {
    db.prepare("DELETE FROM applicants WHERE id = ?").run(a.id);
    db.prepare("DELETE FROM emails WHERE applicant_id = ?").run(a.id);
    db.prepare("UPDATE events SET detail = '' WHERE applicant_id = ?").run(a.id);
  });
  logEvent(org.id, a.id, job.id, "user", "application-deleted", "Personal data erased");
  redirect(`/jobs/${job.id}?deleted=1`);
}

// ---------- public application form ----------

async function createApplication(job: JobRow, f: { name: string; email: string; phone: string; text: string; file?: { name: string; mime: string; bytes: Buffer }; answers: Record<string, string>; optout: boolean }) {
  const resumeText = f.file ? (f.file.mime === "application/pdf" ? pdfText(f.file.bytes) : f.file.bytes.toString("utf8")) : f.text;
  const id = Number(db.prepare(
    "INSERT INTO applicants (org_id, job_id, name, email, phone, resume_name, resume_mime, stored_as, resume_text, answers, ai_optout, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(job.org_id, job.id, f.name, f.email, f.phone, f.file?.name ?? "", f.file?.mime ?? "", f.file ? storeFile(f.file.bytes) : "", resumeText.slice(0, 200_000), JSON.stringify(f.answers), f.optout ? 1 : 0, Date.now()).lastInsertRowid);
  logEvent(job.org_id, id, job.id, "candidate", "applied", f.optout ? "Asked for a human-only review" : "");
  try {
    await assessApplicant(id);
  } catch (err) {
    db.prepare("UPDATE applicants SET error = ? WHERE id = ?").run(err instanceof Error ? err.message.slice(0, 300) : "Comparison failed", id);
  }
  return id;
}

export async function apply(form: FormData) {
  const slug = str(form, "slug");
  const job = db.prepare("SELECT * FROM jobs WHERE slug = ?").get(slug) as JobRow | undefined;
  if (!job || job.status !== "open") redirect(`/apply/${slug}`);
  const back = (m: string): never => redirect(`/apply/${slug}?error=${q(m)}`);
  if (str(form, "website")) redirect(`/apply/${slug}/thanks`); // honeypot: bots fill hidden fields
  const name = str(form, "name").slice(0, 100);
  const email = str(form, "email").toLowerCase();
  const text = String(form.get("resume_text") ?? "").trim();
  const file = form.get("resume");
  if (!name || !validEmail(email)) back("Enter your name and a valid email address");
  if (!form.get("consent")) back("Please confirm you've read how your application is reviewed");
  if (db.prepare("SELECT 1 FROM applicants WHERE job_id = ? AND email = ?").get(job.id, email)) back("We already have an application from this email for this role");
  let upload: { name: string; mime: string; bytes: Buffer } | undefined;
  if (file && typeof file === "object" && (file as File).size > 0) {
    const f = file as File;
    if (f.size > MAX_RESUME) back("The resume file is over 5 MB");
    const bytes = Buffer.from(await f.arrayBuffer());
    const mime = sniffResume(f.name, bytes);
    if (!mime) back("Upload your resume as a PDF or .txt file, or paste it as text");
    upload = { name: f.name.replace(/[\\/\0\r\n"]/g, "_").slice(0, 120), mime: mime!, bytes };
  }
  if (!upload && text.length < 50) back("Attach your resume or paste it as text");
  const questions = JSON.parse(job.questions) as Question[];
  const answers: Record<string, string> = {};
  for (const qu of questions) {
    const v = str(form, `a_${qu.id}`).slice(0, 1000);
    if (!v) back("Please answer every question");
    answers[qu.id] = qu.type === "yesno" ? (v === "yes" ? "yes" : "no") : v;
  }
  await createApplication(job, { name, email, phone: str(form, "phone").slice(0, 40), text, file: upload, answers, optout: !!form.get("optout") });
  redirect(`/apply/${slug}/thanks`);
}

// ---------- demo ----------

const DEMO_RESUMES: { name: string; email: string; phone: string; optout?: boolean; work: "yes" | "no"; text: string }[] = [
  { name: "Jordan Rivera", email: "jordan.rivera@example.com", phone: "(555) 201-7788", work: "yes", text: "Jordan Rivera (she/her)\njordan.rivera@example.com | (555) 201-7788 | linkedin.com/in/jrivera\n221 Maple Street, Apt 4, Austin TX\nDate of birth: 04/12/1988\n\nExperience\nSenior Backend Engineer, Finlytics (2019-2024)\n- Built payment APIs in Python and Django serving 2M requests/day\n- Led a team of 4 engineers; mentored two juniors\n- Migrated PostgreSQL clusters to AWS RDS\nCareer break (2017-2019): caregiving\n\nEducation\nBSc Computer Science, University of Texas" },
  { name: "Sam Okafor", email: "sam.okafor@example.com", phone: "555-330-1212", work: "yes", text: "Sam Okafor\nsam.okafor@example.com | 555-330-1212\n\nSummary\nFull-stack developer moving toward backend work.\n\nExperience\nSoftware Developer, Brightside Apps (2022-2025)\n- Built REST services in Node.js and TypeScript\n- Wrote reporting queries against MySQL\n- Deployed services to Kubernetes on AWS\n\nProjects\n- Open-source contributor to a Python data-validation library" },
  { name: "Priya Shah", email: "priya.shah@example.com", phone: "555-778-9900", optout: true, work: "yes", text: "Priya Shah\npriya.shah@example.com\n\nExperience\nBackend Engineer, Larkspur Health (2018-2025)\n- Python services with FastAPI and PostgreSQL\n- On-call lead for the platform team" },
  { name: "Alex Chen", email: "alex.chen@example.com", phone: "555-410-2020", work: "no", text: "Alex Chen\nalex.chen@example.com\n\nExperience\nData Analyst, Northwind (2020-2025)\n- Dashboards in Tableau and SQL reporting\n- Automated spreadsheets with Python scripts" },
];

/** A sample job with four applications, including one who asked for a human-only review. */
export async function loadDemo() {
  const org = await myOrg();
  const criteria = parseCriteria("5+ years of backend development in Python\nExperience with PostgreSQL\nLed or mentored other engineers", "Kubernetes experience\nAWS");
  const questions = parseQuestions("Are you legally authorized to work in the United States? | yesno | expect yes\nWhat interests you about this role? | text");
  if ("error" in questions) redirect("/jobs");
  const jid = Number(db.prepare("INSERT INTO jobs (org_id, slug, title, location, description, criteria, questions, blind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)").run(
    org.id, crypto.randomBytes(9).toString("base64url"), "Senior Backend Engineer", "Remote (US)", "Build and run the payment APIs behind our product, with a small senior team.", JSON.stringify(criteria), JSON.stringify(questions.questions), Date.now(),
  ).lastInsertRowid);
  logEvent(org.id, null, jid, "user", "job-created", "Senior Backend Engineer (sample)");
  const job = db.prepare("SELECT * FROM jobs WHERE id = ?").get(jid) as JobRow;
  for (const d of DEMO_RESUMES) {
    await createApplication(job, { name: d.name, email: d.email, phone: d.phone, text: d.text, optout: !!d.optout, answers: { [questions.questions[0].id]: d.work, [questions.questions[1].id]: "I enjoy backend work and the product space." } });
  }
  redirect(`/jobs/${jid}`);
}


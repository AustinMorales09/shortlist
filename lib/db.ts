import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

export const dataDir = process.env.DATA_DIR ?? (process.env.VERCEL ? demoDataDir() : path.join(process.env.APP_DIR ?? process.cwd(), "data"));

// Vercel deployments are read-only: copy the bundled demo snapshot (seed/) to /tmp once per instance and work there.
// Changes last as long as the instance does, so the public demo resets itself.
function demoDataDir(): string {
  const dir = "/tmp/data";
  const seed = path.join(process.cwd(), "seed");
  if (!fs.existsSync(path.join(dir, "app.db")) && fs.existsSync(seed)) fs.cpSync(seed, dir, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
export const filesDir = path.join(dataDir, "files");

function init(): DatabaseSync {
  fs.mkdirSync(filesDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, "app.db"));
  db.exec(`
    PRAGMA busy_timeout = 5000; -- first, so parallel build workers wait instead of failing
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);

    CREATE TABLE IF NOT EXISTS orgs (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      timezone TEXT NOT NULL,
      ai_enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    );

    -- slug: unguessable public path for the application form.
    -- criteria: JSON [{ id, text, kind: "must" | "nice" }]   questions: JSON [{ id, text, type: "yesno" | "text", expect: "yes" | "no" | null }]
    -- blind: reviewers (and the AI) see resumes with identifying details removed until identity is revealed.
    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, -- never reused: the audit log refers to jobs by id
      org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
      slug TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      location TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      criteria TEXT NOT NULL DEFAULT '[]',
      questions TEXT NOT NULL DEFAULT '[]',
      blind INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'open',
      created_at INTEGER NOT NULL
    );

    -- stage: new | shortlist | interview | offer | hired | rejected.  Only people change it.
    -- assessment: JSON [{ id, status: met | partial | not_shown, evidence, evidence_ok, note }]   source: claude | rules | '' (not assessed)
    CREATE TABLE IF NOT EXISTS applicants (
      id INTEGER PRIMARY KEY AUTOINCREMENT, -- never reused: audit events outlive a deleted application
      org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
      job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT NOT NULL DEFAULT '',
      resume_name TEXT NOT NULL DEFAULT '',
      resume_mime TEXT NOT NULL DEFAULT '',
      stored_as TEXT NOT NULL DEFAULT '',
      resume_text TEXT NOT NULL DEFAULT '',
      answers TEXT NOT NULL DEFAULT '{}',
      ai_optout INTEGER NOT NULL DEFAULT 0,
      revealed INTEGER NOT NULL DEFAULT 0,
      stage TEXT NOT NULL DEFAULT 'new',
      assessment TEXT NOT NULL DEFAULT '[]',
      summary TEXT NOT NULL DEFAULT '',
      followups TEXT NOT NULL DEFAULT '[]',
      source TEXT NOT NULL DEFAULT '',
      error TEXT,
      assessed_at INTEGER,
      decision_reason TEXT NOT NULL DEFAULT '',
      decided_at INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_applicants_job ON applicants(job_id, stage);

    -- Append-only audit trail: what the system, the AI and each person did to an application.
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY,
      org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
      applicant_id INTEGER,
      job_id INTEGER,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS emails (
      id INTEGER PRIMARY KEY,
      org_id INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
      applicant_id INTEGER,
      recipient TEXT NOT NULL,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL,
      error TEXT,
      created_at INTEGER NOT NULL
    );
  `);
  return db;
}

const g = globalThis as unknown as { __db?: DatabaseSync };
export const db = g.__db ?? (g.__db = init());

export function tx<T>(fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export const STAGES = ["new", "shortlist", "interview", "offer", "hired", "rejected"] as const;
export type Stage = (typeof STAGES)[number];
export type Org = { id: number; user_id: number; name: string; timezone: string; ai_enabled: number; created_at: number };
export type Criterion = { id: string; text: string; kind: "must" | "nice" };
export type Question = { id: string; text: string; type: "yesno" | "text"; expect: "yes" | "no" | null };
export type JobRow = { id: number; org_id: number; slug: string; title: string; location: string; description: string; criteria: string; questions: string; blind: number; status: "open" | "closed"; created_at: number };
export type CritStatus = "met" | "partial" | "not_shown";
export type Assessed = { id: string; status: CritStatus; evidence: string | null; evidence_ok: boolean | null; note: string };
export type ApplicantRow = {
  id: number; org_id: number; job_id: number; name: string; email: string; phone: string; resume_name: string; resume_mime: string; stored_as: string; resume_text: string;
  answers: string; ai_optout: number; revealed: number; stage: Stage; assessment: string; summary: string; followups: string; source: string; error: string | null;
  assessed_at: number | null; decision_reason: string; decided_at: number | null; created_at: number;
};

export function logEvent(orgId: number, applicantId: number | null, jobId: number | null, actor: "system" | "ai" | "user" | "candidate", action: string, detail = "") {
  db.prepare("INSERT INTO events (org_id, applicant_id, job_id, actor, action, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(orgId, applicantId, jobId, actor, action, detail.slice(0, 500), Date.now());
}

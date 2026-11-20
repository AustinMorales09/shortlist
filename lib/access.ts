import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { notFound } from "next/navigation";
import { requireUser } from "./auth";
import { db, filesDir, type ApplicantRow, type JobRow, type Org } from "./db";

export async function myOrg(): Promise<Org> {
  const user = await requireUser();
  return db.prepare("SELECT * FROM orgs WHERE user_id = ?").get(user.id) as Org;
}

export async function ownJob(id: number) {
  const org = await myOrg();
  const job = db.prepare("SELECT * FROM jobs WHERE id = ? AND org_id = ?").get(id, org.id) as JobRow | undefined;
  if (!job) notFound();
  return { org, job };
}

export async function ownApplicant(id: number) {
  const org = await myOrg();
  const a = db.prepare("SELECT * FROM applicants WHERE id = ? AND org_id = ?").get(id, org.id) as ApplicantRow | undefined;
  if (!a) notFound();
  const job = db.prepare("SELECT * FROM jobs WHERE id = ?").get(a.job_id) as JobRow;
  return { org, a, job };
}

/** How an applicant is referred to on screen: a number while the job is blind and identity isn't revealed. */
export const displayName = (a: Pick<ApplicantRow, "id" | "name" | "revealed">, job: Pick<JobRow, "blind">) => (job.blind && !a.revealed ? `Candidate #${a.id}` : a.name);

export const MAX_RESUME = 5 * 1024 * 1024;

/** Resume type from the file's own bytes: PDF or plain text only. */
export function sniffResume(name: string, b: Buffer): string | null {
  if (b.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  if (/\.(txt|md)$/i.test(name) && !b.subarray(0, 4000).includes(0)) return "text/plain";
  return null;
}

export function storeFile(bytes: Buffer): string {
  const storedAs = crypto.randomBytes(16).toString("hex");
  fs.writeFileSync(path.join(filesDir, storedAs), bytes);
  return storedAs;
}

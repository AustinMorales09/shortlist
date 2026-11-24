import { notFound } from "next/navigation";
import { requireUser } from "./auth";
import { db, type ApplicantRow, type JobRow, type Org } from "./db";

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

export { MAX_RESUME, sniffResume, storeFile } from "./files";

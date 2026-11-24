import { db, logEvent, type JobRow } from "./db";
import { storeFile } from "./files";
import { pdfText } from "./pdftext";
import { assessApplicant } from "./process";

/** Adds an application (from the public form, the sample loader or an import) and compares it with the job's criteria. */
export async function createApplication(job: JobRow, f: { name: string; email: string; phone: string; text: string; file?: { name: string; mime: string; bytes: Buffer }; answers: Record<string, string>; optout: boolean; source?: string; assess?: boolean }) {
  const resumeText = f.file ? (f.file.mime === "application/pdf" ? pdfText(f.file.bytes) : f.file.mime === "text/plain" ? f.file.bytes.toString("utf8") : "") : f.text;
  const id = Number(db.prepare(
    "INSERT INTO applicants (org_id, job_id, name, email, phone, resume_name, resume_mime, stored_as, resume_text, answers, ai_optout, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(job.org_id, job.id, f.name, f.email, f.phone, f.file?.name ?? "", f.file?.mime ?? "", f.file ? storeFile(f.file.bytes) : "", resumeText.slice(0, 200_000), JSON.stringify(f.answers), f.optout ? 1 : 0, Date.now()).lastInsertRowid);
  logEvent(job.org_id, id, job.id, f.source ? "system" : "candidate", f.source ? "imported" : "applied", f.source ? `From ${f.source}` : f.optout ? "Asked for a human-only review" : "");
  if (f.assess === false) return id;
  try {
    await assessApplicant(id);
  } catch (err) {
    db.prepare("UPDATE applicants SET error = ? WHERE id = ?").run(err instanceof Error ? err.message.slice(0, 300) : "Comparison failed", id);
  }
  return id;
}


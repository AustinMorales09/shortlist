import type Anthropic from "@anthropic-ai/sdk";
import { db, logEvent, type ApplicantRow, type Assessed, type Criterion, type JobRow, type Org } from "./db";
import { AiUnavailable, claudeAssess } from "./claude";
import { quoteFound, redact, rulesAssess } from "./screen";

const g = globalThis as unknown as { __aiDown?: { until: number; reason: string } };

export function aiStatus(org: Pick<Org, "ai_enabled">): { mode: "claude" | "rules"; reason: string } {
  if (process.env.SCREEN_AI === "off") return { mode: "rules", reason: "AI is turned off on this server (SCREEN_AI=off)" };
  if (!org.ai_enabled) return { mode: "rules", reason: "AI is turned off in Settings" };
  if (g.__aiDown && g.__aiDown.until > Date.now()) return { mode: "rules", reason: `Claude isn't available: ${g.__aiDown.reason}` };
  return { mode: "claude", reason: "" };
}

/** The resume as reviewers and the model see it: redacted while the job is blind and identity isn't revealed. */
export function resumeFor(a: Pick<ApplicantRow, "resume_text" | "name" | "email" | "phone" | "revealed">, job: Pick<JobRow, "blind">): string {
  return job.blind && !a.revealed ? redact(a.resume_text, a) : a.resume_text;
}

/**
 * Compares one application against the job's criteria and stores the result. It never changes the applicant's
 * stage. Applicants who asked for a human-only review are not sent to the model or the keyword matcher.
 * In blind mode the model only ever receives the redacted text.
 */
export async function assessApplicant(applicantId: number, opts: { client?: Anthropic } = {}): Promise<{ source: string; error: string | null }> {
  const a = db.prepare("SELECT * FROM applicants WHERE id = ?").get(applicantId) as ApplicantRow;
  const job = db.prepare("SELECT * FROM jobs WHERE id = ?").get(a.job_id) as JobRow;
  const org = db.prepare("SELECT * FROM orgs WHERE id = ?").get(a.org_id) as Org;
  const criteria = JSON.parse(job.criteria) as Criterion[];
  const save = (source: string, error: string | null, assessment: Assessed[], summary = "", followups: string[] = []) => {
    db.prepare("UPDATE applicants SET assessment = ?, summary = ?, followups = ?, source = ?, error = ?, assessed_at = ? WHERE id = ?").run(
      JSON.stringify(assessment), summary, JSON.stringify(followups), source, error, Date.now(), a.id,
    );
    return { source, error };
  };

  if (a.ai_optout) return save("", "The applicant asked for a human-only review, so no automated comparison was run.", []);
  if (!criteria.length) return save("", "This job has no criteria yet, so there is nothing to compare against.", []);
  if (!a.resume_text.trim()) return save("", "The resume has no readable text (a scan or image-only PDF). Read the original file.", []);

  // Always the redacted text in blind mode: the model gets no more than a blind reviewer would.
  const text = job.blind ? redact(a.resume_text, a) : a.resume_text;
  let error: string | null = null;
  if (opts.client || aiStatus(org).mode === "claude") {
    try {
      const raw = await claudeAssess({ title: job.title, criteria }, text.slice(0, 60_000), opts.client);
      const byId = new Map(raw.criteria.map((c) => [c.id, c]));
      const assessment: Assessed[] = criteria.map((c) => {
        const r = byId.get(c.id);
        if (!r) return { id: c.id, status: "not_shown", evidence: null, evidence_ok: null, note: "Not assessed" };
        const ok = r.evidence ? quoteFound(r.evidence, text) : null;
        // "Met" must be backed by words we can find in the resume. Without that it is downgraded and flagged,
        // so an invented or paraphrased quote can't count toward the tally.
        const unbacked = r.status === "met" && ok !== true;
        return {
          id: c.id, status: unbacked ? "partial" : r.status, evidence: r.evidence ? r.evidence.slice(0, 300) : null, evidence_ok: ok,
          note: (unbacked ? "Marked met, but the quote wasn't found in the resume. Check the original. " : "") + r.note.slice(0, 300),
        };
      });
      logEvent(org.id, a.id, job.id, "ai", "assessed", `Claude compared the resume with ${criteria.length} criteria${job.blind ? " (redacted text)" : ""}`);
      return save("claude", null, assessment, raw.summary.slice(0, 800), raw.followups.slice(0, 4).map((f) => f.slice(0, 240)));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (err instanceof AiUnavailable) g.__aiDown = { until: Date.now() + 10 * 60_000, reason: /resolve authentication/i.test(msg) ? "no Anthropic API credentials found on this server" : msg.slice(0, 160) };
      else error = `Claude couldn't read this application (${msg.slice(0, 200)}); showing keyword matches instead`;
    }
  }
  logEvent(org.id, a.id, job.id, "system", "assessed", `Keyword matching against ${criteria.length} criteria`);
  return save("rules", error, rulesAssess(criteria, text));
}

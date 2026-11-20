import { NextResponse } from "next/server";
import { getUser } from "@/lib/auth";
import { db, type ApplicantRow, type Assessed, type Criterion, type JobRow, type Org } from "@/lib/db";
import { tally } from "@/lib/screen";

const cell = (v: string | number) => {
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // keep spreadsheets from running it as a formula
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const day = (ms: number | null) => (ms ? new Date(ms).toISOString().slice(0, 10) : "");

// One row per application: what was compared, by what, and what a person decided and why. No names or
// contact details, so it can be handed to an auditor (e.g. for a bias audit) as is.
export async function GET() {
  const user = await getUser();
  const org = user && (db.prepare("SELECT * FROM orgs WHERE user_id = ?").get(user.id) as Org | undefined);
  if (!org) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const jobs = new Map((db.prepare("SELECT * FROM jobs WHERE org_id = ?").all(org.id) as JobRow[]).map((j) => [j.id, j]));
  const lines = [["Application", "Job", "Applied", "Blind review", "Compared by", "Human-only requested", "Must-haves met", "Must-haves partly", "Must-haves not shown", "Stage", "Decision reason", "Decided", "Identity revealed"].join(",")];
  for (const a of db.prepare("SELECT * FROM applicants WHERE org_id = ? ORDER BY id").all(org.id) as ApplicantRow[]) {
    const job = jobs.get(a.job_id)!;
    const t = tally(JSON.parse(job.criteria) as Criterion[], JSON.parse(a.assessment) as Assessed[]);
    const compared = a.source === "claude" ? "AI (Claude)" : a.source === "rules" ? "keyword match" : "none";
    lines.push([a.id, job.title, day(a.created_at), job.blind ? "yes" : "no", compared, a.ai_optout ? "yes" : "no", a.source ? t.must.met : "", a.source ? t.must.partial : "", a.source ? t.must.not_shown : "", a.stage, a.decision_reason, day(a.decided_at), a.revealed ? "yes" : "no"].map(cell).join(","));
  }
  return new NextResponse(lines.join("\r\n") + "\r\n", {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="screening-audit.csv"', "Cache-Control": "no-store" },
  });
}

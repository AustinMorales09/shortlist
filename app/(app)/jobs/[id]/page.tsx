import Link from "next/link";
import { headers } from "next/headers";
import { displayName, ownJob } from "@/lib/access";
import { setJobStatus } from "@/lib/actions";
import { db, STAGES, type ApplicantRow, type Assessed, type Criterion, type Question } from "@/lib/db";
import { tally, unmetAnswers } from "@/lib/screen";
import { fmtStamp } from "@/lib/time";

const STAGE_PILL: Record<string, string> = { new: "pill-warn", shortlist: "pill-due", interview: "pill-due", offer: "pill-ok", hired: "pill-ok", rejected: "pill-muted" };

export default async function JobPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ stage?: string; sort?: string; saved?: string; deleted?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  const { org, job } = await ownJob(Number(id));
  const criteria = JSON.parse(job.criteria) as Criterion[];
  const questions = JSON.parse(job.questions) as Question[];
  const all = db.prepare("SELECT * FROM applicants WHERE job_id = ? ORDER BY id").all(job.id) as ApplicantRow[];
  const stage = STAGES.find((s) => s === sp.stage) ?? "all";
  const rows = all.filter((a) => stage === "all" || a.stage === stage).map((a) => ({ a, t: tally(criteria, JSON.parse(a.assessment) as Assessed[]), flags: unmetAnswers(questions, JSON.parse(a.answers) as Record<string, string>) }));
  if (sp.sort === "criteria") rows.sort((x, y) => y.t.must.met - x.t.must.met || y.t.must.partial - x.t.must.partial || x.a.id - y.a.id);
  const h = await headers();
  const url = `${h.get("x-forwarded-proto") ?? "http"}://${h.get("host")}/apply/${job.slug}`;
  const link = (s: string) => `/jobs/${job.id}?stage=${s}${sp.sort ? `&sort=${sp.sort}` : ""}`;

  return (
    <main className="container">
      <p className="small" style={{ margin: 0 }}><Link href="/jobs">← Jobs</Link></p>
      <h1 style={{ margin: "8px 0 4px" }}>{job.title} <span className={job.status === "open" ? "pill-ok" : "pill-muted"}>{job.status}</span></h1>
      <p className="muted" style={{ marginTop: 0 }}>{job.location}{job.location ? " · " : ""}{job.blind ? "blind review" : "names visible"} · {criteria.filter((c) => c.kind === "must").length} must-haves, {criteria.filter((c) => c.kind === "nice").length} nice-to-haves · <Link href={`/jobs/${job.id}/edit`}>Edit</Link></p>
      {sp.saved && <p className="ok-text small">Saved.</p>}
      {sp.deleted && <p className="ok-text small">Application deleted and its personal data erased.</p>}

      <div className="card">
        <h2>Application link</h2>
        {job.status === "open" ? <code className="url-box">{url}</code> : <p className="small muted">Closed: the form isn&apos;t accepting applications.</p>}
        <form action={setJobStatus} style={{ marginTop: 8 }}>
          <input type="hidden" name="job_id" value={job.id} /><input type="hidden" name="status" value={job.status === "open" ? "closed" : "open"} />
          <button className="secondary">{job.status === "open" ? "Close to new applications" : "Reopen"}</button>
        </form>
      </div>

      <div className="filters">
        <Link href={link("all")} className={stage === "all" ? "on" : ""}>All ({all.length})</Link>
        {STAGES.map((s) => <Link key={s} href={link(s)} className={stage === s ? "on" : ""}>{s} ({all.filter((a) => a.stage === s).length})</Link>)}
        <span style={{ marginLeft: "auto" }} className="small">
          Order: <Link href={`/jobs/${job.id}?stage=${stage}`} className={sp.sort ? "" : "on"}>date applied</Link> <Link href={`/jobs/${job.id}?stage=${stage}&sort=criteria`} className={sp.sort === "criteria" ? "on" : ""}>must-haves shown</Link>
        </span>
      </div>
      <div className="card table-wrap">
        {rows.length === 0 ? <p className="small muted" style={{ margin: 0 }}>No applications here yet.</p> : (
          <table className="list">
            <thead><tr><th>Applicant</th><th>Must-haves (of {criteria.filter((c) => c.kind === "must").length})</th><th>Flags</th><th>Stage</th></tr></thead>
            <tbody>
              {rows.map(({ a, t, flags }) => (
                <tr key={a.id}>
                  <td><Link href={`/applicants/${a.id}`}><strong>{displayName(a, job)}</strong></Link><div className="small muted">applied {fmtStamp(a.created_at, org.timezone)}</div></td>
                  <td className="small tally">
                    {a.ai_optout ? <span className="muted">human-only review requested</span> : !a.source ? <span className="muted">not compared: read the resume</span> : a.source === "rules" ? (
                      // Keyword matching can't confirm anything is met, so it reports only what's mentioned.
                      <><span className="s-partial">{t.must.partial} mentioned</span> · <span className="s-not_shown">{t.must.not_shown} not found</span><div className="muted">keyword match only</div></>
                    ) : (
                      <><span className="s-met">{t.must.met} shown</span> · <span className="s-partial">{t.must.partial} partly</span> · <span className="s-not_shown">{t.must.not_shown} not shown</span></>
                    )}
                  </td>
                  <td className="small">{flags.length ? <span className="status-warn">{flags.length} answer{flags.length > 1 ? "s" : ""} to check</span> : <span className="muted">—</span>}</td>
                  <td><span className={STAGE_PILL[a.stage]}>{a.stage}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <p className="small muted">The counts show what each resume demonstrates against your criteria. They aren&apos;t a score or a ranking, and &quot;not shown&quot; means the resume doesn&apos;t mention it, not that the person lacks it. Open each application to decide.</p>
    </main>
  );
}

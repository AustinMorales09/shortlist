import Link from "next/link";
import { displayName, ownApplicant } from "@/lib/access";
import { deleteApplicant, moveStage, reassess, reveal } from "@/lib/actions";
import { db, STAGES, type Assessed, type Criterion, type Question } from "@/lib/db";
import { resumeFor } from "@/lib/process";
import { unmetAnswers } from "@/lib/screen";
import { fmtStamp, today } from "@/lib/time";
import { bookInterview, cancelBooked } from "@/lib/integration-actions";
import { GCAL, GH } from "@/lib/integrations";
import { getConn, getLink, jobFor } from "@/lib/integrations/core";
import { interviewsFor } from "@/lib/integrations/gcal";

type SP = { error?: string; moved?: string; assessed?: string; busy?: string; scheduled?: string; cancelled?: string; date?: string; time?: string; minutes?: string; interviewers?: string; meet?: string };
const LABEL = { met: "Shown", partial: "Partly shown", not_shown: "Not shown in resume" };

export default async function ApplicantPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<SP> }) {
  const { id } = await params;
  const sp = await searchParams;
  const { org, a, job } = await ownApplicant(Number(id));
  const criteria = JSON.parse(job.criteria) as Criterion[];
  const questions = JSON.parse(job.questions) as Question[];
  const answers = JSON.parse(a.answers) as Record<string, string>;
  const assessment = new Map((JSON.parse(a.assessment) as Assessed[]).map((x) => [x.id, x]));
  const followups = JSON.parse(a.followups) as string[];
  // Applied through Greenhouse: they answered Greenhouse's form, not this one, so this job's questions aren't flagged.
  const viaGreenhouse = !!getLink(org.id, GH, "applicant", a.id) && Object.keys(answers).length === 0;
  const flags = viaGreenhouse ? [] : unmetAnswers(questions, answers);
  const hidden = !!job.blind && !a.revealed;
  const events = db.prepare("SELECT * FROM events WHERE applicant_id = ? ORDER BY id DESC LIMIT 30").all(a.id) as { id: number; actor: string; action: string; detail: string; created_at: number }[];
  const musts = criteria.filter((c) => c.kind === "must");

  const critList = (kind: Criterion["kind"]) => criteria.filter((c) => c.kind === kind).map((c) => {
    const x = assessment.get(c.id);
    return (
      <div key={c.id} className="crit">
        <div className="crit-head"><span>{c.text}</span>{x ? <span className={`small s-${x.status}`}>{a.source === "rules" ? (x.status === "partial" ? "Mentioned" : "No keyword match") : LABEL[x.status]}</span> : <span className="small muted">not compared</span>}</div>
        {x?.evidence && <div className="quote">&ldquo;{x.evidence}&rdquo;{x.evidence_ok === false ? <span className="status-warn" style={{ fontStyle: "normal" }}> (this quote wasn&apos;t found in the resume)</span> : null}</div>}
        {x?.note && <div className="small muted">{x.note}</div>}
      </div>
    );
  });

  return (
    <main className="container" style={{ maxWidth: 1240 }}>
      <p className="small" style={{ margin: 0 }}><Link href={`/jobs/${job.id}`}>← {job.title}</Link></p>
      <h1 style={{ margin: "8px 0 4px" }}>{displayName(a, job)}</h1>
      <p className="muted" style={{ marginTop: 0 }}>
        {hidden ? "Identity hidden (blind review)" : `${a.email}${a.phone ? ` · ${a.phone}` : ""}`} · applied {fmtStamp(a.created_at, org.timezone)} · stage: <strong>{a.stage}</strong>{a.decision_reason ? ` (${a.decision_reason})` : ""}
      </p>
      {sp.error && <p className="error card">{sp.error}</p>}
      {sp.moved && <p className="ok-text small">Moved to {sp.moved}. Recorded in the audit log.</p>}
      {sp.assessed && <p className="ok-text small">Compared again against the current criteria.</p>}
      <GreenhouseLine orgId={org.id} applicantId={a.id} />

      <div className="review">
        <div>
          <div className="card">
            <h2 style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>Resume {hidden ? <span className="small muted">personal details removed</span> : a.stored_as ? <a className="small" href={`/resumes/${a.id}`}>Download original</a> : null}</h2>
            {a.resume_text ? <pre className="resume">{resumeFor(a, job)}</pre> : <p className="small status-warn">No readable text in this file (a scan or image-only PDF). {hidden ? "Reveal identity to download and read the original." : "Download the original to read it."}</p>}
          </div>
          {questions.length > 0 && viaGreenhouse && <div className="card small muted">Applied through Greenhouse: their answers to the application questions are in Greenhouse.</div>}
          {questions.length > 0 && !viaGreenhouse && (
            <div className="card">
              <h2>Their answers</h2>
              {questions.map((q) => <div key={q.id} className="crit"><div className="small muted">{q.text}</div><div>{answers[q.id] || "—"}{q.expect && (answers[q.id] ?? "") !== q.expect ? <span className="status-warn small"> (the job asks for &quot;{q.expect}&quot;)</span> : null}</div></div>)}
            </div>
          )}
        </div>

        <div>
          <div className="card ai-box">
            <h2 style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>Against the criteria <span className="small muted">{a.source === "claude" ? "read by Claude" : a.source === "rules" ? "keyword match" : "not compared"}</span></h2>
            {a.error && <p className="small status-warn" style={{ marginTop: 0 }}>{a.error}</p>}
            {a.summary && <p style={{ marginTop: 0 }}>{a.summary}</p>}
            {(a.source || !a.error) && (
              <>
                <h3 className="small muted" style={{ margin: "8px 0 0" }}>MUST-HAVES</h3>
                {critList("must")}
                {criteria.some((c) => c.kind === "nice") && <><h3 className="small muted" style={{ margin: "12px 0 0" }}>NICE-TO-HAVES</h3>{critList("nice")}</>}
              </>
            )}
            {followups.length > 0 && <><h3 className="small muted" style={{ margin: "12px 0 4px" }}>QUESTIONS YOU COULD ASK</h3><ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{followups.map((f, i) => <li key={i}>{f}</li>)}</ul></>}
            <p className="small muted" style={{ marginBottom: 0 }}>This is a reading aid, not a recommendation. &quot;Not shown&quot; means the resume doesn&apos;t mention it. The decision is yours.</p>
            {!a.ai_optout && <form action={reassess} style={{ marginTop: 6 }}><input type="hidden" name="applicant_id" value={a.id} /><button className="link">Compare again</button></form>}
          </div>

          {flags.length > 0 && <div className="card attention"><h2>Answers to check</h2><ul>{flags.map((f, i) => <li key={i}>{f}</li>)}</ul></div>}

          <div className="card">
            <h2>Your decision</h2>
            <form action={moveStage} key={a.stage}>
              <input type="hidden" name="applicant_id" value={a.id} />
              <div className="field"><label htmlFor="stage">Move to</label><select id="stage" name="stage" defaultValue={a.stage}>{STAGES.map((s) => <option key={s} value={s}>{s === "rejected" ? "not moving forward" : s}</option>)}</select></div>
              <div className="field">
                <label htmlFor="reason">Reason (required when not moving forward; job-related, kept on record)</label>
                <select id="reason" name="reason" defaultValue="">
                  <option value="">—</option>
                  {musts.map((c) => <option key={c.id} value={`Resume doesn't show a must-have: ${c.text}`}>Doesn&apos;t show: {c.text}</option>)}
                  <option value="Stated requirement not met in application answers">Stated requirement not met (their answers)</option>
                  <option value="Other candidates more closely matched the criteria">Others matched the criteria more closely</option>
                  <option value="Position filled">Position filled</option>
                  <option value="Applicant withdrew">Applicant withdrew</option>
                  <option value="Other">Other (explain below)</option>
                </select>
              </div>
              <div className="field"><input name="reason_text" placeholder="Details (optional)" aria-label="Reason details" /></div>
              <label className="choice-row"><input type="checkbox" name="notify" /> If not moving forward, email them a polite note</label>
              <button type="submit" style={{ marginTop: 8 }}>Save decision</button>
            </form>
            {hidden && (
              <form action={reveal} style={{ marginTop: 10 }}>
                <input type="hidden" name="applicant_id" value={a.id} />
                <button className="secondary">Reveal identity &amp; contact details</button>
                <p className="small muted" style={{ margin: "4px 0 0" }}>Do this once you&apos;ve decided to contact them. It&apos;s logged.</p>
              </form>
            )}
          </div>

          <Schedule org={org} a={a} hidden={hidden} sp={sp} />

          <div className="card">
            <h2>History</h2>
            <table className="list"><tbody>
              {events.map((e) => <tr key={e.id}><td className="small muted" style={{ whiteSpace: "nowrap" }}>{fmtStamp(e.created_at, org.timezone)}</td><td className="small">{e.actor}</td><td className="small">{e.action}{e.detail ? <span className="muted"> · {e.detail}</span> : null}</td></tr>)}
            </tbody></table>
            <form action={deleteApplicant} style={{ marginTop: 8 }}><input type="hidden" name="applicant_id" value={a.id} /><button className="link">Delete this application and its personal data</button></form>
          </div>
        </div>
      </div>
    </main>
  );
}

/** Where this application came from in Greenhouse, and whether the latest decision note reached it. */
function GreenhouseLine({ orgId, applicantId }: { orgId: number; applicantId: number }) {
  const link = getConn(orgId, GH) && getLink(orgId, GH, "applicant", applicantId);
  if (!link) return null;
  const last = db.prepare("SELECT ref FROM integration_jobs WHERE owner_id = ? AND provider = ? AND kind = 'note' AND ref LIKE ? ORDER BY id DESC LIMIT 1").get(orgId, GH, `${applicantId}:%`) as { ref: string } | undefined;
  const note = last ? jobFor(orgId, GH, "note", last.ref) : undefined;
  return (
    <p className="small muted" style={{ margin: "0 0 10px" }}>
      Imported from Greenhouse (application {link.remote_id}).
      {note ? <> Decision note: {note.status === "done" ? <span className="status-ok">added in Greenhouse</span> : note.status === "failed" ? <span className="status-err">failed ({note.last_error})</span> : <span className="status-warn">sending…</span>}</> : null}
      {" "}<Link href="/integrations#greenhouse">Integrations</Link>
    </p>
  );
}

function Schedule({ org, a, hidden, sp }: { org: { id: number; timezone: string }; a: { id: number; stage: string }; hidden: boolean; sp: SP }) {
  const c = getConn(org.id, GCAL);
  const ivs = interviewsFor(a.id);
  const when = (ms: number) => new Date(ms).toLocaleString("en-US", { timeZone: org.timezone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const busy = sp.busy ? (JSON.parse(sp.busy) as { start: string; end: string }[]) : [];
  if (!c && !ivs.length) {
    return <div className="card small muted" id="schedule">Connect Google Calendar on the <Link href="/integrations#gcal">Integrations</Link> page to schedule interviews from here.</div>;
  }
  return (
    <div className="card" id="schedule">
      <h2>Interviews</h2>
      {sp.scheduled && <p className="ok-text small">Scheduled. The invitation was sent from your Google Calendar.</p>}
      {sp.cancelled && <p className="ok-text small">Cancelled; everyone invited was notified.</p>}
      {ivs.length > 0 && (
        <ul className="small" style={{ paddingLeft: 18, margin: "0 0 10px" }}>
          {ivs.map((iv) => (
            <li key={iv.id} style={iv.status === "cancelled" ? { textDecoration: "line-through", opacity: 0.6 } : undefined}>
              {when(iv.starts_at)} · {iv.minutes} min{iv.meet_link ? <> · <a href={iv.meet_link} target="_blank" rel="noopener">Meet link</a></> : null}
              {iv.html_link && c?.mode === "live" ? <> · <a href={iv.html_link} target="_blank" rel="noopener">calendar</a></> : null}
              {iv.status === "scheduled" && (
                <form action={cancelBooked} style={{ display: "inline" }}>
                  <input type="hidden" name="applicant_id" value={a.id} /><input type="hidden" name="interview_id" value={iv.id} />
                  {" · "}<button className="link small">cancel</button>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
      {c && (hidden ? <p className="small muted" style={{ margin: 0 }}>Reveal the candidate&apos;s identity to schedule: the invitation goes to their email.</p> : (
        <form action={bookInterview}>
          <input type="hidden" name="applicant_id" value={a.id} />
          {busy.length > 0 && (
            <div className="attention small" style={{ padding: 10, borderRadius: 8, marginBottom: 8 }}>
              Your calendar is busy then: {busy.map((b) => `${when(Date.parse(b.start))}–${new Date(b.end).toLocaleTimeString("en-US", { timeZone: org.timezone, hour: "numeric", minute: "2-digit" })}`).join(", ")}.
              <input type="hidden" name="force" value={`${sp.date} ${sp.time} ${sp.minutes}`} /> Submit again to book it anyway, or change the time (a new time is checked again).
            </div>
          )}
          <div className="row">
            <div><label htmlFor="iv-date">Date</label><input id="iv-date" name="date" type="date" min={today(org.timezone)} defaultValue={sp.date} required /></div>
            <div><label htmlFor="iv-time">Time ({org.timezone.replace(/_/g, " ")})</label><input id="iv-time" name="time" type="time" defaultValue={sp.time ?? "10:00"} required /></div>
            <div><label htmlFor="iv-min">Length</label><select id="iv-min" name="minutes" defaultValue={sp.minutes ?? "45"}>{[30, 45, 60, 90].map((m) => <option key={m} value={m}>{m} min</option>)}</select></div>
          </div>
          <div className="field" style={{ marginTop: 8 }}><label htmlFor="iv-who">Other interviewers (emails, optional)</label><input id="iv-who" name="interviewers" defaultValue={sp.interviewers} placeholder="lee@yourco.com, sam@yourco.com" /></div>
          <div className="field"><label htmlFor="iv-note">Note in the invitation (optional)</label><input id="iv-note" name="note" placeholder="45-minute technical conversation with the backend team" /></div>
          <label className="choice-row"><input type="checkbox" name="meet" defaultChecked={sp.meet !== "0"} /> Add a Google Meet link</label>
          <button type="submit" style={{ marginTop: 6 }}>{busy.length ? "Book anyway" : "Check my calendar and send the invitation"}</button>
          <p className="small muted" style={{ margin: "6px 0 0" }}>Booking doesn&apos;t change the stage; that stays your decision above.</p>
        </form>
      ))}
    </div>
  );
}

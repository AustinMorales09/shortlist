import Link from "next/link";
import IntegrationCard from "@/components/IntegrationCard";
import { myOrg } from "@/lib/access";
import { db } from "@/lib/db";
import { connectProvider, reloadGreenhouseJobs, saveJobLink, simApplication } from "@/lib/integration-actions";
import { GCAL, GH } from "@/lib/integrations";
import { getConn, settingsOf } from "@/lib/integrations/core";
import { gcal } from "@/lib/integrations/gcal";
import { greenhouse, type GhSettings } from "@/lib/integrations/greenhouse";
import { simEvents } from "@/lib/integrations/sim-gcal";
import { simNotes } from "@/lib/integrations/sim-greenhouse";

export const dynamic = "force-dynamic";

export default async function IntegrationsPage({ searchParams }: { searchParams: Promise<{ error?: string; done?: string }> }) {
  const org = await myOrg();
  const sp = await searchParams;
  const gh = getConn(org.id, GH);
  const cal = getConn(org.id, GCAL);
  const s = gh ? settingsOf<GhSettings>(gh) : null;
  const jobs = db.prepare("SELECT id, title FROM jobs WHERE org_id = ? ORDER BY id DESC").all(org.id) as { id: number; title: string }[];
  const describe = (kind: string, ref: string) => {
    if (kind === "import") return <>Import applications for Greenhouse job {s?.jobs.find((j) => String(j.id) === ref)?.name ?? ref}</>;
    if (kind === "note") {
      const id = Number(ref.split(":")[0]);
      return <>Decision note for <Link href={`/applicants/${id}`}>applicant #{id}</Link></>;
    }
    return `${kind} ${ref}`;
  };

  const ghLive = (
    <form action={connectProvider} className="row" style={{ alignItems: "flex-end" }}>
      <input type="hidden" name="provider" value={GH} />
      <input type="hidden" name="mode" value="live" />
      <div><label htmlFor="client_id">Harvest v3 client ID</label><input id="client_id" name="client_id" autoComplete="off" required /></div>
      <div><label htmlFor="client_secret">Client secret</label><input id="client_secret" name="client_secret" type="password" autoComplete="off" required /></div>
      <div><label htmlFor="user_id">Act as user ID <span className="muted">(optional)</span></label><input id="user_id" name="user_id" inputMode="numeric" style={{ width: 130 }} /></div>
      <button type="submit">Connect Greenhouse</button>
    </form>
  );

  return (
    <main className="container" style={{ maxWidth: 1000 }}>
      <h1>Integrations</h1>
      <p className="muted" style={{ marginTop: 0 }}>Bring applications in from your applicant tracking system, and book interviews on your calendar. People still make every decision.</p>
      {sp.error && <p className="error card">{sp.error}</p>}
      {process.env.VERCEL === "1" && <p className="card small" style={{ borderStyle: "dashed" }}><strong>About this hosted demo:</strong> it runs on several servers that each keep their own copy of the data, so a connection or sync you just made may not appear on the next page you load. Run the app locally for the full walkthrough; the integration code is the same.</p>}
      {sp.done && <p className="ok-text small">{sp.done}</p>}

      <IntegrationCard p={greenhouse} c={gh} ownerId={org.id} describeJob={describe} liveConnect={ghLive}>
        {gh && s && (
          <>
            <p className="small muted" style={{ margin: "0 0 8px" }}>
              Uses Harvest API v3 with OAuth client credentials (create them in Greenhouse under Configure → Dev Center → API Credential Management, as &quot;Harvest V3 (OAuth)&quot;).
              The credentials need to list jobs, applications, candidates and attachments, and create notes. Make sure your Greenhouse application form tells candidates that software assists the review.
            </p>
            <div className="table-wrap">
              <table className="list">
                <thead><tr className="small muted"><th>Open Greenhouse job</th><th>Imports into</th><th>Compare resumes</th><th>Imported</th><th></th></tr></thead>
                <tbody>
                  {s.jobs.map((j) => {
                    const l = s.links[j.id];
                    return (
                      <tr key={j.id}>
                        <td className="small"><strong>{j.name}</strong> <span className="muted">#{j.id}</span></td>
                        <td colSpan={4}>
                          <form action={saveJobLink} className="row" style={{ alignItems: "center", margin: 0 }}>
                            <input type="hidden" name="gh_job_id" value={j.id} />
                            <input type="hidden" name="gh_job_name" value={j.name} />
                            <select name="job_id" defaultValue={l ? String(l.jobId) : ""} aria-label={`Shortlist job for ${j.name}`}>
                              <option value="">(not imported)</option>
                              <option value="new">A new Shortlist job: “{j.name}”</option>
                              {jobs.map((x) => <option key={x.id} value={x.id}>{x.title} (#{x.id})</option>)}
                            </select>
                            <label className="choice-row small" style={{ margin: 0 }}><input type="checkbox" name="assess" defaultChecked={l ? l.assess : true} /> compare</label>
                            <span className="small muted">{l ? `${l.imported} so far` : ""}</span>
                            <button type="submit" className="secondary">Save</button>
                            {l && gh.mode === "sandbox" && <button type="submit" formAction={simApplication} className="link small">simulate a new application</button>}
                          </form>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <form action={reloadGreenhouseJobs}><button type="submit" className="link small">Reload the job list</button></form>
            <p className="small muted" style={{ margin: "6px 0 0" }}>
              Each import brings in applications created since the last one (with an hour of overlap; nothing is imported twice). Prospects who didn&apos;t apply are skipped. Someone who applied both here and in Greenhouse is linked, not duplicated.
              When you move an imported applicant to another stage, a private note with the decision and reason is added to the candidate in Greenhouse.
            </p>
            {gh.mode === "sandbox" && <GhNotes ownerId={org.id} />}
          </>
        )}
      </IntegrationCard>

      <IntegrationCard p={gcal} c={cal} ownerId={org.id}>
        {cal && (
          <>
            <p className="small muted" style={{ margin: "0 0 6px" }}>
              Schedule from any applicant&apos;s page (identity must be revealed for blind-review jobs). The slot is checked against your calendar first; the invitation goes to the candidate and any interviewers you add, with a Google Meet link.
            </p>
            {cal.mode === "sandbox" && <CalEvents ownerId={org.id} tz={org.timezone} />}
          </>
        )}
      </IntegrationCard>
    </main>
  );
}

function GhNotes({ ownerId }: { ownerId: number }) {
  const notes = simNotes(ownerId).slice(-5).reverse();
  if (!notes.length) return <p className="small muted" style={{ marginTop: 8 }}>The simulated Greenhouse has no notes from Shortlist yet. Move an imported applicant to another stage to send one.</p>;
  return (
    <details open style={{ marginTop: 8 }}>
      <summary className="small"><strong>Notes the simulated Greenhouse received</strong></summary>
      <ul className="small" style={{ paddingLeft: 18, margin: "4px 0 0" }}>{notes.map((n) => <li key={n.id}>Candidate {n.candidate_id} ({n.visibility}): {n.body}</li>)}</ul>
    </details>
  );
}

function CalEvents({ ownerId, tz }: { ownerId: number; tz: string }) {
  const events = simEvents(ownerId).slice(-5).reverse();
  if (!events.length) return <p className="small muted">The simulated calendar has no interviews yet. It&apos;s busy every weekday 12:00–13:00, so you can see the conflict check.</p>;
  return (
    <details open>
      <summary className="small"><strong>What the simulated calendar holds</strong></summary>
      <ul className="small" style={{ paddingLeft: 18, margin: "4px 0 0" }}>
        {events.map((e) => <li key={e.id} style={e.status === "cancelled" ? { textDecoration: "line-through" } : undefined}>{e.summary} · {new Date(e.startMs).toLocaleString("en-US", { timeZone: tz, dateStyle: "medium", timeStyle: "short" })} · {e.attendees.length} invited{e.hangoutLink ? " · Meet link" : ""}{e.status === "cancelled" ? " (cancelled)" : ""}</li>)}
      </ul>
    </details>
  );
}

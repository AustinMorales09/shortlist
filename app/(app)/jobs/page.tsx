import Link from "next/link";
import { myOrg } from "@/lib/access";
import { loadDemo } from "@/lib/actions";
import { db } from "@/lib/db";
import { aiStatus } from "@/lib/process";

export default async function Jobs({ searchParams }: { searchParams: Promise<{ welcome?: string }> }) {
  const org = await myOrg();
  const sp = await searchParams;
  const rows = db.prepare(
    `SELECT j.id, j.title, j.location, j.status, j.blind,
       (SELECT COUNT(*) FROM applicants a WHERE a.job_id = j.id) AS total,
       (SELECT COUNT(*) FROM applicants a WHERE a.job_id = j.id AND a.stage = 'new') AS fresh
     FROM jobs j WHERE j.org_id = ? ORDER BY j.status, j.id DESC`,
  ).all(org.id) as { id: number; title: string; location: string; status: string; blind: number; total: number; fresh: number }[];
  const ai = aiStatus(org);
  return (
    <main className="container">
      <h1 style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>Jobs <Link className="small" href="/jobs/new">+ New job</Link></h1>
      {sp.welcome && rows.length === 0 && <p className="ok-text card">Welcome! Load the sample job to see how applications are compared, or create your own.</p>}
      <p className="small muted" style={{ marginTop: 0 }}>
        Comparison: {ai.mode === "claude" ? <span className="status-ok">Claude reads each resume against your criteria</span> : <><span className="status-warn">keyword matching only</span> ({ai.reason}; set ANTHROPIC_API_KEY for a real reading)</>}. Either way, people make every decision.
      </p>
      <div className="card table-wrap">
        {rows.length === 0 ? <p className="small muted" style={{ margin: 0 }}>No jobs yet.</p> : (
          <table className="list">
            <thead><tr><th>Job</th><th>Applications</th><th>Review</th><th>Status</th></tr></thead>
            <tbody>
              {rows.map((j) => (
                <tr key={j.id}>
                  <td><Link href={`/jobs/${j.id}`}><strong>{j.title}</strong></Link><div className="small muted">{j.location}</div></td>
                  <td>{j.total}{j.fresh ? <span className="pill-warn" style={{ marginLeft: 6 }}>{j.fresh} new</span> : null}</td>
                  <td className="small">{j.blind ? "blind (identity hidden)" : "names visible"}</td>
                  <td><span className={j.status === "open" ? "pill-ok" : "pill-muted"}>{j.status}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <form action={loadDemo}><button className="secondary">Load a sample job with 4 applications</button></form>
    </main>
  );
}

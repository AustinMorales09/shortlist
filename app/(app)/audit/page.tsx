import Link from "next/link";
import { myOrg } from "@/lib/access";
import { db } from "@/lib/db";
import { fmtStamp } from "@/lib/time";

export default async function Audit() {
  const org = await myOrg();
  const rows = db.prepare(
    "SELECT e.*, j.title AS jtitle FROM events e LEFT JOIN jobs j ON j.id = e.job_id WHERE e.org_id = ? ORDER BY e.id DESC LIMIT 300",
  ).all(org.id) as { id: number; applicant_id: number | null; actor: string; action: string; detail: string; created_at: number; jtitle: string | null }[];
  return (
    <main className="container">
      <h1 style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>Audit log <a className="small" href="/audit/export">Export decisions (CSV)</a></h1>
      <p className="muted" style={{ marginTop: 0 }}>
        Everything the system, the AI and your team did to each application. The CSV has one row per application with what was compared, the stage, and
        the recorded reason, without names or contact details, so it can be given to an auditor. If your jurisdiction requires a bias audit or
        candidate notice for automated hiring tools (for example New York City Local Law 144), this is the data it starts from.
      </p>
      <div className="card table-wrap">
        {rows.length === 0 && <p className="small muted" style={{ margin: 0 }}>Nothing yet.</p>}
        <table className="list"><tbody>
          {rows.map((e) => (
            <tr key={e.id}>
              <td className="small muted" style={{ whiteSpace: "nowrap" }}>{fmtStamp(e.created_at, org.timezone)}</td>
              <td className="small">{e.actor}</td>
              <td className="small">{e.action}{e.detail ? <span className="muted"> · {e.detail}</span> : null}</td>
              <td className="small">{e.jtitle}{e.applicant_id ? <> · <Link href={`/applicants/${e.applicant_id}`}>application #{e.applicant_id}</Link></> : null}</td>
            </tr>
          ))}
        </tbody></table>
      </div>
    </main>
  );
}

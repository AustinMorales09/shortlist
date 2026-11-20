import Link from "next/link";
import { myOrg } from "@/lib/access";
import { db } from "@/lib/db";
import { fmtStamp } from "@/lib/time";

export default async function Outbox() {
  const org = await myOrg();
  const rows = db.prepare("SELECT * FROM emails WHERE org_id = ? ORDER BY id DESC LIMIT 100").all(org.id) as {
    id: number; applicant_id: number | null; recipient: string; subject: string; body: string; status: string; error: string | null; created_at: number;
  }[];
  return (
    <main className="container">
      <h1>Sent email</h1>
      {!process.env.RESEND_API_KEY && <p className="small muted">No email provider is configured, so emails are kept here (status &quot;outbox&quot;) instead of being delivered. Set RESEND_API_KEY and EMAIL_FROM to send them.</p>}
      <div className="card table-wrap">
        {rows.length === 0 && <p className="small muted" style={{ margin: 0 }}>Nothing sent yet.</p>}
        <table className="list"><tbody>
          {rows.map((m) => (
            <tr key={m.id}>
              <td className="small" style={{ whiteSpace: "nowrap", verticalAlign: "top" }}>{fmtStamp(m.created_at, org.timezone)}</td>
              <td className="small" style={{ verticalAlign: "top" }}>{m.recipient}</td>
              <td><strong className="small">{m.applicant_id ? <Link href={`/applicants/${m.applicant_id}`}>{m.subject}</Link> : m.subject}</strong><div className="small" style={{ whiteSpace: "pre-wrap" }}>{m.body}</div>{m.error && <div className="small status-err">{m.error}</div>}</td>
              <td className={`small ${m.status === "failed" ? "status-err" : m.status === "sent" ? "status-ok" : "muted"}`}>{m.status}</td>
            </tr>
          ))}
        </tbody></table>
      </div>
    </main>
  );
}

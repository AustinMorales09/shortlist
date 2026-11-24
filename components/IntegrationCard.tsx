import { connectProvider, disconnectProvider, expireSandboxToken, retryFailedJobs, syncNow } from "@/lib/integration-actions";
import { recentJobs, recentLog, type Conn } from "@/lib/integrations/core";
import { liveReady, missingEnv, type Provider } from "@/lib/integrations/provider";

const ago = (ms: number) => {
  const s = Math.round((Date.now() - ms) / 1000);
  return s < 60 ? "just now" : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
};
const JOB_PILL: Record<string, string> = { queued: "pill pill-warn", running: "pill pill-warn", done: "pill pill-ok", failed: "pill pill-err" };

/** Status, connect/disconnect, the recent jobs and the log for one provider. Provider-specific settings go in children. */
export default function IntegrationCard({ p, c, ownerId, describeJob, liveConnect, children }: {
  p: Provider; c: Conn | undefined; ownerId: number; describeJob?: (kind: string, ref: string) => React.ReactNode;
  /** Replaces the "Connect" button (providers connected with API credentials show a form). */
  liveConnect?: React.ReactNode; children?: React.ReactNode;
}) {
  const live = liveReady(p);
  const hidden = (name: string, value: string) => <input type="hidden" name={name} value={value} />;
  const jobs = c ? recentJobs(ownerId, p.id, 8) : [];
  const logs = recentLog(ownerId, p.id, 8);
  const failed = jobs.filter((j) => j.status === "failed").length;
  return (
    <section className="card" id={p.id} style={{ scrollMarginTop: 80 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline", flexWrap: "wrap" }}>
        <h2 style={{ margin: 0 }}>{p.name}</h2>
        {c ? (
          <span>
            <span className={c.status === "connected" ? "pill pill-ok" : "pill pill-err"}>{c.status === "connected" ? "connected" : c.status === "reauth" ? "reconnect needed" : "error"}</span>{" "}
            <span className="pill pill-muted">{c.mode === "sandbox" ? "simulator" : "live"}</span>
          </span>
        ) : <span className="pill pill-muted">not connected</span>}
      </div>
      <p className="small muted" style={{ margin: "6px 0 10px" }}>{p.blurb}</p>

      {!c && (
        <div className="row" style={{ alignItems: "center" }}>
          {liveConnect ?? <form action={connectProvider}>{hidden("provider", p.id)}{hidden("mode", "live")}<button type="submit" disabled={!live}>Connect {p.name.split(" (")[0]}</button></form>}
          <form action={connectProvider}>{hidden("provider", p.id)}{hidden("mode", "sandbox")}<button type="submit" className="secondary">Try it with the simulator</button></form>
          {!live && !liveConnect && <span className="small muted">Live needs {missingEnv(p).map((k, i) => <span key={k}>{i ? ", " : ""}<code>{k}</code></span>)} on the server.</span>}
        </div>
      )}

      {c && (
        <>
          <p className="small" style={{ margin: "0 0 8px" }}>
            Account: <strong>{c.account || "—"}</strong>{c.last_error ? <span className="status-warn"> · {c.last_error}</span> : null}
          </p>
          {c.mode === "sandbox" && (
            <p className="small muted" style={{ margin: "0 0 8px" }}>
              Simulator mode: the same integration code runs against a built-in copy of {p.name.split(" (")[0]}&apos;s API, with its request formats, validation and errors.
              Every 6th call is answered with a rate-limit error (429) so you can see the retries in the log.
            </p>
          )}
          {children}
          <div className="row" style={{ marginTop: 10 }}>
            <form action={syncNow}>{hidden("provider", p.id)}<button type="submit" className="secondary">Run queued jobs</button></form>
            {failed > 0 && <form action={retryFailedJobs}>{hidden("provider", p.id)}<button type="submit" className="secondary">Retry {failed} failed</button></form>}
            {c.status === "reauth" && p.authorizeUrl && <form action={connectProvider}>{hidden("provider", p.id)}{hidden("mode", c.mode)}<button type="submit">Reconnect</button></form>}
            {c.mode === "sandbox" && <form action={expireSandboxToken}>{hidden("provider", p.id)}<button type="submit" className="link">Expire the access token</button></form>}
            <form action={disconnectProvider}>{hidden("provider", p.id)}<button type="submit" className="link" style={{ color: "var(--err)" }}>Disconnect</button></form>
          </div>

          <h3 className="small" style={{ margin: "14px 0 4px" }}>Recent jobs</h3>
          {jobs.length === 0 ? <p className="small muted" style={{ margin: 0 }}>Nothing sent yet.</p> : (
            <div className="table-wrap">
              <table className="list">
                <tbody>
                  {jobs.map((j) => (
                    <tr key={j.id}>
                      <td className="small">{describeJob ? describeJob(j.kind, j.ref) : `${j.kind} ${j.ref}`}</td>
                      <td><span className={JOB_PILL[j.status]}>{j.status}</span>{j.attempts > 1 ? <span className="small muted"> · {j.attempts} tries</span> : null}</td>
                      <td className="small" style={{ maxWidth: 420 }}>{j.status === "failed" || j.status === "queued" ? <span className={j.status === "failed" ? "status-err" : "muted"}>{j.last_error ?? "waiting"}</span> : <span className="muted">{j.result}</span>}</td>
                      <td className="small muted" style={{ whiteSpace: "nowrap" }}>{ago(j.updated_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {logs.length > 0 && (
        <details style={{ marginTop: 10 }}>
          <summary className="small">Log</summary>
          <ul className="small" style={{ paddingLeft: 18, margin: "6px 0 0" }}>
            {logs.map((l) => <li key={l.id} className={l.level === "error" ? "status-err" : l.level === "warn" ? "status-warn" : undefined}>{l.message} <span className="muted">· {ago(l.created_at)}</span></li>)}
          </ul>
        </details>
      )}
    </section>
  );
}

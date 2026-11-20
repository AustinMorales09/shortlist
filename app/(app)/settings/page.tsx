import { myOrg } from "@/lib/access";
import { saveSettings } from "@/lib/actions";
import { MODEL } from "@/lib/claude";
import { aiStatus } from "@/lib/process";
import TimezoneSelect from "@/components/TimezoneSelect";

export default async function Settings({ searchParams }: { searchParams: Promise<{ error?: string; saved?: string }> }) {
  const org = await myOrg();
  const sp = await searchParams;
  const ai = aiStatus(org);
  return (
    <main className="container narrow">
      <div className="card">
        <h1>Settings</h1>
        {sp.error && <p className="error">{sp.error}</p>}
        {sp.saved && <p className="ok-text small">Saved.</p>}
        <form action={saveSettings} key={`${org.name}${org.timezone}${org.ai_enabled}`}>
          <div className="field"><label htmlFor="name">Company name (shown to applicants)</label><input id="name" name="name" defaultValue={org.name} required /></div>
          <div className="field"><label htmlFor="timezone">Time zone</label><TimezoneSelect value={org.timezone} /></div>
          <label className="choice-row"><input type="checkbox" name="ai_enabled" defaultChecked={!!org.ai_enabled} /> Use Claude to compare resumes with each job&apos;s criteria</label>
          <p className="small muted" style={{ margin: "4px 0 8px" }}>
            Right now: {ai.mode === "claude" ? <>Claude (<code>{MODEL}</code>). Resume text is sent to Anthropic&apos;s API; for blind-review jobs only the redacted text is sent.</> : <>keyword matching only. {ai.reason}.</>}
          </p>
          <button type="submit">Save</button>
        </form>
      </div>
      <div className="card">
        <h2>How this tool is meant to be used</h2>
        <ul className="small" style={{ paddingLeft: 18, margin: 0 }}>
          <li>It compares resumes with the criteria you wrote and shows the evidence. It does not score, rank, recommend or reject.</li>
          <li>Applicants are told on the form that software assists the review, and can ask for a human-only review.</li>
          <li>Every stage change is made by a person, and declining someone requires a recorded, job-related reason.</li>
          <li>Hiring law varies by place. Some jurisdictions require notices, bias audits or impact assessments for tools like this. Check what applies to you before relying on it.</li>
        </ul>
      </div>
    </main>
  );
}

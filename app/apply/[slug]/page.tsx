import { apply } from "@/lib/actions";
import { db, type JobRow, type Org, type Question } from "@/lib/db";
import { aiStatus } from "@/lib/process";

export const metadata = { title: "Apply", robots: { index: false } };

export default async function ApplyPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ error?: string }> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const job = db.prepare("SELECT * FROM jobs WHERE slug = ?").get(slug) as JobRow | undefined;
  if (!job || job.status !== "open") {
    return <main className="container narrow"><div className="card" style={{ textAlign: "center", marginTop: 48 }}><h1>This position isn&apos;t accepting applications</h1><p className="muted">It may have been filled or closed.</p></div></main>;
  }
  const org = db.prepare("SELECT * FROM orgs WHERE id = ?").get(job.org_id) as Org;
  const questions = JSON.parse(job.questions) as Question[];
  const usesAi = aiStatus(org).mode === "claude";

  return (
    <main className="container" style={{ maxWidth: 680 }}>
      <p className="small muted" style={{ margin: "16px 0 0" }}>{org.name}</p>
      <h1 style={{ margin: "4px 0" }}>{job.title}</h1>
      {job.location && <p className="muted" style={{ marginTop: 0 }}>{job.location}</p>}
      {job.description && <p style={{ whiteSpace: "pre-wrap" }}>{job.description}</p>}
      {sp.error && <p className="error card">{sp.error}</p>}

      <form action={apply} className="card">
        <input type="hidden" name="slug" value={job.slug} />
        {/* Honeypot: hidden from people, filled in by bots. */}
        <div style={{ position: "absolute", left: -9999 }} aria-hidden="true"><label>Website<input name="website" tabIndex={-1} autoComplete="off" /></label></div>
        <div className="row">
          <div className="grow"><label htmlFor="name">Full name</label><input id="name" name="name" required autoComplete="name" /></div>
          <div className="grow"><label htmlFor="email">Email</label><input id="email" name="email" type="email" required autoComplete="email" /></div>
        </div>
        <div className="field" style={{ marginTop: 8 }}><label htmlFor="phone">Phone (optional)</label><input id="phone" name="phone" type="tel" autoComplete="tel" /></div>
        <div className="field"><label htmlFor="resume">Resume (PDF or .txt, up to 5 MB)</label><input id="resume" name="resume" type="file" accept=".pdf,.txt,.md" /></div>
        <div className="field"><label htmlFor="rt">…or paste your resume</label><textarea id="rt" name="resume_text" rows={6} /></div>
        {questions.map((q) => (
          <div key={q.id} className="field">
            <label htmlFor={`a_${q.id}`}>{q.text}</label>
            {q.type === "yesno"
              ? <select id={`a_${q.id}`} name={`a_${q.id}`} required defaultValue=""><option value="" disabled>Choose…</option><option value="yes">Yes</option><option value="no">No</option></select>
              : <textarea id={`a_${q.id}`} name={`a_${q.id}`} rows={3} required />}
          </div>
        ))}

        <div className="notice">
          <strong>How your application is reviewed</strong>
          <p style={{ margin: "6px 0" }}>
            People at {org.name} read and decide on every application. To help them, software {usesAi ? "(an AI model) " : ""}compares your resume with the job&apos;s
            stated requirements and highlights the relevant parts. It does not score, rank or reject anyone.{job.blind ? " Your name and contact details are hidden from reviewers during the first review." : ""}
          </p>
          <label className="choice-row" style={{ margin: "4px 0" }}><input type="checkbox" name="optout" /> I&apos;d prefer a person to review my application without the software comparison</label>
          <label className="choice-row" style={{ margin: "4px 0" }}><input type="checkbox" name="consent" required /> I&apos;ve read this and want to submit my application</label>
        </div>
        <button type="submit" className="big-btn" style={{ marginTop: 12 }}>Submit application</button>
        <p className="small muted" style={{ marginBottom: 0 }}>Choosing a person-only review doesn&apos;t affect your chances. You can ask {org.name} to delete your application at any time.</p>
      </form>
    </main>
  );
}

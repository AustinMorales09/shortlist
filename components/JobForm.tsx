import { saveJob } from "@/lib/actions";
import type { Criterion, JobRow, Question } from "@/lib/db";
import { questionLines } from "@/lib/screen";

export default function JobForm({ job }: { job?: JobRow }) {
  const criteria = job ? (JSON.parse(job.criteria) as Criterion[]) : [];
  const lines = (kind: Criterion["kind"]) => criteria.filter((c) => c.kind === kind).map((c) => c.text).join("\n");
  return (
    <form action={saveJob} className="card" key={job ? `${job.criteria}${job.questions}${job.title}${job.blind}` : "new"}>
      {job && <input type="hidden" name="job_id" value={job.id} />}
      <div className="row">
        <div className="grow"><label htmlFor="title">Job title</label><input id="title" name="title" defaultValue={job?.title} required placeholder="Senior Backend Engineer" /></div>
        <div className="grow"><label htmlFor="loc">Location</label><input id="loc" name="location" defaultValue={job?.location} placeholder="Remote (US)" /></div>
      </div>
      <div className="field" style={{ marginTop: 8 }}><label htmlFor="desc">Description (shown to applicants)</label><textarea id="desc" name="description" rows={4} defaultValue={job?.description} /></div>

      <h3 style={{ margin: "14px 0 4px" }}>Criteria</h3>
      <p className="small muted" style={{ marginTop: 0 }}>
        One per line. Applications are compared against exactly these, so make each one specific and tied to doing the job
        (&quot;3+ years building REST APIs&quot;, not &quot;rockstar&quot; or &quot;culture fit&quot;). Don&apos;t list anything about who a person is:
        age, native language, &quot;recent graduate&quot;, and similar wording can be discriminatory.
      </p>
      <div className="grid-2">
        <div className="field"><label htmlFor="must">Must-haves</label><textarea id="must" name="must" rows={5} defaultValue={lines("must")} required placeholder={"5+ years of backend development in Python\nExperience with PostgreSQL"} /></div>
        <div className="field"><label htmlFor="nice">Nice-to-haves</label><textarea id="nice" name="nice" rows={5} defaultValue={lines("nice")} placeholder={"Kubernetes experience"} /></div>
      </div>

      <div className="field">
        <label htmlFor="qs">Application questions, one per line: <code>Question | yesno | expect yes</code> or <code>Question | text</code></label>
        <textarea id="qs" name="questions" rows={3} defaultValue={job ? questionLines(JSON.parse(job.questions) as Question[]) : ""} placeholder={"Are you legally authorized to work in the United States? | yesno | expect yes"} />
        <p className="small muted" style={{ margin: "4px 0 0" }}>An unexpected answer is shown to the reviewer as a flag. It never rejects anyone automatically.</p>
      </div>
      <label className="choice-row"><input type="checkbox" name="blind" defaultChecked={job ? !!job.blind : true} /> Blind review: hide names, contact details and personal details from reviewers and from the AI until you choose to reveal them</label>
      <button type="submit" style={{ marginTop: 10 }}>{job ? "Save job" : "Create job"}</button>
      {job && <p className="small muted" style={{ marginBottom: 0 }}>Changing the criteria re-compares every application against the new list, so everyone is measured the same way.</p>}
    </form>
  );
}

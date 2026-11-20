# 22 · Shortlist: applicant screening

**Live demo:** https://shortlist-demo-seven.vercel.app/demo (signs you in to a shared demo account that resets itself)

For small companies and recruiters who get more applications than they can read carefully. You write down what the job actually requires. Shortlist compares every resume with those criteria and shows the exact lines that back each one up, with names and personal details hidden. **It never scores, ranks, recommends or rejects anyone.** People make every decision, and every decision is on record.

## Why it's built this way

Automated hiring tools are a known source of discrimination, and they are regulated:

- **New York City Local Law 144** requires bias audits and candidate notices for automated employment decision tools.
- **US EEOC guidance** says employers are liable for discriminatory outcomes from AI hiring tools.
- **The EU AI Act** classes recruitment AI as high-risk.

So, like #9 (where review gating was left out), the product is built to stay on the right side of these rules rather than maximize automation:

| Risk | What Shortlist does |
|---|---|
| A model ranking people | No score, rank, fit label or recommendation exists anywhere: not in the prompt, not in the output schema, not in the UI. The output is per-criterion: shown / partly shown / not shown, plus a quote. |
| Auto-rejection | The software never changes an applicant's stage. Only a person can, and declining someone requires a recorded, job-related reason. Answers to knock-out questions are shown as flags, never acted on. |
| Bias from identity | **Blind review** (on by default) removes the name, contact details, links, street address, and lines stating age, gender, marital status, nationality and similar, before a reviewer *or the model* sees the resume. The original file can't be downloaded until a reviewer deliberately reveals identity, and that is logged. |
| Bias inside the model's reading | The prompt forbids considering or inferring protected characteristics or their proxies, penalizing employment gaps or non-traditional paths, and judging style or prestige. It also says "not shown" means the resume doesn't mention it, not that the person lacks it. |
| Made-up evidence | Every quote is checked against the resume. A "met" whose quote isn't found is downgraded to "partly" and flagged, so it can't count. |
| Vague or discriminatory criteria | The job form asks for specific, job-related criteria and warns against wording such as age, native language or "recent graduate". Changing the criteria re-compares **every** applicant, so everyone is measured the same way. |
| Candidates not knowing | The application form says software assists the review, says whether names are hidden, and offers a **human-only review** checkbox. Opted-out applications are never sent to any automated comparison. |
| Accountability | An append-only audit log records each application, comparison, stage change with its reason, identity reveal and deletion. A CSV export with no names or contact details is ready for an auditor. Applicants can be deleted on request; the log keeps only that a deletion happened. |

This is still not legal advice. The Settings page tells employers to check what applies to them, because some places require a formal bias audit before using any tool like this.

## Run

```bash
npm install
npm run dev
```

Open http://localhost:3022, sign up, and click **Load a sample job with 4 applications**. Set `ANTHROPIC_API_KEY` for Claude's reading; without it, keyword matching is used and labelled as such. `SCREEN_AI=off` forces keyword matching.

## How the comparison works

**With Claude** (`lib/claude.ts`): one structured-output call per application, `claude-opus-5-5`, via `client.beta.messages.parse`.

- **Schema:** the criterion `id` is an enum of the job's own criteria. There is no field for a score or recommendation.
- **What's sent:** blind jobs send only the redacted text. The resume is wrapped in `<resume>` tags as untrusted data, so "ignore the criteria" inside a resume is just text.
- **Other settings:** a static, cached system prompt; `fallbacks: "default"`.
- **Output:** the per-criterion status with a quote and a one-line note, a neutral two- or three-sentence summary of relevant experience, and up to four interview questions about unclear criteria.

**Without Claude** (`lib/screen.ts`): keyword matching reports only "mentioned" (with the best-matching resume line) or "no keyword match". It never reports "met", because a keyword match can't confirm a requirement. It misses the same experience described in other words, and the UI says so.

## Pages

- **Jobs:** criteria (must-have / nice-to-have), yes/no and text questions with optional expected answers, blind on/off, a private application link, and open/close.
- **Job:** applications by stage, with must-haves shown / partly / not shown counts and answer flags. The default order is date applied. A "must-haves shown" order is available but labelled as counts, not a score.
- **Applicant:** the (redacted) resume beside the criterion-by-criterion reading with quotes, their answers, the decision form (stage plus required reason, and an optional polite email), reveal identity, history, and delete.
- **Audit log:** every event, plus the CSV export.
- **Public apply page:** resume upload (PDF/.txt, type checked by content) or paste, questions, the AI disclosure, a human-only option, required consent, a honeypot against bots, and one application per email per job.

## Verified

- **Unit tests** (12 checks):
  - **Redaction:** name, email, phone, links, address, date of birth, nationality and pronouns are removed; job content and the career-break line are kept.
  - **Job setup:** criteria ids are stable across reordering, duplicates are dropped, and question parsing gives clear errors.
  - **Keyword fallback:** never reports "met".
  - **Stage safety:** the stage is never changed by a comparison, and human-only applicants are never sent to anything.
  - **Claude path, mocked client:**
    - Only redacted text is sent, with no name, email, phone, birth year or nationality.
    - The injection text stays inside the resume tags.
    - The prompt contains the safeguards, and the output schema has no score or rank field.
    - An invented quote is downgraded from "met"; missing criteria are filled in.
    - A non-blind job sends the full text.
    - A refusal falls back to keyword matching.
  - **Real SDK with no credentials:** detected.
  - **Deleted ids:** a deleted application's id is never reused.
- **Browser, end to end, in keyword mode** (no API key on the build machine):
  - **Sample job:** 4 applications, including one human-only.
  - **Blind view:** no identifying text anywhere on the page.
  - **Knock-out answer:** flagged, not acted on.
  - **Rejecting:** blocked without a reason, then recorded with one and the email sent.
  - **Reveal:** shortlisting then revealing identity showed the full resume, and it was logged.
  - **Public form:** blocked without consent, accepted with it, and a duplicate email refused.
  - **Editing criteria:** re-compared everyone except the human-only applicant.
  - **Audit CSV:** contains no names.
  - **Original PDF:** download refused (403) during blind review.
  - **Delete:** erased the data.
  - **Access:** without login, pages redirect and the export returns 401.
  - **Checks:** no horizontal scroll at phone width, no server errors, and `next build` passes.
- **Not verified:** a live Claude call. The prompt's safeguards and output are only checked structurally (with a mocked client), not against the real model's behaviour. Before real use, the first runs should be reviewed, and ideally a bias audit run on real outcomes.

## Stack

Next.js 16 · `node:sqlite` · `@anthropic-ai/sdk` + `zod` · plain CSS.

## Next steps toward a paid product

- Adverse-impact reporting by stage (the four-fifths rule) using voluntary, separately stored demographic self-identification, which never reaches reviewers or the model
- Structured interview kits generated from the criteria, with per-criterion interviewer scorecards
- Multiple reviewers with independent first reads before discussion, and identity-reveal permissions by role
- ATS integrations (Greenhouse, Lever, Workable) and job-board posting
- Retention schedules for automatic deletion of declined applications, configurable per jurisdiction

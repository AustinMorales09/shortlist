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

## Integrations: Greenhouse and Google Calendar

**Integrations** in the nav connects them, live or with the simulator.

- **Greenhouse Recruiting** (`lib/integrations/greenhouse.ts`): Harvest API **v3** (v1/v2 were retired at the end of August 2026), with OAuth **client credentials** created in Greenhouse and pasted in, plus an optional "act as" user.
  - **Linking:** link each Greenhouse job to a Shortlist job (an existing one, or a new one with the same title).
  - **Importing:** applications created since the last import come in, with candidate details from `/v3/candidates` and the resume from `/v3/attachments`. Imports overlap by an hour, and nothing is imported twice.
  - **Resumes:** the attachment link is short-lived and signed, so it's downloaded at once, never stored, and no API token is sent to the file host. Resumes that aren't PDF or text are noted.
  - **Who's skipped or merged:** prospects (people who never applied) are skipped. Someone who applied both here and in Greenhouse is linked, not duplicated.
  - **Comparison:** each import is compared with the job's criteria (optional per job).
  - **Paging:** follows v3's rules. Filters go on the first request only; every next page is the `Link` URL exactly as given, because a cursor must be the only parameter.
  - **Back to Greenhouse:** when a **person** moves an imported applicant to another stage, a private (`admin_only`) note with the decision and reason goes onto the Greenhouse candidate. Shortlist never changes the stage in Greenhouse.
  - **Retries:** a note isn't idempotent and v3 has no way to look it up afterwards, so a 5xx on it isn't retried automatically (it may have been saved). It's marked failed, with a message to check before retrying.
- **Google Calendar** (`lib/integrations/gcal.ts`, OAuth with PKCE and offline access): schedule from an applicant's page.
  - **Conflict check:** the slot is checked with **free/busy** first. If you're busy, you're asked before booking, and a changed time is checked again.
  - **The event:** it's created on your calendar in your organisation's time zone, with a Google Meet link and invitations to the candidate and any interviewers (`sendUpdates=all`).
  - **No double invites:** the event id is derived from the applicant and the start time, so a repeat gets Google's 409 and reuses the event.
  - **Cancelling:** sends cancellations; an event that's already gone (410) is fine.
  - **Blind review:** for blind-review jobs, the identity must be revealed first, because the invitation goes to the candidate's email.
  - **Audit log:** scheduling and cancelling are recorded there.

| Env var | Effect |
|---|---|
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Live Calendar connection (scopes `calendar.events`, `calendar.freebusy`, `openid email`; redirect URI `<APP_URL>/integrations/gcal/callback`). |
| `INTEGRATIONS_KEY` | Key for sealing stored credentials (otherwise a key file is created in the data folder). |
| `APP_URL` | Public base URL for the OAuth redirect URI. |

Greenhouse needs no server configuration: each customer pastes their own Harvest v3 credentials.

### How the integration layer works (`lib/integrations/core.ts`)

The same small core sits under every provider:

- **Credentials sealed at rest.** Tokens and API secrets are stored with AES-256-GCM, keyed by `INTEGRATIONS_KEY` (or a random key file next to the database). Disconnecting deletes them.
- **OAuth done properly.** The state parameter is single-use, expires after 10 minutes and is bound to the person who started the flow. PKCE is used where the provider supports it.
- **Token refresh.** Tokens refresh shortly before they expire, and once more on a 401. Parallel callers share a single refresh, because providers that rotate refresh tokens lock you out if two refreshes race.
- **Retries that can't duplicate.** A 429 waits for `Retry-After`, and other 5xx errors back off. A POST is retried only when it is idempotent (an idempotency key, upsert or client-chosen id) or when the server said 429. Bad data fails right away with the reason instead of retrying.
- **An outbox.** Work is queued in `integration_jobs`, keyed so the same work collapses into one job, and runs after the response has been sent (Next.js `after`). Pages never wait on a third-party API. Failed jobs show their error and can be retried.
- **Links.** `integration_links` records which remote record each local record became, plus a hash of the values last synced. That is what makes re-syncs no-ops and lets two-way sync tell who changed what.
- **A built-in simulator for every provider** (`lib/integrations/sim-*.ts`). "Try it with the simulator" connects without an account. The integration code is identical in both modes; only the fetch function differs. Each simulator speaks the provider's request and response shapes, validation and error codes. Every 6th call gets a 429 so the retry path runs for real, and "Expire the access token" exercises refresh-on-401.

**Verified** (`npm test` runs `tests/integrations.mjs`, 9 checks, against the simulators):
- **Greenhouse paging:** `Link` headers; `per_page` bounds; a 422 for a cursor combined with other parameters; open jobs only.
- **Greenhouse import:** a PDF and a text resume are read and compared; the prospect is skipped; the `.docx` is noted; a second import adds nothing; a new application is imported; one that matches a form applicant is linked.
- **Greenhouse notes:** a stage change sends an `admin_only` note to the right candidate. A 503 on a note fails without retrying, and doesn't mark the connection broken. A retry by a person after the token expired gets a new token and sends.
- **Calendar:** wall-clock time to UTC across DST; the event-id alphabet; free/busy finds the blocked lunch hour and the booked interview; the booking invites the candidate and interviewer with Meet; a repeat creates no second event; cancelling twice is fine.
- **In the browser, simulator mode:** connected both and linked a Greenhouse job, which imported 3 applications (the PDF resume read and redacted for blind review). Moved one to Interview, which put a note in Greenhouse. Revealed the identity, asked for 12:15 and got "busy 12:00–1:00 PM", changed to 10:00, and booked it with a Meet link and two invitations.

**Not verified:** calls to the real Greenhouse and Google APIs. The Greenhouse v3 details (form-encoded token request, comma-separated id lists, a bare-array list response, which the client also accepts wrapped) follow the published v3 reference and should be confirmed on the first live run. v3 documents no webhook signature yet, so imports are pulled ("Run queued jobs", or after linking) rather than pushed.

## Stack

Next.js 16 · `node:sqlite` · `@anthropic-ai/sdk` + `zod` · Greenhouse Harvest v3 and Google Calendar over plain `fetch` · plain CSS.

## Next steps toward a paid product

- Adverse-impact reporting by stage (the four-fifths rule) using voluntary, separately stored demographic self-identification, which never reaches reviewers or the model
- Structured interview kits generated from the criteria, with per-criterion interviewer scorecards
- Multiple reviewers with independent first reads before discussion, and identity-reveal permissions by role
- More ATSs (Lever, Workable), scheduled imports, and job-board posting
- Outlook / Microsoft 365 calendars alongside Google
- Retention schedules for automatic deletion of declined applications, configurable per jurisdiction

// Deterministic screening pieces: redaction for blind review, criteria/question parsing, evidence checking,
// the keyword fallback, and tallies. None of this makes or suggests a hiring decision.

import crypto from "node:crypto";
import type { Assessed, Criterion, CritStatus, Question } from "./db";

// ---------- blind review ----------

const PERSONAL_LINE = /^\s*(date of birth|d\.?o\.?b\.?|born|age|gender|sex|marital status|married|nationality|citizenship|religion|race|ethnicity|pronouns?|photo|children|family status)\s*[:\-–]/i;
const ADDRESS = /\b\d{1,5}\s+(?:[A-Za-z0-9.'-]+\s){1,4}(?:street|st|avenue|ave|road|rd|boulevard|blvd|lane|ln|drive|dr|court|ct|way|place|pl)\b\.?(?:,?\s*(?:apt|unit|suite|#)\s*\w+)?/gi;

/**
 * Removes details that identify the applicant or hint at protected characteristics, before the resume is shown
 * to a reviewer or sent to the model: name, contact details, links, street address, and lines stating age,
 * gender, marital status, nationality and similar. It's pattern-based, so it reduces exposure rather than
 * guaranteeing anonymity (a resume can still say "captain of the women's rowing team").
 */
export function redact(text: string, who: { name: string; email: string; phone: string }): string {
  let t = text.replace(/\r\n?/g, "\n");
  t = t.split("\n").map((l) => (PERSONAL_LINE.test(l) ? "[personal detail removed]" : l)).join("\n");
  t = t.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]");
  t = t.replace(/\b(?:https?:\/\/|www\.)\S+|\b(?:linkedin|github|twitter|x|instagram|facebook)\.com\/\S+/gi, "[link]");
  t = t.replace(/(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)|\d{2,4})[\s.-]\d{3,4}[\s.-]\d{3,4}\b/g, "[phone]");
  t = t.replace(ADDRESS, "[address]");
  t = t.replace(/\((?:she|he|they|ze|xe)\s*\/\s*(?:her|him|them|hir|xem)(?:\s*\/\s*\w+)?\)/gi, "");
  for (const part of who.name.split(/\s+/).filter((p) => p.replace(/[^A-Za-z]/g, "").length >= 2)) {
    t = t.replace(new RegExp(`\\b${part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"), "[name]");
  }
  return t.replace(/\[name\](?:\s+\[name\])+/g, "[name]").replace(/[ \t]+\n/g, "\n").trim();
}

// ---------- job setup ----------

const cid = (text: string) => "c" + crypto.createHash("sha1").update(text.toLowerCase().replace(/\s+/g, " ").trim()).digest("hex").slice(0, 8);

/** One criterion per line. Ids come from the text, so reordering lines keeps existing assessments attached. */
export function parseCriteria(must: string, nice: string): Criterion[] {
  const seen = new Set<string>();
  const take = (text: string, kind: Criterion["kind"]) =>
    // Strip real list markers only ("- ", "• ", "1. ", "2) "), never a number that is part of the requirement ("5+ years").
    text.split("\n").map((l) => l.replace(/^\s*(?:[-*•]\s+|\d{1,2}[.)]\s+)/, "").trim().slice(0, 200)).filter(Boolean).flatMap((line) => {
      const id = cid(line);
      if (seen.has(id)) return [];
      seen.add(id);
      return [{ id, text: line, kind }];
    });
  return [...take(must, "must"), ...take(nice, "nice")].slice(0, 20);
}

/** One question per line: "Question? | yesno | expect yes" or "Question? | text". */
export function parseQuestions(text: string): { questions: Question[] } | { error: string } {
  const out: Question[] = [];
  for (const [i, raw] of text.split("\n").entries()) {
    if (!raw.trim()) continue;
    const [q = "", type = "text", expect = ""] = raw.split("|").map((s) => s.trim());
    if (!q) return { error: `Question line ${i + 1} is empty` };
    const t = /^(yes\s*\/?\s*no|yesno|y\/n)$/i.test(type) ? "yesno" : /^text$/i.test(type) || !type ? "text" : null;
    if (!t) return { error: `Question line ${i + 1}: type must be "yesno" or "text"` };
    const e = /yes/i.test(expect) ? "yes" : /no/i.test(expect) ? "no" : null;
    if (e && t !== "yesno") return { error: `Question line ${i + 1}: only yes/no questions can have an expected answer` };
    out.push({ id: "q" + cid(q).slice(1), text: q.slice(0, 200), type: t, expect: e });
  }
  return out.length > 10 ? { error: "Up to 10 questions" } : { questions: out };
}

export const questionLines = (qs: Question[]) => qs.map((q) => [q.text, q.type, q.expect ? `expect ${q.expect}` : ""].filter(Boolean).join(" | ")).join("\n");

/** Stated requirements the applicant's own answers don't meet. Shown to the reviewer; never an automatic rejection. */
export function unmetAnswers(questions: Question[], answers: Record<string, string>): string[] {
  return questions.filter((q) => q.expect && (answers[q.id] ?? "").toLowerCase() !== q.expect).map((q) => `Answered "${answers[q.id] || "no answer"}" to: ${q.text}`);
}

// ---------- evidence & tallies ----------

const squash = (s: string) => s.toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim();
export const quoteFound = (quote: string, text: string) => squash(quote).length >= 6 && squash(text).includes(squash(quote).replace(/^["']|["']$/g, ""));

export type Tally = { must: Record<CritStatus, number>; nice: Record<CritStatus, number>; mustTotal: number; niceTotal: number };

export function tally(criteria: Criterion[], assessment: Assessed[]): Tally {
  const by = new Map(assessment.map((a) => [a.id, a.status]));
  const zero = (): Record<CritStatus, number> => ({ met: 0, partial: 0, not_shown: 0 });
  const t: Tally = { must: zero(), nice: zero(), mustTotal: 0, niceTotal: 0 };
  for (const c of criteria) {
    t[c.kind][by.get(c.id) ?? "not_shown"]++;
    if (c.kind === "must") t.mustTotal++;
    else t.niceTotal++;
  }
  return t;
}

// ---------- keyword fallback ----------

const STOP = new Set("the a an and or of in on for with to at by from is are be as years year experience experienced strong good excellent ability able knowledge working work using use plus least minimum preferred required must have has nice".split(" "));
const keywords = (s: string) => [...new Set(s.toLowerCase().match(/[a-z][a-z0-9+#.]{1,}/g)?.filter((w) => !STOP.has(w) && w.length > 2) ?? [])];

/**
 * Without the model, a criterion can only be "mentioned" or not: the resume line sharing the most keywords with
 * it is shown as evidence. A keyword match can't confirm a requirement is met, so it is never reported as "met".
 */
export function rulesAssess(criteria: Criterion[], resume: string): Assessed[] {
  const lines = resume.split("\n").map((l) => l.trim()).filter((l) => l.length > 3);
  return criteria.map((c) => {
    const keys = keywords(c.text);
    const has = (k: string, low: string) => new RegExp(`(^|[^a-z0-9])${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`).test(low);
    let best = { line: "", hits: 0 };
    for (const l of lines) {
      const hits = keys.filter((k) => has(k, l.toLowerCase())).length;
      if (hits > best.hits) best = { line: l, hits };
    }
    // Keywords may be spread over several lines ("Backend Engineer" in a title, "Python" in a bullet), so count
    // them across the whole resume and show the single best line as evidence.
    const anywhere = keys.filter((k) => has(k, resume.toLowerCase())).length;
    const enough = keys.length > 0 && best.hits > 0 && anywhere >= Math.max(1, Math.ceil(keys.length / 2));
    return enough
      ? { id: c.id, status: "partial" as const, evidence: best.line.slice(0, 240), evidence_ok: true, note: "Mentioned in the resume (keyword match only; read the line to judge)" }
      : { id: c.id, status: "not_shown" as const, evidence: null, evidence_ok: null, note: "No matching keywords found. The resume may describe it in other words." };
  });
}

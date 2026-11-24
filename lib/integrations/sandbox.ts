// The sandbox: an in-process stand-in for each provider's API, so every integration can be connected and exercised
// without an account. The integration code is identical in both modes: only the fetch function differs. The
// simulators answer with the provider's documented request and response shapes, keep their records in
// sandbox_store, and throttle every 6th call with a 429 so the retry path runs for real.
import crypto from "node:crypto";
import { db } from "../db";
import type { Fetcher } from "./core";

export type SbReq = { method: string; url: URL; headers: Headers; body: string; json: <T = Record<string, unknown>>() => T };
export type SbRes = { status?: number; json?: unknown; text?: string; bytes?: Uint8Array; headers?: Record<string, string> };
export type Simulator = (req: SbReq, ownerId: number) => SbRes | Promise<SbRes>;

const sims = new Map<string, Simulator>();
const calls = new Map<string, number>();

export function registerSimulator(host: string, fn: Simulator) {
  sims.set(host, fn);
}

/** The simulator registered for a host (tests wrap it to inject failures). */
export const simulatorFor = (host: string) => sims.get(host);

const bodyText = (b: unknown): string =>
  b == null ? "" : typeof b === "string" ? b : b instanceof URLSearchParams ? b.toString() : b instanceof Uint8Array ? Buffer.from(b).toString("latin1") : String(b);

export function sandboxFetch(ownerId: number): Fetcher {
  return async (url, init) => {
    const u = new URL(url);
    const sim = sims.get(u.host);
    if (!sim) return new Response(JSON.stringify({ error: `No sandbox for ${u.host}` }), { status: 502 });
    const n = (calls.get(u.host) ?? 0) + 1;
    calls.set(u.host, n);
    if (n % 6 === 0 && process.env.SANDBOX_THROTTLE !== "0") {
      return new Response(JSON.stringify({ error: "rate_limited", message: "Too many requests (sandbox throttle)" }), { status: 429, headers: { "Retry-After": "0", "Content-Type": "application/json" } });
    }
    const body = bodyText(init.body);
    const req: SbReq = { method: (init.method ?? "GET").toUpperCase(), url: u, headers: new Headers(init.headers), body, json: <T,>() => (body ? JSON.parse(body) : {}) as T };
    const r = await sim(req, ownerId);
    const headers = { "Content-Type": r.text !== undefined ? "text/plain" : r.bytes ? "application/octet-stream" : "application/json", ...(r.headers ?? {}) };
    const payload = r.bytes ? new Uint8Array(r.bytes) : r.text !== undefined ? r.text : r.json === undefined ? "" : JSON.stringify(r.json);
    return new Response(r.status === 204 ? null : payload, { status: r.status ?? 200, headers });
  };
}

// ---------- the simulators' storage ----------

export function sbPut(provider: string, ownerId: number, kind: string, id: string | number, data: unknown) {
  db.prepare(`INSERT INTO sandbox_store (provider, owner_id, kind, id, data, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (provider, owner_id, kind, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`).run(provider, ownerId, kind, String(id), JSON.stringify(data), Date.now());
}

export function sbGet<T>(provider: string, ownerId: number, kind: string, id: string | number): T | undefined {
  const r = db.prepare("SELECT data FROM sandbox_store WHERE provider = ? AND owner_id = ? AND kind = ? AND id = ?").get(provider, ownerId, kind, String(id)) as { data: string } | undefined;
  return r ? (JSON.parse(r.data) as T) : undefined;
}

export function sbList<T>(provider: string, ownerId: number, kind: string): T[] {
  return (db.prepare("SELECT data FROM sandbox_store WHERE provider = ? AND owner_id = ? AND kind = ? ORDER BY updated_at, rowid").all(provider, ownerId, kind) as { data: string }[]).map((r) => JSON.parse(r.data) as T);
}

export function sbDelete(provider: string, ownerId: number, kind: string, id: string | number) {
  db.prepare("DELETE FROM sandbox_store WHERE provider = ? AND owner_id = ? AND kind = ? AND id = ?").run(provider, ownerId, kind, String(id));
}

/** Sequential numeric ids per kind, like most providers hand out. */
export function sbNextId(provider: string, ownerId: number, kind: string, start = 100): number {
  const cur = sbGet<number>(provider, ownerId, "_seq", kind) ?? start;
  sbPut(provider, ownerId, "_seq", kind, cur + 1);
  return cur + 1;
}

export const notFound = (what = "Not found"): SbRes => ({ status: 404, json: { message: what } });
export const unauthorized = (): SbRes => ({ status: 401, json: { message: "Invalid or expired access token" } });
export const bearer = (req: SbReq) => (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");

// ---------- simulated OAuth tokens ----------

const rand = () => crypto.randomUUID().replace(/-/g, "");

export function sbIssueTokens(provider: string, ownerId: number, ttlSec = 3600, withRefresh = true) {
  const access_token = `sbx_at_${rand()}`;
  sbPut(provider, ownerId, "_token", access_token, { exp: Date.now() + ttlSec * 1000 });
  const out: { access_token: string; token_type: string; expires_in: number; refresh_token?: string } = { access_token, token_type: "bearer", expires_in: ttlSec };
  if (withRefresh) {
    out.refresh_token = `sbx_rt_${rand()}`;
    sbPut(provider, ownerId, "_refresh", out.refresh_token, { at: Date.now() });
  }
  return out;
}

/** Exchanges a refresh token. rotate: the old refresh token stops working (as QuickBooks and Microsoft do). */
export function sbRefreshTokens(provider: string, ownerId: number, refreshToken: string, rotate: boolean, ttlSec = 3600) {
  if (!sbGet(provider, ownerId, "_refresh", refreshToken)) return null;
  if (rotate) sbDelete(provider, ownerId, "_refresh", refreshToken);
  const t = sbIssueTokens(provider, ownerId, ttlSec, rotate);
  return rotate ? t : { ...t, refresh_token: refreshToken };
}

export function sbAuthorized(req: SbReq, provider: string, ownerId: number): boolean {
  const t = sbGet<{ exp: number }>(provider, ownerId, "_token", bearer(req));
  return !!t && t.exp > Date.now();
}

/** Makes every issued access token expire now, to demonstrate refresh-on-401. */
export function sbExpireTokens(provider: string, ownerId: number) {
  db.prepare("UPDATE sandbox_store SET data = '{\"exp\":0}' WHERE provider = ? AND owner_id = ? AND kind = '_token'").run(provider, ownerId);
}

/** Records the sandbox holds, for the "what the provider received" panel (internal kinds start with _). */
export function sbKinds(provider: string, ownerId: number): { kind: string; n: number }[] {
  return db.prepare("SELECT kind, COUNT(*) AS n FROM sandbox_store WHERE provider = ? AND owner_id = ? AND kind NOT LIKE '\_%' ESCAPE '\' GROUP BY kind").all(provider, ownerId) as { kind: string; n: number }[];
}

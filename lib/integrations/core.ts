// Integration core: connections with sealed credentials, OAuth state, a resilient HTTP client, token refresh,
// a job queue (outbox) with retries, record links for idempotent sync, and an activity log.
// Every provider goes through the same pieces; only the endpoints and the field mapping differ.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { dataDir, db } from "../db";
import { sandboxFetch } from "./sandbox";

db.exec(`
  -- One connection per owner and provider. mode: live (the real API) | sandbox (built-in simulator).
  -- secret: sealed JSON (OAuth tokens or client credentials), never stored in plain text.
  CREATE TABLE IF NOT EXISTS integrations (
    id INTEGER PRIMARY KEY,
    owner_id INTEGER NOT NULL,
    provider TEXT NOT NULL,
    mode TEXT NOT NULL,
    account TEXT NOT NULL DEFAULT '',
    secret TEXT NOT NULL DEFAULT '',
    settings TEXT NOT NULL DEFAULT '{}',
    cursor TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'connected',
    last_error TEXT,
    last_sync_at INTEGER,
    created_at INTEGER NOT NULL,
    UNIQUE (owner_id, provider)
  );
  -- Which remote record a local record became, and a hash of the values last synced (detects edits on either side).
  CREATE TABLE IF NOT EXISTS integration_links (
    owner_id INTEGER NOT NULL,
    provider TEXT NOT NULL,
    local_type TEXT NOT NULL,
    local_id TEXT NOT NULL,
    remote_id TEXT NOT NULL,
    hash TEXT NOT NULL DEFAULT '',
    extra TEXT NOT NULL DEFAULT '{}',
    synced_at INTEGER NOT NULL,
    PRIMARY KEY (owner_id, provider, local_type, local_id)
  );
  CREATE INDEX IF NOT EXISTS ix_links_remote ON integration_links(owner_id, provider, local_type, remote_id);
  -- Outbox. (owner, provider, kind, ref) is the dedupe key: queuing the same work twice keeps one job.
  -- status: queued | running | done | failed (needs a person: bad data, revoked access, retries used up)
  CREATE TABLE IF NOT EXISTS integration_jobs (
    id INTEGER PRIMARY KEY,
    owner_id INTEGER NOT NULL,
    provider TEXT NOT NULL,
    kind TEXT NOT NULL,
    ref TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'queued',
    attempts INTEGER NOT NULL DEFAULT 0,
    next_at INTEGER NOT NULL,
    last_error TEXT,
    result TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (owner_id, provider, kind, ref)
  );
  CREATE INDEX IF NOT EXISTS ix_jobs_due ON integration_jobs(status, next_at);
  CREATE TABLE IF NOT EXISTS integration_log (
    id INTEGER PRIMARY KEY,
    owner_id INTEGER NOT NULL,
    provider TEXT NOT NULL,
    level TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS ix_ilog ON integration_log(owner_id, id DESC);
  CREATE TABLE IF NOT EXISTS oauth_states (
    state TEXT PRIMARY KEY,
    owner_id INTEGER NOT NULL,
    provider TEXT NOT NULL,
    mode TEXT NOT NULL,
    verifier TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  -- The sandbox's own records (what a simulated provider "holds").
  CREATE TABLE IF NOT EXISTS sandbox_store (
    provider TEXT NOT NULL,
    owner_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    id TEXT NOT NULL,
    data TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (provider, owner_id, kind, id)
  );
`);

export type Mode = "live" | "sandbox";
export type ConnStatus = "connected" | "error" | "reauth";
export type Conn = {
  id: number; owner_id: number; provider: string; mode: Mode; account: string; secret: string; settings: string; cursor: string;
  status: ConnStatus; last_error: string | null; last_sync_at: number | null; created_at: number;
};
export type JobRow = {
  id: number; owner_id: number; provider: string; kind: string; ref: string; payload: string; status: "queued" | "running" | "done" | "failed";
  attempts: number; next_at: number; last_error: string | null; result: string | null; created_at: number; updated_at: number;
};
export type LogRow = { id: number; provider: string; level: "info" | "warn" | "error"; message: string; created_at: number };

// ---------- credentials at rest ----------

let sealKey: Buffer | undefined;
function key(): Buffer {
  if (sealKey) return sealKey;
  if (process.env.INTEGRATIONS_KEY) return (sealKey = crypto.createHash("sha256").update(process.env.INTEGRATIONS_KEY).digest());
  const file = path.join(dataDir, "integrations.key");
  try {
    fs.writeFileSync(file, crypto.randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" });
  } catch {
    // already exists
  }
  return (sealKey = Buffer.from(fs.readFileSync(file, "utf8").trim(), "hex"));
}

/** AES-256-GCM. The key comes from INTEGRATIONS_KEY, or a random key file kept next to the database. */
export function seal(value: unknown): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([c.update(JSON.stringify(value), "utf8"), c.final()]);
  return "v1." + Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64url");
}

export function unseal<T>(sealed: string): T | null {
  if (!sealed.startsWith("v1.")) return null;
  try {
    const b = Buffer.from(sealed.slice(3), "base64url");
    const d = crypto.createDecipheriv("aes-256-gcm", key(), b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8")) as T;
  } catch {
    return null;
  }
}

// ---------- connections & log ----------

export function getConn(ownerId: number, provider: string): Conn | undefined {
  return db.prepare("SELECT * FROM integrations WHERE owner_id = ? AND provider = ?").get(ownerId, provider) as Conn | undefined;
}

export function saveConn(ownerId: number, provider: string, mode: Mode, account: string, secret: unknown, settings: Record<string, unknown> = {}): Conn {
  db.prepare(`
    INSERT INTO integrations (owner_id, provider, mode, account, secret, settings, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (owner_id, provider) DO UPDATE SET mode = excluded.mode, account = excluded.account, secret = excluded.secret,
      settings = CASE WHEN integrations.account = excluded.account AND integrations.mode = excluded.mode THEN integrations.settings ELSE excluded.settings END,
      cursor = CASE WHEN integrations.account = excluded.account AND integrations.mode = excluded.mode THEN integrations.cursor ELSE '' END,
      status = 'connected', last_error = NULL
  `).run(ownerId, provider, mode, account, seal(secret), JSON.stringify(settings), Date.now());
  log(ownerId, provider, "info", `Connected${mode === "sandbox" ? " to the sandbox" : ""}${account ? ` (${account})` : ""}`);
  return getConn(ownerId, provider)!;
}

export function updateConn(c: Conn, patch: { secret?: unknown; settings?: Record<string, unknown>; cursor?: string; status?: ConnStatus; last_error?: string | null; last_sync_at?: number }) {
  if (patch.secret !== undefined) c.secret = seal(patch.secret);
  if (patch.settings !== undefined) c.settings = JSON.stringify(patch.settings);
  if (patch.cursor !== undefined) c.cursor = patch.cursor;
  if (patch.status !== undefined) c.status = patch.status;
  if (patch.last_error !== undefined) c.last_error = patch.last_error;
  if (patch.last_sync_at !== undefined) c.last_sync_at = patch.last_sync_at;
  db.prepare("UPDATE integrations SET secret = ?, settings = ?, cursor = ?, status = ?, last_error = ?, last_sync_at = ? WHERE id = ?").run(
    c.secret, c.settings, c.cursor, c.status, c.last_error, c.last_sync_at, c.id,
  );
}

export const settingsOf = <T extends object>(c: Conn): T => JSON.parse(c.settings || "{}") as T;

/** Forget the connection and its links (a reconnect may point at a different account). The log stays. */
export function disconnect(ownerId: number, provider: string) {
  db.prepare("DELETE FROM integrations WHERE owner_id = ? AND provider = ?").run(ownerId, provider);
  db.prepare("DELETE FROM integration_links WHERE owner_id = ? AND provider = ?").run(ownerId, provider);
  db.prepare("DELETE FROM integration_jobs WHERE owner_id = ? AND provider = ? AND status != 'done'").run(ownerId, provider);
  db.prepare("DELETE FROM sandbox_store WHERE owner_id = ? AND provider = ?").run(ownerId, provider);
  log(ownerId, provider, "info", "Disconnected");
}

export function log(ownerId: number, provider: string, level: LogRow["level"], message: string) {
  db.prepare("INSERT INTO integration_log (owner_id, provider, level, message, created_at) VALUES (?, ?, ?, ?, ?)").run(ownerId, provider, level, message.slice(0, 500), Date.now());
}

export function recentLog(ownerId: number, provider: string, limit = 12): LogRow[] {
  return db.prepare("SELECT id, provider, level, message, created_at FROM integration_log WHERE owner_id = ? AND provider = ? ORDER BY id DESC LIMIT ?").all(ownerId, provider, limit) as LogRow[];
}

// ---------- links (idempotency + change detection) ----------

export type Link = { remote_id: string; hash: string; extra: string; synced_at: number };

export function getLink(ownerId: number, provider: string, localType: string, localId: string | number): Link | undefined {
  return db.prepare("SELECT remote_id, hash, extra, synced_at FROM integration_links WHERE owner_id = ? AND provider = ? AND local_type = ? AND local_id = ?").get(ownerId, provider, localType, String(localId)) as Link | undefined;
}

export function findByRemote(ownerId: number, provider: string, localType: string, remoteId: string): string | undefined {
  const r = db.prepare("SELECT local_id FROM integration_links WHERE owner_id = ? AND provider = ? AND local_type = ? AND remote_id = ?").get(ownerId, provider, localType, remoteId) as { local_id: string } | undefined;
  return r?.local_id;
}

export function setLink(ownerId: number, provider: string, localType: string, localId: string | number, remoteId: string, hash = "", extra: Record<string, unknown> = {}) {
  db.prepare(`
    INSERT INTO integration_links (owner_id, provider, local_type, local_id, remote_id, hash, extra, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (owner_id, provider, local_type, local_id) DO UPDATE SET remote_id = excluded.remote_id, hash = excluded.hash, extra = excluded.extra, synced_at = excluded.synced_at
  `).run(ownerId, provider, localType, String(localId), remoteId, hash, JSON.stringify(extra), Date.now());
}

export function dropLink(ownerId: number, provider: string, localType: string, localId: string | number) {
  db.prepare("DELETE FROM integration_links WHERE owner_id = ? AND provider = ? AND local_type = ? AND local_id = ?").run(ownerId, provider, localType, String(localId));
}

/** Stable hash of the synced fields, independent of key order. */
export function hashOf(values: Record<string, unknown>): string {
  const sorted = Object.keys(values).sort().map((k) => [k, values[k] ?? null]);
  return crypto.createHash("sha256").update(JSON.stringify(sorted)).digest("hex").slice(0, 16);
}

// ---------- HTTP ----------

export class ApiError extends Error {
  status: number;
  body: string;
  url: string;
  constructor(status: number, body: string, url: string) {
    super(`${status || "network error"} from ${safeHost(url)}${body ? `: ${body.slice(0, 200)}` : ""}`);
    this.status = status;
    this.body = body;
    this.url = url;
  }
  get retryable() {
    return this.status === 0 || this.status === 408 || this.status === 429 || this.status >= 500;
  }
}

/** The connection needs a person to reconnect it (refresh token revoked or expired). */
export class NeedsReauth extends Error {}

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
export type Ctx = { fetch: Fetcher; ownerId: number; provider: string; mode: Mode; sleep?: (ms: number) => Promise<void> };

const safeHost = (u: string) => {
  try {
    return new URL(u).host;
  } catch {
    return "provider";
  }
};

export function retryAfterMs(h: string | null): number | null {
  if (!h) return null;
  if (/^\d+(\.\d+)?$/.test(h.trim())) return Number(h) * 1000;
  const at = Date.parse(h);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}

const backoff = (attempt: number) => Math.round(400 * 2 ** attempt * (0.75 + Math.random() * 0.5));

type HttpInit = Omit<RequestInit, "body"> & { body?: string | URLSearchParams | Uint8Array; json?: unknown; retries?: number; idempotent?: boolean };

/**
 * One API call with retries. 429 and 503 wait for Retry-After; other 5xx and network failures back off exponentially.
 * A non-idempotent request (POST without an idempotency key) is retried only on 429, when the server did not act on it:
 * retrying it after a 5xx or a dropped connection could create the record twice.
 */
export async function http(ctx: Ctx, url: string, init: HttpInit = {}): Promise<Response> {
  const { json, retries = 3, idempotent, ...rest } = init;
  const method = (rest.method ?? "GET").toUpperCase();
  const safe = idempotent ?? method !== "POST";
  const headers = new Headers(rest.headers);
  let body: BodyInit | undefined = rest.body as BodyInit | undefined;
  if (json !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(json);
  }
  if (!headers.has("Accept")) headers.set("Accept", "application/json");
  const sleep = ctx.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await ctx.fetch(url, { ...rest, method, headers, body, redirect: "follow", signal: AbortSignal.timeout(20_000) });
    } catch (err) {
      if (!safe || attempt >= retries) throw new ApiError(0, err instanceof Error ? err.message : String(err), url);
      await sleep(backoff(attempt));
      continue;
    }
    if (res.ok) return res;
    const text = await res.text().catch(() => "");
    const again = res.status === 429 || (safe && (res.status >= 500 || res.status === 408));
    if (again && attempt < retries) {
      const wait = Math.min(retryAfterMs(res.headers.get("retry-after")) ?? backoff(attempt), 20_000);
      log(ctx.ownerId, ctx.provider, "warn", `${res.status} from ${safeHost(url)}${res.status === 429 ? " (rate limited)" : ""}; retrying in ${(wait / 1000).toFixed(1)}s`);
      await sleep(wait);
      continue;
    }
    throw new ApiError(res.status, text.slice(0, 1000), url);
  }
}

export async function httpJson<T>(ctx: Ctx, url: string, init: HttpInit = {}): Promise<T> {
  const res = await http(ctx, url, init);
  const text = await res.text();
  return (text ? JSON.parse(text) : {}) as T;
}

// ---------- OAuth ----------

export type Tokens = { access_token: string; refresh_token?: string; expires_at: number } & Record<string, unknown>;

/** Converts a token endpoint response to stored tokens. */
export function toTokens(r: { access_token: string; refresh_token?: string; expires_in?: number } & Record<string, unknown>, prev?: Tokens): Tokens {
  const { access_token, refresh_token, expires_in, ...rest } = r;
  return { ...(prev ?? {}), ...rest, access_token, refresh_token: refresh_token ?? prev?.refresh_token, expires_at: Date.now() + (Number(expires_in) || 3600) * 1000 };
}

const refreshing = new Map<number, Promise<Tokens>>();

/**
 * A valid access token, refreshed shortly before expiry. Concurrent callers share one refresh: providers that rotate
 * refresh tokens (QuickBooks) invalidate the old one, so two parallel refreshes would lock the connection out.
 */
export async function accessToken(c: Conn, refresh: (t: Tokens) => Promise<Tokens>, force = false): Promise<string> {
  const t = unseal<Tokens>(c.secret);
  if (!t) throw new NeedsReauth("Stored credentials can't be read (was INTEGRATIONS_KEY changed?)");
  if (!force && t.expires_at - Date.now() > 60_000) return t.access_token;
  let p = refreshing.get(c.id);
  if (!p) {
    p = (async () => {
      try {
        const next = await refresh(t);
        updateConn(c, { secret: next, status: "connected", last_error: null });
        return next;
      } catch (err) {
        if (err instanceof ApiError && (err.status === 400 || err.status === 401)) {
          updateConn(c, { status: "reauth", last_error: "Access was revoked or expired. Reconnect to continue." });
          throw new NeedsReauth("Access was revoked or expired. Reconnect to continue.");
        }
        throw err;
      } finally {
        refreshing.delete(c.id);
      }
    })();
    refreshing.set(c.id, p);
  }
  return (await p).access_token;
}

/** An authenticated call; on a 401 the token is refreshed once and the call repeated. */
export async function authedJson<T>(ctx: Ctx, c: Conn, refresh: (t: Tokens) => Promise<Tokens>, url: string, init: HttpInit = {}): Promise<T> {
  for (let i = 0; ; i++) {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${await accessToken(c, refresh, i > 0)}`);
    try {
      return await httpJson<T>(ctx, url, { ...init, headers });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401 && i === 0) continue;
      throw err;
    }
  }
}

export function newOAuthState(ownerId: number, provider: string, mode: Mode) {
  db.prepare("DELETE FROM oauth_states WHERE created_at < ?").run(Date.now() - 15 * 60_000);
  const state = crypto.randomBytes(24).toString("base64url");
  const verifier = crypto.randomBytes(48).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  db.prepare("INSERT INTO oauth_states (state, owner_id, provider, mode, verifier, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(state, ownerId, provider, mode, verifier, Date.now());
  return { state, verifier, challenge };
}

/** Single use, 10 minutes, and bound to the owner who started it (so a stolen callback URL can't attach an account to someone else). */
export function takeOAuthState(state: string, ownerId: number, provider: string): { mode: Mode; verifier: string } | null {
  const row = db.prepare("SELECT * FROM oauth_states WHERE state = ?").get(state) as { owner_id: number; provider: string; mode: Mode; verifier: string; created_at: number } | undefined;
  db.prepare("DELETE FROM oauth_states WHERE state = ?").run(state);
  if (!row || row.owner_id !== ownerId || row.provider !== provider || Date.now() - row.created_at > 10 * 60_000) return null;
  return { mode: row.mode, verifier: row.verifier };
}

// ---------- job queue ----------

/** attempt: 1 on the first run. A handler whose call isn't idempotent can check for its own earlier effect when attempt > 1. */
export type Handler = (c: Conn, ctx: Ctx, payload: Record<string, unknown>, meta: { attempt: number }) => Promise<string | void>;
const handlers = new Map<string, Handler>();

export function registerJob(provider: string, kind: string, fn: Handler) {
  handlers.set(`${provider}:${kind}`, fn);
}

/** How a provider is reached: the real network in live mode, the in-process simulator in sandbox mode. */
export function ctxFor(ownerId: number, provider: string, mode: Mode): Ctx {
  return { fetch: mode === "sandbox" ? sandboxFetch(ownerId) : (u, i) => fetch(u, i), ownerId, provider, mode };
}

/** Queue work. The same (kind, ref) collapses into one job, re-armed with the newest payload. */
export function enqueue(ownerId: number, provider: string, kind: string, ref: string | number, payload: Record<string, unknown> = {}) {
  const now = Date.now();
  db.prepare(`
    INSERT INTO integration_jobs (owner_id, provider, kind, ref, payload, next_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (owner_id, provider, kind, ref) DO UPDATE SET payload = excluded.payload, status = 'queued', attempts = 0, next_at = excluded.next_at,
      last_error = NULL, updated_at = excluded.updated_at WHERE integration_jobs.status != 'running'
  `).run(ownerId, provider, kind, String(ref), JSON.stringify(payload), now, now, now);
}

export function recentJobs(ownerId: number, provider: string, limit = 10): JobRow[] {
  return db.prepare("SELECT * FROM integration_jobs WHERE owner_id = ? AND provider = ? ORDER BY updated_at DESC, id DESC LIMIT ?").all(ownerId, provider, limit) as JobRow[];
}

export function jobFor(ownerId: number, provider: string, kind: string, ref: string | number): JobRow | undefined {
  return db.prepare("SELECT * FROM integration_jobs WHERE owner_id = ? AND provider = ? AND kind = ? AND ref = ?").get(ownerId, provider, kind, String(ref)) as JobRow | undefined;
}

export function retryFailed(ownerId: number, provider: string) {
  db.prepare("UPDATE integration_jobs SET status = 'queued', attempts = 0, next_at = ?, updated_at = ? WHERE owner_id = ? AND provider = ? AND status = 'failed'").run(Date.now(), Date.now(), ownerId, provider);
}

const MAX_ATTEMPTS = 6;

/** Runs due jobs for one owner, oldest first, within a time budget. Returns how many ran. */
export async function drain(ownerId: number, opts: { provider?: string; budgetMs?: number; max?: number } = {}): Promise<number> {
  const until = Date.now() + (opts.budgetMs ?? 25_000);
  // A job left "running" by a crashed process is picked up again after 5 minutes.
  db.prepare("UPDATE integration_jobs SET status = 'queued' WHERE status = 'running' AND updated_at < ?").run(Date.now() - 5 * 60_000);
  let ran = 0;
  while (Date.now() < until && ran < (opts.max ?? 50)) {
    const job = db.prepare(
      `SELECT * FROM integration_jobs WHERE owner_id = ? AND status = 'queued' AND next_at <= ? ${opts.provider ? "AND provider = ?" : ""} ORDER BY next_at, id LIMIT 1`,
    ).get(...([ownerId, Date.now(), opts.provider].filter((v) => v !== undefined) as (number | string)[])) as JobRow | undefined;
    if (!job) break;
    const claimed = db.prepare("UPDATE integration_jobs SET status = 'running', attempts = attempts + 1, updated_at = ? WHERE id = ? AND status = 'queued'").run(Date.now(), job.id);
    if (claimed.changes !== 1) continue;
    ran++;
    await runJob(job);
  }
  return ran;
}

async function runJob(job: JobRow) {
  const finish = (status: JobRow["status"], fields: { last_error?: string | null; result?: string | null; next_at?: number }) =>
    db.prepare("UPDATE integration_jobs SET status = ?, last_error = ?, result = COALESCE(?, result), next_at = ?, updated_at = ? WHERE id = ?").run(
      status, fields.last_error ?? null, fields.result ?? null, fields.next_at ?? job.next_at, Date.now(), job.id,
    );
  const c = getConn(job.owner_id, job.provider);
  const fn = handlers.get(`${job.provider}:${job.kind}`);
  if (!c || !fn) return finish("failed", { last_error: !c ? "Not connected" : `No handler for ${job.kind}` });
  if (c.status === "reauth") return finish("failed", { last_error: "Reconnect the integration, then retry" });
  try {
    const result = await fn(c, ctxFor(c.owner_id, c.provider, c.mode), JSON.parse(job.payload), { attempt: job.attempts + 1 });
    finish("done", { result: result ?? "ok" });
    if (c.status === "error") updateConn(c, { status: "connected", last_error: null });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const attempts = job.attempts + 1;
    if (err instanceof NeedsReauth) {
      finish("failed", { last_error: msg });
    } else if (err instanceof ApiError && err.retryable && attempts < MAX_ATTEMPTS) {
      finish("queued", { last_error: msg, next_at: Date.now() + Math.min(15_000 * 2 ** attempts, 3_600_000) });
    } else {
      finish("failed", { last_error: msg });
      // A bad record (4xx about the data) is that job's problem; auth failures and outages are the connection's.
      const dataProblem = err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 401 && err.status !== 403;
      if (!dataProblem) updateConn(c, { status: "error", last_error: msg });
    }
    log(job.owner_id, job.provider, "error", `${job.kind} ${job.ref}: ${msg}`);
  }
}

/** Runs the queue after the response is sent (Next.js `after`), so pages never wait on a third-party API. */
export async function kick(ownerId: number, provider?: string) {
  try {
    const { after } = await import("next/server");
    after(() => drain(ownerId, { provider }).catch(() => {}));
  } catch {
    await drain(ownerId, { provider });
  }
}

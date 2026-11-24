import type { Conn, Ctx, Tokens } from "./core";

/** What the Integrations page and the OAuth callback need to know about a provider. */
export type Provider = {
  id: string;
  name: string;
  blurb: string;
  /** Environment variables a live connection needs (the simulator needs none). */
  env: string[];
  /** Where the person approves access (live mode). Absent for providers connected with API credentials instead of OAuth. */
  authorizeUrl?(state: string, challenge: string, redirectUri: string): string;
  /** Trades the authorization code for tokens and describes the connected account. */
  exchange?(ctx: Ctx, code: string, redirectUri: string, verifier: string, params: URLSearchParams): Promise<{ account: string; secret: Tokens; settings?: Record<string, unknown> }>;
  /** One-time setup right after connecting (load reference data, create the workbook...). */
  afterConnect?(c: Conn, ctx: Ctx): Promise<void>;
};

export const liveReady = (p: Pick<Provider, "env">) => p.env.every((k) => !!process.env[k]);
export const missingEnv = (p: Pick<Provider, "env">) => p.env.filter((k) => !process.env[k]);

/** Values for a form-encoded token request. */
export const form = (o: Record<string, string | undefined>) => {
  const f = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined) f.set(k, v);
  return f;
};

export const basic = (id: string, secret: string) => `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;

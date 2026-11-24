// Starting and finishing a connection. Live mode sends the person to the provider's consent screen; the simulator
// skips the consent screen but still goes through the same callback, code exchange and setup.
import { headers } from "next/headers";
import { ctxFor, log, newOAuthState, saveConn, takeOAuthState, type Mode } from "./core";
import { liveReady, type Provider } from "./provider";

export async function redirectUri(provider: string) {
  const h = await headers();
  const base = process.env.APP_URL?.replace(/\/$/, "") ?? `${h.get("x-forwarded-proto") ?? "http"}://${h.get("host")}`;
  return `${base}/integrations/${provider}/callback`;
}

/** Live mode: the provider's consent screen, which redirects back to the callback route. */
export async function startUrl(p: Provider, ownerId: number): Promise<string> {
  if (!p.authorizeUrl || !p.exchange) throw new Error(`${p.name} connects with API credentials, not a sign-in link`);
  if (!liveReady(p)) throw new Error(`${p.name} isn't configured on this server`);
  const { state, challenge } = newOAuthState(ownerId, p.id, "live");
  return p.authorizeUrl(state, challenge, await redirectUri(p.id));
}

/**
 * Simulator: skips the consent screen and hands finish() what the provider's redirect would carry (state, a code,
 * QuickBooks' realmId), so the state check, code exchange (with PKCE) and setup run exactly as in live mode.
 */
export async function connectSimulator(p: Provider, ownerId: number) {
  const { state } = newOAuthState(ownerId, p.id, "sandbox");
  return finish(p, ownerId, new URLSearchParams({ code: `sbx_code_${state.slice(0, 8)}`, state, realmId: "9341453050071234" }));
}

/** The OAuth callback: validates state, exchanges the code, saves the sealed tokens and runs first-time setup. */
export async function finish(p: Provider, ownerId: number, params: URLSearchParams): Promise<{ ok: true } | { error: string }> {
  if (params.get("error")) return { error: params.get("error_description") ?? params.get("error") ?? "Access was not granted" };
  const st = takeOAuthState(params.get("state") ?? "", ownerId, p.id);
  if (!st) return { error: "This connection link expired or was already used. Start again." };
  const ctx = ctxFor(ownerId, p.id, st.mode);
  if (!p.exchange) return { error: `${p.name} doesn't use sign-in links` };
  try {
    const r = await p.exchange(ctx, params.get("code") ?? "", await redirectUri(p.id), st.verifier, params);
    const c = saveConn(ownerId, p.id, st.mode, r.account, r.secret, r.settings);
    if (p.afterConnect) await p.afterConnect(c, ctx);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(ownerId, p.id, "error", `Connecting failed: ${msg}`);
    return { error: `Connecting failed: ${msg.slice(0, 200)}` };
  }
}

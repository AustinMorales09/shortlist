import { NextRequest, NextResponse } from "next/server";
import { getUser } from "@/lib/auth";
import { db, type Org } from "@/lib/db";
import { providerById } from "@/lib/integrations";
import { finish } from "@/lib/integrations/connect";

// OAuth redirect target. The state parameter is single-use and tied to the signed-in owner who started the flow.
export async function GET(req: NextRequest, ctx: { params: Promise<{ provider: string }> }) {
  const { provider } = await ctx.params;
  const user = await getUser();
  const to = (q: string) => NextResponse.redirect(new URL(`/integrations?${q}`, req.nextUrl.origin));
  if (!user) return NextResponse.redirect(new URL("/login", req.nextUrl.origin));
  const org = db.prepare("SELECT * FROM orgs WHERE user_id = ?").get(user.id) as Org;
  const p = providerById(provider);
  if (!p) return to(`error=${encodeURIComponent("Unknown integration")}`);
  const r = await finish(p, org.id, req.nextUrl.searchParams);
  return "error" in r ? to(`error=${encodeURIComponent(r.error)}#${p.id}`) : to(`done=${encodeURIComponent(`Connected ${p.name}`)}#${p.id}`);
}

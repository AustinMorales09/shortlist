import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { NextRequest, NextResponse } from "next/server";
import { getUser } from "@/lib/auth";
import { db, filesDir, type ApplicantRow, type JobRow } from "@/lib/db";

// The original resume file. During blind review it isn't served: the file itself can't be redacted,
// so the reviewer must reveal the applicant's identity first (which is logged).
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const user = await getUser();
  const a = user ? (db.prepare("SELECT a.* FROM applicants a JOIN orgs o ON o.id = a.org_id WHERE a.id = ? AND o.user_id = ?").get(Number(id), user.id) as ApplicantRow | undefined) : undefined;
  if (!a || !a.stored_as) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const job = db.prepare("SELECT * FROM jobs WHERE id = ?").get(a.job_id) as JobRow;
  if (job.blind && !a.revealed) return NextResponse.json({ error: "Blind review is on for this job. Reveal the applicant's identity to open the original file." }, { status: 403 });
  const p = path.join(filesDir, a.stored_as);
  if (!fs.existsSync(p)) return NextResponse.json({ error: "Missing" }, { status: 404 });
  return new NextResponse(Readable.toWeb(fs.createReadStream(p)) as ReadableStream, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${(a.resume_name || "resume").replace(/[^\x20-\x7e]/g, "_")}"`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    },
  });
}

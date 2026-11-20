import Link from "next/link";
import { redirect } from "next/navigation";
import { getUser } from "@/lib/auth";

export default async function Home() {
  if (await getUser()) redirect("/jobs");
  return (
    <main className="hero">
      <h1>Read every application against the same criteria</h1>
      <p>
        Write down what the job actually requires. Shortlist compares each resume with those criteria and shows the exact
        lines that back it up, with names and personal details hidden. It never scores, ranks or rejects anyone: your team
        decides, and every decision is on record.
      </p>
      <Link href="/signup" className="btn">Try it with a sample job</Link>
    </main>
  );
}

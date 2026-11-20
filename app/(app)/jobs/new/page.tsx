import Link from "next/link";
import { myOrg } from "@/lib/access";
import JobForm from "@/components/JobForm";

export default async function NewJob({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  await myOrg();
  const sp = await searchParams;
  return (
    <main className="container" style={{ maxWidth: 860 }}>
      <p className="small" style={{ margin: 0 }}><Link href="/jobs">← Jobs</Link></p>
      <h1 style={{ margin: "8px 0" }}>New job</h1>
      {sp.error && <p className="error card">{sp.error}</p>}
      <JobForm />
    </main>
  );
}

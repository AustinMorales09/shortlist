import Link from "next/link";
import { ownJob } from "@/lib/access";
import JobForm from "@/components/JobForm";

export default async function EditJob({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  const { job } = await ownJob(Number(id));
  return (
    <main className="container" style={{ maxWidth: 860 }}>
      <p className="small" style={{ margin: 0 }}><Link href={`/jobs/${job.id}`}>← {job.title}</Link></p>
      <h1 style={{ margin: "8px 0" }}>Edit job</h1>
      {sp.error && <p className="error card">{sp.error}</p>}
      <JobForm job={job} />
    </main>
  );
}

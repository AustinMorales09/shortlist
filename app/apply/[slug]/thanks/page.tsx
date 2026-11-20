export const metadata = { title: "Application received", robots: { index: false } };

export default function Thanks() {
  return (
    <main className="container narrow">
      <div className="card" style={{ textAlign: "center", marginTop: 48 }}>
        <h1>Thank you. We&apos;ve received your application.</h1>
        <p className="muted">A member of the team will review it and get back to you by email.</p>
      </div>
    </main>
  );
}

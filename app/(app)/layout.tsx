import Link from "next/link";
import { getUser } from "@/lib/auth";
import { logout } from "@/lib/actions";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getUser();
  return (
    <>
      <nav className="nav">
        <Link href={user ? "/jobs" : "/"} className="brand">Shortlist</Link>
        <div className="nav-right">
          {user ? (
            <>
              <Link href="/jobs">Jobs</Link>
              <Link href="/audit">Audit log</Link>
              <Link href="/outbox">Sent</Link>
              <Link href="/integrations">Integrations</Link>
              <Link href="/settings">Settings</Link>
              <form action={logout}><button className="link">Log out</button></form>
            </>
          ) : (
            <>
              <Link href="/login">Log in</Link>
              <Link href="/signup">Sign up</Link>
            </>
          )}
        </div>
      </nav>
      {children}
    </>
  );
}

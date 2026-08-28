import Link from "next/link";

/**
 * Dashboard — Phase 1 placeholder. The master brief's full Dashboard (business
 * metrics, autonomy summary, etc.) is a later-phase concern; for now this is a
 * simple landing point into the two things Phase 1 actually delivers: Inbox and
 * Connections. See docs/architecture/FUTURE_ROADMAP.md for what's explicitly not
 * built yet.
 */
export default function DashboardPage() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <h1 className="text-2xl font-semibold tracking-tight">Global Link</h1>
      <p className="mt-2 text-slate-600">AI email operations platform — Phase 1.</p>

      <div className="mt-10 grid gap-4 sm:grid-cols-2">
        <Link href="/inbox" className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm transition hover:border-slate-300 hover:shadow">
          <h2 className="font-medium">Inbox</h2>
          <p className="mt-1 text-sm text-slate-500">Dossiers ingested from your connected mailbox.</p>
        </Link>
        <Link href="/connections" className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm transition hover:border-slate-300 hover:shadow">
          <h2 className="font-medium">Connections</h2>
          <p className="mt-1 text-sm text-slate-500">Connect a Gmail or Microsoft 365 mailbox.</p>
        </Link>
      </div>

      <p className="mt-10 text-sm text-slate-400">
        Not signed in? <Link href="/login" className="underline">Sign in</Link>
      </p>
    </main>
  );
}

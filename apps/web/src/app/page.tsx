import Link from "next/link";
import { Inbox, Plug, ArrowRight } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

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
      <p className="mt-2 text-muted-foreground">AI email operations platform — Phase 1.</p>

      <div className="mt-10 grid gap-4 sm:grid-cols-2">
        <Link href="/inbox">
          <Card className="h-full transition-colors hover:border-foreground/20">
            <CardHeader>
              <Inbox className="h-5 w-5 text-muted-foreground" />
              <CardTitle className="text-base">Inbox</CardTitle>
              <CardDescription>Dossiers ingested from your connected mailbox.</CardDescription>
            </CardHeader>
          </Card>
        </Link>
        <Link href="/connections">
          <Card className="h-full transition-colors hover:border-foreground/20">
            <CardHeader>
              <Plug className="h-5 w-5 text-muted-foreground" />
              <CardTitle className="text-base">Connections</CardTitle>
              <CardDescription>Connect a Gmail or Microsoft 365 mailbox.</CardDescription>
            </CardHeader>
          </Card>
        </Link>
      </div>

      <p className="mt-10 flex items-center gap-1 text-sm text-muted-foreground">
        Not signed in?
        <Link href="/login" className="inline-flex items-center gap-1 font-medium text-foreground underline underline-offset-4">
          Sign in <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </p>
    </main>
  );
}

"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";
import { apiFetch } from "@/lib/apiClient";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

interface ThreadRow {
  id: string;
  subject: string;
  senderEmail: string;
  senderName: string | null;
  status: string;
  urgency: string;
  receivedAt: string;
  updatedAt: string;
}

const URGENCY_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  low: "outline",
  normal: "secondary",
  high: "destructive",
};

/**
 * Phase 1 Inbox: the dossier list from apps/api. No thread-detail view, no
 * filtering/search yet — those are the next increment once this round-trip
 * (Supabase session -> Bearer token -> org-scoped API -> RLS'd query) is proven
 * end to end. See docs/architecture/refonte-plan.md Phase 1.
 */
export default function InboxPage() {
  const router = useRouter();
  const [threads, setThreads] = useState<ThreadRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) {
        router.push("/login");
        return;
      }

      try {
        const me = await apiFetch<{ memberships: { organizationId: string }[] }>("/api/v1/me");
        const organizationId = me.memberships[0]?.organizationId;
        if (!organizationId) {
          setError("This account has no organization membership yet.");
          return;
        }
        const data = await apiFetch<{ threads: ThreadRow[] }>(`/api/v1/organizations/${organizationId}/threads`);
        if (!cancelled) setThreads(data.threads);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [router]);

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <Card>
        <CardHeader>
          <CardTitle>Inbox</CardTitle>
        </CardHeader>
        <CardContent>
          {error && <p className="text-sm text-destructive">{error}</p>}
          {!error && threads === null && <p className="text-sm text-muted-foreground">Loading…</p>}
          {threads !== null && threads.length === 0 && <p className="text-sm text-muted-foreground">No dossiers yet.</p>}

          {threads !== null && threads.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Subject</TableHead>
                  <TableHead>From</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Urgency</TableHead>
                  <TableHead>Received</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {threads.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell className="font-medium">{t.subject}</TableCell>
                    <TableCell>{t.senderName ?? t.senderEmail}</TableCell>
                    <TableCell>{t.status}</TableCell>
                    <TableCell>
                      <Badge variant={URGENCY_VARIANT[t.urgency] ?? "secondary"}>{t.urgency}</Badge>
                    </TableCell>
                    <TableCell>{new Date(t.receivedAt).toLocaleString()}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </main>
  );
}

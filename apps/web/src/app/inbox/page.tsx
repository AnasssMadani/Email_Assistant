"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";
import { apiFetch } from "@/lib/apiClient";

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
      <h1 className="text-xl font-semibold">Inbox</h1>

      {error && <p className="mt-4 text-sm text-red-600">{error}</p>}
      {!error && threads === null && <p className="mt-4 text-sm text-slate-500">Loading…</p>}
      {threads !== null && threads.length === 0 && <p className="mt-4 text-sm text-slate-500">No dossiers yet.</p>}

      {threads !== null && threads.length > 0 && (
        <table className="mt-6 w-full text-left text-sm">
          <thead className="border-b border-slate-200 text-slate-500">
            <tr>
              <th className="py-2 pr-4">Subject</th>
              <th className="py-2 pr-4">From</th>
              <th className="py-2 pr-4">Status</th>
              <th className="py-2 pr-4">Urgency</th>
              <th className="py-2">Received</th>
            </tr>
          </thead>
          <tbody>
            {threads.map((t) => (
              <tr key={t.id} className="border-b border-slate-100">
                <td className="py-2 pr-4">{t.subject}</td>
                <td className="py-2 pr-4">{t.senderName ?? t.senderEmail}</td>
                <td className="py-2 pr-4">{t.status}</td>
                <td className="py-2 pr-4">{t.urgency}</td>
                <td className="py-2">{new Date(t.receivedAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}

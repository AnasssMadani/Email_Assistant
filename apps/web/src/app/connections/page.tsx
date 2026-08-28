"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";
import { apiFetch } from "@/lib/apiClient";

/** Phase 1 Connections: starts the Gmail/Graph OAuth flow via apps/api. The redirect back after OAuth currently just shows the raw JSON apps/api's callback route returns — a proper "connected!" landing page is the next increment, not yet built. */
export default function ConnectionsPage() {
  const router = useRouter();
  const [organizationId, setOrganizationId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState<"gmail" | "graph" | null>(null);

  useEffect(() => {
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
        setOrganizationId(me.memberships[0]?.organizationId ?? null);
      } catch (err) {
        setError((err as Error).message);
      }
    }
    void load();
  }, [router]);

  async function connect(provider: "gmail" | "graph") {
    if (!organizationId) return;
    setStarting(provider);
    try {
      const { authorizeUrl } = await apiFetch<{ authorizeUrl: string }>(
        `/api/v1/organizations/${organizationId}/mailboxes/${provider}/start`,
        { method: "POST" }
      );
      window.location.href = authorizeUrl;
    } catch (err) {
      setError((err as Error).message);
      setStarting(null);
    }
  }

  return (
    <main className="mx-auto max-w-lg px-6 py-10">
      <h1 className="text-xl font-semibold">Connections</h1>
      <p className="mt-2 text-sm text-slate-600">Connect the mailbox this organization's automation will run against.</p>

      {error && <p className="mt-4 text-sm text-red-600">{error}</p>}

      <div className="mt-6 space-y-3">
        <button
          onClick={() => connect("gmail")}
          disabled={!organizationId || starting !== null}
          className="w-full rounded-md border border-slate-300 bg-white px-4 py-3 text-left text-sm font-medium disabled:opacity-50"
        >
          {starting === "gmail" ? "Redirecting to Google…" : "Connect Gmail"}
        </button>
        <button
          onClick={() => connect("graph")}
          disabled={!organizationId || starting !== null}
          className="w-full rounded-md border border-slate-300 bg-white px-4 py-3 text-left text-sm font-medium disabled:opacity-50"
        >
          {starting === "graph" ? "Redirecting to Microsoft…" : "Connect Microsoft 365"}
        </button>
      </div>
    </main>
  );
}

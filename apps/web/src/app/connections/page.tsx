"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Mail, Building2 } from "lucide-react";
import { supabase } from "@/lib/supabaseClient";
import { apiFetch } from "@/lib/apiClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

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
      <Card>
        <CardHeader>
          <CardTitle>Connections</CardTitle>
          <CardDescription>Connect the mailbox this organization's automation will run against.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {error && <p className="text-sm text-destructive">{error}</p>}

          <Button
            variant="outline"
            onClick={() => connect("gmail")}
            disabled={!organizationId || starting !== null}
            className="w-full justify-start gap-2 py-6"
          >
            <Mail className="h-4 w-4" />
            {starting === "gmail" ? "Redirecting to Google…" : "Connect Gmail"}
          </Button>
          <Button
            variant="outline"
            onClick={() => connect("graph")}
            disabled={!organizationId || starting !== null}
            className="w-full justify-start gap-2 py-6"
          >
            <Building2 className="h-4 w-4" />
            {starting === "graph" ? "Redirecting to Microsoft…" : "Connect Microsoft 365"}
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}

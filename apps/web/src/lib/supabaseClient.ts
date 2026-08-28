"use client";

import { createClient } from "@supabase/supabase-js";

/**
 * Browser Supabase client — auth only (magic link / email+password sign-in).
 * Mailbox data, threads, etc. never go through this client directly; they go
 * through apps/api, which enforces org membership and RLS — see
 * docs/architecture/refonte-plan.md "Multi-tenancy". This client's only job is to
 * produce a session (and its access token) to send as a Bearer header.
 */
// Falls back to a syntactically valid placeholder so `next build`'s static
// prerendering pass (which loads this module without real env vars available)
// doesn't crash — createClient() validates the URL shape eagerly. At runtime,
// NEXT_PUBLIC_SUPABASE_URL/ANON_KEY are required; without them every auth call
// fails against a non-existent project, which is the correct, loud failure mode
// (never silently no-op an auth check).
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://placeholder.supabase.co";
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "placeholder-anon-key";

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

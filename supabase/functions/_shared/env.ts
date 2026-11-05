import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';
import type { VapidConfig } from './webpush.ts';

export function requireEnv(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`Missing secret: ${name}`);
  return v;
}

/** Service-role client. Bypasses RLS — only use after checking authorization yourself. */
export function adminClient(): SupabaseClient {
  const key = Deno.env.get('SERVICE_ROLE_KEY') ?? requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  return createClient(requireEnv('SUPABASE_URL'), key, { auth: { persistSession: false } });
}

export function vapidConfig(): VapidConfig {
  return {
    publicKey: requireEnv('VAPID_PUBLIC_KEY'),
    privateKey: requireEnv('VAPID_PRIVATE_KEY'),
    subject: requireEnv('VAPID_SUBJECT'),
  };
}

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

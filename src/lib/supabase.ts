import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
export const vapidPublicKey = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined;

export const configured = Boolean(url && key && url.startsWith('https://'));

export const supabase: SupabaseClient = configured
  ? createClient(url!, key!, {
      auth: { persistSession: true, autoRefreshToken: true, storageKey: 'lull-auth' },
      realtime: { params: { eventsPerSecond: 5 } },
    })
  : (null as unknown as SupabaseClient);

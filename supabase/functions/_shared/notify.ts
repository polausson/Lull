import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { sendPush, type VapidConfig } from './webpush.ts';

export interface NotificationPayload {
  title: string;
  body: string;
  url: string;
  tag: string;
  kind: 'sound' | 'lost' | 'recovered';
  eventId?: string;
}

/** Sends a notification to every parent device in a household. Removes dead subscriptions. */
export async function notifyHousehold(
  db: SupabaseClient,
  vapid: VapidConfig,
  householdId: string,
  payload: NotificationPayload,
  { soundAlertsOnly }: { soundAlertsOnly: boolean },
) {
  let q = db.from('push_subscriptions').select('endpoint, p256dh, auth').eq('household_id', householdId);
  if (soundAlertsOnly) q = q.eq('sound_alerts', true);
  const { data: subs, error } = await q;
  if (error) throw error;

  const results = await Promise.all(
    ((subs ?? []) as { endpoint: string; p256dh: string; auth: string }[]).map((s) =>
      sendPush(s, payload, vapid, {
        urgency: 'high',
        ttlSeconds: payload.kind === 'sound' ? 120 : 600,
        topic: payload.kind, // replaces an undelivered older push of the same kind
      }),
    ),
  );
  const gone = results.filter((r) => r.gone).map((r) => r.endpoint);
  if (gone.length) await db.from('push_subscriptions').delete().in('endpoint', gone);
  for (const r of results) if (!r.ok) console.warn('push failed', r.status, r.endpoint.slice(0, 60), r.error);
  return { sent: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, removed: gone.length };
}

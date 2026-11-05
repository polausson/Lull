// Called by the Baby Unit the moment a sound is detected (before the clip finishes),
// so parents are alerted within a second or two.
import { adminClient, vapidConfig, corsHeaders, json } from '../_shared/env.ts';
import { notifyHousehold } from '../_shared/notify.ts';

const MIN_INTERVAL_SECONDS = 20; // server-side floor; the Baby Unit applies its own (longer) cooldown

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  try {
    const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    const db = adminClient();
    const { data: userData, error: authError } = await db.auth.getUser(token);
    if (authError || !userData.user) return json({ error: 'unauthorized' }, 401);
    const userId = userData.user.id;

    const { eventId } = await req.json().catch(() => ({}));
    if (typeof eventId !== 'string') return json({ error: 'eventId required' }, 400);

    const { data: event } = await db.from('sound_events')
      .select('id, household_id, created_at, notified').eq('id', eventId).maybeSingle();
    if (!event) return json({ error: 'not found' }, 404);

    const { data: member } = await db.from('household_members')
      .select('role').eq('household_id', event.household_id).eq('user_id', userId).maybeSingle();
    if (member?.role !== 'baby') return json({ error: 'forbidden' }, 403);

    if (event.notified) return json({ skipped: 'already notified' });
    if (Date.now() - new Date(event.created_at).getTime() > 3 * 60_000) return json({ skipped: 'stale event' });

    const { data: claimed, error: claimError } = await db.rpc('try_claim_notify', {
      p_household: event.household_id, p_min_interval_seconds: MIN_INTERVAL_SECONDS,
    });
    if (claimError) throw claimError;
    if (!claimed) return json({ skipped: 'rate limited' });

    await db.from('sound_events').update({ notified: true }).eq('id', event.id);
    const result = await notifyHousehold(db, vapidConfig(), event.household_id, {
      kind: 'sound',
      title: 'Sound in the nursery',
      body: 'Tap to listen.',
      url: `/?event=${event.id}`,
      tag: 'lull-sound',
      eventId: event.id,
    }, { soundAlertsOnly: true });
    return json(result);
  } catch (e) {
    console.error('notify-sound error', e);
    return json({ error: 'internal error' }, 500);
  }
});

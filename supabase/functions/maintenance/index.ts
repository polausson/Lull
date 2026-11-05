// Runs every minute from pg_cron (see supabase/cron.sql). Deploy with --no-verify-jwt;
// it authenticates with the CRON_SECRET header instead.
//  1. Watchdog: alert parents when a monitoring Baby Unit stops reporting or loses its microphone,
//     and again when it recovers. This works even when the Baby Unit's phone is dead or offline.
//  2. Retention: delete clips (storage + rows) older than the household's retention period.
import { adminClient, vapidConfig, json, requireEnv } from '../_shared/env.ts';
import { notifyHousehold } from '../_shared/notify.ts';

Deno.serve(async (req) => {
  if (req.headers.get('x-cron-secret') !== requireEnv('CRON_SECRET')) return json({ error: 'unauthorized' }, 401);
  const db = adminClient();
  const vapid = vapidConfig();
  const report: Record<string, unknown> = {};

  try {
    const { data: changes, error } = await db.rpc('watchdog_scan');
    if (error) throw error;
    report.watchdog = await Promise.all((changes ?? []).map((c: { household_id: string; kind: string; detail: string | null }) =>
      notifyHousehold(db, vapid, c.household_id, c.kind === 'lost'
        ? {
            kind: 'lost',
            title: c.detail === 'no_audio' ? 'Baby unit stopped listening' : 'Baby unit disconnected',
            body: c.detail === 'no_audio'
              ? 'The microphone is no longer active. Check the baby unit.'
              : 'No signal from the baby unit for over a minute. Check the phone, power and Wi‑Fi.',
            url: '/', tag: 'lull-connection',
          }
        : { kind: 'recovered', title: 'Baby unit is listening again', body: 'Monitoring has resumed.', url: '/', tag: 'lull-connection' },
        { soundAlertsOnly: false })));
  } catch (e) {
    console.error('watchdog error', e);
    report.watchdogError = String(e);
  }

  try {
    const { data: expired, error } = await db.rpc('expired_events', { p_limit: 500 });
    if (error) throw error;
    const rows = (expired ?? []) as { id: string; storage_path: string | null }[];
    const paths = rows.map((r) => r.storage_path).filter((p): p is string => !!p);
    if (paths.length) {
      const { error: rmError } = await db.storage.from('recordings').remove(paths);
      if (rmError) throw rmError;
    }
    if (rows.length) await db.from('sound_events').delete().in('id', rows.map((r) => r.id));
    await db.rpc('housekeeping');
    report.deleted = rows.length;
  } catch (e) {
    console.error('retention error', e);
    report.retentionError = String(e);
  }

  return json(report);
});

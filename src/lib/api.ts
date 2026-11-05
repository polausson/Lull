// Typed wrappers around the database RPCs and tables.
import { supabase } from './supabase';
import { unwrap, withRetry } from './retry';
import { log } from './log';

export type Role = 'baby' | 'parent';

export interface Status {
  household_id: string;
  role: Role;
  retention_hours: number;
  monitoring: boolean;
  audio_ok: boolean;
  status_detail: string | null;
  last_heartbeat: string | null;
  heartbeat_age_seconds: number | null;
  parent_count: number;
  alert_device_count: number;
  server_time: string;
}

export interface SoundEvent {
  id: string;
  household_id: string;
  created_at: string;
  peak_db: number | null;
  above_floor_db: number | null;
  duration_ms: number | null;
  storage_path: string | null;
  status: 'recording' | 'ready' | 'failed';
}

export async function ensureSession(): Promise<string> {
  const { data } = await supabase.auth.getSession();
  if (data.session) return data.session.user.id;
  const res = await supabase.auth.signInAnonymously();
  if (res.error || !res.data.user) throw new Error(res.error?.message ?? 'Could not sign in');
  log.info('auth', 'anonymous session created');
  return res.data.user.id;
}

export async function getStatus(): Promise<Status | null> {
  const rows = unwrap(await supabase.rpc('get_status')) as Status[];
  return rows[0] ?? null;
}

export async function createHousehold(label: string) {
  return unwrap(await supabase.rpc('create_household', { p_label: label })) as string;
}

export async function createPairingCode(): Promise<{ code: string; expires_at: string }> {
  const rows = unwrap(await supabase.rpc('create_pairing_code')) as { code: string; expires_at: string }[];
  return rows[0];
}

/** Returns false for a wrong or expired code. */
export async function claimPairingCode(code: string, label: string): Promise<boolean> {
  const id = unwrap(await supabase.rpc('claim_pairing_code', { p_code: code, p_label: label }));
  return Boolean(id);
}

export async function heartbeat(monitoring: boolean, audioOk: boolean, detail: string | null) {
  unwrap(await supabase.rpc('baby_heartbeat', { p_monitoring: monitoring, p_audio_ok: audioOk, p_detail: detail }));
}

export async function leaveHousehold() {
  unwrap(await supabase.rpc('leave_household'));
}

export async function setRetention(hours: number) {
  unwrap(await supabase.rpc('set_retention', { p_hours: hours }));
}

// ---- sound events --------------------------------------------------------

export async function insertSoundEvent(householdId: string, peakDb: number, aboveFloorDb: number): Promise<string> {
  return withRetry(async () => {
    const row = unwrap(await supabase.from('sound_events')
      .insert({ household_id: householdId, peak_db: peakDb, above_floor_db: aboveFloorDb })
      .select('id').single()) as { id: string };
    return row.id;
  }, 3);
}

export async function notifySound(eventId: string) {
  const { data, error } = await supabase.functions.invoke('notify-sound', { body: { eventId } });
  if (error) throw error;
  return data;
}

export async function uploadClip(householdId: string, eventId: string, wav: Uint8Array<ArrayBuffer>, meta: { durationMs: number; peakDb: number; aboveFloorDb: number }) {
  const path = `${householdId}/${eventId}.wav`;
  await withRetry(async () => {
    const { error } = await supabase.storage.from('recordings')
      .upload(path, new Blob([wav], { type: 'audio/wav' }), { contentType: 'audio/wav', upsert: false });
    if (error && !/exists|duplicate/i.test(error.message)) throw error;
  }, 4, 1000);
  await withRetry(async () => unwrap(await supabase.from('sound_events').update({
    status: 'ready', storage_path: path, duration_ms: meta.durationMs,
    peak_db: meta.peakDb, above_floor_db: meta.aboveFloorDb,
  }).eq('id', eventId)), 3);
}

export async function markEventFailed(eventId: string) {
  await supabase.from('sound_events').update({ status: 'failed' }).eq('id', eventId);
}

export async function listEvents(sinceHours = 24): Promise<SoundEvent[]> {
  const since = new Date(Date.now() - sinceHours * 3600_000).toISOString();
  return unwrap(await supabase.from('sound_events').select('*').gte('created_at', since)
    .order('created_at', { ascending: false }).limit(200)) as SoundEvent[];
}

export async function signedClipUrl(path: string): Promise<string> {
  const data = unwrap(await supabase.storage.from('recordings').createSignedUrl(path, 300)) as { signedUrl: string };
  return data.signedUrl;
}

export async function deleteEvent(e: SoundEvent) {
  if (e.storage_path) {
    const { error } = await supabase.storage.from('recordings').remove([e.storage_path]);
    if (error) throw error;
  }
  unwrap(await supabase.from('sound_events').delete().eq('id', e.id));
}

export async function deleteAllEvents(householdId: string, events: SoundEvent[]) {
  const paths = events.map((e) => e.storage_path).filter((p): p is string => !!p);
  for (let i = 0; i < paths.length; i += 100) {
    const { error } = await supabase.storage.from('recordings').remove(paths.slice(i, i + 100));
    if (error) throw error;
  }
  unwrap(await supabase.from('sound_events').delete().eq('household_id', householdId));
}

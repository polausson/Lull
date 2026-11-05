// Parent Unit controller: status polling, realtime sound events, playback URLs.
import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import * as api from '../lib/api';
import { log } from '../lib/log';
import { useOnline } from './useOnline';

const POLL_MS = 8_000;
export const STALE_AFTER_S = 35;

export type Link =
  | 'unknown'      // we (the parent) can't reach the server
  | 'listening'    // baby unit alive and microphone frames flowing
  | 'interrupted'  // baby unit wants to listen but mic/heartbeat is failing
  | 'idle'         // baby unit online, monitoring off
  | 'offline';     // no recent heartbeat and not monitoring

export function linkState(s: api.Status | null, reachable: boolean): Link {
  if (!reachable || !s) return 'unknown';
  const stale = s.heartbeat_age_seconds == null || s.heartbeat_age_seconds > STALE_AFTER_S;
  if (s.monitoring) return !stale && s.audio_ok ? 'listening' : 'interrupted';
  return stale ? 'offline' : 'idle';
}

export function useParentUnit(initial: api.Status) {
  const [status, setStatus] = useState<api.Status>(initial);
  const [reachable, setReachable] = useState(true);
  const [checkedAt, setCheckedAt] = useState(Date.now());
  const [events, setEvents] = useState<api.SoundEvent[]>([]);
  const [eventsLoaded, setEventsLoaded] = useState(false);
  const online = useOnline();
  const householdId = initial.household_id;

  const refreshStatus = useCallback(async () => {
    try {
      const s = await api.getStatus();
      if (s) setStatus(s);
      setReachable(true);
    } catch (e) {
      setReachable(false);
      log.warn('net', 'status poll failed', String(e));
    }
    setCheckedAt(Date.now());
  }, []);

  const refreshEvents = useCallback(async () => {
    try {
      setEvents(await api.listEvents(Math.max(24, status.retention_hours)));
      setEventsLoaded(true);
    } catch (e) {
      log.warn('net', 'events load failed', String(e));
    }
  }, [status.retention_hours]);

  useEffect(() => {
    void refreshStatus();
    const id = window.setInterval(() => { if (document.visibilityState === 'visible') void refreshStatus(); }, POLL_MS);
    const onVis = () => { if (document.visibilityState === 'visible') { void refreshStatus(); void refreshEvents(); } };
    document.addEventListener('visibilitychange', onVis);
    return () => { window.clearInterval(id); document.removeEventListener('visibilitychange', onVis); };
  }, [refreshStatus, refreshEvents]);

  useEffect(() => { if (online) { void refreshStatus(); void refreshEvents(); } else setReachable(false); }, [online, refreshStatus, refreshEvents]);

  useEffect(() => {
    void refreshEvents();
    const channel = supabase
      .channel(`events-${householdId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'sound_events', filter: `household_id=eq.${householdId}` }, (payload) => {
        if (payload.eventType === 'DELETE') {
          const id = (payload.old as { id: string }).id;
          setEvents((list) => list.filter((e) => e.id !== id));
          return;
        }
        const row = payload.new as api.SoundEvent;
        setEvents((list) => [row, ...list.filter((e) => e.id !== row.id)]
          .sort((a, b) => b.created_at.localeCompare(a.created_at)));
      })
      .subscribe((state) => {
        log.info('realtime', state);
        if (state === 'SUBSCRIBED') void refreshEvents(); // catch up on anything missed
      });
    return () => { void supabase.removeChannel(channel); };
  }, [householdId, refreshEvents]);

  const remove = useCallback(async (e: api.SoundEvent) => {
    setEvents((list) => list.filter((x) => x.id !== e.id));
    try { await api.deleteEvent(e); } catch (err) { log.error('events', 'delete failed', String(err)); void refreshEvents(); throw err; }
  }, [refreshEvents]);

  const removeAll = useCallback(async () => {
    const snapshot = events;
    setEvents([]);
    try { await api.deleteAllEvents(householdId, snapshot); } catch (err) { log.error('events', 'delete all failed', String(err)); void refreshEvents(); throw err; }
  }, [events, householdId, refreshEvents]);

  return {
    status, link: linkState(status, reachable && online), reachable: reachable && online, checkedAt,
    events, eventsLoaded, refreshStatus, refreshEvents, remove, removeAll, setStatus,
  };
}

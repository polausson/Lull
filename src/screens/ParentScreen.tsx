import { useCallback, useEffect, useRef, useState } from 'react';
import { useParentUnit, type Link } from '../hooks/useParentUnit';
import * as api from '../lib/api';
import * as push from '../lib/push';
import { log } from '../lib/log';
import { NightStrip } from '../components/NightStrip';
import { Button, Choice, Dot, GearIcon, IconButton, Notice, Panel, PauseIcon, PlayIcon, Sheet, Toggle } from '../components/ui';
import { ago, duration, intensity, secondsSince, timeOf } from '../lib/format';
import { Diagnostics, UnpairButton } from './Settings';

const LINK: Record<Link, { title: string; tone: 'sage' | 'amber' | 'coral' | 'faint'; body: string }> = {
  listening: { title: 'Listening', tone: 'sage', body: 'The baby unit is online and its microphone is working.' },
  interrupted: { title: 'Not listening', tone: 'coral', body: 'The baby unit was set to listen but has stopped. Check the phone in the nursery.' },
  idle: { title: 'Paused', tone: 'faint', body: 'The baby unit is open but not listening.' },
  offline: { title: 'Baby unit offline', tone: 'faint', body: 'It isn’t open or has no connection.' },
  unknown: { title: 'Status unknown', tone: 'amber', body: 'This phone can’t reach the server, so it can’t tell whether the baby unit is listening.' },
};

function usePlayer() {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const a = new Audio();
    a.preload = 'auto';
    a.addEventListener('ended', () => { setPlaying(null); setProgress(0); });
    a.addEventListener('timeupdate', () => setProgress(a.duration ? a.currentTime / a.duration : 0));
    a.addEventListener('error', () => { setPlaying(null); log.error('playback', 'audio error', a.error?.message); });
    audio.current = a;
    return () => { a.pause(); a.src = ''; };
  }, []);

  const toggle = useCallback(async (e: api.SoundEvent) => {
    const a = audio.current!;
    if (playing === e.id) { a.pause(); setPlaying(null); return; }
    if (!e.storage_path) return;
    setLoading(e.id);
    try {
      a.src = await api.signedClipUrl(e.storage_path);
      setProgress(0);
      await a.play();
      setPlaying(e.id);
    } catch (err) {
      log.error('playback', 'could not play', String(err));
    } finally {
      setLoading(null);
    }
  }, [playing]);

  return { playing, loading, progress, toggle };
}

function EventRow({ e, player, highlight, onDelete }: {
  e: api.SoundEvent; player: ReturnType<typeof usePlayer>; highlight: boolean; onDelete: () => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const ready = e.status === 'ready' && !!e.storage_path;
  const isPlaying = player.playing === e.id;
  const level = intensity(e.above_floor_db);
  return (
    <li id={`event-${e.id}`} className={`relative flex items-center gap-4 rounded-3xl px-3 py-3 transition ${highlight ? 'bg-raised' : ''}`}>
      <button
        onClick={() => player.toggle(e)} disabled={!ready}
        aria-label={isPlaying ? 'Pause' : `Play sound from ${timeOf(e.created_at)}`}
        className="grid size-12 shrink-0 place-items-center rounded-full bg-ink text-bg disabled:bg-raised disabled:text-faint"
      >
        {player.loading === e.id ? <span className="size-3 rounded-full bg-bg pulse-dot" /> : isPlaying ? <PauseIcon /> : <PlayIcon />}
      </button>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-3">
          <span className="text-[18px] tabular-nums">{timeOf(e.created_at)}</span>
          <span className="text-[14px] text-mist">
            {e.status === 'recording' ? 'Recording…' : e.status === 'failed' ? 'Clip not saved' : duration(e.duration_ms)}
          </span>
        </div>
        <div className="mt-2 h-[3px] w-full max-w-[160px] overflow-hidden rounded-full bg-raised" aria-label={`Intensity ${Math.round(level * 100)}%`}>
          <div className="h-full rounded-full bg-heather" style={{ width: `${isPlaying ? player.progress * 100 : 12 + level * 88}%`, opacity: isPlaying ? 1 : 0.7 }} />
        </div>
      </div>
      {confirm ? (
        <div className="flex gap-1">
          <button onClick={() => setConfirm(false)} className="min-h-11 rounded-full px-3 text-[14px] text-mist">Keep</button>
          <button onClick={onDelete} className="min-h-11 rounded-full px-3 text-[14px] text-coral">Delete</button>
        </div>
      ) : (
        <button onClick={() => setConfirm(true)} aria-label="Delete recording" className="grid size-11 place-items-center rounded-full text-faint active:bg-raised">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12" /></svg>
        </button>
      )}
    </li>
  );
}

function Alerts({ status, onChange }: { status: api.Status; onChange: () => void }) {
  const support = push.pushSupport();
  const [row, setRow] = useState<{ endpoint: string; sound_alerts: boolean } | null | undefined>(undefined);
  const [permission, setPermission] = useState(typeof Notification !== 'undefined' ? Notification.permission : 'default');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [r, sub] = await Promise.all([push.mySubscriptionRow(), push.currentSubscription()]);
      // Browser subscription changed (e.g. renewed)? Re-save it so pushes reach this device.
      if (sub && (!r || r.endpoint !== sub.endpoint)) { await push.saveSubscription(sub, r?.sound_alerts ?? true); setRow({ endpoint: sub.endpoint, sound_alerts: r?.sound_alerts ?? true }); }
      else setRow(sub ? r : null);
    } catch (e) { setRow(null); log.warn('push', 'load failed', String(e)); }
  }, []);
  useEffect(() => { if (support === 'supported') void load(); }, [load, support]);

  if (support === 'needs-install') {
    return (
      <Notice tone="amber" title="Add Lull to your Home Screen for alerts">
        iPhone only sends notifications to apps on the Home Screen. Tap the Share button, choose “Add to Home Screen”, then open Lull from there and pair again with a new code.
      </Notice>
    );
  }
  if (support === 'unsupported') return <Notice tone="amber" title="This browser can’t receive alerts">Use Safari (iOS 16.4+) from the Home Screen, or Chrome on Android.</Notice>;
  if (support === 'not-configured') return <Notice tone="amber" title="Alerts aren’t set up">This build is missing VITE_VAPID_PUBLIC_KEY.</Notice>;
  if (row === undefined) return null;

  if (!row) {
    return (
      <div>
        <p className="mb-4 text-[15px] leading-relaxed text-mist">
          {permission === 'denied'
            ? 'Notifications are blocked for Lull. Allow them in your phone’s settings, then come back.'
            : 'Get a notification when the baby unit hears something, or stops listening — even with this phone locked.'}
        </p>
        <Button disabled={busy || permission === 'denied'} onClick={async () => {
          setBusy(true); setError(null);
          try { const p = await push.enablePush(true); setPermission(p); await load(); onChange(); }
          catch (e) { setError((e as Error).message ?? String(e)); log.error('push', 'enable failed', String(e)); }
          finally { setBusy(false); }
        }}>Turn on alerts</Button>
        {error && <p className="mt-3 text-[14px] text-coral">{error}</p>}
      </div>
    );
  }

  return (
    <div className="divide-y divide-line">
      <Toggle
        label="Sound alerts" checked={row.sound_alerts}
        description={row.sound_alerts ? 'Notify me when the baby makes a sound' : 'Recordings are still saved'}
        onChange={async (v) => { setRow({ ...row, sound_alerts: v }); try { await push.setSoundAlerts(v); onChange(); } catch { setRow(row); } }}
      />
      <p className="pt-3 text-[13px] text-faint">Warnings when the baby unit stops listening are always on. {status.alert_device_count} phone{status.alert_device_count === 1 ? '' : 's'} receiving alerts.</p>
    </div>
  );
}

export function ParentScreen({ initial, onLeft, focusEventId }: { initial: api.Status; onLeft: () => void; focusEventId: string | null }) {
  const p = useParentUnit(initial);
  const player = usePlayer();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [focus, setFocus] = useState<string | null>(focusEventId);
  const [, tick] = useState(0);
  useEffect(() => { const id = setInterval(() => tick((n) => n + 1), 5000); return () => clearInterval(id); }, []);
  useEffect(() => setFocus(focusEventId), [focusEventId]);
  useEffect(() => {
    if (!focus) return;
    const el = document.getElementById(`event-${focus}`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const t = setTimeout(() => setFocus(null), 6000);
    return () => clearTimeout(t);
  }, [focus, p.events]);

  const link = LINK[p.link];
  const critical = p.link === 'interrupted';
  const last = p.events[0];
  const lastSeen = p.status.last_heartbeat ? p.status.heartbeat_age_seconds! + (Date.now() - p.checkedAt) / 1000 : null;

  return (
    <main className="safe min-h-full space-y-5">
      <header className="flex items-start justify-between">
        <div className="rise">
          <div className="flex items-center gap-2.5">
            <Dot color={link.tone} pulse={p.link === 'listening'} />
            <h1 className={`text-[34px] leading-tight font-light ${critical ? 'text-coral' : ''}`}>{link.title}</h1>
          </div>
          <p className="mt-1 pl-5 text-[15px] text-mist">
            {p.reachable ? `Last signal ${ago(lastSeen)}` : 'Checking connection…'}
          </p>
        </div>
        <IconButton label="Settings" onClick={() => setSettingsOpen(true)}><GearIcon /></IconButton>
      </header>

      {p.link !== 'listening' && (
        <Notice tone={critical ? 'coral' : p.link === 'unknown' ? 'amber' : 'mist'} title={critical ? 'The baby unit stopped listening' : link.body}>
          {critical ? (p.status.status_detail ? `Reported: ${p.status.status_detail}. ` : '') + link.body : undefined}
        </Notice>
      )}

      <Panel>
        <h2 className="text-[15px] text-mist">Last sound</h2>
        {last ? (
          <div className="mt-2 flex items-end justify-between gap-4">
            <div>
              <div className="whitespace-nowrap text-[clamp(32px,10vw,44px)] leading-none font-light tabular-nums">{timeOf(last.created_at)}</div>
              <div className="mt-2 text-[14px] text-mist">{ago(secondsSince(last.created_at))}</div>
            </div>
            <button
              onClick={() => player.toggle(last)} disabled={last.status !== 'ready'}
              className="flex min-h-12 items-center gap-2 rounded-full bg-ink px-5 text-[15px] text-bg disabled:bg-raised disabled:text-faint"
            >
              {player.playing === last.id ? <PauseIcon /> : <PlayIcon />}
              {last.status === 'recording' ? 'Recording' : player.playing === last.id ? 'Pause' : 'Listen'}
            </button>
          </div>
        ) : (
          <p className="mt-2 text-[16px] text-mist">{p.eventsLoaded ? 'Nothing heard yet.' : 'Loading…'}</p>
        )}
        <div className="mt-6"><NightStrip events={p.events} onSelect={(e) => setFocus(e.id)} /></div>
      </Panel>

      <Panel>
        <h2 className="mb-3 text-[17px]">Alerts</h2>
        <Alerts status={p.status} onChange={p.refreshStatus} />
      </Panel>

      {p.events.length > 0 && (
        <section>
          <h2 className="mb-2 px-1 text-[17px]">Recordings</h2>
          <ul className="space-y-1">
            {p.events.map((e) => (
              <EventRow key={e.id} e={e} player={player} highlight={focus === e.id} onDelete={() => void p.remove(e)} />
            ))}
          </ul>
          <p className="mt-3 px-1 text-[13px] text-faint">Recordings are deleted automatically after {p.status.retention_hours} hours.</p>
        </section>
      )}

      <p className="px-1 pt-2 text-[13px] leading-relaxed text-faint">Lull is not a medical device and can miss sounds or alerts.</p>

      <Sheet open={settingsOpen} onClose={() => setSettingsOpen(false)} title="Parent unit">
        <div className="space-y-6">
          <Choice
            label="Keep recordings for"
            value={p.status.retention_hours}
            options={[{ id: 12, label: '12 h' }, { id: 24, label: '24 h' }, { id: 72, label: '3 days' }, { id: 168, label: '7 days' }]}
            onChange={async (h) => { p.setStatus({ ...p.status, retention_hours: h }); await api.setRetention(h).catch(() => undefined); void p.refreshStatus(); }}
          />
          {p.events.length > 0 && <Button tone="danger" onClick={() => void p.removeAll()}>Delete all recordings</Button>}
          <Diagnostics />
          <UnpairButton role="parent" onLeft={async () => { await push.disablePush().catch(() => undefined); onLeft(); }} />
        </div>
      </Sheet>
    </main>
  );
}

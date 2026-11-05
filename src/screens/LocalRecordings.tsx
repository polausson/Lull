// Recordings list for the one-phone trial: clips live in this phone's IndexedDB.
import { useCallback, useEffect, useRef, useState } from 'react';
import { localStore } from '../lib/backend';
import type { SoundEvent } from '../lib/api';
import { Panel, PauseIcon, PlayIcon } from '../components/ui';
import { duration, intensity, timeOf } from '../lib/format';
import { log } from '../lib/log';

export function LocalRecordings() {
  const [events, setEvents] = useState<SoundEvent[]>([]);
  const [playing, setPlaying] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const audio = useRef<HTMLAudioElement | null>(null);
  const url = useRef<string | null>(null);

  const load = useCallback(() => {
    localStore.list().then(setEvents).catch((e) => log.error('local', 'could not read recordings', String(e)));
  }, []);
  useEffect(() => { load(); return localStore.subscribe(load); }, [load]);

  useEffect(() => {
    const a = new Audio();
    a.addEventListener('ended', () => { setPlaying(null); setProgress(0); });
    a.addEventListener('timeupdate', () => setProgress(a.duration ? a.currentTime / a.duration : 0));
    audio.current = a;
    return () => { a.pause(); if (url.current) URL.revokeObjectURL(url.current); };
  }, []);

  const toggle = async (e: SoundEvent) => {
    const a = audio.current!;
    if (playing === e.id) { a.pause(); setPlaying(null); return; }
    const full = await localStore.get(e.id);
    if (!full?.wav) return;
    if (url.current) URL.revokeObjectURL(url.current);
    url.current = URL.createObjectURL(full.wav);
    a.src = url.current;
    setProgress(0);
    try { await a.play(); setPlaying(e.id); } catch (err) { log.error('playback', 'could not play', String(err)); }
  };

  return (
    <Panel>
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-[17px]">Recordings</h2>
        {events.length > 0 && <button onClick={() => void localStore.clear()} className="min-h-11 rounded-full px-4 text-[15px] text-mist active:bg-raised">Delete all</button>}
      </div>
      {events.length === 0 ? (
        <p className="text-[15px] leading-relaxed text-mist">Nothing heard yet. Start listening and clap or talk near the phone: a clip appears here about 15 seconds later.</p>
      ) : (
        <ul className="-mx-2 space-y-1">
          {events.map((e) => {
            const ready = e.status === 'ready';
            const on = playing === e.id;
            return (
              <li key={e.id} className="flex items-center gap-4 rounded-3xl px-2 py-2">
                <button onClick={() => void toggle(e)} disabled={!ready} aria-label={on ? 'Pause' : `Play sound from ${timeOf(e.created_at)}`}
                  className="grid size-11 shrink-0 place-items-center rounded-full bg-ink text-bg disabled:bg-raised disabled:text-faint">
                  {on ? <PauseIcon /> : <PlayIcon />}
                </button>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-3">
                    <span className="text-[17px] tabular-nums">{timeOf(e.created_at)}</span>
                    <span className="text-[14px] text-mist">{e.status === 'recording' ? 'Recording…' : e.status === 'failed' ? 'Clip not saved' : duration(e.duration_ms)}</span>
                  </div>
                  <div className="mt-2 h-[3px] w-full max-w-[160px] overflow-hidden rounded-full bg-raised">
                    <div className="h-full rounded-full bg-heather" style={{ width: `${on ? progress * 100 : 12 + intensity(e.above_floor_db) * 88}%` }} />
                  </div>
                </div>
                <button onClick={() => void localStore.remove(e.id)} aria-label="Delete recording" className="grid size-11 place-items-center rounded-full text-faint active:bg-raised">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12" /></svg>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

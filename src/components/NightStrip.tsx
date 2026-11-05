// Sound activity over the last N hours: a single quiet strip, one tick per event, height = intensity.
import type { SoundEvent } from '../lib/api';
import { intensity } from '../lib/format';

export function NightStrip({ events, hours = 12, now = Date.now(), onSelect }: {
  events: SoundEvent[]; hours?: number; now?: number; onSelect?: (e: SoundEvent) => void;
}) {
  const span = hours * 3600_000;
  const start = now - span;
  const marks = [0, hours / 3, (2 * hours) / 3, hours].map((h) => new Date(start + h * 3600_000));
  const visible = events.filter((e) => new Date(e.created_at).getTime() >= start);
  return (
    <div>
      <div className="relative h-16 rounded-2xl bg-raised/50" role="img" aria-label={`${visible.length} sounds in the last ${hours} hours`}>
        {visible.map((e) => {
          const x = ((new Date(e.created_at).getTime() - start) / span) * 100;
          const h = 18 + intensity(e.above_floor_db) * 70;
          return (
            <button
              key={e.id} onClick={() => onSelect?.(e)} aria-label="Sound"
              className="absolute bottom-0 w-3 -translate-x-1/2"
              style={{ left: `${x}%`, height: '100%' }}
            >
              <span className="absolute bottom-2 left-1/2 w-[3px] -translate-x-1/2 rounded-full bg-heather" style={{ height: `${h}%` }} />
            </button>
          );
        })}
      </div>
      <div className="mt-2 flex justify-between text-[12px] text-faint">
        {marks.map((d, i) => (
          <span key={i}>{i === 3 ? 'Now' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
        ))}
      </div>
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import { log } from '../lib/log';

/** Keeps the screen on while `enabled`. Re-acquires after returning to the app. */
export function useWakeLock(enabled: boolean) {
  const supported = typeof navigator !== 'undefined' && 'wakeLock' in navigator;
  const [active, setActive] = useState(false);
  const sentinel = useRef<WakeLockSentinel | null>(null);

  useEffect(() => {
    if (!supported) return;
    let cancelled = false;
    const acquire = async () => {
      if (!enabled || document.visibilityState !== 'visible' || sentinel.current) return;
      try {
        const s = await navigator.wakeLock.request('screen');
        if (cancelled) { s.release(); return; }
        sentinel.current = s;
        setActive(true);
        s.addEventListener('release', () => { sentinel.current = null; setActive(false); });
      } catch (e) {
        log.warn('wakelock', 'request failed', String(e));
        setActive(false);
      }
    };
    const onVis = () => { if (document.visibilityState === 'visible') acquire(); };
    if (enabled) acquire();
    else { sentinel.current?.release(); sentinel.current = null; }
    document.addEventListener('visibilitychange', onVis);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [enabled, supported]);

  useEffect(() => () => { sentinel.current?.release(); }, []);
  return { supported, active };
}

// Baby unit shows a code; parent unit types it in.
import { useCallback, useEffect, useState } from 'react';
import * as api from '../lib/api';
import { Button, Notice } from '../components/ui';
import { deviceLabel } from '../lib/format';

export function ShowCode({ onDone, parentCount, refresh, firstRun }: {
  onDone: () => void; parentCount: number; refresh: () => Promise<void>; firstRun: boolean;
}) {
  const [code, setCode] = useState<{ code: string; expires_at: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [startCount] = useState(parentCount);

  const issue = useCallback(async () => {
    setError(null);
    try { setCode(await api.createPairingCode()); } catch (e) { setError((e as Error).message); }
  }, []);

  useEffect(() => { void issue(); }, [issue]);
  useEffect(() => {
    const id = setInterval(() => { setNow(Date.now()); void refresh(); }, 3000);
    return () => clearInterval(id);
  }, [refresh]);

  const remaining = code ? Math.max(0, Math.round((new Date(code.expires_at).getTime() - now) / 1000)) : 0;
  const joined = parentCount > startCount;

  return (
    <main className="safe flex min-h-full flex-col">
      <div className="rise mt-[8vh]">
        <h1 className="text-[32px] font-light leading-tight">{joined ? 'Parent phone connected' : 'Pair a parent phone'}</h1>
        <p className="mt-3 max-w-[32ch] text-[16px] leading-relaxed text-mist">
          {joined
            ? 'That phone will now get alerts and recordings from this one.'
            : 'On the other phone, open Lull, choose Parent unit, and enter this code.'}
        </p>
      </div>

      {!joined && (
        <div className="mt-12 text-center">
          <div aria-live="polite" className="whitespace-nowrap text-[clamp(34px,11vw,48px)] font-light tracking-[0.06em] tabular-nums select-all">
            {code && remaining > 0 ? code.code : '····-····'}
          </div>
          <div className="mt-3 text-[14px] text-mist">
            {code && remaining > 0 ? `Expires in ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}` : 'Code expired'}
          </div>
          {(!code || remaining === 0) && (
            <button onClick={issue} className="mt-4 min-h-11 rounded-full px-5 text-[15px] text-ink underline underline-offset-4">New code</button>
          )}
        </div>
      )}
      {error && <div className="mt-6"><Notice tone="coral" title="Couldn't create a code">{error}</Notice></div>}

      <div className="mt-auto space-y-3 pt-10">
        <Button tone={joined ? 'primary' : 'quiet'} onClick={onDone}>
          {joined ? 'Continue' : firstRun ? 'Skip for now' : 'Done'}
        </Button>
      </div>
    </main>
  );
}

export function EnterCode({ onPaired, onBack }: { onPaired: () => Promise<void>; onBack: () => void }) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const clean = value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  const shown = clean.length > 4 ? `${clean.slice(0, 4)}-${clean.slice(4)}` : clean;

  const submit = async () => {
    setBusy(true); setError(null);
    try {
      const ok = await api.claimPairingCode(clean, deviceLabel());
      if (!ok) { setError('That code didn’t work. Check it, or create a new one on the baby unit.'); setBusy(false); return; }
      await onPaired();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <main className="safe flex min-h-full flex-col">
      <button onClick={onBack} className="-ml-3 min-h-11 self-start rounded-full px-3 text-[15px] text-mist">Back</button>
      <div className="rise mt-[6vh]">
        <h1 className="text-[32px] font-light">Enter the code</h1>
        <p className="mt-3 text-[16px] text-mist">It’s on the baby unit’s screen.</p>
      </div>
      <form className="mt-10" onSubmit={(e) => { e.preventDefault(); if (clean.length === 8) void submit(); }}>
        <input
          autoFocus inputMode="text" autoCapitalize="characters" autoComplete="one-time-code" spellCheck={false}
          aria-label="Pairing code" placeholder="XXXX-XXXX" value={shown}
          onChange={(e) => setValue(e.target.value)}
          className="w-full rounded-3xl bg-surface px-5 py-5 text-center text-[34px] font-light tracking-[0.12em] tabular-nums outline-none placeholder:text-faint focus:ring-2 focus:ring-sage"
        />
        {error && <div className="mt-4"><Notice tone="amber" title="Not paired">{error}</Notice></div>}
        <div className="mt-6"><Button type="submit" disabled={clean.length !== 8 || busy}>{busy ? 'Pairing…' : 'Pair'}</Button></div>
      </form>
    </main>
  );
}

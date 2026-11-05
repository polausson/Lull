import { useState } from 'react';
import { Notice } from '../components/ui';

export function Welcome({ configured, onBaby, onParent, onTrial }: {
  configured: boolean; onBaby: () => Promise<void>; onParent: () => void; onTrial: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const card = 'w-full rounded-[28px] bg-surface p-5 text-left active:bg-raised disabled:opacity-50';
  return (
    <main className="safe flex min-h-full flex-col">
      <div className="rise mt-[12vh]">
        <h1 className="text-[44px] leading-[1.05] font-light tracking-[-0.02em]">Lull</h1>
        <p className="mt-4 max-w-[30ch] text-[18px] leading-relaxed text-mist">
          {configured ? 'Two phones, one quiet night. Choose what this phone will do.' : 'A quiet baby monitor. Try listening, recordings and sleep sounds on this phone.'}
        </p>
      </div>

      <div className="mt-auto space-y-3 pt-10">
        {configured ? (<>
          <button
            disabled={busy} className={card}
            onClick={async () => { setBusy(true); setError(null); try { await onBaby(); } catch (e) { setError(String((e as Error).message ?? e)); setBusy(false); } }}
          >
            <span className="block text-[20px]">Baby unit</span>
            <span className="mt-1 block text-[15px] text-mist">Stays in the nursery and listens. Plays sleep sounds.</span>
          </button>
          <button onClick={onParent} className={card}>
            <span className="block text-[20px]">Parent unit</span>
            <span className="mt-1 block text-[15px] text-mist">Stays with you. Alerts you and plays back what it heard.</span>
          </button>
          <button onClick={onTrial} className="min-h-12 w-full text-[15px] text-mist">Try it on this phone only</button>
        </>) : (<>
          <button onClick={onTrial} className={card}>
            <span className="block text-[20px]">Try on this phone</span>
            <span className="mt-1 block text-[15px] text-mist">Listens, records sounds and plays sleep sounds. Recordings stay on this phone.</span>
          </button>
          <p className="px-1 text-[14px] leading-relaxed text-mist">Alerts to a second phone turn on once Lull is connected to its server.</p>
        </>)}
        {error && <Notice tone="coral" title="Couldn't set up this phone">{error}</Notice>}
        <p className="px-1 pt-4 text-[13px] leading-relaxed text-faint">
          Lull is not a medical device and can miss sounds. It does not replace supervision or a certified monitor.
        </p>
      </div>
    </main>
  );
}

export function NotConfigured() {
  return (
    <main className="safe">
      <h1 className="mt-[10vh] text-[32px] font-light">Almost there</h1>
      <p className="mt-4 text-mist leading-relaxed">
        This build has no backend configured. Add <code>VITE_SUPABASE_URL</code>, <code>VITE_SUPABASE_ANON_KEY</code> and{' '}
        <code>VITE_VAPID_PUBLIC_KEY</code> to <code>.env</code> and rebuild. See README.md.
      </p>
    </main>
  );
}


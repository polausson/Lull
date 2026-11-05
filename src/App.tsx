import { useCallback, useEffect, useState } from 'react';
import { configured } from './lib/supabase';
import * as api from './lib/api';
import { log } from './lib/log';
import { deviceLabel } from './lib/format';
import { Welcome } from './screens/Welcome';
import { useStored } from './hooks/useStored';
import { ShowCode, EnterCode } from './screens/PairCode';
import { BabyScreen } from './screens/BabyScreen';
import { ParentScreen } from './screens/ParentScreen';
import { Button } from './components/ui';

type View =
  | { name: 'loading' }
  | { name: 'error'; message: string }
  | { name: 'welcome' }
  | { name: 'enter-code' }
  | { name: 'show-code'; firstRun: boolean }
  | { name: 'home' };

function eventFromUrl() {
  return new URLSearchParams(location.search).get('event');
}

export default function App() {
  const [view, setView] = useState<View>({ name: 'loading' });
  const [status, setStatus] = useState<api.Status | null>(null);
  const [focusEvent, setFocusEvent] = useState<string | null>(eventFromUrl());
  const [trial, setTrial] = useStored('lull-trial', false);

  const load = useCallback(async () => {
    const s = await api.getStatus();
    setStatus(s);
    return s;
  }, []);

  const boot = useCallback(async () => {
    setView({ name: 'loading' });
    try {
      await api.ensureSession();
      const s = await load();
      setView(s ? { name: 'home' } : { name: 'welcome' });
    } catch (e) {
      log.error('app', 'startup failed', String(e));
      setView({ name: 'error', message: (e as Error).message ?? String(e) });
    }
  }, [load]);

  useEffect(() => { if (configured && !trial) void boot(); }, [boot, trial]);

  // Notification taps while the app is already open arrive from the service worker.
  useEffect(() => {
    const onMsg = (ev: MessageEvent) => {
      if (ev.data?.type === 'open-event') setFocusEvent(ev.data.eventId ?? null);
    };
    navigator.serviceWorker?.addEventListener('message', onMsg);
    if (eventFromUrl()) history.replaceState(null, '', location.pathname); // keeps the /<repo>/ base
    return () => navigator.serviceWorker?.removeEventListener('message', onMsg);
  }, []);

  if (trial) return <BabyScreen demo status={null} onPair={() => undefined} onLeft={() => setTrial(false)} />;
  if (!configured) return <Welcome configured={false} onBaby={async () => undefined} onParent={() => undefined} onTrial={() => setTrial(true)} />;

  switch (view.name) {
    case 'loading':
      return <main className="grid min-h-full place-items-center"><span className="size-3 rounded-full bg-mist pulse-dot" aria-label="Loading" /></main>;
    case 'error':
      return (
        <main className="safe flex min-h-full flex-col justify-center gap-6">
          <div>
            <h1 className="text-[28px] font-light">Can’t reach Lull’s server</h1>
            <p className="mt-2 text-mist">{view.message}</p>
          </div>
          <Button onClick={boot}>Try again</Button>
        </main>
      );
    case 'welcome':
      return (
        <Welcome
          configured
          onTrial={() => setTrial(true)}
          onBaby={async () => { await api.createHousehold(deviceLabel()); await load(); setView({ name: 'show-code', firstRun: true }); }}
          onParent={() => setView({ name: 'enter-code' })}
        />
      );
    case 'enter-code':
      return <EnterCode onBack={() => setView({ name: 'welcome' })} onPaired={async () => { await load(); setView({ name: 'home' }); }} />;
    case 'show-code':
      return (
        <ShowCode
          firstRun={view.firstRun}
          parentCount={status?.parent_count ?? 0}
          refresh={async () => { await load().catch(() => undefined); }}
          onDone={() => setView({ name: 'home' })}
        />
      );
    case 'home':
      if (!status) return <Welcome configured onTrial={() => setTrial(true)} onBaby={async () => undefined} onParent={() => setView({ name: 'enter-code' })} />;
      return status.role === 'baby'
        ? <BabyScreen status={status} onPair={() => setView({ name: 'show-code', firstRun: false })} onLeft={() => { setStatus(null); setView({ name: 'welcome' }); }} />
        : <ParentScreen initial={status} focusEventId={focusEvent} onLeft={() => { setStatus(null); setView({ name: 'welcome' }); }} />;
  }
}

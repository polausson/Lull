import { useEffect, useState, useSyncExternalStore } from 'react';
import { log } from '../lib/log';
import * as api from '../lib/api';
import { Button } from '../components/ui';

export function Diagnostics() {
  const [open, setOpen] = useState(false);
  const entries = useSyncExternalStore(log.subscribe, log.entries);
  const [copied, setCopied] = useState(false);
  useEffect(() => { if (copied) { const t = setTimeout(() => setCopied(false), 1500); return () => clearTimeout(t); } }, [copied]);
  return (
    <div>
      <button onClick={() => setOpen(!open)} className="flex min-h-12 w-full items-center justify-between text-left text-[16px]" aria-expanded={open}>
        Diagnostics <span className="text-[14px] text-mist">{((n) => (n === 0 ? 'No problems' : `${n} warning${n === 1 ? '' : 's'}`))(entries.filter((e) => e.level !== 'info').length)}</span>
      </button>
      {open && (
        <div className="mt-2">
          <pre className="max-h-64 overflow-auto rounded-2xl bg-bg p-3 font-sans text-[12px] leading-relaxed whitespace-pre-wrap text-mist select-text">
            {entries.slice(-120).reverse().map((e) => (
              <div key={e.t + e.msg} className={e.level === 'error' ? 'text-coral' : e.level === 'warn' ? 'text-amber' : ''}>
                {new Date(e.t).toLocaleTimeString()} {e.area}: {e.msg}{e.data ? ` ${e.data}` : ''}
              </div>
            ))}
          </pre>
          <button className="mt-2 min-h-11 text-[14px] text-mist underline underline-offset-4"
            onClick={() => navigator.clipboard?.writeText(log.asText()).then(() => setCopied(true))}>
            {copied ? 'Copied' : 'Copy log'}
          </button>
        </div>
      )}
    </div>
  );
}

export function UnpairButton({ onLeft, role }: { onLeft: () => void; role: api.Role }) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!confirm) return <Button tone="danger" onClick={() => setConfirm(true)}>Unpair this phone</Button>;
  return (
    <div className="rounded-3xl border border-line p-4">
      <p className="text-[15px] leading-relaxed text-mist">
        {role === 'baby'
          ? 'This phone stops being the baby unit. Parent phones will show it as offline. Recordings stay until they expire.'
          : 'This phone stops getting alerts and recordings. You’ll need a new code to pair again.'}
      </p>
      <div className="mt-3 flex gap-2">
        <Button tone="quiet" onClick={() => setConfirm(false)}>Cancel</Button>
        <Button tone="danger" disabled={busy} onClick={async () => { setBusy(true); try { await api.leaveHousehold(); onLeft(); } finally { setBusy(false); } }}>Unpair</Button>
      </div>
    </div>
  );
}

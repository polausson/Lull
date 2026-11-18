import { useMemo, useState } from 'react';
import { useBabyUnit } from '../hooks/useBabyUnit';
import { Orb } from '../components/Orb';
import { Button, Choice, Dot, IconButton, GearIcon, Notice, Panel, Segmented, Sheet, Slider } from '../components/ui';
import { NOISES } from '../audio/noise';
import type { MicError } from '../audio/monitor';
import type { Status } from '../lib/api';
import { isIOS } from '../lib/push';
import { timeOf } from '../lib/format';
import { Diagnostics, UnpairButton } from './Settings';
import { localBackend, remoteBackend } from '../lib/backend';
import { LocalRecordings } from './LocalRecordings';

const MIC_ERRORS: Record<MicError, { title: string; body: string }> = {
  denied: { title: 'Microphone access is off', body: 'Allow microphone access for this site in your browser settings, then try again. On iPhone: Settings → Apps → Safari → Microphone.' },
  'no-mic': { title: 'No microphone found', body: 'This device has no usable microphone.' },
  'in-use': { title: 'Microphone is busy', body: 'Another app (a call, a recorder) is using it. Close that app and try again.' },
  insecure: { title: 'Needs a secure connection', body: 'Open Lull over https:// to use the microphone.' },
  unsupported: { title: 'This browser can’t listen', body: 'Use a recent Safari (iOS 16.4+) or Chrome.' },
  ended: { title: 'Microphone stopped', body: 'The system turned the microphone off.' },
  unknown: { title: 'Couldn’t start listening', body: 'Something went wrong starting the microphone. Try again.' },
};

const STATE_TEXT = {
  calibrating: 'Learning the room’s sound',
  silence: 'Quiet',
  background: 'Background noise',
  sound: 'Sound',
} as const;

export function BabyScreen({ status, onPair, onLeft, demo = false }: { status: Status | null; onPair: () => void; onLeft: () => void; demo?: boolean }) {
  const householdId = status?.household_id;
  const backend = useMemo(() => (demo || !householdId ? localBackend : remoteBackend(householdId)), [demo, householdId]);
  const b = useBabyUnit(backend);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [dim, setDim] = useState(false);

  const broken = b.intent && !b.listening;
  const connected = demo || (b.online && b.serverOk !== false);
  const headline = !b.intent ? 'Not listening' : broken ? 'Listening stopped' : 'Listening';
  const sub = !b.intent
    ? 'Start when the baby is settled.'
    : broken
      ? b.health.reason ?? 'The microphone isn’t delivering audio.'
      : b.recording ? 'Sound — recording a clip' : STATE_TEXT[b.audioState];

  return (
    <main className="safe flex min-h-full flex-col">
      <header className="flex items-start justify-between">
        <div className="rise">
          <div className="flex items-center gap-2.5">
            <Dot color={!b.intent ? 'faint' : broken ? 'coral' : b.audioState === 'sound' ? 'heather' : 'sage'} pulse={b.listening} />
            <h1 className={`text-[34px] leading-tight font-light ${broken ? 'text-coral' : ''}`}>{headline}</h1>
          </div>
          <p className="mt-1 pl-5 text-[16px] text-mist" aria-live="polite">{sub}</p>
        </div>
        <IconButton label="Settings" onClick={() => setSettingsOpen(true)}><GearIcon /></IconButton>
      </header>

      <div className="flex flex-1 items-center justify-center py-6">
        <Orb frameRef={b.frameRef} live={b.listening} hot={b.audioState === 'sound'} />
      </div>

      <div className="space-y-4">
        {b.micError && <Notice tone="coral" title={MIC_ERRORS[b.micError].title}>{MIC_ERRORS[b.micError].body}</Notice>}
        {broken && (
          <Notice tone="coral" title={demo ? 'Nothing is being recorded right now' : 'Parent phones are alerted if this lasts over a minute'}>
            Keep Lull open on screen. {isIOS() ? 'iPhone stops the microphone when the screen locks or you switch apps.' : ''}
          </Notice>
        )}

        {broken || b.needsResume
          ? <Button onClick={b.start}>Resume listening</Button>
          : b.intent
            ? <Button tone="quiet" onClick={b.stop}>Stop listening</Button>
            : <Button onClick={b.start}>Start listening</Button>}

        {b.intent && !broken && (
          <button onClick={() => setDim(true)} className="min-h-11 w-full text-[15px] text-mist">Dim screen</button>
        )}

        <Panel>
          <Slider
            label="Sensitivity" value={b.settings.sensitivity}
            hint={b.settings.sensitivity > 0.75 ? 'Picks up small sounds' : b.settings.sensitivity < 0.3 ? 'Only loud crying' : 'Balanced'}
            onChange={(v) => b.setSettings((s) => ({ ...s, sensitivity: v }))}
          />
        </Panel>

        <Panel>
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-[17px]">Sleep sounds</h2>
            {b.noisePlaying && <button onClick={b.stopNoise} className="min-h-11 rounded-full px-4 text-[15px] text-mist active:bg-raised">Turn off</button>}
          </div>
          <Segmented label="Sleep sound" options={NOISES} value={b.noisePlaying ? b.noise.kind : null} onChange={(k) => void b.playNoise(k)} />
          <div className="mt-3"><Slider label="Volume" value={b.noise.volume} onChange={b.setNoiseVolume} /></div>
        </Panel>

        {demo && <LocalRecordings />}

        <div className="space-y-2 px-1 pb-2 text-[14px] text-mist">
          {demo ? (
            <div className="flex items-center gap-2"><Dot color="amber" />One-phone trial: no alerts, recordings stay on this phone for 24 hours</div>
          ) : (<>
          <div className="flex items-center gap-2"><Dot color={connected ? 'sage' : 'coral'} />{connected ? 'Online' : 'Offline — alerts can’t reach the parent phone'}</div>
          <div className="flex items-center gap-2">
            <Dot color={status && status.alert_device_count > 0 ? 'sage' : 'amber'} />
            {status && status.alert_device_count > 0
              ? `Alerts go to ${status.alert_device_count} parent phone${status.alert_device_count > 1 ? 's' : ''}`
              : status && status.parent_count > 0 ? 'Parent phone paired, but alerts are off there' : 'No parent phone paired yet'}
          </div>
          </>)}
          {b.lastSoundAt && <div className="flex items-center gap-2"><Dot color="heather" />Last sound {timeOf(b.lastSoundAt)}</div>}
          {b.pendingUploads > 0 && !demo && <div className="flex items-center gap-2"><Dot color="faint" pulse />Saving recording…</div>}
          {b.intent && (!b.wake.supported || !b.wake.active) && (
            <p className="pt-2 text-amber">
              This phone may lock itself. {isIOS() ? 'Set Settings → Display & Brightness → Auto-Lock to Never while it’s the baby unit.' : 'Turn off screen timeout while it’s the baby unit.'}
            </p>
          )}
          <p className="pt-2 text-faint">Keep this phone plugged in with Lull open. Not a medical device.</p>
        </div>
      </div>

      {dim && (
        <button
          aria-label="Wake screen" onClick={() => setDim(false)}
          className="fixed inset-0 z-50 flex flex-col items-center justify-end bg-black pb-[max(env(safe-area-inset-bottom),40px)] text-[13px]"
          style={{ color: '#3a3f4a' }}
        >
          <span className="flex items-center gap-2">
            <Dot color={b.listening ? 'sage' : 'coral'} />
            {b.listening ? 'Listening — tap to wake' : 'Listening stopped — tap'}
          </span>
        </button>
      )}

      <Sheet open={settingsOpen} onClose={() => setSettingsOpen(false)} title={demo ? 'One-phone trial' : 'Baby unit'}>
        <div className="space-y-6">
          <Choice
            label="Recording after a sound"
            value={b.settings.postRollS}
            options={[{ id: 10, label: '10 s' }, { id: 15, label: '15 s' }, { id: 20, label: '20 s' }]}
            onChange={(v) => b.setSettings((s) => ({ ...s, postRollS: v }))}
          />
          <p className="-mt-3 text-[13px] text-faint">Each clip also includes the 5 seconds before the sound, and keeps recording while it continues.</p>
          {!demo && <><Choice
            label="Wait between alerts"
            value={b.settings.cooldownS}
            options={[{ id: 30, label: '30 s' }, { id: 60, label: '1 min' }, { id: 120, label: '2 min' }, { id: 300, label: '5 min' }]}
            onChange={(v) => b.setSettings((s) => ({ ...s, cooldownS: v }))}
          />
          <p className="-mt-3 text-[13px] text-faint">Sounds during this time are still recorded, without another alert.</p></>}
          {!demo && <Button tone="quiet" onClick={() => { setSettingsOpen(false); onPair(); }}>Pair another parent phone</Button>}
          <div className="flex items-center justify-between text-[16px]">
            <span>Microphone</span>
            <span className={`text-[15px] ${b.permission === 'denied' ? 'text-coral' : 'text-mist'}`}>
              {b.permission === 'denied' ? 'Blocked in browser settings' : b.permission === 'granted' ? 'Allowed' : 'Asked when you start'}
            </span>
          </div>
          <Diagnostics />
          {demo
            ? <Button tone="quiet" onClick={() => { b.stop(); b.stopNoise(); onLeft(); }}>Leave trial</Button>
            : <UnpairButton onLeft={() => { b.stop(); onLeft(); }} role="baby" />}
        </div>
      </Sheet>
    </main>
  );
}

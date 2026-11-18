// One AudioContext shared by microphone analysis and white noise playback.
// Must first be created/resumed inside a user gesture (iOS requirement).

let ctx: AudioContext | null = null;

type AudioSessionNav = Navigator & { audioSession?: { type: string } };

export function getAudioContext(): AudioContext {
  if (!ctx || ctx.state === 'closed') {
    // Safari ≥16.4: tell iOS we both play and record, so playback isn't ducked/muted by capture.
    const nav = navigator as AudioSessionNav;
    try { if (nav.audioSession) nav.audioSession.type = 'play-and-record'; } catch { /* unsupported */ }
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    ctx = new AC({ latencyHint: 'playback' });
  }
  return ctx;
}

/** Halts all audio output immediately (used when the app leaves the screen). */
export function suspendAudio() {
  if (ctx && ctx.state === 'running') ctx.suspend().catch(() => undefined);
}

/** Resolves true if audio is running within `ms` (iOS may refuse without a tap). */
export async function tryResumeAudio(ms = 800): Promise<boolean> {
  const c = getAudioContext();
  if (c.state === 'running') return true;
  await Promise.race([c.resume().catch(() => undefined), new Promise((r) => setTimeout(r, ms))]);
  return (c.state as string) === 'running';
}

export async function resumeAudio(): Promise<AudioContext> {
  const c = getAudioContext();
  if (c.state !== 'running') await c.resume();
  return c;
}

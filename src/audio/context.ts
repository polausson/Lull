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

export async function resumeAudio(): Promise<AudioContext> {
  const c = getAudioContext();
  if (c.state !== 'running') await c.resume();
  return c;
}

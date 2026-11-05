// Microphone monitoring engine: capture → level → detection → pre/post-roll clip capture.
// Health is derived from actual audio frames arriving, never from intent.
import { resumeAudio } from './context';
import { SoundDetector, rmsDb, type AudioState, type DetectorFrame } from './detector';
import { Resampler, RingBuffer, concatFloat32, normalize } from './pcm';
import { log } from '../lib/log';

export const CLIP_SAMPLE_RATE = 16000;
const PRE_ROLL_S = 5;
const EXTEND_S = 6;     // continued sound keeps the clip open this long after it stops
const MAX_CLIP_S = 45;
const STALL_MS = 2500;  // no frames for this long ⇒ microphone is not working

export type MicError = 'denied' | 'no-mic' | 'in-use' | 'insecure' | 'unsupported' | 'ended' | 'unknown';

export interface Health {
  audioOk: boolean;
  reason: string | null; // human-readable when not ok
}

export interface ClipStart {
  startedAt: Date;
  levelDb: number;
  aboveFloorDb: number;
}

export interface Clip {
  samples: Float32Array;
  sampleRate: number;
  durationMs: number;
  peakDb: number;
  aboveFloorDb: number;
  interrupted: boolean;
}

export interface MonitorCallbacks {
  onFrame?: (f: DetectorFrame) => void;
  onHealth?: (h: Health) => void;
  onClipStart?: (c: ClipStart) => void;
  onClipEnd?: (c: Clip) => void;
}

interface Recording {
  chunks: Float32Array[];
  samples: number;
  remainingMs: number;
  peakDb: number;
  aboveFloorDb: number;
}

export class MonitorEngine {
  private detector: SoundDetector;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private worklet: AudioWorkletNode | null = null;
  private sink: GainNode | null = null;
  private resampler: Resampler | null = null;
  private ring = new RingBuffer(CLIP_SAMPLE_RATE * PRE_ROLL_S);
  private rec: Recording | null = null;
  private lastChunkAt = 0;
  private healthTimer: number | undefined;
  private health: Health = { audioOk: false, reason: 'not started' };
  private trackMuted = false;
  private postRollMs = 12000;
  private static loadedContexts = new WeakSet<BaseAudioContext>();

  constructor(private cb: MonitorCallbacks, sensitivity: number) {
    this.detector = new SoundDetector({ sensitivity });
  }

  get running() {
    return this.stream !== null;
  }

  setCallbacks(cb: MonitorCallbacks) {
    this.cb = cb;
  }

  setSensitivity(s: number) {
    this.detector.setSettings({ sensitivity: s });
  }

  setPostRoll(seconds: number) {
    this.postRollMs = seconds * 1000;
  }

  /** Re-learn the room's noise floor (call after white noise starts/stops/changes volume). */
  calibrate(ms = 4000) {
    this.detector.calibrate(ms);
  }

  /** Must be called from a user gesture the first time (iOS). Throws MicError strings. */
  async start(): Promise<void> {
    if (this.stream) return;
    if (!window.isSecureContext) throw 'insecure' satisfies MicError;
    if (!navigator.mediaDevices?.getUserMedia || typeof AudioWorkletNode === 'undefined') throw 'unsupported' satisfies MicError;

    const ctx = await resumeAudio();
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,   // may cancel this phone's own white noise; not guaranteed
          noiseSuppression: false,  // would also suppress quiet baby sounds
          autoGainControl: false,   // AGC would move the noise floor around
        },
      });
    } catch (e) {
      const name = (e as DOMException)?.name;
      log.warn('audio', 'getUserMedia failed', name);
      throw (name === 'NotAllowedError' || name === 'SecurityError' ? 'denied'
        : name === 'NotFoundError' || name === 'OverconstrainedError' ? 'no-mic'
        : name === 'NotReadableError' || name === 'AbortError' ? 'in-use' : 'unknown') satisfies MicError;
    }

    try {
      if (!MonitorEngine.loadedContexts.has(ctx)) {
        await ctx.audioWorklet.addModule(`${import.meta.env.BASE_URL}capture-worklet.js`);
        MonitorEngine.loadedContexts.add(ctx);
      }
      this.stream = stream;
      this.source = ctx.createMediaStreamSource(stream);
      this.worklet = new AudioWorkletNode(ctx, 'lull-capture');
      this.sink = ctx.createGain();
      this.sink.gain.value = 0; // keep the graph pulled without playing the mic back
      this.source.connect(this.worklet).connect(this.sink).connect(ctx.destination);
      this.resampler = new Resampler(ctx.sampleRate, CLIP_SAMPLE_RATE);
      this.ring.clear();
      this.detector.calibrate(3000);
      this.lastChunkAt = performance.now();
      const sampleRate = ctx.sampleRate;
      this.worklet.port.onmessage = (ev: MessageEvent<Float32Array>) => this.onChunk(ev.data, sampleRate);

      const track = stream.getAudioTracks()[0];
      track.addEventListener('ended', () => { log.error('audio', 'microphone track ended'); this.setHealth(false, 'Microphone was turned off'); });
      track.addEventListener('mute', () => { this.trackMuted = true; log.warn('audio', 'track muted'); });
      track.addEventListener('unmute', () => { this.trackMuted = false; log.info('audio', 'track unmuted'); });
      ctx.addEventListener('statechange', this.onCtxState);

      this.healthTimer = window.setInterval(() => this.checkHealth(), 1000);
      log.info('audio', 'monitoring started', { sampleRate, label: track.label, settings: track.getSettings?.() });
    } catch (e) {
      stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
      log.error('audio', 'audio graph setup failed', String(e));
      throw 'unknown' satisfies MicError;
    }
  }

  stop() {
    if (this.rec) this.finishClip(true);
    window.clearInterval(this.healthTimer);
    if (this.worklet) this.worklet.port.onmessage = null;
    this.source?.disconnect();
    this.worklet?.disconnect();
    this.sink?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.source?.context.removeEventListener('statechange', this.onCtxState);
    this.stream = this.source = this.worklet = this.sink = null;
    this.trackMuted = false;
    this.setHealth(false, 'stopped');
    log.info('audio', 'monitoring stopped');
  }

  private onCtxState = (ev: Event) => {
    const state = (ev.target as AudioContext).state as string;
    log.warn('audio', 'audio context state', state);
    if (state !== 'running' && document.visibilityState === 'visible') {
      (ev.target as AudioContext).resume().catch(() => undefined);
    }
    this.checkHealth();
  };

  private checkHealth() {
    if (!this.stream || !this.source) return;
    const track = this.stream.getAudioTracks()[0];
    const ctxState = this.source.context.state as string;
    const stalled = performance.now() - this.lastChunkAt > STALL_MS;
    if (!track || track.readyState === 'ended') return this.setHealth(false, 'Microphone was turned off');
    if (this.trackMuted) return this.setHealth(false, 'Microphone is muted by the system');
    if (ctxState !== 'running') return this.setHealth(false, document.hidden ? 'App is in the background' : 'Audio is suspended');
    if (stalled) return this.setHealth(false, 'No audio from the microphone');
    this.setHealth(true, null);
  }

  private setHealth(audioOk: boolean, reason: string | null) {
    if (this.health.audioOk === audioOk && this.health.reason === reason) return;
    this.health = { audioOk, reason };
    if (!audioOk && reason !== 'stopped') log.warn('audio', 'health', reason);
    if (!audioOk && this.rec) this.finishClip(true);
    this.cb.onHealth?.(this.health);
  }

  private onChunk(raw: Float32Array, sampleRate: number) {
    this.lastChunkAt = performance.now();
    if (!this.health.audioOk) this.checkHealth();
    const dtMs = (raw.length / sampleRate) * 1000;
    const pcm = this.resampler!.process(raw);
    const frame = this.detector.update(rmsDb(raw), dtMs);
    this.cb.onFrame?.(frame);

    if (this.rec) {
      this.rec.chunks.push(pcm);
      this.rec.samples += pcm.length;
      this.rec.peakDb = Math.max(this.rec.peakDb, frame.levelDb);
      this.rec.aboveFloorDb = Math.max(this.rec.aboveFloorDb, frame.levelDb - frame.floorDb);
      this.rec.remainingMs = frame.active ? Math.max(this.rec.remainingMs - dtMs, EXTEND_S * 1000) : this.rec.remainingMs - dtMs;
      if (this.rec.remainingMs <= 0 || this.rec.samples >= MAX_CLIP_S * CLIP_SAMPLE_RATE) this.finishClip(false);
    } else {
      this.ring.push(pcm);
      if (frame.triggered) this.beginClip(frame);
    }
  }

  private beginClip(frame: DetectorFrame) {
    const pre = this.ring.snapshot();
    this.ring.clear();
    const above = frame.levelDb - frame.floorDb;
    this.rec = { chunks: [pre], samples: pre.length, remainingMs: this.postRollMs, peakDb: frame.levelDb, aboveFloorDb: above };
    log.info('audio', 'sound detected', { level: frame.levelDb.toFixed(1), floor: frame.floorDb.toFixed(1) });
    this.cb.onClipStart?.({ startedAt: new Date(), levelDb: frame.levelDb, aboveFloorDb: above });
  }

  private finishClip(interrupted: boolean) {
    const r = this.rec;
    this.rec = null;
    if (!r) return;
    const samples = normalize(concatFloat32(r.chunks));
    this.cb.onClipEnd?.({
      samples,
      sampleRate: CLIP_SAMPLE_RATE,
      durationMs: Math.round((samples.length / CLIP_SAMPLE_RATE) * 1000),
      peakDb: r.peakDb,
      aboveFloorDb: r.aboveFloorDb,
      interrupted,
    });
  }
}

export type { AudioState, DetectorFrame };

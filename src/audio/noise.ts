// Procedurally generated sleep sounds — no audio files to download, license, or cache.
import { getAudioContext, resumeAudio } from './context';

export type NoiseKind = 'rain' | 'white' | 'ocean' | 'fan';

export const NOISES: { id: NoiseKind; label: string }[] = [
  { id: 'rain', label: 'Rain' },
  { id: 'white', label: 'White noise' },
  { id: 'ocean', label: 'Ocean' },
  { id: 'fan', label: 'Fan' },
];

const LOOP_SECONDS = 12;

function noiseBuffer(ctx: BaseAudioContext, kind: NoiseKind): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * LOOP_SECONDS);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    // pink (Paul Kellet) and brown state
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, brown = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.969 * b2 + w * 0.153852; b3 = 0.8665 * b3 + w * 0.3104856;
      b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
      const pink = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
      b6 = w * 0.115926;
      brown = (brown + 0.02 * w) / 1.02;
      switch (kind) {
        case 'white': d[i] = w * 0.35; break;
        case 'rain': d[i] = pink * 0.9; break;
        case 'ocean': d[i] = brown * 3.2; break;
        case 'fan': d[i] = brown * 2.4 + pink * 0.25; break;
      }
    }
    if (kind === 'rain') {
      // sparse soft droplets
      const drops = LOOP_SECONDS * 220;
      for (let k = 0; k < drops; k++) {
        const at = Math.floor(Math.random() * (len - 400));
        const amp = 0.08 + Math.random() * 0.18;
        for (let j = 0; j < 400; j++) d[at + j] += (Math.random() * 2 - 1) * amp * Math.exp(-j / 60);
      }
    }
    // Crossfade the ends so the loop is seamless.
    const fade = Math.floor(ctx.sampleRate * 0.5);
    for (let i = 0; i < fade; i++) {
      const t = i / fade;
      d[i] = d[i] * t + d[len - fade + i] * (1 - t);
    }
  }
  // Trim the crossfaded tail.
  const out = ctx.createBuffer(2, len - Math.floor(ctx.sampleRate * 0.5), ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) out.copyToChannel(buf.getChannelData(ch).subarray(0, out.length), ch);
  return out;
}

export class NoisePlayer {
  private nodes: AudioNode[] = [];
  private sources: AudioScheduledSourceNode[] = [];
  private gain: GainNode | null = null;
  private cache = new Map<NoiseKind, AudioBuffer>();
  kind: NoiseKind | null = null;
  volume = 0.5;

  get playing() {
    return this.kind !== null;
  }

  async play(kind: NoiseKind, volume = this.volume) {
    const ctx = await resumeAudio();
    this.stop(0.25);
    this.volume = volume;
    this.kind = kind;

    let buffer = this.cache.get(kind);
    if (!buffer) { buffer = noiseBuffer(ctx, kind); this.cache.set(kind, buffer); }

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;

    const shape = ctx.createBiquadFilter();
    shape.type = 'lowpass';
    shape.frequency.value = kind === 'fan' ? 900 : kind === 'ocean' ? 1400 : kind === 'rain' ? 7000 : 12000;

    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.gain.setTargetAtTime(this.curve(volume), ctx.currentTime, 0.4); // gentle fade-in

    src.connect(shape);
    let tail: AudioNode = shape;
    const extra: AudioScheduledSourceNode[] = [];

    if (kind === 'ocean') {
      // slow swell: ~9 s waves
      const swell = ctx.createGain();
      swell.gain.value = 0.55;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.11;
      const depth = ctx.createGain();
      depth.gain.value = 0.42;
      lfo.connect(depth).connect(swell.gain);
      shape.connect(swell);
      tail = swell;
      lfo.start();
      extra.push(lfo);
      this.nodes.push(swell, depth);
    }

    tail.connect(gain).connect(ctx.destination);
    src.start();
    this.sources = [src, ...extra];
    this.nodes.push(shape, gain);
    this.gain = gain;
  }

  setVolume(v: number) {
    this.volume = v;
    if (this.gain) this.gain.gain.setTargetAtTime(this.curve(v), getAudioContext().currentTime, 0.1);
  }

  stop(fadeSeconds = 0.6) {
    if (!this.gain) { this.kind = null; return; }
    const ctx = getAudioContext();
    const { sources, nodes, gain } = this;
    gain.gain.setTargetAtTime(0, ctx.currentTime, fadeSeconds / 4);
    setTimeout(() => {
      sources.forEach((s) => { try { s.stop(); } catch { /* already stopped */ } });
      nodes.forEach((n) => n.disconnect());
    }, fadeSeconds * 1000 + 50);
    this.sources = []; this.nodes = []; this.gain = null; this.kind = null;
  }

  /** Perceptual volume curve. */
  private curve(v: number) {
    return Math.pow(Math.max(0, Math.min(1, v)), 2) * 0.9;
  }
}

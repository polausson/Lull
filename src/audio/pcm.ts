// PCM utilities: streaming resampler, ring buffer for pre-roll, WAV encoder.

/** Streaming box-filter resampler (anti-aliased by averaging). Good enough for voice-band clips. */
export class Resampler {
  private readonly ratio: number;
  private pos = 0;
  private acc = 0;
  private count = 0;

  constructor(inRate: number, readonly outRate: number) {
    this.ratio = inRate / outRate;
  }

  process(input: Float32Array): Float32Array {
    const out = new Float32Array(Math.ceil(input.length / this.ratio) + 1);
    let n = 0;
    for (let i = 0; i < input.length; i++) {
      this.acc += input[i];
      this.count++;
      this.pos += 1;
      if (this.pos >= this.ratio) {
        out[n++] = this.acc / this.count;
        this.pos -= this.ratio;
        this.acc = 0;
        this.count = 0;
      }
    }
    return out.subarray(0, n);
  }
}

/** Fixed-size ring buffer holding the most recent N samples. */
export class RingBuffer {
  private readonly buf: Float32Array;
  private write = 0;
  private filled = 0;

  constructor(readonly capacity: number) {
    this.buf = new Float32Array(capacity);
  }

  push(samples: Float32Array) {
    let src = samples;
    if (src.length >= this.capacity) src = src.subarray(src.length - this.capacity);
    const first = Math.min(src.length, this.capacity - this.write);
    this.buf.set(src.subarray(0, first), this.write);
    this.buf.set(src.subarray(first), 0);
    this.write = (this.write + src.length) % this.capacity;
    this.filled = Math.min(this.capacity, this.filled + src.length);
  }

  /** Returns a copy of the buffered samples, oldest first. */
  snapshot(): Float32Array {
    const out = new Float32Array(this.filled);
    const start = (this.write - this.filled + this.capacity) % this.capacity;
    const first = Math.min(this.filled, this.capacity - start);
    out.set(this.buf.subarray(start, start + first), 0);
    out.set(this.buf.subarray(0, this.filled - first), first);
    return out;
  }

  clear() {
    this.write = 0;
    this.filled = 0;
  }
}

export function concatFloat32(chunks: Float32Array[]): Float32Array {
  const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

/** Normalises quiet clips so they're audible on playback (max +18 dB gain, peak −1 dBFS). */
export function normalize(samples: Float32Array, maxGainDb = 18): Float32Array {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]));
  if (peak === 0) return samples;
  const gain = Math.min(10 ** (maxGainDb / 20), 0.89 / peak);
  if (gain <= 1) return samples;
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = samples[i] * gain;
  return out;
}

/** 16-bit mono PCM WAV — plays natively on iOS, Android and every browser. */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const v = new DataView(bytes.buffer);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return bytes;
}

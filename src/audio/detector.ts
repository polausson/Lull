// Sound detection with an adaptive noise floor.
//
// Each audio frame (~20–50 ms) gives a level in dBFS. We track the room's noise floor
// (falls quickly, rises slowly) and call something a sound when the level stays above
// max(floor + margin, absolute minimum) for long enough. Steady noise — a fan, white noise
// from this phone — raises the floor, so it stops counting as "sound" within seconds.

export type AudioState = 'calibrating' | 'silence' | 'background' | 'sound';

export interface DetectorSettings {
  /** 0 (least sensitive) … 1 (most sensitive). */
  sensitivity: number;
}

export interface DetectorFrame {
  state: AudioState;
  levelDb: number;
  floorDb: number;
  thresholdDb: number;
  /** True exactly once at the start of a detected sound. */
  triggered: boolean;
  /** True while level is above threshold (used to extend recordings). */
  active: boolean;
}

export const SILENCE_DB = -70;
const MIN_DB = -100;

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

export function rmsDb(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  const rms = Math.sqrt(sum / Math.max(1, samples.length));
  return rms > 0 ? Math.max(MIN_DB, 20 * Math.log10(rms)) : MIN_DB;
}

/** dB above the floor required to count as a sound. */
export function marginFor(sensitivity: number) {
  return lerp(22, 7, clamp(sensitivity, 0, 1));
}
/** Absolute level a sound must reach regardless of how quiet the room is. */
export function absoluteMinFor(sensitivity: number) {
  return lerp(-36, -58, clamp(sensitivity, 0, 1));
}

export class SoundDetector {
  floorDb = -60;
  private settings: DetectorSettings;
  private calibrateUntil = 0;
  private elapsed = 0;
  private aboveMs = 0;      // leaky accumulator of time spent above threshold
  private inSound = false;
  private quietMs = 0;      // time since last above-threshold frame while in a sound

  /** Sustained time above threshold before triggering. */
  static TRIGGER_MS = 300;
  /** Quiet time that ends a sound (so a new one can trigger). */
  static RELEASE_MS = 1500;

  constructor(settings: DetectorSettings) {
    this.settings = { ...settings };
  }

  setSettings(s: Partial<DetectorSettings>) {
    this.settings = { ...this.settings, ...s };
  }

  /** Re-learn the noise floor for `ms` (start of monitoring, white noise changes). */
  calibrate(ms = 4000) {
    this.calibrateUntil = this.elapsed + ms;
    this.aboveMs = 0;
    this.inSound = false;
  }

  get calibrating() {
    return this.elapsed < this.calibrateUntil;
  }

  update(levelDb: number, dtMs: number): DetectorFrame {
    this.elapsed += dtMs;
    const dtS = dtMs / 1000;

    if (this.calibrating) {
      // Track the floor quickly in both directions using a robust-ish estimate.
      const a = 1 - Math.exp(-dtS / 0.6);
      this.floorDb += (levelDb - this.floorDb) * a;
      return this.frame('calibrating', levelDb, false, false);
    }

    const threshold = this.threshold();
    const above = levelDb > threshold;

    // Floor tracking: fast down (τ 1.5 s); slow up (τ 20 s, 60 s while a sound is in progress).
    if (levelDb < this.floorDb) {
      this.floorDb += (levelDb - this.floorDb) * (1 - Math.exp(-dtS / 1.5));
    } else {
      const tau = this.inSound || above ? 60 : 20;
      this.floorDb += (levelDb - this.floorDb) * (1 - Math.exp(-dtS / tau));
    }
    this.floorDb = clamp(this.floorDb, MIN_DB, -10);

    this.aboveMs = above ? this.aboveMs + dtMs : Math.max(0, this.aboveMs - dtMs * 0.5);

    let triggered = false;
    if (!this.inSound && this.aboveMs >= SoundDetector.TRIGGER_MS) {
      this.inSound = true;
      triggered = true;
      this.quietMs = 0;
    }
    if (this.inSound) {
      this.quietMs = above ? 0 : this.quietMs + dtMs;
      if (this.quietMs >= SoundDetector.RELEASE_MS) {
        this.inSound = false;
        this.aboveMs = 0;
      }
    }

    const state: AudioState = this.inSound || above ? 'sound' : levelDb < SILENCE_DB ? 'silence' : 'background';
    return this.frame(state, levelDb, triggered, above);
  }

  threshold() {
    return Math.max(this.floorDb + marginFor(this.settings.sensitivity), absoluteMinFor(this.settings.sensitivity));
  }

  private frame(state: AudioState, levelDb: number, triggered: boolean, active: boolean): DetectorFrame {
    return { state, levelDb, floorDb: this.floorDb, thresholdDb: this.threshold(), triggered, active };
  }
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SoundDetector, rmsDb } from '../src/audio/detector.ts';
import { Resampler, RingBuffer, encodeWav, normalize } from '../src/audio/pcm.ts';

const FRAME_MS = 21.3;
const jitter = () => (Math.random() - 0.5) * 3; // ±1.5 dB measurement noise

/** Feeds `seconds` of a level profile and returns the number of triggers. */
function run(d: SoundDetector, seconds: number, level: (t: number) => number) {
  let triggers = 0;
  for (let t = 0; t < seconds * 1000; t += FRAME_MS) if (d.update(level(t) + jitter(), FRAME_MS).triggered) triggers++;
  return triggers;
}

test('quiet room: crying triggers once, room tone never does', () => {
  const d = new SoundDetector({ sensitivity: 0.6 });
  d.calibrate(3000);
  assert.equal(run(d, 120, () => -66), 0, 'room tone');
  assert.equal(run(d, 4, () => -28), 1, 'cry');
  assert.equal(run(d, 20, () => -66), 0, 'quiet again');
  assert.equal(run(d, 3, () => -30), 1, 'second cry is a new event');
});

test('short clicks under 300 ms are ignored', () => {
  const d = new SoundDetector({ sensitivity: 0.8 });
  d.calibrate(3000);
  run(d, 5, () => -65);
  assert.equal(run(d, 10, (t) => (t % 2000 < 120 ? -20 : -65)), 0);
});

test('white noise from the phone is learned during calibration and does not trigger', () => {
  const d = new SoundDetector({ sensitivity: 0.6 });
  d.calibrate(3000);
  run(d, 10, () => -65);
  d.calibrate(4000); // white noise switched on
  assert.equal(run(d, 300, () => -34), 0, '5 minutes of white noise');
  assert.ok(d.floorDb > -38, `floor adapted (${d.floorDb.toFixed(1)})`);
  assert.equal(run(d, 3, () => -14), 1, 'loud cry over white noise still detected');
});

test('a fan switched on without calibration only triggers once and is then absorbed', () => {
  const d = new SoundDetector({ sensitivity: 0.5 });
  d.calibrate(3000);
  run(d, 10, () => -65);
  assert.ok(run(d, 180, () => -40) <= 1);
  assert.equal(run(d, 120, () => -40), 0);
});

test('lower sensitivity needs a louder sound', () => {
  const quietSound = () => -50;
  const hi = new SoundDetector({ sensitivity: 1 }); hi.calibrate(3000); run(hi, 5, () => -70);
  const lo = new SoundDetector({ sensitivity: 0 }); lo.calibrate(3000); run(lo, 5, () => -70);
  assert.equal(run(hi, 3, quietSound), 1);
  assert.equal(run(lo, 3, quietSound), 0);
});

test('rmsDb of a full-scale sine is about -3 dBFS', () => {
  const s = new Float32Array(4800).map((_, i) => Math.sin((2 * Math.PI * 440 * i) / 48000));
  assert.ok(Math.abs(rmsDb(s) + 3.01) < 0.1);
});

test('resampler 48k→16k and 44.1k→16k produce the right number of samples', () => {
  for (const rate of [48000, 44100]) {
    const r = new Resampler(rate, 16000);
    let n = 0;
    for (let i = 0; i < 100; i++) n += r.process(new Float32Array(rate / 100)).length;
    assert.ok(Math.abs(n - 16000) <= 1, `${rate}: ${n}`);
  }
});

test('ring buffer keeps the most recent samples in order', () => {
  const rb = new RingBuffer(5);
  rb.push(Float32Array.from([1, 2, 3]));
  assert.deepEqual([...rb.snapshot()], [1, 2, 3]);
  rb.push(Float32Array.from([4, 5, 6, 7]));
  assert.deepEqual([...rb.snapshot()], [3, 4, 5, 6, 7]);
  rb.push(Float32Array.from([8, 9, 10, 11, 12, 13]));
  assert.deepEqual([...rb.snapshot()], [9, 10, 11, 12, 13]);
});

test('WAV header is valid', () => {
  const wav = encodeWav(Float32Array.from([0, 0.5, -0.5, 1]), 16000);
  const v = new DataView(wav.buffer);
  assert.equal(String.fromCharCode(...wav.slice(0, 4)), 'RIFF');
  assert.equal(v.getUint32(24, true), 16000);
  assert.equal(v.getUint32(40, true), 8);
  assert.equal(v.getInt16(46, true), 16383);
  assert.equal(wav.length, 52);
});

test('normalize lifts quiet clips without clipping', () => {
  const out = normalize(Float32Array.from([0.01, -0.02]));
  assert.ok(Math.abs(Math.max(...out.map(Math.abs)) - 0.02 * 10 ** (18 / 20)) < 1e-6);
  const loud = Float32Array.from([0.95]);
  assert.equal(normalize(loud), loud);
});

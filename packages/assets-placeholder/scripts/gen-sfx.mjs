#!/usr/bin/env node
/**
 * Synthesises the four placeholder sound effects. Nothing is sampled or
 * downloaded: every waveform is computed here from oscillators and seeded
 * noise, so the committed `.wav` files are reproducible and unencumbered.
 *
 * Outputs, all 16-bit mono PCM at 22.05 kHz and well under 60 KB:
 *
 * - `shot.wav`   noise burst with a fast downward pitch sweep
 * - `hit.wav`    short body thud plus a transient
 * - `pickup.wav` rising four-note arpeggio
 * - `step.wav`   damped footfall
 *
 * Usage: `node scripts/gen-sfx.mjs`
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Sample rate for every placeholder effect, in hertz. */
const SAMPLE_RATE = 22_050;

/** Peak amplitude after normalisation, leaving a little headroom. */
const PEAK = 0.89;

/** Hard per-file size budget, in bytes. */
const MAX_BYTES = 60 * 1024;

/** Master seed for the noise generators. */
const SEED = 0x50f_1c3;

/**
 * Mulberry32: a tiny, fast, fully deterministic PRNG.
 *
 * @param {number} seed Any 32-bit integer.
 * @returns {() => number} A generator of floats in `[0, 1)`.
 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const rnd = mulberry32(SEED);

/**
 * White noise in `[-1, 1]`.
 *
 * @returns {number} One noise sample.
 */
function noise() {
  return rnd() * 2 - 1;
}

/**
 * A one-pole low-pass filter, as a closure over its own state.
 *
 * @param {number} cutoff Cutoff frequency in hertz.
 * @returns {(x: number) => number} The filter.
 */
function lowpass(cutoff) {
  const k = 1 - Math.exp((-2 * Math.PI * cutoff) / SAMPLE_RATE);
  let y = 0;
  return (x) => {
    y += k * (x - y);
    return y;
  };
}

/**
 * A one-pole high-pass filter, as a closure over its own state.
 *
 * @param {number} cutoff Cutoff frequency in hertz.
 * @returns {(x: number) => number} The filter.
 */
function highpass(cutoff) {
  const lp = lowpass(cutoff);
  return (x) => x - lp(x);
}

/**
 * Exponential decay.
 *
 * @param {number} t Time in seconds.
 * @param {number} tau Time constant in seconds.
 * @returns {number} A gain in `(0, 1]`.
 */
function decay(t, tau) {
  return Math.exp(-t / tau);
}

/**
 * Fade the first and last few milliseconds so no effect starts or ends on a
 * discontinuity. Clicks in a placeholder asset read as engine bugs.
 *
 * @param {Float64Array} samples Samples, edited in place.
 * @param {number} [ms] Fade length in milliseconds.
 * @returns {void}
 */
function deClick(samples, ms = 3) {
  const n = Math.min(Math.floor((ms / 1000) * SAMPLE_RATE), samples.length >> 1);
  for (let i = 0; i < n; i += 1) {
    const g = i / n;
    samples[i] *= g;
    samples[samples.length - 1 - i] *= g;
  }
}

/**
 * Scale a buffer so its loudest sample sits at {@link PEAK}.
 *
 * @param {Float64Array} samples Samples, edited in place.
 * @returns {Float64Array} The same buffer.
 */
function normalise(samples) {
  let peak = 0;
  for (const s of samples) peak = Math.max(peak, Math.abs(s));
  if (peak > 0) {
    const g = PEAK / peak;
    for (let i = 0; i < samples.length; i += 1) samples[i] *= g;
  }
  return samples;
}

/**
 * Allocate a buffer of the given duration.
 *
 * @param {number} seconds Duration in seconds.
 * @returns {Float64Array} A silent buffer.
 */
function buffer(seconds) {
  return new Float64Array(Math.round(seconds * SAMPLE_RATE));
}

/**
 * Wrap PCM samples in a canonical 44-byte RIFF/WAVE header.
 *
 * @param {Float64Array} samples Samples in `[-1, 1]`.
 * @returns {Buffer} A complete `.wav` file.
 */
function encodeWav(samples) {
  const dataBytes = samples.length * 2;
  const out = Buffer.alloc(44 + dataBytes);
  out.write('RIFF', 0, 'ascii');
  out.writeUInt32LE(36 + dataBytes, 4);
  out.write('WAVE', 8, 'ascii');
  out.write('fmt ', 12, 'ascii');
  out.writeUInt32LE(16, 16); // fmt chunk size
  out.writeUInt16LE(1, 20); // PCM
  out.writeUInt16LE(1, 22); // mono
  out.writeUInt32LE(SAMPLE_RATE, 24);
  out.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate
  out.writeUInt16LE(2, 32); // block align
  out.writeUInt16LE(16, 34); // bits per sample
  out.write('data', 36, 'ascii');
  out.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    out.writeInt16LE(Math.round(clamped * 32_767), 44 + i * 2);
  }
  return out;
}

/**
 * `shot.wav` — a noise burst over a fast downward pitch sweep.
 *
 * @returns {Float64Array} The rendered effect.
 */
function renderShot() {
  const out = buffer(0.22);
  const body = lowpass(2600);
  const crack = highpass(1500);
  let phase = 0;
  for (let i = 0; i < out.length; i += 1) {
    const t = i / SAMPLE_RATE;
    // 460 Hz down to 70 Hz in 90 ms: the "drop" that makes it read as a shot.
    const f = 70 + 390 * decay(t, 0.03);
    phase += (2 * Math.PI * f) / SAMPLE_RATE;
    const tone = Math.tanh(2.4 * Math.sin(phase)) * decay(t, 0.055);
    const burst = crack(noise()) * decay(t, 0.018) * 0.9;
    out[i] = body(tone * 0.75 + burst);
  }
  deClick(out, 2);
  return normalise(out);
}

/**
 * `hit.wav` — a dull body impact with a bright transient on the front.
 *
 * @returns {Float64Array} The rendered effect.
 */
function renderHit() {
  const out = buffer(0.2);
  const thump = lowpass(900);
  const snap = highpass(2200);
  let phase = 0;
  for (let i = 0; i < out.length; i += 1) {
    const t = i / SAMPLE_RATE;
    const f = 58 + 190 * decay(t, 0.022);
    phase += (2 * Math.PI * f) / SAMPLE_RATE;
    const low = Math.sin(phase) * decay(t, 0.06);
    const transient = snap(noise()) * decay(t, 0.01) * 0.55;
    out[i] = thump(low) + transient;
  }
  deClick(out, 2);
  return normalise(out);
}

/**
 * `pickup.wav` — a rising A-major arpeggio: A4, C#5, E5, A5.
 *
 * @returns {Float64Array} The rendered effect.
 */
function renderPickup() {
  const notes = [440, 554.365, 659.255, 880];
  const noteLen = 0.11;
  const out = buffer(notes.length * noteLen + 0.1);
  for (const [index, f] of notes.entries()) {
    const start = Math.round(index * noteLen * SAMPLE_RATE);
    const tail = Math.round(0.16 * SAMPLE_RATE);
    for (let i = 0; i < tail && start + i < out.length; i += 1) {
      const t = i / SAMPLE_RATE;
      // 8 ms attack, then a plucked decay.
      const attack = Math.min(1, t / 0.008);
      const env = attack * decay(t, 0.055);
      const phase = 2 * Math.PI * f * t;
      out[start + i] +=
        env * (Math.sin(phase) + 0.28 * Math.sin(2 * phase) + 0.1 * Math.sin(3 * phase));
    }
  }
  deClick(out, 3);
  return normalise(out);
}

/**
 * `step.wav` — a short, damped footfall on a hard floor.
 *
 * @returns {Float64Array} The rendered effect.
 */
function renderStep() {
  const out = buffer(0.13);
  const scuff = lowpass(1400);
  const floor = lowpass(220);
  let phase = 0;
  for (let i = 0; i < out.length; i += 1) {
    const t = i / SAMPLE_RATE;
    phase += (2 * Math.PI * 95) / SAMPLE_RATE;
    const thud = Math.sin(phase) * decay(t, 0.022) * 0.7;
    out[i] = scuff(noise()) * decay(t, 0.012) * 0.6 + floor(thud);
  }
  deClick(out, 2);
  return normalise(out);
}

const outDir = fileURLToPath(new URL('../assets/', import.meta.url));
mkdirSync(outDir, { recursive: true });

/** The four effects, in the order they are written. */
const EFFECTS = [
  ['shot.wav', renderShot],
  ['hit.wav', renderHit],
  ['pickup.wav', renderPickup],
  ['step.wav', renderStep],
];

for (const [name, render] of EFFECTS) {
  const samples = render();
  const wav = encodeWav(samples);
  if (wav.length > MAX_BYTES) {
    throw new Error(`${name} is ${String(wav.length)} bytes, over the 60 KB budget`);
  }
  writeFileSync(`${outDir}${name}`, wav);
  console.log(
    `${name.padEnd(20)} ${(samples.length / SAMPLE_RATE).toFixed(3)} s  ${String(
      wav.length,
    ).padStart(6)} bytes`,
  );
}

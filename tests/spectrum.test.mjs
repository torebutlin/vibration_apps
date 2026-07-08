import test from 'node:test';
import assert from 'node:assert/strict';
import { SpectrumProcessor } from '../shared/js/dsp/spectrum.js';
import { findPeaks } from '../shared/js/dsp/peaks.js';

function makeSine(n, fs, freq, amp, phase = 0) {
  const s = new Float32Array(n);
  for (let i = 0; i < n; i++) s[i] = amp * Math.sin((2 * Math.PI * freq * i) / fs + phase);
  return s;
}

// Deterministic gaussian-ish noise via sum of uniforms (mulberry32 PRNG)
function makeNoise(n, sigma, seedStart = 42) {
  let a = seedStart | 0;
  const rand = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const s = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let j = 0; j < 12; j++) acc += rand();
    s[i] = sigma * (acc - 6); // variance ~ sigma^2
  }
  return s;
}

test('amplitude spectrum recovers sine amplitude (hann, bin-centred)', () => {
  const fs = 48000;
  const n = 4096;
  const bin = 200;
  const amp = 0.25;
  const proc = new SpectrumProcessor({ fftSize: n, windowName: 'hann', sampleRate: fs });
  proc.setAveraging('off');
  proc.process(makeSine(n, fs, (bin * fs) / n, amp), 0.02);
  const out = new Float32Array(proc.nBins);
  proc.toDisplay(proc.avgPower, out, 'amplitude', false);
  assert.ok(Math.abs(out[bin] - amp) / amp < 1e-5, `got ${out[bin]}, want ${amp}`);
  const rmsOut = new Float32Array(proc.nBins);
  proc.toDisplay(proc.avgPower, rmsOut, 'rms', false);
  assert.ok(Math.abs(rmsOut[bin] - amp / Math.SQRT2) / amp < 1e-5);
});

test('flattop recovers amplitude of off-bin-centre sine', () => {
  const fs = 48000;
  const n = 4096;
  const amp = 0.5;
  const freq = (200.43 * fs) / n; // deliberately between bins
  const proc = new SpectrumProcessor({ fftSize: n, windowName: 'flattop', sampleRate: fs });
  proc.setAveraging('off');
  proc.process(makeSine(n, fs, freq, amp), 0.02);
  const out = new Float32Array(proc.nBins);
  proc.toDisplay(proc.avgPower, out, 'amplitude', false);
  let peak = 0;
  for (const v of out) peak = Math.max(peak, v);
  // flat-top scalloping loss < 0.02 dB
  assert.ok(Math.abs(peak - amp) / amp < 0.01, `got ${peak}, want ~${amp}`);
});

test('PSD of white noise integrates to variance', () => {
  const fs = 10000;
  const n = 4096;
  const sigma = 0.1;
  const proc = new SpectrumProcessor({ fftSize: n, windowName: 'hann', sampleRate: fs });
  proc.setAveraging('linear', { linearTarget: 200 });
  // feed many independent segments
  for (let seg = 0; seg < 200; seg++) {
    proc.process(makeNoise(n, sigma, 1000 + seg * 7919), 0.01);
  }
  const psd = new Float32Array(proc.nBins);
  proc.toDisplay(proc.avgPower, psd, 'psd', false);
  let integral = 0;
  for (let k = 0; k < proc.nBins; k++) integral += psd[k] * proc.binHz;
  const variance = sigma * sigma;
  assert.ok(
    Math.abs(integral - variance) / variance < 0.05,
    `integral ${integral}, variance ${variance}`
  );
});

test('PSD level of white noise is flat at 2*sigma^2/fs', () => {
  const fs = 10000;
  const n = 2048;
  const sigma = 0.2;
  const proc = new SpectrumProcessor({ fftSize: n, windowName: 'hann', sampleRate: fs });
  proc.setAveraging('linear', { linearTarget: 300 });
  for (let seg = 0; seg < 300; seg++) {
    proc.process(makeNoise(n, sigma, 55 + seg * 104729), 0.01);
  }
  const psd = new Float32Array(proc.nBins);
  proc.toDisplay(proc.avgPower, psd, 'psd', false);
  const expected = (2 * sigma * sigma) / fs; // one-sided white PSD
  // check a mid-band average
  let sum = 0;
  let count = 0;
  for (let k = 100; k < 900; k++) { sum += psd[k]; count++; }
  const meanLevel = sum / count;
  assert.ok(Math.abs(meanLevel - expected) / expected < 0.05, `mean ${meanLevel}, want ${expected}`);
});

test('linear averaging reduces variance and freezes at target', () => {
  const fs = 10000;
  const n = 1024;
  const proc = new SpectrumProcessor({ fftSize: n, windowName: 'hann', sampleRate: fs });
  proc.setAveraging('linear', { linearTarget: 10 });
  for (let seg = 0; seg < 10; seg++) proc.process(makeNoise(n, 0.1, seg * 31 + 7), 0.01);
  assert.equal(proc.avgCount, 10);
  assert.ok(proc.linearDone);
  const before = Float64Array.from(proc.avgPower);
  proc.process(makeNoise(n, 0.1, 12345), 0.01);
  assert.deepEqual(Array.from(proc.avgPower), Array.from(before), 'frozen after target');
});

test('exponential averaging converges toward steady level', () => {
  const fs = 10000;
  const n = 1024;
  const proc = new SpectrumProcessor({ fftSize: n, windowName: 'hann', sampleRate: fs });
  proc.setAveraging('exponential', { expTimeConst: 0.1 });
  const sine = makeSine(n, fs, (100 * fs) / n, 0.5);
  for (let i = 0; i < 100; i++) proc.process(sine, 0.02);
  const out = new Float32Array(proc.nBins);
  proc.toDisplay(proc.avgPower, out, 'amplitude', false);
  assert.ok(Math.abs(out[100] - 0.5) / 0.5 < 1e-3);
});

test('peak hold retains maxima after signal stops', () => {
  const fs = 10000;
  const n = 1024;
  const proc = new SpectrumProcessor({ fftSize: n, windowName: 'hann', sampleRate: fs });
  proc.setAveraging('off');
  proc.process(makeSine(n, fs, (50 * fs) / n, 0.8), 0.02);
  proc.process(new Float32Array(n), 0.02); // silence
  const live = new Float32Array(proc.nBins);
  const held = new Float32Array(proc.nBins);
  proc.toDisplay(proc.avgPower, live, 'amplitude', false);
  proc.toDisplay(proc.peakPower, held, 'amplitude', false);
  assert.ok(live[50] < 1e-6);
  assert.ok(Math.abs(held[50] - 0.8) < 1e-3);
  proc.resetPeakHold();
  proc.toDisplay(proc.peakPower, held, 'amplitude', false);
  assert.ok(held[50] < 1e-6);
});

test('findPeaks labels distinct tones and skips shoulders', () => {
  const fs = 48000;
  const n = 8192;
  const proc = new SpectrumProcessor({ fftSize: n, windowName: 'hann', sampleRate: fs });
  proc.setAveraging('off');
  const s = new Float32Array(n);
  const tones = [
    { freq: 440, amp: 0.5 },
    { freq: 880, amp: 0.25 },
    { freq: 2000, amp: 0.1 },
  ];
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (const t of tones) v += t.amp * Math.sin((2 * Math.PI * t.freq * i) / fs + t.freq);
    s[i] = v;
  }
  proc.process(s, 0.02);
  const db = new Float32Array(proc.nBins);
  proc.toDisplay(proc.avgPower, db, 'amplitude', true);
  const peaks = findPeaks(db, 5);
  assert.ok(peaks.length >= 3, `found ${peaks.length}`);
  const freqs = peaks.map((p) => (p.bin + p.frac) * proc.binHz);
  for (const t of tones) {
    const nearest = freqs.reduce((best, f) => Math.min(best, Math.abs(f - t.freq)), Infinity);
    assert.ok(nearest < proc.binHz, `tone ${t.freq} labelled within a bin (off by ${nearest})`);
  }
});

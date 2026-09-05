import test from 'node:test';
import assert from 'node:assert/strict';
import { plotLayout } from '../shared/js/plot/axes.js';
import { rowRanges, rowMax } from '../shared/js/plot/rows.js';
import { minMaxEnvelope } from '../shared/js/plot/envelope.js';
import { rfftMagSq } from '../shared/js/dsp/fft.js';
import { getWindow } from '../shared/js/dsp/windows.js';

// ---------- plotLayout ----------

test('plotLayout: wide keeps outside labels with axis titles', () => {
  const L = plotLayout(1000, 600, {});
  assert.deepEqual(L.m, { l: 58, r: 14, t: 14, b: 40 });
  assert.equal(L.yInside, false);
  assert.equal(L.xTitle, true);
  assert.equal(L.yTitle, true);
  assert.deepEqual(L.rect, { x: 58, y: 14, w: 1000 - 58 - 14, h: 600 - 14 - 40 });
});

test('plotLayout: narrow landscape keeps the y axis outside, drops the x title', () => {
  const L = plotLayout(844, 390, { compact: true });
  assert.deepEqual(L.m, { l: 58, r: 12, t: 12, b: 26 });
  assert.equal(L.yInside, false);
  assert.equal(L.xTitle, false);
  assert.equal(L.yTitle, true);
});

test('plotLayout: narrow portrait puts the y labels inside', () => {
  const L = plotLayout(390, 700, { compact: true, yInside: true });
  assert.deepEqual(L.m, { l: 10, r: 10, t: 12, b: 26 });
  assert.equal(L.yInside, true);
  assert.equal(L.xTitle, false);
  assert.equal(L.yTitle, false);
});

test('plotLayout: padTop/padBottom reserve room for floating pill rows', () => {
  const L = plotLayout(390, 844, { compact: true, yInside: true, padTop: 60, padBottom: 62 });
  assert.deepEqual(L.m, { l: 10, r: 10, t: 72, b: 88 });
  assert.deepEqual(L.rect, { x: 10, y: 72, w: 370, h: 844 - 72 - 88 });
});

// ---------- rowRanges / rowMax ----------

test('rowRanges: rows wider than bins cover every bin between the row edges', () => {
  // rows top-first: 100, 50, 0 Hz; bins every 10 Hz; max bin index 10
  const { lo, hi } = rowRanges([100, 50, 0], (f) => f / 10, 10);
  assert.deepEqual([...lo], [8, 3, 0]);
  assert.deepEqual([...hi], [10, 7, 2]);
});

test('rowRanges: rows denser than bins fall back to the nearest bin', () => {
  const { lo, hi } = rowRanges([12, 11, 10], (f) => f / 10, 100);
  assert.deepEqual([...lo], [1, 1, 1]);
  assert.deepEqual([...hi], [1, 1, 1]);
});

test('rowMax pools narrow tones so no tone is lost at FFT 32768', () => {
  const fs = 48000;
  const N = 32768;
  const rows = 512;
  const fMin = 20;
  const fMax = 5000;
  const rowFreqs = new Float64Array(rows);
  for (let r = 0; r < rows; r++) rowFreqs[r] = fMin + (1 - r / (rows - 1)) * (fMax - fMin);
  const binHz = fs / N;
  const { lo, hi } = rowRanges(rowFreqs, (f) => f / binHz, N / 2);
  const { w, coherentGain } = getWindow('hann', N);
  const scale = 2 / (N * coherentGain);
  const x = new Float64Array(N);
  const P = new Float64Array(N / 2 + 1);
  let worstLoss = 0;
  for (let f = 100; f < 4900; f += 41.7) {
    for (let i = 0; i < N; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * f * i) / fs) * w[i];
    rfftMagSq(x, P);
    let truePeak = 0;
    for (let b = 1; b <= N / 2; b++) truePeak = Math.max(truePeak, P[b]);
    let rowPeak = 0;
    for (let r = 0; r < rows; r++) rowPeak = Math.max(rowPeak, rowMax(P, lo, hi, r));
    const lossDb = 10 * Math.log10(truePeak / rowPeak);
    worstLoss = Math.max(worstLoss, lossDb);
    assert.ok(Math.abs(scale * Math.sqrt(rowPeak) - 0.5) < 0.1, `amplitude at ${f} Hz`);
  }
  assert.ok(worstLoss < 0.01, `worst pooled loss ${worstLoss} dB`);
});

// ---------- minMaxEnvelope ----------

test('minMaxEnvelope: every column of a dense sine spans -A..+A', () => {
  const n = 48000;
  const buf = new Float32Array(n + 100);
  for (let i = 0; i < buf.length; i++) buf[i] = 0.7 * Math.sin((2 * Math.PI * 440 * i) / 48000);
  const cols = 200;
  const mn = new Float32Array(cols);
  const mx = new Float32Array(cols);
  minMaxEnvelope(buf, 100, n, cols, mn, mx);
  for (let c = 0; c < cols; c++) {
    assert.ok(mx[c] > 0.69, `col ${c} max ${mx[c]}`);
    assert.ok(mn[c] < -0.69, `col ${c} min ${mn[c]}`);
  }
});

test('minMaxEnvelope: with fewer samples than columns each column holds one sample', () => {
  const buf = Float32Array.from([1, 2, 3, 4]);
  const mn = new Float32Array(8);
  const mx = new Float32Array(8);
  minMaxEnvelope(buf, 0, 4, 8, mn, mx);
  assert.deepEqual([...mx], [1, 1, 2, 2, 3, 3, 4, 4]);
  assert.deepEqual([...mn], [1, 1, 2, 2, 3, 3, 4, 4]);
});

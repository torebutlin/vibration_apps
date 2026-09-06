import test from 'node:test';
import assert from 'node:assert/strict';
import { StreamingCWT } from '../shared/js/dsp/cwt.js';

function tone(n, fs, f, amp, offset = 0) {
  const s = new Float32Array(n);
  for (let i = 0; i < n; i++) s[i] = amp * Math.sin((2 * Math.PI * f * (i + offset)) / fs);
  return s;
}

test('streaming CWT: columns arrive one per hop, after the wavelet latency', () => {
  const fs = 48000;
  const cwt = new StreamingCWT({ sampleRate: fs, fMin: 100, fMax: 4000, binsPerOctave: 8, omega0: 6, hopSamples: 480 });
  assert.equal(cwt.hop % cwt.decimation, 0, 'hop is a whole number of decimated samples');
  assert.ok(cwt.latencySeconds > 0.03 && cwt.latencySeconds < 0.06, `latency ${cwt.latencySeconds}`);
  cwt.push(new Float32Array(1000));
  assert.equal(cwt.available, 0, 'nothing computable inside the latency');
  cwt.push(new Float32Array(fs)); // one second
  // the first column sits one latency in (full wavelet support), the last
  // one latency before the newest sample
  const expect = Math.floor((1000 + fs - 2 * cwt.latencySamples) / cwt.hop);
  assert.ok(Math.abs(cwt.available - expect) <= 2, `available ${cwt.available} vs ${expect}`);
  const out = new Float32Array(cwt.nScales);
  const t0 = cwt.nextColumn(out);
  const t1 = cwt.nextColumn(out);
  assert.equal(t1 - t0, cwt.hop, 'column instants are one hop apart');
});

test('streaming CWT: a tone at a scale centre reads its amplitude on that row', () => {
  const fs = 48000;
  const cwt = new StreamingCWT({ sampleRate: fs, fMin: 50, fMax: 5000, binsPerOctave: 12, omega0: 6, hopSamples: 960 });
  const j = 24;
  const f = cwt.freqs[j];
  const amp = 0.4;
  cwt.push(tone(fs * 2, fs, f, amp));
  const out = new Float32Array(cwt.nScales);
  let sum = 0;
  let n = 0;
  while (cwt.available > 0) {
    cwt.nextColumn(out);
    if (n > 5) sum += out[j]; // skip the first columns (decimator warm-up)
    n++;
  }
  const mean = sum / (n - 6);
  assert.ok(Math.abs(mean - amp) / amp < 0.03, `row amp ${mean} vs ${amp}`);
  // the maximum over scales sits on (or next to) row j
  let best = -1;
  let bestRow = -1;
  for (let r = 0; r < cwt.nScales; r++) if (out[r] > best) { best = out[r]; bestRow = r; }
  assert.ok(Math.abs(bestRow - j) <= 1, `best row ${bestRow} vs ${j}`);
});

test('streaming CWT: resolves two tones an octave apart', () => {
  const fs = 48000;
  const cwt = new StreamingCWT({ sampleRate: fs, fMin: 100, fMax: 2000, binsPerOctave: 12, omega0: 6, hopSamples: 960 });
  const f1 = cwt.freqs[12];
  const f2 = cwt.freqs[24];
  const s = tone(fs, fs, f1, 0.3);
  const s2 = tone(fs, fs, f2, 0.3);
  for (let i = 0; i < s.length; i++) s[i] += s2[i];
  cwt.push(s);
  const out = new Float32Array(cwt.nScales);
  while (cwt.available > 1) cwt.nextColumn(out);
  cwt.nextColumn(out);
  assert.ok(out[12] > 0.25 && out[24] > 0.25, `both tones present: ${out[12]} ${out[24]}`);
  assert.ok(out[18] < 0.15, `valley between tones: ${out[18]}`);
});

test('streaming CWT: a tone above fMax does not alias into the band', () => {
  const fs = 48000;
  const cwt = new StreamingCWT({ sampleRate: fs, fMin: 100, fMax: 2000, binsPerOctave: 8, omega0: 6, hopSamples: 960 });
  const above = cwt.decRate - cwt.freqs[10]; // would fold exactly onto row 10 without a filter
  cwt.push(tone(fs, fs, above, 0.5));
  const out = new Float32Array(cwt.nScales);
  while (cwt.available > 1) cwt.nextColumn(out);
  cwt.nextColumn(out);
  let peak = 0;
  for (let r = 0; r < cwt.nScales; r++) peak = Math.max(peak, out[r]);
  assert.ok(peak < 0.01, `in-band leakage ${peak}`);
});

test('streaming CWT: pushing in small chunks gives the same columns as one push', () => {
  const fs = 48000;
  const mk = () => new StreamingCWT({ sampleRate: fs, fMin: 100, fMax: 4000, binsPerOctave: 8, omega0: 6, hopSamples: 480 });
  const a = mk();
  const b = mk();
  const s = tone(fs, fs, 700, 0.5);
  a.push(s);
  for (let i = 0; i < s.length; i += 1000) b.push(s.subarray(i, Math.min(i + 1000, s.length)));
  assert.equal(a.available, b.available);
  const oa = new Float32Array(a.nScales);
  const ob = new Float32Array(b.nScales);
  for (let c = 0; c < a.available; c++) {
    assert.equal(a.nextColumn(oa), b.nextColumn(ob));
    for (let r = 0; r < a.nScales; r++) assert.ok(Math.abs(oa[r] - ob[r]) < 1e-6);
  }
});

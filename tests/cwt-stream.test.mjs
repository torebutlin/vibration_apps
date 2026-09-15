import test from 'node:test';
import assert from 'node:assert/strict';
import { StreamingCWT, erbHz, sigmaFHz } from '../shared/js/dsp/cwt.js';

function tone(n, fs, f, amp, offset = 0) {
  const s = new Float32Array(n);
  for (let i = 0; i < n; i++) s[i] = amp * Math.sin((2 * Math.PI * f * (i + offset)) / fs);
  return s;
}

/** Run everything available, leaving `out` holding the newest head. */
function drain(cwt, out) {
  let n = 0;
  while (cwt.pending > 0) {
    cwt.nextColumn(out);
    n++;
  }
  return n;
}

// ---------- bandwidth laws ----------

test('ERB of the auditory filter: about f/9 in the treble, ~25 Hz at the bottom', () => {
  assert.ok(Math.abs(erbHz(1000) - 132.6) < 1, `1 kHz: ${erbHz(1000)}`);
  assert.ok(Math.abs(erbHz(20) - 26.9) < 1, `20 Hz: ${erbHz(20)}`);
  // Q = f/ERB collapses at low frequency — the reason hearing places a
  // low thump in time far better than a constant-Q analysis does
  assert.ok(1000 / erbHz(1000) > 7 && 1000 / erbHz(1000) < 8);
  assert.ok(20 / erbHz(20) < 1);
});

test('constant Q keeps f/sigma_f fixed; the auditory law does not', () => {
  for (const f of [50, 500, 5000]) {
    assert.ok(Math.abs(sigmaFHz(f, 'constq', 12) - f / 12) < 1e-9);
  }
  const qLow = 20 / sigmaFHz(20, 'ear');
  const qHigh = 2000 / sigmaFHz(2000, 'ear');
  assert.ok(qHigh > 5 * qLow, `ear Q: ${qLow} at 20 Hz vs ${qHigh} at 2 kHz`);
});

// ---------- per-scale latency ----------

test('each scale waits only for its own wavelet, not the widest', () => {
  const cwt = new StreamingCWT({
    sampleRate: 48000, fMin: 20, fMax: 2000, binsPerOctave: 16, omega0: 24, hopSamples: 300,
  });
  const top = cwt.nScales - 1;
  // 4 sigma at f, in seconds: 2 omega0 / (pi f)
  const expect = (f) => (2 * 24) / (Math.PI * f);
  assert.ok(Math.abs(cwt.lagSeconds[0] - expect(20)) < 0.02, `20 Hz: ${cwt.lagSeconds[0]}`);
  assert.ok(Math.abs(cwt.lagSeconds[top] - expect(2000)) < 0.01, `2 kHz: ${cwt.lagSeconds[top]}`);
  assert.ok(cwt.lagSeconds[0] > 50 * cwt.lagSeconds[top], 'the bass trails the treble by orders');
  // lags are monotone in frequency, so a row's edge is its lowest scale's
  for (let j = 1; j < cwt.nScales; j++) assert.ok(cwt.lagCols[j] <= cwt.lagCols[j - 1]);
});

test('the auditory law brings the bottom of the band nearly up to date', () => {
  const opts = { sampleRate: 48000, fMin: 20, fMax: 2000, binsPerOctave: 32, hopSamples: 300 };
  const q = new StreamingCWT({ ...opts, omega0: 24 });
  const ear = new StreamingCWT({ ...opts, bandwidth: 'ear' });
  assert.ok(q.maxLagSeconds > 0.7, `constant Q: ${q.maxLagSeconds}`);
  assert.ok(ear.maxLagSeconds < 0.09, `ear: ${ear.maxLagSeconds}`);
  // and it is much cheaper, the windows being shorter where they were worst
  const work = (c) => c.half.reduce((a, b) => a + b, 0);
  assert.ok(work(ear) * 3 < work(q), `${work(ear)} vs ${work(q)} taps`);
});

test('heads advance one column at a time, one hop apart', () => {
  const fs = 48000;
  const cwt = new StreamingCWT({ sampleRate: fs, fMin: 100, fMax: 4000, binsPerOctave: 8, omega0: 6, hopSamples: 480 });
  assert.equal(cwt.hop % cwt.decimation, 0, 'hop is a whole number of decimated samples');
  cwt.push(new Float32Array(1000));
  assert.equal(cwt.pending, 0, 'nothing computable inside the widest wavelet');
  cwt.push(new Float32Array(fs));
  const out = new Float32Array(cwt.nScales);
  const h0 = cwt.nextColumn(out);
  const h1 = cwt.nextColumn(out);
  assert.equal(h1 - h0, 1, 'heads are consecutive');
  assert.equal(cwt.totalAt(h1) - cwt.totalAt(h0), cwt.hop, 'one hop of stream per head');
});

// ---------- amplitude and selectivity ----------

for (const bandwidth of ['constq', 'ear']) {
  test(`${bandwidth}: a tone at a scale centre reads its amplitude on that row`, () => {
    const fs = 48000;
    const cwt = new StreamingCWT({
      sampleRate: fs, fMin: 50, fMax: 5000, binsPerOctave: 12, omega0: 6, bandwidth, hopSamples: 960,
    });
    const j = 24;
    const f = cwt.freqs[j];
    const amp = 0.4;
    cwt.push(tone(fs * 2, fs, f, amp));
    const out = new Float32Array(cwt.nScales);
    let sum = 0;
    let n = 0;
    while (cwt.pending > 0) {
      cwt.nextColumn(out);
      if (n > 5) sum += out[j]; // skip the first columns (decimator warm-up)
      n++;
    }
    const mean = sum / (n - 6);
    assert.ok(Math.abs(mean - amp) / amp < 0.03, `row amp ${mean} vs ${amp}`);
    let best = -1;
    let bestRow = -1;
    for (let r = 0; r < cwt.nScales; r++) if (out[r] > best) { best = out[r]; bestRow = r; }
    assert.ok(Math.abs(bestRow - j) <= 1, `best row ${bestRow} vs ${j}`);
  });
}

test('the wavelets are zero-mean: a DC offset reads nothing on any row', () => {
  const fs = 48000;
  // the auditory law puts barely two cycles under the envelope at 20 Hz,
  // where an uncorrected Morlet would answer to DC
  const cwt = new StreamingCWT({
    sampleRate: fs, fMin: 20, fMax: 500, binsPerOctave: 8, bandwidth: 'ear', hopSamples: 960,
  });
  cwt.push(new Float32Array(fs * 2).fill(0.5));
  const out = new Float32Array(cwt.nScales);
  const n = drain(cwt, out);
  assert.ok(n > 0, 'columns were produced');
  let peak = 0;
  for (let r = 0; r < cwt.nScales; r++) peak = Math.max(peak, out[r]);
  assert.ok(peak < 0.01, `DC leakage ${peak} of 0.5`);
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
  drain(cwt, out);
  assert.ok(out[12] > 0.25 && out[24] > 0.25, `both tones present: ${out[12]} ${out[24]}`);
  assert.ok(out[18] < 0.15, `valley between tones: ${out[18]}`);
});

test('streaming CWT: a tone above fMax does not alias into the band', () => {
  const fs = 48000;
  const cwt = new StreamingCWT({ sampleRate: fs, fMin: 100, fMax: 2000, binsPerOctave: 8, omega0: 6, hopSamples: 960 });
  const above = cwt.decRate - cwt.freqs[10]; // would fold exactly onto row 10 without a filter
  cwt.push(tone(fs, fs, above, 0.5));
  const out = new Float32Array(cwt.nScales);
  drain(cwt, out);
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
  assert.equal(a.pending, b.pending);
  const oa = new Float32Array(a.nScales);
  const ob = new Float32Array(b.nScales);
  for (let c = 0, n = a.pending; c < n; c++) {
    assert.equal(a.nextColumn(oa), b.nextColumn(ob));
    for (let r = 0; r < a.nScales; r++) assert.ok(Math.abs(oa[r] - ob[r]) < 1e-6);
  }
});

test('an impulse lands at its own instant on every row', () => {
  const fs = 48000;
  const cwt = new StreamingCWT({
    sampleRate: fs, fMin: 100, fMax: 1600, binsPerOctave: 8, omega0: 6, hopSamples: 480,
  });
  const n = fs * 2;
  const s = new Float32Array(n);
  const at = fs; // one second in
  s[at] = 1;
  const out = new Float32Array(cwt.nScales);
  const peakAt = new Float64Array(cwt.nScales).fill(-1);
  const peak = new Float64Array(cwt.nScales);
  // fed the way the app feeds it — a block at a time, drained as it goes,
  // so nothing ages out of the ring before it is used
  for (let i = 0; i < n; i += 2048) {
    cwt.push(s.subarray(i, Math.min(i + 2048, n)));
    let h;
    while ((h = cwt.nextColumn(out)) !== null) {
      for (let j = 0; j < cwt.nScales; j++) {
        if (out[j] > peak[j]) {
          peak[j] = out[j];
          // each scale reports on the column its own lag behind the head
          peakAt[j] = cwt.totalAt(h - cwt.lagCols[j]);
        }
      }
    }
  }
  for (let j = 0; j < cwt.nScales; j++) {
    const err = Math.abs(peakAt[j] - at) / fs;
    assert.ok(err < 0.02, `scale ${j} (${cwt.freqs[j].toFixed(0)} Hz) peaks ${err.toFixed(3)} s off`);
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { MultiResSpectrum } from '../shared/js/dsp/multires.js';
import { MorletCWT } from '../shared/js/dsp/cwt.js';

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
    s[i] = sigma * (acc - 6);
  }
  return s;
}

test('multires recovers tone amplitude in every region', () => {
  const fs = 48000;
  const baseSize = 2048;
  const mr = new MultiResSpectrum({ baseSize, windowName: 'hann', sampleRate: fs });
  // Region boundaries: fs/8 = 6000, fs/32 = 1500
  const tones = [
    { freq: 12000, amp: 0.3 }, // stage 0 region (6k..24k)
    { freq: 3000, amp: 0.2 },  // stage 1 region (1.5k..6k)
    { freq: 100, amp: 0.1 },   // stage 2 region (0..1.5k)
  ];
  const n = mr.maxSize;
  const s = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (const t of tones) v += t.amp * Math.sin((2 * Math.PI * t.freq * i) / fs);
    s[i] = v;
  }
  // multiple frames so all cadences fire
  for (let f = 0; f < 8; f++) mr.process(s, 0.05);
  const segs = mr.segments('amplitude', false);
  assert.equal(segs.length, 3);
  for (const t of tones) {
    const seg = segs.find((g) => t.freq > g.fLow && t.freq <= g.fHigh);
    assert.ok(seg, `segment for ${t.freq}`);
    let peak = 0;
    for (const v of seg.values) peak = Math.max(peak, v);
    // tones are not bin-centred; hann worst-case scalloping ~15%
    assert.ok(Math.abs(peak - t.amp) / t.amp < 0.16, `tone ${t.freq}: peak ${peak} vs ${t.amp}`);
  }
});

test('multires PSD is continuous across boundaries for white noise', () => {
  const fs = 48000;
  const mr = new MultiResSpectrum({ baseSize: 1024, windowName: 'hann', sampleRate: fs });
  mr.expTimeConst = 0.01; // effectively per-frame; rely on many frames
  const n = mr.maxSize;
  for (let f = 0; f < 150; f++) mr.process(makeNoise(n, 0.1, 7 + f * 7919), 0.05);
  const segs = mr.segments('psd', false);
  const expected = (2 * 0.1 * 0.1) / fs;
  for (const seg of segs) {
    let sum = 0;
    let count = 0;
    const from = Math.floor(seg.values.length * 0.2);
    const to = Math.floor(seg.values.length * 0.9);
    for (let i = from; i < to; i++) { sum += seg.values[i]; count++; }
    const mean = sum / count;
    assert.ok(
      Math.abs(mean - expected) / expected < 0.1,
      `segment ${seg.fLow}-${seg.fHigh}: mean ${mean} vs ${expected}`
    );
  }
});

test('multires linear averaging freezes every stage at the target', () => {
  const fs = 48000;
  const mr = new MultiResSpectrum({ baseSize: 1024, windowName: 'hann', sampleRate: fs });
  mr.setAveraging('linear', { linearTarget: 5 });
  const n = mr.maxSize;
  // stage cadences are 1/2/4 frames, so the slowest stage needs 5*4 frames
  for (let f = 0; f < 24; f++) mr.process(makeNoise(n, 0.1, 3 + f * 31), 0.05);
  const prog = mr.linearProgress;
  assert.ok(prog.done, `progress ${prog.count}/${prog.target}`);
  const before = mr.stages.map((s) => Float64Array.from(s.avgPower));
  for (let f = 0; f < 8; f++) mr.process(makeNoise(n, 0.1, 999 + f * 17), 0.05);
  mr.stages.forEach((s, k) => {
    assert.deepEqual(Array.from(s.avgPower), Array.from(before[k]), `stage ${k} frozen`);
  });
});

test('multires peak hold retains maxima after the signal stops', () => {
  const fs = 48000;
  const mr = new MultiResSpectrum({ baseSize: 1024, windowName: 'hann', sampleRate: fs });
  mr.setAveraging('off');
  const n = mr.maxSize;
  const tone = new Float32Array(n);
  for (let i = 0; i < n; i++) tone[i] = 0.5 * Math.sin((2 * Math.PI * 100 * i) / fs);
  for (let f = 0; f < 8; f++) mr.process(tone, 0.05);
  for (let f = 0; f < 8; f++) mr.process(new Float32Array(n), 0.05);
  const live = mr.segments('amplitude', false);
  const held = mr.segments('amplitude', false, 'peak');
  const peakOf = (segs) => {
    let p = 0;
    for (const seg of segs) for (const v of seg.values) p = Math.max(p, v);
    return p;
  };
  assert.ok(peakOf(live) < 1e-6, 'live trace silent');
  assert.ok(Math.abs(peakOf(held) - 0.5) < 0.08, `held peak ${peakOf(held)}`);
  mr.resetPeakHold();
  assert.ok(peakOf(mr.segments('amplitude', false, 'peak')) < 1e-6, 'reset clears hold');
});

test('multires extensions continue each stage past its boundary', () => {
  const fs = 48000;
  const mr = new MultiResSpectrum({ baseSize: 1024, windowName: 'hann', sampleRate: fs });
  const n = mr.maxSize;
  for (let f = 0; f < 8; f++) mr.process(makeNoise(n, 0.1, 5 + f * 13), 0.05);
  const ext = mr.extensions('psd', false, 1.6);
  // stages 1,2 extend up; stages 0,1 extend down => 4 pieces
  assert.equal(ext.length, 4);
  const expected = (2 * 0.1 * 0.1) / fs;
  for (const e of ext) {
    assert.ok(e.values.length > 0, 'extension has bins');
    const lo = Math.min(e.fadeFromHz, e.fadeToHz);
    const hi = Math.max(e.fadeFromHz, e.fadeToHz);
    const f0 = e.startBin * e.binHz;
    const f1 = (e.startBin + e.values.length - 1) * e.binHz;
    assert.ok(f0 >= lo - e.binHz && f1 <= hi + e.binHz, `bins ${f0}-${f1} within ${lo}-${hi}`);
    // white-noise PSD level continues correctly past the boundary
    let mean = 0;
    for (const v of e.values) mean += v;
    mean /= e.values.length;
    assert.ok(Math.abs(mean - expected) / expected < 0.35, `level ${mean} vs ${expected}`);
  }
});

test('CWT localizes a tone at the right scale with correct amplitude', () => {
  const fs = 48000;
  const cwt = new MorletCWT({
    fullSize: 32768, sampleRate: fs, fMin: 50, fMax: 5000, binsPerOctave: 12, omega0: 6,
  });
  // pick an exact scale centre frequency
  const j = 24;
  const f = cwt.freqs[j];
  const amp = 0.4;
  const s = new Float32Array(cwt.fullSize);
  for (let i = 0; i < s.length; i++) s[i] = amp * Math.sin((2 * Math.PI * f * i) / fs);
  const nCols = 16;
  const out = cwt.analyze(s, nCols, 8);
  // amplitude at the tone's row
  let rowMean = 0;
  for (let c = 0; c < nCols; c++) rowMean += out[j * nCols + c];
  rowMean /= nCols;
  assert.ok(Math.abs(rowMean - amp) / amp < 0.02, `row amp ${rowMean} vs ${amp}`);
  // the maximum over scales should be at (or adjacent to) row j
  let best = 0;
  let bestRow = -1;
  for (let r = 0; r < cwt.nScales; r++) {
    let m = 0;
    for (let c = 0; c < nCols; c++) m += out[r * nCols + c];
    if (m > best) { best = m; bestRow = r; }
  }
  assert.ok(Math.abs(bestRow - j) <= 1, `best row ${bestRow} vs ${j}`);
});

test('CWT resolves two tones an octave apart', () => {
  const fs = 48000;
  const cwt = new MorletCWT({
    fullSize: 32768, sampleRate: fs, fMin: 100, fMax: 2000, binsPerOctave: 12, omega0: 6,
  });
  const f1 = cwt.freqs[12];
  const f2 = cwt.freqs[24]; // one octave up
  const s = new Float32Array(cwt.fullSize);
  for (let i = 0; i < s.length; i++) {
    s[i] = 0.3 * Math.sin((2 * Math.PI * f1 * i) / fs) + 0.3 * Math.sin((2 * Math.PI * f2 * i) / fs);
  }
  const out = cwt.analyze(s, 4, 16);
  const rowAmp = (r) => {
    let m = 0;
    for (let c = 0; c < 4; c++) m += out[r * 4 + c];
    return m / 4;
  };
  const mid = rowAmp(18); // halfway between, should dip
  assert.ok(rowAmp(12) > 0.25 && rowAmp(24) > 0.25, 'both tones present');
  assert.ok(mid < 0.15, `valley between tones: ${mid}`);
});

test('CWT latency margin suppresses edge wraparound', () => {
  const fs = 48000;
  const cwt = new MorletCWT({
    fullSize: 16384, sampleRate: fs, fMin: 100, fMax: 4000, binsPerOctave: 8, omega0: 6,
  });
  // Impulse at the very newest sample: its response should NOT contaminate
  // columns at the latency margin (they're 4 sigma away).
  const s = new Float32Array(cwt.fullSize);
  s[s.length - 1] = 1;
  const out = cwt.analyze(s, 1, 1);
  for (let r = 0; r < cwt.nScales; r++) {
    assert.ok(out[r] < 2e-3, `row ${r} leaked ${out[r]}`);
  }
});

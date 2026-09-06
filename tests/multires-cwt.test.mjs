import test from 'node:test';
import assert from 'node:assert/strict';
import { MultiResSpectrum } from '../shared/js/dsp/multires.js';

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
  // stage 2 runs every 4 frames and each of its frames counts 1/4 of an
  // independent average, so 5 averages need 5*4/0.25 = 80 frames
  for (let f = 0; f < 80; f++) mr.process(makeNoise(n, 0.1, 3 + f * 31), 0.05);
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

test('multires linear averaging weights slower stages by their longer windows', () => {
  const fs = 48000;
  const mr = new MultiResSpectrum({ baseSize: 1024, windowName: 'hann', sampleRate: fs });
  mr.setAveraging('linear', { linearTarget: 2 });
  const n = mr.maxSize;
  // weight 1 = the base stage hops by half its window; stage k then hops by
  // 2^k * hop but has a 4^k longer window, so its weight is 1 / 2^k
  for (let f = 0; f < 16; f++) mr.process(makeNoise(n, 0.1, 3 + f * 31), 0.05, 1);
  // every stage also computes on the very first frame, then on its cadence:
  // stage 0: 16 frames x 1          = 16    (done)
  // stage 1: (1 + 8) frames x 0.5   = 4.5   (done)
  // stage 2: (1 + 4) frames x 0.25  = 1.25  (not done)
  assert.equal(mr.stages[2].avgCount, 1.25);
  assert.ok(!mr.linearProgress.done);
  for (let f = 16; f < 32; f++) mr.process(makeNoise(n, 0.1, 3 + f * 31), 0.05, 1);
  // the stage freezes as soon as it reaches the target (8 computes x 0.25)
  assert.equal(mr.stages[2].avgCount, 2);
  assert.ok(mr.linearProgress.done);
});

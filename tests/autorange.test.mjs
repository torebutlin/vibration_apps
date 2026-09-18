import test from 'node:test';
import assert from 'node:assert/strict';
import { levelStats, axisCeiling, AxisLimit } from '../shared/js/plot/autorange.js';

/** One trace segment: `values` starting at bin `startBin`, `binHz` apart. */
function seg(values, { binHz = 1, startBin = 0 } = {}) {
  return { binHz, startBin, values: Float32Array.from(values) };
}

/** A flat trace with a tone on top: the shape the spectrum usually has. */
function toneOnFloor({ n = 1000, floorDb = -110, toneDb = -40, at = 100 } = {}) {
  const v = new Array(n).fill(floorDb);
  v[at] = toneDb;
  return seg(v);
}

// ---------- levelStats ----------

test('levelStats: peak and floor of a tone on a flat noise floor', () => {
  const st = levelStats([toneOnFloor()], 0, 1000);
  assert.equal(st.peak, -40);
  assert.equal(st.count, 1000);
  // the floor sits at the body of the trace, not 110 dB under the tone
  assert.ok(st.low <= -110 && st.low >= -112, `low ${st.low}`);
});

test('levelStats: one deep null does not drag the floor down', () => {
  const values = new Array(1000).fill(-110);
  values[100] = -40;
  values[500] = -250;   // a single null, 140 dB down
  const st = levelStats([seg(values)], 0, 1000);
  assert.ok(st.low >= -112, `low ${st.low}`);
});

test('levelStats: a floor that most of the band really sits at is found', () => {
  // half the band 30 dB below the rest: well past the 2% tail
  const values = new Array(1000).fill(-80);
  for (let i = 500; i < 1000; i++) values[i] = -110;
  const st = levelStats([seg(values)], 0, 1000);
  assert.ok(st.low <= -110 && st.low >= -112, `low ${st.low}`);
});

test('levelStats: only the bins inside the band count', () => {
  const values = new Array(1000).fill(-110);
  values[900] = -10;    // a loud tone outside the displayed band
  for (let i = 0; i < 100; i++) values[i] = -60;
  const st = levelStats([seg(values)], 0, 99);
  assert.equal(st.peak, -60);
  assert.equal(st.count, 100);
});

test('levelStats: segments with different bin widths are pooled', () => {
  const coarse = seg(new Array(50).fill(-90), { binHz: 10 });          // 0..490 Hz
  const fine = seg(new Array(200).fill(-50), { binHz: 1, startBin: 0 }); // 0..199 Hz
  const st = levelStats([coarse, fine], 0, 500);
  assert.equal(st.peak, -50);
  assert.equal(st.count, 250);
});

test('levelStats: an empty band returns null', () => {
  assert.equal(levelStats([seg([-100, -100])], 500, 600), null);
});

test('levelStats: floor:false skips the quantile', () => {
  const st = levelStats([toneOnFloor()], 0, 1000, { floor: false });
  assert.equal(st.peak, -40);
  assert.equal(st.low, -40);
});

test('levelStats: a caller-supplied histogram is reused, not grown', () => {
  const hist = new Int32Array(160);
  const a = levelStats([toneOnFloor()], 0, 1000, { hist });
  const b = levelStats([toneOnFloor()], 0, 1000, { hist });
  assert.deepEqual(a, b);
});

// ---------- axisCeiling ----------

test('axisCeiling: headroom above the peak, quantized up to the grid', () => {
  assert.equal(axisCeiling(-42), -35);   // -42 + 6 = -36, up to the 5 dB grid
  assert.equal(axisCeiling(-40), -30);   // exactly on a grid line: still clear
  assert.equal(axisCeiling(-44, { headroom: 12 }), -30); // big labels
});

test('axisCeiling: a quiet signal brings the ceiling down with it', () => {
  // the whole point: nothing pins the top of the axis to a fixed level
  assert.equal(axisCeiling(-62), -55);
  assert.equal(axisCeiling(-95), -85);
  assert.equal(axisCeiling(-118), -110);
});

test('axisCeiling: full scale and meaningless levels bound it', () => {
  assert.equal(axisCeiling(40), 20, 'a clipping source stops at the top');
  assert.equal(axisCeiling(-300), -140, 'digital silence does not drag it away');
  assert.equal(axisCeiling(-90, { min: -60 }), -60, 'a caller can raise the floor');
});

// ---------- AxisLimit ----------

const frame = (now, dt = 1 / 60, snap = false) => ({ now, dt, snap });

test('AxisLimit: a ceiling follows the data up at once', () => {
  const top = new AxisLimit(-20, +1);
  assert.equal(top.track(0, frame(100)), 0);
  assert.equal(top.track(5, frame(116)), 5);
});

test('AxisLimit: a ceiling holds inside the dead band, then releases slowly', () => {
  const top = new AxisLimit(0, +1, { holdBand: 12, holdMs: 1500, tau: 2.5 });
  assert.equal(top.track(-10, frame(0)), 0, 'inside the dead band: held');
  assert.equal(top.track(-30, frame(100)), 0, 'outside it, but only just now');
  assert.equal(top.track(-30, frame(1000)), 0, 'still inside the hold time');
  const after = top.track(-30, frame(2000, 0.1));
  assert.ok(after < 0 && after > -30, `glides, not jumps: ${after}`);
  // one time constant of frames gets roughly 63% of the way there
  let t = 2000;
  for (let i = 0; i < 25; i++) t += 100, top.track(-30, frame(t, 0.1));
  assert.ok(top.value < -17 && top.value > -22, `after tau: ${top.value}`);
  // and it arrives: the dead band decides when to release, not where to stop
  for (let i = 0; i < 150; i++) t += 100, top.track(-30, frame(t, 0.1));
  assert.equal(top.value, -30);
});

test('AxisLimit: a floor moves down at once and back up slowly', () => {
  const bottom = new AxisLimit(-100, -1, { holdBand: 12, holdMs: 1500, tau: 2.5 });
  assert.equal(bottom.track(-130, frame(0)), -130, 'data went quiet: drop now');
  assert.equal(bottom.track(-125, frame(100)), -130, 'inside the dead band: held');
  assert.equal(bottom.track(-90, frame(200)), -130, 'outside it, but only just now');
  let t = 200;
  // 4 s on: 1.5 s of hold and then one time constant of glide (63% of 40 dB)
  for (let i = 0; i < 38; i++) t += 100, bottom.track(-90, frame(t, 0.1));
  assert.ok(bottom.value > -110 && bottom.value < -100, `one tau in: ${bottom.value}`);
  for (let i = 0; i < 150; i++) t += 100, bottom.track(-90, frame(t, 0.1));
  assert.equal(bottom.value, -90, 'settles right up to the data');
});

test('AxisLimit: snap skips the hysteresis entirely', () => {
  const top = new AxisLimit(0, +1);
  assert.equal(top.track(-70, frame(0, 1 / 60, true)), -70);
  const bottom = new AxisLimit(-100, -1);
  assert.equal(bottom.track(-40, frame(0, 1 / 60, true)), -40);
});

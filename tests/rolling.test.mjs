import test from 'node:test';
import assert from 'node:assert/strict';
import { RollingPowerAverage } from '../shared/js/dsp/rolling.js';

/** A flat "spectrum" of n bins, all of value v. */
function flat(n, v) {
  return Float64Array.from({ length: n }, () => v);
}

/** A spectrum whose bins are v scaled by the bin index, so a mean that
 *  mixed bins up would show. */
function ramp(n, v) {
  return Float64Array.from({ length: n }, (_, k) => v * (1 + k));
}

test('the mean is over exactly the last N frames', () => {
  const n = 8;
  const target = 4;
  const r = new RollingPowerAverage(n, target);
  const out = new Float64Array(n);
  for (let i = 1; i <= 10; i++) r.add(ramp(n, i), 1);
  r.writeTo(out);
  // frames 7..10 are in the window; 1..6 have left it
  const want = (7 + 8 + 9 + 10) / target;
  for (let k = 0; k < n; k++) assert.ok(Math.abs(out[k] - want * (1 + k)) < 1e-4, `bin ${k}: ${out[k]}`);
});

test('a window that is still filling averages what it has', () => {
  const n = 4;
  const r = new RollingPowerAverage(n, 8);
  const out = new Float64Array(n);
  r.writeTo(out);
  assert.deepEqual([...out], [0, 0, 0, 0], 'nothing in it yet');
  r.add(flat(n, 2), 1);
  r.add(flat(n, 4), 1);
  r.writeTo(out);
  assert.ok(!r.full);
  assert.equal(r.frames, 2);
  for (const v of out) assert.ok(Math.abs(v - 3) < 1e-5, `${v}`);
});

test('a steady signal reads as itself at every point in the cycle', () => {
  const n = 4;
  const r = new RollingPowerAverage(n, 5);
  const out = new Float64Array(n);
  const x = flat(n, 7);
  // odd weights, so the window is sampled part-way through a slot as well
  for (let i = 0; i < 40; i++) {
    r.add(x, 0.3);
    r.writeTo(out);
    for (const v of out) assert.ok(Math.abs(v - 7) < 1e-4, `step ${i}: ${v}`);
  }
  assert.ok(r.full);
  assert.ok(Math.abs(r.frames - 5) < 1e-9);
});

test('the window forgets: N frames later nothing of the old signal is left', () => {
  const n = 4;
  const target = 6;
  const r = new RollingPowerAverage(n, target);
  const out = new Float64Array(n);
  for (let i = 0; i < 50; i++) r.add(flat(n, 100), 1);
  for (let i = 0; i < target; i++) r.add(flat(n, 1), 1);
  r.writeTo(out);
  for (const v of out) assert.ok(Math.abs(v - 1) < 1e-5, `${v}`);
});

test('frames count whatever weight they arrive in', () => {
  const n = 4;
  const target = 4;
  const fine = new RollingPowerAverage(n, target);
  const coarse = new RollingPowerAverage(n, target);
  const a = new Float64Array(n);
  const b = new Float64Array(n);
  for (let i = 1; i <= 12; i++) {
    const x = ramp(n, i);
    coarse.add(x, 1);
    for (let j = 0; j < 4; j++) fine.add(x, 0.25);
  }
  fine.writeTo(a);
  coarse.writeTo(b);
  assert.ok(Math.abs(fine.frames - target) < 1e-9);
  for (let k = 0; k < n; k++) assert.ok(Math.abs(a[k] - b[k]) < 1e-4, `bin ${k}: ${a[k]} vs ${b[k]}`);
});

test('a budget too small for one slot per frame still spans N frames', () => {
  const n = 64;
  const target = 16;
  // room for four slots: each banks four frames, so the window slides in
  // coarser steps but is still sixteen frames long
  const r = new RollingPowerAverage(n, target, 4 * n * 4);
  assert.equal(r.slotCount, 4);
  assert.equal(r.slotWeight, 4);
  const out = new Float64Array(n);
  for (let i = 0; i < 40; i++) r.add(flat(n, 9), 1);
  r.writeTo(out);
  assert.ok(r.full);
  assert.ok(Math.abs(r.frames - target) < 1e-9);
  for (const v of out) assert.ok(Math.abs(v - 9) < 1e-4, `${v}`);
  // and it still forgets completely within N frames
  for (let i = 0; i < target; i++) r.add(flat(n, 1), 1);
  r.writeTo(out);
  for (const v of out) assert.ok(Math.abs(v - 1) < 1e-5, `${v}`);
});

test('the ring never costs more than its budget', () => {
  const n = 4096;
  const r = new RollingPowerAverage(n, 128, 1 << 20);
  // one slot over the window's length: the one being filled
  assert.equal(r.slots.length, (r.slotCount + 1) * n);
  assert.ok(r.slotCount * n * 4 <= (1 << 20), `${r.slotCount} slots`);
  assert.ok(Math.abs(r.slotCount * r.slotWeight - 128) < 1e-9, 'the slots span the target');
});

test('a reset empties the window', () => {
  const n = 4;
  const r = new RollingPowerAverage(n, 4);
  const out = new Float64Array(n);
  for (let i = 0; i < 10; i++) r.add(flat(n, 5), 1);
  r.reset();
  assert.equal(r.frames, 0);
  assert.ok(!r.full);
  r.writeTo(out);
  assert.deepEqual([...out], [0, 0, 0, 0]);
  r.add(flat(n, 2), 1);
  r.writeTo(out);
  for (const v of out) assert.ok(Math.abs(v - 2) < 1e-6, `${v}`);
});

test('a long run does not let the running sum drift', () => {
  const n = 4;
  const target = 8;
  const r = new RollingPowerAverage(n, target);
  const out = new Float64Array(n);
  // values spanning many decades, so any cancellation error would show
  for (let i = 0; i < 20000; i++) r.add(flat(n, 1e-9 + (i % 7) * 1e3), 1);
  for (let i = 0; i < target; i++) r.add(flat(n, 2), 1);
  r.writeTo(out);
  for (const v of out) assert.ok(Math.abs(v - 2) < 1e-6, `${v}`);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { FrameHopper } from '../shared/js/dsp/hop.js';

test('first call is due and sets the reference', () => {
  const h = new FrameHopper(2048);
  assert.equal(h.due(5000), true);
  assert.equal(h.due(5001), false);
});

test('one frame per hop of new samples, whatever the call cadence', () => {
  const fine = new FrameHopper(2048);
  let nFine = 0;
  for (let t = 0; t <= 100000; t += 300) if (fine.due(t)) nFine++;
  assert.equal(nFine, 1 + Math.floor(100000 / 2048));

  const coarse = new FrameHopper(2048);
  let nCoarse = 0;
  let lastDue = -Infinity;
  for (let t = 0; t <= 100000; t += 5000) {
    if (coarse.due(t)) {
      assert.ok(t - lastDue >= 2048, 'dues are at least one hop apart');
      lastDue = t;
      nCoarse++;
    }
  }
  assert.equal(nCoarse, 21);
});

test('a sample counter that goes backwards (source restart) resyncs', () => {
  const h = new FrameHopper(1024);
  h.due(50000);
  assert.equal(h.due(100), true);
  assert.equal(h.due(200), false);
  assert.equal(h.due(1200), true);
});

test('changing the hop keeps the reference', () => {
  const h = new FrameHopper(1024);
  h.due(0);
  h.setHop(4096);
  assert.equal(h.due(2000), false);
  assert.equal(h.due(4096), true);
});

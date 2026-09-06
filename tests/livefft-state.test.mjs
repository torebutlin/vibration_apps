import test from 'node:test';
import assert from 'node:assert/strict';
import {
  State,
  CWT_BPO_OPTIONS,
  recommendedBinsPerOctave,
  effectiveBinsPerOctave,
} from '../apps/livefft/js/state.js';

test('bins per octave that match the wavelet Q: 8 / 16 / 32 for ω₀ = 6 / 12 / 24', () => {
  assert.equal(recommendedBinsPerOctave(6), 8);
  assert.equal(recommendedBinsPerOctave(12), 16);
  assert.equal(recommendedBinsPerOctave(24), 32);
});

test('the matched density puts two scales across each wavelet band (σ_f = f/ω₀)', () => {
  for (const omega0 of [6, 12, 24]) {
    const B = recommendedBinsPerOctave(omega0);
    const spacing = Math.pow(2, 1 / B) - 1; // relative step between neighbouring scales
    const halfBand = 1 / (2 * omega0);
    assert.ok(Math.abs(spacing / halfBand - 1) < 0.1, `ω₀ ${omega0}: step ${spacing} vs ${halfBand}`);
  }
});

test('recommendation is always one of the offered options', () => {
  for (const omega0 of [3, 6, 9, 12, 18, 24, 48]) {
    assert.ok(CWT_BPO_OPTIONS.includes(recommendedBinsPerOctave(omega0)));
  }
});

test('effective bins follow Q while Auto, the manual value otherwise', () => {
  const values = { cwtBpoAuto: true, cwtOmega0: 24, cwtBinsPerOctave: 12 };
  const state = { get: (k) => values[k] };
  assert.equal(effectiveBinsPerOctave(state), 32);
  values.cwtBpoAuto = false;
  assert.equal(effectiveBinsPerOctave(state), 12);
});

test('State.update stores the whole patch before any listener runs', () => {
  const state = new State();
  const seen = [];
  state.on(['cwtBpoAuto', 'cwtBinsPerOctave'], (_v, key) => {
    seen.push([key, state.get('cwtBpoAuto'), state.get('cwtBinsPerOctave')]);
  });
  state.update({ cwtBpoAuto: false, cwtBinsPerOctave: 24 });
  assert.deepEqual(seen, [
    ['cwtBpoAuto', false, 24],
    ['cwtBinsPerOctave', false, 24],
  ]);
  state.update({ cwtBpoAuto: false }); // unchanged: no emission
  assert.equal(seen.length, 2);
});

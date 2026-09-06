import test from 'node:test';
import assert from 'node:assert/strict';
import {
  State,
  CWT_BPO_OPTIONS,
  CWT_FLOOR_HZ,
  recommendedBinsPerOctave,
  effectiveBinsPerOctave,
  freqRange,
} from '../apps/livefft/js/state.js';

/** A state stub: the defaults with a patch applied. */
function fakeState(patch = {}) {
  const values = {
    freqScale: 'auto',
    freqMin: 20,
    freqMax: 5000,
    freqAuto: false,
    resMode: 'standard',
    sgMode: 'stft',
    ...patch,
  };
  return { get: (k) => values[k] };
}

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

test('Full range is 0..fs/2 on a linear axis, from the floor on a log one', () => {
  const linear = freqRange(fakeState({ freqAuto: true }), 'spectrum', 48000);
  assert.deepEqual(linear, { min: 0, max: 24000, log: false });
  const log = freqRange(fakeState({ freqAuto: true, freqScale: 'log' }), 'spectrum', 48000);
  assert.deepEqual(log, { min: CWT_FLOOR_HZ, max: 24000, log: true });
});

test('a manual range is clamped to Nyquist', () => {
  const fr = freqRange(fakeState({ freqMax: 20000 }), 'spectrum', 16000);
  assert.equal(fr.max, 8000);
  assert.equal(fr.min, 20);
});

test('the wavelet analyses the displayed range, never below the floor', () => {
  const cwt = { sgMode: 'cwt' };
  // Full: the whole band from the floor up, whatever the axis scale
  const full = freqRange(fakeState({ ...cwt, freqAuto: true, freqScale: 'linear' }), 'spectrogram', 48000);
  assert.deepEqual(full, { min: CWT_FLOOR_HZ, max: 24000, log: false });
  // a preset: exactly what is on display
  const preset = freqRange(fakeState({ ...cwt, freqMin: 20, freqMax: 2000 }), 'spectrogram', 48000);
  assert.deepEqual(preset, { min: 20, max: 2000, log: true });
  // a zoom that starts at DC still starts the wavelet at the floor
  const zoom = freqRange(fakeState({ ...cwt, freqMin: 0, freqMax: 500 }), 'spectrogram', 48000);
  assert.equal(zoom.min, CWT_FLOOR_HZ);
  // the STFT keeps DC
  const stft = freqRange(fakeState({ freqMin: 0, freqMax: 500 }), 'spectrogram', 48000);
  assert.equal(stft.min, 0);
});

test('a range left above the current Nyquist stays usable', () => {
  const fr = freqRange(fakeState({ freqMin: 12000, freqMax: 20000 }), 'spectrogram', 16000);
  assert.ok(fr.min < fr.max, `${fr.min} < ${fr.max}`);
  assert.equal(fr.max, 8000);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { fftInPlace, rfft, rfftMagSq } from '../shared/js/dsp/fft.js';
import { getWindow } from '../shared/js/dsp/windows.js';

function naiveDft(signal) {
  const n = signal.length;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    for (let t = 0; t < n; t++) {
      const ang = (-2 * Math.PI * k * t) / n;
      re[k] += signal[t] * Math.cos(ang);
      im[k] += signal[t] * Math.sin(ang);
    }
  }
  return { re, im };
}

test('fft matches naive DFT for random signal', () => {
  const n = 64;
  const signal = new Float64Array(n);
  let seed = 12345;
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    signal[i] = seed / 2147483648 - 0.5;
  }
  const expected = naiveDft(signal);
  const re = Float64Array.from(signal);
  const im = new Float64Array(n);
  fftInPlace(re, im);
  for (let k = 0; k < n; k++) {
    assert.ok(Math.abs(re[k] - expected.re[k]) < 1e-9, `re[${k}]`);
    assert.ok(Math.abs(im[k] - expected.im[k]) < 1e-9, `im[${k}]`);
  }
});

test('inverse fft round-trips', () => {
  const n = 256;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = Math.sin((2 * Math.PI * 7 * i) / n) + 0.3 * i / n;
  const orig = Float64Array.from(re);
  fftInPlace(re, im, false);
  fftInPlace(re, im, true);
  for (let i = 0; i < n; i++) {
    assert.ok(Math.abs(re[i] / n - orig[i]) < 1e-9);
    assert.ok(Math.abs(im[i] / n) < 1e-9);
  }
});

test('rfft of pure sine puts energy in the right bin with amplitude N/2', () => {
  const n = 1024;
  const bin = 37;
  const amp = 0.8;
  const signal = new Float64Array(n);
  for (let i = 0; i < n; i++) signal[i] = amp * Math.sin((2 * Math.PI * bin * i) / n);
  const { re, im } = rfft(signal);
  const mag = new Float64Array(n / 2 + 1);
  for (let k = 0; k <= n / 2; k++) mag[k] = Math.hypot(re[k], im[k]);
  assert.ok(Math.abs(mag[bin] - (amp * n) / 2) < 1e-6);
  for (let k = 0; k <= n / 2; k++) {
    if (k !== bin) assert.ok(mag[k] < 1e-6, `leakage at bin ${k}`);
  }
});

test('Parseval: sum |X|^2 = N * sum x^2', () => {
  const n = 512;
  const signal = new Float64Array(n);
  let seed = 999;
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    signal[i] = seed / 2147483648 - 0.5;
  }
  const re = Float64Array.from(signal);
  const im = new Float64Array(n);
  fftInPlace(re, im);
  let sumTime = 0;
  for (let i = 0; i < n; i++) sumTime += signal[i] * signal[i];
  let sumFreq = 0;
  for (let k = 0; k < n; k++) sumFreq += re[k] * re[k] + im[k] * im[k];
  assert.ok(Math.abs(sumFreq - n * sumTime) / (n * sumTime) < 1e-10);
});

test('rfftMagSq agrees with rfft magnitudes', () => {
  const n = 128;
  const signal = new Float64Array(n);
  for (let i = 0; i < n; i++) signal[i] = Math.cos((2 * Math.PI * 5 * i) / n) + 0.1;
  const { re, im } = rfft(signal);
  const magSq = rfftMagSq(signal);
  for (let k = 0; k <= n / 2; k++) {
    assert.ok(Math.abs(magSq[k] - (re[k] * re[k] + im[k] * im[k])) < 1e-8);
  }
});

test('window correction factors match known values', () => {
  const n = 4096;
  const rect = getWindow('rectangular', n);
  assert.ok(Math.abs(rect.coherentGain - 1) < 1e-12);
  assert.ok(Math.abs(rect.noiseGain - 1) < 1e-12);
  assert.ok(Math.abs(rect.enbwBins - 1) < 1e-12);

  const hann = getWindow('hann', n);
  assert.ok(Math.abs(hann.coherentGain - 0.5) < 1e-3, `hann CG ${hann.coherentGain}`);
  assert.ok(Math.abs(hann.noiseGain - 0.375) < 1e-3, `hann NG ${hann.noiseGain}`);
  assert.ok(Math.abs(hann.enbwBins - 1.5) < 5e-3, `hann ENBW ${hann.enbwBins}`);

  // Flat-top windows have ENBW around 3.77 bins
  const ft = getWindow('flattop', n);
  assert.ok(ft.enbwBins > 3.5 && ft.enbwBins < 4.0, `flattop ENBW ${ft.enbwBins}`);
});

test('windowed sine amplitude recovers with coherent gain correction', () => {
  const n = 4096;
  const bin = 100;
  const amp = 0.5;
  const signal = new Float64Array(n);
  for (let i = 0; i < n; i++) signal[i] = amp * Math.sin((2 * Math.PI * bin * i) / n);
  const { w, coherentGain } = getWindow('hann', n);
  const windowed = new Float64Array(n);
  for (let i = 0; i < n; i++) windowed[i] = signal[i] * w[i];
  const { re, im } = rfft(windowed);
  const mag = Math.hypot(re[bin], im[bin]);
  const recovered = (2 * mag) / (n * coherentGain);
  assert.ok(Math.abs(recovered - amp) / amp < 1e-6, `recovered ${recovered}`);
});

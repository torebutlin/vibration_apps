// Live spectrum pipeline: windowed FFT -> power spectrum -> averaging.
//
// All averaging happens on the one-sided *power* spectrum |X[k]|^2
// (Welch-style). Display quantities are derived from the averaged power:
//
//   amplitude spectrum (peak) : A[k]   = 2*sqrt(P[k]) / (N*CG)
//   amplitude spectrum (rms)  : Arms   = A / sqrt(2)
//   PSD                       : S[k]   = 2*P[k] / (fs * N * NG)
//
// where CG = coherent gain = mean(w), NG = noise gain = mean(w^2).
// DC and Nyquist bins do not get the factor 2. With a full-scale input of
// +-1, dB quantities are dBFS (sine at full scale reads 0 dBFS on the
// amplitude spectrum with amplitude reference 'peak').

import { rfftMagSq } from './fft.js';
import { getWindow } from './windows.js';

export const AVG_MODES = ['off', 'exponential', 'linear'];

export class SpectrumProcessor {
  constructor({ fftSize = 4096, windowName = 'hann', sampleRate = 48000 } = {}) {
    this.sampleRate = sampleRate;
    this.avgMode = 'exponential';
    this.expTimeConst = 0.5;    // seconds
    this.linearTarget = 16;     // frames; freeze when reached
    this.configure(fftSize, windowName);
  }

  configure(fftSize, windowName) {
    this.fftSize = fftSize;
    this.windowName = windowName;
    const { w, coherentGain, noiseGain } = getWindow(windowName, fftSize);
    this.window = w;
    this.coherentGain = coherentGain;
    this.noiseGain = noiseGain;
    const nBins = fftSize / 2 + 1;
    this.nBins = nBins;
    this.windowed = new Float64Array(fftSize);
    this.power = new Float64Array(nBins);      // instantaneous
    this.avgPower = new Float64Array(nBins);   // averaged
    this.peakPower = new Float64Array(nBins);  // peak hold
    this.resetAverage();
    this.resetPeakHold();
  }

  setAveraging(mode, { expTimeConst, linearTarget } = {}) {
    if (!AVG_MODES.includes(mode)) throw new Error(`Unknown averaging mode: ${mode}`);
    this.avgMode = mode;
    if (expTimeConst !== undefined) this.expTimeConst = expTimeConst;
    if (linearTarget !== undefined) this.linearTarget = linearTarget;
    this.resetAverage();
  }

  resetAverage() {
    this.avgPower.fill(0);
    this.avgCount = 0;
    this.linearDone = false;
  }

  resetPeakHold() {
    this.peakPower.fill(0);
    this.peakValid = false;
  }

  get binHz() {
    return this.sampleRate / this.fftSize;
  }

  /**
   * Process one frame of the newest fftSize samples.
   * @param {Float32Array} samples length >= fftSize; the last fftSize are used
   * @param {number} dt seconds since previous frame (for exponential averaging)
   */
  process(samples, dt) {
    const n = this.fftSize;
    const offset = samples.length - n;
    const w = this.window;
    const x = this.windowed;
    for (let i = 0; i < n; i++) x[i] = samples[offset + i] * w[i];
    rfftMagSq(x, this.power);

    const p = this.power;
    const avg = this.avgPower;
    const nb = this.nBins;

    switch (this.avgMode) {
      case 'off':
        avg.set(p);
        this.avgCount = 1;
        break;
      case 'exponential': {
        const alpha = this.avgCount === 0 ? 1 : 1 - Math.exp(-dt / Math.max(this.expTimeConst, 1e-3));
        for (let k = 0; k < nb; k++) avg[k] += alpha * (p[k] - avg[k]);
        this.avgCount++;
        break;
      }
      case 'linear': {
        if (!this.linearDone) {
          const c = this.avgCount;
          for (let k = 0; k < nb; k++) avg[k] = (avg[k] * c + p[k]) / (c + 1);
          this.avgCount = c + 1;
          if (this.avgCount >= this.linearTarget) this.linearDone = true;
        }
        break;
      }
    }

    const pk = this.peakPower;
    for (let k = 0; k < nb; k++) if (avg[k] > pk[k]) pk[k] = avg[k];
    this.peakValid = true;
  }

  /**
   * Convert a power spectrum to the display quantity, in dB or linear.
   * @param {Float64Array} power one-sided |X|^2
   * @param {Float32Array} out length nBins
   * @param {'amplitude'|'rms'|'psd'} quantity
   * @param {boolean} dB
   */
  toDisplay(power, out, quantity, dB) {
    const n = this.fftSize;
    const nb = this.nBins;
    const FLOOR = 1e-30;
    if (quantity === 'psd') {
      const scale = 2 / (this.sampleRate * n * this.noiseGain);
      for (let k = 0; k < nb; k++) {
        let v = power[k] * scale;
        if (k === 0 || k === nb - 1) v /= 2; // no one-sided doubling at DC/Nyquist
        out[k] = dB ? 10 * Math.log10(Math.max(v, FLOOR)) : v;
      }
    } else {
      // peak amplitude: A = 2|X|/(N CG) inner bins, |X|/(N CG) at DC/Nyquist.
      // rms: inner bins A/sqrt(2); DC/Nyquist are already RMS values.
      const c = 2 / (n * this.coherentGain);
      const rms = quantity === 'rms';
      for (let k = 0; k < nb; k++) {
        const edge = k === 0 || k === nb - 1;
        let v = c * Math.sqrt(Math.max(power[k], 0));
        if (edge) v /= 2;
        else if (rms) v /= Math.SQRT2;
        out[k] = dB ? 20 * Math.log10(Math.max(v, 1e-15)) : v;
      }
    }
    return out;
  }
}

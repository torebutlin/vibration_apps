// Multi-resolution "smart" spectrum: three stitched FFT lengths so low
// frequencies get proportionally longer windows (finer resolution) while
// high frequencies stay responsive.
//
// Stage sizes are N, 4N, 16N samples at the full sample rate. Stage k
// covers frequencies up to (fs/2)/4^k, so at each region boundary the
// relative resolution df/f is continuous: crossing down a boundary swaps
// to 4x finer bins at 1/4 the frequency.
//
// Each stage has its own window correction, averaging state and peak hold;
// the longer stages are recomputed at a reduced cadence to bound CPU cost.
// Averaging modes mirror SpectrumProcessor (off / exponential / linear-N-
// then-freeze); in linear mode the longest stage finishes last because it
// updates least often.

import { rfftMagSq } from './fft.js';
import { getWindow } from './windows.js';

export class MultiResSpectrum {
  /**
   * @param {object} opts
   * @param {number} opts.baseSize FFT size of the fastest (highest-frequency) stage
   * @param {string} opts.windowName
   * @param {number} opts.sampleRate
   */
  constructor({ baseSize = 4096, windowName = 'hann', sampleRate = 48000 } = {}) {
    this.sampleRate = sampleRate;
    this.expTimeConst = 0.5;
    this.avgMode = 'exponential';
    this.linearTarget = 16;
    this.configure(baseSize, windowName);
  }

  configure(baseSize, windowName) {
    this.baseSize = baseSize;
    this.windowName = windowName;
    this.stages = [0, 1, 2].map((k) => {
      const size = baseSize * 4 ** k;
      const { w, coherentGain, noiseGain } = getWindow(windowName, size);
      const nBins = size / 2 + 1;
      return {
        size,
        w,
        coherentGain,
        noiseGain,
        nBins,
        cadence: 2 ** k,       // recompute every 2^k frames
        frame: 0,
        windowed: new Float64Array(size),
        power: new Float64Array(nBins),
        avgPower: new Float64Array(nBins),
        peakPower: new Float64Array(nBins),
        avgCount: 0,
        // Region covered by this stage: (fLow, fHigh]; stage 2 reaches 0
        fHigh: this.sampleRate / 2 / 4 ** k,
        fLow: k === 2 ? 0 : this.sampleRate / 2 / 4 ** (k + 1),
      };
    });
    this.resetAverage();
    this.resetPeakHold();
  }

  setAveraging(mode, { expTimeConst, linearTarget } = {}) {
    this.avgMode = mode;
    if (expTimeConst !== undefined) this.expTimeConst = expTimeConst;
    if (linearTarget !== undefined) this.linearTarget = linearTarget;
    this.resetAverage();
  }

  resetAverage() {
    for (const s of this.stages) {
      s.avgPower.fill(0);
      s.avgCount = 0;
    }
  }

  resetPeakHold() {
    for (const s of this.stages) s.peakPower.fill(0);
    this.peakValid = false;
  }

  /** Progress of the slowest stage (linear mode): {count, target, done}. */
  get linearProgress() {
    let count = Infinity;
    for (const s of this.stages) count = Math.min(count, s.avgCount);
    return { count, target: this.linearTarget, done: count >= this.linearTarget };
  }

  /** Longest window length needed from the ring buffer. */
  get maxSize() {
    return this.stages[2].size;
  }

  /**
   * @param {Float32Array} samples newest samples, length >= maxSize
   * @param {number} dt seconds since last call
   */
  process(samples, dt) {
    for (const s of this.stages) {
      s.frame++;
      if (s.frame % s.cadence !== 0 && s.avgCount > 0) continue;
      const linearDone = this.avgMode === 'linear' && s.avgCount >= this.linearTarget;
      if (!linearDone) {
        const n = s.size;
        const offset = samples.length - n;
        for (let i = 0; i < n; i++) s.windowed[i] = samples[offset + i] * s.w[i];
        rfftMagSq(s.windowed, s.power);
        const { power, avgPower, nBins } = s;
        switch (this.avgMode) {
          case 'off':
            avgPower.set(power);
            s.avgCount = 1;
            break;
          case 'linear': {
            const c = s.avgCount;
            for (let k = 0; k < nBins; k++) avgPower[k] = (avgPower[k] * c + power[k]) / (c + 1);
            s.avgCount = c + 1;
            break;
          }
          default: {
            const alpha = s.avgCount === 0
              ? 1
              : 1 - Math.exp((-dt * s.cadence) / Math.max(this.expTimeConst, 1e-3));
            for (let k = 0; k < nBins; k++) avgPower[k] += alpha * (power[k] - avgPower[k]);
            s.avgCount++;
          }
        }
      }
      const { avgPower, peakPower, nBins } = s;
      for (let k = 0; k < nBins; k++) if (avgPower[k] > peakPower[k]) peakPower[k] = avgPower[k];
    }
    this.peakValid = true;
  }

  /**
   * Stitched display segments, low frequency first. Each segment holds the
   * bins of one stage that fall inside its region, converted like
   * SpectrumProcessor.toDisplay.
   * @param {'amplitude'|'rms'|'psd'} quantity
   * @param {boolean} dB
   * @param {'avg'|'peak'} source which power spectrum to convert
   * @returns {{binHz: number, startBin: number, values: Float32Array, fLow: number, fHigh: number}[]}
   */
  segments(quantity, dB, source = 'avg') {
    const fs = this.sampleRate;
    const out = [];
    for (let k = 2; k >= 0; k--) {
      const s = this.stages[k];
      const powerArr = source === 'peak' ? s.peakPower : s.avgPower;
      const binHz = fs / s.size;
      const startBin = k === 2 ? 0 : Math.ceil(s.fLow / binHz);
      const endBin = Math.min(Math.floor(s.fHigh / binHz), s.nBins - 1);
      const values = new Float32Array(endBin - startBin + 1);
      const cAmp = 2 / (s.size * s.coherentGain);
      const psdScale = 2 / (fs * s.size * s.noiseGain);
      const rms = quantity === 'rms';
      for (let b = startBin; b <= endBin; b++) {
        const edge = b === 0 || b === s.nBins - 1;
        let v;
        if (quantity === 'psd') {
          v = powerArr[b] * psdScale;
          if (edge) v /= 2;
          values[b - startBin] = dB ? 10 * Math.log10(Math.max(v, 1e-30)) : v;
        } else {
          v = cAmp * Math.sqrt(Math.max(powerArr[b], 0));
          if (edge) v /= 2;
          else if (rms) v /= Math.SQRT2;
          values[b - startBin] = dB ? 20 * Math.log10(Math.max(v, 1e-15)) : v;
        }
      }
      out.push({ binHz, startBin, values, fLow: s.fLow, fHigh: s.fHigh });
    }
    return out;
  }
}
